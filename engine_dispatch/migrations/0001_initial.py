import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import engine_main.timeutils
import engine_main.validators


class Migration(migrations.Migration):
    initial = True
    dependencies = [
        ("engine_main", "0001_initial"),
        ("engine_radio", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]
    operations = [
        migrations.CreateModel(
            name="DispatchUser",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(max_length=64, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("secret_key_hash", models.CharField(editable=False, max_length=256)),
                ("internal_name", models.CharField(max_length=200, verbose_name="Interne naam")),
                ("external_name", models.CharField(max_length=200, verbose_name="Weergavenaam")),
                ("device_status", models.CharField(choices=[("offline","Offline"),("online","Online")], default="offline", max_length=16, verbose_name="Apparaatstatus")),
                ("django_users", models.ManyToManyField(related_name="dispatch_users", to=settings.AUTH_USER_MODEL, verbose_name="Django-gebruikers")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
                ("user_profile", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="dispatch_users", to="engine_radio.userprofile", verbose_name="Gebruikersprofiel")),
            ],
            options={"verbose_name":"Dispatch","verbose_name_plural":"Dispatchers","ordering":["tenant__name","external_name"]},
        ),
        migrations.AddConstraint(model_name="dispatchuser", constraint=models.UniqueConstraint(fields=("tenant","slug"), name="engine_dispatch_dispatchuser_tenant_slug_uq")),
        migrations.CreateModel(
            name="DispatchSession",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("session_key", models.CharField(max_length=64, verbose_name="Browsersessie")),
                ("status", models.CharField(choices=[("active","Actief"),("released","Vrijgegeven"),("timed_out","Time-out")], default="active", max_length=16, verbose_name="Status")),
                ("claimed_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Geclaimd op (ms)")),
                ("last_seen_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst gezien (ms)")),
                ("telemetry", models.JSONField(blank=True, default=dict, help_text="Geaggregeerde WebRTC-metingen sinds de vorige heartbeat.", verbose_name="Laatste heartbeattelemetrie")),
                ("released_at_ms", models.BigIntegerField(blank=True, null=True, verbose_name="Vrijgegeven op (ms)")),
                ("dispatch_user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="sessions", to="engine_dispatch.dispatchuser", verbose_name="Dispatcher")),
                ("django_user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="dispatch_sessions", to=settings.AUTH_USER_MODEL, verbose_name="Django-gebruiker")),
            ],
            options={"verbose_name":"Dispatchsessie","verbose_name_plural":"Dispatchsessies","ordering":["-claimed_at_ms"]},
        ),
        migrations.AddConstraint(model_name="dispatchsession", constraint=models.UniqueConstraint(condition=models.Q(("status","active")), fields=("dispatch_user",), name="one_active_session_per_dispatch_user")),
    ]
