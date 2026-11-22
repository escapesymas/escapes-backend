#!/usr/bin/env bash
# Rehace la base de datos del entorno de pruebas a partir de producción, SIN datos de clientes.
#
# Se ejecuta EN EL VPS, como root (primero se copian los dos ficheros y luego se lanza):
#   scp -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes scripts/staging/refresh-staging-db.sh scripts/staging/seed-staging-users.sql root@13.140.220.42:/root/staging/
#   ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes root@13.140.220.42 'SEED_SQL=/root/staging/seed-staging-users.sql bash /root/staging/refresh-staging-db.sh'
#
# Qué hace:
#   1. Comprueba que el destino es el Postgres de pruebas (no el de producción) y que su base se llama «…staging…».
#   2. Se niega a seguir si en producción hay una tabla que no está clasificada abajo (así una tabla nueva con datos
#      personales nunca se copia por descuido: hay que decidir a mano si es catálogo o es de clientes).
#   3. Vuelve a crear la base de pruebas: estructura de TODAS las tablas + datos solo de las del catálogo y la configuración.
#   4. Refresca las vistas materializadas y crea 2 cuentas de pruebas (administrador y cliente) con contraseñas aleatorias que
#      se guardan en /root/staging-credenciales.txt (modo 600) y NO se imprimen.
# Producción solo se LEE (pg_dump con prioridad mínima). No toca ningún dato de producción.
set -euo pipefail

PROD_PG="${PROD_PG:-hk6mt4abfh8ijg2vak6utvz2}"
PROD_DB="${PROD_DB:-escapes_db}"
STG_PG="${STG_PG:-escapes-staging-db}"
STG_DB="${STG_DB:-escapes_staging}"
CRED_FILE="${CRED_FILE:-/root/staging-credenciales.txt}"
SEED_SQL="${SEED_SQL:-}"   # ruta de seed-staging-users.sql; si va por stdin junto al script, ver el final

# ── Tablas con datos que SÍ se copian: catálogo y configuración, sin datos personales ────────────────────────────
ALLOW=(
  products product_links product_tags product_variation_attributes product_variations product_vehicles
  product_attributes product_attribute_terms attribute_descriptions description_translations name_translations
  categories tags vehicle_models vehicle_brands brand_logos pricing_rules promotions seo_autolinks
  shipping_methods shipping_zones tax_classes tax_rates tax_rules catalog_meta global_settings schema_migrations
)
# ── Tablas que se crean VACÍAS: clientes, pedidos, chats, avisos, cuentas, secretos y copias de seguridad ─────────
DENY=(
  admin_notifications admin_push_tokens agent_announcements agent_invitations agent_legal_acceptances agent_notifications
  ai_chat_sessions app_settings bk_material_promocional_20261003 bk_material_promocional_cats_20261003 cart_abandoned_emails
  carts chat_agents chat_conversations chat_messages chat_orders chat_quick_replies commission_payouts coupons customer_notes
  email_open_tracking email_send_queue forum_likes forum_posts forum_replies garage image_regen_state invoices moto_alert_optout
  moto_alert_seen moto_alerts order_items order_notes orders processed_events product_reviews products_category_backup_20261003
  products_images_backup_all products_images_backup_v3 push_subscriptions refund_requests reviews social_content_calendar
  staff_devices staff_mfa staff_passkeys stock_notifications stripe_webhook_events stripe_webhook_retry_queue users
)
# Vistas materializadas que hay que rellenar después de cargar los datos.
MATVIEWS=(catalog_words compat_vehicle_models)

die() { echo "ERROR: $*" >&2; exit 1; }

# ── 1. Seguridad del destino ─────────────────────────────────────────────────────────────────────────────────
[[ "$STG_PG" != "$PROD_PG" ]] || die "el destino no puede ser el Postgres de producción"
[[ "$STG_DB" == *staging* || "$STG_DB" == *pruebas* ]] || die "la base de destino ($STG_DB) debe llevar «staging» o «pruebas» en el nombre"
[[ "$STG_DB" != "$PROD_DB" ]] || die "la base de destino no puede ser la de producción"
docker inspect -f '{{.State.Running}}' "$STG_PG" 2>/dev/null | grep -q true || die "el contenedor $STG_PG no existe o no está en marcha"

PROD_USER="$(docker exec "$PROD_PG" printenv POSTGRES_USER)"
STG_USER="$(docker exec "$STG_PG" printenv POSTGRES_USER)"
prod_psql() { docker exec -i "$PROD_PG" psql -U "$PROD_USER" -d "$PROD_DB" -v ON_ERROR_STOP=1 -tA "$@"; }
stg_psql()  { docker exec -i "$STG_PG"  psql -U "$STG_USER"  -d "${STG_DB_CONN:-postgres}" -v ON_ERROR_STOP=1 -tA "$@"; }

# ── 2. Toda tabla de producción debe estar clasificada ───────────────────────────────────────────────────────
KNOWN=" ${ALLOW[*]} ${DENY[*]} "
UNKNOWN=()
while IFS= read -r t; do
  [[ -z "$t" ]] && continue
  [[ "$KNOWN" == *" $t "* ]] || UNKNOWN+=("$t")
done < <(prod_psql -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
if ((${#UNKNOWN[@]})); then
  die "hay tablas en producción sin clasificar: ${UNKNOWN[*]}. Añádelas a ALLOW (catálogo/configuración) o a DENY (clientes/secretos) en este script."
fi

# ── 3. Recrear la base de pruebas ────────────────────────────────────────────────────────────────────────────
echo "[1/4] Recreando $STG_DB en $STG_PG…"
stg_psql -c "DROP DATABASE IF EXISTS \"$STG_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$STG_DB\""
export STG_DB_CONN="$STG_DB"

echo "[2/4] Copiando la estructura (todas las tablas, vacías)…"
docker exec "$PROD_PG" nice -n 19 pg_dump -U "$PROD_USER" -d "$PROD_DB" --schema-only --no-owner --no-privileges \
  | stg_psql -q -f - >/dev/null

echo "[3/4] Copiando los datos del catálogo y la configuración (${#ALLOW[@]} tablas)…"
T_ARGS=(); for t in "${ALLOW[@]}"; do T_ARGS+=(-t "public.$t"); done
docker exec "$PROD_PG" nice -n 19 pg_dump -U "$PROD_USER" -d "$PROD_DB" --data-only --no-owner --disable-triggers "${T_ARGS[@]}" \
  | stg_psql -q -f - >/dev/null

echo "[4/4] Refrescando vistas y creando las cuentas de pruebas…"
for mv in "${MATVIEWS[@]}"; do stg_psql -c "REFRESH MATERIALIZED VIEW $mv" >/dev/null; done
stg_psql -c "ANALYZE" >/dev/null

# ── 4. Cuentas de pruebas (contraseñas aleatorias, nunca se imprimen) ────────────────────────────────────────
if [[ -n "$SEED_SQL" && -f "$SEED_SQL" ]]; then
  gen() { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 18; }
  ADMIN_PW="$(gen)"; CLIENTE_PW="$(gen)"
  # Se conservan las líneas de acceso a las webs (las escribe deploy-staging.sh); solo se renuevan las de las cuentas.
  KEEP="$(grep -E '^(web:|# Entorno de pruebas — acceso)' "$CRED_FILE" 2>/dev/null || true)"
  ( umask 177
    { if [[ -n "$KEEP" ]]; then echo "$KEEP"; fi
      echo "# Entorno de pruebas — cuentas creadas el $(date -u +%F\ %T) UTC (se renuevan cada vez que se rehace la base)"
      echo "admin@pruebas.invalid   $ADMIN_PW"
      echo "cliente@pruebas.invalid $CLIENTE_PW"; } > "$CRED_FILE.new" )
  mv "$CRED_FILE.new" "$CRED_FILE"; chmod 600 "$CRED_FILE"
  { printf "\\\\set admin_pw '%s'\n\\\\set cliente_pw '%s'\n" "$ADMIN_PW" "$CLIENTE_PW"; cat "$SEED_SQL"; } | stg_psql -q -f - >/dev/null
  echo "Cuentas de pruebas creadas. Credenciales en $CRED_FILE (solo root)."
else
  echo "AVISO: sin SEED_SQL no se han creado cuentas de pruebas."
fi

echo "Resumen de la base de pruebas:"
stg_psql -c "SELECT 'productos='||(SELECT count(*) FROM products)||' categorías='||(SELECT count(*) FROM categories)||' usuarios='||(SELECT count(*) FROM users)||' pedidos='||(SELECT count(*) FROM orders)"
