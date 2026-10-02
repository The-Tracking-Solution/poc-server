import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def populate_device_uuids(apps, schema_editor):
    HardwareAutoLogin = apps.get_model("engine_main", "HardwareAutoLogin")
    for mapping in HardwareAutoLogin.objects.filter(device_uuid__isnull=True).iterator():
        mapping.device_uuid = uuid.uuid4()
        mapping.save(update_fields=["device_uuid"])


class Migration(migrations.Migration):
    dependencies = [
        ("engine_main", "0005_enable_postgis"),
    ]

    operations = [
        migrations.AddField(
            model_name="hardwareautologin",
            name="device_uuid",
            field=models.UUIDField(null=True, editable=False),
        ),
        migrations.AddField(
            model_name="hardwareautologin",
            name="android_id",
            field=models.CharField(blank=True, db_index=True, max_length=255, verbose_name="Android ID"),
        ),
        migrations.AlterField(
            model_name="hardwareautologin",
            name="user",
            field=models.ForeignKey(
                blank=True,
                help_text="Leeg zolang een nieuw device nog niet is gekoppeld.",
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="hardware_auto_logins",
                to=settings.AUTH_USER_MODEL,
                verbose_name="Gebruiker",
            ),
        ),
        migrations.RunPython(populate_device_uuids, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="hardwareautologin",
            name="device_uuid",
            field=models.UUIDField(default=uuid.uuid4, editable=False, unique=True, verbose_name="Device UUID"),
        ),
        migrations.AlterField(
            model_name="hardwareautologin",
            name="hardware_id",
            field=models.CharField(
                help_text="Legacy hardware-ID. Nieuwe Android-clients gebruiken device_uuid.",
                max_length=255,
                unique=True,
                verbose_name="Hardware ID (legacy)",
            ),
        ),
    ]
