from django.conf import settings
from django.db import models
from django.db.models import Q
from django.core.exceptions import ValidationError

from engine_main.models import TenantOwnedModel, TimestampedModel
from engine_main.timeutils import now_ms
from engine_radio.models import UserProfile



class DispatchConfig(TimestampedModel):
    """Generieke dispatch-instellingen per tenant."""

    tenant = models.OneToOneField(
        "engine_main.Tenant",
        on_delete=models.CASCADE,
        related_name="dispatch_config",
        verbose_name="Tenant",
    )
    radio_settings = models.JSONField("Radio-instellingen", default=dict, blank=True)
    buttons = models.JSONField(
        "Buttons", default=dict, blank=True,
        help_text="Centrale knopdefinities: radio (R1-R5) en sidebar (SB).",
    )

    class Meta:
        db_table = "dispatch_config"
        verbose_name = "Dispatch config"
        verbose_name_plural = "Dispatch configs"

    def __str__(self):
        return f"Dispatch config – {self.tenant}"


class DispatchProfile(TimestampedModel):
    """Tussenlaag met overrides op DispatchConfig."""

    tenant = models.ForeignKey(
        "engine_main.Tenant",
        on_delete=models.CASCADE,
        related_name="dispatch_profiles",
        verbose_name="Tenant",
    )
    dispatch_config = models.ForeignKey(
        DispatchConfig,
        on_delete=models.CASCADE,
        related_name="profiles",
        verbose_name="Dispatch config",
    )
    name = models.CharField("Naam", max_length=200, default="Default")
    status_schema = models.ForeignKey(
        "engine_poc.StatusSchema",
        on_delete=models.PROTECT,
        related_name="dispatch_profiles",
        verbose_name="Statusschema",
    )
    radio_settings = models.JSONField("Radio-instellingen", default=dict, blank=True)
    buttons = models.JSONField(
        "Buttons aan/uit", default=dict, blank=True,
        help_text="Alleen overrides per button-id: true/false.",
    )

    class Meta:
        db_table = "dispatch_profiles"
        ordering = ["tenant__name", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"],
                name="dispatch_profiles_tenant_name_uq",
            )
        ]
        verbose_name = "Dispatch profiel"
        verbose_name_plural = "Dispatch profielen"

    def __str__(self):
        return f"{self.name} ({self.tenant})"

    def clean(self):
        super().clean()
        if self.status_schema_id and self.status_schema.tenant_id != self.tenant_id:
            raise ValidationError({
                "status_schema": "Het statusschema moet bij dezelfde tenant horen als het Dispatch-profiel."
            })
        if self.buttons and (
            not isinstance(self.buttons, dict)
            or any(not isinstance(value, bool) for value in self.buttons.values())
        ):
            raise ValidationError({"buttons": "Profiles mogen buttons alleen met true/false aan- of uitzetten."})


class DispatchUserSettings(TimestampedModel):
    """Gedetailleerde overrides voor één dispatcher."""

    tenant = models.ForeignKey(
        "engine_main.Tenant",
        on_delete=models.CASCADE,
        related_name="dispatch_user_settings",
        verbose_name="Tenant",
    )
    dispatch_user = models.OneToOneField(
        "DispatchUser",
        on_delete=models.CASCADE,
        related_name="dispatch_settings",
        verbose_name="Dispatcher",
    )
    dispatch_profile = models.ForeignKey(
        DispatchProfile,
        on_delete=models.PROTECT,
        related_name="user_settings",
        verbose_name="Dispatch profiel",
    )
    radio_settings = models.JSONField("Radio-instellingen", default=dict, blank=True)
    buttons = models.JSONField(
        "Buttons aan/uit", default=dict, blank=True,
        help_text="Alleen overrides per button-id: true/false.",
    )

    class Meta:
        db_table = "dispatch_usersettings"
        verbose_name = "Dispatch gebruikersinstellingen"
        verbose_name_plural = "Dispatch gebruikersinstellingen"

    def __str__(self):
        return f"{self.dispatch_user.display_name} – instellingen"

    def clean(self):
        super().clean()
        if self.buttons and (
            not isinstance(self.buttons, dict)
            or any(not isinstance(value, bool) for value in self.buttons.values())
        ):
            raise ValidationError({"buttons": "User settings mogen buttons alleen met true/false aan- of uitzetten."})


class DispatchUser(TenantOwnedModel):
    class DeviceStatus(models.TextChoices):
        OFFLINE = "offline", "Offline"
        ONLINE = "online", "Online"

    django_users = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="dispatch_users",
        verbose_name="Django-gebruikers",
    )
    secret_key_hash = models.CharField(max_length=256, editable=False)
    internal_name = models.CharField("Interne naam", max_length=200)
    external_name = models.CharField("Weergavenaam", max_length=200)
    device_status = models.CharField(
        "Apparaatstatus",
        max_length=16,
        choices=DeviceStatus.choices,
        default=DeviceStatus.OFFLINE,
    )
    user_profile = models.ForeignKey(
        UserProfile,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="dispatch_users",
        verbose_name="Gebruikersprofiel",
    )
    dispatch_profile = models.ForeignKey(
        DispatchProfile,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="dispatch_users",
        verbose_name="Dispatchprofiel",
    )

    class Meta(TenantOwnedModel.Meta):
        ordering = ["tenant__name", "external_name"]
        verbose_name = "Dispatch"
        verbose_name_plural = "Dispatchers"
        constraints = TenantOwnedModel.Meta.constraints

    def __str__(self):
        return f"{self.display_name} ({self.tenant})"

    def clean(self):
        super().clean()
        if self.user_profile_id and self.user_profile.tenant_id != self.tenant_id:
            from django.core.exceptions import ValidationError
            raise ValidationError({
                "user_profile": "Het gekoppelde gebruikersprofiel moet bij dezelfde tenant horen."
            })

    @property
    def display_name(self):
        return self.external_name


class DispatchSession(TimestampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Actief"
        RELEASED = "released", "Vrijgegeven"
        TIMED_OUT = "timed_out", "Time-out"

    dispatch_user = models.ForeignKey(
        DispatchUser,
        on_delete=models.CASCADE,
        related_name="sessions",
        verbose_name="Dispatcher",
    )
    django_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="dispatch_sessions",
        verbose_name="Django-gebruiker",
    )
    session_key = models.CharField("Browsersessie", max_length=64)
    status = models.CharField("Status", max_length=16, choices=Status.choices, default=Status.ACTIVE)
    claimed_at_ms = models.BigIntegerField("Geclaimd op (ms)", default=now_ms)
    last_seen_at_ms = models.BigIntegerField("Laatst gezien (ms)", default=now_ms)
    telemetry = models.JSONField(
        "Laatste heartbeattelemetrie", default=dict, blank=True,
        help_text="Geaggregeerde WebRTC-metingen sinds de vorige heartbeat.",
    )
    released_at_ms = models.BigIntegerField("Vrijgegeven op (ms)", null=True, blank=True)

    class Meta:
        ordering = ["-claimed_at_ms"]
        verbose_name = "Dispatchsessie"
        verbose_name_plural = "Dispatchsessies"
        constraints = [
            models.UniqueConstraint(
                fields=["dispatch_user"],
                condition=Q(status="active"),
                name="one_active_session_per_dispatch_user",
            )
        ]

    def __str__(self):
        return f"{self.dispatch_user.display_name} – {self.django_user}"
