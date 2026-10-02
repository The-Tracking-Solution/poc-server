from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed
from engine_poc.models import DeviceSession


class DeviceSessionAuthentication(BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        header = request.headers.get("Authorization", "")
        if not header.startswith(self.keyword + " "):
            return None
        token = header[len(self.keyword) + 1:].strip()
        session_id = request.headers.get("X-POC-Session-ID")
        if not session_id:
            raise AuthenticationFailed("X-POC-Session-ID ontbreekt.")
        try:
            session = DeviceSession.objects.select_related("radio_user", "dispatch_user").prefetch_related(
                "radio_user__django_users", "dispatch_user__django_users"
            ).get(pk=session_id, status=DeviceSession.Status.ACTIVE)
        except DeviceSession.DoesNotExist as exc:
            raise AuthenticationFailed("Sessie is niet actief.") from exc
        if not session.verify_token(token):
            raise AuthenticationFailed("Ongeldig sessietoken.")
        request.radio_session = session
        actor = session.actor
        django_user = actor.django_users.order_by("pk").first()
        if django_user is None:
            raise AuthenticationFailed("Aan dit device is geen Django-gebruiker gekoppeld.")
        return django_user, session
