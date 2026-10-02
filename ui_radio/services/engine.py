from __future__ import annotations
import uuid
from dataclasses import dataclass
from typing import Any
import httpx
from django.conf import settings

class EngineError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502, payload: Any = None):
        super().__init__(message); self.status_code=status_code; self.payload=payload

@dataclass(frozen=True)
class RadioIdentity:
    tenant_slug: str
    user_slug: str
    display_name: str

class POCEngineClient:
    """Thin server-side adapter. Keeps engine tokens out of browser JavaScript."""
    def __init__(self, token: str | None = None):
        self.base_url = getattr(settings, "POC_ENGINE_BASE_URL", "http://web:8000").rstrip("/")
        self.token = token
        self.timeout = httpx.Timeout(getattr(settings, "RADIO_ENGINE_TIMEOUT", 10.0))

    def _headers(self):
        h={"Accept":"application/json", "Content-Type":"application/json"}
        if self.token: h["Authorization"] = f"Bearer {self.token}"
        return h

    def request(self, method: str, path: str, payload: dict | None=None):
        try:
            with httpx.Client(base_url=self.base_url, timeout=self.timeout, headers=self._headers()) as c:
                r=c.request(method, path, json=payload)
        except httpx.HTTPError as exc:
            raise EngineError(f"POC Engine niet bereikbaar: {exc}") from exc
        data = None
        if r.content:
            try: data=r.json()
            except ValueError: data={"detail":r.text}
        if r.is_error:
            msg=(data or {}).get("detail") if isinstance(data,dict) else None
            raise EngineError(msg or f"POC Engine HTTP {r.status_code}", r.status_code, data)
        return data or {}

    def login(self, tenant_slug, user_slug, secret_key, device_identifier):
        return self.request("POST", "/poc/api/v1/auth/session/", {
            "tenant_slug":tenant_slug,"user_slug":user_slug,
            "secret_key":secret_key,"device_identifier":device_identifier,
        })
    def heartbeat(self):
        return self.request("POST", "/poc/api/v1/session/heartbeat/", {
            "heartbeat_id":uuid.uuid4().hex, "sent_at_ms":__import__('time').time_ns()//1_000_000,
        })
    def user(self,t,u): return self.request("GET",f"/poc/api/v1/tenants/{t}/users/{u}/")
    def channels(self,t): return self.request("GET",f"/poc/api/v1/tenants/{t}/channels/")
    def live_status(self,t): return self.request("GET",f"/poc/api/v1/tenants/{t}/live-status/")
    def channel_state(self,t,c): return self.request("GET",f"/poc/api/v1/tenants/{t}/channels/{c}/state/")
    def ptt_request(self,t,c,payload): return self.request("POST",f"/poc/api/v1/tenants/{t}/channels/{c}/ptt/request/",payload)
    def ptt_release(self,t,c,payload): return self.request("POST",f"/poc/api/v1/tenants/{t}/channels/{c}/ptt/release/",payload)

    def priority(self,t,c,kind,active,payload):
        """Optional engine extension. Configure URL templates in settings.
        Defaults intentionally fail closed when the engine lacks priority endpoints.
        """
        setting = "RADIO_URGENT_ENDPOINT" if kind=="urgent" else "RADIO_EMERGENCY_ENDPOINT"
        template=getattr(settings,setting,"")
        if not template:
            raise EngineError(f"Geen engine-endpoint geconfigureerd voor {kind}.",501)
        path=template.format(tenant_slug=t,channel_slug=c)
        return self.request("POST",path,{**payload,"active":active,"priority_kind":kind})
