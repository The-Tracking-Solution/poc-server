from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("engine_poc", "0004_rename_echo_channel_to_test_audio"),
    ]

    operations = [
        migrations.AddField(
            model_name="devicesession",
            name="django_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="device_sessions",
                to=settings.AUTH_USER_MODEL,
                verbose_name="Ingelogde gebruiker",
            ),
        ),
    ]
