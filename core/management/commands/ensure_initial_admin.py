import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Maak bij de eerste opstart een beheerder aan zonder een bestaand wachtwoord te wijzigen."

    def handle(self, *args, **options):
        username = os.getenv("DJANGO_INITIAL_ADMIN_USERNAME", "admin")
        password = os.getenv("DJANGO_INITIAL_ADMIN_PASSWORD", "poc2026")
        email = os.getenv("DJANGO_INITIAL_ADMIN_EMAIL", "admin@localhost")

        User = get_user_model()
        if User.objects.filter(username=username).exists():
            self.stdout.write(self.style.NOTICE(f"Beheerder '{username}' bestaat al; niets gewijzigd."))
            return

        User.objects.create_superuser(username=username, email=email, password=password)
        self.stdout.write(self.style.SUCCESS(f"Beheerder '{username}' is aangemaakt."))
