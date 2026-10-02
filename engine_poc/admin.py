import json
from datetime import datetime, timezone as dt_timezone

from django.contrib import admin
from django import forms
from django.urls import reverse
from django.utils import timezone
from django.utils.html import format_html

from .models import (
    Channel,
    ChannelState,
    DeviceSession,
    EventAttachment,
    EventLog,
    CallRequest,
    UserStatus, StatusSchema,
)


def format_ms(value):
    """Zet een Unix-tijdstip in milliseconden om naar lokale, leesbare tijd."""
    if not value:
        return "—"
    moment = datetime.fromtimestamp(value / 1000, tz=dt_timezone.utc)
    return timezone.localtime(moment).strftime("%d-%m-%Y %H:%M:%S")


class TimestampAdminMixin:
    readonly_fields = ("created_at", "last_update")

    @admin.display(description="Aangemaakt", ordering="created_at_ms")
    def created_at(self, obj):
        return format_ms(obj.created_at_ms)

    @admin.display(description="Bijgewerkt", ordering="last_update_ms")
    def last_update(self, obj):
        return format_ms(obj.last_update_ms)


class TenantFilterMixin:
    list_filter = ("tenant",)
    autocomplete_fields = ("tenant",)









@admin.register(UserStatus)
class UserStatusAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display = (
        "system_status",
        "display_code",
        "display_label",
        "display_status",
        "call_request_priority",
        "tenant",
        "slug",
        "last_update",
    )
    list_filter = ("tenant", "system_status", "call_request_priority")
    search_fields = ("display_code", "display_status", "display_label", "slug", "tenant__name")
    ordering = ("tenant__name", "display_code", "display_label")
    fieldsets = (
        ("Systeemstatus", {"fields": ("tenant", "system_status", "slug")}),
        ("Weergave", {"fields": ("display_code", "display_status", "display_label")}),
        ("Call request", {"fields": ("call_request_priority",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )


class StatusSchemaAdminForm(forms.ModelForm):
    class Meta:
        model = StatusSchema
        fields = "__all__"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        tenant_id = getattr(self.instance, "tenant_id", None)
        if not tenant_id and self.data:
            tenant_id = self.data.get("tenant")
        queryset = UserStatus.objects.all().order_by("tenant__name", "display_code", "display_label")
        if tenant_id:
            queryset = queryset.filter(tenant_id=tenant_id)
        self.fields["statuses"].queryset = queryset


@admin.register(StatusSchema)
class StatusSchemaAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    form = StatusSchemaAdminForm
    list_display = ("name", "slug", "tenant", "status_count", "last_update")
    search_fields = ("name", "slug", "tenant__name")
    ordering = ("tenant__name", "name", "slug")
    filter_horizontal = ("statuses",)
    fieldsets = (
        ("Statusschema", {"fields": ("tenant", "slug", "name")}),
        ("Gebruikersstatussen", {"fields": ("statuses",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Gebruikersstatussen")
    def status_count(self, obj):
        return obj.statuses.count()


@admin.register(Channel)
class ChannelAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display = ("name", "tenant", "status", "channel_type", "max_ptt_duration_ms", "last_update")
    list_filter = ("tenant", "status", "channel_type")
    search_fields = ("name", "slug", "tenant__name")
    ordering = ("tenant__name", "name")








@admin.register(DeviceSession)
class DeviceSessionAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display = (
        "actor_name_admin",
        "device_identifier",
        "tenant",
        "status",
        "current_channel",
        "connected_at",
        "last_seen_at",
        "average_roundtrip_ms",
    )
    list_filter = ("tenant", "status", "current_channel")
    search_fields = ("device_identifier", "radio_user__external_name", "radio_user__slug", "dispatch_user__external_name", "dispatch_user__slug")
    autocomplete_fields = ("tenant", "radio_user", "dispatch_user", "current_channel")
    list_select_related = ("tenant", "radio_user", "dispatch_user", "current_channel")
    readonly_fields = (
        "token_configured",
        "connected_at",
        "disconnected_at",
        "last_seen_at",
        "last_heartbeat_at",
        "telemetry_pretty",
        "created_at",
        "last_update",
    )
    fieldsets = (
        ("Sessie", {"fields": ("tenant", "radio_user", "dispatch_user", "device_identifier", "status", "current_channel")}),
        ("Tijdstippen", {"fields": ("connected_at", "disconnected_at", "last_seen_at", "last_heartbeat_at")}),
        (
            "Heartbeat",
            {"fields": ("last_roundtrip_ms", "average_roundtrip_ms", "heartbeat_samples", "missed_heartbeats", "telemetry_pretty")},
        ),
        ("Beveiliging", {"fields": ("token_configured",), "classes": ("collapse",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Device")
    def actor_name_admin(self, obj):
        return obj.actor_name

    @admin.display(description="Laatste heartbeattelemetrie")
    def telemetry_pretty(self, obj):
        return format_html("<pre style=\"white-space:pre-wrap;max-width:900px\">{}</pre>", json.dumps(obj.telemetry or {}, ensure_ascii=False, indent=2))

    @admin.display(description="Token ingesteld", boolean=True)
    def token_configured(self, obj):
        return bool(obj.session_token_hash)

    @admin.display(description="Verbonden", ordering="connected_at_ms")
    def connected_at(self, obj):
        return format_ms(obj.connected_at_ms)

    @admin.display(description="Verbroken", ordering="disconnected_at_ms")
    def disconnected_at(self, obj):
        return format_ms(obj.disconnected_at_ms)

    @admin.display(description="Laatst gezien", ordering="last_seen_at_ms")
    def last_seen_at(self, obj):
        return format_ms(obj.last_seen_at_ms)

    @admin.display(description="Laatste heartbeat", ordering="last_heartbeat_at_ms")
    def last_heartbeat_at(self, obj):
        return format_ms(obj.last_heartbeat_at_ms)


@admin.register(ChannelState)
class ChannelStateAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display = ("channel", "tenant", "emergency_radio_names", "floor_status", "active_user_name", "pending_user_name", "last_update")
    list_filter = ("tenant", "floor_status")
    search_fields = ("channel__name", "active_user_name", "pending_user_name")
    autocomplete_fields = ("tenant", "channel", "active_session", "pending_session", "emergency_users")
    list_select_related = ("tenant", "channel", "active_session", "pending_session")
    readonly_fields = ("created_at", "last_update")
    fieldsets = (
        ("Kanaal", {"fields": ("tenant", "channel", "floor_status", "emergency_users")}),
        (
            "Actieve spreker",
            {
                "fields": (
                    "active_session",
                    "active_user_slug",
                    "active_user_name",
                    "active_priority",
                    "active_event_sequence",
                    "granted_at_ms",
                )
            },
        ),
        (
            "Wachtende spreker",
            {"fields": ("pending_session", "pending_user_slug", "pending_user_name", "pending_priority", "pending_since_ms")},
        ),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Radio's met noodoproep")
    def emergency_radio_names(self, obj):
        names = list(obj.emergency_users.order_by("external_name").values_list("external_name", flat=True))
        return ", ".join(names) if names else "—"


class EventAttachmentInline(admin.TabularInline):
    model = EventAttachment
    extra = 0
    fields = ("attachment_type", "original_filename", "mime_type", "file_size", "duration_ms", "file")
    readonly_fields = fields
    can_delete = False
    show_change_link = True


@admin.register(EventLog)
class EventLogAdmin(admin.ModelAdmin):
    list_display = ("sequence_number", "timestamp", "tenant", "action_type", "actor_name", "channel_name", "short_message")
    list_filter = ("tenant", "action_type", "entity_type")
    search_fields = (
        "=sequence_number",
        "client_request_id",
        "actor_name",
        "subject_name",
        "channel_name",
        "entity_name",
        "message",
    )
    list_select_related = ("tenant",)
    date_hierarchy = None
    ordering = ("-sequence_number",)
    readonly_fields = tuple(field.name for field in EventLog._meta.fields) + ("timestamp", "pretty_metadata")
    inlines = (EventAttachmentInline,)
    fieldsets = (
        ("Event", {"fields": ("sequence_number", "timestamp", "tenant", "action_type", "message", "value", "ptt_priority")}),
        ("Actor en onderwerp", {"fields": ("actor_slug", "actor_name", "subject_slug", "subject_name")}),
        ("Kanaal", {"fields": ("channel_slug", "channel_name")}),
        ("Locatie", {"fields": ("location", "location_accuracy_m", "location_timestamp_ms")}),
        ("Entiteit", {"fields": ("entity_type", "entity_slug", "entity_name")}),
        ("Technisch", {"fields": ("client_request_id", "tenant_slug_snapshot", "tenant_name_snapshot", "pretty_metadata"), "classes": ("collapse",)}),
        ("Ruwe tijdvelden", {"fields": ("timestamp_ms", "created_at_ms", "last_update_ms"), "classes": ("collapse",)}),
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="Tijdstip", ordering="timestamp_ms")
    def timestamp(self, obj):
        return format_ms(obj.timestamp_ms)

    @admin.display(description="Bericht")
    def short_message(self, obj):
        return obj.message[:80] + ("…" if len(obj.message) > 80 else "")

    @admin.display(description="Metadata")
    def pretty_metadata(self, obj):
        return format_html("<pre>{}</pre>", json.dumps(obj.metadata, indent=2, ensure_ascii=False))


@admin.register(EventAttachment)
class EventAttachmentAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display = ("original_filename", "tenant", "event", "attachment_type", "human_file_size", "duration_ms", "created_at")
    list_filter = ("tenant", "attachment_type", "mime_type")
    search_fields = ("original_filename", "checksum", "event__action_type")
    autocomplete_fields = ("tenant", "event")
    list_select_related = ("tenant", "event")
    readonly_fields = ("human_file_size", "created_at", "last_update")

    @admin.display(description="Grootte", ordering="file_size")
    def human_file_size(self, obj):
        size = obj.file_size
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024 or unit == "GB":
                return f"{size:.1f} {unit}" if unit != "B" else f"{size} {unit}"
            size /= 1024


@admin.register(CallRequest)
class CallRequestAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display=("priority","radio_user","channel","status","activated_at_ms","accepted_at_ms","cleared_at_ms")
    list_filter=("tenant","priority","status")
    search_fields=("radio_user__external_name","channel__name")
    autocomplete_fields=("tenant","radio_user","channel")
    readonly_fields=("created_at","last_update")
