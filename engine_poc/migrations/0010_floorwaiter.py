from django.db import migrations, models
import django.db.models.deletion
import engine_poc.timeutils


class Migration(migrations.Migration):
    dependencies = [
        ("engine_poc", "0009_rename_engine_poc_a_tenant__index_engine_poc__tenant__f62530_idx"),
    ]

    operations = [
        migrations.CreateModel(
            name="FloorWaiter",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_poc.timeutils.now_ms, editable=False)),
                ("last_update_ms", models.BigIntegerField(default=engine_poc.timeutils.now_ms, editable=False)),
                ("priority", models.PositiveSmallIntegerField(verbose_name="PTT-prioriteit")),
                ("emergency", models.BooleanField(default=False, verbose_name="Noodaanvraag")),
                ("requested_at_ms", models.BigIntegerField(default=engine_poc.timeutils.now_ms, verbose_name="Wacht sinds (ms)")),
                ("last_request_at_ms", models.BigIntegerField(default=engine_poc.timeutils.now_ms, verbose_name="Laatste PTT-aanvraag (ms)")),
                ("channel", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="floor_waiters", to="engine_poc.channel")),
                ("session", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="floor_waiters", to="engine_poc.devicesession")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="floor_waiters", to="engine_main.tenant")),
            ],
            options={
                "verbose_name": "PTT-wachtende",
                "verbose_name_plural": "PTT-wachtrij",
                "ordering": ["-priority", "requested_at_ms", "pk"],
            },
        ),
        migrations.AddConstraint(
            model_name="floorwaiter",
            constraint=models.UniqueConstraint(fields=("channel", "session"), name="engine_poc_floorwaiter_channel_session_uq"),
        ),
        migrations.AddIndex(
            model_name="floorwaiter",
            index=models.Index(fields=["tenant", "channel", "priority", "requested_at_ms"], name="engine_poc_floorwaiter_queue_idx"),
        ),
    ]
