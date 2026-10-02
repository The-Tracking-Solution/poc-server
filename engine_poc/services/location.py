from django.contrib.gis.geos import Point
from django.db import transaction
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from engine_poc.control_protocol import map_location_group_name

from engine_poc.services.events import create_event
from engine_poc.timeutils import now_ms

LOCATION_ACCURACY_LIMIT_M = 25.0
DEFAULT_LOCATION_INTERVAL_SECONDS = 15


def location_config(radio):
    seconds = int(getattr(radio, "location_interval_seconds", 0) or 0) if radio is not None else 0
    return {
        "enabled": seconds > 0,
        "interval_ms": seconds * 1000,
        "accuracy_limit_m": LOCATION_ACCURACY_LIMIT_M,
    }


def process_location_sample(*, session, latitude: float, longitude: float, accuracy_m: float, timestamp_ms=None, source: str = "interval"):

    """Persist every valid location sample in EventLog.

    RadioUser.last_location is only updated for accurate (<25 m) samples.
    The measured timestamp is preserved separately from server receive time.
    """
    if not session.radio_user_id:
        raise ValueError("Locatie-updates zijn alleen beschikbaar voor radiosessies.")

    radio = session.radio_user
    if int(radio.location_interval_seconds or 0) <= 0:
        raise PermissionError("Locatie is niet ingeschakeld voor deze radio.")

    measured_at_ms = int(timestamp_ms or now_ms())
    received_at_ms = now_ms()
    accuracy = float(accuracy_m)
    point = Point(float(longitude), float(latitude), srid=4326)

    with transaction.atomic():
        event = create_event(
            tenant=session.tenant,
            action_type="location_update",
            actor_slug=radio.slug,
            actor_name=radio.display_name,
            subject_slug=radio.slug,
            subject_name=radio.display_name,
            entity_type="radio_user",
            entity_slug=radio.slug,
            entity_name=radio.display_name,
            channel_slug=radio.current_channel.slug if radio.current_channel_id else "",
            channel_name=radio.current_channel.name if radio.current_channel_id else "",
            message="Locatie ontvangen",
            value=f"accuracy={accuracy:.1f}m",
            location=point,
            location_accuracy_m=accuracy,
            location_timestamp_ms=measured_at_ms,
            metadata={
                "latitude": float(latitude),
                "longitude": float(longitude),
                "accuracy_m": accuracy,
                "measured_at_ms": measured_at_ms,
                "received_at_ms": received_at_ms,
                "radio_location_updated": accuracy < LOCATION_ACCURACY_LIMIT_M,
                "source": str(source or "interval"),
            },
        )

        radio_updated = False
        if accuracy < LOCATION_ACCURACY_LIMIT_M:
            # Een oude GPS-fix mag een nieuwere betrouwbare positie niet overschrijven.
            if radio.last_location_at_ms is None or measured_at_ms >= radio.last_location_at_ms:
                radio.last_location = point
                radio.last_location_accuracy_m = accuracy
                radio.last_location_at_ms = measured_at_ms
                radio.save(update_fields=[
                    "last_location", "last_location_accuracy_m", "last_location_at_ms", "last_update_ms",
                ])
                radio_updated = True

        if radio_updated:
            payload = {
                "type": "radio_location",
                "radio_id": str(radio.pk),
                "latitude": point.y,
                "longitude": point.x,
                "accuracy_m": accuracy,
                "timestamp_ms": measured_at_ms,
                "source": str(source or "interval"),
            }
            def publish():
                channel_layer = get_channel_layer()
                if channel_layer is not None:
                    async_to_sync(channel_layer.group_send)(
                        map_location_group_name(session.tenant_id),
                        {"type": "map_location", "payload": payload},
                    )
            transaction.on_commit(publish)

    return {
        "timestamp_ms": received_at_ms,
        "measured_at_ms": measured_at_ms,
        "accuracy_m": accuracy,
        "radio_location_updated": radio_updated,
        "event_sequence": event.sequence_number,
    }
