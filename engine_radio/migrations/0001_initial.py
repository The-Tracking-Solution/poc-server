import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import engine_main.timeutils
import engine_main.validators
import engine_radio.config_overrides
import engine_radio.models
import engine_radio.validators


class Migration(migrations.Migration):
    initial = True
    dependencies = [
        ("engine_main", "0001_initial"),
        ("engine_poc", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Hardware",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("name", models.CharField(max_length=200, unique=True, verbose_name="Naam")),
                ("config", models.JSONField(default=engine_radio.models.default_screen_config, validators=[engine_radio.validators.validate_screen_config], verbose_name="Configuratie")),
            ],
            options={"ordering":["name"],"verbose_name":"Hardware","verbose_name_plural":"Hardware"},
        ),
        migrations.CreateModel(
            name="UserProfile",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(max_length=64, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("name", models.CharField(max_length=200, verbose_name="Naam")),
                ("location_enabled", models.BooleanField(default=False, verbose_name="Locatie ingeschakeld")),
                ("ptt_priority", models.PositiveSmallIntegerField(default=0, verbose_name="PTT-prioriteit")),
                ("opus_bitrate_kbps", models.PositiveSmallIntegerField(default=20, help_text="Doelbitrate voor PTT-spraak. 16-24 kbps is een goede start.", verbose_name="Opus bitrate (kbps)")),
                ("opus_dtx", models.BooleanField(default=True, verbose_name="Opus DTX")),
                ("opus_red", models.BooleanField(default=False, help_text="Redundante audio verhoogt robuustheid maar ook dataverbruik.", verbose_name="Opus RED")),
                ("channels", models.ManyToManyField(blank=True, related_name="user_profiles", to="engine_poc.channel", verbose_name="Kanalen")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["tenant__name","name"],"verbose_name":"Gebruikersprofiel","verbose_name_plural":"Gebruikersprofielen"},
        ),
        migrations.AddConstraint(model_name="userprofile", constraint=models.UniqueConstraint(fields=("tenant","slug"), name="engine_radio_userprofile_tenant_slug_uq")),
        migrations.CreateModel(
            name="HardwareProfile",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(max_length=64, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("name", models.CharField(max_length=200, verbose_name="Naam")),
                ("location_enabled", models.BooleanField(default=False, verbose_name="Locatie ingeschakeld")),
                ("config", models.JSONField(blank=True, default=dict, validators=[engine_radio.config_overrides.validate_config_override], verbose_name="Configuratie-override")),
                ("hardware", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="profiles", to="engine_radio.hardware", verbose_name="Hardware")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["tenant__name","name"],"verbose_name":"Hardwareprofiel","verbose_name_plural":"Hardwareprofielen"},
        ),
        migrations.AddConstraint(model_name="hardwareprofile", constraint=models.UniqueConstraint(fields=("tenant","slug"), name="engine_radio_hardwareprofile_tenant_slug_uq")),
        migrations.CreateModel(
            name="RadioUser",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(max_length=64, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("secret_key_hash", models.CharField(editable=False, max_length=256)),
                ("internal_name", models.CharField(max_length=200, verbose_name="Interne naam")),
                ("external_name", models.CharField(max_length=200, verbose_name="Weergavenaam")),
                ("debug", models.BooleanField(default=False, help_text="Toon hardware/key-press meldingen op de secundaire regel van de radio.", verbose_name="Debug")),
                ("device_status", models.CharField(choices=[("offline","Offline"),("online","Online")], default="offline", max_length=16, verbose_name="Apparaatstatus")),
                ("current_channel", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="current_radio_users", to="engine_poc.channel", verbose_name="Huidig kanaal")),
                ("django_users", models.ManyToManyField(related_name="radio_users", to=settings.AUTH_USER_MODEL, verbose_name="Django-gebruikers")),
                ("hardware_profile", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="radio_users", to="engine_radio.hardwareprofile", verbose_name="Hardwareprofiel")),
                ("previous_status", models.ForeignKey(blank=True, editable=False, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="previous_status_radio_users", to="engine_poc.userstatus", verbose_name="Vorige status")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
                ("user_profile", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="radio_users", to="engine_radio.userprofile", verbose_name="Gebruikersprofiel")),
                ("user_status", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to="engine_poc.userstatus", verbose_name="Gebruikersstatus")),
            ],
            options={"ordering":["tenant__name","external_name"],"verbose_name":"Radio","verbose_name_plural":"Radio's"},
        ),
        migrations.AddConstraint(model_name="radiouser", constraint=models.UniqueConstraint(fields=("tenant","slug"), name="engine_radio_radiouser_tenant_slug_uq")),
        migrations.CreateModel(
            name="Screen",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("name", models.CharField(max_length=200, verbose_name="Naam")),
                ("config", models.JSONField(blank=True, default=dict, validators=[engine_radio.config_overrides.validate_config_override], verbose_name="Configuratie-override")),
                ("hardware_profile", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="screens", to="engine_radio.hardwareprofile", verbose_name="Hardwareprofiel")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="screens", to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["tenant__name","name"],"verbose_name":"Scherm","verbose_name_plural":"Schermen"},
        ),
        migrations.AddConstraint(model_name="screen", constraint=models.UniqueConstraint(fields=("tenant","name"), name="engine_radio_screen_tenant_name_uq")),
    ]
