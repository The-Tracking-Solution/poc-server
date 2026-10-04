import logging

from django.contrib.admin.views.decorators import staff_member_required
from django.http import JsonResponse
from django.db.models import Case, F, IntegerField, Value, When
from django.shortcuts import render
from django.utils import timezone

from engine_poc.models import DeviceSession

logger = logging.getLogger(__name__)


@staff_member_required
def radio_diagnostics(request):
    return render(request, "engine_poc/radio_diagnostics.html")


@staff_member_required
def radio_diagnostics_data(request):
    now_ms = int(timezone.now().timestamp() * 1000)

    try:
        rows = (
            DeviceSession.objects
            .filter(radio_user__isnull=False, radio_user__debug=True)
            .annotate(
                diagnostics_active=Case(
                    When(status=DeviceSession.Status.ACTIVE, then=Value(1)),
                    default=Value(0),
                    output_field=IntegerField(),
                ),
            )
            .values(
                "id",
                "tenant_id",
                "tenant__slug",
                "radio_user_id",
                "radio_user__slug",
                "radio_user__external_name",
                "device_identifier",
                "status",
                "current_channel__name",
                "current_channel__channel_type",
                "last_heartbeat_at_ms",
                "heartbeat_samples",
                "last_roundtrip_ms",
                "average_roundtrip_ms",
                "telemetry",
            )
            .order_by(
                "tenant__slug",
                "radio_user__external_name",
                "-diagnostics_active",
                F("last_heartbeat_at_ms").desc(nulls_last=True),
                "-id",
            )
        )

        # Eén kaart per radio: actieve sessies eerst, daarna nieuwste heartbeat.
        # PostgreSQL sorteert NULL anders vooraan bij aflopende tijdstippen.
        latest = {}
        for row in rows:
            key = (row["tenant_id"], row["radio_user_id"])
            if key in latest:
                continue

            telemetry = row.get("telemetry")
            if not isinstance(telemetry, dict):
                telemetry = {}

            latest[key] = {
                "id": row["id"],
                "tenant": row.get("tenant__slug") or "",
                "radio": row.get("radio_user__external_name") or "",
                "radio_slug": row.get("radio_user__slug") or "",
                "device_identifier": row.get("device_identifier") or "",
                "status": row.get("status") or "",
                "channel": row.get("current_channel__name"),
                "channel_type": row.get("current_channel__channel_type"),
                "last_heartbeat_at_ms": row.get("last_heartbeat_at_ms"),
                "server_now_ms": now_ms,
                "heartbeat_samples": row.get("heartbeat_samples") or 0,
                "roundtrip_ms": row.get("last_roundtrip_ms"),
                "average_roundtrip_ms": row.get("average_roundtrip_ms"),
                "telemetry": telemetry,
            }

        return JsonResponse({
            "generated_at_ms": now_ms,
            "sessions": list(latest.values()),
        })

    except Exception as error:
        # Log de echte traceback in docker logs én geef een leesbare fout terug.
        logger.exception("Radio diagnostics data kon niet worden opgebouwd.")
        return JsonResponse({
            "generated_at_ms": now_ms,
            "sessions": [],
            "error": {
                "type": error.__class__.__name__,
                "message": str(error),
            },
        }, status=200)
