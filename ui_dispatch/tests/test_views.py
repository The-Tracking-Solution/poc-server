import json

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from engine_main.models import Tenant
from engine_poc.models import CallRequest, Channel, ChannelState, UserStatus
from engine_radio.models import RadioUser


class DispatchViewTests(TestCase):
    def setUp(self):
        self.django_user = get_user_model().objects.create_user(
            username="dispatcher",
            password="test-password",
        )
        self.tenant = Tenant.objects.create(slug="meldkamer", name="Meldkamer")
        self.radio = RadioUser(
            tenant=self.tenant,
            slug="dispatch-radio",
            internal_name="Dispatch radio",
            external_name="Dispatch radio",
        )
        self.radio.set_secret("test-secret")
        self.radio.save()
        self.radio.django_users.add(self.django_user)

    def test_dispatch_requires_login(self):
        response = self.client.get(reverse("dispatch:index"))
        self.assertEqual(response.status_code, 302)

    def test_dispatch_is_tenant_scoped(self):
        self.client.force_login(self.django_user)
        response = self.client.get(
            reverse("dispatch:console", kwargs={"tenant_slug": self.tenant.slug})
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "DISPATCH")
        self.assertContains(response, self.tenant.name)

    def test_radio_layout_has_its_own_url(self):
        self.client.force_login(self.django_user)
        response = self.client.get(
            reverse("dispatch:radio", kwargs={"tenant_slug": self.tenant.slug})
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'class="layout radio-layout"')

    def test_accept_emergency_hides_request_without_clearing_it(self):
        channel = Channel.objects.create(tenant=self.tenant, slug="nood", name="Nood")
        status = UserStatus.objects.create(
            tenant=self.tenant, slug="noodoproep", call_request_priority=1,
        )
        self.radio.current_channel = channel
        self.radio.user_contact_status = status
        self.radio.save(update_fields=["current_channel", "user_contact_status"])
        item = CallRequest.objects.get(radio_user=self.radio, priority=1)
        self.client.force_login(self.django_user)

        response = self.client.post(reverse("dispatch:accept-call-request", kwargs={
            "tenant_slug": self.tenant.slug, "request_id": item.pk,
        }))
        self.assertEqual(response.status_code, 200)
        item.refresh_from_db()
        self.assertEqual(item.status, CallRequest.Status.ACTIVE)
        self.assertIsNotNone(item.accepted_at_ms)

        listing = self.client.get(reverse("dispatch:call-requests", kwargs={"tenant_slug": self.tenant.slug}))
        self.assertEqual(listing.json()["data"], [])

    def test_dispatch_can_cancel_emergency_from_radio_card(self):
        available = UserStatus.objects.create(
            tenant=self.tenant, slug="available-card",
        )
        emergency = UserStatus.objects.create(
            tenant=self.tenant, slug="emergency-card", call_request_priority=1,
        )
        self.radio.user_status = available
        self.radio.save(update_fields=["user_status"])
        self.radio.user_contact_status = emergency
        self.radio.save(update_fields=["user_contact_status"])
        item = CallRequest.objects.get(radio_user=self.radio, priority=1)
        self.client.force_login(self.django_user)

        response = self.client.post(reverse("dispatch:cancel-radio-emergency", kwargs={
            "tenant_slug": self.tenant.slug, "radio_id": self.radio.pk,
        }))
        self.assertEqual(response.status_code, 200)
        self.radio.refresh_from_db()
        item.refresh_from_db()
        self.assertEqual(self.radio.user_status, available)
        self.assertEqual(item.status, CallRequest.Status.CLEARED)
        self.assertEqual(item.clear_reason, "Beëindigd door dispatch")

    def test_dispatch_can_move_emergency_radio_to_unassigned_channel(self):
        old_channel = Channel.objects.create(tenant=self.tenant, slug="old-emergency", name="Oud")
        new_channel = Channel.objects.create(tenant=self.tenant, slug="new-emergency", name="Nieuw")
        emergency = UserStatus.objects.create(
            tenant=self.tenant, slug="emergency-move", call_request_priority=1,
        )
        self.radio.current_channel = old_channel
        self.radio.user_contact_status = emergency
        self.radio.save(update_fields=["current_channel", "user_contact_status"])
        self.client.force_login(self.django_user)

        response = self.client.post(
            reverse("dispatch:set-radio-channel", kwargs={
                "tenant_slug": self.tenant.slug, "radio_id": self.radio.pk,
            }),
            data=json.dumps({"channel_id": str(new_channel.pk)}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.radio.refresh_from_db()
        self.assertEqual(self.radio.current_channel, new_channel)
        self.assertFalse(ChannelState.objects.get(channel=old_channel).emergency_users.filter(pk=self.radio.pk).exists())
        self.assertTrue(ChannelState.objects.get(channel=new_channel).emergency_users.filter(pk=self.radio.pk).exists())
    def test_dispatch_locations_uses_userstatus_display_fields(self):
        from django.contrib.gis.geos import Point

        channel = Channel.objects.create(tenant=self.tenant, slug="kaart", name="Kaart")
        status = UserStatus.objects.create(
            tenant=self.tenant,
            slug="available-map",
            display_label="Beschikbaar voor inzet",
        )
        self.radio.current_channel = channel
        self.radio.user_status = status
        self.radio.location_interval_seconds = 15
        self.radio.last_location = Point(5.79321, 51.48123, srid=4326)
        self.radio.last_location_accuracy_m = 8.4
        self.radio.last_location_at_ms = 1234567890
        self.radio.save(update_fields=[
            "current_channel", "user_status", "location_interval_seconds", "last_location",
            "last_location_accuracy_m", "last_location_at_ms",
        ])

        self.client.force_login(self.django_user)
        response = self.client.get(reverse("dispatch:locations", kwargs={"tenant_slug": self.tenant.slug}))

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["radios"]), 1)
        self.assertEqual(payload["radios"][0]["frontend_status"], "Beschikbaar voor inzet")
        self.assertEqual(payload["radios"][0]["channel"], "Kaart")
        self.assertAlmostEqual(payload["radios"][0]["location"]["latitude"], 51.48123)
        self.assertAlmostEqual(payload["radios"][0]["location"]["longitude"], 5.79321)

