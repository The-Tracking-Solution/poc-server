from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("engine_poc", "0006_callrequest_one_active_per_radio"),
    ]

    operations = [
        migrations.AlterField(
            model_name="userstatus",
            name="call_request_priority",
            field=models.PositiveSmallIntegerField(
                blank=True,
                choices=[(1, "1"), (2, "2"), (3, "3"), (4, "4"), (5, "5"), (6, "6")],
                default=None,
                null=True,
                verbose_name="Call request priority",
            ),
        ),
        migrations.AlterField(
            model_name="callrequest",
            name="priority",
            field=models.PositiveSmallIntegerField(choices=[(1, "1"), (2, "2"), (3, "3"), (4, "4"), (5, "5"), (6, "6")]),
        ),
    ]
