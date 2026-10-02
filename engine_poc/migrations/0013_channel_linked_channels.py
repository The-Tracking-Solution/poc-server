from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("engine_poc", "0012_rename_floorwaiter_queue_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="channel",
            name="linked_channels",
            field=models.ManyToManyField(
                blank=True,
                symmetrical=True,
                to="engine_poc.channel",
                verbose_name="Gekoppelde kanalen",
            ),
        ),
    ]
