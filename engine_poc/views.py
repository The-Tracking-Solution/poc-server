import json
import logging
from django.db import transaction
from django.db.models import Q
from django.http import FileResponse
from rest_framework import generics, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from drf_spectacular.utils import extend_schema, OpenApiResponse
from drf_spectacular.types import OpenApiTypes
from engine_main.models import Tenant
from engine_poc.models import (Channel, UserStatus,
                        DeviceSession, ChannelState, EventLog, EventAttachment)
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, UserProfile
from engine_poc.serializers import *
from engine_poc.services.floor import request_floor, release_floor
from engine_poc.services.sessions import create_session
from engine_poc.services.events import create_event
from engine_poc.services.location import process_location_sample, location_config
from engine_poc.tenant_api import TenantScopedMixin
from engine_poc.timeutils import now_ms


telemetry_logger = logging.getLogger("poc.telemetry")

class TenantViewSet(viewsets.ModelViewSet):
    queryset = Tenant.objects.all()
    serializer_class = TenantSerializer
    lookup_field = "slug"


class HardwareConfigViewSet(viewsets.ModelViewSet):
    queryset = HardwareConfig.objects.all()
    serializer_class = HardwareConfigSerializer


class BaseTenantModelViewSet(TenantScopedMixin, viewsets.ModelViewSet):
    lookup_field = "slug"


class RadioUserViewSet(BaseTenantModelViewSet):
    queryset = RadioUser.objects.prefetch_related("django_users").select_related(
        "tenant",
        "user_profile",
        "hardware_profile",
        "user_status",
        "user_contact_status",
        "current_channel",
    )
    serializer_class = RadioUserSerializer

    @action(detail=True, methods=["post"], url_path="reset-secret")
    def reset_secret(self, request, tenant_slug=None, slug=None):
        raw = self.get_object().reset_secret()
        return Response({"secret_key": raw, "shown_once": True})

    @action(detail=True, methods=["post"])
    def logout(self, request, tenant_slug=None, slug=None):
        user = self.get_object()
        ts = now_ms()
        user.sessions.filter(status=DeviceSession.Status.ACTIVE).update(status=DeviceSession.Status.REVOKED, disconnected_at_ms=ts, last_update_ms=ts)
        previous_device_status = user.device_status
        user.device_status = RadioUser.DeviceStatus.OFFLINE
        user.save()
        if previous_device_status != RadioUser.DeviceStatus.OFFLINE:
            create_event(tenant=user.tenant, action_type="RADIO_STATE_CHANGED", actor_slug=user.slug, actor_name=user.display_name,
                         subject_slug=user.slug, subject_name=user.display_name, entity_type="radio_user",
                         entity_slug=user.slug, entity_name=user.display_name, value="offline", message="Radio offline",
                         metadata={"old_state": previous_device_status, "new_state": "offline", "reason": "logout"})
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserStatusViewSet(BaseTenantModelViewSet):
    queryset = UserStatus.objects.all()
    serializer_class = UserStatusSerializer


class ChannelViewSet(BaseTenantModelViewSet):
    queryset = Channel.objects.all()
    serializer_class = ChannelSerializer

    @action(detail=True, methods=["get"])
    def state(self, request, tenant_slug=None, slug=None):
        channel = self.get_object()
        state_obj, _ = ChannelState.objects.get_or_create(tenant=channel.tenant, channel=channel)
        return Response(ChannelStateSerializer(state_obj).data)

    def _session(self, request):
        session = getattr(request, "radio_session", None)
        if not session:
            from rest_framework.exceptions import AuthenticationFailed
            raise AuthenticationFailed("DeviceSession-authenticatie vereist.")
        return session

    @action(detail=True, methods=["post"], url_path="ptt/request")
    def ptt_request(self, request, tenant_slug=None, slug=None):
        serializer = PTTRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = request_floor(channel=self.get_object(), session=self._session(request),
                               emergency=serializer.validated_data["request_type"] == "emergency",
                               client_request_id=serializer.validated_data["client_request_id"])
        return Response({
            "timestamp_ms": now_ms(), "status": result.status,
            "effective_priority": result.effective_priority,
            "floor_token": result.floor_token,
            "event_sequence": result.event_sequence,
            "required_hold_ms": result.required_hold_ms,
            "remaining_hold_ms": result.remaining_hold_ms,
        })

    @action(detail=True, methods=["post"], url_path="ptt/release")
    def ptt_release(self, request, tenant_slug=None, slug=None):
        serializer = PTTReleaseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        state_obj = release_floor(channel=self.get_object(), session=self._session(request), **serializer.validated_data)
        return Response(ChannelStateSerializer(state_obj).data)


class UserProfileViewSet(BaseTenantModelViewSet):
    queryset = UserProfile.objects.prefetch_related("channels", "radio_users")
    serializer_class = UserProfileSerializer


class HardwareProfileViewSet(BaseTenantModelViewSet):
    queryset = HardwareProfile.objects.select_related("hardware_config").prefetch_related("radio_users", "screens")
    serializer_class = HardwareProfileSerializer


class DeviceSessionListView(TenantScopedMixin, generics.ListAPIView):
    queryset = DeviceSession.objects.select_related("radio_user", "dispatch_user", "current_channel")
    serializer_class = DeviceSessionSerializer
    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("active") == "true":
            qs = qs.filter(status=DeviceSession.Status.ACTIVE)
        if slug := self.request.query_params.get("user_slug"):
            qs = qs.filter(Q(radio_user__slug=slug) | Q(dispatch_user__slug=slug))
        if slug := self.request.query_params.get("channel_slug"):
            qs = qs.filter(current_channel__slug=slug)
        return qs


class EventListView(TenantScopedMixin, generics.ListAPIView):
    queryset = EventLog.objects.prefetch_related("attachments")
    serializer_class = EventLogSerializer
    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        for field in ("action_type", "channel_slug", "actor_slug"):
            if value := p.get(field): qs = qs.filter(**{field: value})
        if value := p.get("timestamp_from_ms"): qs = qs.filter(timestamp_ms__gte=value)
        if value := p.get("timestamp_to_ms"): qs = qs.filter(timestamp_ms__lte=value)
        if value := p.get("after_sequence"): qs = qs.filter(sequence_number__gt=value)
        return qs


class EventDetailView(TenantScopedMixin, generics.RetrieveAPIView):
    queryset = EventLog.objects.prefetch_related("attachments")
    serializer_class = EventLogSerializer
    lookup_field = "sequence_number"
    lookup_url_kwarg = "event_id"


class SessionLoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    @extend_schema(request=SessionLoginSerializer, responses={201: OpenApiTypes.OBJECT})
    def post(self, request):
        serializer = SessionLoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            user = RadioUser.objects.select_related("tenant", "user_profile", "hardware_profile").get(tenant__slug=data["tenant_slug"], slug=data["user_slug"])
        except RadioUser.DoesNotExist:
            return Response({"error": {"code": "INVALID_CREDENTIALS", "message": "Ongeldige aanmelding."}}, status=401)
        if not user.verify_secret(data["secret_key"]):
            return Response({"error": {"code": "INVALID_CREDENTIALS", "message": "Ongeldige aanmelding."}}, status=401)
        session, token = create_session(radio_user=user, device_identifier=data["device_identifier"])
        return Response({
            "session_id": session.pk,
            "access_token": token,
            "token_type": "Bearer",
            "timestamp_ms": now_ms(),
            "location": location_config(user),
        }, status=201)


class LocationUpdateView(APIView):
    @extend_schema(request=LocationUpdateSerializer, responses={200: OpenApiTypes.OBJECT})
    def post(self, request):
        serializer = LocationUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        session = getattr(request, "radio_session", None)
        if not session:
            from rest_framework.exceptions import AuthenticationFailed
            raise AuthenticationFailed("DeviceSession-authenticatie vereist.")
        if not session.radio_user_id:
            return Response({"detail": "Locatie-updates zijn alleen beschikbaar voor radio's."}, status=400)
        try:
            result = process_location_sample(session=session, **serializer.validated_data)
        except PermissionError as exc:
            return Response({"detail": str(exc), "code": "location_disabled"}, status=403)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(result)


class HeartbeatView(APIView):
    @extend_schema(request=HeartbeatSerializer, responses={200: OpenApiTypes.OBJECT})
    def post(self, request):
        serializer = HeartbeatSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        session = getattr(request, "radio_session", None)
        if not session:
            from rest_framework.exceptions import AuthenticationFailed
            raise AuthenticationFailed("DeviceSession-authenticatie vereist.")
        received = now_ms()
        sent = serializer.validated_data.get("sent_at_ms")
        rtt = max(0, received - sent) if sent else None
        session.last_seen_at_ms = received
        session.last_heartbeat_at_ms = received
        if "telemetry" in serializer.validated_data:
            raw_telemetry = serializer.validated_data.get("telemetry") or {}
            previous_telemetry = session.telemetry if isinstance(session.telemetry, dict) else {}

            # Houd server-side bij hoelang de volledige WebRTC-mediaverbinding
            # onbeschikbaar is. Een losse dispatcher-channel mag de dispatcher
            # wel degraded/oranje maken, maar pas wanneer geen enkel kanaal meer
            # verbonden is loopt de rood-timer. Radio's hebben één WebRTC-status.
            if session.dispatch_user_id:
                channels = raw_telemetry.get("channels") if isinstance(raw_telemetry, dict) else None
                states = [
                    str(value.get("connection_state") or "disconnected").lower()
                    for value in (channels or {}).values()
                    if isinstance(value, dict)
                ]
                webrtc_available = any(state == "connected" for state in states)
                webrtc_degraded = bool(states) and not all(state == "connected" for state in states)
                if not states:
                    webrtc_available = False
                    webrtc_degraded = True
            else:
                webrtc = raw_telemetry.get("webrtc") if isinstance(raw_telemetry, dict) else None
                state = str((webrtc or {}).get("connection_state") or "disconnected").lower()
                webrtc_available = state == "connected"
                webrtc_degraded = not webrtc_available

            unavailable_since = None
            if not webrtc_available:
                unavailable_since = previous_telemetry.get("webrtc_unavailable_since_ms") or received

            session.telemetry = {
                "device_type": session.role,
                "device": session.actor_name,
                "device_slug": session.actor_slug,
                "tenant": session.tenant.slug,
                "received_at_ms": received,
                **raw_telemetry,
                "webrtc_available": webrtc_available,
                "webrtc_degraded": webrtc_degraded,
                "webrtc_unavailable_since_ms": unavailable_since,
            }
            telemetry_logger.info(json.dumps({
                "type": "heartbeat_telemetry", "session_id": session.pk, **session.telemetry,
            }, ensure_ascii=False, separators=(",", ":")))
        if rtt is not None:
            n = session.heartbeat_samples
            session.last_roundtrip_ms = rtt
            session.average_roundtrip_ms = ((session.average_roundtrip_ms or 0) * n + rtt) / (n + 1)
            session.heartbeat_samples = n + 1
        session.save()
        radio = session.radio_user if session.radio_user_id else None
        return Response({
            "heartbeat_id": serializer.validated_data["heartbeat_id"],
            "received_at_ms": received,
            "response_at_ms": now_ms(),
            "roundtrip_ms": rtt,
            "location": location_config(radio),
        })


class WebRTCTokenView(APIView):
    @extend_schema(request=WebRTCTokenSerializer, responses={200: OpenApiTypes.OBJECT})
    def post(self, request):
        serializer = WebRTCTokenSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        session = getattr(request, "radio_session", None)
        if not session:
            from rest_framework.exceptions import AuthenticationFailed
            raise AuthenticationFailed("DeviceSession-authenticatie vereist.")
        channel = Channel.objects.filter(
            tenant=session.tenant,
            slug=serializer.validated_data["channel_slug"],
        ).first()
        if channel is None:
            return Response({"detail": "Kanaal niet gevonden."}, status=404)
        from engine_poc.livekit_media import radio_connection_payload
        if not session.radio_user_id:
            return Response({"detail": "RadioSession vereist."}, status=403)
        profile = session.user_profile
        return Response(radio_connection_payload(
            request=request,
            session=session,
            channel=channel,
            profile=profile,
        ))


class LiveStatusView(TenantScopedMixin, APIView):
    @extend_schema(responses={200: OpenApiTypes.OBJECT})
    def get(self, request, tenant_slug):
        tenant = self.get_tenant()
        states = ChannelState.objects.filter(tenant=tenant).select_related("channel")
        active = DeviceSession.objects.filter(tenant=tenant, status=DeviceSession.Status.ACTIVE).count()
        return Response({
            "timestamp_ms": now_ms(),
            "users": {"total": RadioUser.objects.filter(tenant=tenant).count(), "online": active},
            "sessions": {"active": active},
            "channels": [{
                "slug": s.channel.slug, "floor_status": s.floor_status,
                "active_speaker_slug": s.active_user_slug or None,
                "active_priority": s.active_priority,
                "connected_sessions": DeviceSession.objects.filter(tenant=tenant, current_channel=s.channel, status=DeviceSession.Status.ACTIVE).count(),
            } for s in states],
        })

class EventAttachmentListView(TenantScopedMixin, generics.ListAPIView):
    serializer_class = EventAttachmentSerializer

    def get_queryset(self):
        return EventAttachment.objects.select_related("tenant", "event").filter(
            tenant=self.get_tenant(), event_id=self.kwargs["event_id"]
        )


class EventAttachmentContentView(TenantScopedMixin, APIView):
    @extend_schema(responses={200: OpenApiResponse(response=OpenApiTypes.BINARY, description="Audiobestand")})
    def get(self, request, tenant_slug, event_id, attachment_id):
        try:
            attachment = EventAttachment.objects.select_related("tenant", "event").get(
                tenant=self.get_tenant(), event_id=event_id, pk=attachment_id
            )
        except EventAttachment.DoesNotExist:
            from rest_framework.exceptions import NotFound
            raise NotFound("Audiobijlage niet gevonden.")
        response = FileResponse(attachment.file.open("rb"), content_type=attachment.mime_type)
        response["Content-Length"] = attachment.file_size
        response["Content-Disposition"] = f'inline; filename="{attachment.original_filename}"'
        response["X-Content-Type-Options"] = "nosniff"
        return response
