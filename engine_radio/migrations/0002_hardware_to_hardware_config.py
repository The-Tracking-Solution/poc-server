from django.db import migrations, models
import django.db.models.deletion
import engine_radio.config_overrides


class Migration(migrations.Migration):
    dependencies = [
        ("engine_radio", "0001_initial"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="Hardware",
            new_name="HardwareConfig",
        ),
        migrations.AlterModelTable(
            name="hardwareconfig",
            table="engine_radio_hardware_config",
        ),
        migrations.AlterModelOptions(
            name="hardwareconfig",
            options={
                "ordering": ["name"],
                "verbose_name": "Hardware config",
                "verbose_name_plural": "Hardware configs",
            },
        ),
        migrations.RenameField(
            model_name="hardwareprofile",
            old_name="hardware",
            new_name="hardware_config",
        ),
        migrations.AlterField(
            model_name="hardwareprofile",
            name="hardware_config",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="profiles",
                to="engine_radio.hardwareconfig",
                verbose_name="Hardware config",
            ),
        ),
        migrations.AlterField(
            model_name="hardwareprofile",
            name="config",
            field=models.JSONField(blank=True, default=dict, validators=[engine_radio.config_overrides.validate_config_override], verbose_name="JSON"),
        ),
        migrations.AlterField(
            model_name="screen",
            name="config",
            field=models.JSONField(blank=True, default=dict, validators=[engine_radio.config_overrides.validate_config_override], verbose_name="JSON"),
        ),
    ]
