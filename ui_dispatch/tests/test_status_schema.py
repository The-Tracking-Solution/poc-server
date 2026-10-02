from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from engine_dispatch.models import DispatchConfig, DispatchProfile, DispatchUser
from engine_poc.models import StatusSchema
from engine_main.models import Tenant
from engine_poc.models import UserStatus
from engine_radio.models import RadioUser


class DispatchStatusSchemaTests(TestCase):
    def setUp(self):
        self.tenant = Tenant.objects.create(name="Schema test", slug="schema-test")
        self.user = get_user_model().objects.create_user(username="dispatcher", password="test")
        config = DispatchConfig.objects.create(tenant=self.tenant)
        self.schema = StatusSchema.objects.create(tenant=self.tenant, name="Operationeel")
        self.profile = DispatchProfile.objects.create(
            tenant=self.tenant,
            dispatch_config=config,
            status_schema=self.schema,
            name="Default",
        )
        self.dispatcher = DispatchUser.objects.create(
            tenant=self.tenant,
            slug="dispatch",
            internal_name="dispatch",
            external_name="Dispatch",
            dispatch_profile=self.profile,
        )
        self.dispatcher.django_users.add(self.user)
        self.client.force_login(self.user)

    def _status(self, code, label, system_status):
        return UserStatus.objects.create(
            tenant=self.tenant,
            slug=f"s-{code}",
            display_code=str(code),
            display_label=label,
            system_status=system_status,
        )

    def test_states_are_filtered_by_schema_and_sorted_by_numeric_display_code(self):
        s10 = self._status("10", "Tien", 10)
        s2 = self._status("2", "Twee", 2)
        hidden = self._status("3", "Verborgen", 3)
        self.schema.statuses.set([s10, s2])

        radio = RadioUser.objects.create(
            tenant=self.tenant,
            slug="r1",
            internal_name="r1",
            external_name="Radio 1",
            user_status=hidden,
        )

        response = self.client.get(reverse("dispatch:states-state", kwargs={"tenant_slug": self.tenant.slug}))
        self.assertEqual(response.status_code, 200)
        states = response.json()["data"]["states"]
        schema_cards = [item for item in states if not item.get("fallback") and item["id"] != "none"]
        self.assertEqual([item["display_code"] for item in schema_cards], ["2", "10"])
        self.assertEqual([item["badge_label"] for item in schema_cards], ["2", "10"])
        self.assertEqual([item["name"] for item in schema_cards], ["Twee", "Tien"])

        fallback = next(item for item in states if item.get("fallback"))
        self.assertEqual(fallback["badge_label"], "s-3")
        self.assertEqual(fallback["name"], "Verborgen")
        self.assertEqual(fallback["radios"][0]["name"], "Radio 1")
