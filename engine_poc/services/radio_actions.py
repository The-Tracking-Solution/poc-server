"""Autoritatieve radio-acties voor de soft-radio.

Deze module bevat de bedrijfslogica die nooit door de browser zelf als waarheid
mag worden bepaald. De HTTP views in ``ui_radio`` zijn alleen transportlagen:
ze halen gebruiker/sessie op en delegeren daarna naar deze functies.
"""
from __future__ import annotations

import uuid

from django.core.exceptions import ValidationError
from django.db import transaction

from engine_poc.models import CallRequest, Channel, ChannelState, DeviceSession, UserStatus
from engine_poc.channel_links import canonical_link_channel
from engine_radio.models import RadioUser
from engine_poc.services.floor import cancel_floor_waiter, force_release_floor, request_floor, release_floor
from engine_poc.timeutils import now_ms


def available_channels(user: RadioUser):
    """Alle actieve kanalen van de tenant; radio's mogen deze direct selecteren en gebruiken."""
    return Channel.objects.filter(
        status=Channel.Status.ACTIVE,
        tenant=user.tenant,
    ).order_by("name")


def allowed_channels(user: RadioUser):
    """Kanaallijst voor channel up/down: uitsluitend UserProfile.channels."""
    if not user.user_profile:
        return Channel.objects.none()
    return user.user_profile.channels.filter(
        status=Channel.Status.ACTIVE,
        tenant=user.tenant,
    ).order_by("name")


@transaction.atomic
def select_channel(*, user: RadioUser, session: DeviceSession, channel_slug: str) -> Channel:
    """Selecteer een kanaal na alle server-side controles."""
    if ChannelState.objects.filter(active_session=session).exists():
        raise ValidationError("Kanaal wijzigen is geblokkeerd tijdens zenden.")

    channel = available_channels(user).get(slug=channel_slug)
    user.current_channel = channel
    user.save(update_fields=["current_channel", "last_update_ms"])
    session.current_channel = channel
    session.save(update_fields=["current_channel", "last_update_ms"])
    return channel


def move_channel(*, user: RadioUser, session: DeviceSession, step: int) -> Channel:
    """Ga cyclisch naar het volgende/vorige toegestane kanaal."""
    channels = list(allowed_channels(user))
    if not channels:
        raise ValidationError("Geen kanalen beschikbaar.")
    current_id = user.current_channel_id
    current_index = next((i for i, channel in enumerate(channels) if channel.id == current_id), None)
    if current_index is None:
        # Vanaf een direct geselecteerd, niet-toegewezen kanaal springt UP naar
        # het eerste profielkanaal en DOWN naar het laatste profielkanaal.
        current_index = -1 if step > 0 else 0
    next_channel = channels[(current_index + step) % len(channels)]
    return select_channel(user=user, session=session, channel_slug=next_channel.slug)


def start_ptt(*, user: RadioUser, session: DeviceSession, previous_floor_token: str = "",
              automatic_emergency: bool = False) -> dict:
    """Vraag de PTT-vloer aan. Alleen de backend beslist of zenden is toegestaan."""
    channel = user.current_channel
    if not channel:
        raise ValidationError("Geen kanaal geselecteerd.")

    emergency_status = bool(
        user.user_contact_status_id
        and user.user_contact_status.call_request_priority == 1
    )
    # De server leidt de prioriteit uitsluitend af uit de actuele status en het
    # type verzoek. De browser kan geen willekeurige prioriteitswaarde meesturen.
    automatic_emergency = bool(automatic_emergency and emergency_status)
    effective_priority = 99 if automatic_emergency else (90 if emergency_status else None)
    result = request_floor(
        channel=channel,
        session=session,
        emergency=automatic_emergency,
        priority_override=effective_priority,
        client_request_id=uuid.uuid4().hex,
        allow_unassigned_channel=True,
    )
    if result.status != "granted":
        if result.status in {"waiting", "emergency_waiting", "preemption_pending"}:
            return {
                "waiting": True,
                "effective_priority": result.effective_priority,
                "emergency": automatic_emergency,
                "emergency_status": emergency_status,
                "required_hold_ms": result.required_hold_ms,
                "remaining_hold_ms": result.remaining_hold_ms,
                "urgent_reset": False,
            }
        raise ValidationError("Kanaal is bezet; PTT is niet toegekend.")

    token = result.floor_token or previous_floor_token
    if not token:
        # Herstelpad voor een stale floor zonder bruikbaar token.
        force_release_floor(channel=channel, session=session, reason="radio_recovery")
        result = request_floor(
            channel=channel,
            session=session,
            emergency=automatic_emergency,
            priority_override=effective_priority,
            client_request_id=uuid.uuid4().hex,
        )
        token = result.floor_token or ""
    if not token:
        raise ValidationError("PTT kon niet worden gestart: geen floor-token ontvangen.")

    max_tx_duration_ms = (
        15000
        if automatic_emergency
        else (channel.max_ptt_duration_ms if channel.max_ptt_duration_ms is not None else channel.tenant.default_max_ptt_duration_ms)
    )

    return {
        "waiting": False,
        "floor_token": token,
        "event_sequence": result.event_sequence,
        "effective_priority": result.effective_priority,
        "emergency": automatic_emergency,
        "emergency_status": emergency_status,
        "max_tx_duration_ms": max_tx_duration_ms,
        "urgent_reset": False,
    }


def heartbeat_ptt(*, user: RadioUser, session: DeviceSession, floor_token: str) -> dict:
    """Houd een toegekende PTT-vloer actief."""
    channel = user.current_channel
    if not channel or not floor_token:
        raise ValidationError("Geen actieve PTT-sessie.")

    floor_channel = canonical_link_channel(channel)
    state_obj = ChannelState.objects.filter(channel=floor_channel, active_session=session).first()
    if not state_obj:
        raise ValidationError("De PTT-vloer is niet meer actief.")

    ts = now_ms()
    state_obj.save(update_fields=["last_update_ms"])
    session.last_seen_at_ms = ts
    session.last_heartbeat_at_ms = ts
    session.save(update_fields=["last_seen_at_ms", "last_heartbeat_at_ms", "last_update_ms"])
    return {"active": True, "timestamp_ms": ts}


def stop_ptt(*, user: RadioUser, session: DeviceSession, floor_token: str) -> None:
    """Geef actieve floor vrij of verwijder een losgelaten PTT uit de wachtrij."""
    if not user.current_channel:
        return
    if floor_token:
        release_floor(
            channel=user.current_channel,
            session=session,
            floor_token=floor_token,
            client_request_id=uuid.uuid4().hex,
        )
    else:
        cancel_floor_waiter(channel=user.current_channel, session=session)


@transaction.atomic
def select_user_status(*, user: RadioUser, status_slug: str) -> UserStatus:
    """Routeer een gekozen status naar user_status of user_contact_status."""
    if not status_slug:
        raise ValidationError("Geen status opgegeven.")
    status = UserStatus.objects.get(tenant=user.tenant, slug=status_slug)

    if status.call_request_priority is None:
        user.user_status = status
        user.save(update_fields=["user_status", "last_update_ms"])
        return status

    active = (
        CallRequest.objects.select_for_update()
        .filter(radio_user=user, status=CallRequest.Status.ACTIVE)
        .order_by("activated_at_ms", "pk")
        .first()
    )
    if active and status.call_request_priority > active.priority:
        raise ValidationError("Een actieve spraakaanvraag kan alleen naar een hogere prioriteit worden geüpgraded.")

    user.user_contact_status = status
    user.save(update_fields=["user_contact_status", "last_update_ms"])
    return status


@transaction.atomic
def cancel_emergency_status(*, user: RadioUser, clear_reason: str = "Beëindigd door radio") -> UserStatus | None:
    """Beëindig P1 zonder de normale user_status te wijzigen."""
    if not user.user_contact_status_id or user.user_contact_status.call_request_priority != 1:
        raise ValidationError("Er is geen eigen noodoproep actief.")
    cleared_at = now_ms()
    CallRequest.objects.filter(
        radio_user=user, priority=1, status=CallRequest.Status.ACTIVE,
    ).update(
        status=CallRequest.Status.CLEARED, cleared_at_ms=cleared_at,
        clear_reason=clear_reason, last_update_ms=cleared_at,
    )
    user.user_contact_status = None
    user.save(update_fields=["user_contact_status", "last_update_ms"])
    return user.frontend_status
