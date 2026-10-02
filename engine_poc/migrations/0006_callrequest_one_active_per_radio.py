from django.db import migrations, models
from django.db.models import Q


def collapse_active_requests(apps, schema_editor):
    CallRequest = apps.get_model("engine_poc", "CallRequest")
    radio_ids = (
        CallRequest.objects.filter(status="active")
        .values_list("radio_user_id", flat=True)
        .distinct()
    )
    for radio_id in radio_ids:
        requests = list(
            CallRequest.objects.filter(radio_user_id=radio_id, status="active")
            .order_by("activated_at_ms", "pk")
        )
        if len(requests) <= 1:
            continue

        oldest = requests[0]
        # De oudste request/timestamp blijft leidend. Als een nieuwere request
        # een gewijzigde prioriteit/kanaal bevat, nemen we die actuele inhoud
        # over zonder activated_at_ms te wijzigen.
        newest = requests[-1]
        oldest.priority = newest.priority
        oldest.channel_id = newest.channel_id
        oldest.tenant_id = newest.tenant_id
        oldest.accepted_at_ms = None
        oldest.cleared_at_ms = None
        oldest.clear_reason = ""
        oldest.save(
            update_fields=[
                "priority",
                "channel",
                "tenant",
                "accepted_at_ms",
                "cleared_at_ms",
                "clear_reason",
                "last_update_ms",
            ]
        )

        CallRequest.objects.filter(pk__in=[request.pk for request in requests[1:]]).update(
            status="cleared",
            clear_reason="duplicate_active_request",
        )


class Migration(migrations.Migration):

    # Data cleanup updates CallRequest rows before PostgreSQL creates the
    # conditional unique index. Keeping the whole migration in one atomic
    # transaction can leave pending trigger events and make CREATE INDEX fail.
    atomic = False

    dependencies = [
        ("engine_poc", "0005_devicesession_django_user"),
    ]

    operations = [
        migrations.RunPython(collapse_active_requests, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="callrequest",
            constraint=models.UniqueConstraint(
                fields=("radio_user",),
                condition=Q(status="active"),
                name="engine_poc_callrequest_one_active_per_radio_uq",
            ),
        ),
    ]
