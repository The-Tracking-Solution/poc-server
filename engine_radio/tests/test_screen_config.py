from copy import deepcopy

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from engine_radio.models import default_screen_config
from engine_radio.models import Screen
from engine_radio.validators import validate_screen_config


class ScreenConfigTests(SimpleTestCase):
    def test_default_config_is_valid(self):
        validate_screen_config(default_screen_config())

    def test_missing_action_is_allowed(self):
        config = deepcopy(default_screen_config())
        del config["screens"]["home"]["navkeys"]["keys"]["p2"]["action"]
        validate_screen_config(config)

    def test_invalid_usemode_is_rejected(self):
        config = deepcopy(default_screen_config())
        config["screens"]["home"]["keyboard"]["usemode"] = "unknown"
        with self.assertRaises(ValidationError):
            validate_screen_config(config)

    def test_button_paths_include_named_buttons(self):
        paths = Screen.button_paths(default_screen_config())
        self.assertIn("screens.home.navkeys.keys.p1", paths)
