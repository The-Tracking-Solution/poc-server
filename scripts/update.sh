#!/bin/sh
set -eu
docker compose build --pull
docker compose up -d --remove-orphans
docker image prune -f
docker compose ps
