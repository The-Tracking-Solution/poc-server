from django.contrib.postgres.operations import CreateExtension
from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("engine_main", "0004_preemption_hold_3000"),
    ]
    operations = [
        CreateExtension("postgis"),
    ]
