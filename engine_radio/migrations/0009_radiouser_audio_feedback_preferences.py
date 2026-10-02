from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("engine_radio", "0008_location_interval_seconds"),
    ]

    operations = [
        migrations.AddField(
            model_name="radiouser",
            name="play_tx_accept_tone",
            field=models.BooleanField(
                default=True,
                help_text="Speel de korte bevestigingstoon af zodra zendtoestemming is verkregen.",
                verbose_name="TX-accepttoon afspelen",
            ),
        ),
        migrations.AddField(
            model_name="radiouser",
            name="play_key_tones",
            field=models.BooleanField(
                default=True,
                help_text="Speel lokale toetstonen af bij bediening van soft- en hardwaretoetsen.",
                verbose_name="Toetstonen afspelen",
            ),
        ),
        migrations.AddField(
            model_name="radiouser",
            name="vibration_enabled",
            field=models.BooleanField(
                default=True,
                help_text="Geef korte haptische feedback bij toetsbediening als het apparaat dit ondersteunt.",
                verbose_name="Trillen actief",
            ),
        ),
    ]
