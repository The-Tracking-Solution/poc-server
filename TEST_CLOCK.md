# TESTKLOK – batterijduurtest

Deze build bevat een server-side virtuele radio **Test klok** op kanaal **test klok** (`test-klok`).

## Gedrag

Elke minuut:

- rond `hh:mm:49.30`: de virtuele radio vraagt zendtoestemming aan;
- `hh:mm:49.800`: de mediasource start met 200 ms stilte;
- `hh:mm:50.000`: de zin begint hoorbaar: `Bij de volgende piep is het <dag> <dd> <maand>, <hh> uur <mm> minuten.`;
- `hh:(mm+1):00.000`: 1000-Hz piep, 250 ms;
- daarna wordt PTT/floor direct vrijgegeven.

De virtuele radio gebruikt dezelfde LiveKit-room en dezelfde server-side floor/PTT-logica als een gewone radio. Hij heeft geen browser nodig.

## Starten

Bouw eerst de nieuwe image, omdat deze `livekit` RTC en Piper TTS bevat:

```bash
docker compose build web test-clock
docker compose up -d --force-recreate web
docker compose up -d test-clock
```

Wanneer er exact één tenant bestaat wordt die automatisch gebruikt. Bij meerdere tenants zet je in `.env` bijvoorbeeld:

```env
TEST_CLOCK_TENANT_SLUG=test
```

Daarna:

```bash
docker compose up -d test-clock
```

## Status/log bekijken

```bash
docker compose logs -f test-clock
```

Je ziet onder andere:

```text
TESTKLOK gereed: tenant=test, kanaal=test-klok, radio=test-klok
TX testklok: Bij de volgende piep is het vrijdag 18 november, 23 uur 10 minuten.
```

## Stoppen

```bash
docker compose stop test-clock
```

## Instelbaar via `.env`

```env
TEST_CLOCK_TIMEZONE=Europe/Amsterdam
TEST_CLOCK_SPEECH_WPM=155
TEST_CLOCK_BEEP_HZ=1000
TEST_CLOCK_BEEP_LEVEL=0.32
TEST_CLOCK_VOICE=nl
```

De test-clock service zit in het Compose-profiel `testclock`, maar omdat je de service expliciet met `docker compose up -d test-clock` start hoef je `--profile` niet te gebruiken.
