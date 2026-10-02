# Testklok autostart

De `test-clock` service draait nu standaard mee met de Compose-stack.

Bij start maakt de service indien nodig automatisch aan:
- kanaal `test-klok`
- profiel `test-klok`
- virtuele radio `test-klok` / `Test klok`

Start/upgrade:

```bash
docker compose up -d --build --force-recreate web test-clock
```

Controle:

```bash
docker compose ps test-clock
docker compose logs -f test-clock
```

Bij meerdere tenants moet `TEST_CLOCK_TENANT_SLUG` in `.env` zijn ingesteld.
