from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from engine_dispatch.models import DispatchUser
from engine_main.models import Tenant
from engine_poc.models import Channel
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, Screen, UserProfile


class Command(BaseCommand):
    help = "Controleer of de complete testconfig correct is aangemaakt."

    def handle(self, *args, **options):
        errors = []
        User = get_user_model()

        try:
            tenant = Tenant.objects.get(slug="test")
        except Tenant.DoesNotExist:
            raise CommandError("Tenant 'test' ontbreekt.")

        expected_users = {"admin", "soft", "te320", "dispatch"}
        actual_users = set(User.objects.filter(username__in=expected_users).values_list("username", flat=True))
        if actual_users != expected_users:
            errors.append(f"Users fout: verwacht {sorted(expected_users)}, gevonden {sorted(actual_users)}")

        admin = User.objects.filter(username="admin", is_staff=True, is_superuser=True).first()
        if not admin:
            errors.append("admin is geen staff/superuser")

        expected_channels = {
            "test_audio": Channel.ChannelType.ECHO,
            "alfa": Channel.ChannelType.GROUP,
            "bravo": Channel.ChannelType.GROUP,
            "charlie": Channel.ChannelType.GROUP,
            "delta": Channel.ChannelType.GROUP,
        }
        found_channels = {c.slug: c.channel_type for c in Channel.objects.filter(tenant=tenant)}
        for slug, channel_type in expected_channels.items():
            if found_channels.get(slug) != channel_type:
                errors.append(f"Kanaal {slug} ontbreekt of heeft fout type")

        profile = UserProfile.objects.filter(tenant=tenant, slug="test_profile").first()
        if not profile:
            errors.append("UserProfile test_profile ontbreekt")
        else:
            profile_channels = set(profile.channels.values_list("slug", flat=True))
            if profile_channels != set(expected_channels):
                errors.append(f"test_profile kanalen fout: {sorted(profile_channels)}")
            if profile.opus_bitrate_kbps != 24 or profile.opus_dtx or not profile.opus_red:
                errors.append("test_profile Opus instellingen zijn niet 24kbps / DTX uit / RED aan")

        hardware = HardwareConfig.objects.filter(name="alle").first()
        te320_hardware = HardwareConfig.objects.filter(name="Telox TE320").first()
        softradio_hardware = HardwareConfig.objects.filter(name="Softradio").first()
        if not hardware:
            errors.append("HardwareConfig alle ontbreekt")
        else:
            cfg = hardware.config or {}
            required_paths = ["topkeys", "navkeys", "leftkeys", "rightkeys", "softradio", "keyboard", "display"]
            for key in required_paths:
                if key not in cfg:
                    errors.append(f"Hardwaregroep ontbreekt: {key}")
            if "softkeys" not in (cfg.get("display") or {}):
                errors.append("Hardwaregroep display.softkeys ontbreekt")

        if not softradio_hardware:
            errors.append("HardwareConfig Softradio ontbreekt")

        if not te320_hardware:
            errors.append("HardwareConfig Telox TE320 ontbreekt")
        else:
            cfg = te320_hardware.config or {}
            if cfg.get("leftkeys", {}).get("keys", {}).get("tl2", {}).get("hw_key") != 141:
                errors.append("Telox TE320 PTT keyCode is niet 141")
            tk7 = cfg.get("topkeys", {}).get("keys", {}).get("tk7", {})
            if tk7.get("hw_key_clockwise") != 167 or tk7.get("action_clockwise") != "channel_up":
                errors.append("Telox TE320 TK7 clockwise mapping is fout")
            if tk7.get("hw_key_counter_clockwise") != 166 or tk7.get("action_counter_clockwise") != "channel_down":
                errors.append("Telox TE320 TK7 counter-clockwise mapping is fout")
            if any(name.startswith("short_action") or name.startswith("long_action") for name in tk7):
                errors.append("Telox TE320 TK7 bevat nog short/long rotary-velden")

        hw_profile = HardwareProfile.objects.filter(tenant=tenant, slug="all_keys").first()
        te320_hw_profile = HardwareProfile.objects.filter(tenant=tenant, slug="te320").first()
        if not hw_profile:
            errors.append("HardwareProfile all_keys ontbreekt")
        elif hardware and hw_profile.hardware_config_id != hardware.id:
            errors.append("HardwareProfile all_keys is niet aan hardware alle gekoppeld")
        if not te320_hw_profile:
            errors.append("HardwareProfile te320 ontbreekt")
        elif te320_hardware and te320_hw_profile.hardware_config_id != te320_hardware.id:
            errors.append("HardwareProfile te320 is niet aan Telox TE320 gekoppeld")

        if not Screen.objects.filter(tenant=tenant, name="home").exists():
            errors.append("Screen home ontbreekt")

        expected_radios = {"admin", "soft", "te320", "dispatch"}
        radios = {r.slug: r for r in RadioUser.objects.filter(tenant=tenant, slug__in=expected_radios)}
        if set(radios) != expected_radios:
            errors.append(f"Radio's fout: gevonden {sorted(radios)}")
        for slug, radio in radios.items():
            linked_users = list(radio.django_users.values_list("username", flat=True))
            if linked_users != [slug]:
                errors.append(f"Radio {slug} accountkoppeling fout: {linked_users}")
            if radio.current_channel and radio.current_channel.slug != "test_audio":
                errors.append(f"Radio {slug} start niet op test_audio")
            if profile and radio.user_profile_id != profile.id:
                errors.append(f"Radio {slug} heeft fout user profile")
            expected_hw_profile = te320_hw_profile if slug == "te320" else hw_profile
            if expected_hw_profile and radio.hardware_profile_id != expected_hw_profile.id:
                errors.append(f"Radio {slug} heeft fout hardware profile")

        dispatch = DispatchUser.objects.filter(tenant=tenant, slug="dispatch").first()
        if not dispatch:
            errors.append("DispatchUser dispatch ontbreekt")
        elif set(dispatch.django_users.values_list("username", flat=True)) != {"dispatch"}:
            errors.append("DispatchUser dispatch is niet aan account dispatch gekoppeld")

        if errors:
            raise CommandError("Testconfig ongeldig:\n- " + "\n- ".join(errors))

        self.stdout.write(self.style.SUCCESS("OK: complete testconfig is geldig."))
        self.stdout.write("Tenant: test")
        self.stdout.write("Users/radio's: admin, soft, te320, dispatch")
        self.stdout.write("Kanalen: test_audio, Alfa, Bravo, Charlie, Delta")
        self.stdout.write("HardwareProfiles: all_keys, te320")
