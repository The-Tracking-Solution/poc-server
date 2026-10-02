from django.test import SimpleTestCase

from engine_poc.actions import ACTION_REGISTRY, BACKEND_ACTIONS, HOLD_ACTIONS, LOCAL_ACTIONS


class ActionRegistryTests(SimpleTestCase):
    def test_expected_action_contract(self):
        self.assertEqual(
            set(ACTION_REGISTRY),
            {
                "none", "ptt", "sos", "screen_open", "screen_back",
                "channel_up", "channel_down", "channel_select",
                "volume_up", "volume_down", "input_numeric", "input_t9",
                "selection_up", "selection_down", "selection_left",
                "selection_right", "selection_select",
            },
        )

    def test_backend_and_local_actions_do_not_overlap(self):
        self.assertFalse(BACKEND_ACTIONS & LOCAL_ACTIONS)
        self.assertEqual(BACKEND_ACTIONS | LOCAL_ACTIONS, set(ACTION_REGISTRY))

    def test_ptt_is_hold_backend_action(self):
        self.assertIn("ptt", BACKEND_ACTIONS)
        self.assertIn("ptt", HOLD_ACTIONS)

    def test_sos_is_layout_only(self):
        self.assertIn("sos", LOCAL_ACTIONS)
        self.assertNotIn("sos", BACKEND_ACTIONS)
        self.assertNotIn("sos", HOLD_ACTIONS)
