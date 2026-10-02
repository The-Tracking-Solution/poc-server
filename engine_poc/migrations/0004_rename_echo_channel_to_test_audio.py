from django.db import migrations


def rename_echo_channels(apps, schema_editor):
    Channel = apps.get_model("engine_poc", "Channel")
    for channel in Channel.objects.filter(channel_type="echo").order_by("tenant_id", "pk"):
        target = Channel.objects.filter(tenant_id=channel.tenant_id, slug="test_audio").exclude(pk=channel.pk).first()
        if target is not None:
            # Laat bestaande test_audio intact; maak alleen de zichtbare naam van
            # een reeds aanwezige echo-type target canoniek.
            if target.channel_type == "echo" and target.name != "test_audio":
                target.name = "test_audio"
                target.save(update_fields=["name"])
            continue
        channel.slug = "test_audio"
        channel.name = "test_audio"
        channel.save(update_fields=["slug", "name"])


def reverse_rename(apps, schema_editor):
    Channel = apps.get_model("engine_poc", "Channel")
    for channel in Channel.objects.filter(channel_type="echo", slug="test_audio"):
        collision = Channel.objects.filter(tenant_id=channel.tenant_id, slug="echo").exclude(pk=channel.pk).exists()
        if not collision:
            channel.slug = "echo"
            channel.name = "Echo"
            channel.save(update_fields=["slug", "name"])


class Migration(migrations.Migration):
    dependencies = [("engine_poc", "0003_rename_device_dispatch_session_constraint")]
    operations = [migrations.RunPython(rename_echo_channels, reverse_rename)]
