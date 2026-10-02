from django.db import migrations


def normalize_channel_link_groups(apps, schema_editor):
    Channel = apps.get_model("engine_poc", "Channel")

    # Echo-kanalen horen niet bij Dispatch-linkgroepen.
    for channel in Channel.objects.filter(channel_type="echo"):
        channel.linked_channels.clear()

    tenant_ids = Channel.objects.values_list("tenant_id", flat=True).distinct()
    for tenant_id in tenant_ids:
        channels = list(
            Channel.objects.filter(tenant_id=tenant_id)
            .exclude(channel_type="echo")
            .prefetch_related("linked_channels")
            .order_by("pk")
        )
        allowed_ids = {channel.pk for channel in channels}
        by_id = {channel.pk: channel for channel in channels}
        adjacency = {channel.pk: set() for channel in channels}
        for channel in channels:
            for linked in channel.linked_channels.all():
                if linked.pk in allowed_ids and linked.pk != channel.pk:
                    adjacency[channel.pk].add(linked.pk)
                    adjacency[linked.pk].add(channel.pk)

        seen = set()
        for channel in channels:
            if channel.pk in seen:
                continue
            stack = [channel.pk]
            component = []
            while stack:
                current = stack.pop()
                if current in seen:
                    continue
                seen.add(current)
                component.append(current)
                stack.extend(adjacency[current] - seen)
            if len(component) < 2:
                continue

            members = [by_id[pk] for pk in component]
            # Maak elk bestaand connected component een volledige clique. Daarmee
            # is de groep eenduidig en heeft elk kanaal exact dezelfde groepsleden.
            for index, source in enumerate(members):
                for target in members[index + 1:]:
                    source.linked_channels.add(target)


class Migration(migrations.Migration):
    dependencies = [
        ("engine_poc", "0013_channel_linked_channels"),
    ]

    operations = [
        migrations.RunPython(normalize_channel_link_groups, migrations.RunPython.noop),
    ]
