#!/bin/sh
set -eu

cd "$(dirname "$0")"

printf '\n*** WARNING ***\n'
printf 'This removes ALL Docker volumes for compose project "meldkamer".\n'
printf 'PostgreSQL, Redis, media and static data will be deleted.\n\n'

if [ "${1:-}" != "--yes" ]; then
    printf 'Run again with: ./clean-install.sh --yes\n'
    exit 2
fi

echo "[1/6] Stop and remove old stack + volumes"
docker compose down --volumes --remove-orphans || true

echo "[2/6] Remove old locally-built compose images"
docker compose down --rmi local --remove-orphans || true

echo "[3/6] Build clean images"
docker compose build --no-cache

echo "[4/6] Start stack"
docker compose up -d

echo "[5/6] Verify containers and seeded configuration"
docker compose ps
docker compose exec -T web python manage.py verify_test_tenant

echo "[6/6] Run automated tests"
docker compose exec -T web python manage.py test engine_main engine_radio engine_dispatch engine_poc ui_radio ui_dispatch --verbosity 1

echo
echo "CLEAN INSTALL OK"
echo "Tenant: test"
echo "Users: admin / soft / te320 / dispatch"
echo "Password: poc2026"
echo "Radio URL: https://lifeguardmeldkamer.nl/radio/test/"
