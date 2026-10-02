# Test tijd-radio

Virtuele server-side radio voor batterij- en duurtesten.

- Kanaal: `test-klok`
- Radio: `Test klok` (`test-klok`)
- Profiel: `Test klok` (`test-klok`)
- Spraak start elke minuut omstreeks `:50`.
- De aangekondigde tijd is de volgende volle minuut.
- 1000 Hz piep start exact op `:00` en duurt standaard 250 ms.
- Daarna wordt PTT vrijgegeven.
- De LiveKit-verbinding blijft tussen uitzendingen bestaan.
- De worker houdt DeviceSession en PTT-floor tijdens de uitzending actief.
- Herstarten is idempotent: bestaande kanaal/profiel/radio/sessie worden hergebruikt.

Configuratie via `.env`:

```env
TEST_CLOCK_TENANT_SLUG=test
TEST_CLOCK_TIMEZONE=Europe/Amsterdam
TEST_CLOCK_VOICE=nl
TEST_CLOCK_SPEECH_WPM=155
TEST_CLOCK_BEEP_HZ=1000
TEST_CLOCK_BEEP_LEVEL=0.32
```

Bij precies één tenant mag `TEST_CLOCK_TENANT_SLUG` leeg blijven.
Bij meerdere tenants moet de slug expliciet worden ingesteld.

Starten/controleren:

```bash
docker compose up -d --build test-clock
docker compose logs -f test-clock
```
