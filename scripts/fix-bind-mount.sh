#!/bin/sh
# Reapplies the bind-mount for the production container after Coolify drops it.
#
# Coolify regenerates docker-compose.yaml on every image-tag change, dropping
# any manually-added volumes. This script checks the running container, and
# if it doesn't have the bind mount, force-recreates it with the mount.
# Safe to run repeatedly.
#
# Usage:
#   ./scripts/fix-bind-mount.sh
#
# Run from any host with SSH access to the VPS.

set -e

VPS_IP=${ESCAPES_VPS_IP:-212.227.134.161}
SSH_KEY=${ESCAPES_SSH_KEY:-$HOME/.ssh/id_ed25519}
APP_UUID="wg90ssxowlynpipdyxil35lw"
APP_DIR="/data/coolify/applications/$APP_UUID"
HOST_VOLUME="/data/escapes-uploads"
CONTAINER_PATH="/app/server/uploads"

SSH="ssh -i $SSH_KEY -o BatchMode=yes root@$VPS_IP"

# Find the running container (Coolify uses a random suffix like -222841226875).
CONTAINER=$($SSH "docker ps --filter label=coolify.applicationId=11 --format '{{.Names}}' | head -1")
if [ -z "$CONTAINER" ]; then
  echo "ERROR: no running container found for app $APP_UUID" >&2
  exit 1
fi
echo "Container: $CONTAINER"

# Check whether the bind mount is currently in place.
HAS_MOUNT=$($SSH "docker inspect $CONTAINER --format '{{.HostConfig.Binds}}'" | grep -c "$HOST_VOLUME")
if [ "$HAS_MOUNT" -gt 0 ]; then
  echo "Bind mount already present. Nothing to do."
  exit 0
fi

echo "Bind mount missing. Re-applying..."

# Add the volumes block to docker-compose.yaml right after the last
# coolify.* label (which is the last thing in the service section).
$SSH "cd $APP_DIR && sed -i '/^            - coolify.pullRequestId=0\$/a\\        volumes:\\n            - $HOST_VOLUME:$CONTAINER_PATH' docker-compose.yaml"

# Force-recreate the container. The image tag is unchanged, so Coolify
# won't fight back. Container will be down for ~30-60s during recreate.
$SSH "cd $APP_DIR && docker compose up -d --force-recreate 2>&1 | tail -5"

# Wait for it to come back healthy.
echo "Waiting for healthcheck..."
$SSH "until docker ps --format '{{.Names}} {{.Status}}' | grep -q '$CONTAINER .*healthy'; do sleep 3; done"
echo "OK. Container is back up with bind mount."
