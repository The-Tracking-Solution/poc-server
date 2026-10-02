from django.db import transaction
from engine_poc.models import DeviceSession
from engine_radio.models import RadioUser
from engine_poc.timeutils import now_ms
from .events import create_event


@transaction.atomic
def create_session(*, radio_user: RadioUser, device_identifier: str):
    existing = DeviceSession.objects.select_for_update().filter(radio_user=radio_user, status=DeviceSession.Status.ACTIVE)
    for old in existing:
        old.status = DeviceSession.Status.REVOKED
        old.disconnected_at_ms = now_ms()
        old.save()
    session = DeviceSession(
        tenant=radio_user.tenant,
        radio_user=radio_user,
        device_identifier=device_identifier,
        current_channel=radio_user.current_channel,
    )
    token = session.issue_token()
    session.save()
    previous_device_status = radio_user.device_status
    radio_user.device_status = RadioUser.DeviceStatus.ONLINE
    radio_user.save(update_fields=["device_status", "last_update_ms"])
    create_event(tenant=radio_user.tenant, action_type="SESSION_CREATED", actor_slug=radio_user.slug,
                 actor_name=radio_user.display_name, metadata={"device_identifier": device_identifier})
    if previous_device_status != RadioUser.DeviceStatus.ONLINE:
        create_event(tenant=radio_user.tenant, action_type="RADIO_STATE_CHANGED", actor_slug=radio_user.slug,
                     actor_name=radio_user.display_name, subject_slug=radio_user.slug, subject_name=radio_user.display_name,
                     entity_type="radio_user", entity_slug=radio_user.slug, entity_name=radio_user.display_name,
                     value="online", message="Radio online",
                     metadata={"old_state": previous_device_status, "new_state": "online", "device_identifier": device_identifier})
    return session, token
