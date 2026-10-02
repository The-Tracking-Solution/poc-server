import django.db.models.deletion
from django.db import migrations, models

import engine_main.models
import engine_main.timeutils
import engine_main.validators


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Tenant",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(help_text="Unieke naam voor API's en interne verwijzingen.", max_length=64, unique=True, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("name", models.CharField(max_length=200, verbose_name="Naam")),
                ("logo", models.ImageField(blank=True, null=True, upload_to=engine_main.models.tenant_logo_upload_to, verbose_name="Logo")),
                ("preemption_hold_ms", models.PositiveIntegerField(default=2000, verbose_name="Overnametijd (ms)")),
                ("urgent_priority", models.PositiveSmallIntegerField(default=50, verbose_name="Spoedprioriteit")),
                ("emergency_priority", models.PositiveSmallIntegerField(default=99, verbose_name="Noodprioriteit")),
                ("heartbeat_interval_ms", models.PositiveIntegerField(default=5000, verbose_name="Heartbeat-interval (ms)")),
                ("heartbeat_timeout_ms", models.PositiveIntegerField(default=15000, verbose_name="Heartbeat-time-out (ms)")),
                ("default_max_ptt_duration_ms", models.PositiveIntegerField(blank=True, default=60000, null=True, verbose_name="Standaard maximale PTT-duur (ms)")),
            ],
            options={"verbose_name": "Tenant", "verbose_name_plural": "Tenants", "ordering": ["name"]},
        ),
    ]
