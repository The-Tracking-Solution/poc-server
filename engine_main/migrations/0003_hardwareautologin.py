from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import engine_main.timeutils


class Migration(migrations.Migration):

    dependencies = [
        ("engine_main", "0002_tenant_tx_permission_mode"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="HardwareAutoLogin",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("hardware_id", models.CharField(help_text="Hardware-ID zoals aangeleverd door de Android-app. Hoofdletters worden genormaliseerd.", max_length=255, unique=True, verbose_name="Hardware ID")),
                ("name", models.CharField(blank=True, help_text="Optionele herkenbare naam, bijvoorbeeld 'Samsung balie'.", max_length=200, verbose_name="Naam / omschrijving")),
                ("enabled", models.BooleanField(default=True, verbose_name="Auto-login actief")),
                ("last_login_at_ms", models.BigIntegerField(blank=True, editable=False, null=True, verbose_name="Laatste auto-login (ms)")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="hardware_auto_logins", to=settings.AUTH_USER_MODEL, verbose_name="Gebruiker")),
            ],
            options={
                "verbose_name": "Hardware auto-login",
                "verbose_name_plural": "Hardware auto-logins",
                "ordering": ["name", "hardware_id"],
            },
        ),
    ]
