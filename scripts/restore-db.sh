#!/bin/sh
set -eu
[ $# -eq 1 ] || { echo "Gebruik: $0 pad/naar/db.dump"; exit 2; }
file="$1"
[ -f "$file" ] || { echo "Bestand niet gevonden: $file"; exit 2; }
cat "$file" | docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'
