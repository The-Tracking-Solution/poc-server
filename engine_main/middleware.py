from engine_main.identity_claims import DISPATCH_SESSION_ID_KEY, RADIO_SESSION_ID_KEY
from engine_main.timeutils import now_ms


class IdentityLeaseMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if getattr(request, "user", None) and request.user.is_authenticated:
            timestamp = now_ms()
            if session_id := request.session.get(RADIO_SESSION_ID_KEY):
                from engine_poc.models import DeviceSession
                DeviceSession.objects.filter(
                    pk=session_id,
                    radio_user__django_users=request.user,
                    status=DeviceSession.Status.ACTIVE,
                ).update(last_seen_at_ms=timestamp, last_update_ms=timestamp)
            if session_id := request.session.get(DISPATCH_SESSION_ID_KEY):
                from engine_dispatch.models import DispatchSession
                DispatchSession.objects.filter(
                    pk=session_id,
                    django_user=request.user,
                    status=DispatchSession.Status.ACTIVE,
                ).update(last_seen_at_ms=timestamp, last_update_ms=timestamp)
        return self.get_response(request)
