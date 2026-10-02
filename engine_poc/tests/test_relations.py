from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase

from engine_main.models import Tenant
from engine_poc.models import CallRequest, Channel, UserStatus
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, UserProfile
from engine_poc.services.radio_actions import cancel_emergency_status


class ProfileRelationTests(TestCase):
    def setUp(self):
        self.tenant = Tenant.objects.create(slug="tenant", name="Tenant")
        self.channel = Channel.objects.create(tenant=self.tenant, slug="main", name="Main")
        self.user_profile = UserProfile.objects.create(
            tenant=self.tenant, slug="standard", name="Standard", ptt_priority=10
        )
        self.user_profile.channels.add(self.channel)
        self.hardware_config = HardwareConfig.objects.create(name="Testhardware")
        self.hardware_profile = HardwareProfile.objects.create(
            tenant=self.tenant, slug="radio", name="Radio", hardware_config=self.hardware_config
        )

    def create_radio_user(self, slug):
        django_user = get_user_model().objects.create_user(username=slug)
        radio_user = RadioUser.objects.create(
            tenant=self.tenant,
            slug=slug,
            secret_key_hash="!",
            internal_name=slug,
            external_name=slug,
            user_profile=self.user_profile,
            hardware_profile=self.hardware_profile,
            current_channel=self.channel,
        )
        radio_user.django_users.add(django_user)
        return radio_user

    def test_profiles_can_be_shared_by_multiple_users(self):
        first = self.create_radio_user("radio1")
        second = self.create_radio_user("radio2")
        self.assertEqual(first.user_profile, second.user_profile)
        self.assertEqual(first.hardware_profile, second.hardware_profile)
        self.assertEqual(self.user_profile.radio_users.count(), 2)
        self.assertEqual(self.hardware_profile.radio_users.count(), 2)

    def test_radio_user_can_be_linked_to_multiple_django_users(self):
        radio = self.create_radio_user("gedeelde-radio")
        second_login = get_user_model().objects.create_user(username="tweede-login")
        radio.django_users.add(second_login)

        self.assertEqual(radio.django_users.count(), 2)
        self.assertIn(radio, second_login.radio_users.all())

    def test_cross_tenant_relations_are_rejected(self):
        other = Tenant.objects.create(slug="other", name="Other")
        other_hardware = HardwareProfile.objects.create(
            tenant=other, slug="radio", name="Radio", hardware_config=self.hardware_config
        )
        user = self.create_radio_user("radio3")
        user.hardware_profile = other_hardware
        with self.assertRaises(ValidationError):
            user.full_clean()

    def test_contact_status_is_separate_and_creates_call_request(self):
        available = UserStatus.objects.create(
            tenant=self.tenant,
            slug="available",
        )
        assistance = UserStatus.objects.create(
            tenant=self.tenant,
            slug="assistance",
            call_request_priority=2,
        )
        user = self.create_radio_user("radio-status")
        user.user_status = available
        user.save(update_fields=["user_status"])
        self.assertIsNone(user.user_contact_status)
        self.assertEqual(CallRequest.objects.count(), 0)

        user.user_contact_status = assistance
        user.save(update_fields=["user_contact_status"])
        user.refresh_from_db()

        self.assertEqual(user.user_status, available)
        self.assertEqual(user.user_contact_status, assistance)
        request = CallRequest.objects.get()
        self.assertEqual(request.radio_user, user)
        self.assertEqual(request.channel, self.channel)
        self.assertEqual(request.priority, 2)

    def test_save_without_status_change_does_not_duplicate_call_request(self):
        status = UserStatus.objects.create(
            tenant=self.tenant,
            slug="priority",
            call_request_priority=3,
        )
        user = self.create_radio_user("radio-no-duplicate")
        user.user_contact_status = status
        user.save(update_fields=["user_contact_status"])
        user.external_name = "Nieuwe naam"
        user.save(update_fields=["external_name"])

        self.assertEqual(CallRequest.objects.filter(radio_user=user).count(), 1)

    def test_emergency_call_request_is_cleared_when_status_is_reset(self):
        available = UserStatus.objects.create(
            tenant=self.tenant, slug="available-after-emergency",
        )
        emergency = UserStatus.objects.create(
            tenant=self.tenant, slug="emergency-request",
            call_request_priority=1,
        )
        user = self.create_radio_user("radio-emergency-reset")
        user.user_status = available
        user.save(update_fields=["user_status"])
        user.user_contact_status = emergency
        user.save(update_fields=["user_contact_status"])
        request = CallRequest.objects.get(radio_user=user, priority=1)
        self.assertEqual(request.status, CallRequest.Status.ACTIVE)

        user.user_contact_status = None
        user.save(update_fields=["user_contact_status"])
        request.refresh_from_db()

        self.assertEqual(request.status, CallRequest.Status.CLEARED)
        self.assertIsNotNone(request.cleared_at_ms)
        self.assertEqual(request.clear_reason, "emergency_status_reset")

    def test_radio_emergency_cancel_restores_status_and_records_reason(self):
        available = UserStatus.objects.create(
            tenant=self.tenant, slug="available-before-cancel",
        )
        emergency = UserStatus.objects.create(
            tenant=self.tenant, slug="emergency-cancel",
            call_request_priority=1,
        )
        user = self.create_radio_user("radio-emergency-cancel")
        user.user_status = available
        user.save(update_fields=["user_status"])
        user.user_contact_status = emergency
        user.save(update_fields=["user_contact_status"])

        restored = cancel_emergency_status(user=user)
        request = CallRequest.objects.get(radio_user=user, priority=1)
        user.refresh_from_db()

        self.assertEqual(restored, available)
        self.assertEqual(user.user_status, available)
        self.assertEqual(request.status, CallRequest.Status.CLEARED)
        self.assertIsNotNone(request.cleared_at_ms)
        self.assertEqual(request.clear_reason, "Beëindigd door radio")
