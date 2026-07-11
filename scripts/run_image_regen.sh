#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/var/log/image-regen.log"

echo "[$(date -Iseconds)] START - regenerating images" >> "$LOG"

set -a
source "$SCRIPT_DIR/.env"
set +a

python3 "$SCRIPT_DIR/regenerate_images.py" --batch 50 --delay 0.5 >> "$LOG" 2>&1
EXIT_CODE=$?

echo "[$(date -Iseconds)] END - exit=$EXIT_CODE" >> "$LOG"
exit $EXIT_CODE