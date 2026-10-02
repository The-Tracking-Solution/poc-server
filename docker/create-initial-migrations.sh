#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
image_name="tts-poc-clean-migrations"

echo "Dockerimage bouwen voor de verse initiële migraties..."
docker build -t "$image_name" "$project_dir"

echo "Initiële migraties in de bronmap genereren..."
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$project_dir:/app" \
  --workdir /app \
  --entrypoint python \
  "$image_name" \
  manage.py makemigrations engine_main engine_poc engine_radio engine_dispatch

echo "Klaar. Controleer en bewaar de nieuwe migratiebestanden vóór de eerste start."
