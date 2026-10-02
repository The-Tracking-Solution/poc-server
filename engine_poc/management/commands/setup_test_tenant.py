from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand
from django.db import transaction

from engine_dispatch.models import DispatchUser
from engine_main.models import Tenant
from engine_poc.models import Channel
from engine_poc.user_status_defaults import ensure_default_user_statuses
from engine_radio.hardware_defaults import generic_hardware_config, softradio_hardware_config, telox_te320_hardware_config
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, Screen, UserProfile


PASSWORD = "poc2026"
TENANT_SLUG = "test"


class Command(BaseCommand):
    help = "Maak of herstel de complete test-tenant voor de TTS POC."

    def add_arguments(self, parser):
        parser.add_argument(
            "--preload",
            action="store_true",
            help="Interne optie voor de eenmalige preload op een lege database.",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Expliciet handmatig herstellen/bijwerken van de testtenant. Kan bestaande POC-data wijzigen.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        if not options.get("force") and not options.get("preload"):
            if (
                Tenant.objects.exists()
                or Channel.objects.exists()
                or HardwareConfig.objects.exists()
                or HardwareProfile.objects.exists()
                or Screen.objects.exists()
                or UserProfile.objects.exists()
                or RadioUser.objects.exists()
            ):
                self.stdout.write(
                    self.style.WARNING(
                        "Geen wijzigingen uitgevoerd: de applicatie-database bevat al data. "
                        "Gebruik alleen bewust --force als je de testtenant handmatig wilt herstellen."
                    )
                )
                return
        tenant, _ = Tenant.objects.update_or_create(
            slug=TENANT_SLUG,
            defaults={
                "name": "Test",
                "preemption_hold_ms": 3000,
                "urgent_priority": 50,
                "emergency_priority": 99,
                "heartbeat_interval_ms": 5000,
                "heartbeat_timeout_ms": 15000,
                "default_max_ptt_duration_ms": 60000,
            },
        )
        ensure_default_user_statuses(tenant)

        channels = {}
        channel_specs = (
            ("test_audio", "test_audio", Channel.ChannelType.ECHO),
            ("alfa", "Alfa", Channel.ChannelType.GROUP),
            ("bravo", "Bravo", Channel.ChannelType.GROUP),
            ("charlie", "Charlie", Channel.ChannelType.GROUP),
            ("delta", "Delta", Channel.ChannelType.GROUP),
        )
        for slug, name, channel_type in channel_specs:
            channel, _ = Channel.objects.update_or_create(
                tenant=tenant,
                slug=slug,
                defaults={
                    "name": name,
                    "status": Channel.Status.ACTIVE,
                    "channel_type": channel_type,
                    "max_ptt_duration_ms": None,
                },
            )
            channels[slug] = channel

        user_profile, _ = UserProfile.objects.update_or_create(
            tenant=tenant,
            slug="test_profile",
            defaults={
                "name": "Test profiel - alle kanalen",
                "ptt_priority": 0,
                "opus_bitrate_kbps": 24,
                "opus_dtx": False,
                "opus_red": True,
            },
        )
        user_profile.channels.set(list(channels.values()))

        # Exact de canonieke hardwareconfig uit deze codebase. Geen extra of
        # verzonnen toetsen: TK/NK/LK/RK/SK/SR/KB worden door de bestaande UI
        # opgeslagen onder topkeys/navkeys/leftkeys/rightkeys/display.softkeys/
        # softradio/keyboard.
        hardware_alle, _ = HardwareConfig.objects.get_or_create(
            name="alle",
            defaults={"config": generic_hardware_config()},
        )
        hardware_te320, _ = HardwareConfig.objects.get_or_create(
            name="Telox TE320",
            defaults={"config": telox_te320_hardware_config()},
        )
        HardwareConfig.objects.get_or_create(
            name="Softradio",
            defaults={"config": softradio_hardware_config()},
        )

        hardware_profile, _ = HardwareProfile.objects.update_or_create(
            tenant=tenant,
            slug="all_keys",
            defaults={
                "name": "Alle hardware",
                "hardware_config": hardware_alle,
                "config": {},
            },
        )
        te320_profile, _ = HardwareProfile.objects.update_or_create(
            tenant=tenant,
            slug="te320",
            defaults={
                "name": "Telox TE320",
                "hardware_config": hardware_te320,
                "config": {},
            },
        )

        # Zonder minstens één Screen-record heeft de productie-radio niets om te renderen.
        Screen.objects.update_or_create(
            tenant=tenant,
            name="home",
            defaults={
                "hardware_profile": hardware_profile,
                "config": {},
            },
        )

        User = get_user_model()
        users = {}
        for username in ("admin", "soft", "te320", "dispatch"):
            user, _ = User.objects.get_or_create(username=username)
            user.set_password(PASSWORD)
            user.is_active = True
            user.is_staff = username == "admin"
            user.is_superuser = username == "admin"
            user.save()
            users[username] = user

        # Dispatch-login voor de meldkamerkant.
        dispatch_user, _ = DispatchUser.objects.update_or_create(
            tenant=tenant,
            slug="dispatch",
            defaults={
                "internal_name": "dispatch",
                "external_name": "Dispatch",
                "device_status": DispatchUser.DeviceStatus.OFFLINE,
                "user_profile": user_profile,
                "secret_key_hash": make_password(PASSWORD),
            },
        )
        dispatch_user.django_users.set([users["dispatch"]])

        # Vier radio-identiteiten, elk exact aan één Django-account gekoppeld.
        radio_specs = (
            ("admin", "Admin radio", users["admin"]),
            ("soft", "Soft radio", users["soft"]),
            ("te320", "TE320 radio", users["te320"]),
            ("dispatch", "Dispatch radio", users["dispatch"]),
        )
        for slug, display_name, django_user in radio_specs:
            radio, _ = RadioUser.objects.update_or_create(
                tenant=tenant,
                slug=slug,
                defaults={
                    "internal_name": slug,
                    "external_name": display_name,
                    "debug": True,
                    "device_status": RadioUser.DeviceStatus.OFFLINE,
                    "current_channel": channels["test_audio"],
                    "user_profile": user_profile,
                    "hardware_profile": te320_profile if slug == "te320" else hardware_profile,
                    "secret_key_hash": make_password(PASSWORD),
                },
            )
            radio.django_users.set([django_user])

        self.stdout.write(self.style.SUCCESS("Test-tenant 'test' is ingericht."))
        self.stdout.write("Users: admin, soft, te320, dispatch")
        self.stdout.write(f"Wachtwoord voor alle users: {PASSWORD}")
        self.stdout.write("Kanalen: test_audio (echo-type), Alfa, Bravo, Charlie, Delta (group)")
        self.stdout.write("Radio's: admin, soft, te320, dispatch; elk 1-op-1 gekoppeld")
        self.stdout.write("UserProfile: test_profile met alle vijf kanalen")
        self.stdout.write("Hardware configs: alle + Telox TE320 + Softradio")
        self.stdout.write("Hardwareprofielen: all_keys + te320")
        self.stdout.write("Startscherm: home")
