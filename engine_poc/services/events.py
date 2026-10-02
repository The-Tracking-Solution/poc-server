from engine_main.models import Tenant
from engine_poc.models import EventLog


def create_event(*, tenant: Tenant, action_type: str, actor_slug: str = "SYSTEM", actor_name: str = "System", client_request_id=None, **kwargs) -> EventLog:
    if client_request_id:
        existing = EventLog.objects.filter(tenant=tenant, client_request_id=client_request_id).first()
        if existing:
            return existing
    return EventLog.objects.create(
        tenant=tenant,
        tenant_slug_snapshot=tenant.slug,
        tenant_name_snapshot=tenant.name,
        action_type=action_type,
        actor_slug=actor_slug,
        actor_name=actor_name,
        client_request_id=client_request_id,
        **kwargs,
    )
