from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from engine_dispatch.models import DispatchUser
from engine_main.models import Tenant
from engine_radio.models import RadioUser


class IdentitySelectionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="operator", password="geheim")
        self.tenant = Tenant.objects.create(slug="test", name="Test")
        self.client.force_login(self.user)

    def radio(self, slug="radio"):
        radio = RadioUser.objects.create(
            tenant=self.tenant, slug=slug, secret_key_hash="!",
            internal_name=slug, external_name=slug.title(),
        )
        radio.django_users.add(self.user)
        return radio

    def dispatcher(self, slug="dispatch"):
        dispatcher = DispatchUser.objects.create(
            tenant=self.tenant, slug=slug, secret_key_hash="!",
            internal_name=slug, external_name=slug.title(),
        )
        dispatcher.django_users.add(self.user)
        return dispatcher

    def test_one_tenant_skips_tenant_page_but_shows_identity_page(self):
        self.radio()
        response = self.client.get(reverse("engine_main:entry"))
        self.assertRedirects(response, reverse("engine_main:tenant-select", kwargs={"tenant_slug": "test"}), fetch_redirect_response=False)
        selection = self.client.get(response.url)
        self.assertContains(selection, "Kies bediening voor Test")
        self.assertContains(selection, "Radio")

    def test_radio_plus_dispatch_shows_choice_page(self):
        self.radio()
        self.dispatcher()
        response = self.client.get(reverse("engine_main:entry"))
        self.assertRedirects(response, reverse("engine_main:tenant-select", kwargs={"tenant_slug": "test"}), fetch_redirect_response=False)
        selection = self.client.get(response.url)
        self.assertContains(selection, "Radio")
        self.assertContains(selection, "Dispatch")

    def test_multiple_tenants_show_tenant_page_first(self):
        self.radio()
        other = Tenant.objects.create(slug="tweede", name="Tweede tenant")
        dispatcher = DispatchUser.objects.create(
            tenant=other, slug="centralist", secret_key_hash="!",
            internal_name="centralist", external_name="Centralist",
        )
        dispatcher.django_users.add(self.user)

        response = self.client.get(reverse("engine_main:entry"))
        self.assertRedirects(response, reverse("engine_main:select"), fetch_redirect_response=False)
        selection = self.client.get(response.url)
        self.assertContains(selection, "Kies een tenant")
        self.assertContains(selection, "Test")
        self.assertContains(selection, "Tweede tenant")

    def test_dispatch_choice_is_stored_per_tenant(self):
        dispatcher = self.dispatcher()
        response = self.client.post(reverse("engine_main:tenant-select", kwargs={"tenant_slug": "test"}), {
            "kind": "dispatch", "identity_id": dispatcher.pk,
        })
        self.assertRedirects(response, reverse("dispatch:console", kwargs={"tenant_slug": "test"}), fetch_redirect_response=False)
        self.assertEqual(self.client.session["selected_dispatch_users"]["test"], dispatcher.pk)
