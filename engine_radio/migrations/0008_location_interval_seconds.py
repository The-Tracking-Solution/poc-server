from django.db import migrations, models


def forwards(apps, schema_editor):
    RadioUser = apps.get_model("engine_radio", "RadioUser")
    for radio in RadioUser.objects.all().only("pk", "location_enabled"):
        radio.location_interval_seconds = 15 if radio.location_enabled else 0
        radio.save(update_fields=["location_interval_seconds"])


class Migration(migrations.Migration):
    dependencies = [("engine_radio", "0007_move_location_to_radiouser")]
    operations = [
        migrations.AddField(
            model_name="radiouser",
            name="location_interval_seconds",
            field=models.PositiveIntegerField(
                default=15,
                help_text="0 = uitgeschakeld. Anders een veelvoud van 5 seconden.",
                verbose_name="Locatie interval (seconden)",
            ),
        ),
        migrations.RunPython(forwards, migrations.RunPython.noop),
        migrations.RemoveField(model_name="radiouser", name="location_enabled"),
    ]
