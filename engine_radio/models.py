import secrets

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.contrib.gis.db import models as gis_models

from engine_main.models import Tenant, TenantOwnedModel, TimestampedModel
from .config_overrides import merge_config, validate_button_subset, validate_config_override

from .validators import validate_screen_config


def default_screen_config():
    return {
        "schema_version": 2,
        "theme": {
            "icon_family": "material-symbols-outlined",
            "contrast_mode": "auto",
            "dark_text_color": "#000000",
            "light_text_color": "#ffffff",
            "default_button_color": "#3a3d40",
        },
        "type": "detail",
        "title": "Nieuw scherm",
        "primary": "",
        "secondary": "",
        "display": {
            "usemode": "visible",
            "default_screen_type": "detail",
            "softkeys": {"usemode": "hidden", "default_color": "#e4e4e4", "keys": {}},
        },
        "navkeys": {"usemode": "visible", "default_color": "#3a3d40", "keys": {}},
        "keyboard": {"usemode": "hidden", "layout": "none", "default_color": "#3a3d40", "keys": {}},
        "softradio": {"usemode": "hidden", "layout": "1x3", "default_color": "#3a3d40", "keys": {}},
        "topkeys": {"usemode": "hidden", "default_color": "#3a3d40", "keys": {}},
        "leftkeys": {"usemode": "hidden", "default_color": "#3a3d40", "keys": {}},
        "rightkeys": {"usemode": "hidden", "default_color": "#3a3d40", "keys": {}},
    }


class HardwareConfig(TimestampedModel):
    name = models.CharField("Naam", max_length=200, unique=True)
    config = models.JSONField(
        "Configuratie",
        default=default_screen_config,
        validators=[validate_screen_config],
    )

    class Meta:
        db_table = "engine_radio_hardware_config"
        ordering = ["name"]
        verbose_name = "Hardware config"
        verbose_name_plural = "Hardware configs"

    def __str__(self):
        return self.name


class UserProfile(TenantOwnedModel):
    name = models.CharField("Naam", max_length=200)
    ptt_priority = models.PositiveSmallIntegerField("PTT-prioriteit", default=0)
    opus_bitrate_kbps = models.PositiveSmallIntegerField(
        "Opus bitrate (kbps)", default=20,
        help_text="Doelbitrate voor PTT-spraak. 16-24 kbps is een goede start.",
    )
    opus_dtx = models.BooleanField("Opus DTX", default=True)
    opus_red = models.BooleanField(
        "Opus RED", default=False,
        help_text="Redundante audio verhoogt robuustheid maar ook dataverbruik.",
    )
    channels = models.ManyToManyField(
        "engine_poc.Channel",
        blank=True,
        related_name="user_profiles",
        verbose_name="Kanalen",
    )

    class Meta(TenantOwnedModel.Meta):
        ordering = ["tenant__name", "name"]
        verbose_name = "Gebruikersprofiel"
        verbose_name_plural = "Gebruikersprofielen"
        constraints = [
            models.UniqueConstraint(fields=["tenant", "slug"], name="engine_radio_userprofile_tenant_slug_uq")
        ]

    def __str__(self):
        return f"{self.name} ({self.tenant})"


class RadioUser(TenantOwnedModel):
    class DeviceStatus(models.TextChoices):
        OFFLINE = "offline", "Offline"
        ONLINE = "online", "Online"

    django_users = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="radio_users",
        verbose_name="Django-gebruikers",
    )
    secret_key_hash = models.CharField(max_length=256, editable=False)
    internal_name = models.CharField("Interne naam", max_length=200)
    external_name = models.CharField("Weergavenaam", max_length=200)
    debug = models.BooleanField(
        "Debug",
        default=False,
        help_text="Toon hardware/key-press meldingen op de secundaire regel van de radio.",
    )
    play_tx_accept_tone = models.BooleanField(
        "TX-accepttoon afspelen",
        default=True,
        help_text="Speel de korte bevestigingstoon af zodra zendtoestemming is verkregen.",
    )
    play_key_tones = models.BooleanField(
        "Toetstonen afspelen",
        default=True,
        help_text="Speel lokale toetstonen af bij bediening van soft- en hardwaretoetsen.",
    )
    vibration_enabled = models.BooleanField(
        "Trillen actief",
        default=True,
        help_text="Geef korte haptische feedback bij toetsbediening als het apparaat dit ondersteunt.",
    )
    device_status = models.CharField(
        "Apparaatstatus",
        max_length=16,
        choices=DeviceStatus.choices,
        default=DeviceStatus.OFFLINE,
    )
    user_status = models.ForeignKey(
        "engine_poc.UserStatus",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        verbose_name="Gebruikersstatus",
    )
    user_contact_status = models.ForeignKey(
        "engine_poc.UserStatus",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="contact_radio_users",
        verbose_name="Gespreksstatus",
    )
    current_channel = models.ForeignKey(
        "engine_poc.Channel",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="current_radio_users",
        verbose_name="Huidig kanaal",
    )
    user_profile = models.ForeignKey(
        UserProfile,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="radio_users",
        verbose_name="Gebruikersprofiel",
    )
    hardware_profile = models.ForeignKey(
        "HardwareProfile",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="radio_users",
        verbose_name="Hardwareprofiel",
    )
    location_interval_seconds = models.PositiveIntegerField(
        "Locatie interval (seconden)",
        default=15,
        help_text="0 = uitgeschakeld. Anders een veelvoud van 5 seconden.",
    )
    last_location = gis_models.PointField(
        "Laatste locatie", srid=4326, null=True, blank=True,
        help_text="Laatste betrouwbare locatie van deze radio (alleen updates met accuracy < 25 meter).",
    )
    last_location_accuracy_m = models.FloatField(
        "Nauwkeurigheid laatste locatie (m)", null=True, blank=True
    )
    last_location_at_ms = models.BigIntegerField(
        "Tijdstip laatste locatie (ms)", null=True, blank=True
    )

    class Meta(TenantOwnedModel.Meta):
        ordering = ["tenant__name", "external_name"]
        verbose_name = "Radio"
        verbose_name_plural = "Radio's"
        constraints = [
            models.UniqueConstraint(fields=["tenant", "slug"], name="engine_radio_radiouser_tenant_slug_uq")
        ]

    def __str__(self):
        return f"{self.display_name} ({self.tenant})"

    @property
    def frontend_status(self):
        """Status die clients tonen: gespreksstatus heeft voorrang op gebruikersstatus."""
        return self.user_contact_status or self.user_status

    def clean(self):
        super().clean()
        related_objects = {
            "user_status": self.user_status,
            "user_contact_status": self.user_contact_status,
            "current_channel": self.current_channel,
            "user_profile": self.user_profile,
            "hardware_profile": self.hardware_profile,
        }
        errors = {
            field: "Het gekoppelde object moet bij dezelfde tenant horen."
            for field, obj in related_objects.items()
            if obj and obj.tenant_id != self.tenant_id
        }
        if self.user_status and self.user_status.call_request_priority is not None:
            errors["user_status"] = "Normale gebruikersstatus mag geen contact_request_priority hebben."
        if self.user_contact_status and self.user_contact_status.call_request_priority is None:
            errors["user_contact_status"] = "Gespreksstatus moet een contact_request_priority hebben."
        if self.location_interval_seconds != 0 and self.location_interval_seconds % 5 != 0:
            errors["location_interval_seconds"] = "Gebruik 0 om GPS uit te schakelen, of een veelvoud van 5 seconden."
        if errors:
            raise ValidationError(errors)

    def save(self, *args, **kwargs):
        from engine_poc.models import CallRequest
        from engine_poc.services.emergency_channels import sync_emergency_user
        from engine_poc.timeutils import now_ms

        old_channel_id = None
        old_user_status_id = None
        old_contact_status_id = None
        if self.pk:
            previous = type(self).objects.filter(pk=self.pk).values(
                "user_status_id", "user_contact_status_id", "current_channel_id"
            ).first() or {}
            old_user_status_id = previous.get("user_status_id")
            old_contact_status_id = previous.get("user_contact_status_id")
            old_channel_id = previous.get("current_channel_id")

        user_status_changed = old_user_status_id != self.user_status_id
        contact_changed = old_contact_status_id != self.user_contact_status_id

        with transaction.atomic():
            super().save(*args, **kwargs)
            sync_emergency_user(self, previous_channel_id=old_channel_id)

            # Alle gebruikersstatuswijzigingen horen in dezelfde immutable EventLog.
            # Dit zit bewust op modelniveau zodat radio, dispatch en admin dezelfde
            # audittrail opleveren.
            from engine_poc.services.events import create_event
            if user_status_changed:
                old_status = None
                if old_user_status_id:
                    from engine_poc.models import UserStatus
                    old_status = UserStatus.objects.filter(pk=old_user_status_id).first()
                new_status = self.user_status
                create_event(
                    tenant=self.tenant, action_type="USER_STATUS_CHANGED",
                    actor_slug=self.slug, actor_name=self.display_name,
                    subject_slug=self.slug, subject_name=self.display_name,
                    channel_slug=self.current_channel.slug if self.current_channel_id else "",
                    channel_name=self.current_channel.name if self.current_channel_id else "",
                    entity_type="radio_user", entity_slug=self.slug, entity_name=self.display_name,
                    value=new_status.slug if new_status else "",
                    message=(
                        f"Gebruikersstatus gewijzigd naar {new_status.display_status or new_status.display_label or new_status.slug}"
                        if new_status else "Gebruikersstatus gewist"
                    ),
                    metadata={
                        "old_status_id": old_user_status_id,
                        "old_status_slug": old_status.slug if old_status else None,
                        "old_display_status": (old_status.display_status or old_status.display_label) if old_status else None,
                        "new_status_id": self.user_status_id,
                        "new_status_slug": new_status.slug if new_status else None,
                        "new_display_status": (new_status.display_status or new_status.display_label) if new_status else None,
                    },
                )

            # Een actieve contactaanvraag volgt altijd het actuele radiokanaal.
            if old_channel_id != self.current_channel_id and self.current_channel_id:
                CallRequest.objects.filter(
                    radio_user=self, status=CallRequest.Status.ACTIVE,
                ).exclude(channel_id=self.current_channel_id).update(
                    channel_id=self.current_channel_id, last_update_ms=now_ms(),
                )

            if not contact_changed:
                return

            active_request = (
                CallRequest.objects.select_for_update()
                .filter(radio_user=self, status=CallRequest.Status.ACTIVE)
                .order_by("activated_at_ms", "pk")
                .first()
            )

            # Contactstatus wissen beëindigt de actieve aanvraag.
            if not self.user_contact_status_id:
                if active_request:
                    old_priority = active_request.priority
                    active_request.clear(reason="contact_status_cleared")
                    action = "EMERGENCY_CLEARED" if old_priority == 1 else "CALL_REQUEST_CLEARED"
                    create_event(
                        tenant=self.tenant, action_type=action, actor_slug=self.slug, actor_name=self.display_name,
                        subject_slug=self.slug, subject_name=self.display_name,
                        channel_slug=self.current_channel.slug if self.current_channel_id else "",
                        channel_name=self.current_channel.name if self.current_channel_id else "",
                        entity_type="call_request", entity_slug=str(active_request.pk), entity_name=self.display_name,
                        value=str(old_priority), message="Noodoproep beëindigd" if old_priority == 1 else "Spraakaanvraag beëindigd",
                        metadata={"request_id": active_request.pk, "priority": old_priority, "reason": "contact_status_cleared"},
                    )
                return

            new_priority = self.user_contact_status.call_request_priority
            if new_priority is None:
                raise ValidationError({
                    "user_contact_status": "Gespreksstatus moet een contact_request_priority hebben."
                })
            if not self.current_channel_id:
                return

            if active_request is None:
                active_request = CallRequest.objects.create(
                    tenant_id=self.tenant_id, channel_id=self.current_channel_id,
                    radio_user=self, priority=new_priority,
                )
                action = "EMERGENCY_STARTED" if new_priority == 1 else "CALL_REQUEST_CREATED"
                create_event(
                    tenant=self.tenant, action_type=action, actor_slug=self.slug, actor_name=self.display_name,
                    subject_slug=self.slug, subject_name=self.display_name,
                    channel_slug=self.current_channel.slug, channel_name=self.current_channel.name,
                    entity_type="call_request", entity_slug=str(active_request.pk), entity_name=self.display_name,
                    value=str(new_priority), message="Noodoproep gestart" if new_priority == 1 else f"Spraakaanvraag prioriteit {new_priority}",
                    metadata={"request_id": active_request.pk, "priority": new_priority, "contact_status_slug": self.user_contact_status.slug},
                )
                return

            # Dezelfde prioriteit verandert alleen de specifieke contactstatus;
            # de wachtrijtijd blijft exact gelijk. Een upgrade (lager getal)
            # krijgt bewust een nieuw tijdstip. Downgrades worden door de
            # status-service geweigerd en worden hier defensief niet toegepast.
            if new_priority < active_request.priority:
                ts = now_ms()
                active_request.tenant_id = self.tenant_id
                active_request.channel_id = self.current_channel_id
                active_request.priority = new_priority
                active_request.activated_at_ms = ts
                active_request.accepted_at_ms = None
                active_request.cleared_at_ms = None
                active_request.clear_reason = ""
                active_request.save(update_fields=[
                    "tenant", "channel", "priority", "activated_at_ms",
                    "accepted_at_ms", "cleared_at_ms", "clear_reason", "last_update_ms",
                ])
                action = "EMERGENCY_STARTED" if new_priority == 1 else "CALL_REQUEST_UPGRADED"
                create_event(
                    tenant=self.tenant, action_type=action, actor_slug=self.slug, actor_name=self.display_name,
                    subject_slug=self.slug, subject_name=self.display_name,
                    channel_slug=self.current_channel.slug, channel_name=self.current_channel.name,
                    entity_type="call_request", entity_slug=str(active_request.pk), entity_name=self.display_name,
                    value=str(new_priority), message="Noodoproep gestart" if new_priority == 1 else f"Spraakaanvraag opgewaardeerd naar prioriteit {new_priority}",
                    metadata={"request_id": active_request.pk, "priority": new_priority, "contact_status_slug": self.user_contact_status.slug},
                )

    def reset_secret(self) -> str:
        raw = secrets.token_urlsafe(32)
        self.secret_key_hash = make_password(raw)
        self.save(update_fields=["secret_key_hash", "last_update_ms"])
        return raw

    def verify_secret(self, raw: str) -> bool:
        return check_password(raw, self.secret_key_hash)

    @property
    def display_name(self) -> str:
        return self.external_name


class HardwareProfile(TenantOwnedModel):
    name = models.CharField("Naam", max_length=200)
    hardware_config = models.ForeignKey(
        HardwareConfig,
        on_delete=models.PROTECT,
        related_name="profiles",
        verbose_name="Hardware config",
    )
    config = models.JSONField(
        "JSON", default=dict, blank=True, validators=[validate_config_override]
    )

    class Meta(TenantOwnedModel.Meta):
        ordering = ["tenant__name", "name"]
        verbose_name = "Hardwareprofiel"
        verbose_name_plural = "Hardwareprofielen"
        constraints = [
            models.UniqueConstraint(fields=["tenant", "slug"], name="engine_radio_hardwareprofile_tenant_slug_uq")
        ]

    def __str__(self):
        return f"{self.name} ({self.tenant})"

    def clean(self):
        super().clean()
        if self.hardware_config_id:
            validate_button_subset(self.config, self.hardware_config.config)
            validate_screen_config(self.resolved_config)

    @property
    def resolved_config(self):
        return merge_config(self.hardware_config.config, self.config)


class Screen(TimestampedModel):
    """Herbruikbare schermconfiguratie van de radio-interface."""

    tenant = models.ForeignKey(
        Tenant,
        on_delete=models.CASCADE,
        related_name="screens",
        verbose_name="Tenant",
    )
    name = models.CharField("Naam", max_length=200)
    hardware_profile = models.ForeignKey(
        HardwareProfile,
        on_delete=models.CASCADE,
        related_name="screens",
        verbose_name="Hardwareprofiel",
    )
    hardware_config = models.ForeignKey(
        HardwareConfig,
        on_delete=models.PROTECT,
        related_name="screens",
        verbose_name="Hardware config",
        editable=False,
    )
    config = models.JSONField(
        "JSON",
        default=dict,
        blank=True,
        validators=[validate_config_override],
    )

    class Meta:
        ordering = ["tenant__name", "name"]
        verbose_name = "Scherm"
        verbose_name_plural = "Schermen"
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "hardware_config", "name"],
                name="engine_radio_screen_tenant_hwconfig_name_uq",
            )
        ]

    def __str__(self):
        return f"{self.name} ({self.tenant})"

    @staticmethod
    def button_paths(config):
        paths = set()
        screen = config or {}
        groups = {
            "navkeys": screen.get("navkeys", {}).get("keys", {}),
            "keyboard": screen.get("keyboard", {}).get("keys", {}),
            "softkeys": screen.get("display", {}).get("softkeys", {}).get("keys", {}),
            "topkeys": screen.get("topkeys", {}).get("keys", {}),
            "leftkeys": screen.get("leftkeys", {}).get("keys", {}),
            "rightkeys": screen.get("rightkeys", {}).get("keys", {}),
        }
        for group_name, keys in groups.items():
            for key_id in keys:
                paths.add(f"{group_name}.keys.{key_id}")
        return paths

    def clean(self):
        super().clean()
        if self.hardware_profile_id:
            if self.tenant_id != self.hardware_profile.tenant_id:
                raise ValidationError({"hardware_profile": "Het hardwareprofiel moet bij dezelfde tenant horen."})
            self.hardware_config_id = self.hardware_profile.hardware_config_id
            duplicate = type(self).objects.filter(
                tenant_id=self.tenant_id,
                hardware_config_id=self.hardware_config_id,
                name=self.name,
            )
            if self.pk:
                duplicate = duplicate.exclude(pk=self.pk)
            if duplicate.exists():
                raise ValidationError({"name": "Deze schermnaam bestaat al binnen deze tenant en HardwareConfig."})
        if self.hardware_profile_id:
            validate_button_subset(self.config, self.hardware_profile.hardware_config.config)
        validate_screen_config(self.resolved_config)

    def save(self, *args, **kwargs):
        if self.hardware_profile_id:
            self.hardware_config_id = self.hardware_profile.hardware_config_id
        super().save(*args, **kwargs)

    @property
    def resolved_config(self):
        return merge_config(
            self.hardware_profile.hardware_config.config,
            self.hardware_profile.config,
            self.config,
        )
