from django.db import migrations, models
import django.db.models.deletion


def fill_hardware_config(apps, schema_editor):
    Screen = apps.get_model("engine_radio", "Screen")
    HardwareProfile = apps.get_model("engine_radio", "HardwareProfile")
    profile_map = dict(HardwareProfile.objects.values_list("id", "hardware_config_id"))
    for screen in Screen.objects.all().only("id", "hardware_profile_id"):
        screen.hardware_config_id = profile_map.get(screen.hardware_profile_id)
        screen.save(update_fields=["hardware_config"])


class Migration(migrations.Migration):
    dependencies = [
        ("engine_radio", "0003_default_hardware_configs"),
    ]

    operations = [
        migrations.AddField(
            model_name="screen",
            name="hardware_config",
            field=models.ForeignKey(
                null=True,
                editable=False,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="screens",
                to="engine_radio.hardwareconfig",
                verbose_name="Hardware config",
            ),
        ),
        migrations.RunPython(fill_hardware_config, migrations.RunPython.noop),
        migrations.RemoveConstraint(
            model_name="screen",
            name="engine_radio_screen_tenant_name_uq",
        ),
        migrations.AlterField(
            model_name="screen",
            name="hardware_config",
            field=models.ForeignKey(
                editable=False,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="screens",
                to="engine_radio.hardwareconfig",
                verbose_name="Hardware config",
            ),
        ),
        migrations.AddConstraint(
            model_name="screen",
            constraint=models.UniqueConstraint(
                fields=("tenant", "hardware_config", "name"),
                name="engine_radio_screen_tenant_hwconfig_name_uq",
            ),
        ),
    ]
