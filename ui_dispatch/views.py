import json
import logging

from django.contrib.auth.decorators import login_required
from django.core import signing
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from django.db.models import Count
from django.http import Http404
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_GET, require_POST
from django.views.decorators.csrf import ensure_csrf_cookie

from engine_main.models import Tenant
from engine_dispatch.models import DispatchConfig, DispatchProfile, DispatchSession, DispatchUser, DispatchUserSettings
from engine_poc.models import StatusSchema, ChannelPresence, CallRequest, Channel, ChannelState, DeviceSession, UserStatus
from engine_radio.models import RadioUser
from engine_poc.services.floor import cancel_floor_waiter, force_release_floor, release_floor, request_floor, revoke_active_floor
from engine_poc.services.events import create_event
from engine_poc.services.emergency_channels import sync_emergency_user
from engine_poc.services.radio_actions import cancel_emergency_status
from engine_poc.control_protocol import control_group_name
from engine_poc.livekit_media import dispatch_connection_payload
from engine_poc.timeutils import now_ms

telemetry_logger = logging.getLogger("poc.telemetry")
DISPATCH_DEVICE_SESSION_IDS = "dispatch_device_session_ids"
DISPATCH_DEVICE_TOKENS = "dispatch_device_tokens"



def _merge_settings(*layers):
    """Recursieve merge; latere lagen overschrijven eerdere lagen."""
    result = {}
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        for key, value in layer.items():
            if isinstance(value, dict) and isinstance(result.get(key), dict):
                result[key] = _merge_settings(result[key], value)
            else:
                result[key] = value
    return result



def _default_dispatch_radio_settings():
    return {
        "call_request_audio": {
            "enabled": True,
            "volume": 80,
            "priority_1": {
                "enabled": True,
                "initial_frequency_hz": 520,
                "morse_delay_seconds": 15,
                "low_frequency_hz": 520,
                "high_frequency_hz": 880,
            },
            "priority_2_pings": 5,
            "priority_3_pings": 4,
            "priority_4_pings": 3,
            "priority_5_pings": 2,
            "priority_6_pings": 1,
        }
    }

def _default_dispatch_buttons():
    return {
        "radio": [
            {"id": f"r{index}", "slot": f"R{index}", "label": f"R{index}", "enabled": True, "action": {}}
            for index in range(1, 6)
        ],
        "sidebar": [],
    }


def _sanitize_button_overrides(value):
    if not isinstance(value, dict):
        return {}
    return {str(key): enabled for key, enabled in value.items() if isinstance(enabled, bool)}


def _effective_dispatch_buttons(config, profile, user_settings):
    definitions = config.buttons if isinstance(config.buttons, dict) else {}
    radio = definitions.get("radio") if isinstance(definitions.get("radio"), list) else []
    sidebar = definitions.get("sidebar") if isinstance(definitions.get("sidebar"), list) else []
    profile_overrides = _sanitize_button_overrides(profile.buttons)
    user_overrides = _sanitize_button_overrides(user_settings.buttons)

    def normalize(items, button_type):
        normalized = []
        seen = set()
        for position, raw in enumerate(items):
            if not isinstance(raw, dict):
                continue
            button_id = str(raw.get("id") or "").strip()
            if not button_id or button_id in seen:
                continue
            seen.add(button_id)
            enabled = bool(raw.get("enabled", True))
            if button_id in profile_overrides:
                enabled = profile_overrides[button_id]
            if button_id in user_overrides:
                enabled = user_overrides[button_id]
            item = {
                "id": button_id,
                "type": button_type,
                "label": str(raw.get("label") or raw.get("slot") or button_id),
                "enabled": enabled,
                "action": raw.get("action") if isinstance(raw.get("action"), dict) else {},
                "position": position,
            }
            if button_type == "radio":
                item["slot"] = str(raw.get("slot") or "").upper()
            normalized.append(item)
        return normalized

    radio_items = normalize(radio, "radio")
    by_slot = {item.get("slot"): item for item in radio_items if item.get("slot")}
    default_radio = _default_dispatch_buttons()["radio"]
    completed_radio = []
    for default in default_radio:
        slot = default["slot"]
        item = by_slot.get(slot)
        if item is None:
            item = {
                **default,
                "type": "radio",
                "position": len(completed_radio),
            }
            enabled = bool(default.get("enabled", True))
            if default["id"] in profile_overrides:
                enabled = profile_overrides[default["id"]]
            if default["id"] in user_overrides:
                enabled = user_overrides[default["id"]]
            item["enabled"] = enabled
        completed_radio.append(item)

    return {
        "radio": completed_radio,
        "sidebar": normalize(sidebar, "sidebar"),
    }


def _display_code_number(value):
    """Numerieke sorteersleutel voor UserStatus.display_code."""
    raw = str(value or "").strip()
    if not raw:
        return (1, 0, "")
    try:
        return (0, int(raw), raw)
    except (TypeError, ValueError):
        try:
            return (0, float(raw.replace(",", ".")), raw)
        except (TypeError, ValueError):
            return (1, 0, raw.casefold())


def _ensure_default_status_schema(tenant):
    schema, created = StatusSchema.objects.get_or_create(
        tenant=tenant,
        slug="default",
        defaults={"name": "Default"},
    )
    if created:
        schema.statuses.set(UserStatus.objects.filter(tenant=tenant))
    return schema


def _dispatch_status_schema(dispatch_user):
    profile = dispatch_user.dispatch_profile
    if profile and profile.status_schema_id:
        return profile.status_schema
    return _ensure_default_status_schema(dispatch_user.tenant)


def _schema_status_ids(schema):
    return set(schema.statuses.values_list("pk", flat=True))


def _status_in_schema(radio, allowed_status_ids):
    status = radio.frontend_status
    if status and status.pk in allowed_status_ids:
        return status
    return None


@transaction.atomic
def _ensure_dispatch_settings(dispatch_user):
    """Maak de config/profile/userlaag aan zodra dispatch wordt geopend."""
    config, _ = DispatchConfig.objects.get_or_create(
        tenant=dispatch_user.tenant,
        defaults={"radio_settings": _default_dispatch_radio_settings(), "buttons": _default_dispatch_buttons()},
    )
    if not isinstance(config.buttons, dict) or not config.buttons:
        config.buttons = _default_dispatch_buttons()
        config.save(update_fields=["buttons", "last_update_ms"])
    status_schema = _ensure_default_status_schema(dispatch_user.tenant)
    profile = dispatch_user.dispatch_profile
    if profile is None or profile.tenant_id != dispatch_user.tenant_id:
        profile, _ = DispatchProfile.objects.get_or_create(
            tenant=dispatch_user.tenant,
            name="Default",
            defaults={
                "dispatch_config": config,
                "status_schema": status_schema,
                "radio_settings": {},
                "buttons": {},
            },
        )
        if profile.dispatch_config_id != config.pk:
            profile.dispatch_config = config
            profile.save(update_fields=["dispatch_config", "last_update_ms"])
        dispatch_user.dispatch_profile = profile
        dispatch_user.save(update_fields=["dispatch_profile", "last_update_ms"])
    elif profile.dispatch_config_id != config.pk:
        profile.dispatch_config = config
        profile.save(update_fields=["dispatch_config", "last_update_ms"])

    if profile.status_schema_id is None or profile.status_schema.tenant_id != dispatch_user.tenant_id:
        profile.status_schema = status_schema
        profile.save(update_fields=["status_schema", "last_update_ms"])

    user_settings, _ = DispatchUserSettings.objects.get_or_create(
        dispatch_user=dispatch_user,
        defaults={
            "tenant": dispatch_user.tenant,
            "dispatch_profile": profile,
            "radio_settings": {},
            "buttons": {},
        },
    )
    changed = []
    if user_settings.tenant_id != dispatch_user.tenant_id:
        user_settings.tenant = dispatch_user.tenant
        changed.append("tenant")
    if user_settings.dispatch_profile_id != profile.pk:
        user_settings.dispatch_profile = profile
        changed.append("dispatch_profile")
    if changed:
        changed.append("last_update_ms")
        user_settings.save(update_fields=changed)

    effective = _merge_settings(
        _default_dispatch_radio_settings(),
        config.radio_settings,
        profile.radio_settings,
        user_settings.radio_settings,
    )
    effective_buttons = _effective_dispatch_buttons(config, profile, user_settings)
    return config, profile, user_settings, effective, effective_buttons

def _accessible_tenants(user):
    tenants = Tenant.objects.all() if user.is_superuser else Tenant.objects.filter(
        dispatchuser__django_users=user
    )
    return tenants.order_by("name").distinct()


def _dispatch_user(request, tenant_slug):
    queryset = DispatchUser.objects.select_related("tenant", "user_profile", "dispatch_profile", "dispatch_profile__status_schema").filter(
        django_users=request.user, tenant__slug=tenant_slug,
    ).distinct()
    selected_id = (request.session.get("selected_dispatch_users") or {}).get(tenant_slug)
    if selected_id:
        selected = queryset.filter(pk=selected_id).first()
        if selected is not None:
            return selected
    user = queryset.order_by("pk").first()
    if user is None:
        raise Http404("Geen dispatcher beschikbaar binnen deze tenant.")
    return user


def _dispatch_session(request, dispatch_user):
    if not request.session.session_key:
        request.session.create()
    session = DispatchSession.objects.filter(
        dispatch_user=dispatch_user, django_user=request.user,
        session_key=request.session.session_key, status=DispatchSession.Status.ACTIVE,
    ).first()
    if session is None:
        DispatchSession.objects.filter(
            dispatch_user=dispatch_user, status=DispatchSession.Status.ACTIVE,
        ).update(status=DispatchSession.Status.RELEASED, released_at_ms=now_ms())
        session = DispatchSession.objects.create(
            dispatch_user=dispatch_user, django_user=request.user,
            session_key=request.session.session_key, last_seen_at_ms=now_ms(),
        )
    return session


def _dispatch_control_session(request, dispatch_user):
    if not request.session.session_key:
        request.session.create()
    ids = dict(request.session.get(DISPATCH_DEVICE_SESSION_IDS) or {})
    tokens = dict(request.session.get(DISPATCH_DEVICE_TOKENS) or {})
    key = dispatch_user.tenant.slug
    session = None
    session_id = ids.get(key)
    if session_id:
        session = DeviceSession.objects.filter(
            pk=session_id, dispatch_user=dispatch_user, status=DeviceSession.Status.ACTIVE,
        ).first()
    if session is None:
        DeviceSession.objects.filter(
            dispatch_user=dispatch_user, status=DeviceSession.Status.ACTIVE,
        ).update(status=DeviceSession.Status.REVOKED, disconnected_at_ms=now_ms())
        session = DeviceSession(
            tenant=dispatch_user.tenant, django_user=request.user, dispatch_user=dispatch_user,
            device_identifier=f"web-dispatch-{request.session.session_key}",
        )
        raw_token = session.issue_token()
        session.save()
        ids[key] = session.pk
        tokens[key] = raw_token
        dispatch_user.device_status = DispatchUser.DeviceStatus.ONLINE
        dispatch_user.save(update_fields=["device_status", "last_update_ms"])
        request.session[DISPATCH_DEVICE_SESSION_IDS] = ids
        request.session[DISPATCH_DEVICE_TOKENS] = tokens
        request.session.modified = True
        return session, raw_token
    raw_token = tokens.get(key)
    if not raw_token or not session.verify_token(raw_token):
        raw_token = session.issue_token()
        session.save(update_fields=["session_token_hash", "last_update_ms"])
        tokens[key] = raw_token
        request.session[DISPATCH_DEVICE_TOKENS] = tokens
        request.session.modified = True
    return session, raw_token


@login_required
def index(request):
    tenants = _accessible_tenants(request.user)
    tenant = tenants.first()
    if tenant is None:
        raise Http404("Geen tenant beschikbaar voor dispatch.")
    return redirect("dispatch:radio", tenant_slug=tenant.slug)


def _console_context(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    _config, profile, _user_settings, effective_radio_settings, effective_buttons = _ensure_dispatch_settings(dispatch_user)
    # Dispatch moet ieder tenantkanaal direct kunnen openen en gebruiken.
    _dispatch_channels_queryset(tenant).filter(status=Channel.Status.INACTIVE).update(
        status=Channel.Status.ACTIVE, last_update_ms=now_ms(),
    )
    channels = _dispatch_channels_queryset(tenant).prefetch_related("linked_channels").order_by("name")
    channel_link_group_by_id, _channel_link_groups_list = _channel_link_groups(channels)
    units = list(RadioUser.objects.filter(tenant=tenant).select_related(
        "current_channel",
        "user_status",
        "user_contact_status",
        "user_profile",
    ).prefetch_related("user_profile__channels").order_by("external_name"))
    dispatchers = list(DispatchUser.objects.filter(tenant=tenant).order_by("external_name"))

    dispatch_status_objects = list(
        profile.status_schema.statuses.filter(
            tenant=tenant,
            call_request_priority__isnull=True,
        )
    )
    dispatch_status_objects.sort(key=lambda status: (
        _display_code_number(status.display_code),
        (status.display_label or status.display_status or status.slug).casefold(),
    ))
    dispatch_statuses = [
        {
            "id": str(status.pk),
            "slug": status.slug,
            "display_code": status.display_code,
            "display_status": status.display_status,
            "display_label": status.display_label,
            "choice_label": status.selection_label,
        }
        for status in dispatch_status_objects
    ]

    channel_data = [
        {
            "id": str(channel.pk),
            "slug": channel.slug,
            "name": channel.name,
            "linkedChannelIds": [
                str(member.pk)
                for member in channel_link_group_by_id.get(channel.pk, [channel])
                if member.pk != channel.pk
            ],
        }
        for channel in channels
    ]
    unit_data = [
        {
            "id": str(unit.pk),
            "code": unit.external_name,
            "slug": unit.slug,
            "channelId": (
                str(unit.current_channel_id)
                if unit.current_channel_id and unit.current_channel.channel_type != Channel.ChannelType.ECHO
                else ""
            ),
            "online": unit.device_status == RadioUser.DeviceStatus.ONLINE,
            "assignedChannelIds": [
                str(channel.pk)
                for channel in unit.user_profile.channels.all()
                if channel.channel_type != Channel.ChannelType.ECHO
            ] if unit.user_profile_id else [],
        }
        for unit in units
    ]

    return {
        "tenant": tenant,
        "dispatch_user": dispatch_user,
        "channels": channels,
        "units": units,
        "dispatchers": dispatchers,
        "dispatch_statuses": dispatch_statuses,
        "dispatch_poc_channels": channel_data,
        "dispatch_units": unit_data,
        "dispatch_radio_settings": effective_radio_settings,
        "dispatch_buttons": effective_buttons,
    }


@login_required
def console_redirect(request, tenant_slug):
    # Canonieke dispatch-startpagina is de radio-console.
    return redirect("dispatch:radio", tenant_slug=tenant_slug)


@login_required
@ensure_csrf_cookie
def map_console(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    return render(request, "dispatch/map.html", {"tenant": tenant, "dispatch_user": dispatch_user})



def _dispatch_channels_queryset(tenant):
    """Kanalen die zichtbaar/bruikbaar zijn in Dispatch. Echo-kanalen horen hier niet bij."""
    return Channel.objects.filter(tenant=tenant).exclude(channel_type=Channel.ChannelType.ECHO)


def _channel_link_groups(channels):
    """Return (group_by_channel_id, groups) voor de zichtbare kanaalgraaf.

    Een linkgroep is een connected component met minimaal twee kanalen. Echo-kanalen
    worden genegeerd, ook wanneer er nog historische M2M-links naar bestaan.
    """
    channel_list = list(channels)
    allowed_ids = {channel.pk for channel in channel_list}
    by_id = {channel.pk: channel for channel in channel_list}
    adjacency = {channel.pk: set() for channel in channel_list}
    for channel in channel_list:
        for linked in channel.linked_channels.all():
            if linked.pk in allowed_ids and linked.pk != channel.pk:
                adjacency[channel.pk].add(linked.pk)
                adjacency[linked.pk].add(channel.pk)

    group_by_id = {}
    groups = []
    seen = set()
    for channel in channel_list:
        if channel.pk in seen:
            continue
        stack = [channel.pk]
        component = []
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            component.append(current)
            stack.extend(adjacency[current] - seen)
        if len(component) < 2:
            continue
        members = sorted((by_id[item] for item in component), key=lambda item: item.name.casefold())
        groups.append(members)
        for member in members:
            group_by_id[member.pk] = members
    groups.sort(key=lambda members: tuple(member.name.casefold() for member in members))
    return group_by_id, groups


def _locked_dispatch_channels_with_groups(tenant):
    channels = list(
        Channel.objects.select_for_update()
        .filter(tenant=tenant)
        .exclude(channel_type=Channel.ChannelType.ECHO)
        .prefetch_related("linked_channels")
        .order_by("name")
    )
    group_by_id, groups = _channel_link_groups(channels)
    return channels, {channel.pk: channel for channel in channels}, group_by_id, groups


def _normalize_link_group(members):
    """Maak de groep een volledige clique zodat direct link_count == groepsgrootte-1."""
    members = list(members)
    for index, source in enumerate(members):
        for target in members[index + 1:]:
            source.linked_channels.add(target)


def _notify_link_group_changed(tenant_id, channel_ids):
    layer = get_channel_layer()
    if not layer:
        return
    affected_ids = sorted({int(value) for value in channel_ids if value})
    payload = {
        "type": "channel_links_changed",
        "timestamp_ms": now_ms(),
        "channel_ids": affected_ids,
    }
    for channel_id in affected_ids:
        async_to_sync(layer.group_send)(control_group_name(tenant_id, channel_id), {
            "type": "control.message", "sender": "dispatch-network", "payload": payload,
        })


def _network_status_style(status):
    if status is None:
        return {"code": None, "bg": DEFAULT_SYSTEM_STATUS_MAP_STYLE["bg"], "border": DEFAULT_SYSTEM_STATUS_MAP_STYLE["border"]}
    style = SYSTEM_STATUS_MAP_STYLES.get(status.system_status, DEFAULT_SYSTEM_STATUS_MAP_STYLE)
    return {
        "code": status.display_code or None,
        "bg": style["bg"],
        "border": style["border"],
    }


@login_required
@ensure_csrf_cookie
def network_console(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    return render(
        request,
        "dispatch/network.html",
        {"tenant": tenant, "dispatch_user": dispatch_user},
    )


@login_required
@ensure_csrf_cookie
def states_console(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    return render(
        request,
        "dispatch/states.html",
        {"tenant": tenant, "dispatch_user": dispatch_user},
    )


@login_required
@require_GET
def states_state(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    _config, profile, _settings, _effective, _buttons = _ensure_dispatch_settings(dispatch_user)
    schema = profile.status_schema

    statuses = list(
        schema.statuses.filter(tenant=tenant)
    )
    statuses.sort(key=lambda status: (
        _display_code_number(status.display_code),
        (status.display_label or status.display_status or status.display_code).casefold(),
    ))
    allowed_status_ids = {status.pk for status in statuses}
    radios = list(
        RadioUser.objects.filter(tenant=tenant)
        .select_related("current_channel", "user_status", "user_contact_status")
        .order_by("external_name")
    )
    radio_sessions = _best_active_session(
        DeviceSession.objects.filter(
            tenant=tenant,
            status=DeviceSession.Status.ACTIVE,
            radio_user__isnull=False,
        ),
        "radio_user_id",
    )

    cards = []
    card_by_status_id = {}
    for status in statuses:
        style = _network_status_style(status)
        card = {
            "id": str(status.pk),
            "system_status": int(status.system_status) if status.system_status is not None else None,
            "display_code": status.display_code,
            "technical_name": status.slug,
            "display_status": (
                status.display_status
                or status.display_label
                or status.display_code
                or status.slug
            ),
            # In het statusschema toont States de dispatcher-displaycode.
            # Als een status geen displaycode heeft, blijft de technische naam
            # een bruikbare fallback.
            "badge_label": status.display_code or status.slug,
            "name": (
                status.display_status
                or status.display_label
                or status.display_code
                or status.slug
            ),
            "short_name": status.display_code,
            "bg": style["bg"],
            "border": style["border"],
            "radios": [],
        }
        cards.append(card)
        card_by_status_id[status.pk] = card

    no_status = {
        "id": "none",
        "system_status": None,
        "name": "Geen status",
        "short_name": "Geen status",
        "bg": DEFAULT_SYSTEM_STATUS_MAP_STYLE["bg"],
        "border": DEFAULT_SYSTEM_STATUS_MAP_STYLE["border"],
        "radios": [],
    }
    fallback_by_status_id = {}

    for radio in radios:
        actual_status = radio.frontend_status
        status = _status_in_schema(radio, allowed_status_ids)

        if status is not None:
            target = card_by_status_id[status.pk]
        elif actual_status is not None:
            # Fallback voor een geldige gebruikersstatus die niet in het
            # statusschema van deze dispatcher voorkomt. Iedere onbekende
            # gebruikersstatus krijgt een eigen kaart.
            target = fallback_by_status_id.get(actual_status.pk)
            if target is None:
                style = _network_status_style(actual_status)
                display_status = (
                    actual_status.display_status
                    or actual_status.display_label
                    or actual_status.display_code
                    or "status"
                )
                target = {
                    "id": f"fallback:{actual_status.pk}",
                    "fallback": True,
                    "system_status": (
                        int(actual_status.system_status)
                        if actual_status.system_status is not None
                        else None
                    ),
                    "display_code": actual_status.display_code,
                    "technical_name": actual_status.slug,
                    "display_status": display_status,
                    # Niet opgenomen in het dispatcher-statusschema: toon de
                    # technische naam in de badge, ongeacht de displaycode op
                    # het onderliggende UserStatus-record.
                    "badge_label": actual_status.slug,
                    "name": display_status,
                    "short_name": actual_status.slug,
                    "bg": style["bg"],
                    "border": style["border"],
                    "radios": [],
                }
                fallback_by_status_id[actual_status.pk] = target
                cards.append(target)
        else:
            target = no_status

        channel_name = ""
        if radio.current_channel_id and radio.current_channel.channel_type != Channel.ChannelType.ECHO:
            channel_name = radio.current_channel.name
        target["radios"].append({
            "id": str(radio.pk),
            "name": radio.external_name,
            "channel_id": (
                str(radio.current_channel_id)
                if channel_name and radio.current_channel_id
                else ""
            ),
            "channel": channel_name,
            "connection": _session_connection_status(radio_sessions.get(radio.pk)),
        })

    if no_status["radios"]:
        cards.append(no_status)

    for card in cards:
        card["radios"].sort(key=lambda item: item["name"].casefold())

    cards.sort(key=lambda item: (
        item["id"] == "none",
        item.get("fallback") is True,
        _display_code_number(item.get("display_code") or item.get("short_name")),
        item["name"].casefold(),
    ))

    return JsonResponse({"ok": True, "data": {"states": cards}})


@login_required
@require_GET
def network_state(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    _config, profile, _settings, _effective, _buttons = _ensure_dispatch_settings(dispatch_user)
    allowed_status_ids = _schema_status_ids(profile.status_schema)
    cutoff = now_ms() - 60_000

    channels = list(_dispatch_channels_queryset(tenant).prefetch_related("linked_channels").order_by("name"))
    channel_ids = [channel.pk for channel in channels]
    link_group_by_id, link_groups = _channel_link_groups(channels)

    radios = list(
        RadioUser.objects.filter(tenant=tenant)
        .select_related("current_channel", "user_status", "user_contact_status")
        .order_by("external_name")
    )

    radio_sessions = _best_active_session(
        DeviceSession.objects.filter(tenant=tenant, status=DeviceSession.Status.ACTIVE, radio_user__isnull=False),
        "radio_user_id",
    )

    dispatch_presence = (
        ChannelPresence.objects.filter(
            tenant=tenant,
            channel_id__in=channel_ids,
            role=ChannelPresence.Role.DISPATCH,
            listening=True,
            last_update_ms__gte=cutoff,
            session__status=DeviceSession.Status.ACTIVE,
            session__dispatch_user__isnull=False,
        )
        .select_related("channel", "session__dispatch_user")
        .order_by("session__dispatch_user__external_name")
    )

    dispatchers_by_channel = {str(channel.pk): [] for channel in channels}
    seen_dispatchers = {str(channel.pk): set() for channel in channels}
    for presence in dispatch_presence:
        channel_key = str(presence.channel_id)
        dispatcher = presence.session.dispatch_user
        if dispatcher.pk in seen_dispatchers[channel_key]:
            continue
        seen_dispatchers[channel_key].add(dispatcher.pk)
        dispatchers_by_channel[channel_key].append({
            "id": str(dispatcher.pk),
            "name": dispatcher.external_name,
            "connection": _session_connection_status(presence.session, is_dispatch=True),
        })

    radios_by_channel = {str(channel.pk): [] for channel in channels}
    unassigned = []
    for radio in radios:
        # Network volgt dezelfde statuspresentatie als States: als de actuele
        # status in het statusschema van de dispatcher staat, toon de
        # dispatcher-displaycode. Staat hij niet in het schema, toon dan de
        # technische naam (slug) in plaats van NULL/"-". De kleur blijft
        # afkomstig van de daadwerkelijke radiostatus.
        actual_status = radio.frontend_status
        schema_status = _status_in_schema(radio, allowed_status_ids)
        style = _network_status_style(actual_status)
        network_status_code = (
            schema_status.display_code
            if schema_status is not None and schema_status.display_code
            else (actual_status.slug if actual_status is not None else None)
        )
        session = radio_sessions.get(radio.pk)
        visible_channel_id = (
            radio.current_channel_id
            if radio.current_channel_id and radio.current_channel.channel_type != Channel.ChannelType.ECHO
            else None
        )
        item = {
            "id": str(radio.pk),
            "name": radio.external_name,
            "channel_id": str(visible_channel_id or ""),
            "connection": _session_connection_status(session),
            "status_code": network_status_code,
            "status_technical_name": actual_status.slug if actual_status is not None else "",
            "status_display": (
                actual_status.display_status
                or actual_status.display_label
                or actual_status.display_code
                or actual_status.slug
            ) if actual_status is not None else "",
            "status_in_schema": schema_status is not None,
            "status_bg": style["bg"],
            "status_border": style["border"],
        }
        key = str(visible_channel_id or "")
        if key and key in radios_by_channel:
            radios_by_channel[key].append(item)
        else:
            unassigned.append(item)

    payload = []
    for channel in channels:
        key = str(channel.pk)
        payload.append({
            "id": key,
            "slug": channel.slug,
            "name": channel.name,
            "links": [
                {"id": str(linked.pk), "name": linked.name, "slug": linked.slug}
                for linked in link_group_by_id.get(channel.pk, [])
                if linked.pk != channel.pk
            ],
            "dispatchers": sorted(dispatchers_by_channel[key], key=lambda item: item["name"].casefold()),
            "radios": sorted(radios_by_channel[key], key=lambda item: item["name"].casefold()),
        })

    return JsonResponse({
        "ok": True,
        "data": {
            "channels": payload,
            "link_groups": [
                {
                    "id": "-".join(str(member.pk) for member in members),
                    "channels": [
                        {"id": str(member.pk), "name": member.name, "slug": member.slug}
                        for member in members
                    ],
                }
                for members in link_groups
            ],
            "unassigned": sorted(unassigned, key=lambda item: item["name"].casefold()),
            "private_calls": [],
        },
    })


@login_required
@require_POST
@transaction.atomic
def link_channels(request, tenant_slug, channel_id):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (TypeError, ValueError, UnicodeDecodeError):
        payload = {}

    target_id = str(payload.get("target_channel_id") or "").strip()
    channels, by_id, group_by_id, _groups = _locked_dispatch_channels_with_groups(tenant)
    try:
        source_pk = int(channel_id)
        target_pk = int(target_id)
    except (TypeError, ValueError):
        return JsonResponse({"ok": False, "error": "Ongeldig kanaal."}, status=400)
    source = by_id.get(source_pk)
    target = by_id.get(target_pk)
    if source is None or target is None:
        # Echo-kanalen zijn bewust niet koppelbaar vanuit Dispatch.
        return JsonResponse({"ok": False, "error": "Dit kanaal is niet koppelbaar in Dispatch."}, status=400)
    if source.pk == target.pk:
        return JsonResponse({"ok": False, "error": "Een kanaal kan niet aan zichzelf worden gekoppeld."}, status=400)

    source_group = list(group_by_id.get(source.pk, [source]))
    target_group = list(group_by_id.get(target.pk, [target]))
    source_ids = {item.pk for item in source_group}
    target_ids = {item.pk for item in target_group}

    if source_ids == target_ids and len(source_ids) > 1:
        return JsonResponse({"ok": True, "data": {"channel_id": str(source.pk), "group_size": len(source_ids)}})

    # Een kanaal mag maar in één linkgroep zitten. Twee bestaande groepen worden
    # daarom niet stilzwijgend door één drag/drop samengevoegd.
    if len(source_ids) > 1 and len(target_ids) > 1:
        return JsonResponse({
            "ok": False,
            "error": "Beide kanalen zitten al in een linkgroep. Verwijder eerst één kanaal uit zijn huidige groep.",
        }, status=400)

    members_by_id = {item.pk: item for item in source_group + target_group}
    members = sorted(members_by_id.values(), key=lambda item: item.name.casefold())
    _normalize_link_group(members)
    timestamp = now_ms()
    affected_ids = [item.pk for item in members]
    Channel.objects.filter(pk__in=affected_ids).update(last_update_ms=timestamp)
    transaction.on_commit(lambda: _notify_link_group_changed(tenant.pk, affected_ids))
    return JsonResponse({"ok": True, "data": {
        "channel_id": str(source.pk),
        "linked_channel_id": str(target.pk),
        "group_size": len(members),
    }})


@login_required
@require_POST
@transaction.atomic
def unlink_channel_group(request, tenant_slug, channel_id):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    channels, by_id, group_by_id, _groups = _locked_dispatch_channels_with_groups(tenant)
    source = by_id.get(int(channel_id))
    if source is None:
        return JsonResponse({"ok": False, "error": "Dit kanaal is niet beschikbaar in Dispatch."}, status=400)

    members = list(group_by_id.get(source.pk, [source]))
    if len(members) < 2:
        return JsonResponse({"ok": True, "data": {"channel_id": str(source.pk), "group_size": 1}})

    source.linked_channels.clear()
    remaining = [member for member in members if member.pk != source.pk]
    _normalize_link_group(remaining)
    timestamp = now_ms()
    affected_ids = [member.pk for member in members]
    Channel.objects.filter(pk__in=affected_ids).update(last_update_ms=timestamp)
    transaction.on_commit(lambda: _notify_link_group_changed(tenant.pk, affected_ids))
    return JsonResponse({"ok": True, "data": {
        "channel_id": str(source.pk),
        "remaining_group_size": len(remaining),
    }})


@login_required
@require_POST
@transaction.atomic
def clear_link_group(request, tenant_slug, channel_id):
    """Verbreek alle links van de volledige linkgroep waar channel_id in zit."""
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    channels, by_id, group_by_id, _groups = _locked_dispatch_channels_with_groups(tenant)
    source = by_id.get(int(channel_id))
    if source is None:
        return JsonResponse({"ok": False, "error": "Dit kanaal is niet beschikbaar in Dispatch."}, status=400)

    members = list(group_by_id.get(source.pk, [source]))
    if len(members) < 2:
        return JsonResponse({"ok": True, "data": {
            "channel_id": str(source.pk),
            "group_size": 1,
        }})

    affected_ids = [member.pk for member in members]
    # Wis aan alle kanten zodat de hele groep in één transactie uiteenvalt.
    for member in members:
        member.linked_channels.clear()

    timestamp = now_ms()
    Channel.objects.filter(pk__in=affected_ids).update(last_update_ms=timestamp)
    transaction.on_commit(lambda: _notify_link_group_changed(tenant.pk, affected_ids))
    return JsonResponse({"ok": True, "data": {
        "channel_id": str(source.pk),
        "cleared_channel_ids": [str(value) for value in affected_ids],
        "group_size": 1,
    }})


@login_required
@require_POST
@transaction.atomic
def unlink_channels(request, tenant_slug, channel_id, linked_channel_id):
    # Backwards-compatible route: binnen de nieuwe groepssemantiek wordt het
    # bronkanaal volledig uit zijn linkgroep gehaald.
    return unlink_channel_group(request, tenant_slug, channel_id)


@login_required
def console(request, tenant_slug):
    return render(
        request,
        "dispatch/dispatch.html",
        _console_context(request, tenant_slug),
    )


@login_required
@ensure_csrf_cookie
def radio_console(request, tenant_slug):
    return render(
        request,
        "dispatch/radio.html",
        _console_context(request, tenant_slug),
    )



def _session_connection_status(session, *, is_dispatch=False, current_ms=None):
    """Map een DeviceSession naar connected/degraded/offline voor het adresboek."""
    current_ms = current_ms or now_ms()
    if session is None or session.status != DeviceSession.Status.ACTIVE:
        return "offline"

    heartbeat_at = session.last_heartbeat_at_ms or session.last_seen_at_ms or 0
    age_ms = max(0, current_ms - heartbeat_at) if heartbeat_at else 10**12
    telemetry = session.telemetry if isinstance(session.telemetry, dict) else {}

    # Een dispatcher kan bewust online zijn terwijl zijn radio uit staat. Voor
    # radiobereikbaarheid is dat expliciet offline/rood.
    if is_dispatch and telemetry.get("radio_powered") is False:
        return "offline"

    if age_ms > 60_000:
        return "offline"

    unavailable_since = telemetry.get("webrtc_unavailable_since_ms")
    try:
        unavailable_age = current_ms - int(unavailable_since) if unavailable_since else 0
    except (TypeError, ValueError):
        unavailable_age = 0

    if telemetry.get("webrtc_available") is False and unavailable_age > 60_000:
        return "offline"

    if age_ms > 15_000:
        return "degraded"
    if telemetry.get("webrtc_degraded") is True or telemetry.get("webrtc_available") is False:
        return "degraded"
    return "connected"


def _best_active_session(sessions, actor_field):
    grouped = {}
    for session in sessions:
        actor_id = getattr(session, actor_field)
        if not actor_id:
            continue
        current = grouped.get(actor_id)
        current_ref = max(current.last_heartbeat_at_ms or 0, current.last_seen_at_ms or 0) if current else -1
        candidate_ref = max(session.last_heartbeat_at_ms or 0, session.last_seen_at_ms or 0)
        if current is None or candidate_ref > current_ref:
            grouped[actor_id] = session
    return grouped


SYSTEM_STATUS_MAP_STYLES = {
    UserStatus.SystemStatus.EMERGENCY: {"bg": "#ff00ff", "border": "#cc00cc"},
    UserStatus.SystemStatus.OWN_INITIATIVE: {"bg": "#e03131", "border": "#b42323"},
    UserStatus.SystemStatus.SPEECH_REQUEST: {"bg": "#7048e8", "border": "#5636b8"},
    UserStatus.SystemStatus.INFORMATION_REQUEST: {"bg": "#5f3dc4", "border": "#4527a0"},
    UserStatus.SystemStatus.EN_ROUTE_TO_INCIDENT: {"bg": "#f08c00", "border": "#b56600"},
    UserStatus.SystemStatus.ON_SCENE: {"bg": "#e03131", "border": "#b42323"},
    UserStatus.SystemStatus.EN_ROUTE_TO_DESTINATION: {"bg": "#ffd43b", "border": "#c9a227"},
    UserStatus.SystemStatus.AVAILABLE_SOON: {"bg": "#ffd43b", "border": "#c9a227"},
    UserStatus.SystemStatus.AVAILABLE_OFF_STATION: {"bg": "#1c7ed6", "border": "#1864ab"},
    UserStatus.SystemStatus.AT_STATION: {"bg": "#2f9e44", "border": "#237032"},
    UserStatus.SystemStatus.DELAYED_AVAILABILITY: {"bg": "#2b8a3e", "border": "#1f5f2c"},
    UserStatus.SystemStatus.OUT_OF_SERVICE: {"bg": "#495057", "border": "#212529"},
    UserStatus.SystemStatus.IN_SERVICE_SOON: {"bg": "#fcc419", "border": "#c99700"},
    UserStatus.SystemStatus.PRIVATE_CALL_REQUEST: {"bg": "#7048e8", "border": "#5636b8"},
    UserStatus.SystemStatus.URGENT_SPEECH_REQUEST: {"bg": "#d63384", "border": "#a61e63"},
    UserStatus.SystemStatus.ASSIGNMENT_GIVEN: {"bg": "#15aabf", "border": "#0f7c8c"},
    UserStatus.SystemStatus.ALERT_RECEIVED: {"bg": "#0c8599", "border": "#0b7285"},
}

DEFAULT_SYSTEM_STATUS_MAP_STYLE = {"bg": "#495057", "border": "#212529"}


@login_required
@require_GET
def dispatch_locations(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    _config, profile, _settings, _effective, _buttons = _ensure_dispatch_settings(dispatch_user)
    allowed_status_ids = _schema_status_ids(profile.status_schema)
    radios = list(
        RadioUser.objects.filter(tenant=tenant)
        .select_related("user_status", "user_contact_status", "current_channel")
        .order_by("external_name")
    )

    # Determine TX state from the authoritative server-side floor owner.  This
    # keeps the map independent from whichever dispatch browser currently has
    # the radio tab open.
    transmitting_radio_ids = set(
        ChannelState.objects.filter(
            tenant=tenant,
            active_session__radio_user__isnull=False,
            floor_status__in=[
                ChannelState.FloorStatus.ACTIVE,
                ChannelState.FloorStatus.EMERGENCY,
            ],
        ).values_list("active_session__radio_user_id", flat=True)
    )

    items = []
    channels = {}
    location_cutoff_ms = now_ms() - (5 * 60 * 1000)
    for radio in radios:
        # A map position is valid only when it is a recent, reliable GPS fix.
        # Whether periodic GPS is currently enabled must not invalidate an
        # already received reliable position during its five-minute lifetime.
        point = radio.last_location
        accuracy = radio.last_location_accuracy_m
        if (
            point is not None
            and (
                not radio.last_location_at_ms
                or radio.last_location_at_ms < location_cutoff_ms
                or accuracy is None
                or accuracy >= 25.0
            )
        ):
            point = None
        status = _status_in_schema(radio, allowed_status_ids)
        has_dispatch_channel = bool(
            radio.current_channel_id
            and radio.current_channel.channel_type != Channel.ChannelType.ECHO
        )
        channel_id = str(radio.current_channel_id) if has_dispatch_channel else "unassigned"
        channel_name = radio.current_channel.name if has_dispatch_channel else "Niet toegewezen"
        channels[channel_id] = channel_name
        item = {
            "id": str(radio.pk),
            "name": radio.external_name,
            "slug": radio.slug,
            "channel_id": channel_id,
            "channel": channel_name,
            "frontend_status": (
                (status.display_label or status.display_status or status.display_code)
                if status else ""
            ),
            "system_status": status.system_status if status else None,
            "status_color": (
                SYSTEM_STATUS_MAP_STYLES.get(status.system_status, DEFAULT_SYSTEM_STATUS_MAP_STYLE)["bg"]
                if status else DEFAULT_SYSTEM_STATUS_MAP_STYLE["bg"]
            ),
            "status_border_color": (
                SYSTEM_STATUS_MAP_STYLES.get(status.system_status, DEFAULT_SYSTEM_STATUS_MAP_STYLE)["border"]
                if status else DEFAULT_SYSTEM_STATUS_MAP_STYLE["border"]
            ),
            "status_icon_bg_color": (
                f'{SYSTEM_STATUS_MAP_STYLES.get(status.system_status, DEFAULT_SYSTEM_STATUS_MAP_STYLE)["bg"]}33'
                if status else f'{DEFAULT_SYSTEM_STATUS_MAP_STYLE["bg"]}33'
            ),
            "location_enabled": int(radio.location_interval_seconds or 0) > 0,
            "location_interval_seconds": int(radio.location_interval_seconds or 0),
            "transmitting": radio.pk in transmitting_radio_ids,
            "location": None,
        }
        if point is not None:
            item["location"] = {
                "latitude": point.y,
                "longitude": point.x,
                "accuracy_m": radio.last_location_accuracy_m,
                "timestamp_ms": radio.last_location_at_ms,
            }
        items.append(item)
    return JsonResponse({
        "ok": True,
        "timestamp_ms": now_ms(),
        "channels": [
            {"id": channel_id, "name": name}
            for channel_id, name in sorted(channels.items(), key=lambda item: item[1].casefold())
        ],
        "radios": items,
    })



@login_required
@require_GET
def addressbook_connection_status(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    current_ms = now_ms()
    sessions = list(DeviceSession.objects.filter(tenant=tenant, status=DeviceSession.Status.ACTIVE))
    radio_sessions = _best_active_session(sessions, "radio_user_id")
    dispatch_sessions = _best_active_session(sessions, "dispatch_user_id")

    radios = {
        str(item.pk): _session_connection_status(radio_sessions.get(item.pk), current_ms=current_ms)
        for item in RadioUser.objects.filter(tenant=tenant).only("pk")
    }
    dispatchers = {
        str(item.pk): _session_connection_status(
            dispatch_sessions.get(item.pk), is_dispatch=True, current_ms=current_ms
        )
        for item in DispatchUser.objects.filter(tenant=tenant).only("pk")
    }
    return JsonResponse({
        "ok": True,
        "timestamp_ms": current_ms,
        "radios": radios,
        "dispatchers": dispatchers,
    })


@login_required
def radio_settings(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    if dispatch_user.tenant_id != tenant.pk:
        raise Http404
    _config, _profile, user_settings, effective, effective_buttons = _ensure_dispatch_settings(dispatch_user)

    if request.method == "GET":
        return JsonResponse({"ok": True, "radio_settings": effective, "buttons": effective_buttons})

    if request.method != "POST":
        return JsonResponse({"detail": "Methode niet toegestaan."}, status=405)

    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "Ongeldige JSON."}, status=400)

    patch = payload.get("radio_settings", {})
    if not isinstance(patch, dict):
        return JsonResponse({"detail": "radio_settings moet een object zijn."}, status=400)

    button_patch = payload.get("buttons")
    update_fields = []
    if patch:
        user_settings.radio_settings = _merge_settings(user_settings.radio_settings, patch)
        update_fields.append("radio_settings")
    if button_patch is not None:
        sanitized = _sanitize_button_overrides(button_patch)
        if not isinstance(button_patch, dict) or len(sanitized) != len(button_patch):
            return JsonResponse({"detail": "buttons mag alleen button-id: true/false bevatten."}, status=400)
        config_ids = {
            str(item.get("id"))
            for group in (user_settings.dispatch_profile.dispatch_config.buttons or {}).values()
            if isinstance(group, list)
            for item in group
            if isinstance(item, dict) and item.get("id")
        }
        user_settings.buttons = {
            **_sanitize_button_overrides(user_settings.buttons),
            **{key: value for key, value in sanitized.items() if key in config_ids},
        }
        update_fields.append("buttons")
    if update_fields:
        user_settings.save(update_fields=[*update_fields, "last_update_ms"])

    config = user_settings.dispatch_profile.dispatch_config
    effective = _merge_settings(
        _default_dispatch_radio_settings(),
        config.radio_settings,
        user_settings.dispatch_profile.radio_settings,
        user_settings.radio_settings,
    )
    effective_buttons = _effective_dispatch_buttons(config, user_settings.dispatch_profile, user_settings)
    return JsonResponse({"ok": True, "radio_settings": effective, "buttons": effective_buttons})

@login_required
def media_bootstrap(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    dispatch_session = _dispatch_session(request, dispatch_user)
    session, control_token = _dispatch_control_session(request, dispatch_user)
    _dispatch_channels_queryset(tenant).filter(status=Channel.Status.INACTIVE).update(
        status=Channel.Status.ACTIVE, last_update_ms=now_ms(),
    )
    channels = list(
        _dispatch_channels_queryset(tenant)
        .order_by("name")
        .values("slug", "name")
    )
    dispatch_token = signing.dumps(
        {"purpose": "dispatch-control", "session_id": session.pk, "tenant": tenant_slug},
        salt="dispatch.control",
        compress=True,
    )
    return JsonResponse({"ok": True, "data": {
        "identity": {"user_slug": dispatch_user.slug, "display_name": dispatch_user.display_name},
        "channels": channels,
        "tx_permission_mode": tenant.tx_permission_mode,
        "audio": {
            "session_id": session.pk,
            "access_token": control_token,
            "dispatch_token": dispatch_token,
            "dispatch_session_id": dispatch_session.pk,
                        "webrtc_token_url": f"/dispatch/{tenant_slug}/api/webrtc/token/",
            "opus_bitrate_kbps": dispatch_user.user_profile.opus_bitrate_kbps if dispatch_user.user_profile else 20,
            "opus_dtx": dispatch_user.user_profile.opus_dtx if dispatch_user.user_profile else True,
            "opus_red": dispatch_user.user_profile.opus_red if dispatch_user.user_profile else False,
        },
    }})


@login_required
@require_POST
def webrtc_token(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "Ongeldige JSON."}, status=400)
    channel_slug = str(payload.get("channel_slug") or "")
    channel = get_object_or_404(Channel, tenant=tenant, slug=channel_slug, channel_type=Channel.ChannelType.GROUP)
    return JsonResponse(dispatch_connection_payload(
        request=request, dispatch_user=dispatch_user, channel=channel,
        profile=dispatch_user.user_profile,
    ))


@login_required
@require_POST
def heartbeat(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    session = _dispatch_session(request, dispatch_user)
    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "Ongeldige JSON."}, status=400)
    telemetry = payload.get("telemetry")
    received_at_ms = now_ms()
    if isinstance(telemetry, dict):
        session.telemetry = {
            "device_type": "dispatch",
            "device": dispatch_user.display_name,
            "device_slug": dispatch_user.slug,
            "tenant": dispatch_user.tenant.slug,
            "received_at_ms": received_at_ms,
            **telemetry,
        }
        telemetry_logger.info(json.dumps({
            "type": "heartbeat_telemetry", "dispatch_session_id": session.pk, **session.telemetry,
        }, ensure_ascii=False, separators=(",", ":")))
    session.last_seen_at_ms = received_at_ms
    session.save(update_fields=["telemetry", "last_seen_at_ms", "last_update_ms"])
    return JsonResponse({"ok": True, "timestamp_ms": session.last_seen_at_ms})


@login_required
@require_GET
def call_requests(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    _config, profile, _settings, _effective, _buttons = _ensure_dispatch_settings(dispatch_user)
    allowed_status_ids = _schema_status_ids(profile.status_schema)
    rows = (
        CallRequest.objects.filter(
            tenant=tenant,
            status=CallRequest.Status.ACTIVE,
            accepted_at_ms__isnull=True,
        )
        .select_related("channel", "radio_user", "radio_user__user_contact_status", "radio_user__user_status")
        .order_by("priority", "activated_at_ms")
    )
    return JsonResponse({"ok": True, "data": [{
        "id": item.pk,
        "radio_name": item.radio_user.display_name,
        "priority": item.priority,
        "status": (
            (
                item.radio_user.frontend_status.display_code
                or item.radio_user.frontend_status.display_code
            )
            if (
                item.radio_user.frontend_status
                and item.radio_user.frontend_status.pk in allowed_status_ids
            )
            else "Geen status"
        ),
        "channel_id": str(item.channel_id),
        "channel_name": item.channel.name,
        "activated_at_ms": item.activated_at_ms,
    } for item in rows]})


@login_required
@require_POST
@transaction.atomic
def accept_call_request(request, tenant_slug, request_id):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    item = get_object_or_404(
        CallRequest.objects.select_for_update().select_related("channel", "radio_user"),
        pk=request_id, tenant=tenant, priority=1, status=CallRequest.Status.ACTIVE,
    )
    if item.accepted_at_ms is None:
        item.accepted_at_ms = now_ms()
        item.save(update_fields=["accepted_at_ms", "last_update_ms"])
        dispatch_user = _dispatch_user(request, tenant_slug)
        create_event(
            tenant=tenant, action_type="EMERGENCY_ACCEPTED",
            actor_slug=dispatch_user.slug, actor_name=dispatch_user.display_name,
            subject_slug=item.radio_user.slug, subject_name=item.radio_user.display_name,
            channel_slug=item.channel.slug, channel_name=item.channel.name,
            entity_type="call_request", entity_slug=str(item.pk), entity_name=item.radio_user.display_name,
            value=str(item.priority), message=f"Noodoproep van {item.radio_user.display_name} geaccepteerd",
            metadata={"request_id": item.pk, "priority": item.priority},
        )
    layer = get_channel_layer()
    if layer:
        transaction.on_commit(lambda: async_to_sync(layer.group_send)(
            control_group_name(item.tenant_id, item.channel_id),
            {"type": "control.message", "sender": "dispatch", "payload": {
                "type": "emergency_accepted", "request_id": item.pk,
                "channel_id": item.channel_id, "radio_slug": item.radio_user.slug,
                "radio_name": item.radio_user.display_name, "timestamp_ms": item.accepted_at_ms,
            }},
        ))
    return JsonResponse({"ok": True, "data": {
        "id": item.pk, "accepted_at_ms": item.accepted_at_ms,
        "channel_id": str(item.channel_id), "radio_name": item.radio_user.display_name,
    }})


@login_required
@require_POST
@transaction.atomic
def cancel_radio_emergency(request, tenant_slug, radio_id):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    # Vergrendel uitsluitend de RadioUser-tabel. user_status en user_contact_status
    # zijn nullable relaties; PostgreSQL staat FOR UPDATE niet toe op de
    # nullable zijde van de LEFT JOIN die select_related() daarvoor maakt.
    radio = get_object_or_404(
        RadioUser.objects.select_for_update(),
        pk=radio_id, tenant=tenant,
    )
    if radio.user_status_id:
        radio.user_status = UserStatus.objects.get(pk=radio.user_status_id)
    if radio.user_contact_status_id:
        radio.user_contact_status = UserStatus.objects.get(pk=radio.user_contact_status_id)
    status = cancel_emergency_status(user=radio, clear_reason="Beëindigd door dispatch")
    dispatch_user = _dispatch_user(request, tenant_slug)
    create_event(
        tenant=tenant, action_type="EMERGENCY_HANDLED_BY_DISPATCH",
        actor_slug=dispatch_user.slug, actor_name=dispatch_user.display_name,
        subject_slug=radio.slug, subject_name=radio.display_name,
        channel_slug=radio.current_channel.slug if radio.current_channel_id else "",
        channel_name=radio.current_channel.name if radio.current_channel_id else "",
        entity_type="radio_user", entity_slug=radio.slug, entity_name=radio.display_name,
        message=f"Noodoproep van {radio.display_name} beëindigd door dispatch",
        metadata={"reason": "Beëindigd door dispatch"},
    )
    return JsonResponse({"ok": True, "data": {
        "radio_id": radio.pk,
        "radio_name": radio.display_name,
        "status_slug": status.slug if status else None,
        "status_label": status.display_code if status else "",
        "clear_reason": "Beëindigd door dispatch",
    }})


@login_required
@require_POST
@transaction.atomic
def set_radio_user_status(request, tenant_slug, radio_id):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    _config, profile, _settings, _effective, _buttons = _ensure_dispatch_settings(dispatch_user)

    try:
        status_id = str(json.loads(request.body or b"{}").get("status_id") or "").strip()
    except (TypeError, ValueError, json.JSONDecodeError):
        return JsonResponse({"ok": False, "error": "Ongeldige statuskeuze."}, status=400)

    radio = get_object_or_404(
        RadioUser.objects.select_for_update(),
        pk=radio_id,
        tenant=tenant,
    )

    status = get_object_or_404(
        profile.status_schema.statuses.filter(
            tenant=tenant,
            call_request_priority__isnull=True,
        ),
        pk=status_id,
    )

    radio.user_status = status
    radio.save(update_fields=["user_status", "last_update_ms"])

    return JsonResponse({"ok": True, "data": {
        "radio_id": radio.pk,
        "status_id": str(status.pk),
        "status_slug": status.slug,
        "display_code": status.display_code,
        "display_status": status.display_status,
        "display_label": status.display_label,
        "label": status.selection_label,
        "choice_label": status.selection_label,
    }})


@login_required
@require_POST
@transaction.atomic
def set_radio_channel(request, tenant_slug, radio_id):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    try:
        channel_id = str(json.loads(request.body or b"{}").get("channel_id") or "").strip()
    except (TypeError, ValueError, json.JSONDecodeError):
        return JsonResponse({"ok": False, "error": "Ongeldige kanaalkeuze."}, status=400)
    radio = get_object_or_404(
        RadioUser.objects.select_for_update(),
        pk=radio_id, tenant=tenant,
    )
    if radio.current_channel_id:
        radio.current_channel = Channel.objects.get(pk=radio.current_channel_id)
    if radio.user_status_id:
        radio.user_status = UserStatus.objects.get(pk=radio.user_status_id)
    if radio.user_contact_status_id:
        radio.user_contact_status = UserStatus.objects.get(pk=radio.user_contact_status_id)
    channel = get_object_or_404(
        Channel, pk=channel_id, tenant=tenant, channel_type=Channel.ChannelType.GROUP
    )
    if channel.status != Channel.Status.ACTIVE:
        channel.status = Channel.Status.ACTIVE
        channel.save(update_fields=["status", "last_update_ms"])
    old_channel = radio.current_channel
    if old_channel and old_channel.pk != channel.pk:
        sessions = list(DeviceSession.objects.select_for_update().filter(
            radio_user=radio, tenant=tenant, status=DeviceSession.Status.ACTIVE,
        ))
        for session in sessions:
            if ChannelState.objects.filter(channel=old_channel, active_session=session).exists():
                force_release_floor(channel=old_channel, session=session, reason="dispatch_channel_change")
        radio.current_channel = channel
        radio.save(update_fields=["current_channel", "last_update_ms"])
        # RadioUser.save() verhuist actieve requests en de emergency-channel
        # state mee. Deze update is defensief voor bestaande/legacy records.
        CallRequest.objects.filter(
            radio_user=radio,
            status=CallRequest.Status.ACTIVE,
        ).exclude(channel=channel).update(
            channel=channel,
            last_update_ms=now_ms(),
        )
        DeviceSession.objects.filter(pk__in=[session.pk for session in sessions]).update(
            current_channel=channel, last_update_ms=now_ms(),
        )
    return JsonResponse({"ok": True, "data": {
        "radio_id": radio.pk, "channel_id": str(channel.pk),
        "channel_slug": channel.slug, "channel_name": channel.name,
        "emergency_active": bool(radio.user_contact_status_id and radio.user_contact_status.call_request_priority == 1),
    }})



def _dispatch_ptt_error(exc):
    detail = getattr(exc, "detail", None)
    if detail is None:
        detail = getattr(exc, "message", None) or str(exc)
    return JsonResponse({"detail": detail}, status=400)


@login_required
@require_POST
@transaction.atomic
def dispatch_ptt_request(request, tenant_slug, channel_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    channel = get_object_or_404(Channel, tenant=tenant, slug=channel_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    session, _ = _dispatch_control_session(request, dispatch_user)
    try:
        body = json.loads(request.body or b"{}")
        client_request_id = str(body.get("client_request_id") or "")
        if not client_request_id:
            return JsonResponse({"detail": "client_request_id ontbreekt"}, status=400)
        request_type = body.get("request_type", "normal")
        if request_type not in {"normal", "emergency"}:
            return JsonResponse({"detail": "Ongeldig request_type"}, status=400)
        result = request_floor(
            channel=channel,
            session=session,
            emergency=request_type == "emergency",
            client_request_id=client_request_id,
            allow_unassigned_channel=True,
        )
    except (ValueError, TypeError) as exc:
        return _dispatch_ptt_error(exc)
    except Exception as exc:
        # request_floor gebruikt DRF/Django ValidationError voor verwachte weigeringen.
        if exc.__class__.__name__ == "ValidationError":
            return _dispatch_ptt_error(exc)
        raise
    return JsonResponse({
        "timestamp_ms": now_ms(),
        "status": result.status,
        "effective_priority": result.effective_priority,
        "floor_token": result.floor_token,
        "event_sequence": result.event_sequence,
        "required_hold_ms": result.required_hold_ms,
        "remaining_hold_ms": result.remaining_hold_ms,
    })


@login_required
@require_POST
@transaction.atomic
def dispatch_ptt_release(request, tenant_slug, channel_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    channel = get_object_or_404(Channel, tenant=tenant, slug=channel_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    session, _ = _dispatch_control_session(request, dispatch_user)
    try:
        body = json.loads(request.body or b"{}")
        floor_token = str(body.get("floor_token") or "")
        client_request_id = str(body.get("client_request_id") or "")
        if not client_request_id:
            return JsonResponse({"detail": "client_request_id ontbreekt"}, status=400)
        if floor_token:
            release_floor(
                channel=channel, session=session, floor_token=floor_token,
                client_request_id=client_request_id,
            )
        else:
            cancel_floor_waiter(channel=channel, session=session)
    except (ValueError, TypeError) as exc:
        return _dispatch_ptt_error(exc)
    except Exception as exc:
        if exc.__class__.__name__ == "ValidationError":
            return _dispatch_ptt_error(exc)
        raise
    return JsonResponse({"released": True, "timestamp_ms": now_ms()})


@login_required
@require_POST
@transaction.atomic
def dispatch_ptt_revoke(request, tenant_slug, channel_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    channel = get_object_or_404(Channel, tenant=tenant, slug=channel_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    revoked = revoke_active_floor(
        channel=channel,
        actor_slug=dispatch_user.slug,
        actor_name=dispatch_user.display_name,
        reason="dispatch_revoke",
    )
    return JsonResponse({"ok": True, "revoked": bool(revoked), "timestamp_ms": now_ms()})


@login_required
@require_POST
def dispatch_parrot_start(request, tenant_slug, channel_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    channel = get_object_or_404(Channel, tenant=tenant, slug=channel_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    session, _ = _dispatch_control_session(request, dispatch_user)
    try:
        started = start_parrot_floor(channel=channel, owner_session=session)
    except Exception as exc:
        if exc.__class__.__name__ == "ValidationError":
            return _dispatch_ptt_error(exc)
        raise
    return JsonResponse({"started": started})


@login_required
@require_POST
def dispatch_parrot_stop(request, tenant_slug, channel_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    channel = get_object_or_404(Channel, tenant=tenant, slug=channel_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    session, _ = _dispatch_control_session(request, dispatch_user)
    try:
        stopped = stop_parrot_floor(channel=channel, owner_session=session)
    except Exception as exc:
        if exc.__class__.__name__ == "ValidationError":
            return _dispatch_ptt_error(exc)
        raise
    return JsonResponse({"stopped": stopped})


@login_required
@require_GET
def channel_presence(request, tenant_slug):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    dispatch_user = _dispatch_user(request, tenant_slug)
    dispatch_session, _ = _dispatch_control_session(request, dispatch_user)
    cutoff = now_ms() - 60_000
    rows = (
        ChannelPresence.objects.filter(
            tenant=tenant,
            channel__channel_type=Channel.ChannelType.GROUP,
            listening=True,
            last_update_ms__gte=cutoff,
        )
        .values("channel_id", "role")
        .annotate(count=Count("session_id", distinct=True))
    )
    counts = {}
    for row in rows:
        channel = counts.setdefault(str(row["channel_id"]), {"radios": 0, "dispatchers": 0})
        channel["dispatchers" if row["role"] == ChannelPresence.Role.DISPATCH else "radios"] = row["count"]
    other_rows = (
        ChannelPresence.objects.filter(
            tenant=tenant, channel__channel_type=Channel.ChannelType.GROUP,
            listening=True, last_update_ms__gte=cutoff,
        )
        .exclude(session=dispatch_session)
        .values("channel_id")
        .annotate(count=Count("session_id", distinct=True))
    )
    for row in other_rows:
        counts.setdefault(str(row["channel_id"]), {"radios": 0, "dispatchers": 0})["other_users"] = row["count"]
    for channel in counts.values():
        channel.setdefault("other_users", 0)
    visible_channels = list(_dispatch_channels_queryset(tenant).prefetch_related("linked_channels").order_by("name"))
    link_group_by_id, _link_groups = _channel_link_groups(visible_channels)
    for channel in visible_channels:
        entry = counts.setdefault(str(channel.pk), {"radios": 0, "dispatchers": 0, "other_users": 0})
        entry["link_count"] = max(0, len(link_group_by_id.get(channel.pk, [])) - 1)
    return JsonResponse({"ok": True, "data": counts})


@login_required
@require_POST
@transaction.atomic
def clear_call_request(request, tenant_slug, request_id):
    tenant = get_object_or_404(_accessible_tenants(request.user), slug=tenant_slug)
    item = get_object_or_404(
        CallRequest.objects.select_for_update().select_related("radio_user"),
        pk=request_id,
        tenant=tenant,
        priority__gt=1,
    )
    radio = None
    if item.status == CallRequest.Status.ACTIVE:
        radio = RadioUser.objects.select_for_update().get(pk=item.radio_user_id)
        # Een normale gebruikersstatus staat los van de gespreksstatus.
        # Afhandelen wist daarom uitsluitend user_contact_status.
        RadioUser.objects.filter(pk=radio.pk).update(
            user_contact_status_id=None, last_update_ms=now_ms(),
        )
        radio.user_contact_status_id = None
        sync_emergency_user(radio)
        item.clear(reason="dispatch_ptt")
        dispatch_user = _dispatch_user(request, tenant_slug)
        create_event(
            tenant=tenant, action_type="CALL_REQUEST_CLEARED",
            actor_slug=dispatch_user.slug, actor_name=dispatch_user.display_name,
            subject_slug=radio.slug, subject_name=radio.display_name,
            channel_slug=item.channel.slug, channel_name=item.channel.name,
            entity_type="call_request", entity_slug=str(item.pk), entity_name=radio.display_name,
            value=str(item.priority), message=f"Spraakaanvraag van {radio.display_name} afgehandeld",
            metadata={"request_id": item.pk, "priority": item.priority, "reason": "dispatch_ptt"},
        )
    return JsonResponse({"ok": True, "data": {
        "id": item.pk,
        "status": item.status,
        "status_label": item.get_status_display(),
        "cleared_at_ms": item.cleared_at_ms,
        "frontend_status_id": radio.user_status_id if radio else None,
    }})
