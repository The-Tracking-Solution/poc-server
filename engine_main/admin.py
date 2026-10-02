from datetime import datetime, timezone as dt_timezone

from django.contrib import admin
from django.utils import timezone

from .models import HardwareAutoLogin, Tenant


@admin.register(Tenant)
class TenantAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "tx_permission_mode", "heartbeat_interval_ms", "heartbeat_timeout_ms", "last_update")
    search_fields = ("name", "slug")
    ordering = ("name",)
    readonly_fields = ("created_at", "last_update")
    fieldsets = (
        ("Algemeen", {"fields": ("name", "slug", "logo")}),
        ("PTT-instellingen", {"fields": ("tx_permission_mode", "preemption_hold_ms", "urgent_priority", "emergency_priority", "default_max_ptt_duration_ms")}),
        ("Verbinding en time-outs", {"fields": ("heartbeat_interval_ms", "heartbeat_timeout_ms")}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Aangemaakt", ordering="created_at_ms")
    def created_at(self, obj):
        return self._format_ms(obj.created_at_ms)

    @admin.display(description="Bijgewerkt", ordering="last_update_ms")
    def last_update(self, obj):
        return self._format_ms(obj.last_update_ms)

    @staticmethod
    def _format_ms(value):
        moment = datetime.fromtimestamp(value / 1000, tz=dt_timezone.utc)
        return timezone.localtime(moment).strftime("%d-%m-%Y %H:%M:%S")


@admin.register(HardwareAutoLogin)
class HardwareAutoLoginAdmin(admin.ModelAdmin):
    list_display = ("name", "short_code", "device_uuid", "android_id", "user", "enabled", "last_login")
    list_filter = ("enabled",)
    search_fields = ("name", "hardware_id", "device_uuid", "android_id", "user__username", "user__first_name", "user__last_name")
    autocomplete_fields = ("user",)
    readonly_fields = ("device_uuid", "short_code", "created_at", "last_update", "last_login")
    fieldsets = (
        ("Hardware", {"fields": ("name", "device_uuid", "short_code", "android_id", "hardware_id", "enabled")}),
        ("Login", {"fields": ("user",)}),
        ("Systeeminformatie", {"fields": ("last_login", "created_at", "last_update"), "classes": ("collapse",)}),
    )


    @admin.display(description="Code")
    def short_code(self, obj):
        return obj.short_code or "-"

    @admin.display(description="Laatste auto-login", ordering="last_login_at_ms")
    def last_login(self, obj):
        if not obj.last_login_at_ms:
            return "-"
        return TenantAdmin._format_ms(obj.last_login_at_ms)

    @admin.display(description="Aangemaakt", ordering="created_at_ms")
    def created_at(self, obj):
        return TenantAdmin._format_ms(obj.created_at_ms)

    @admin.display(description="Bijgewerkt", ordering="last_update_ms")
    def last_update(self, obj):
        return TenantAdmin._format_ms(obj.last_update_ms)
