#!/bin/sh
# Starts the v5 image downloader sidecar.
#
# The sidecar runs in a SEPARATE container (not managed by Coolify), binds the
# host volume /data/escapes-uploads:/app/server/uploads, and runs the downloader
# in a loop. It survives Coolify redeploys of the production container.
#
# Usage:
#   ./scripts/start-image-downloader-sidecar.sh                 # start
#   ./scripts/start-image-downloader-sidecar.sh --stop          # stop
#   ./scripts/start-image-downloader-sidecar.sh --status        # status
#
# Environment expectations (set by the calling shell):
#   - SSH access to the VPS (root@212.227.134.161)
#   - Backend image already built on the VPS (tag = wg90ssxowlynpipdyxil35lw:<sha>)
#   - Host volume /data/escapes-uploads already exists and is writable
#
# This script is intended to be run from your LOCAL machine (or another host
# with SSH access), not from inside the VPS.

set -e

VPS_IP=${ESCAPES_VPS_IP:-212.227.134.161}
SSH_KEY=${ESCAPES_SSH_KEY:-$HOME/.ssh/id_ed25519}
SIDECAR_NAME="escapes-image-dl-sidecar"
SIDECAR_LOG="/data/escapes-uploads/image-dl-sidecar.log"
APP_UUID="wg90ssxowlynpipdyxil35lw"

SSH="ssh -i $SSH_KEY -o BatchMode=yes root@$VPS_IP"

# Get the latest production image tag from the compose file.
# Falls back to the running container's image if compose is missing it.
IMAGE_TAG=$($SSH "cd /data/coolify/applications/$APP_UUID && grep -oE 'image: .+' docker-compose.yaml | head -1 | sed 's|image: ||;s|[\"'\'']||g'")
if [ -z "$IMAGE_TAG" ]; then
  IMAGE_TAG=$($SSH "docker inspect $APP_UUID-222841226875 --format '{{.Config.Image}}' 2>/dev/null || echo ''")
fi
if [ -z "$IMAGE_TAG" ]; then
  echo "ERROR: could not determine image tag on VPS" >&2
  exit 1
fi
echo "Using image: $IMAGE_TAG"

case "${1:-}" in
  --stop)
    $SSH "docker rm -f $SIDECAR_NAME 2>&1 || true; echo 'Sidecar stopped.'"
    ;;
  --status)
    $SSH "docker ps --filter name=$SIDECAR_NAME --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' || true"
    $SSH "tail -10 $SIDECAR_LOG 2>/dev/null || echo 'No log yet.'"
    ;;
  --restart)
    $SSH "docker rm -f $SIDECAR_NAME 2>&1 || true"
    ;&
  *)
    # Pull env from the production container's env file so the sidecar has
    # DATABASE_URL, REDIS_URL, BIHR_*, etc.
    ENV_FILE="/data/coolify/applications/$APP_UUID/.env"
    echo "Starting sidecar..."
    $SSH "docker run -d \
      --name $SIDECAR_NAME \
      --restart unless-stopped \
      --network coolify \
      -v /data/escapes-uploads:/app/server/uploads \
      --env-file $ENV_FILE \
      -e SOURCE_COMMIT=${IMAGE_TAG##*:} \
      -e NODE_ENV=production \
      --log-driver json-file \
      --log-opt max-size=10m \
      --log-opt max-file=3 \
      --entrypoint /bin/sh \
      $IMAGE_TAG \
      -c 'touch $SIDECAR_LOG && /app/server/scripts/image-downloader-loop.sh' 2>&1 | tee -a $SIDECAR_LOG"
    echo "Sidecar started. Logs: tail -f $SIDECAR_LOG on VPS"
    ;;
esac
