from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from engine_poc.models import Channel
from engine_poc.livekit_media import radio_connection_payload, room_name


class LiveKitEchoPayloadTests(SimpleTestCase):
    def _session(self):
        tenant = SimpleNamespace(slug="test")
        return SimpleNamespace(
            pk=42, tenant=tenant, actor_slug="radio1", actor_name="Radio 1"
        )

    def _profile(self):
        return SimpleNamespace(opus_bitrate_kbps=20, opus_dtx=True, opus_red=False)

    @patch("engine_poc.livekit_media.public_url", return_value="wss://example.test")
    @patch("engine_poc.livekit_media.create_join_token")
    def test_group_channel_keeps_shared_room(self, token, _public_url):
        token.side_effect = ["radio-token"]
        channel = SimpleNamespace(slug="alfa", channel_type=Channel.ChannelType.GROUP, ChannelType=Channel.ChannelType)
        payload = radio_connection_payload(
            request=object(), session=self._session(), channel=channel, profile=self._profile()
        )
        self.assertEqual(payload["room"], room_name("test", "alfa"))
        self.assertNotIn("echo", payload)
        self.assertEqual(token.call_count, 1)

    @patch("engine_poc.livekit_media.public_url", return_value="wss://example.test")
    @patch("engine_poc.livekit_media.create_join_token")
    def test_echo_channel_is_shared_parrot_room(self, token, _public_url):
        token.side_effect = ["radio-token"]
        channel = SimpleNamespace(slug="test_audio", channel_type=Channel.ChannelType.ECHO, ChannelType=Channel.ChannelType)
        payload = radio_connection_payload(
            request=object(), session=self._session(), channel=channel, profile=self._profile()
        )
        self.assertEqual(payload["room"], room_name("test", "test_audio"))
        self.assertEqual(payload["channel_type"], "echo")
        self.assertNotIn("echo", payload)
        self.assertEqual(token.call_count, 1)
        self.assertTrue(token.call_args.kwargs["can_publish"])
        self.assertTrue(token.call_args.kwargs["can_subscribe"])
