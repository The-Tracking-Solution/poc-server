#!/bin/sh
set -eu
interval="${POC_SWEEP_INTERVAL_SECONDS:-1}"
while true; do
  python manage.py poc_sweep || true
  sleep "$interval"
done
