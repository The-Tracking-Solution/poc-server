import logging
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from django.contrib.auth.hashers import check_password

from engine_poc.models import DeviceSession

logger = logging.getLogger(__name__)


@database_sync_to_async
def authenticate_scope(scope):
    """Authenticate a websocket from query parameters or HTTP headers.

    Supported query parameters: session_id and access_token. Headers may
    alternatively contain X-POC-Session-ID and Authorization: Bearer <token>.
    """
    query_string = scope.get("query_string", b"").decode("utf-8")
    query = parse_qs(query_string)
    headers = {
        key.decode().lower(): value.decode()
        for key, value in scope.get("headers", [])
    }

    session_id = (query.get("session_id") or [headers.get("x-poc-session-id")])[0]
    token = (query.get("access_token") or [None])[0]

    if not token:
        authorization = headers.get("authorization", "")
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()

    if not session_id:
        logger.warning("Control WS geweigerd: session_id ontbreekt")
        return None

    if not token:
        logger.warning(
            "Control WS geweigerd: access_token ontbreekt, session_id=%s",
            session_id,
        )
        return None

    try:
        session = DeviceSession.objects.select_related(
            "tenant",
            "radio_user", "radio_user__user_profile",
            "radio_user__hardware_profile", "radio_user__current_channel", "radio_user__user_status", "radio_user__user_contact_status",
            "dispatch_user", "dispatch_user__user_profile",
        ).get(
            pk=session_id,
            status=DeviceSession.Status.ACTIVE,
        )
    except (DeviceSession.DoesNotExist, ValueError):
        logger.warning(
            "Control WS geweigerd: actieve sessie niet gevonden, session_id=%s",
            session_id,
        )
        return None

    if not check_password(token, session.session_token_hash):
        logger.warning(
            "Control WS geweigerd: token klopt niet, session_id=%s user=%s",
            session_id,
            session.actor_slug,
        )
        return None

    logger.info(
        "Control WS geauthenticeerd: session_id=%s user=%s",
        session.pk,
        session.actor_slug,
    )
    return session
