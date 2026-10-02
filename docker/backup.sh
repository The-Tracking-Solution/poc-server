#!/bin/sh
set -eu
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /backups
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "/backups/db-${stamp}.dump"
tar -czf "/backups/media-${stamp}.tar.gz" -C /media .
find /backups -type f -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
