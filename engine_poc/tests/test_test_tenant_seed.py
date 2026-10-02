from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase

from engine_dispatch.models import DispatchUser
from engine_main.models import Tenant
from engine_poc.models import Channel
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, UserProfile


class TestTenantSeedTests(TestCase):
    def setUp(self):
        call_command("setup_test_tenant", verbosity=0)

    def test_complete_test_seed(self):
        tenant = Tenant.objects.get(slug="test")
        User = get_user_model()
        self.assertEqual(
            set(User.objects.filter(username__in=["admin", "soft", "te320", "dispatch"]).values_list("username", flat=True)),
            {"admin", "soft", "te320", "dispatch"},
        )
        admin = User.objects.get(username="admin")
        self.assertTrue(admin.is_staff)
        self.assertTrue(admin.is_superuser)

        channels = {c.slug: c.channel_type for c in Channel.objects.filter(tenant=tenant)}
        self.assertEqual(channels["test_audio"], Channel.ChannelType.ECHO)
        for slug in ("alfa", "bravo", "charlie", "delta"):
            self.assertEqual(channels[slug], Channel.ChannelType.GROUP)

        profile = UserProfile.objects.get(tenant=tenant, slug="test_profile")
        self.assertEqual(set(profile.channels.values_list("slug", flat=True)), {"test_audio", "alfa", "bravo", "charlie", "delta"})
        self.assertEqual(profile.opus_bitrate_kbps, 24)
        self.assertFalse(profile.opus_dtx)
        self.assertTrue(profile.opus_red)

        hardware = HardwareConfig.objects.get(name="alle")
        te320_hardware = HardwareConfig.objects.get(name="Telox TE320")
        self.assertIn("topkeys", hardware.config)
        self.assertIn("navkeys", hardware.config)
        self.assertIn("leftkeys", hardware.config)
        self.assertIn("rightkeys", hardware.config)
        self.assertIn("softradio", hardware.config)
        self.assertIn("keyboard", hardware.config)
        self.assertIn("softkeys", hardware.config["display"])

        hw_profile = HardwareProfile.objects.get(tenant=tenant, slug="all_keys")
        te320_hw_profile = HardwareProfile.objects.get(tenant=tenant, slug="te320")
        self.assertEqual(hw_profile.hardware_config, hardware)
        self.assertEqual(te320_hw_profile.hardware_config, te320_hardware)

        radios = RadioUser.objects.filter(tenant=tenant)
        self.assertEqual(set(radios.values_list("slug", flat=True)), {"admin", "soft", "te320", "dispatch"})
        for radio in radios:
            self.assertEqual(list(radio.django_users.values_list("username", flat=True)), [radio.slug])
            self.assertEqual(radio.current_channel.slug, "test_audio")
            self.assertEqual(radio.user_profile, profile)
            self.assertEqual(radio.hardware_profile, te320_hw_profile if radio.slug == "te320" else hw_profile)

        dispatch = DispatchUser.objects.get(tenant=tenant, slug="dispatch")
        self.assertEqual(set(dispatch.django_users.values_list("username", flat=True)), {"dispatch"})
