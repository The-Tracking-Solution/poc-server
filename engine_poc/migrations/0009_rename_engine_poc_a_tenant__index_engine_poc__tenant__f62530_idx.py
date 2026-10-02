from django.db import migrations


OLD_NAME = "engine_poc_a_tenant__index"
NEW_NAME = "engine_poc__tenant__f62530_idx"
TABLE = "engine_poc_channelpresence"


def ensure_index_name(apps, schema_editor):
    """Maak migration 0009 veilig voor zowel oude als reeds bijgewerkte DB's."""
    connection = schema_editor.connection
    qn = connection.ops.quote_name
    with connection.cursor() as cursor:
        constraints = connection.introspection.get_constraints(cursor, TABLE)
        if NEW_NAME in constraints:
            return
        if OLD_NAME in constraints:
            schema_editor.execute(f"ALTER INDEX {qn(OLD_NAME)} RENAME TO {qn(NEW_NAME)}")
            return
        schema_editor.execute(
            f"CREATE INDEX {qn(NEW_NAME)} ON {qn(TABLE)} "
            "(tenant_id, channel_id, role, listening)"
        )


class Migration(migrations.Migration):
    dependencies = [
        ("engine_poc", "0008_channelstate_parrot_radio"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunPython(ensure_index_name, migrations.RunPython.noop)],
            state_operations=[
                migrations.RenameIndex(
                    model_name="channelpresence",
                    new_name=NEW_NAME,
                    old_name=OLD_NAME,
                ),
            ],
        ),
    ]
