from django.conf import settings
from django.db import transaction

from engine_main.timeutils import now_ms


RADIO_SESSION_ID_KEY = "radio_device_session_id"
RADIO_SESSION_TOKEN_KEY = "radio_device_token"
DISPATCH_SESSION_ID_KEY = "dispatch_session_id"


class IdentityBusy(Exception):
    def __init__(self, occupant):
        self.occupant = occupant
        super().__init__(f"In gebruik door {occupant}")


def user_label(user):
    return user.get_full_name().strip() or user.get_username()


def _identity_expired(last_seen):
    return last_seen < now_ms() - settings.IDENTITY_CLAIM_TIMEOUT_MS


def dispatch_availability(dispatch_user):
    from engine_dispatch.models import DispatchSession

    active = dispatch_user.sessions.select_related("django_user").filter(
        status=DispatchSession.Status.ACTIVE
    ).first()
    if not active:
        return True, "Vrij"
    if _identity_expired(active.last_seen_at_ms):
        active.status = DispatchSession.Status.TIMED_OUT
        active.released_at_ms = now_ms()
        active.save(update_fields=["status", "released_at_ms", "last_update_ms"])
        dispatch_user.device_status = dispatch_user.DeviceStatus.OFFLINE
        dispatch_user.save(update_fields=["device_status", "last_update_ms"])
        return True, "Vrij"
    return False, user_label(active.django_user)


@transaction.atomic
def claim_dispatch_user(request, dispatch_user):
    from engine_dispatch.models import DispatchSession, DispatchUser

    dispatch_user = DispatchUser.objects.select_for_update().select_related("tenant").get(pk=dispatch_user.pk)
    current_id = request.session.get(DISPATCH_SESSION_ID_KEY)
    current = DispatchSession.objects.filter(
        pk=current_id,
        dispatch_user=dispatch_user,
        django_user=request.user,
        status=DispatchSession.Status.ACTIVE,
    ).first()
    if current:
        return current

    available, status = dispatch_availability(dispatch_user)
    if not available:
        raise IdentityBusy(status)

    if not request.session.session_key:
        request.session.create()

    session = DispatchSession.objects.create(
        dispatch_user=dispatch_user,
        django_user=request.user,
        session_key=request.session.session_key,
    )
    DispatchUser.objects.filter(pk=dispatch_user.pk).update(
        device_status=DispatchUser.DeviceStatus.ONLINE,
        last_update_ms=now_ms(),
    )
    if current_id:
        DispatchSession.objects.filter(
            pk=current_id, status=DispatchSession.Status.ACTIVE
        ).exclude(pk=session.pk).update(
            status=DispatchSession.Status.RELEASED,
            released_at_ms=now_ms(),
            last_update_ms=now_ms(),
        )
    request.session[DISPATCH_SESSION_ID_KEY] = session.pk
    request.session.modified = True
    return session


def release_claims(request):
    from engine_dispatch.models import DispatchSession, DispatchUser
    from engine_poc.models import DeviceSession
    from engine_radio.models import RadioUser

    timestamp = now_ms()
    if session_id := request.session.get(RADIO_SESSION_ID_KEY):
        radio_user_id = DeviceSession.objects.filter(pk=session_id).values_list(
            "radio_user_id", flat=True
        ).first()
        DeviceSession.objects.filter(
            pk=session_id, status=DeviceSession.Status.ACTIVE
        ).update(
            status=DeviceSession.Status.DISCONNECTED,
            disconnected_at_ms=timestamp,
            last_update_ms=timestamp,
        )
        if radio_user_id and not DeviceSession.objects.filter(
            radio_user_id=radio_user_id,
            status=DeviceSession.Status.ACTIVE,
        ).exists():
            RadioUser.objects.filter(pk=radio_user_id).update(
                device_status=RadioUser.DeviceStatus.OFFLINE,
                last_update_ms=timestamp,
            )

    if session_id := request.session.get(DISPATCH_SESSION_ID_KEY):
        dispatch_user_id = DispatchSession.objects.filter(pk=session_id).values_list(
            "dispatch_user_id", flat=True
        ).first()
        DispatchSession.objects.filter(
            pk=session_id, status=DispatchSession.Status.ACTIVE
        ).update(
            status=DispatchSession.Status.RELEASED,
            released_at_ms=timestamp,
            last_update_ms=timestamp,
        )
        if dispatch_user_id and not DispatchSession.objects.filter(
            dispatch_user_id=dispatch_user_id,
            status=DispatchSession.Status.ACTIVE,
        ).exists():
            DispatchUser.objects.filter(pk=dispatch_user_id).update(
                device_status=DispatchUser.DeviceStatus.OFFLINE,
                last_update_ms=timestamp,
            )
