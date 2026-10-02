import json
from django.contrib import admin
from django.utils.html import format_html

from engine_poc.admin import TenantFilterMixin, TimestampAdminMixin

from .models import DispatchConfig, DispatchProfile, DispatchSession, DispatchUser, DispatchUserSettings


@admin.register(DispatchUser)
class DispatchUserAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display = (
        "external_name", "internal_name", "tenant", "django_user_names",
        "device_status", "user_profile", "dispatch_profile", "last_update",
    )
    list_filter = ("tenant", "device_status")
    search_fields = (
        "external_name", "internal_name", "slug", "django_users__username",
        "django_users__email", "tenant__name",
    )
    autocomplete_fields = ("tenant", "user_profile", "dispatch_profile")
    list_select_related = ("tenant", "user_profile", "dispatch_profile")
    filter_horizontal = ("django_users",)
    readonly_fields = ("secret_configured", "created_at", "last_update")
    fieldsets = (
        ("Identiteit", {"fields": ("tenant", "django_users", "slug", "internal_name", "external_name")}),
        ("Status", {"fields": ("device_status",)}),
        ("Profiel", {"fields": ("user_profile", "dispatch_profile")}),
        ("Beveiliging", {"fields": ("secret_configured",), "classes": ("collapse",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Secret ingesteld", boolean=True)
    def secret_configured(self, obj):
        return bool(obj.secret_key_hash and obj.secret_key_hash != "!")

    @admin.display(description="Django-gebruikers")
    def django_user_names(self, obj):
        return ", ".join(obj.django_users.order_by("username").values_list("username", flat=True)) or "—"

    def save_model(self, request, obj, form, change):
        if not change and not obj.secret_key_hash:
            obj.secret_key_hash = "!"
        super().save_model(request, obj, form, change)


@admin.register(DispatchSession)
class DispatchSessionAdmin(TimestampAdminMixin, admin.ModelAdmin):
    list_display = (
        "dispatch_user", "django_user", "status", "claimed_at_ms",
        "last_seen_at_ms", "released_at_ms",
    )
    list_filter = ("status", "dispatch_user__tenant")
    search_fields = ("dispatch_user__external_name", "django_user__username", "session_key")
    autocomplete_fields = ("dispatch_user", "django_user")
    list_select_related = ("dispatch_user", "dispatch_user__tenant", "django_user")
    readonly_fields = (
        "claimed_at_ms", "last_seen_at_ms", "released_at_ms", "telemetry_pretty", "created_at", "last_update",
    )
    fieldsets = (
        ("Sessie", {"fields": ("dispatch_user", "django_user", "status", "session_key")}),
        ("Heartbeat", {"fields": ("claimed_at_ms", "last_seen_at_ms", "released_at_ms", "telemetry_pretty")}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Laatste heartbeattelemetrie")
    def telemetry_pretty(self, obj):
        return format_html(
            '<pre style="white-space:pre-wrap;max-width:900px">{}</pre>',
            json.dumps(obj.telemetry or {}, ensure_ascii=False, indent=2),
        )


@admin.register(DispatchConfig)
class DispatchConfigAdmin(TimestampAdminMixin, admin.ModelAdmin):
    list_display = ("tenant", "last_update")
    search_fields = ("tenant__name", "tenant__slug")
    autocomplete_fields = ("tenant",)
    readonly_fields = ("created_at", "last_update")


@admin.register(DispatchProfile)
class DispatchProfileAdmin(TimestampAdminMixin, admin.ModelAdmin):
    list_display = ("name", "tenant", "dispatch_config", "status_schema", "last_update")
    list_filter = ("tenant",)
    search_fields = ("name", "tenant__name")
    autocomplete_fields = ("tenant", "dispatch_config", "status_schema")
    list_select_related = ("tenant", "dispatch_config", "status_schema")
    readonly_fields = ("created_at", "last_update")


@admin.register(DispatchUserSettings)
class DispatchUserSettingsAdmin(TimestampAdminMixin, admin.ModelAdmin):
    list_display = ("dispatch_user", "tenant", "dispatch_profile", "last_update")
    list_filter = ("tenant", "dispatch_profile")
    search_fields = ("dispatch_user__external_name", "dispatch_user__internal_name", "tenant__name")
    autocomplete_fields = ("tenant", "dispatch_user", "dispatch_profile")
    readonly_fields = ("created_at", "last_update")
