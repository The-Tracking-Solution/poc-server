from django.db import migrations, models


def upgrade_legacy_default(apps, schema_editor):
    Tenant = apps.get_model("engine_main", "Tenant")
    # Alleen de oude standaardwaarde wordt aangepast. Bewust door de beheerder
    # ingestelde afwijkende waarden blijven intact.
    Tenant.objects.filter(preemption_hold_ms=2000).update(preemption_hold_ms=3000)


class Migration(migrations.Migration):

    dependencies = [
        ("engine_main", "0003_hardwareautologin"),
    ]

    operations = [
        migrations.AlterField(
            model_name="tenant",
            name="preemption_hold_ms",
            field=models.PositiveIntegerField(
                default=3000,
                help_text=(
                    "Totale PTT-holdtijd voordat een hogere normale prioriteit een lagere actieve TX mag overnemen. "
                    "Standaard 3000 ms: maximaal 1 seconde bezet-buzz plus 2 seconden extra vasthouden. "
                    "Prioriteiten 91 t/m 99 preëmpten een lagere TX direct."
                ),
                verbose_name="Overnametijd (ms)",
            ),
        ),
        migrations.RunPython(upgrade_legacy_default, migrations.RunPython.noop),
    ]
