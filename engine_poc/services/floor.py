import secrets
from dataclasses import dataclass

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from rest_framework.exceptions import ValidationError

from engine_poc.control_protocol import control_group_name
from engine_poc.channel_links import canonical_link_channel, linked_group_members
from engine_poc.models import Channel, ChannelState, DeviceSession, FloorWaiter
from engine_poc.timeutils import now_ms
from .events import create_event


# Alles vanaf deze prioriteit mag een lagere actieve TX zonder wachttijd
# preëmpten. 91..99 is gereserveerd voor operationele spoed/nood-prioriteiten.
DIRECT_PREEMPT_PRIORITY = 91
# Wachtenden die geen nieuwe PTT-request meer sturen worden als losgelaten
# beschouwd. De clients pollen tijdens een ingedrukte PTT veel sneller.
WAITER_STALE_MS = 5_000


@dataclass(frozen=True)
class FloorResult:
    status: str
    effective_priority: int
    floor_token: str | None = None
    event_sequence: int | None = None
    required_hold_ms: int | None = None
    remaining_hold_ms: int | None = None


def _identity(session: DeviceSession):
    profile = session.user_profile
    if profile is None:
        raise ValidationError("Device heeft geen UserProfile en kan geen PTT aanvragen.")
    return session.actor_slug, session.actor_name


def _priority(session: DeviceSession, emergency: bool, priority_override: int | None = None) -> int:
    if priority_override is not None:
        return priority_override
    if emergency:
        return 99
    profile = session.user_profile
    if profile is None:
        raise ValidationError("Device heeft geen UserProfile en kan geen PTT aanvragen.")
    return profile.ptt_priority


def _clear_pending(state: ChannelState):
    state.pending_session = None
    state.pending_user_slug = ""
    state.pending_user_name = ""
    state.pending_priority = None
    state.pending_since_ms = None


def _notify(channel: Channel, payload: dict):
    layer = get_channel_layer()
    if not layer:
        return
    for member in linked_group_members(channel):
        async_to_sync(layer.group_send)(control_group_name(member.tenant_id, member.id), {
            "type": "control.message", "sender": "floor-service", "payload": payload,
        })


def _cleanup_waiters(channel: Channel):
    cutoff = now_ms() - WAITER_STALE_MS
    FloorWaiter.objects.filter(channel=channel).filter(
        last_request_at_ms__lt=cutoff
    ).delete()
    FloorWaiter.objects.filter(channel=channel).exclude(
        session__status=DeviceSession.Status.ACTIVE
    ).delete()


def _top_waiter(channel: Channel):
    _cleanup_waiters(channel)
    return (
        FloorWaiter.objects.filter(channel=channel)
        .select_related("session", "session__radio_user", "session__dispatch_user")
        .order_by("-priority", "requested_at_ms", "pk")
        .first()
    )


def _sync_pending(state: ChannelState):
    waiter = _top_waiter(state.channel)
    if waiter is None:
        _clear_pending(state)
    else:
        slug, name = _identity(waiter.session)
        state.pending_session = waiter.session
        state.pending_user_slug = slug
        state.pending_user_name = name
        state.pending_priority = waiter.priority
        state.pending_since_ms = waiter.requested_at_ms
    state.save(update_fields=[
        "pending_session", "pending_user_slug", "pending_user_name",
        "pending_priority", "pending_since_ms", "last_update_ms",
    ])
    return waiter


def _upsert_waiter(*, channel: Channel, session: DeviceSession, priority: int, emergency: bool):
    ts = now_ms()
    waiter, created = FloorWaiter.objects.select_for_update().get_or_create(
        channel=channel,
        session=session,
        defaults={
            "tenant": channel.tenant,
            "priority": priority,
            "emergency": emergency,
            "requested_at_ms": ts,
            "last_request_at_ms": ts,
        },
    )
    if not created:
        update_fields = ["last_request_at_ms", "last_update_ms"]
        waiter.last_request_at_ms = ts
        # Tijdens dezelfde PTT-hold kan de effectieve prioriteit veranderen
        # (bijv. een noodstatus); behoud het oorspronkelijke FIFO-tijdstip.
        if waiter.priority != priority:
            waiter.priority = priority
            update_fields.append("priority")
        if waiter.emergency != emergency:
            waiter.emergency = emergency
            update_fields.append("emergency")
        waiter.save(update_fields=update_fields)
    return waiter


def _remove_waiter(channel: Channel, session: DeviceSession):
    FloorWaiter.objects.filter(channel=channel, session=session).delete()


def _grant(state: ChannelState, session: DeviceSession, priority: int, emergency: bool, event_sequence: int) -> str:
    raw = secrets.token_urlsafe(40)
    slug, name = _identity(session)
    state.floor_status = ChannelState.FloorStatus.EMERGENCY if emergency else ChannelState.FloorStatus.ACTIVE
    state.active_session = session
    state.active_user_slug = slug
    state.active_user_name = name
    state.active_priority = priority
    state.active_event_sequence = event_sequence
    state.floor_token_hash = make_password(raw)
    state.granted_at_ms = now_ms()
    _remove_waiter(state.channel, session)
    _sync_pending(state)
    state.save()
    return raw


def _reset_state(state: ChannelState):
    state.floor_status = ChannelState.FloorStatus.IDLE
    state.active_session = None
    state.active_user_slug = ""
    state.active_user_name = ""
    state.active_priority = None
    state.active_event_sequence = None
    state.floor_token_hash = ""
    state.granted_at_ms = None
    _sync_pending(state)
    state.save()


def _notify_next_waiter(channel: Channel, state: ChannelState):
    waiter = _sync_pending(state)
    if waiter is None:
        return
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_available",
        "timestamp_ms": now_ms(),
        "session_id": waiter.session_id,
        "effective_priority": waiter.priority,
    }))


def _preempt(*, state: ChannelState, channel: Channel, session: DeviceSession,
             priority: int, emergency: bool, client_request_id: str,
             reason: str, hold_duration_ms: int, source_channel: Channel | None = None) -> FloorResult:
    slug, name = _identity(session)
    previous_session_id = state.active_session_id
    previous = state.active_user_slug
    current_priority = state.active_priority or 0
    event = create_event(
        tenant=channel.tenant, action_type="PTT", actor_slug=slug, actor_name=name,
        subject_slug=previous, channel_slug=channel.slug, channel_name=channel.name,
        ptt_priority=priority, client_request_id=client_request_id,
        metadata={
            "reason": reason,
            "hold_duration_ms": hold_duration_ms,
            "previous_priority": current_priority,
            "phase": "started",
        },
    )
    token = _grant(state, session, priority, emergency, event.sequence_number)
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_revoked", "timestamp_ms": now_ms(), "session_id": previous_session_id,
        "reason": reason, "new_speaker_slug": slug,
    }))
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_granted", "timestamp_ms": now_ms(), "session_id": session.id,
        "speaker_slug": slug, "speaker_name": name, "effective_priority": priority,
        "event_sequence": event.sequence_number, "emergency": emergency,
        "source_channel_id": (source_channel or channel).pk,
        "source_channel_name": (source_channel or channel).name,
    }))
    return FloorResult("granted", priority, token, event.sequence_number)


@transaction.atomic
def request_floor(*, channel: Channel, session: DeviceSession, emergency: bool,
                  client_request_id: str, priority_override: int | None = None,
                  allow_unassigned_channel: bool = False) -> FloorResult:
    source_channel = channel
    channel = canonical_link_channel(channel)
    if session.status != DeviceSession.Status.ACTIVE or session.tenant_id != channel.tenant_id:
        raise ValidationError({"code": "SESSION_NOT_ACTIVE"})
    profile = session.user_profile
    if profile is None:
        raise ValidationError({"code": "USER_PROFILE_REQUIRED"})

    state, _ = ChannelState.objects.select_for_update().get_or_create(
        tenant=channel.tenant, channel=channel
    )
    priority = _priority(session, emergency, priority_override)
    slug, name = _identity(session)

    if state.parrot_active:
        parrot_stale = bool(
            not state.parrot_started_at_ms
            or now_ms() - int(state.parrot_started_at_ms) > 120_000
            or (state.parrot_owner_session_id and state.parrot_owner_session.status != DeviceSession.Status.ACTIVE)
        )
        if parrot_stale:
            state.parrot_active = False
            state.parrot_owner_session = None
            state.parrot_started_at_ms = None
            state.save(update_fields=["parrot_active", "parrot_owner_session", "parrot_started_at_ms", "last_update_ms"])
            transaction.on_commit(lambda: _notify(channel, {
                "type": "floor_released", "timestamp_ms": now_ms(), "session_id": 0,
                "speaker_slug": "parrot", "reason": "parrot_stale", "virtual": True,
            }))
        else:
            waiter = _upsert_waiter(channel=channel, session=session, priority=priority, emergency=emergency)
            _sync_pending(state)
            return FloorResult("waiting", priority)

    # Herhaalde aanvraag door de actieve zender: roteer het token zodat de
    # HTTP-client altijd een bruikbaar onbewerkt token terugkrijgt.
    if state.active_session_id == session.id:
        effective_priority = state.active_priority or priority
        token = _grant(
            state,
            session,
            effective_priority,
            state.floor_status == ChannelState.FloorStatus.EMERGENCY,
            state.active_event_sequence,
        )
        return FloorResult("granted", effective_priority, token, state.active_event_sequence)

    # Elke ingedrukte PTT registreert zich in dezelfde server-side wachtrij.
    waiter = _upsert_waiter(channel=channel, session=session, priority=priority, emergency=emergency)
    _sync_pending(state)

    # Vrij kanaal: alleen de hoogste/FIFO wachtende mag claimen. Dit voorkomt
    # dat twee vrijwel gelijktijdige pollers de wachtrijvolgorde omzeilen.
    if state.floor_status == ChannelState.FloorStatus.IDLE or not state.active_session_id:
        top = _top_waiter(channel)
        if top is not None and top.session_id != session.id:
            return FloorResult("waiting", priority)
        event = create_event(
            tenant=channel.tenant, action_type="PTT", actor_slug=slug, actor_name=name,
            channel_slug=channel.slug, channel_name=channel.name, ptt_priority=priority,
            client_request_id=client_request_id, metadata={"emergency": emergency, "phase": "started"},
        )
        token = _grant(state, session, priority, emergency, event.sequence_number)
        transaction.on_commit(lambda: _notify(channel, {
            "type": "floor_granted", "timestamp_ms": now_ms(), "session_id": session.id,
            "speaker_slug": slug, "speaker_name": name, "effective_priority": priority,
            "event_sequence": event.sequence_number, "emergency": emergency,
            "source_channel_id": source_channel.pk,
            "source_channel_name": source_channel.name,
        }))
        return FloorResult("granted", priority, token, event.sequence_number)

    current_priority = state.active_priority or 0

    # Alleen een hogere prioriteit kan een actieve lagere prioriteit overrulen.
    # 91..99 doen dit direct; normale hogere prioriteiten moeten vanaf de eerste
    # BUSY/wachtrijregistratie de tenant-holdtijd vasthouden (standaard 3 s =
    # max 1 s buzz + nog 2 s bewust vasthouden).
    if priority > current_priority:
        if priority >= DIRECT_PREEMPT_PRIORITY:
            return _preempt(
                state=state, channel=channel, session=session, priority=priority,
                emergency=emergency, client_request_id=client_request_id,
                reason="priority_91_99_preemption", hold_duration_ms=0,
                source_channel=source_channel,
            )

        required_hold_ms = max(0, int(channel.tenant.preemption_hold_ms or 3000))
        elapsed = max(0, now_ms() - int(waiter.requested_at_ms))
        remaining = max(0, required_hold_ms - elapsed)
        if remaining <= 0:
            return _preempt(
                state=state, channel=channel, session=session, priority=priority,
                emergency=emergency, client_request_id=client_request_id,
                reason="higher_priority_hold_preemption", hold_duration_ms=elapsed,
                source_channel=source_channel,
            )
        return FloorResult(
            "waiting", priority,
            required_hold_ms=required_hold_ms,
            remaining_hold_ms=remaining,
        )

    # Gelijke of lagere prioriteit blijft simpelweg in de wachtrij. De huidige
    # spreker wordt nooit onderbroken; bij release krijgt de beste waiter een
    # floor_available wake-up en claimt die bij zijn eerstvolgende request.
    return FloorResult("waiting", priority)


@transaction.atomic
def cancel_floor_waiter(*, channel: Channel, session: DeviceSession) -> bool:
    channel = canonical_link_channel(channel)
    state, _ = ChannelState.objects.select_for_update().get_or_create(
        tenant=channel.tenant, channel=channel
    )
    deleted, _ = FloorWaiter.objects.filter(channel=channel, session=session).delete()
    _sync_pending(state)
    return bool(deleted)


@transaction.atomic
def release_floor(*, channel: Channel, session: DeviceSession, floor_token: str, client_request_id: str):
    channel = canonical_link_channel(channel)
    state = ChannelState.objects.select_for_update().get(channel=channel, tenant=channel.tenant)
    if state.active_session_id != session.id or not check_password(floor_token, state.floor_token_hash):
        raise ValidationError({"code": "INVALID_FLOOR_TOKEN"})
    slug, name = _identity(session)
    priority = state.active_priority
    event_sequence = state.active_event_sequence
    _remove_waiter(channel, session)
    _reset_state(state)
    create_event(
        tenant=channel.tenant, action_type="PTT_RELEASED", actor_slug=slug, actor_name=name,
        channel_slug=channel.slug, channel_name=channel.name, ptt_priority=priority,
        client_request_id=client_request_id, metadata={"ptt_event_sequence": event_sequence},
    )
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_released", "timestamp_ms": now_ms(), "session_id": session.id,
        "speaker_slug": slug, "event_sequence": event_sequence, "reason": "client_release",
    }))
    _notify_next_waiter(channel, state)
    return state


@transaction.atomic
def force_release_floor(*, channel: Channel, session: DeviceSession, reason: str) -> bool:
    channel = canonical_link_channel(channel)
    try:
        state = ChannelState.objects.select_for_update().get(channel=channel, tenant=channel.tenant)
    except ChannelState.DoesNotExist:
        return False
    _remove_waiter(channel, session)
    if state.active_session_id != session.id:
        _sync_pending(state)
        return False
    slug, name = _identity(session)
    priority = state.active_priority
    event_sequence = state.active_event_sequence
    _reset_state(state)
    create_event(
        tenant=channel.tenant, action_type="PTT_RELEASED", actor_slug=slug, actor_name=name,
        channel_slug=channel.slug, channel_name=channel.name, ptt_priority=priority,
        metadata={"ptt_event_sequence": event_sequence, "reason": reason},
    )
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_released", "timestamp_ms": now_ms(), "session_id": session.id,
        "speaker_slug": slug, "event_sequence": event_sequence, "reason": reason,
    }))
    _notify_next_waiter(channel, state)
    return True


@transaction.atomic
def revoke_active_floor(*, channel: Channel, actor_slug: str = "dispatch", actor_name: str = "Dispatch", reason: str = "dispatch_revoke") -> bool:
    channel = canonical_link_channel(channel)
    """Trek de huidige TX zonder floor-token in (beheeractie vanuit Dispatch)."""
    try:
        state = ChannelState.objects.select_for_update().get(channel=channel, tenant=channel.tenant)
    except ChannelState.DoesNotExist:
        return False
    if not state.active_session_id:
        return False
    previous_session_id = state.active_session_id
    previous_slug = state.active_user_slug
    previous_name = state.active_user_name
    priority = state.active_priority
    event_sequence = state.active_event_sequence
    _reset_state(state)
    create_event(
        tenant=channel.tenant, action_type="PTT_RELEASED", actor_slug=actor_slug, actor_name=actor_name,
        subject_slug=previous_slug, channel_slug=channel.slug, channel_name=channel.name,
        ptt_priority=priority, metadata={
            "ptt_event_sequence": event_sequence, "reason": reason, "revoked_user_name": previous_name,
        },
    )
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_revoked", "timestamp_ms": now_ms(), "session_id": previous_session_id,
        "reason": reason, "new_speaker_slug": "",
    }))
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_released", "timestamp_ms": now_ms(), "session_id": previous_session_id,
        "speaker_slug": previous_slug, "speaker_name": previous_name, "reason": reason,
    }))
    _notify_next_waiter(channel, state)
    return True


@transaction.atomic
def start_parrot_floor(*, channel: Channel, owner_session: DeviceSession) -> bool:
    if channel.channel_type != Channel.ChannelType.ECHO:
        raise ValidationError({"code": "PARROT_CHANNEL_REQUIRED"})
    if owner_session.status != DeviceSession.Status.ACTIVE or owner_session.tenant_id != channel.tenant_id:
        raise ValidationError({"code": "SESSION_NOT_ACTIVE"})
    state, _ = ChannelState.objects.select_for_update().get_or_create(tenant=channel.tenant, channel=channel)
    if state.floor_status != ChannelState.FloorStatus.IDLE or state.active_session_id:
        return False
    if state.parrot_active:
        return state.parrot_owner_session_id == owner_session.id
    state.parrot_active = True
    state.parrot_owner_session = owner_session
    state.parrot_started_at_ms = now_ms()
    state.save(update_fields=["parrot_active", "parrot_owner_session", "parrot_started_at_ms", "last_update_ms"])
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_granted", "timestamp_ms": now_ms(), "session_id": 0,
        "speaker_slug": "parrot", "speaker_name": "Papegaai", "effective_priority": 0,
        "event_sequence": None, "emergency": False, "virtual": True,
    }))
    return True


@transaction.atomic
def stop_parrot_floor(*, channel: Channel, owner_session: DeviceSession) -> bool:
    try:
        state = ChannelState.objects.select_for_update().get(tenant=channel.tenant, channel=channel)
    except ChannelState.DoesNotExist:
        return False
    if not state.parrot_active:
        return False
    if state.parrot_owner_session_id and state.parrot_owner_session_id != owner_session.id:
        raise ValidationError({"code": "PARROT_NOT_OWNER"})
    state.parrot_active = False
    state.parrot_owner_session = None
    state.parrot_started_at_ms = None
    state.save(update_fields=["parrot_active", "parrot_owner_session", "parrot_started_at_ms", "last_update_ms"])
    transaction.on_commit(lambda: _notify(channel, {
        "type": "floor_released", "timestamp_ms": now_ms(), "session_id": 0,
        "speaker_slug": "parrot", "reason": "parrot_complete", "virtual": True,
    }))
    _notify_next_waiter(channel, state)
    return True
