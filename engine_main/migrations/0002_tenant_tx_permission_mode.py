from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("engine_main", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="tenant",
            name="tx_permission_mode",
            field=models.CharField(
                choices=[("proactive", "Proactief"), ("conservative", "Conservatief")],
                default="conservative",
                help_text=(
                    "Proactief start lokale WebRTC-TX direct en laat de server parallel controleren; "
                    "Conservatief start TX pas na expliciete floor-toekenning."
                ),
                max_length=16,
                verbose_name="TX-toestemmingsmodus",
            ),
        ),
    ]
