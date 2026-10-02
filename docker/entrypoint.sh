#!/bin/sh
set -eu
wait_for_host() { host="$1"; port="$2"; name="$3"; echo "Wachten op ${name} (${host}:${port})..."; until nc -z "$host" "$port"; do sleep 1; done; }
[ "${DB_ENGINE:-django.db.backends.postgresql}" = "django.db.backends.sqlite3" ] || wait_for_host "${DB_HOST:-db}" "${DB_PORT:-5432}" PostgreSQL
[ "${CHANNEL_LAYER_BACKEND:-channels_redis.core.RedisChannelLayer}" = "channels.layers.InMemoryChannelLayer" ] || wait_for_host "${REDIS_HOST:-redis}" "${REDIS_PORT:-6379}" Redis
if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then python manage.py migrate --noinput; fi
if [ "${RUN_COLLECTSTATIC:-0}" = "1" ]; then python manage.py collectstatic --noinput; fi
python manage.py check --deploy
exec "$@"
