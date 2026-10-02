from django.db import migrations, models
import django.db.models.deletion
import engine_main.timeutils


class Migration(migrations.Migration):

    dependencies = [
        ("engine_dispatch", "0001_initial"),
        ("engine_main", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="DispatchConfig",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("radio_settings", models.JSONField(blank=True, default=dict, verbose_name="Radio-instellingen")),
                ("tenant", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="dispatch_config", to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={
                "verbose_name": "Dispatch config",
                "verbose_name_plural": "Dispatch configs",
                "db_table": "dispatch_config",
            },
        ),
        migrations.CreateModel(
            name="DispatchProfile",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("name", models.CharField(default="Default", max_length=200, verbose_name="Naam")),
                ("radio_settings", models.JSONField(blank=True, default=dict, verbose_name="Radio-instellingen")),
                ("dispatch_config", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="profiles", to="engine_dispatch.dispatchconfig", verbose_name="Dispatch config")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="dispatch_profiles", to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={
                "verbose_name": "Dispatch profiel",
                "verbose_name_plural": "Dispatch profielen",
                "db_table": "dispatch_profiles",
                "ordering": ["tenant__name", "name"],
            },
        ),
        migrations.AddConstraint(
            model_name="dispatchprofile",
            constraint=models.UniqueConstraint(fields=("tenant", "name"), name="dispatch_profiles_tenant_name_uq"),
        ),
        migrations.AddField(
            model_name="dispatchuser",
            name="dispatch_profile",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="dispatch_users", to="engine_dispatch.dispatchprofile", verbose_name="Dispatchprofiel"),
        ),
        migrations.CreateModel(
            name="DispatchUserSettings",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("radio_settings", models.JSONField(blank=True, default=dict, verbose_name="Radio-instellingen")),
                ("dispatch_profile", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="user_settings", to="engine_dispatch.dispatchprofile", verbose_name="Dispatch profiel")),
                ("dispatch_user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="dispatch_settings", to="engine_dispatch.dispatchuser", verbose_name="Dispatcher")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="dispatch_user_settings", to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={
                "verbose_name": "Dispatch gebruikersinstellingen",
                "verbose_name_plural": "Dispatch gebruikersinstellingen",
                "db_table": "dispatch_usersettings",
            },
        ),
    ]
