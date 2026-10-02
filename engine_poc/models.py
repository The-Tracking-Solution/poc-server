import secrets

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.db.models import Q
from django.contrib.gis.db import models as gis_models

from engine_main.models import Tenant, TenantOwnedModel, TimestampedModel

from .timeutils import now_ms




class UserStatus(TenantOwnedModel):
    class SystemStatus(models.IntegerChoices):
        EMERGENCY = 0, "Noodsignaal"
        OWN_INITIATIVE = 1, "Eigen initiatief"
        SPEECH_REQUEST = 2, "Aanvraag spraak"
        INFORMATION_REQUEST = 3, "Informatievraag"
        EN_ROUTE_TO_INCIDENT = 4, "Aanrijdend naar incident"
        ON_SCENE = 5, "Ter plaatse"
        EN_ROUTE_TO_DESTINATION = 6, "Aanrijdend naar bestemming"
        AVAILABLE_SOON = 7, "Binnenkort beschikbaar"
        AVAILABLE_OFF_STATION = 8, "Beschikbaar, Niet op standplaats"
        AT_STATION = 9, "Op standplaats"
        DELAYED_AVAILABILITY = 10, "Vertraagd inzetbaar"
        OUT_OF_SERVICE = 11, "Buiten dienst"
        IN_SERVICE_SOON = 12, "Binnenkort in dienst"
        PRIVATE_CALL_REQUEST = 13, "Aanvraag privégesprek"
        URGENT_SPEECH_REQUEST = 14, "Aanvraag spraak urgent"
        ASSIGNMENT_GIVEN = 15, "Opdracht verstrekt"
        ALERT_RECEIVED = 16, "Alarmering ontvangen"

    class CallRequestPriority(models.IntegerChoices):
        PRIORITY_1 = 1, "1"
        PRIORITY_2 = 2, "2"
        PRIORITY_3 = 3, "3"
        PRIORITY_4 = 4, "4"
        PRIORITY_5 = 5, "5"
        PRIORITY_6 = 6, "6"

    call_request_priority = models.PositiveSmallIntegerField(
        "Call request priority",
        choices=CallRequestPriority.choices,
        null=True,
        blank=True,
        default=None,
    )
    system_status = models.PositiveSmallIntegerField(
        "Systeemstatus",
        choices=SystemStatus.choices,
        null=True,
        blank=True,
    )
    display_code = models.CharField("Displaycode", max_length=32, blank=True, default="")
    display_status = models.CharField("Displaystatus", max_length=200, blank=True, default="")
    display_label = models.CharField("Displaylabel", max_length=200, blank=True, default="")

    class Meta(TenantOwnedModel.Meta):
        ordering = ["tenant__name", "display_code", "display_label"]
        verbose_name = "Gebruikersstatus"
        verbose_name_plural = "Gebruikersstatussen"
        constraints = TenantOwnedModel.Meta.constraints

    @property
    def selection_label(self):
        """Uniform label voor status-keuzelijsten: technische naam - displaystatus."""
        technical_name = (self.slug or "").strip()
        display_status = (self.display_status or self.display_label or self.get_system_status_display() or self.display_code or "").strip()
        if technical_name and display_status:
            return f"{technical_name} - {display_status}"
        return technical_name or display_status or str(self.pk or "")

    def __str__(self):
        return self.selection_label


class StatusSchema(TenantOwnedModel):
    """Tenant-eigen selectie van gebruikersstatussen voor o.a. Dispatch."""

    name = models.CharField("Naam", max_length=200)
    statuses = models.ManyToManyField(
        UserStatus,
        related_name="status_schemas",
        blank=True,
        verbose_name="Gebruikersstatussen",
    )

    class Meta(TenantOwnedModel.Meta):
        ordering = ["tenant__name", "name", "slug"]
        verbose_name = "Statusschema"
        verbose_name_plural = "Statusschema's"
        constraints = TenantOwnedModel.Meta.constraints

    def __str__(self):
        return f"{self.name} ({self.tenant})"

    def clean(self):
        super().clean()
        if not self.pk:
            return
        invalid = self.statuses.exclude(tenant_id=self.tenant_id)
        if invalid.exists():
            raise ValidationError({
                "statuses": "Alle gebruikersstatussen in het statusschema moeten bij dezelfde tenant horen."
            })


class Channel(TenantOwnedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Actief"
        INACTIVE = "inactive", "Inactief"

    class ChannelType(models.TextChoices):
        GROUP = "group", "Groep"
        ECHO = "echo", "Echo"

    name = models.CharField("Naam", max_length=200)
    status = models.CharField(
        "Status",
        max_length=16,
        choices=Status.choices,
        default=Status.ACTIVE,
    )
    channel_type = models.CharField(
        "Kanaaltype",
        max_length=16,
        choices=ChannelType.choices,
        default=ChannelType.GROUP,
    )
    max_ptt_duration_ms = models.PositiveIntegerField(
        "Maximale PTT-duur (ms)",
        null=True,
        blank=True,
    )
    linked_channels = models.ManyToManyField(
        "self",
        symmetrical=True,
        blank=True,
        verbose_name="Gekoppelde kanalen",
    )

    class Meta(TenantOwnedModel.Meta):
        ordering = ["tenant__name", "name"]
        verbose_name = "Kanaal"
        verbose_name_plural = "Kanalen"

    def __str__(self):
        return f"{self.name} ({self.tenant})"


class DeviceSession(TimestampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Actief"
        REVOKED = "revoked", "Ingetrokken"
        DISCONNECTED = "disconnected", "Verbinding verbroken"
        TIMED_OUT = "timed_out", "Time-out"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, verbose_name="Tenant")
    django_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="device_sessions",
        verbose_name="Ingelogde gebruiker",
    )
    radio_user = models.ForeignKey(
        "engine_radio.RadioUser",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="sessions",
        verbose_name="Radio",
    )
    dispatch_user = models.ForeignKey(
        "engine_dispatch.DispatchUser",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="device_sessions",
        verbose_name="Dispatcher",
    )
    session_token_hash = models.CharField(max_length=256, editable=False)
    device_identifier = models.CharField("Apparaat-ID", max_length=200)
    status = models.CharField("Status", max_length=20, choices=Status.choices, default=Status.ACTIVE)
    current_channel = models.ForeignKey(
        Channel,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        verbose_name="Huidig kanaal",
    )
    connected_at_ms = models.BigIntegerField("Verbonden op (ms)", default=now_ms)
    disconnected_at_ms = models.BigIntegerField("Verbroken op (ms)", null=True, blank=True)
    last_seen_at_ms = models.BigIntegerField("Laatst gezien (ms)", default=now_ms)
    last_heartbeat_at_ms = models.BigIntegerField("Laatste heartbeat (ms)", null=True, blank=True)
    last_roundtrip_ms = models.PositiveIntegerField("Laatste roundtrip (ms)", null=True, blank=True)
    average_roundtrip_ms = models.FloatField("Gemiddelde roundtrip (ms)", null=True, blank=True)
    heartbeat_samples = models.PositiveIntegerField("Heartbeatmetingen", default=0)
    missed_heartbeats = models.PositiveIntegerField("Gemiste heartbeats", default=0)
    telemetry = models.JSONField(
        "Laatste heartbeattelemetrie", default=dict, blank=True,
        help_text="Geaggregeerde metingen ontvangen sinds de vorige heartbeat.",
    )

    class Meta:
        ordering = ["-connected_at_ms"]
        verbose_name = "Apparaatsessie"
        verbose_name_plural = "Apparaatsessies"
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(radio_user__isnull=False, dispatch_user__isnull=True)
                    | Q(radio_user__isnull=True, dispatch_user__isnull=False)
                ),
                name="device_session_exactly_one_actor",
            ),
            models.UniqueConstraint(
                fields=["radio_user"],
                condition=Q(status="active", radio_user__isnull=False),
                name="one_active_session_per_radio_user",
            ),
            models.UniqueConstraint(
                fields=["dispatch_user"],
                condition=Q(status="active", dispatch_user__isnull=False),
                name="one_active_device_session_per_dispatch_user",
            ),
        ]

    @property
    def actor(self):
        return self.radio_user or self.dispatch_user

    @property
    def actor_slug(self):
        return self.actor.slug

    @property
    def actor_name(self):
        return self.actor.display_name

    @property
    def user_profile(self):
        return self.actor.user_profile

    @property
    def role(self):
        return "radio" if self.radio_user_id else "dispatch"

    def __str__(self):
        return f"{self.actor_name} – {self.device_identifier}"

    def issue_token(self) -> str:
        raw = secrets.token_urlsafe(48)
        self.session_token_hash = make_password(raw)
        return raw

    def verify_token(self, raw: str) -> bool:
        return check_password(raw, self.session_token_hash)


class ChannelState(TimestampedModel):
    class FloorStatus(models.TextChoices):
        IDLE = "idle", "Vrij"
        ACTIVE = "active", "Actief"
        PREEMPTION_PENDING = "preemption_pending", "Overname in afwachting"
        EMERGENCY = "emergency", "Noodoproep"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, verbose_name="Tenant")
    channel = models.OneToOneField(
        Channel,
        on_delete=models.CASCADE,
        related_name="state",
        verbose_name="Kanaal",
    )
    floor_status = models.CharField(
        "Floorstatus",
        max_length=32,
        choices=FloorStatus.choices,
        default=FloorStatus.IDLE,
    )
    active_session = models.ForeignKey(
        DeviceSession,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="active_floors",
        verbose_name="Actieve sessie",
    )
    active_user_slug = models.CharField("Actieve gebruiker (slug)", max_length=64, blank=True, default="")
    active_user_name = models.CharField("Actieve gebruiker", max_length=200, blank=True, default="")
    active_priority = models.PositiveSmallIntegerField("Actieve prioriteit", null=True, blank=True)
    active_event_sequence = models.PositiveBigIntegerField("Actieve eventreeks", null=True, blank=True, db_index=True)
    floor_token_hash = models.CharField(max_length=256, blank=True, default="")
    granted_at_ms = models.BigIntegerField("Toegekend op (ms)", null=True, blank=True)
    parrot_active = models.BooleanField("Papegaai actief", default=False)
    parrot_owner_session = models.ForeignKey(
        DeviceSession, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="parrot_floors", verbose_name="Papegaai bron-sessie",
    )
    parrot_started_at_ms = models.BigIntegerField("Papegaai gestart op (ms)", null=True, blank=True)
    pending_session = models.ForeignKey(
        DeviceSession,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="pending_floors",
        verbose_name="Wachtende sessie",
    )
    pending_user_slug = models.CharField("Wachtende gebruiker (slug)", max_length=64, blank=True, default="")
    pending_user_name = models.CharField("Wachtende gebruiker", max_length=200, blank=True, default="")
    pending_priority = models.PositiveSmallIntegerField("Wachtende prioriteit", null=True, blank=True)
    pending_since_ms = models.BigIntegerField("Wacht sinds (ms)", null=True, blank=True)
    emergency_users = models.ManyToManyField(
        "engine_radio.RadioUser",
        blank=True,
        related_name="emergency_channel_states",
        verbose_name="Radio's met noodoproep",
    )

    class Meta:
        ordering = ["tenant__name", "channel__name"]
        verbose_name = "Kanaalstatus"
        verbose_name_plural = "Kanaalstatussen"
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "channel"],
                name="channel_state_tenant_channel_uq",
            )
        ]

    def __str__(self):
        return f"{self.channel} – {self.get_floor_status_display()}"


class FloorWaiter(TimestampedModel):
    """Een ingedrukte PTT die wacht op de spreekvloer van een kanaal.

    De server bewaart de wachtrij expliciet zodat een gebruiker PTT kan blijven
    vasthouden terwijl een andere zender actief is. Hogere ``priority`` komt
    eerst; bij gelijke prioriteit geldt FIFO via ``requested_at_ms``.
    """

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="floor_waiters")
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name="floor_waiters")
    session = models.ForeignKey(DeviceSession, on_delete=models.CASCADE, related_name="floor_waiters")
    priority = models.PositiveSmallIntegerField("PTT-prioriteit")
    emergency = models.BooleanField("Noodaanvraag", default=False)
    requested_at_ms = models.BigIntegerField("Wacht sinds (ms)", default=now_ms)
    last_request_at_ms = models.BigIntegerField("Laatste PTT-aanvraag (ms)", default=now_ms)

    class Meta:
        ordering = ["-priority", "requested_at_ms", "pk"]
        verbose_name = "PTT-wachtende"
        verbose_name_plural = "PTT-wachtrij"
        constraints = [
            models.UniqueConstraint(
                fields=["channel", "session"],
                name="engine_poc_floorwaiter_channel_session_uq",
            )
        ]
        indexes = [
            models.Index(
                fields=["tenant", "channel", "priority", "requested_at_ms"],
                name="engine_poc_floorwait_q_idx",
            )
        ]

    def __str__(self):
        return f"{self.channel} – {self.session.actor_name} ({self.priority})"


class CallRequest(TimestampedModel):
    class Priority(models.IntegerChoices):
        PRIORITY_1 = 1, "1"
        PRIORITY_2 = 2, "2"
        PRIORITY_3 = 3, "3"
        PRIORITY_4 = 4, "4"
        PRIORITY_5 = 5, "5"
        PRIORITY_6 = 6, "6"

    class Status(models.TextChoices):
        ACTIVE = "active", "Actief"
        CLEARED = "cleared", "Beëindigd"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="call_requests")
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name="call_requests")
    radio_user = models.ForeignKey("engine_radio.RadioUser", on_delete=models.CASCADE, related_name="call_requests")
    priority = models.PositiveSmallIntegerField(choices=Priority.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    activated_at_ms = models.BigIntegerField(default=now_ms)
    cleared_at_ms = models.BigIntegerField(null=True, blank=True)
    accepted_at_ms = models.BigIntegerField(null=True, blank=True)
    clear_reason = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["-activated_at_ms"]
        verbose_name = "Call request"
        verbose_name_plural = "Call requests"
        constraints = [
            models.UniqueConstraint(
                fields=["radio_user"],
                condition=Q(status="active"),
                name="engine_poc_callrequest_one_active_per_radio_uq",
            )
        ]

    def __str__(self):
        return f"Prioriteit {self.priority} – {self.radio_user.display_name}"

    def clear(self, reason="manual"):
        if self.status != self.Status.ACTIVE:
            return
        self.status = self.Status.CLEARED
        self.cleared_at_ms = now_ms()
        self.clear_reason = reason
        self.save(update_fields=["status", "cleared_at_ms", "clear_reason", "last_update_ms"])


class ChannelPresence(TimestampedModel):
    class Role(models.TextChoices):
        RADIO = "radio", "Radio"
        DISPATCH = "dispatch", "Dispatcher"

    connection_id = models.CharField(max_length=255, unique=True)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="channel_presences")
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name="channel_presences")
    session = models.ForeignKey(DeviceSession, on_delete=models.CASCADE, related_name="channel_presences")
    role = models.CharField(max_length=16, choices=Role.choices)
    listening = models.BooleanField(default=True)

    class Meta:
        indexes = [models.Index(fields=["tenant", "channel", "role", "listening"])]


class EventLog(TimestampedModel):
    tenant = models.ForeignKey(Tenant, on_delete=models.PROTECT, related_name="events", verbose_name="Tenant")
    sequence_number = models.BigAutoField("Volgnummer", primary_key=True)
    timestamp_ms = models.BigIntegerField("Tijdstip (ms)", default=now_ms, db_index=True)
    client_request_id = models.CharField("Client-request-ID", max_length=200, null=True, blank=True)
    tenant_slug_snapshot = models.CharField("Tenant-slug", max_length=64)
    tenant_name_snapshot = models.CharField("Tenantnaam", max_length=200)
    actor_slug = models.CharField("Actor-slug", max_length=64, blank=True, default="SYSTEM")
    actor_name = models.CharField("Actor", max_length=200, blank=True, default="System")
    subject_slug = models.CharField("Onderwerp-slug", max_length=64, blank=True, default="")
    subject_name = models.CharField("Onderwerp", max_length=200, blank=True, default="")
    channel_slug = models.CharField("Kanaal-slug", max_length=64, blank=True, default="", db_index=True)
    channel_name = models.CharField("Kanaal", max_length=200, blank=True, default="")
    action_type = models.CharField("Actietype", max_length=64, db_index=True)
    entity_type = models.CharField("Entiteittype", max_length=64, blank=True, default="")
    entity_slug = models.CharField("Entiteit-slug", max_length=64, blank=True, default="")
    entity_name = models.CharField("Entiteit", max_length=200, blank=True, default="")
    message = models.TextField("Bericht", blank=True, default="")
    value = models.CharField("Waarde", max_length=200, blank=True, default="")
    ptt_priority = models.PositiveSmallIntegerField("PTT-prioriteit", null=True, blank=True)
    location = gis_models.PointField(
        "Locatie", srid=4326, null=True, blank=True,
        help_text="Gemeten locatie behorend bij dit event. Voor locatie-events wordt iedere geldige meting bewaard, ongeacht accuracy.",
    )
    location_accuracy_m = models.FloatField("Locatie-accuracy (m)", null=True, blank=True)
    location_timestamp_ms = models.BigIntegerField("Locatie meettijdstip (ms)", null=True, blank=True)
    metadata = models.JSONField("Metadata", default=dict, blank=True)

    class Meta:
        ordering = ["-sequence_number"]
        verbose_name = "Eventlogregel"
        verbose_name_plural = "Eventlog"
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "client_request_id"],
                condition=Q(client_request_id__isnull=False),
                name="event_client_request_tenant_uq",
            )
        ]

    def __str__(self):
        return f"#{self.sequence_number} – {self.action_type}"

    def save(self, *args, **kwargs):
        if self.pk and EventLog.objects.filter(pk=self.pk).exists():
            raise ValueError("EventLog is immutable.")
        super().save(*args, **kwargs)


class EventAttachment(TimestampedModel):
    class AttachmentType(models.TextChoices):
        AUDIO = "audio", "Audio"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, verbose_name="Tenant")
    event = models.ForeignKey(
        EventLog,
        on_delete=models.CASCADE,
        related_name="attachments",
        verbose_name="Event",
    )
    attachment_type = models.CharField(
        "Bijlagetype",
        max_length=16,
        choices=AttachmentType.choices,
        default=AttachmentType.AUDIO,
    )
    file = models.FileField("Bestand", upload_to="poc/audio/%Y/%m/%d/")
    original_filename = models.CharField("Oorspronkelijke bestandsnaam", max_length=255)
    mime_type = models.CharField("MIME-type", max_length=100)
    file_size = models.PositiveBigIntegerField("Bestandsgrootte (bytes)")
    duration_ms = models.PositiveIntegerField("Duur (ms)", null=True, blank=True)
    checksum = models.CharField("Checksum", max_length=64)

    class Meta:
        ordering = ["-created_at_ms"]
        verbose_name = "Eventbijlage"
        verbose_name_plural = "Eventbijlagen"

    def __str__(self):
        return self.original_filename
