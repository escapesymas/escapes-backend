#!/bin/bash
# /usr/local/bin/escapes-post-deploy.sh
#
# Hook post-deploy para todas las apps de Coolify (escapes-*).
# Debe ejecutarse en el HOST (no dentro de un contenedor), porque manipula
# la red Docker y la config de Traefik del proxy de Coolify.
#
# Si se ejecuta dentro de un contenedor (sin acceso a `docker`), sale con 0
# para que el hook de Coolify no marque el deploy como fallido. El cron del
# host (`/etc/cron.d/escapes-post-deploy`) hace el trabajo real cada 5 min.

set -e

# --- Modo contenedor: no-op seguro ---
if ! command -v docker >/dev/null 2>&1; then
  echo "[escapes-post-deploy] docker no disponible (¿dentro de un contenedor?) — saliendo OK"
  echo "[escapes-post-deploy] el cron del host (/etc/cron.d/escapes-post-deploy) actualizará el proxy"
  exit 0
fi

LOG_FILE="/var/log/escapes-post-deploy.log"
NETWORK="coolify"
BACKEND_UUID="wg90ssxowlynpipdyxil35lw"
FRONTEND_UUID="k11bvrk0fa8e83hg4i61e4w3"
ADMIN_UUID="tg1dkuljg665aer4aqk26500"
REDIS_UUID="lds0q4sjfbo3hpiqitjm0pxb"
DB_UUID="hk6mt4abfh8ijg2vak6utvz2"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

get_container_name() {
  local uuid="$1"
  docker ps --format '{{.Names}}' | grep -E "^${uuid}(-[0-9]+)?$" | head -1
}

add_aliases() {
  local container="$1"
  shift
  local aliases=("$@")

  if [ -z "$container" ]; then
    return
  fi
  if ! docker inspect "$container" >/dev/null 2>&1; then
    log "WARN: container $container not found"
    return
  fi

  local current_aliases
  current_aliases=$(docker inspect "$container" --format '{{json .NetworkSettings.Networks.coolify.DNSNames}}' 2>/dev/null)

  local alias_args=""
  local new_aliases_log=""
  for alias in "${aliases[@]}"; do
    if ! echo "$current_aliases" | grep -q "\"$alias\""; then
      alias_args="$alias_args --alias $alias"
      new_aliases_log="$new_aliases_log $alias"
    fi
  done

  if [ -z "$alias_args" ]; then
    return
  fi

  log "Adding aliases${new_aliases_log} to $container"
  docker network disconnect "$NETWORK" "$container" 2>/dev/null || true
  eval "docker network connect $alias_args $NETWORK $container" 2>/dev/null || true
}

update_traefik() {
  local backend_container
  backend_container=$(get_container_name "$BACKEND_UUID")
  local frontend_container
  frontend_container=$(get_container_name "$FRONTEND_UUID")
  local admin_container
  admin_container=$(get_container_name "$ADMIN_UUID")
  local http_yaml="/data/coolify/proxy/dynamic/http.yaml"

  if [ ! -f "$http_yaml" ]; then
    log "WARN: $http_yaml not found"
    return
  fi

  if [ -n "$backend_container" ]; then
    sed -i "s|http://wg90ssxowlynpipdyxil35lw-[0-9]*:3001|http://$backend_container:3001|g" "$http_yaml"
  fi
  if [ -n "$frontend_container" ]; then
    sed -i "s|http://k11bvrk0fa8e83hg4i61e4w3-[0-9]*:3000|http://$frontend_container:3000|g" "$http_yaml"
  fi
  if [ -n "$admin_container" ]; then
    sed -i "s|http://tg1dkuljg665aer4aqk26500-[0-9]*:80|http://$admin_container:80|g" "$http_yaml"
  fi

  docker exec coolify-proxy kill -SIGHUP 1 2>/dev/null || true
  log "Traefik config updated and reloaded"
}

log "==== Post-deploy started ===="

BACKEND=$(get_container_name "$BACKEND_UUID")
FRONTEND=$(get_container_name "$FRONTEND_UUID")
ADMIN=$(get_container_name "$ADMIN_UUID")
REDIS_CONTAINER=$(get_container_name "$REDIS_UUID")
DB_CONTAINER=$(get_container_name "$DB_UUID")

log "Backend: $BACKEND"
log "Frontend: $FRONTEND"
log "Admin: $ADMIN"
log "Redis: $REDIS_CONTAINER"
log "Database: $DB_CONTAINER"

add_aliases "$BACKEND" "backend" "escapes-backend"
add_aliases "$FRONTEND" "frontend" "escapes-frontend"
add_aliases "$ADMIN" "admin" "escapes-admin"
add_aliases "$REDIS_CONTAINER" "redis" "escapes-redis"
add_aliases "$DB_CONTAINER" "postgres" "escapes-db" "db"

update_traefik

log "==== Post-deploy completed ===="
