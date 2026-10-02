from django.test import SimpleTestCase

from engine_radio.hardware_defaults import (
    generic_hardware_config,
    softradio_hardware_config,
    telox_te320_hardware_config,
)
from engine_radio.validators import validate_screen_config


class HardwareDefaultsTests(SimpleTestCase):
    def test_all_default_hardware_configs_are_valid(self):
        for factory in (
            generic_hardware_config,
            softradio_hardware_config,
            telox_te320_hardware_config,
        ):
            validate_screen_config(factory())

    def test_softradio_physical_layout(self):
        config = softradio_hardware_config()
        self.assertEqual(set(config["display"]["softkeys"]["keys"]), {"sk1", "sk2"})
        self.assertEqual(config["display"]["softkeys"]["usemode"], "visible")
        self.assertEqual(config["softradio"]["keys"], {})
        self.assertEqual(config["softradio"]["usemode"], "hidden")

    def test_telox_te320_physical_layout(self):
        config = telox_te320_hardware_config()
        self.assertEqual(set(config["display"]["softkeys"]["keys"]), {"sk1", "sk2"})
        self.assertEqual(set(config["topkeys"]["keys"]), {"tk1", "tk7"})
        self.assertEqual(set(config["leftkeys"]["keys"]), {"tl1", "tl2", "tl3", "tl4"})
    def test_te320_android_keycodes(self):
        config = telox_te320_hardware_config()
        self.assertEqual(config["topkeys"]["keys"]["tk1"]["hw_key"], 140)
        self.assertEqual(config["leftkeys"]["keys"]["tl2"]["hw_key"], 141)
        self.assertEqual(config["leftkeys"]["keys"]["tl3"]["hw_key"], 24)
        self.assertEqual(config["leftkeys"]["keys"]["tl4"]["hw_key"], 25)
        self.assertEqual(config["navkeys"]["keys"]["p1"]["hw_key"], 23)
        self.assertEqual(config["navkeys"]["keys"]["p2"]["hw_key"], 4)
        self.assertEqual(config["navkeys"]["keys"]["p3"]["hw_key"], 82)
        self.assertEqual(config["navkeys"]["keys"]["up"]["hw_key"], 19)
        self.assertEqual(config["navkeys"]["keys"]["down"]["hw_key"], 20)
        self.assertEqual(config["navkeys"]["keys"]["left"]["hw_key"], 21)
        self.assertEqual(config["navkeys"]["keys"]["right"]["hw_key"], 22)

    def test_te320_rotary_has_direct_actions_only(self):
        rotary = telox_te320_hardware_config()["topkeys"]["keys"]["tk7"]
        self.assertEqual(rotary["hw_key_clockwise"], 167)
        self.assertEqual(rotary["action_clockwise"], "channel_up")
        self.assertEqual(rotary["hw_key_counter_clockwise"], 166)
        self.assertEqual(rotary["action_counter_clockwise"], "channel_down")
        self.assertFalse(any(key.startswith("short_action") for key in rotary))
        self.assertFalse(any(key.startswith("long_action") for key in rotary))

