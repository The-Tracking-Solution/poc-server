from django.db import migrations


def repair_status_schema_ids(apps, schema_editor):
    """
    Een oudere versie van engine_dispatch.0004 kon status_schema_id laten
    verwijzen naar dispatch_status_schemas. De actuele modelrelatie wijst naar
    engine_poc_statusschema.

    Koppel bestaande profielen daarom eerst aan het Default-schema van hun
    eigen tenant. Daarna kan de database-FK veilig naar de POC-tabel wijzen.
    """
    DispatchProfile = apps.get_model("engine_dispatch", "DispatchProfile")
    StatusSchema = apps.get_model("engine_poc", "StatusSchema")

    for profile in DispatchProfile.objects.all().iterator():
        schema = (
            StatusSchema.objects
            .filter(tenant_id=profile.tenant_id, slug="default")
            .first()
        )
        if schema is None:
            # 0015 hoort dit schema al te hebben aangemaakt. Dit is alleen een
            # defensieve fallback voor databases met een afwijkende historie.
            schema = StatusSchema.objects.create(
                tenant_id=profile.tenant_id,
                slug="default",
                name="Default",
            )
        if profile.status_schema_id != schema.pk:
            DispatchProfile.objects.filter(pk=profile.pk).update(
                status_schema_id=schema.pk
            )


DROP_OLD_STATUS_SCHEMA_FKS = r"""
DO $$
DECLARE
    constraint_name text;
BEGIN
    FOR constraint_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'f'
          AND t.relname = 'dispatch_profiles'
          AND EXISTS (
              SELECT 1
              FROM unnest(c.conkey) AS k(attnum)
              JOIN pg_attribute a
                ON a.attrelid = t.oid
               AND a.attnum = k.attnum
              WHERE a.attname = 'status_schema_id'
          )
    LOOP
        EXECUTE format(
            'ALTER TABLE dispatch_profiles DROP CONSTRAINT %I',
            constraint_name
        );
    END LOOP;
END $$;
"""

ADD_POC_STATUS_SCHEMA_FK = r"""
ALTER TABLE dispatch_profiles
ADD CONSTRAINT dispatch_profiles_status_schema_id_poc_fk
FOREIGN KEY (status_schema_id)
REFERENCES engine_poc_statusschema(id)
DEFERRABLE INITIALLY DEFERRED;
"""


class Migration(migrations.Migration):

    dependencies = [
        ("engine_dispatch", "0004_status_schema"),
        ("engine_poc", "0015_status_schema_userstatus_cleanup"),
    ]

    operations = [
        # Eerst de oude/verkeerde FK weghalen, zodat de status_schema_id's naar
        # engine_poc_statusschema kunnen worden omgezet.
        migrations.RunSQL(
            sql=DROP_OLD_STATUS_SCHEMA_FKS,
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunPython(
            repair_status_schema_ids,
            migrations.RunPython.noop,
        ),
        migrations.RunSQL(
            sql=ADD_POC_STATUS_SCHEMA_FK,
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
