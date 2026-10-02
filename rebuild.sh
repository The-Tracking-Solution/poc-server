#!/usr/bin/env bash

set -e

cd /opt/lifeguardmeldkamer

echo "==> Containers stoppen..."
docker compose stop web migrate

echo "==> Containers verwijderen..."
docker compose rm -f web migrate

echo "==> Oude image verwijderen..."
docker image rm -f meldkamer-app:local || true

echo "==> Docker build cache opruimen..."
docker builder prune -af

echo "==> Nieuwe images bouwen..."
docker compose build --no-cache --pull migrate web

echo "==> Migraties uitvoeren..."
docker compose run --rm migrate

echo "==> Containers starten..."
docker compose up -d

echo "==> Static files verzamelen..."
docker compose exec web python manage.py collectstatic --noinput --clear

echo "==> Web container herstarten..."
docker compose restart web

echo "==> Deploy voltooid!"