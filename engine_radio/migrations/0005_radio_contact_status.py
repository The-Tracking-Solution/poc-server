from django.db import migrations, models
import django.db.models.deletion


def migrate_statuses(apps, schema_editor):
    RadioUser = apps.get_model("engine_radio", "RadioUser")
    # Bestaande contact-/spraakstatus verhuist naar het nieuwe veld. Normale
    # user_status blijft staan; oude previous_status wordt alleen gebruikt als
    # herstelbron wanneer de huidige user_status een contactstatus is.
    for radio in RadioUser.objects.select_related("user_status", "previous_status").iterator():
        current = radio.user_status
        if current and current.call_request_priority is not None:
            radio.user_contact_status_id = current.pk
            previous = radio.previous_status
            radio.user_status_id = previous.pk if previous and previous.call_request_priority is None else None
            radio.save(update_fields=["user_status", "user_contact_status"])


class Migration(migrations.Migration):
    dependencies = [("engine_radio", "0004_screen_hardware_config_unique")]
    operations = [
        migrations.AddField(
            model_name="radiouser",
            name="user_contact_status",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="contact_radio_users", to="engine_poc.userstatus", verbose_name="Gespreksstatus"),
        ),
        migrations.RunPython(migrate_statuses, migrations.RunPython.noop),
        migrations.RemoveField(model_name="radiouser", name="previous_status"),
    ]
