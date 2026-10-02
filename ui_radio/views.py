from __future__ import annotations

import json
import logging

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.contrib.auth.hashers import check_password
from django.core.exceptions import ValidationError
from django.db.models import Count
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST
from django.views.decorators.clickjacking import xframe_options_sameorigin

from engine_poc.models import ChannelPresence, Channel, ChannelState, DeviceSession, EventLog, UserStatus
from engine_radio.models import HardwareProfile, RadioUser, Screen
from engine_poc.services.radio_actions import (
    allowed_channels,
    available_channels,
    cancel_emergency_status,
    heartbeat_ptt,
    move_channel as perform_channel_move,
    select_channel as perform_channel_select,
    select_user_status as perform_status_select,
    start_ptt,
    stop_ptt,
)
from engine_poc.services.emergency_channels import channel_emergency_data, sync_emergency_user
from engine_poc.services.events import create_event
from engine_poc.timeutils import now_ms
from engine_poc.services.floor import start_parrot_floor, stop_parrot_floor
from engine_poc.services.location import process_location_sample, location_config
from engine_poc.channel_links import linked_group_members
from engine_poc.livekit_media import radio_connection_payload

FLOOR_TOKEN_KEY = "radio_floor_token"
DEVICE_TOKEN_KEY = "radio_device_token"
DEVICE_SESSION_ID_KEY = "radio_device_session_id"
EMERGENCY_AUTO_STATUS_KEY = "radio_emergency_auto_status_id"
LAST_SPEAKER_MS = 5000
telemetry_logger = logging.getLogger("poc.telemetry")


def _json(request):
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError as exc:
        raise ValidationError("Ongeldige JSON.") from exc


def _reply(data=None, status=200):
    return JsonResponse({"ok": status < 400, "data": data or {}}, status=status)


def _error(exc):
    messages = getattr(exc, "messages", None)
    return JsonResponse(
        {"ok": False, "error": " ".join(messages) if messages else str(exc)},
        status=409 if isinstance(exc, ValidationError) else 500,
    )


def api(fn):
    def wrapped(request, *args, **kwargs):
        try:
            return fn(request, *args, **kwargs)
        except (ValidationError, Channel.DoesNotExist, RadioUser.DoesNotExist) as exc:
            return _error(exc)

    return wrapped


def _user(request, tenant_slug):
    queryset = RadioUser.objects.select_related(
        "tenant", "current_channel", "user_profile", "user_status",
        "hardware_profile", "hardware_profile__hardware_config",
    ).prefetch_related("django_users").filter(
        django_users=request.user, tenant__slug=tenant_slug,
    ).distinct()
    selected_id = (request.session.get("selected_radio_users") or {}).get(tenant_slug)
    if selected_id:
        selected = queryset.filter(pk=selected_id).first()
        if selected is not None:
            return selected
    user = queryset.order_by("pk").first()
    if user is None:
        raise RadioUser.DoesNotExist
    return user



def _device_identifier(request):
    """Return a stable ID for Android hardware, otherwise the browser session ID."""
    device_uuid = str(request.session.get("android_device_uuid") or "").strip().lower()
    if device_uuid:
        return f"android:{device_uuid}"
    android_id = str(request.session.get("android_secure_id") or "").strip().lower()
    if android_id:
        return f"android-id:{android_id}"
    return f"web-radio-{request.session.session_key}"

def _session(request, user):
    if not request.session.session_key:
        request.session.create()

    device_identifier = _device_identifier(request)
    session_id = request.session.get(DEVICE_SESSION_ID_KEY)
    # engine_main uses this key while deciding whether an identity is selectable.
    if not session_id:
        session_id = request.session.get("radio_session_id")

    session = None
    if session_id:
        session = DeviceSession.objects.filter(
            pk=session_id,
            radio_user=user,
            status=DeviceSession.Status.ACTIVE,
        ).first()
        # Migration bridge for sessions created before stable Android IDs were
        # used. The session id comes from this exact Django/WebView session and
        # the Django user must also match, so another device is never claimed.
        if session is not None and session.device_identifier != device_identifier:
            if (
                device_identifier.startswith("android:")
                or device_identifier.startswith("android-id:")
            ) and session.django_user_id == request.user.id:
                session.device_identifier = device_identifier
                session.save(update_fields=["device_identifier", "last_update_ms"])
            else:
                session = None

    # A new Django/browser session may be reconnecting to an Android radio that
    # is still active server-side. Re-adopt it only for the exact same device.
    if session is None:
        session = (
            DeviceSession.objects.filter(
                radio_user=user,
                django_user=request.user,
                device_identifier=device_identifier,
                status=DeviceSession.Status.ACTIVE,
            )
            .order_by("-connected_at_ms", "-pk")
            .first()
        )

    if session is None:
        # Do not steal an occupied radio. If another active session exists, the
        # identity selection flow must handle it instead of revoking it here.
        occupied = DeviceSession.objects.filter(
            radio_user=user,
            status=DeviceSession.Status.ACTIVE,
        ).exists()
        if occupied:
            raise ValidationError("Deze radio is momenteel niet beschikbaar.")

        session = DeviceSession(
            tenant=user.tenant,
            django_user=request.user,
            radio_user=user,
            device_identifier=device_identifier,
            current_channel=user.current_channel,
        )
        raw_token = session.issue_token()
        session.save()
        previous_device_status = user.device_status
        if previous_device_status != user.DeviceStatus.ONLINE:
            user.device_status = user.DeviceStatus.ONLINE
            user.save(update_fields=["device_status", "last_update_ms"])
            create_event(
                tenant=user.tenant, action_type="RADIO_STATE_CHANGED", actor_slug=user.slug, actor_name=user.display_name,
                subject_slug=user.slug, subject_name=user.display_name, entity_type="radio_user",
                entity_slug=user.slug, entity_name=user.display_name, value="online", message="Radio online",
                metadata={"old_state": previous_device_status, "new_state": "online", "session_id": session.pk},
            )
        request.session[DEVICE_SESSION_ID_KEY] = session.pk
        request.session["radio_session_id"] = session.pk
        request.session[DEVICE_TOKEN_KEY] = raw_token
        request.session.modified = True
        return session

    # Reconnecting browser/app: bind the active hardware session to this logged-in
    # Django user/session. BELANGRIJK: roteer het DeviceSession-token niet bij
    # iedere HTTP-call. Heartbeat en channel-presence lopen iedere 5 seconden en
    # mogen een reeds geopende control-WebSocket nooit ongeldig maken.
    update_fields = []
    if session.django_user_id != request.user.id:
        session.django_user = request.user
        update_fields.append("django_user")

    raw_token = str(request.session.get(DEVICE_TOKEN_KEY) or "")
    token_valid = bool(
        raw_token
        and session.session_token_hash
        and check_password(raw_token, session.session_token_hash)
    )
    if not token_valid:
        raw_token = session.issue_token()
        update_fields.extend(["session_token_hash", "last_update_ms"])

    if update_fields:
        session.save(update_fields=list(dict.fromkeys(update_fields)))

    request.session[DEVICE_SESSION_ID_KEY] = session.pk
    request.session["radio_session_id"] = session.pk
    request.session[DEVICE_TOKEN_KEY] = raw_token
    request.session.modified = True
    return session


def _allowed(user):
    # Alle tenantkanalen mogen direct geselecteerd/ontvangen/verzonden worden.
    return available_channels(user)




def _available_screens(request):
    """Schermen die de ingelogde gebruiker binnen zijn tenants mag testen."""
    queryset = Screen.objects.select_related(
        "tenant", "hardware_profile", "hardware_profile__hardware_config"
    ).order_by("tenant__name", "hardware_profile__name", "name", "pk")
    if request.user.is_superuser:
        return queryset
    tenant_ids = RadioUser.objects.filter(django_users=request.user).values_list("tenant_id", flat=True).distinct()
    return queryset.filter(tenant_id__in=tenant_ids)


@login_required
def dev_screen_select(request):
    """Tussenpagina voor het kiezen van een tenantgebonden Screen."""
    screens = _available_screens(request)
    if request.method == "POST":
        screen_id = request.POST.get("screen")
        if screen_id:
            selected = get_object_or_404(screens, pk=screen_id)
    return render(request, "ui_radio/dev_screen_select.html", {"screens": screens})


@login_required
@xframe_options_sameorigin
def dev_screen(request, screen_id):
    """Render de ontwikkelweergave met de JSON-configuratie van één Screen."""
    selected = get_object_or_404(_available_screens(request), pk=screen_id)
    # De browser-engine werkt met een runtime-bundel, maar elk database-record
    # blijft één afzonderlijk scherm. Voor de preview bundelen we alleen de
    # schermen van dezelfde tenant tijdelijk.
    tenant_screens = selected.hardware_profile.screens.select_related(
        "hardware_profile", "hardware_profile__hardware_config"
    ).order_by("name", "pk")
    selected_config = selected.resolved_config
    runtime_config = {
        "schema_version": 2,
        "theme": selected_config.get("theme", {}),
        "initial_screen": selected.name,
        "screens": {},
    }
    for item in tenant_screens:
        item_config = item.resolved_config
        item_config.pop("schema_version", None)
        item_config.pop("theme", None)
        runtime_config["screens"][item.name] = item_config

    return render(
        request,
        "ui_radio/dev_screen.html",
        {"screen_model": selected, "screen_config": runtime_config},
    )


@login_required
def index(request):
    users = RadioUser.objects.filter(django_users=request.user).select_related("tenant").distinct()
    if users.count() == 1:
        return redirect("ui_radio:screen", tenant_slug=users.first().tenant.slug)
    return render(request, "ui_radio/select.html", {"radio_users": users})


@login_required
@ensure_csrf_cookie
@xframe_options_sameorigin
def screen(request, tenant_slug):
    """Render de echte soft-radio voor de ingelogde RadioUser.

    De productiepagina gebruikt dezelfde schermdefinities als de linker
    dev-viewer, maar zonder testviewport. Alleen secties met usemode=visible
    worden getoond; de renderer verdeelt de volledige beschikbare ruimte
    automatisch over die zichtbare secties.
    """
    user = _user(request, tenant_slug)

    # Een hardwareprofiel bepaalt welke schermen voor deze radio beschikbaar
    # zijn. Wanneer nog geen profiel/schermen zijn gekoppeld, gebruiken we als
    # ontwikkelvriendelijke fallback alle schermen van dezelfde tenant.
    if user.hardware_profile_id:
        screens = user.hardware_profile.screens.select_related(
            "hardware_profile", "hardware_profile__hardware_config"
        ).filter(tenant=user.tenant).order_by("pk", "name")
    else:
        screens = Screen.objects.none()

    if not screens.exists():
        screens = Screen.objects.select_related(
            "hardware_profile", "hardware_profile__hardware_config"
        ).filter(tenant=user.tenant).order_by("pk", "name")

    screen_items = list(screens)
    requested_screen_id = request.GET.get("screen")
    initial = next(
        (item for item in screen_items if str(item.pk) == requested_screen_id),
        screen_items[0] if screen_items else None,
    )

    runtime_config = {
        "schema_version": 2,
        "theme": initial.resolved_config.get("theme", {}) if initial else {},
        "initial_screen": initial.name if initial else None,
        "screens": {},
    }

    for item in screen_items:
        item_config = item.resolved_config
        item_config.pop("schema_version", None)
        item_config.pop("theme", None)
        runtime_config["screens"][item.name] = item_config

    return render(
        request,
        "ui_radio/tenant_screen.html",
        {
            "tenant_slug": tenant_slug,
            "radio_user": user,
            "screen_config": runtime_config,
        },
    )


@login_required
@require_GET
@api
def bootstrap(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    channels = list(_allowed(user).values("slug", "name"))
    statuses = list(
        UserStatus.objects.filter(tenant=user.tenant)
        .order_by("display_code")
        .values("slug", "display_code", "display_label", "display_status", "call_request_priority")
    )
    statuses = [
        {
            "slug": item["slug"],
            "label_short": item["display_code"],
            "label_long": item["display_label"] or item["display_status"],
            "choice_label": f'{item["slug"]} - {item["display_status"] or item["display_label"] or item["display_code"]}',
            "call_request_priority": item["call_request_priority"],
        }
        for item in statuses
    ]
    if not user.current_channel_id and channels:
        user.current_channel = Channel.objects.get(tenant=user.tenant, slug=channels[0]["slug"])
        user.save(update_fields=["current_channel", "last_update_ms"])
        session.current_channel = user.current_channel
        session.save(update_fields=["current_channel", "last_update_ms"])

    sync_emergency_user(user)
    channel_state = ChannelState.objects.filter(channel=user.current_channel).first() if user.current_channel else None
    emergency_data = channel_emergency_data(channel_state)
    return _reply(
        {
            "identity": {
                "display_name": user.display_name,
                "user_slug": user.slug,
                "tenant_slug": tenant_slug,
            },
            "channels": channels,
            "current_channel_slug": user.current_channel.slug if user.current_channel else None,
            "statuses": statuses,
            "current_status_slug": user.frontend_status.slug if user.frontend_status else None,
            "emergency_auto_sent": bool(
                user.user_contact_status_id
                and user.user_contact_status.call_request_priority == 1
                and request.session.get(EMERGENCY_AUTO_STATUS_KEY) == user.user_contact_status_id
            ),
            "default_tx_priority": user.user_profile.ptt_priority if user.user_profile else 0,
            "tx_permission_mode": user.tenant.tx_permission_mode,
            "location": location_config(user),
            **emergency_data,
            "priority": None,
            "audio": {
                "session_id": session.pk,
                "access_token": request.session[DEVICE_TOKEN_KEY],
                "webrtc_token_url": f"/radio/{tenant_slug}/api/webrtc/token/",
                "opus_bitrate_kbps": user.user_profile.opus_bitrate_kbps if user.user_profile else 20,
                "opus_dtx": user.user_profile.opus_dtx if user.user_profile else True,
                "opus_red": user.user_profile.opus_red if user.user_profile else False,
            },
        }
    )


@login_required
@require_POST
def webrtc_token(request, tenant_slug):
    """Issue a LiveKit token for the logged-in radio user and an allowed channel.

    This endpoint deliberately uses the existing Django radio login/session instead
    of the generic DeviceSession DRF authentication path.  It therefore matches
    the rest of ui_radio and avoids token/session skew during reconnects.
    """
    user = _user(request, tenant_slug)
    session = _session(request, user)
    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "Ongeldige JSON."}, status=400)

    channel_slug = str(payload.get("channel_slug") or "").strip()
    channel = _allowed(user).filter(slug=channel_slug).first()
    if channel is None:
        return JsonResponse({"detail": "Kanaal niet beschikbaar."}, status=404)

    return JsonResponse(radio_connection_payload(
        request=request,
        session=session,
        channel=channel,
        profile=user.user_profile,
    ))


@login_required
@require_POST
@api
def heartbeat(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    ts = now_ms()
    payload = _json(request)
    previous_telemetry = session.telemetry if isinstance(session.telemetry, dict) else {}
    previous_connection_state = previous_telemetry.get("_server_connection_state")
    compact_status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
    status_snapshot = {
        "roundtrip_ms": compact_status.get("r"),
        "network_online": compact_status.get("n") == 1,
        "network_type": compact_status.get("nt"),
        "channel_slug": compact_status.get("c"),
        "status_slug": compact_status.get("s"),
        "transmitting": compact_status.get("tx") == 1,
    }
    detailed_telemetry_received = isinstance(payload.get("telemetry"), dict)
    connection_state = previous_connection_state or "connected"
    if detailed_telemetry_received:
        client_telemetry = payload["telemetry"]
        webrtc = client_telemetry.get("webrtc") if isinstance(client_telemetry.get("webrtc"), dict) else {}
        connection_state = (
            "degraded"
            if client_telemetry.get("webrtc_degraded") is True
            or client_telemetry.get("webrtc_available") is False
            or webrtc.get("connection_state") in {"failed", "disconnected"}
            else "connected"
        )
        session.telemetry = {
            "device_type": "radio",
            "device": user.display_name,
            "device_slug": user.slug,
            "tenant": user.tenant.slug,
            "received_at_ms": ts,
            "report_interval_ms": int(payload.get("telemetry_interval_ms") or 60000),
            "status": status_snapshot,
            **client_telemetry,
            "_server_connection_state": connection_state,
        }
        telemetry_logger.info(json.dumps({
            "type": "minute_telemetry",
            "session_id": session.pk,
            **session.telemetry,
        }, ensure_ascii=False, separators=(",", ":")))
    # RadioUser.current_channel is authoritative. This may have changed through
    # Django Admin while the radio page was already open.
    if session.current_channel_id != user.current_channel_id:
        session.current_channel = user.current_channel
    session.last_seen_at_ms = ts
    session.last_heartbeat_at_ms = ts
    update_fields = ["current_channel", "last_seen_at_ms", "last_heartbeat_at_ms", "last_update_ms"]
    if detailed_telemetry_received:
        update_fields.append("telemetry")
    session.save(update_fields=update_fields)
    if detailed_telemetry_received and previous_connection_state != connection_state:
        create_event(
            tenant=user.tenant, action_type="RADIO_STATE_CHANGED", actor_slug=user.slug, actor_name=user.display_name,
            subject_slug=user.slug, subject_name=user.display_name,
            channel_slug=user.current_channel.slug if user.current_channel_id else "",
            channel_name=user.current_channel.name if user.current_channel_id else "",
            entity_type="radio_user", entity_slug=user.slug, entity_name=user.display_name,
            value=connection_state, message=f"Radioverbinding: {connection_state}",
            metadata={"old_state": previous_connection_state, "new_state": connection_state, "session_id": session.pk},
        )
    status = user.frontend_status
    sync_emergency_user(user)
    channel_state = ChannelState.objects.filter(channel=user.current_channel).first() if user.current_channel else None
    if not status or status.call_request_priority != 1:
        request.session.pop(EMERGENCY_AUTO_STATUS_KEY, None)
    return _reply({
        "timestamp_ms": ts,
        "current_channel_slug": user.current_channel.slug if user.current_channel else None,
        "current_status_slug": status.slug if status else None,
        "status_label_short": status.display_code if status else "",
        "status_label_long": (status.display_label or status.display_status) if status else "",
        "call_request_priority": status.call_request_priority if status else None,
        "emergency_auto_sent": bool(
            status and status.call_request_priority == 1
            and request.session.get(EMERGENCY_AUTO_STATUS_KEY) == user.user_contact_status_id
        ),
        "default_tx_priority": user.user_profile.ptt_priority if user.user_profile else 0,
        "location": location_config(user),
        **channel_emergency_data(channel_state),
    })


@login_required
@require_POST
@api
def update_location(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    payload = _json(request)
    try:
        latitude = float(payload["latitude"])
        longitude = float(payload["longitude"])
        accuracy_m = float(payload["accuracy_m"])
        timestamp_ms = int(payload.get("timestamp_ms") or now_ms())
    except (KeyError, TypeError, ValueError) as exc:
        raise ValidationError("latitude, longitude en accuracy_m zijn verplicht en numeriek.") from exc
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180 and accuracy_m >= 0):
        raise ValidationError("Ongeldige locatiecoördinaten of accuracy.")
    try:
        result = process_location_sample(
            session=session, latitude=latitude, longitude=longitude,
            accuracy_m=accuracy_m, timestamp_ms=timestamp_ms,
            source=str(payload.get("source") or "interval"),
        )
    except PermissionError as exc:
        return _reply({"code": "location_disabled", "message": str(exc)}, status=403)
    return _reply(result)


@login_required
@require_POST
@api
def select_channel(request, tenant_slug, channel_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    channel = perform_channel_select(user=user, session=session, channel_slug=channel_slug)
    return _reply({"channel_slug": channel.slug, "channel_name": channel.name})


@login_required
@require_POST
@api
def move_channel(request, tenant_slug):
    body = _json(request)
    try:
        step = int(body.get("step", 0))
    except (TypeError, ValueError) as exc:
        raise ValidationError("Kanaalstap moet een getal zijn.") from exc
    if step not in {-1, 1}:
        raise ValidationError("Kanaalstap moet -1 of 1 zijn.")
    user = _user(request, tenant_slug)
    session = _session(request, user)
    channel = perform_channel_move(user=user, session=session, step=step)
    return _reply({"channel_slug": channel.slug, "channel_name": channel.name})


@login_required
@require_POST
@api
def select_status(request, tenant_slug):
    body = _json(request)
    status_slug = str(body.get("status") or "").strip()
    user = _user(request, tenant_slug)
    status = perform_status_select(user=user, status_slug=status_slug)
    if status.call_request_priority != 1:
        request.session.pop(EMERGENCY_AUTO_STATUS_KEY, None)
    return _reply({
        "status_slug": status.slug,
        "status_label_short": status.display_code,
        "status_label_long": status.display_label or status.display_status,
        "call_request_priority": status.call_request_priority,
    })


@login_required
@require_POST
@api
def cancel_emergency(request, tenant_slug):
    user = _user(request, tenant_slug)
    status = cancel_emergency_status(user=user)
    request.session.pop(EMERGENCY_AUTO_STATUS_KEY, None)
    return _reply({
        "status_slug": status.slug if status else None,
        "status_label_short": status.display_code if status else "",
        "status_label_long": (status.display_label or status.display_status) if status else "",
        "call_request_priority": status.call_request_priority if status else None,
        "clear_reason": "Beëindigd door radio",
    })


@login_required
@require_GET
@api
def state(request, tenant_slug):
    user = _user(request, tenant_slug)
    channel = user.current_channel
    floor = None
    last_speaker = None
    if channel:
        cs = ChannelState.objects.select_related("active_session__radio_user").filter(channel=channel).first()
        if cs:
            floor = {
                "floor_status": cs.floor_status,
                "active_user_slug": cs.active_user_slug,
                "active_user_name": cs.active_user_name,
                "granted_at_ms": cs.granted_at_ms,
                "is_self": bool(cs.active_session_id and cs.active_session.radio_user_id == user.id),
            }
        cutoff = now_ms() - LAST_SPEAKER_MS
        event = EventLog.objects.filter(
            tenant=user.tenant,
            channel_slug=channel.slug,
            action_type="PTT_RELEASED",
            timestamp_ms__gte=cutoff,
        ).order_by("-timestamp_ms").first()
        if event:
            last_speaker = {
                "user_slug": event.actor_slug,
                "user_name": event.actor_name,
                "channel_slug": event.channel_slug,
                "channel_name": event.channel_name or channel.name,
                "released_at_ms": event.timestamp_ms,
                "visible_until_ms": event.timestamp_ms + LAST_SPEAKER_MS,
            }

    return _reply(
        {
            "channel": {"slug": channel.slug, "name": channel.name} if channel else None,
            "floor": floor,
            "last_speaker": last_speaker,
            "server_time_ms": now_ms(),
            "priority": None,
        }
    )


@login_required
@require_GET
@api
def channel_presence(request, tenant_slug):
    """
    Aanwezigheid op het actuele radiokanaal.

    Dezelfde ChannelPresence-bron als de dispatcher channel-tile:
    - radios: alle luisterende radiosessies op het kanaal
    - dispatchers: alle luisterende dispatchsessies op het kanaal
    - other_users: alle andere sessies behalve deze radio zelf

    Deze endpoint blijft ook beschikbaar voor toekomstige presence-logica.
    Hij zit niet meer in het kritieke PTT-pad.
    """
    user = _user(request, tenant_slug)
    session = _session(request, user)

    if not user.current_channel_id:
        return _reply({
            "radios": 0,
            "dispatchers": 0,
            "other_users": 0,
            "channel_id": None,
            "channel_slug": "",
        })

    cutoff = now_ms() - 60_000
    linked_members = linked_group_members(user.current_channel)
    linked_channel_ids = [member.pk for member in linked_members]
    linked_channel_names = [
        member.name
        for member in linked_members
        if member.pk != user.current_channel_id
    ]
    linked = len(linked_channel_ids) > 1

    # Een gekoppelde kanaalgroep is voor presence één logisch kanaal.
    # Dezelfde sessie kan op meerdere leden van de groep een presence-row
    # hebben; daarom tellen we per rol unieke sessies over de hele groep.
    base = ChannelPresence.objects.filter(
        tenant=user.tenant,
        channel_id__in=linked_channel_ids,
        listening=True,
        last_update_ms__gte=cutoff,
    )

    rows = (
        base.values("role")
        .annotate(count=Count("session_id", distinct=True))
    )

    counts = {"radios": 0, "dispatchers": 0}
    for row in rows:
        key = (
            "dispatchers"
            if row["role"] == ChannelPresence.Role.DISPATCH
            else "radios"
        )
        counts[key] = row["count"]

    other_users = (
        base.exclude(session=session)
        .values("session_id")
        .distinct()
        .count()
    )

    return _reply({
        **counts,
        "other_users": other_users,
        "channel_id": user.current_channel_id,
        "channel_slug": user.current_channel.slug if user.current_channel else "",
        "linked": linked,
        "linked_channel_count": len(linked_channel_ids),
        "linked_channel_ids": linked_channel_ids,
        "linked_channel_names": linked_channel_names,
    })


@login_required
@require_POST
@api
def ptt_start(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    body = _json(request)
    automatic_requested = body.get("automatic_emergency") is True
    completion_requested = body.get("emergency_completion") is True

    # Als locatie voor het profiel is ingeschakeld mag de radio de laatst
    # bekende positie direct met de eerste PTT-aanvraag meesturen. Dit pad
    # blokkeert de floor-toekenning nooit: een ongeldige/stale GPS sample
    # mag de zendtoestemming niet vertragen of verhinderen.
    location_payload = body.get("location")
    if isinstance(location_payload, dict) and int(user.location_interval_seconds or 0) > 0:
        try:
            latitude = float(location_payload["latitude"])
            longitude = float(location_payload["longitude"])
            accuracy_m = float(location_payload["accuracy_m"])
            timestamp_ms = int(location_payload.get("timestamp_ms") or now_ms())
            if -90 <= latitude <= 90 and -180 <= longitude <= 180 and accuracy_m >= 0:
                process_location_sample(
                    session=session,
                    latitude=latitude,
                    longitude=longitude,
                    accuracy_m=accuracy_m,
                    timestamp_ms=timestamp_ms,
                    source="ptt",
                )
        except (KeyError, TypeError, ValueError, PermissionError):
            pass
    automatic_allowed = bool(
        automatic_requested
        and user.user_contact_status_id
        and user.user_contact_status.call_request_priority == 1
        and (
            completion_requested
            or request.session.get(EMERGENCY_AUTO_STATUS_KEY) != user.user_contact_status_id
        )
    )
    data = start_ptt(
        user=user,
        session=session,
        previous_floor_token=request.session.get(FLOOR_TOKEN_KEY, ""),
        automatic_emergency=automatic_allowed,
    )
    if data.get("waiting"):
        return _reply(data)
    if data.get("emergency") and not completion_requested:
        request.session[EMERGENCY_AUTO_STATUS_KEY] = user.user_contact_status_id
    request.session[FLOOR_TOKEN_KEY] = data["floor_token"]
    request.session.modified = True
    return _reply(data)


@login_required
@require_POST
@api
def ptt_heartbeat(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    return _reply(heartbeat_ptt(
        user=user,
        session=session,
        floor_token=request.session.get(FLOOR_TOKEN_KEY, ""),
    ))


@login_required
@require_POST
@api
def ptt_stop(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    token = request.session.pop(FLOOR_TOKEN_KEY, "")
    stop_ptt(user=user, session=session, floor_token=token)
    return _reply({})


@login_required
@require_POST
@api
def parrot_start(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    channel = user.current_channel
    if not channel:
        raise ValidationError("Geen actief kanaal.")
    return _reply({"started": start_parrot_floor(channel=channel, owner_session=session)})


@login_required
@require_POST
@api
def parrot_stop(request, tenant_slug):
    user = _user(request, tenant_slug)
    session = _session(request, user)
    channel = user.current_channel
    if not channel:
        raise ValidationError("Geen actief kanaal.")
    return _reply({"stopped": stop_parrot_floor(channel=channel, owner_session=session)})
