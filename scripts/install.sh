#!/bin/sh
set -eu
[ -f .env ] || { cp .env.example .env; echo "Pas .env aan en start dit script opnieuw."; exit 1; }
docker compose pull db redis proxy || true
docker compose build --pull
docker compose up -d
docker compose ps
