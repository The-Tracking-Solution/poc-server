from django.db import migrations, models
import django.db.models.deletion


def attach_default_status_schema(apps, schema_editor):
    StatusSchema = apps.get_model("engine_poc", "StatusSchema")
    DispatchProfile = apps.get_model("engine_dispatch", "DispatchProfile")
    for profile in DispatchProfile.objects.filter(status_schema__isnull=True).iterator():
        schema = StatusSchema.objects.filter(tenant_id=profile.tenant_id, slug="default").first()
        if schema is None:
            schema = StatusSchema.objects.create(
                tenant_id=profile.tenant_id,
                slug="default",
                name="Default",
            )
        profile.status_schema_id = schema.pk
        profile.save(update_fields=["status_schema"])


class Migration(migrations.Migration):
    dependencies = [
        ("engine_dispatch", "0003_dispatch_buttons"),
        ("engine_poc", "0015_status_schema_userstatus_cleanup"),
    ]
    operations = [
        migrations.AddField(
            model_name="dispatchprofile",
            name="status_schema",
            field=models.ForeignKey(null=True, on_delete=django.db.models.deletion.PROTECT, related_name="dispatch_profiles", to="engine_poc.statusschema", verbose_name="Statusschema"),
        ),
        migrations.RunPython(attach_default_status_schema, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="dispatchprofile",
            name="status_schema",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="dispatch_profiles", to="engine_poc.statusschema", verbose_name="Statusschema"),
        ),
    ]
