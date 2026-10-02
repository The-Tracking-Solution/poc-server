from django.core.management import call_command
from django.core.management.base import BaseCommand

from engine_main.models import Tenant
from engine_poc.models import Channel
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, Screen, UserProfile


class Command(BaseCommand):
    help = (
        "Voer de initiële POC-preload uitsluitend uit wanneer de applicatie-"
        "database nog geen configuratie/data bevat."
    )

    def _application_database_is_empty(self):
        checks = (
            Tenant.objects.exists(),
            Channel.objects.exists(),
            HardwareConfig.objects.exists(),
            HardwareProfile.objects.exists(),
            Screen.objects.exists(),
            UserProfile.objects.exists(),
            RadioUser.objects.exists(),
        )
        return not any(checks)

    def handle(self, *args, **options):
        if not self._application_database_is_empty():
            self.stdout.write(
                self.style.WARNING(
                    "Preload overgeslagen: applicatie-database bevat al data. "
                    "Bestaande HardwareConfig/HardwareProfile/HardwareScreen-data blijft ongewijzigd."
                )
            )
            return

        self.stdout.write("Lege applicatie-database gedetecteerd; initiële preload wordt uitgevoerd.")
        call_command("ensure_initial_admin")
        call_command("setup_test_tenant", preload=True)
        self.stdout.write(self.style.SUCCESS("Initiële preload voltooid."))
