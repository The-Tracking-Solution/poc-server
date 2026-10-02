# Django app `radio`

Mobiele PoC-radiofrontend die de bestaande POC Engine als server-authoritatieve bron gebruikt.

## Installatie
1. Kopieer map `ui_radio/` naar je Django-project.
2. Installeer dependency: `pip install httpx`.
3. Voeg `radio.apps.RadioConfig` toe aan `INSTALLED_APPS`.
4. Voeg toe aan project-urls: `path("ui_radio/", include("ui_radio.urls", namespace="radio"))`.
5. Controleer dat sessions, staticfiles en CSRF middleware actief zijn.

## Settings
```python
POC_ENGINE_BASE_URL = "http://web:8000"  # of externe engine URL
RADIO_TENANT_SLUG = "demoteam"
RADIO_USER_SLUG = "radio01"
RADIO_SECRET_KEY = "..."  # bij voorkeur uit environment
RADIO_DEVICE_IDENTIFIER = "web-radio01"
RADIO_PRIORITY_COUNTDOWN_SECONDS = 5
RADIO_ENGINE_TIMEOUT = 10

# Deze twee routes bestaan niet aantoonbaar in de meegeleverde OpenAPI.
# Configureer ze nadat de engine ze ondersteunt. Placeholders worden vervangen.
RADIO_URGENT_ENDPOINT = "/poc/api/v1/tenants/{tenant_slug}/channels/{channel_slug}/priority/urgent/"
RADIO_EMERGENCY_ENDPOINT = "/poc/api/v1/tenants/{tenant_slug}/channels/{channel_slug}/priority/emergency/"
```

## Belangrijke integratienotitie
De meegeleverde Engine API documenteert login, heartbeat, channels, channel state, PTT request/release, live status en audio-WebSocket. Een afzonderlijk SPOED-endpoint staat niet in de specificatie. Daarom faalt de adapter bewust met HTTP 501 wanneer `RADIO_URGENT_ENDPOINT` of `RADIO_EMERGENCY_ENDPOINT` leeg is. Voeg deze acties server-side toe; implementeer prioriteit niet alleen in JavaScript.

## Gedrag
- 5 seconden aftellen voor SPOED/NOOD, met annuleren.
- Display krijgt dezelfde kleur als de knop.
- Kanaalknoppen worden geblokkeerd tijdens SPOED/NOOD.
- SPOED wordt geblokkeerd tijdens NOOD.
- De eerste succesvolle PTT-aanvraag reset SPOED.
- NOOD blijft actief nadat PTT wordt losgelaten.
- Engine-token blijft server-side in de Django session.

## Productie
Gebruik secrets via environment, HTTPS, secure session cookies en een gedeelde session backend wanneer meerdere webworkers draaien. Voeg live ontvangst/audio toe via `/poc/ws/v1/audio/{tenant_slug}/{channel_slug}/`; de gegenereerde basis bevat de volledige besturingsflow maar geen browser PCM encoder/decoder, omdat het exacte WebSocket frameprotocol niet volledig in de OpenAPI is beschreven.
