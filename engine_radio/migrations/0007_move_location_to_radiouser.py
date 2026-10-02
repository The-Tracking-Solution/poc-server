from django.contrib.gis.db import models as gis_models
from django.db import migrations, models


def copy_profile_location_to_radios(apps, schema_editor):
    UserProfile = apps.get_model("engine_radio", "UserProfile")
    RadioUser = apps.get_model("engine_radio", "RadioUser")
    for profile in UserProfile.objects.all().iterator():
        RadioUser.objects.filter(user_profile_id=profile.pk).update(
            location_enabled=profile.location_enabled,
            last_location=profile.last_location,
            last_location_accuracy_m=profile.last_location_accuracy_m,
            last_location_at_ms=profile.last_location_at_ms,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("engine_radio", "0006_userprofile_location"),
    ]

    operations = [
        migrations.AddField(
            model_name="radiouser",
            name="location_enabled",
            field=models.BooleanField(default=False, verbose_name="Locatie ingeschakeld"),
        ),
        migrations.AddField(
            model_name="radiouser",
            name="last_location",
            field=gis_models.PointField(blank=True, help_text="Laatste betrouwbare locatie van deze radio (alleen updates met accuracy < 25 meter).", null=True, srid=4326, verbose_name="Laatste locatie"),
        ),
        migrations.AddField(
            model_name="radiouser",
            name="last_location_accuracy_m",
            field=models.FloatField(blank=True, null=True, verbose_name="Nauwkeurigheid laatste locatie (m)"),
        ),
        migrations.AddField(
            model_name="radiouser",
            name="last_location_at_ms",
            field=models.BigIntegerField(blank=True, null=True, verbose_name="Tijdstip laatste locatie (ms)"),
        ),
        migrations.RunPython(copy_profile_location_to_radios, migrations.RunPython.noop),
        migrations.RemoveField(model_name="userprofile", name="location_enabled"),
        migrations.RemoveField(model_name="userprofile", name="last_location"),
        migrations.RemoveField(model_name="userprofile", name="last_location_accuracy_m"),
        migrations.RemoveField(model_name="userprofile", name="last_location_at_ms"),
    ]
