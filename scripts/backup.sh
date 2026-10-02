#!/bin/sh
set -eu
docker compose --profile tools run --rm backup
