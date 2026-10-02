import uuid
from django.conf import settings
from django.db import models

from .timeutils import now_ms
from .validators import validate_engine_slug


class TimestampedModel(models.Model):
    created_at_ms = models.BigIntegerField(default=now_ms, editable=False, verbose_name="Aangemaakt op (ms)")
    last_update_ms = models.BigIntegerField(default=now_ms, verbose_name="Laatst bijgewerkt (ms)")

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        self.last_update_ms = now_ms()
        super().save(*args, **kwargs)


def tenant_logo_upload_to(instance, filename):
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    return f"poc/tenants/{instance.slug}/logo.{extension}"


class TenantOwnedModel(TimestampedModel):
    tenant = models.ForeignKey("engine_main.Tenant", on_delete=models.CASCADE, verbose_name="Tenant")
    slug = models.CharField(
        "Technische naam",
        max_length=64,
        validators=[validate_engine_slug],
    )

    class Meta:
        abstract = True
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"],
                name="%(app_label)s_%(class)s_tenant_slug_uq",
            )
        ]


class Tenant(TimestampedModel):
    class TxPermissionMode(models.TextChoices):
        PROACTIVE = "proactive", "Proactief"
        CONSERVATIVE = "conservative", "Conservatief"

    slug = models.CharField(
        "Technische naam",
        max_length=64,
        unique=True,
        validators=[validate_engine_slug],
        help_text="Unieke naam voor API's en interne verwijzingen.",
    )
    name = models.CharField("Naam", max_length=200)
    logo = models.ImageField("Logo", upload_to=tenant_logo_upload_to, null=True, blank=True)
    preemption_hold_ms = models.PositiveIntegerField(
        "Overnametijd (ms)",
        default=3000,
        help_text=(
            "Totale PTT-holdtijd voordat een hogere normale prioriteit een lagere actieve TX mag overnemen. "
            "Standaard 3000 ms: maximaal 1 seconde bezet-buzz plus 2 seconden extra vasthouden. "
            "Prioriteiten 91 t/m 99 preëmpten een lagere TX direct."
        ),
    )
    urgent_priority = models.PositiveSmallIntegerField("Spoedprioriteit", default=50)
    emergency_priority = models.PositiveSmallIntegerField("Noodprioriteit", default=99)
    heartbeat_interval_ms = models.PositiveIntegerField("Heartbeat-interval (ms)", default=5000)
    heartbeat_timeout_ms = models.PositiveIntegerField("Heartbeat-time-out (ms)", default=15000)
    default_max_ptt_duration_ms = models.PositiveIntegerField(
        "Standaard maximale PTT-duur (ms)", null=True, blank=True, default=60000
    )
    tx_permission_mode = models.CharField(
        "TX-toestemmingsmodus",
        max_length=16,
        choices=TxPermissionMode.choices,
        default=TxPermissionMode.CONSERVATIVE,
        help_text=(
            "Proactief start lokale WebRTC-TX direct en laat de server parallel controleren; "
            "Conservatief start TX pas na expliciete floor-toekenning."
        ),
    )

    class Meta:
        ordering = ["name"]
        verbose_name = "Tenant"
        verbose_name_plural = "Tenants"

    def __str__(self):
        return self.name


class HardwareAutoLogin(TimestampedModel):
    """Persistente identiteit van een Android-radio voor hardware auto-login.

    ``device_uuid`` is de publieke/operationele identiteit van het toestel en
    blijft server-side altijd gelijk. ``android_id`` wordt uitsluitend gebruikt
    om hetzelfde fysieke toestel na een reinstall opnieuw aan het bestaande
    record te koppelen.
    """

    # Legacy veld behouden voor backwards compatibility met bestaande clients.
    # Voor nieuwe devices bevat dit dezelfde UUID-string als ``device_uuid``.
    hardware_id = models.CharField(
        "Hardware ID (legacy)",
        max_length=255,
        unique=True,
        help_text="Legacy hardware-ID. Nieuwe Android-clients gebruiken device_uuid.",
    )
    device_uuid = models.UUIDField(
        "Device UUID",
        default=uuid.uuid4,
        unique=True,
        editable=False,
        help_text="Stabiele UUID4 waarmee dit device binnen TTS wordt geïdentificeerd.",
    )
    android_id = models.CharField(
        "Android ID",
        max_length=255,
        blank=True,
        db_index=True,
        help_text="Herstelkenmerk om dit device na een reinstall terug te vinden.",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="hardware_auto_logins",
        verbose_name="Gebruiker",
        null=True,
        blank=True,
        help_text="Leeg zolang een nieuw device nog niet is gekoppeld.",
    )
    name = models.CharField(
        "Naam / omschrijving",
        max_length=200,
        blank=True,
        help_text="Optionele herkenbare naam, bijvoorbeeld 'Samsung balie'.",
    )
    enabled = models.BooleanField("Auto-login actief", default=True)
    last_login_at_ms = models.BigIntegerField("Laatste auto-login (ms)", null=True, blank=True, editable=False)

    class Meta:
        ordering = ["name", "hardware_id"]
        verbose_name = "Hardware auto-login"
        verbose_name_plural = "Hardware auto-logins"

    @staticmethod
    def normalize_hardware_id(value):
        return str(value or "").strip().lower()

    @classmethod
    def short_code_for_hardware_id(cls, value):
        """Menselijk herkenbare code: eerste 4 + laatste 4 tekens van de hardware-id."""
        normalized = cls.normalize_hardware_id(value)
        if not normalized:
            return ""
        if len(normalized) <= 8:
            return normalized
        return f"{normalized[:4]}-{normalized[-4:]}"

    @property
    def short_code(self):
        # UUID zonder streepjes gebruiken voor een rustige 4-4 weergave.
        value = self.device_uuid.hex if self.device_uuid else self.hardware_id
        return self.short_code_for_hardware_id(value)

    @staticmethod
    def normalize_android_id(value):
        return str(value or "").strip().lower()

    def save(self, *args, **kwargs):
        if not self.device_uuid:
            self.device_uuid = uuid.uuid4()
        if not self.hardware_id:
            self.hardware_id = str(self.device_uuid)
        self.hardware_id = self.normalize_hardware_id(self.hardware_id)
        self.android_id = self.normalize_android_id(self.android_id)
        super().save(*args, **kwargs)

    def __str__(self):
        label = self.name or self.short_code or self.hardware_id
        target = self.user if self.user_id else "niet gekoppeld"
        return f"{label} → {target}"
