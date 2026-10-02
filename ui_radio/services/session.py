from dataclasses import dataclass
from django.conf import settings
from .engine import POCEngineClient, EngineError

TOKEN_KEY="radio_engine_token"
IDENTITY_KEY="radio_identity"
CHANNEL_KEY="radio_channel_slug"
PRIORITY_KEY="radio_priority"

def ensure_engine_session(request):
    token=request.session.get(TOKEN_KEY)
    identity=request.session.get(IDENTITY_KEY)
    if token and identity: return POCEngineClient(token), identity
    tenant=getattr(settings,"RADIO_TENANT_SLUG","")
    user=getattr(settings,"RADIO_USER_SLUG","")
    secret=getattr(settings,"RADIO_SECRET_KEY","")
    device=getattr(settings,"RADIO_DEVICE_IDENTIFIER","") or f"web-{request.session.session_key or 'radio'}"
    if not all([tenant,user,secret]):
        raise EngineError("RADIO_TENANT_SLUG, RADIO_USER_SLUG en RADIO_SECRET_KEY zijn verplicht.",500)
    login=POCEngineClient().login(tenant,user,secret,device)
    token=login.get("access_token")
    if not token: raise EngineError("Loginantwoord bevat geen access_token.",502,login)
    identity={"tenant_slug":tenant,"user_slug":user,"display_name":user}
    request.session[TOKEN_KEY]=token; request.session[IDENTITY_KEY]=identity
    return POCEngineClient(token), identity
