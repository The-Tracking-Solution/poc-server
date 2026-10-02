#!/bin/sh
set -eu
cd "$(dirname "$0")"

echo "[1/3] Django deployment checks"
docker compose exec -T web python manage.py check --deploy

echo "[2/3] Verify seeded test tenant"
docker compose exec -T web python manage.py verify_test_tenant

echo "[3/3] Django test suite"
docker compose exec -T web python manage.py test engine_main engine_radio engine_dispatch engine_poc ui_radio ui_dispatch --verbosity 2
