from datetime import datetime, timezone as dt_timezone

from django.contrib import admin
from django.urls import reverse
from django.utils import timezone
from django.utils.html import format_html

from .forms import HardwareAdminForm, HardwareProfileAdminForm, RadioUserAdminForm, ScreenAdminForm
from .models import HardwareConfig, HardwareProfile, RadioUser, Screen, UserProfile


def format_ms(value):
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


@admin.register(HardwareConfig)
class HardwareAdmin(TimestampAdminMixin, admin.ModelAdmin):
    form = HardwareAdminForm
    list_display = ("name", "profile_count", "last_update")
    search_fields = ("name",)
    readonly_fields = ("created_at", "last_update")
    fieldsets = (
        ("HardwareConfig", {"fields": ("name",)}),
        ("JSON", {"fields": ("config",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Hardwareprofielen")
    def profile_count(self, obj):
        return obj.profiles.count()


@admin.register(UserProfile)
class UserProfileAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    list_display = ("name", "tenant", "ptt_priority", "opus_bitrate_kbps", "channel_count", "last_update")
    list_filter = ("tenant", "opus_dtx", "opus_red")
    search_fields = ("name", "slug", "tenant__name")
    autocomplete_fields = ("tenant", "channels")
    filter_horizontal = ("channels",)
    readonly_fields = ("created_at", "last_update")
    fieldsets = (
        ("Algemeen", {"fields": ("tenant", "slug", "name")}),
        ("Mogelijkheden", {"fields": ("ptt_priority", "channels")}),
        ("Audio", {"fields": ("opus_bitrate_kbps", "opus_dtx", "opus_red")}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Kanalen")
    def channel_count(self, obj):
        return obj.channels.count()


@admin.register(RadioUser)
class RadioUserAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    form = RadioUserAdminForm
    list_display = (
        "display_name_admin", "tenant", "django_user_names", "device_status", "debug",
        "user_status", "user_contact_status", "current_channel", "location_interval_seconds",
        "play_tx_accept_tone", "play_key_tones", "vibration_enabled", "last_location_display", "last_update",
    )
    list_filter = (
        "tenant", "device_status", "debug", "play_tx_accept_tone", "play_key_tones",
        "vibration_enabled", "user_status", "user_contact_status", "current_channel",
    )
    search_fields = ("internal_name", "external_name", "slug", "django_users__username", "django_users__email")
    autocomplete_fields = ("tenant", "user_status", "user_contact_status", "current_channel", "user_profile", "hardware_profile")
    list_select_related = ("tenant", "user_status", "user_contact_status", "current_channel", "user_profile", "hardware_profile")
    readonly_fields = ("secret_configured", "last_location_display", "last_location_accuracy_m", "last_location_at_ms", "created_at", "last_update")
    filter_horizontal = ("django_users",)
    fieldsets = (
        ("Identiteit", {"fields": ("tenant", "django_users", "slug", "internal_name", "external_name", "debug")}),
        ("Status", {"fields": ("device_status", "user_status", "user_contact_status", "current_channel")}),
        ("Profielen", {"fields": ("user_profile", "hardware_profile")}),
        ("Audio en feedback", {"fields": ("play_tx_accept_tone", "play_key_tones", "vibration_enabled")}),
        ("Locatie", {"fields": ("location_interval_seconds", "last_location_display", "last_location_accuracy_m", "last_location_at_ms", "clear_location")}),
        ("Beveiliging", {"fields": ("secret_configured",), "classes": ("collapse",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Naam", ordering="external_name")
    def display_name_admin(self, obj):
        return obj.display_name

    @admin.display(description="Django-gebruikers")
    def django_user_names(self, obj):
        return ", ".join(obj.django_users.order_by("username").values_list("username", flat=True)) or "—"


    @admin.display(description="Laatste locatie")
    def last_location_display(self, obj):
        if not obj.last_location:
            return "—"
        return f"POINT ({obj.last_location.x:.6f} {obj.last_location.y:.6f})"

    def save_model(self, request, obj, form, change):
        if form.cleaned_data.get("clear_location"):
            obj.last_location = None
            obj.last_location_accuracy_m = None
            obj.last_location_at_ms = None
        super().save_model(request, obj, form, change)

    @admin.display(description="Secret ingesteld", boolean=True)
    def secret_configured(self, obj):
        return bool(obj.secret_key_hash)


@admin.register(HardwareProfile)
class HardwareProfileAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    form = HardwareProfileAdminForm
    list_display = ("name", "hardware_config", "tenant", "screen_count", "last_update")
    list_filter = ("tenant", "hardware_config")
    search_fields = ("name", "slug", "hardware_config__name", "tenant__name")
    autocomplete_fields = ("tenant", "hardware_config")
    readonly_fields = ("created_at", "last_update")
    fieldsets = (
        ("Algemeen", {"fields": ("tenant", "slug", "name", "hardware_config")}),
        ("JSON", {"fields": ("config",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )

    @admin.display(description="Schermen")
    def screen_count(self, obj):
        return obj.screens.count()


@admin.register(Screen)
class ScreenAdmin(TimestampAdminMixin, TenantFilterMixin, admin.ModelAdmin):
    form = ScreenAdminForm
    list_display = ("name", "hardware_profile", "hardware_config", "tenant", "last_update")
    list_filter = ("tenant", "hardware_config", "hardware_profile")
    search_fields = ("name", "hardware_profile__name", "hardware_config__name", "tenant__name")
    autocomplete_fields = ("tenant", "hardware_profile")
    readonly_fields = ("created_at", "last_update")
    fieldsets = (
        ("Algemeen", {"fields": ("tenant", "hardware_profile", "name")}),
        ("JSON", {"fields": ("config",)}),
        ("Systeeminformatie", {"fields": ("created_at", "last_update"), "classes": ("collapse",)}),
    )
