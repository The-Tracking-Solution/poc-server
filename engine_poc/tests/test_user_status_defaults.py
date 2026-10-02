from django.test import TestCase

from engine_main.models import Tenant
from engine_poc.models import UserStatus
from engine_poc.user_status_defaults import DEFAULT_USER_STATUSES


class DefaultUserStatusTests(TestCase):
    def test_new_tenant_receives_all_system_statuses(self):
        tenant = Tenant.objects.create(slug="statussen", name="Statussen")

        statuses = UserStatus.objects.filter(tenant=tenant).order_by("system_status")
        self.assertEqual(statuses.count(), 17)
        self.assertEqual(
            list(statuses.values_list("system_status", "display_label")),
            list(DEFAULT_USER_STATUSES),
        )

    def test_emergency_status_keeps_emergency_priority(self):
        tenant = Tenant.objects.create(slug="nood", name="Nood")
        emergency = UserStatus.objects.get(tenant=tenant, system_status=0)

        self.assertEqual(emergency.call_request_priority, 1)
        self.assertEqual(str(emergency), "0 - Noodsignaal")

    def test_display_fields_keep_legacy_labels_usable(self):
        tenant = Tenant.objects.create(slug="display", name="Display")
        status = UserStatus.objects.get(tenant=tenant, system_status=5)
        status.display_code = "05"
        status.display_label = "Ter plaatse incident"
        status.save()
        status.refresh_from_db()

        self.assertEqual(status.display_code, "05")
        self.assertEqual(status.display_label, "Ter plaatse incident")
