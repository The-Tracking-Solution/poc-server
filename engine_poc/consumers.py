import asyncio
import json
import logging
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.core import signing

from engine_poc.control_protocol import control_group_name, map_location_group_name, tenant_config_group_name
from engine_poc.channel_links import canonical_link_channel
from engine_poc.models import CallRequest, Channel, ChannelPresence, ChannelState, DeviceSession
from engine_poc.timeutils import now_ms
from engine_poc.ws_auth import authenticate_scope

logger = logging.getLogger(__name__)


class ChannelControlConsumer(AsyncWebsocketConsumer):
    """JSON-only control channel for PTT/floor/presence. Media is WebRTC/Opus via LiveKit."""

    async def connect(self):
        self.session = await authenticate_scope(self.scope)
        if not self.session:
            await self.close(code=4401); return
        self.channel = await self._get_channel()
        if not self.channel or self.channel.tenant_id != self.session.tenant_id:
            await self.close(code=4404); return
        self.dispatch_mode = self._valid_dispatch_token()
        self.initial_presence_profile = self._initial_presence_profile() if self.dispatch_mode else None
        await self._select_current_channel()
        self.group_name = control_group_name(self.channel.tenant_id, self.channel.id)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        self.config_group_name = tenant_config_group_name(self.channel.tenant_id)
        await self.channel_layer.group_add(self.config_group_name, self.channel_name)
        await self.accept()
        await self._register_presence()
        self.presence_task = asyncio.create_task(self._presence_heartbeat())
        initial = await self._initial_channel_state()
        await self.send_json({"type":"control_ready","timestamp_ms":now_ms(),"channel_slug":self.channel.slug,"presence_profile":self.initial_presence_profile,**initial})

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
        if hasattr(self, "config_group_name"):
            await self.channel_layer.group_discard(self.config_group_name, self.channel_name)
        if getattr(self, "presence_task", None): self.presence_task.cancel()
        await self._remove_presence()

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data is not None:
            await self.close(code=4400); return
        if text_data is None: return
        try: message=json.loads(text_data)
        except json.JSONDecodeError:
            await self.send_json({"type":"error","code":"INVALID_JSON","timestamp_ms":now_ms()}); return
        t=message.get("type")
        if t=="ping":
            await self.send_json({"type":"pong","ping_id":message.get("ping_id"),"timestamp_ms":now_ms()})
        elif t=="presence_mode" and self.dispatch_mode:
            await self._set_presence_listening(message.get("profile") in {"primary","secondary"})
        else:
            await self.send_json({"type":"error","code":"UNKNOWN_CONTROL_TYPE","timestamp_ms":now_ms()})

    async def control_message(self, event):
        await self.send_json(event["payload"])

    async def config_changed(self, event):
        await self.send_json(event["payload"])

    async def send_json(self,payload):
        await self.send(text_data=json.dumps(payload,separators=(",",":")))

    @database_sync_to_async
    def _get_channel(self):
        return Channel.objects.select_related("tenant").filter(tenant__slug=self.scope["url_route"]["kwargs"]["tenant_slug"],slug=self.scope["url_route"]["kwargs"]["channel_slug"],status=Channel.Status.ACTIVE).first()

    @database_sync_to_async
    def _initial_channel_state(self):
        own_state=ChannelState.objects.filter(channel=self.channel,tenant=self.channel.tenant).first()
        floor_channel=canonical_link_channel(self.channel)
        floor_state=ChannelState.objects.filter(channel=floor_channel,tenant=self.channel.tenant).first()
        users=list(own_state.emergency_users.order_by("external_name").values("slug","external_name")) if own_state else []
        accepted=CallRequest.objects.filter(channel=self.channel,tenant=self.channel.tenant,priority=1,status=CallRequest.Status.ACTIVE,accepted_at_ms__isnull=False).exists()
        active_slug = "parrot" if floor_state and floor_state.parrot_active else (floor_state.active_user_slug if floor_state else "")
        active_name = "Papegaai" if floor_state and floor_state.parrot_active else (floor_state.active_user_name if floor_state else "")
        effective_priority = 0 if floor_state and floor_state.parrot_active else (floor_state.active_priority if floor_state else None)
        return {"emergency_active":bool(users),"emergency_users":[{"slug":u["slug"],"name":u["external_name"]} for u in users],"effective_priority":effective_priority,"emergency_accepted":accepted,"active_speaker_slug":active_slug,"active_speaker_name":active_name}

    @database_sync_to_async
    def _select_current_channel(self):
        if self.dispatch_mode:return
        ts=now_ms(); DeviceSession.objects.filter(pk=self.session.id).update(current_channel=self.channel,last_seen_at_ms=ts,last_update_ms=ts)
        if self.session.radio_user_id:self.session.radio_user.__class__.objects.filter(pk=self.session.radio_user_id).update(current_channel=self.channel,last_update_ms=ts)

    def _valid_dispatch_token(self):
        query=parse_qs(self.scope.get("query_string",b"").decode("utf-8")); token=(query.get("dispatch_token") or [""])[0]
        if not token:return False
        try:data=signing.loads(token,salt="dispatch.control",max_age=12*60*60)
        except signing.BadSignature:return False
        return data.get("purpose")=="dispatch-control" and str(data.get("session_id"))==str(self.session.pk) and data.get("tenant")==self.channel.tenant.slug

    def _initial_presence_profile(self):
        query = parse_qs(self.scope.get("query_string", b"").decode("utf-8"))
        profile = (query.get("presence_profile") or [""])[0]
        return profile if profile in {"primary", "secondary", "muted"} else "muted"

    @database_sync_to_async
    def _register_presence(self):
        listening = (
            self.initial_presence_profile in {"primary", "secondary"}
            if self.dispatch_mode
            else True
        )
        ChannelPresence.objects.update_or_create(
            connection_id=self.channel_name,
            defaults={
                "tenant_id":self.channel.tenant_id,
                "channel_id":self.channel.id,
                "session_id":self.session.id,
                "role":ChannelPresence.Role.DISPATCH if self.dispatch_mode else ChannelPresence.Role.RADIO,
                "listening":listening,
            },
        )
    @database_sync_to_async
    def _remove_presence(self): ChannelPresence.objects.filter(connection_id=self.channel_name).delete()
    @database_sync_to_async
    def _set_presence_listening(self,listening): ChannelPresence.objects.filter(connection_id=self.channel_name).update(listening=bool(listening),last_update_ms=now_ms())
    async def _presence_heartbeat(self):
        try:
            while True:
                await asyncio.sleep(20); await self._touch_presence()
        except asyncio.CancelledError:return
    @database_sync_to_async
    def _touch_presence(self): ChannelPresence.objects.filter(connection_id=self.channel_name).update(last_update_ms=now_ms())


class MapLocationConsumer(AsyncWebsocketConsumer):
    """Tenantbrede realtime locatiefeed voor ingelogde dispatchers."""

    async def connect(self):
        self.session = await authenticate_scope(self.scope)
        if not self.session or not self.session.dispatch_user_id:
            await self.close(code=4401)
            return
        tenant_slug = self.scope["url_route"]["kwargs"]["tenant_slug"]
        if self.session.tenant.slug != tenant_slug:
            await self.close(code=4404)
            return
        self.group_name = map_location_group_name(self.session.tenant_id)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json({"type": "map_ready", "timestamp_ms": now_ms()})

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data is not None:
            await self.close(code=4400)
            return
        if not text_data:
            return
        try:
            message = json.loads(text_data)
        except json.JSONDecodeError:
            return
        if message.get("type") == "ping":
            await self.send_json({"type": "pong", "timestamp_ms": now_ms()})

    async def map_location(self, event):
        await self.send_json(event["payload"])

    async def send_json(self, payload):
        await self.send(text_data=json.dumps(payload, separators=(",", ":")))
