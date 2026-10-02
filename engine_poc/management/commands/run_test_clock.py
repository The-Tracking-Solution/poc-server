from __future__ import annotations

import asyncio
import audioop
import logging
import math
import os
import secrets
import time
import uuid
from array import array
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
from zoneinfo import ZoneInfo

from asgiref.sync import sync_to_async
from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from engine_main.models import Tenant
from engine_poc.channel_links import canonical_link_channel
from engine_poc.livekit_media import create_join_token, room_name
from engine_poc.models import Channel, DeviceSession
from engine_poc.services.floor import force_release_floor
from engine_poc.services.radio_actions import heartbeat_ptt, start_ptt, stop_ptt
from engine_poc.timeutils import now_ms
from engine_radio.models import RadioUser, UserProfile

logger = logging.getLogger("test_clock")

SAMPLE_RATE = 48_000
CHANNELS = 1
FRAME_MS = 20
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_MS // 1000
BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2

DAYS_NL = (
    "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"
)
MONTHS_NL = (
    "januari", "februari", "maart", "april", "mei", "juni",
    "juli", "augustus", "september", "oktober", "november", "december",
)

_PIPER_VOICE = None
_PIPER_VOICE_PATH = None
_PIPER_LOCK = Lock()


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "ja"}


def _choose_tenant() -> Tenant:
    configured = os.getenv("TEST_CLOCK_TENANT_SLUG", "").strip()
    if configured:
        try:
            return Tenant.objects.get(slug=configured)
        except Tenant.DoesNotExist as exc:
            raise CommandError(f"TEST_CLOCK_TENANT_SLUG={configured!r} bestaat niet.") from exc

    tenants = list(Tenant.objects.order_by("pk")[:2])
    if not tenants:
        raise CommandError("Er is nog geen tenant aanwezig.")
    if len(tenants) > 1:
        raise CommandError(
            "Er zijn meerdere tenants. Stel TEST_CLOCK_TENANT_SLUG in .env in op de tenant voor de testklok."
        )
    return tenants[0]


@transaction.atomic
def _ensure_virtual_radio() -> tuple[Tenant, Channel, RadioUser, DeviceSession]:
    tenant = _choose_tenant()

    channel, _ = Channel.objects.get_or_create(
        tenant=tenant,
        slug="test-klok",
        defaults={
            "name": "test klok",
            "status": Channel.Status.ACTIVE,
            "channel_type": Channel.ChannelType.GROUP,
            "max_ptt_duration_ms": 20_000,
        },
    )
    changed = []
    if channel.name != "test klok":
        channel.name = "test klok"
        changed.append("name")
    if channel.status != Channel.Status.ACTIVE:
        channel.status = Channel.Status.ACTIVE
        changed.append("status")
    if channel.max_ptt_duration_ms is None or channel.max_ptt_duration_ms < 15_000:
        channel.max_ptt_duration_ms = 20_000
        changed.append("max_ptt_duration_ms")
    if changed:
        channel.save(update_fields=[*changed, "last_update_ms"])

    profile, _ = UserProfile.objects.get_or_create(
        tenant=tenant,
        slug="test-klok",
        defaults={
            "name": "Test klok",
            "ptt_priority": 0,
            "opus_bitrate_kbps": 20,
            "opus_dtx": True,
            "opus_red": False,
        },
    )
    # Idempotent: een bestaande koppeling niet opnieuw via m2m.add() aanraken.
    # m2m_changed verstuurt namelijk tenant-brede config_changed events. Bij een
    # crash/restart-loop van test-clock zou dat anders alle radio-UI's telkens
    # opnieuw laten configureren.
    if not profile.channels.filter(pk=channel.pk).exists():
        profile.channels.add(channel)

    radio, _ = RadioUser.objects.get_or_create(
        tenant=tenant,
        slug="test-klok",
        defaults={
            "secret_key_hash": make_password(secrets.token_urlsafe(32)),
            "internal_name": "TESTKLOK",
            "external_name": "Test klok",
            "device_status": RadioUser.DeviceStatus.ONLINE,
            "current_channel": channel,
            "user_profile": profile,
            "location_interval_seconds": 0,
            "play_tx_accept_tone": False,
            "play_key_tones": False,
            "vibration_enabled": False,
        },
    )
    # Idempotent: alleen opslaan wat echt wijzigt. Dit is bewust belangrijk:
    # RadioUser post_save kan config_changed naar alle actieve radio-UI's sturen.
    # Een test-clock restart mag dus nooit een tenant-brede reload/reconnect-storm
    # veroorzaken als de virtuele radio al correct bestaat.
    radio_changed = []
    desired = {
        "internal_name": "TESTKLOK",
        "external_name": "Test klok",
        "device_status": RadioUser.DeviceStatus.ONLINE,
        "current_channel": channel,
        "user_profile": profile,
        "location_interval_seconds": 0,
        "play_tx_accept_tone": False,
        "play_key_tones": False,
        "vibration_enabled": False,
    }
    for field_name, value in desired.items():
        id_name = f"{field_name}_id"
        if hasattr(radio, id_name) and hasattr(value, "pk"):
            if getattr(radio, id_name) != value.pk:
                setattr(radio, field_name, value)
                radio_changed.append(field_name)
        elif getattr(radio, field_name) != value:
            setattr(radio, field_name, value)
            radio_changed.append(field_name)
    if not radio.secret_key_hash:
        radio.secret_key_hash = make_password(secrets.token_urlsafe(32))
        radio_changed.append("secret_key_hash")
    if radio_changed:
        radio.save(update_fields=[*radio_changed, "last_update_ms"])

    session = DeviceSession.objects.filter(
        radio_user=radio,
        status=DeviceSession.Status.ACTIVE,
    ).order_by("-connected_at_ms").first()
    if session is None:
        session = DeviceSession.objects.create(
            tenant=tenant,
            radio_user=radio,
            dispatch_user=None,
            session_token_hash=make_password(secrets.token_urlsafe(48)),
            device_identifier="virtual:test-clock",
            status=DeviceSession.Status.ACTIVE,
            current_channel=channel,
            connected_at_ms=now_ms(),
            last_seen_at_ms=now_ms(),
            last_heartbeat_at_ms=now_ms(),
        )
    else:
        session.current_channel = channel
        session.last_seen_at_ms = now_ms()
        session.last_heartbeat_at_ms = now_ms()
        session.device_identifier = "virtual:test-clock"
        session.save(update_fields=[
            "current_channel", "last_seen_at_ms", "last_heartbeat_at_ms",
            "device_identifier", "last_update_ms",
        ])

    return tenant, channel, radio, session


def _mark_offline(radio_id: int, session_id: int) -> None:
    RadioUser.objects.filter(pk=radio_id).update(
        device_status=RadioUser.DeviceStatus.OFFLINE,
        last_update_ms=now_ms(),
    )
    DeviceSession.objects.filter(pk=session_id, status=DeviceSession.Status.ACTIVE).update(
        status=DeviceSession.Status.DISCONNECTED,
        disconnected_at_ms=now_ms(),
        last_update_ms=now_ms(),
    )


def _refresh_presence(radio_id: int, session_id: int) -> None:
    ts = now_ms()
    RadioUser.objects.filter(pk=radio_id).update(
        device_status=RadioUser.DeviceStatus.ONLINE,
        last_update_ms=ts,
    )
    DeviceSession.objects.filter(pk=session_id).update(
        status=DeviceSession.Status.ACTIVE,
        last_seen_at_ms=ts,
        last_heartbeat_at_ms=ts,
        missed_heartbeats=0,
        last_update_ms=ts,
    )


def _clock_text(target: datetime) -> str:
    day = DAYS_NL[target.weekday()]
    month = MONTHS_NL[target.month - 1]
    # De piep zelf markeert seconde 00. Uur/minuut als woorden klinkt voor TTS
    # duidelijker dan een dubbele punt.
    return (
        f"Bij de volgende piep is het {day} {target.day} {month}, "
        f"{target.hour} uur {target.minute} minuten."
    )


def _get_piper_voice():
    """Load de Piper-stem één keer en houd hem in geheugen."""
    global _PIPER_VOICE, _PIPER_VOICE_PATH

    model_path = os.getenv(
        "TEST_CLOCK_PIPER_MODEL",
        "/opt/piper-voices/nl_NL-alex-medium.onnx",
    ).strip()
    if not model_path:
        raise RuntimeError("TEST_CLOCK_PIPER_MODEL is leeg.")
    if not Path(model_path).is_file():
        raise RuntimeError(f"Piper-model niet gevonden: {model_path}")

    with _PIPER_LOCK:
        if _PIPER_VOICE is None or _PIPER_VOICE_PATH != model_path:
            from piper import PiperVoice

            logger.info("Piper-stem laden: %s", model_path)
            _PIPER_VOICE = PiperVoice.load(model_path)
            _PIPER_VOICE_PATH = model_path
        return _PIPER_VOICE


def _synth_wav(text: str, speed: int = 155) -> bytes:
    """Genereer mono 16-bit PCM met Piper en resample naar de LiveKit 48-kHz track."""
    from piper import SynthesisConfig

    # Piper gebruikt length_scale: lager = sneller, hoger = langzamer.
    # 155 WPM is onze neutrale radiosnelheid zodat de bestaande env-setting
    # TEST_CLOCK_SPEECH_WPM bruikbaar blijft.
    speed = max(80, min(260, int(speed)))
    length_scale = 155.0 / float(speed)
    volume = float(os.getenv("TEST_CLOCK_PIPER_VOLUME", "0.88"))
    noise_scale = float(os.getenv("TEST_CLOCK_PIPER_NOISE_SCALE", "0.55"))
    noise_w_scale = float(os.getenv("TEST_CLOCK_PIPER_NOISE_W_SCALE", "0.65"))

    voice = _get_piper_voice()
    syn_config = SynthesisConfig(
        volume=volume,
        length_scale=length_scale,
        noise_scale=noise_scale,
        noise_w_scale=noise_w_scale,
        normalize_audio=True,
    )

    # Verzamel rechtstreeks de int16 audiochunks. Zo is geen tijdelijk WAV-bestand
    # of extern TTS-proces nodig en blijft de geladen stem tussen minuten actief.
    chunks = list(voice.synthesize(text, syn_config=syn_config))
    if not chunks:
        raise RuntimeError("Piper leverde geen audio op.")

    first = chunks[0]
    rate = int(first.sample_rate)
    width = int(first.sample_width)
    channels = int(first.sample_channels)
    raw = b"".join(chunk.audio_int16_bytes for chunk in chunks)

    if width != 2:
        raw = audioop.lin2lin(raw, width, 2)
        width = 2
    if channels > 1:
        raw = audioop.tomono(raw, width, 0.5, 0.5)
        channels = 1
    if rate != SAMPLE_RATE:
        raw, _ = audioop.ratecv(raw, width, channels, rate, SAMPLE_RATE, None)

    # Extra marge tegen clipping na resampling/mixen met de klokpiep.
    raw = audioop.mul(raw, 2, 0.92)
    return raw


def _build_transmission_pcm(text: str) -> bytes:
    # De track begint 200 ms vóór hh:mm:50 met stilte. Hierdoor kan LiveKit de
    # eerste frames bufferen terwijl de eerste hoorbare sample exact rond :50 valt.
    pre_roll_ms = 200
    speech_offset_samples = SAMPLE_RATE * pre_roll_ms // 1000
    beep_offset_samples = SAMPLE_RATE * 10_200 // 1000  # start :49.800 -> piep op :00.000
    beep_duration_samples = SAMPLE_RATE * 250 // 1000
    tail_samples = SAMPLE_RATE * 150 // 1000

    speech = _synth_wav(text, speed=int(os.getenv("TEST_CLOCK_SPEECH_WPM", "155")))
    speech_samples = len(speech) // 2
    max_speech_samples = beep_offset_samples - speech_offset_samples - (SAMPLE_RATE // 5)
    if speech_samples > max_speech_samples:
        # Een onverwacht lang TTS-resultaat opnieuw iets sneller genereren.
        speech = _synth_wav(text, speed=190)
        speech_samples = len(speech) // 2
    if speech_samples > max_speech_samples:
        raise RuntimeError("De tijdzin is te lang om tussen :50 en :00 uit te spreken.")

    total_samples = beep_offset_samples + beep_duration_samples + tail_samples
    pcm = array("h", [0]) * total_samples
    speech_arr = array("h")
    speech_arr.frombytes(speech)
    pcm[speech_offset_samples:speech_offset_samples + len(speech_arr)] = speech_arr

    amplitude = int(32767 * float(os.getenv("TEST_CLOCK_BEEP_LEVEL", "0.32")))
    frequency = float(os.getenv("TEST_CLOCK_BEEP_HZ", "1000"))
    for i in range(beep_duration_samples):
        pcm[beep_offset_samples + i] = int(amplitude * math.sin(2.0 * math.pi * frequency * i / SAMPLE_RATE))
    return pcm.tobytes()


class TestClockRuntime:
    def __init__(self, tenant: Tenant, channel: Channel, radio: RadioUser, session: DeviceSession):
        self.tenant = tenant
        self.channel = channel
        self.radio = radio
        self.session = session
        self.room = None
        self.source = None
        self.track = None
        self.floor_token = ""
        self.timezone = ZoneInfo(os.getenv("TEST_CLOCK_TIMEZONE", "Europe/Amsterdam"))
        self.livekit_url = os.getenv("TEST_CLOCK_LIVEKIT_URL", "ws://livekit:7880").strip()

    async def connect_media(self) -> None:
        from livekit import rtc

        if self.room is not None and self.room.isconnected():
            return
        if self.room is not None:
            try:
                await self.room.disconnect()
            except Exception:
                pass

        media_channel = await sync_to_async(
            canonical_link_channel, thread_sensitive=True
        )(self.channel)
        room = rtc.Room()
        token = create_join_token(
            room=room_name(self.tenant.slug, media_channel.slug),
            identity=f"virtual-radio:{self.tenant.slug}:test-klok",
            name="Test klok",
            can_publish=True,
            can_subscribe=False,
        )
        await room.connect(self.livekit_url, token)
        source = rtc.AudioSource(SAMPLE_RATE, CHANNELS, queue_size_ms=250)
        track = rtc.LocalAudioTrack.create_audio_track("test-clock", source)
        options = rtc.TrackPublishOptions()
        options.source = rtc.TrackSource.SOURCE_MICROPHONE
        await room.local_participant.publish_track(track, options)

        self.room = room
        self.source = source
        self.track = track
        logger.info("Testklok verbonden met LiveKit room %s", room_name(self.tenant.slug, media_channel.slug))

    async def close_media(self) -> None:
        if self.room is not None:
            try:
                await self.room.disconnect()
            except Exception:
                logger.exception("LiveKit disconnect van testklok mislukte")
        self.room = None
        self.source = None
        self.track = None

    async def request_floor(self, deadline_monotonic: float) -> bool:
        while time.monotonic() < deadline_monotonic:
            data = await sync_to_async(start_ptt, thread_sensitive=True)(
                user=self.radio,
                session=self.session,
                previous_floor_token=self.floor_token,
                automatic_emergency=False,
            )
            if not data.get("waiting"):
                self.floor_token = str(data.get("floor_token") or "")
                return bool(self.floor_token)
            await asyncio.sleep(0.08)
        await sync_to_async(stop_ptt, thread_sensitive=True)(
            user=self.radio, session=self.session, floor_token=""
        )
        return False

    async def release_floor(self) -> None:
        token = self.floor_token
        self.floor_token = ""
        try:
            await sync_to_async(stop_ptt, thread_sensitive=True)(
                user=self.radio, session=self.session, floor_token=token
            )
        except Exception:
            logger.exception("Vrijgeven testklok-floor mislukte")
            try:
                await sync_to_async(force_release_floor, thread_sensitive=True)(
                    channel=self.channel, session=self.session, reason="test_clock_recovery"
                )
            except Exception:
                logger.exception("Force-release testklok-floor mislukte")

    async def stream_pcm(self, pcm: bytes, start_monotonic: float) -> None:
        from livekit import rtc

        if self.source is None:
            raise RuntimeError("LiveKit AudioSource is niet verbonden.")

        total_frames = (len(pcm) + BYTES_PER_FRAME - 1) // BYTES_PER_FRAME
        zero_frame = b"\x00" * BYTES_PER_FRAME
        last_ptt_heartbeat = time.monotonic()
        for frame_no in range(total_frames):
            target = start_monotonic + (frame_no * FRAME_MS / 1000.0)
            delay = target - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            chunk = pcm[frame_no * BYTES_PER_FRAME:(frame_no + 1) * BYTES_PER_FRAME]
            if len(chunk) < BYTES_PER_FRAME:
                chunk += zero_frame[:BYTES_PER_FRAME - len(chunk)]
            frame = rtc.AudioFrame(
                data=chunk,
                sample_rate=SAMPLE_RATE,
                num_channels=CHANNELS,
                samples_per_channel=SAMPLES_PER_FRAME,
            )
            await self.source.capture_frame(frame)

            # Houd de virtuele sessie/floor tijdens de hele uitzending levend.
            # Dit voorkomt dat een korte tenant-heartbeat-timeout de klok-TX
            # vlak voor de piep op :00 kan vrijgeven.
            if self.floor_token and time.monotonic() - last_ptt_heartbeat >= 2.0:
                await sync_to_async(heartbeat_ptt, thread_sensitive=True)(
                    user=self.radio, session=self.session, floor_token=self.floor_token
                )
                last_ptt_heartbeat = time.monotonic()

    async def run_one_minute(self, target: datetime, pcm: bytes) -> None:
        # Floor aanvragen om :49.30. De audiotrack begint :49.80 met 200 ms stilte,
        # zodat de gesproken zin rond :50.00 start en de piep 10.2 s later op :00 valt.
        stream_wall = target - timedelta(seconds=10.2)
        floor_wall = target - timedelta(seconds=10.7)
        now = datetime.now(self.timezone)
        if floor_wall > now:
            await asyncio.sleep((floor_wall - now).total_seconds())

        await self.connect_media()
        await sync_to_async(_refresh_presence, thread_sensitive=True)(self.radio.pk, self.session.pk)

        floor_deadline = time.monotonic() + max(0.05, (stream_wall - datetime.now(self.timezone)).total_seconds() - 0.02)
        if not await self.request_floor(floor_deadline):
            logger.warning("Testklok slaat %s over: kanaal niet tijdig vrij.", target.isoformat())
            return

        delay = (stream_wall - datetime.now(self.timezone)).total_seconds()
        if delay < -0.25:
            logger.warning("Testklok slaat %s over: timing %.3fs te laat.", target.isoformat(), -delay)
            await self.release_floor()
            return
        if delay > 0:
            await asyncio.sleep(delay)

        logger.info("TX testklok: %s", _clock_text(target))
        start_mono = time.monotonic()
        try:
            await self.stream_pcm(pcm, start_mono)
        finally:
            await self.release_floor()

    async def run(self) -> None:
        await self.connect_media()
        logger.info(
            "Testklok actief: tenant=%s kanaal=%s radio=%s timezone=%s",
            self.tenant.slug, self.channel.slug, self.radio.slug, self.timezone.key,
        )
        while True:
            now = datetime.now(self.timezone)
            target = (now + timedelta(minutes=1)).replace(second=0, microsecond=0)
            # Genoeg tijd reserveren voor TTS-generatie en reconnect. Als het proces
            # vlak voor :50 start, pakken we bewust de minuut daarna.
            if (target - now).total_seconds() < 13:
                target += timedelta(minutes=1)

            text = _clock_text(target)
            try:
                pcm = await asyncio.to_thread(_build_transmission_pcm, text)
                await self.run_one_minute(target, pcm)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Testklokcyclus voor %s mislukt", target.isoformat())
                await self.release_floor()
                await self.close_media()
                await asyncio.sleep(2)


class Command(BaseCommand):
    help = (
        "Start de virtuele radio TESTKLOK. De zin start elke minuut om :50 en "
        "de 1000-Hz piep wordt op de volgende :00 uitgezonden."
    )

    def handle(self, *args, **options):
        tenant, channel, radio, session = _ensure_virtual_radio()
        self.stdout.write(self.style.SUCCESS(
            f"TESTKLOK gereed: tenant={tenant.slug}, kanaal={channel.slug}, radio={radio.slug}"
        ))
        runtime = TestClockRuntime(tenant, channel, radio, session)
        try:
            asyncio.run(runtime.run())
        except KeyboardInterrupt:
            self.stdout.write("Testklok gestopt.")
        finally:
            # Best effort; normale container-stop kan het proces hard beëindigen.
            try:
                if runtime.floor_token:
                    stop_ptt(user=radio, session=session, floor_token=runtime.floor_token)
            except Exception:
                try:
                    force_release_floor(channel=channel, session=session, reason="test_clock_shutdown")
                except Exception:
                    pass
            _mark_offline(radio.pk, session.pk)
