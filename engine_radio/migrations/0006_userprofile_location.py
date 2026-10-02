import django.contrib.gis.db.models.fields
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("engine_main", "0005_enable_postgis"),
        ("engine_radio", "0005_radio_contact_status"),
    ]
    operations = [
        migrations.AddField(
            model_name="userprofile",
            name="last_location",
            field=django.contrib.gis.db.models.fields.PointField(
                blank=True,
               
                help_text="Laatste betrouwbare locatie (alleen updates met accuracy < 25 meter).",
                null=True,
                srid=4326,
                verbose_name="Laatste locatie",
            ),
        ),
        migrations.AddField(
            model_name="userprofile",
            name="last_location_accuracy_m",
            field=models.FloatField(blank=True, null=True, verbose_name="Nauwkeurigheid laatste locatie (m)"),
        ),
        migrations.AddField(
            model_name="userprofile",
            name="last_location_at_ms",
            field=models.BigIntegerField(blank=True, null=True, verbose_name="Tijdstip laatste locatie (ms)"),
        ),
        migrations.RemoveField(
            model_name="hardwareprofile",
            name="location_enabled",
        ),
    ]
