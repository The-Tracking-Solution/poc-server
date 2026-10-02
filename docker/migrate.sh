#!/bin/sh
set -eu

echo "[1/3] Django migrations"
python manage.py migrate --noinput

echo "[2/3] Initial preload (alleen bij lege applicatie-database)"
python manage.py preload_if_empty

echo "[3/3] Static files"
python manage.py collectstatic --noinput

echo "Database ready. Bestaande configuratie is niet gewijzigd."
