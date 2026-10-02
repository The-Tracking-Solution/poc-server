from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class LoginTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="porto1", password="geheim")

    def test_login_page_is_public(self):
        response = self.client.get(reverse("engine_main:login"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Inloggen")
        self.assertNotContains(response, "Porto inloggen")
        self.assertNotContains(response, ">QR<")


    def test_hardware_code_is_shown_from_query_parameter(self):
        response = self.client.get(
            reverse("engine_main:login"),
            {"hardware_id": "550e8400-e29b-41d4-a716-446655440000"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "550e-0000")

    def test_hardware_code_survives_redirect_via_session(self):
        self.client.get(
            reverse("engine_main:login"),
            {"hardware_id": "abcd0000-1111-2222-3333-44445555ef01"},
        )
        response = self.client.get(reverse("engine_main:login"))
        self.assertContains(response, "abcd-ef01")

    def test_valid_credentials_create_session(self):
        response = self.client.post(reverse("engine_main:login"), {
            "username": "porto1", "password": "geheim",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user.pk)

    def test_external_next_url_is_rejected(self):
        response = self.client.post(reverse("engine_main:login") + "?next=https://example.org", {
            "username": "porto1", "password": "geheim", "next": "https://example.org",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("engine_main:entry"))
