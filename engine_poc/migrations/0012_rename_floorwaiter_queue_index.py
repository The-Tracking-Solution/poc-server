from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("engine_poc", "0011_eventlog_location"),
    ]

    operations = [
        migrations.RenameIndex(
            model_name="floorwaiter",
            old_name="engine_poc_floorwaiter_queue_idx",
            new_name="engine_poc_floorwait_q_idx",
        ),
    ]
