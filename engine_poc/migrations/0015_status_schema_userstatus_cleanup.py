from django.db import migrations, models
import django.db.models.deletion
import engine_main.timeutils
import engine_main.validators


def backfill_display_fields(apps, schema_editor):
    UserStatus = apps.get_model("engine_poc", "UserStatus")
    for status in UserStatus.objects.all().iterator():
        changed = []
        if not status.display_code and status.label_short:
            status.display_code = status.label_short
            changed.append("display_code")
        if not status.display_label and status.label_long:
            status.display_label = status.label_long
            changed.append("display_label")
        if not status.display_status and status.label_long:
            status.display_status = status.label_long
            changed.append("display_status")
        if changed:
            status.save(update_fields=changed)


def create_default_schemas(apps, schema_editor):
    Tenant = apps.get_model("engine_main", "Tenant")
    UserStatus = apps.get_model("engine_poc", "UserStatus")
    StatusSchema = apps.get_model("engine_poc", "StatusSchema")
    now = engine_main.timeutils.now_ms()
    for tenant in Tenant.objects.all().iterator():
        schema, _ = StatusSchema.objects.get_or_create(
            tenant_id=tenant.pk,
            slug="default",
            defaults={
                "name": "Default",
                "created_at_ms": now,
                "last_update_ms": now,
            },
        )
        schema.statuses.set(UserStatus.objects.filter(tenant_id=tenant.pk))


class Migration(migrations.Migration):
    dependencies = [
        ("engine_poc", "0014_normalize_channel_link_groups"),
        ("engine_main", "0001_initial"),
    ]
    operations = [
        migrations.RunPython(backfill_display_fields, migrations.RunPython.noop),
        migrations.RemoveConstraint(
            model_name="userstatus",
            name="engine_poc_userstatus_tenant_system_status_uq",
        ),
        migrations.CreateModel(
            name="StatusSchema",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(max_length=64, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("name", models.CharField(max_length=200, verbose_name="Naam")),
                ("statuses", models.ManyToManyField(blank=True, related_name="status_schemas", to="engine_poc.userstatus", verbose_name="Gebruikersstatussen")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={
                "verbose_name": "Statusschema",
                "verbose_name_plural": "Statusschema's",
                "ordering": ["tenant__name", "name", "slug"],
            },
        ),
        migrations.AddConstraint(
            model_name="statusschema",
            constraint=models.UniqueConstraint(fields=("tenant", "slug"), name="engine_poc_statusschema_tenant_slug_uq"),
        ),
        migrations.RunPython(create_default_schemas, migrations.RunPython.noop),
        migrations.RemoveField(model_name="userstatus", name="label_short"),
        migrations.RemoveField(model_name="userstatus", name="label_long"),
    ]
