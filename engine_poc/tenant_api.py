from rest_framework.exceptions import NotFound
from engine_main.models import Tenant

class TenantScopedMixin:
    tenant_url_kwarg = "tenant_slug"
    def get_tenant(self):
        if not hasattr(self, "_tenant"):
            try:
                self._tenant = Tenant.objects.get(slug=self.kwargs[self.tenant_url_kwarg])
            except Tenant.DoesNotExist as exc:
                raise NotFound("Tenant niet gevonden.") from exc
        return self._tenant
    def get_queryset(self):
        return super().get_queryset().filter(tenant=self.get_tenant())
    def perform_create(self, serializer):
        serializer.save(tenant=self.get_tenant())
    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["tenant"] = self.get_tenant()
        return context
