from __future__ import annotations

from django.db.models import Q

from engine_poc.models import Channel


def linked_group_members(channel: Channel) -> list[Channel]:
    """Return the normalized linked group for a channel.

    Echo channels are never linkable and therefore always form a group of one.
    The Dispatch link-group migration normalizes groups to cliques, but this
    query also works while a group is being edited because it includes all
    channels directly related to ``channel``.
    """
    if channel.channel_type == Channel.ChannelType.ECHO:
        return [channel]
    members = list(
        Channel.objects.filter(tenant_id=channel.tenant_id)
        .exclude(channel_type=Channel.ChannelType.ECHO)
        .filter(Q(pk=channel.pk) | Q(linked_channels=channel))
        .distinct()
    )
    if not members:
        return [channel]
    members.sort(key=lambda item: (item.name.casefold(), item.pk))
    return members


def canonical_link_channel(channel: Channel) -> Channel:
    """Stable channel used as media/floor domain for a linked group."""
    return linked_group_members(channel)[0]


def linked_group_ids(channel: Channel) -> list[int]:
    return [member.pk for member in linked_group_members(channel)]


def linked_group_slugs(channel: Channel) -> list[str]:
    return [member.slug for member in linked_group_members(channel)]
