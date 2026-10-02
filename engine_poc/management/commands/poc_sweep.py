from django.core.management.base import BaseCommand
from engine_poc.models import ChannelState, DeviceSession
from engine_poc.services.floor import force_release_floor
from engine_poc.services.events import create_event
from engine_poc.timeutils import now_ms


class Command(BaseCommand):
    help = "Ruimt verlopen heartbeats en vastgelopen PTT-floors op."

    def handle(self, *args, **options):
        current = now_ms()
        released = 0
        timed_out = 0
        for state in ChannelState.objects.select_related("tenant", "channel", "active_session"):
            if not state.active_session_id:
                continue
            max_duration = state.channel.max_ptt_duration_ms or state.tenant.default_max_ptt_duration_ms
            # Media loopt via WebRTC; de PTT-floor
            # wordt apart bewaakt door de HTTP-heartbeat van de actieve sessie.
            heartbeat_reference = max(
                state.active_session.last_heartbeat_at_ms or 0,
                state.active_session.last_seen_at_ms or 0,
                state.granted_at_ms or 0,
            )
            reason = None
            if max_duration and state.granted_at_ms and current - state.granted_at_ms >= max_duration:
                reason = "max_duration"
            elif heartbeat_reference and current - heartbeat_reference >= state.tenant.heartbeat_timeout_ms:
                reason = "heartbeat_timeout"
            if reason and force_release_floor(channel=state.channel, session=state.active_session, reason=reason):
                released += 1

        sessions = DeviceSession.objects.select_related("tenant", "radio_user", "dispatch_user").filter(status=DeviceSession.Status.ACTIVE)
        for session in sessions:
            # A radio has two independent liveness signals: the periodic HTTP
            # heartbeat and activity on the control WebSocket.  WebRTC/audio can
            # remain healthy while browser timers are throttled, so never mark a
            # session offline while either signal is still recent.
            reference = max(
                session.last_heartbeat_at_ms or 0,
                session.last_seen_at_ms or 0,
            )
            if reference and current - reference >= session.tenant.heartbeat_timeout_ms:
                session.status = DeviceSession.Status.TIMED_OUT
                session.disconnected_at_ms = current
                session.save()
                actor = session.actor
                relation = actor.sessions if session.radio_user_id else actor.device_sessions
                if not relation.filter(status=DeviceSession.Status.ACTIVE).exists():
                    previous_device_status = actor.device_status
                    actor.device_status = actor.DeviceStatus.OFFLINE
                    actor.save(update_fields=["device_status", "last_update_ms"])
                    if session.radio_user_id and previous_device_status != actor.DeviceStatus.OFFLINE:
                        create_event(
                            tenant=session.tenant, action_type="RADIO_STATE_CHANGED",
                            actor_slug="SYSTEM", actor_name="System",
                            subject_slug=actor.slug, subject_name=actor.display_name,
                            entity_type="radio_user", entity_slug=actor.slug, entity_name=actor.display_name,
                            value="offline", message="Radio offline (heartbeat timeout)",
                            metadata={"old_state": previous_device_status, "new_state": "offline", "reason": "heartbeat_timeout", "session_id": session.pk},
                        )
                timed_out += 1
        self.stdout.write(self.style.SUCCESS(f"floors_released={released} sessions_timed_out={timed_out}"))
