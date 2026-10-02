from django.apps import apps
from django.test import SimpleTestCase

from engine_main.models import Tenant
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, Screen, UserProfile


class ApplicationArchitectureTests(SimpleTestCase):
    def test_application_labels_match_package_names(self):
        self.assertEqual(apps.get_app_config("engine_main").name, "engine_main")
        self.assertEqual(apps.get_app_config("engine_poc").name, "engine_poc")
        self.assertEqual(apps.get_app_config("engine_radio").name, "engine_radio")
        self.assertEqual(apps.get_app_config("ui_radio").name, "ui_radio")
        self.assertEqual(apps.get_app_config("ui_dispatch").name, "ui_dispatch")

    def test_radio_models_are_owned_by_engine_radio(self):
        self.assertEqual(Tenant._meta.app_label, "engine_main")
        for model in (HardwareConfig, UserProfile, RadioUser, HardwareProfile, Screen):
            self.assertEqual(model._meta.app_label, "engine_radio")

    def test_radio_relations_use_shared_tenant(self):
        self.assertIs(RadioUser._meta.get_field("tenant").remote_field.model, Tenant)
        self.assertIs(
            RadioUser._meta.get_field("hardware_profile").remote_field.model,
            HardwareProfile,
        )
