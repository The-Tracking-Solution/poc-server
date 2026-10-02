from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("engine_poc", "0007_callrequest_priority_6")]

    operations = [
        migrations.AddField(
            model_name="channelstate", name="parrot_active",
            field=models.BooleanField(default=False, verbose_name="Papegaai actief"),
        ),
        migrations.AddField(
            model_name="channelstate", name="parrot_started_at_ms",
            field=models.BigIntegerField(blank=True, null=True, verbose_name="Papegaai gestart op (ms)"),
        ),
        migrations.AddField(
            model_name="channelstate", name="parrot_owner_session",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="parrot_floors", to="engine_poc.devicesession", verbose_name="Papegaai bron-sessie"),
        ),
    ]
