import django.contrib.gis.db.models.fields
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("engine_main", "0005_enable_postgis"),
        ("engine_poc", "0010_floorwaiter"),
    ]
    operations = [
        migrations.AddField(
            model_name="eventlog",
            name="location",
            field=django.contrib.gis.db.models.fields.PointField(
                blank=True,
               
                help_text="Gemeten locatie behorend bij dit event. Voor locatie-events wordt iedere geldige meting bewaard, ongeacht accuracy.",
                null=True,
                srid=4326,
                verbose_name="Locatie",
            ),
        ),
        migrations.AddField(
            model_name="eventlog",
            name="location_accuracy_m",
            field=models.FloatField(blank=True, null=True, verbose_name="Locatie-accuracy (m)"),
        ),
        migrations.AddField(
            model_name="eventlog",
            name="location_timestamp_ms",
            field=models.BigIntegerField(blank=True, null=True, verbose_name="Locatie meettijdstip (ms)"),
        ),
    ]
