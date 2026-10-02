from django.contrib import admin
from django.test import SimpleTestCase
from django.urls import reverse

from engine_radio.models import HardwareProfile, Screen
from engine_radio.models import HardwareConfig


class RadioUiAdminRegistrationTests(SimpleTestCase):
    def test_models_are_registered_under_ui_radio(self):
        self.assertIn(HardwareProfile, admin.site._registry)
        self.assertIn(Screen, admin.site._registry)
        self.assertIn(HardwareConfig, admin.site._registry)

    def test_admin_urls_use_ui_radio_model_names(self):
        self.assertEqual(
            reverse("admin:engine_radio_hardwareprofile_changelist"),
            "/admin/ui_radio/hardwareprofile/",
        )
        self.assertEqual(
            reverse("admin:engine_radio_screen_changelist"),
            "/admin/ui_radio/screen/",
        )
