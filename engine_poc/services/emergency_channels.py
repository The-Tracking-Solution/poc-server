"""Autoritatieve noodstatus per kanaal."""

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from engine_poc.control_protocol import control_group_name
from engine_poc.models import ChannelState
from engine_radio.models import RadioUser


def _is_emergency(user: RadioUser) -> bool:
    return bool(
        user.current_channel_id
        and user.user_contact_status_id
        and user.user_contact_status.call_request_priority == 1
    )


def _payload(state: ChannelState) -> dict:
    users = list(state.emergency_users.order_by("external_name").values("slug", "external_name"))
    return {
        "type": "channel_emergency",
        "active": bool(users),
        "users": [{"slug": item["slug"], "name": item["external_name"]} for item in users],
    }


def _notify(state: ChannelState) -> None:
    layer = get_channel_layer()
    if layer:
        async_to_sync(layer.group_send)(
            control_group_name(state.tenant_id, state.channel_id),
            {"type": "control.message", "sender": "emergency-channel-service", "payload": _payload(state)},
        )


def sync_emergency_user(user: RadioUser, previous_channel_id: int | None = None) -> None:
    channel_ids = {item for item in (previous_channel_id, user.current_channel_id) if item}
    for channel_id in channel_ids:
        state, _ = ChannelState.objects.get_or_create(tenant_id=user.tenant_id, channel_id=channel_id)
        before = state.emergency_users.filter(pk=user.pk).exists()
        should_include = channel_id == user.current_channel_id and _is_emergency(user)
        if should_include and not before:
            state.emergency_users.add(user)
            _notify(state)
        elif before and not should_include:
            state.emergency_users.remove(user)
            _notify(state)


def channel_emergency_data(state: ChannelState | None) -> dict:
    if not state:
        return {"channel_emergency": False, "emergency_users": []}
    payload = _payload(state)
    return {"channel_emergency": payload["active"], "emergency_users": payload["users"]}
