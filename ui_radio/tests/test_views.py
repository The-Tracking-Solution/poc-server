from django.test import SimpleTestCase
from django.urls import reverse


class RadioUrlTests(SimpleTestCase):
    def test_porto_login_url(self):
        self.assertEqual(reverse("engine_main:login"), "/user/login/")

    def test_porto_logout_url(self):
        self.assertEqual(reverse("engine_main:logout"), "/user/logout/")

    def test_screen_url_contains_tenant_prefix(self):
        self.assertEqual(
            reverse("ui_radio:screen", kwargs={"tenant_slug": "test"}),
            "/radio/test/",
        )

    def test_bootstrap_url_contains_tenant_prefix(self):
        self.assertEqual(
            reverse("ui_radio:bootstrap", kwargs={"tenant_slug": "test"}),
            "/radio/test/api/bootstrap/",
        )

    def test_channel_presence_url_contains_tenant_prefix(self):
        self.assertEqual(
            reverse("ui_radio:channel-presence", kwargs={"tenant_slug": "test"}),
            "/radio/test/api/channel-presence/",
        )


class RadioDevScreenUrlTests(SimpleTestCase):
    def test_screen_selector_url(self):
        self.assertEqual(reverse("ui_radio:dev-screen-select"), "/radio/dev/screen/")

    def test_screen_url(self):
        self.assertEqual(reverse("ui_radio:dev-screen-select"), "/radio/dev/screen/")
