from django.contrib.auth import get_user_model
from django.test import TestCase

from engine_dispatch.models import DispatchUser
from engine_main.models import Tenant


class DispatchUserTests(TestCase):
    def setUp(self):
        self.tenant = Tenant.objects.create(slug="dispatch", name="Dispatch")
        self.user = get_user_model().objects.create_user(username="centralist")

    def test_dispatch_user_defaults_to_offline(self):
        dispatcher = DispatchUser.objects.create(
            tenant=self.tenant,
            slug="centralist",
            secret_key_hash="!",
            internal_name="centralist",
            external_name="Centralist",
        )
        dispatcher.django_users.add(self.user)

        self.assertEqual(dispatcher.device_status, DispatchUser.DeviceStatus.OFFLINE)
        self.assertEqual(str(dispatcher), "Centralist (Dispatch)")
        self.assertEqual(list(self.user.dispatch_users.all()), [dispatcher])

    def test_django_user_can_use_multiple_dispatch_identities(self):
        values = {
            "tenant": self.tenant,
            "secret_key_hash": "!",
            "internal_name": "centralist",
            "external_name": "Centralist",
        }
        first = DispatchUser.objects.create(slug="een", **values)
        second = DispatchUser.objects.create(slug="twee", **values)
        first.django_users.add(self.user)
        second.django_users.add(self.user)
        self.assertEqual(set(self.user.dispatch_users.all()), {first, second})
