from __future__ import annotations

import os

from livekit import api as livekit_api

from engine_poc.channel_links import canonical_link_channel, linked_group_slugs


def room_name(tenant_slug: str, channel_slug: str) -> str:
    return f"poc:{tenant_slug}:{channel_slug}"


def public_url(request=None) -> str:
    configured = os.getenv("LIVEKIT_PUBLIC_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    if request is None:
        return "ws://localhost:7880"
    scheme = "wss" if request.is_secure() else "ws"
    return f"{scheme}://{request.get_host()}"


def create_join_token(
    *,
    room: str,
    identity: str,
    name: str,
    can_publish: bool = True,
    can_subscribe: bool = True,
) -> str:
    api_key = os.getenv("LIVEKIT_API_KEY", "").strip()
    api_secret = os.getenv("LIVEKIT_API_SECRET", "").strip()
    if not api_key or not api_secret:
        raise RuntimeError("LIVEKIT_API_KEY en LIVEKIT_API_SECRET moeten ingesteld zijn.")
    if len(api_secret) < 32:
        raise RuntimeError("LIVEKIT_API_SECRET moet minimaal 32 tekens lang zijn.")
    token = (
        livekit_api.AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_name(name)
        .with_grants(
            livekit_api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=can_publish,
                can_subscribe=can_subscribe,
                can_publish_data=False,
            )
        )
    )
    return token.to_jwt()


def radio_connection_payload(*, request, session, channel, profile) -> dict:
    media_channel = canonical_link_channel(channel)
    room = room_name(session.tenant.slug, media_channel.slug)
    identity = f"radio:{session.tenant.slug}:{session.actor_slug}:{session.pk}"
    return {
        "server_url": public_url(request),
        "participant_token": create_join_token(
            room=room, identity=identity, name=session.actor_name,
            can_publish=True, can_subscribe=True,
        ),
        "room": room,
        "channel_slug": channel.slug,
        "media_channel_slug": media_channel.slug,
        "linked_channel_slugs": linked_group_slugs(channel),
        "channel_type": channel.channel_type,
        "audio": {
            "codec": "opus",
            "bitrate_kbps": int(getattr(profile, "opus_bitrate_kbps", 20) or 20),
            "dtx": bool(getattr(profile, "opus_dtx", True)),
            "red": bool(getattr(profile, "opus_red", False)),
        },
    }


def dispatch_connection_payload(*, request, dispatch_user, channel, profile) -> dict:
    media_channel = canonical_link_channel(channel)
    room = room_name(dispatch_user.tenant.slug, media_channel.slug)
    identity_prefix = f"dispatch:{dispatch_user.tenant.slug}:{dispatch_user.slug}:"
    identity = f"{identity_prefix}{channel.slug}"
    return {
        "server_url": public_url(request),
        "participant_token": create_join_token(
            room=room, identity=identity, name=dispatch_user.display_name,
        ),
        "room": room,
        "channel_slug": channel.slug,
        "media_channel_slug": media_channel.slug,
        "linked_channel_slugs": linked_group_slugs(channel),
        "ignore_identity_prefix": identity_prefix,
        "channel_type": channel.channel_type,
        "audio": {
            "codec": "opus",
            "bitrate_kbps": int(getattr(profile, "opus_bitrate_kbps", 20) or 20),
            "dtx": bool(getattr(profile, "opus_dtx", True)),
            "red": bool(getattr(profile, "opus_red", False)),
        },
    }
