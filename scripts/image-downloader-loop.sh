#!/bin/sh
# Sidecar wrapper for the v5 image downloader.
# Runs the downloader in a loop, catching any new products that get NULL'd
# (e.g. by resets, or when new products are added without images).
#
# Why: when the production container is redeployed by Coolify, in-flight
# downloader runs are killed. Running this in a sidecar that's bound to the
# persistent host volume (/data/escapes-uploads) keeps the work going across
# production redeploys.
#
# The --recheck-files flag is run on every iteration so that any product still
# missing a file on disk gets reset and re-downloaded. This handles the case
# where the bind mount is empty (e.g., a host-level accident) — the recovery
# is automatic.

set -e

NODE_DIR=/app/server
SCRIPT="$NODE_DIR/scripts/download-images-from-zip.ts"
OPTIMIZED_DIR="$NODE_DIR/uploads/optimized"
LOG_FILE="$NODE_DIR/uploads/image-dl-sidecar.log"

# Wait for the DB to be reachable. The sidecar may start before the
# production container's /data/escapes-uploads/* has been populated by the
# startup hook in the production container — but that's OK because the
# downloader reads CSVs from disk, not from the production container.
echo "[SIDECAR] Waiting for CSVs in $NODE_DIR/uploads/catalog-csv ..."
while [ ! -d "$NODE_DIR/uploads/catalog-csv" ] || [ -z "$(ls -A "$NODE_DIR/uploads/catalog-csv" 2>/dev/null | grep -c '\.csv$')" ]; do
  sleep 5
done
CSV_COUNT=$(ls "$NODE_DIR/uploads/catalog-csv"/*.csv 2>/dev/null | wc -l)
echo "[SIDECAR] Found $CSV_COUNT CSV files. Starting downloader loop."

cd "$NODE_DIR"

# Loop forever — the script is idempotent (only picks products with no image).
# --recheck-files every ~5th iteration to catch any host-level file loss.
ITER=0
while true; do
  ITER=$((ITER + 1))
  RECHECK=""
  if [ $((ITER % 5)) -eq 0 ]; then
    RECHECK="--recheck-files"
    echo "[SIDECAR] iter $ITER: running with --recheck-files (periodic file scan)"
  else
    echo "[SIDECAR] iter $ITER: starting downloader"
  fi

  if npx tsx "$SCRIPT" --batch=300 --concurrency=4 --csv-dir="$NODE_DIR/uploads/catalog-csv" --all $RECHECK 2>&1 | tee -a "$LOG_FILE"; then
    echo "[SIDECAR] iter $ITER: downloader completed"
  else
    echo "[SIDECAR] iter $ITER: downloader failed (exit $?), will retry"
  fi

  # Sleep before next iteration to avoid hammering the DB if there's nothing to do.
  sleep 30
done
