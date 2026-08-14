#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Script de Backup Automatizado de PostgreSQL — Escapes y Más
# ==============================================================================

BACKUP_DIR="${BACKUP_DIR:-/tmp/pg_backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="escapesymas_db_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "${BACKUP_DIR}"

echo "[$(date)] 📦 Iniciando backup de PostgreSQL..."

if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "${DATABASE_URL}" | gzip > "${FILEPATH}"
else
  PGHOST="${PGHOST:-localhost}"
  PGPORT="${PGPORT:-5432}"
  PGUSER="${PGUSER:-postgres}"
  PGDATABASE="${PGDATABASE:-escapesymas}"
  pg_dump -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" "${PGDATABASE}" | gzip > "${FILEPATH}"
fi

FILESIZE=$(du -h "${FILEPATH}" | cut -f1)
echo "[$(date)] ✅ Backup completado exitosamente: ${FILEPATH} (${FILESIZE})"

# Opcional: Subir a AWS S3 o Backblaze B2 si S3_BUCKET está configurado
if [ -n "${S3_BUCKET:-}" ]; then
  echo "[$(date)] ☁️ Subiendo backup a S3 (${S3_BUCKET})..."
  aws s3 cp "${FILEPATH}" "s3://${S3_BUCKET}/db-backups/${FILENAME}"
  echo "[$(date)] ☁️ Backup subido a S3 correctamente."
fi

# Rotación de backups locales (elimina archivos antiguos)
echo "[$(date)] 🧹 Limpiando backups con más de ${RETENTION_DAYS} días..."
find "${BACKUP_DIR}" -name "escapesymas_db_*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" -exec rm -f {} \;
echo "[$(date)] 🎉 Proceso de backup finalizado."
