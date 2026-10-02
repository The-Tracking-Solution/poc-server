"""Automatische POC-engine basisobjecten voor nieuwe tenants/profielen."""

from django.db import transaction
from django.db.models.signals import m2m_changed, post_delete, post_save
from django.dispatch import receiver
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from engine_main.models import Tenant
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, Screen, UserProfile
from engine_poc.models import Channel, UserStatus
from engine_poc.services.emergency_channels import sync_emergency_user
from engine_poc.control_protocol import tenant_config_group_name
from engine_poc.timeutils import now_ms
from engine_poc.user_status_defaults import ensure_default_user_statuses


@receiver(post_save, sender=Tenant, dispatch_uid="poc.ensure_default_user_statuses_for_tenant")
def create_default_user_statuses_for_tenant(sender, instance, created, **kwargs):
    if created:
        ensure_default_user_statuses(instance)


@receiver(post_save, sender=UserStatus, dispatch_uid="poc.sync_emergency_users_for_status")
def sync_emergency_users_for_status(sender, instance, **kwargs):
    for user in RadioUser.objects.select_related("user_contact_status", "current_channel").filter(user_contact_status=instance):
        sync_emergency_user(user)



def _push_config_change(tenant_id, *domains):
    if not tenant_id:
        return
    unique = sorted({str(item) for item in domains if item})
    if not unique:
        return
    def send():
        layer = get_channel_layer()
        if not layer:
            return
        async_to_sync(layer.group_send)(
            tenant_config_group_name(int(tenant_id)),
            {
                "type": "config_changed",
                "payload": {
                    "type": "config_changed",
                    "domains": unique,
                    "timestamp_ms": now_ms(),
                },
            },
        )
    transaction.on_commit(send)


@receiver([post_save, post_delete], sender=Channel, dispatch_uid="poc.push_channel_config")
def push_channel_config(sender, instance, **kwargs):
    _push_config_change(instance.tenant_id, "channels")


@receiver([post_save, post_delete], sender=UserStatus, dispatch_uid="poc.push_status_config")
def push_status_config(sender, instance, **kwargs):
    _push_config_change(instance.tenant_id, "statuses")


@receiver([post_save, post_delete], sender=Screen, dispatch_uid="poc.push_screen_config")
def push_screen_config(sender, instance, **kwargs):
    _push_config_change(instance.tenant_id, "screens")


@receiver([post_save, post_delete], sender=HardwareProfile, dispatch_uid="poc.push_hardware_profile_config")
def push_hardware_profile_config(sender, instance, **kwargs):
    _push_config_change(instance.tenant_id, "screens", "hardware")


@receiver([post_save, post_delete], sender=UserProfile, dispatch_uid="poc.push_user_profile_config")
def push_user_profile_config(sender, instance, **kwargs):
    _push_config_change(instance.tenant_id, "channels", "audio", "profile")


@receiver(m2m_changed, sender=UserProfile.channels.through, dispatch_uid="poc.push_user_profile_channels")
def push_user_profile_channels(sender, instance, action, **kwargs):
    if action in {"post_add", "post_remove", "post_clear"}:
        _push_config_change(instance.tenant_id, "channels")


@receiver(post_save, sender=RadioUser, dispatch_uid="poc.push_radio_user_config")
def push_radio_user_config(sender, instance, created=False, update_fields=None, **kwargs):
    # Runtime status/current channel changes are handled by the normal radio protocol
    # and must not create config storms. Admin/full saves can change identity/profile.
    relevant = {"external_name", "name", "slug", "user_profile", "hardware_profile", "location_interval_seconds"}
    if created or update_fields is None or relevant.intersection(set(update_fields or ())):
        _push_config_change(instance.tenant_id, "identity", "contacts", "profile")


@receiver(post_save, sender=HardwareConfig, dispatch_uid="poc.push_hardware_config")
def push_hardware_config(sender, instance, **kwargs):
    tenant_ids = list(HardwareProfile.objects.filter(hardware_config=instance).values_list("tenant_id", flat=True).distinct())
    for tenant_id in tenant_ids:
        _push_config_change(tenant_id, "screens", "hardware")
