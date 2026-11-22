#!/usr/bin/env bash
# Despliega (o actualiza) el entorno de pruebas en el VPS: https://pruebas.escapesymas.com y https://admin.pruebas.escapesymas.com.
#
# Uso, desde este directorio del repo del backend (copia los ficheros y lo lanza; no pide nada a producción):
#   scp -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes scripts/staging/{deploy-staging.sh,refresh-staging-db.sh,seed-staging-users.sql,docker-compose.staging.yml} root@13.140.220.42:/root/staging/
#   ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes root@13.140.220.42 'bash /root/staging/deploy-staging.sh [--refresh-db] [--no-build]'
#
#   --refresh-db  rehace la base de pruebas desde producción (catálogo y configuración, sin datos de clientes) y renueva las cuentas.
#   --no-build    no recompila las imágenes (solo reinicia con lo que haya).
#   BRANCH=…      rama a desplegar (por defecto mejoras/2026-10: lo que aún NO está en main).
#
# Qué hace: clona/actualiza los 3 repos (HTTPS, son públicos), crea una sola vez /root/staging/.env (secretos aleatorios) y
# /root/staging-credenciales.txt (modo 600), compila, levanta el compose y comprueba que el entorno está aislado.
# NUNCA imprime una contraseña. Producción solo se lee (la copia de la base) y a Traefik solo se le conecta la red de pruebas.
set -euo pipefail

DIR=/root/staging
BRANCH="${BRANCH:-mejoras/2026-10}"
GH=https://github.com/escapesymas
CRED=/root/staging-credenciales.txt
REFRESH=0; BUILD=1
for a in "$@"; do case "$a" in --refresh-db) REFRESH=1;; --no-build) BUILD=0;; *) echo "opción desconocida: $a" >&2; exit 2;; esac; done

die() { echo "ERROR: $*" >&2; exit 1; }
cd "$DIR" || die "falta $DIR (cópiale primero los ficheros de scripts/staging)"
mkdir -p src

# ── 1. Código: clones poco profundos de la rama a probar ────────────────────────────────────────────────────────
for pair in backend:escapes-backend frontend:escapes-frontend admin:escapes-admin; do
  name="${pair%%:*}"; repo="${pair##*:}"
  if [[ -d "src/$name/.git" ]]; then
    git -C "src/$name" fetch -q --depth 1 origin "$BRANCH" && git -C "src/$name" reset -q --hard FETCH_HEAD && git -C "src/$name" clean -qfd -e Dockerfile.staging
  else
    git clone -q --depth 1 --branch "$BRANCH" "$GH/$repo.git" "src/$name"
  fi
  echo "· $repo @ $(git -C "src/$name" rev-parse --short HEAD) ($BRANCH)"
done
# La tienda necesita ARG para que Next incruste las variables NEXT_PUBLIC_* al compilar. Se añaden en una copia del Dockerfile
# (el de producción no se toca: Coolify ya inyecta sus propias variables de compilación).
awk '{print} /^COPY \. \.$/ && !d {print "ARG NEXT_PUBLIC_APP_ENV\nARG NEXT_PUBLIC_API_URL\nARG NEXT_PUBLIC_SITE_URL\nARG API_URL"; d=1}' \
  src/frontend/Dockerfile > src/frontend/Dockerfile.staging
grep -q '^ARG NEXT_PUBLIC_APP_ENV' src/frontend/Dockerfile.staging || die "no pude añadir los ARG al Dockerfile de la tienda"

# ── 2. Secretos del entorno de pruebas (una sola vez) ───────────────────────────────────────────────────────────
gen() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
# Contraseña de acceso a las webs (Traefik): el hash va a .env y la contraseña, al fichero de credenciales (nunca se imprime).
new_web_auth() {
  local pw hash; pw="$(gen 16)"; hash="$(openssl passwd -apr1 "$pw")"
  ( umask 177
    { grep -v '^STAGING_BASIC_AUTH=' .env 2>/dev/null || true; echo "STAGING_BASIC_AUTH='pruebas:$hash'"; } > .env.new
    { grep -v -E '^(web:|# Entorno de pruebas — acceso)' "$CRED" 2>/dev/null || true
      echo "# Entorno de pruebas — acceso a las webs (usuario y contraseña de Traefik), creado el $(date -u +%F) UTC"
      echo "web: pruebas / $pw"; } > "$CRED.new" )
  mv .env.new .env; mv "$CRED.new" "$CRED"
}
if [[ ! -f .env ]]; then
  ( umask 177; { echo "STAGING_DB_PASSWORD=$(gen 28)"; echo "STAGING_JWT_SECRET=$(gen 64)"; } > .env )
  new_web_auth
  echo "· Secretos creados en $DIR/.env y credenciales en $CRED (solo root)."
elif ! grep -q '^web:' "$CRED" 2>/dev/null; then
  new_web_auth
  echo "· Faltaba la contraseña de las webs en $CRED: se ha generado una nueva (solo root)."
fi
chmod 600 .env "$CRED" 2>/dev/null || true

# ── 3. Base de datos y Redis; base de pruebas si no existe ──────────────────────────────────────────────────────
export COMPOSE_PARALLEL_LIMIT=1
docker compose -f docker-compose.staging.yml up -d db redis
for i in $(seq 1 30); do [[ "$(docker inspect -f '{{.State.Health.Status}}' escapes-staging-db)" == healthy ]] && break; sleep 2; done
HAS_DB="$(docker exec escapes-staging-db psql -U staging -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='escapes_staging'")"
if [[ "$REFRESH" == 1 || -z "$HAS_DB" ]]; then
  docker compose -f docker-compose.staging.yml stop backend >/dev/null 2>&1 || true
  SEED_SQL="$DIR/seed-staging-users.sql" bash "$DIR/refresh-staging-db.sh"
fi

# ── 4. Imágenes y arranque ──────────────────────────────────────────────────────────────────────────────────────
if [[ "$BUILD" == 1 ]]; then
  # De uno en uno y con prioridad mínima: el VPS comparte CPU con producción.
  for s in backend admin frontend; do echo "· compilando $s…"; nice -n 19 docker compose -f docker-compose.staging.yml build "$s"; done
fi
docker compose -f docker-compose.staging.yml up -d
# Traefik (coolify-proxy) tiene que estar en la red de pruebas para publicar la tienda y el panel. Si Coolify recrea el proxy, repetir esto.
docker network connect escapes-staging coolify-proxy 2>/dev/null || true

# ── 5. Comprobaciones de aislamiento ────────────────────────────────────────────────────────────────────────────
echo "· comprobando…"
FAIL=0; ok() { echo "  OK   $*"; }; bad() { echo "  FALLA $*"; FAIL=1; }
for c in escapes-staging-backend escapes-staging-frontend escapes-staging-admin escapes-staging-db escapes-staging-redis; do
  nets="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c")"
  [[ "$nets" == "escapes-staging " ]] && ok "$c solo está en la red de pruebas" || bad "$c está en redes: $nets"
done
[[ "$(docker network inspect -f '{{.Internal}}' escapes-staging)" == true ]] && ok "la red de pruebas no tiene salida a Internet" || bad "la red de pruebas NO es interna"
docker exec escapes-staging-backend node -e "fetch('https://api.mybihr.com/').then(()=>process.exit(1),()=>process.exit(0))" && ok "el backend no puede salir a Internet" || bad "el backend SÍ salió a Internet"
for i in $(seq 1 40); do [[ "$(docker inspect -f '{{.State.Health.Status}}' escapes-staging-backend)" == healthy ]] && break; sleep 3; done
[[ "$(docker inspect -f '{{.State.Health.Status}}' escapes-staging-backend)" == healthy ]] && ok "el backend está sano" || bad "el backend no está sano (docker logs escapes-staging-backend)"
docker logs escapes-staging-backend 2>&1 | grep -q "Modo pruebas activo" && ok "el backend arrancó en modo pruebas" || bad "el backend no dice «Modo pruebas activo»"
echo "· URLs: https://pruebas.escapesymas.com  https://admin.pruebas.escapesymas.com  (usuario y contraseña en $CRED)"
[[ "$FAIL" == 0 ]] && echo "RESULTADO: todo OK" || { echo "RESULTADO: REVISAR"; exit 1; }
