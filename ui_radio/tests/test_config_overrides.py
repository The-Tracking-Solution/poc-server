from copy import deepcopy

from django.test import TestCase

from engine_main.models import Tenant
from engine_radio.config_overrides import merge_config
from engine_radio.models import default_screen_config
from engine_radio.models import HardwareConfig
from engine_radio.models import HardwareProfile, Screen


class ConfigOverrideTests(TestCase):
    def setUp(self):
        self.tenant = Tenant.objects.create(slug="config", name="Configuratie")
        base = default_screen_config()
        base["theme"]["default_button_color"] = "#111111"
        self.hardware_config = HardwareConfig.objects.create(name="Porto", config=base)
        self.profile = HardwareProfile.objects.create(
            tenant=self.tenant,
            slug="porto1",
            name="Porto 1",
            hardware_config=self.hardware_config,
            config={"theme": {"default_button_color": "#222222"}},
        )

    def test_merge_does_not_modify_source_layers(self):
        base = {"display": {"visible": True, "color": "blue"}}
        override = {"display": {"visible": False}}
        original_base = deepcopy(base)

        result = merge_config(base, override)

        self.assertEqual(result, {"display": {"visible": False, "color": "blue"}})
        self.assertEqual(base, original_base)

    def test_screen_resolves_all_three_layers(self):
        screen = Screen.objects.create(
            tenant=self.tenant,
            hardware_profile=self.profile,
            name="Hoofdscherm",
            config={"title": "Welkom"},
        )

        resolved = screen.resolved_config
        self.assertEqual(resolved["theme"]["default_button_color"], "#222222")
        self.assertEqual(resolved["title"], "Welkom")
        self.assertEqual(self.hardware_config.config["title"], "Nieuw scherm")
        self.assertNotIn("title", self.profile.config)
