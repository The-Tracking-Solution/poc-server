from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("engine_dispatch", "0002_dispatch_settings_hierarchy"),
    ]

    operations = [
        migrations.AddField(
            model_name="dispatchconfig",
            name="buttons",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text="Centrale knopdefinities: radio (R1-R5) en sidebar (SB).",
                verbose_name="Buttons",
            ),
        ),
        migrations.AddField(
            model_name="dispatchprofile",
            name="buttons",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text="Alleen overrides per button-id: true/false.",
                verbose_name="Buttons aan/uit",
            ),
        ),
        migrations.AddField(
            model_name="dispatchusersettings",
            name="buttons",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text="Alleen overrides per button-id: true/false.",
                verbose_name="Buttons aan/uit",
            ),
        ),
    ]
