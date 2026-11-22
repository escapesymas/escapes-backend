#!/usr/bin/env bash
# Prueba automática de PRODUCCIÓN después de un despliegue. Solo hace lecturas: no crea pedidos, cuentas,
# correos ni avisos, y el presupuesto del carrito se calcula sin canjear cupones.
#
#   scripts/factory/smoke-prod.sh [--repo backend|frontend|admin] [--commit <hash>] [--solo-web]
#
#   --repo/--commit  comprueba además que el contenedor de esa app ya corre ese commit.
#   --solo-web       solo lo que se ve desde fuera (sin entrar por SSH al VPS).
#
# Termina con «RESULTADO: todo OK» o «RESULTADO: REVISAR» (y código de salida 1). Léelo siempre: el 21/11/2026
# el registro del reinicio decía «REVISAR» y nadie lo leyó durante un día.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API="${API:-https://api.escapesymas.com}"
TIENDA="${TIENDA:-https://escapesymas.com}"
ADMIN="${ADMIN:-https://admin.escapesymas.com}"
ASESORES="${ASESORES:-https://asesores.escapesymas.com}"
VPS="${VPS:-root@13.140.220.42}"
SSH=(ssh -i "$HOME/.ssh/id_ed25519" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 "$VPS")

REPO=""; COMMIT=""; SOLO_WEB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --commit) COMMIT="$2"; shift 2;;
    --solo-web) SOLO_WEB=1; shift;;
    *) echo "Argumento desconocido: $1"; exit 2;;
  esac
done

FAIL=0
ok()   { echo "  OK    $*"; }
bad()  { echo "  FALLA $*"; FAIL=1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }
body() { curl -s --max-time 30 "$@"; }
# Lo que devuelve «fn» se compara con un código esperado: expect "texto" 200 "$(code url)"
expect() { [[ "$3" == "$2" ]] && ok "$1" || bad "$1 (devolvió $3, se esperaba $2)"; }

echo "· API"
R="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 30 "$API/api/health")"
[[ "${R%% *}" == 200 ]] && ok "la API responde (${R#* } s)" || bad "la API no responde (HTTP ${R%% *})"
body "$API/api/health" | grep -q '"status":"ok"' && ok "/api/health dice «ok»" || bad "/api/health no dice «ok»"

# Un producto real y barato (se elige solo: no depende de que exista uno concreto).
PRODUCTS="$(body "$API/api/catalog/products?limit=20")"
PICK="$(python3 - "$PRODUCTS" <<'PY'
import json, sys
try:
    items = json.loads(sys.argv[1])
except Exception:
    items = []
items = items if isinstance(items, list) else []
# Precio entre 5 y 100 € y con stock: así 200 €/precio da como mucho 40 unidades y el pedido de prueba queda por debajo de 300 €.
for p in items:
    price = p.get('price') or 0
    if p.get('inStock') and 5 <= price <= 100 and p.get('id') and (p.get('slug') or p.get('sku')):
        print(p['id'], p.get('slug') or p.get('sku'))
        break
PY
)"
N="$(python3 -c "import json,sys
try:
    d=json.loads(sys.argv[1]); print(len(d) if isinstance(d,list) else 0)
except Exception: print(0)" "$PRODUCTS")"
[[ "$N" -ge 1 ]] && ok "el catálogo devuelve productos ($N)" || bad "el catálogo no devuelve productos"
COUNT="$(body "$API/api/catalog/sitemap-count" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('total',0))
except Exception: print(0)")"
[[ "$COUNT" -gt 10000 ]] && ok "el sitemap cuenta $COUNT productos" || bad "el sitemap cuenta solo $COUNT productos (se esperaban más de 10.000)"
expect "el feed de Google Shopping existe" 200 "$(code -I "$API/feeds/google.xml")"

echo "· dinero: presupuesto del carrito (envío 19,99 €, gratis desde 200 €)"
if [[ -z "$PICK" ]]; then
  bad "no se encontró un producto con stock y precio entre 5 y 100 € para el presupuesto"
else
  PID="${PICK%% *}"; SLUG="${PICK#* }"
  quote() { curl -s --max-time 40 -X POST "$API/api/cart/quote" -H 'content-type: application/json' \
    -d "{\"cart\":[{\"id\":$PID,\"quantity\":$1}]}"; }
  Q1="$(quote 1)"
  CHECK1="$(python3 - "$Q1" <<'PY'
import json, sys
try:
    q = json.loads(sys.argv[1])
except Exception:
    print("FALLA respuesta que no es JSON"); sys.exit()
msgs = []
if abs(q.get('shipping', -1) - 19.99) > 0.001: msgs.append(f"el envío de un pedido pequeño es {q.get('shipping')} € (debe ser 19,99)")
if q.get('discountPercent') != 0: msgs.append(f"un pedido pequeño lleva {q.get('discountPercent')} % de descuento")
if abs(q.get('total', -1) - (q.get('subtotal', 0) - q.get('discount', 0) + q.get('shipping', 0))) > 0.011: msgs.append("el total no cuadra con subtotal − descuento + envío")
print("FALLA " + "; ".join(msgs) if msgs else f"OK {q.get('subtotal')}")
PY
)"
  if [[ "$CHECK1" == OK* ]]; then
    ok "un pedido pequeño (${CHECK1#OK } €) paga 19,99 € de envío, sin descuento, y el total cuadra"
    UNIT="${CHECK1#OK }"
    QTY="$(python3 -c "import math,sys; print(max(1, math.ceil(200/float(sys.argv[1]))))" "$UNIT")"
    Q2="$(quote "$QTY")"
    CHECK2="$(python3 - "$Q2" <<'PY'
import json, sys
try:
    q = json.loads(sys.argv[1])
except Exception:
    print("FALLA respuesta que no es JSON"); sys.exit()
msgs = []
if not (200 <= q.get('subtotal', 0) < 300): msgs.append(f"subtotal de prueba fuera de 200-300 € ({q.get('subtotal')})")
if q.get('shipping') != 0: msgs.append(f"a partir de 200 € el envío sigue costando {q.get('shipping')} €")
if q.get('discountPercent') != 5: msgs.append(f"entre 200 y 300 € el descuento debería ser 5 % y es {q.get('discountPercent')} %")
if abs(q.get('total', -1) - (q.get('subtotal', 0) - q.get('discount', 0) + q.get('shipping', 0))) > 0.011: msgs.append("el total no cuadra con subtotal − descuento + envío")
print("FALLA " + "; ".join(msgs) if msgs else f"OK {q.get('subtotal')}")
PY
)"
    [[ "$CHECK2" == OK* ]] && ok "un pedido de ${CHECK2#OK } € tiene envío gratis y 5 % de descuento, y el total cuadra" || bad "pedido de 200-300 €: ${CHECK2#FALLA }"
  else
    bad "pedido pequeño: ${CHECK1#FALLA }"
  fi
fi

echo "· tienda"
expect "la portada responde" 200 "$(code "$TIENDA/")"
HOME_HTML="$(body "$TIENDA/")"
[[ "$HOME_HTML" == *"</html>"* ]] && ok "la portada llega completa" || bad "la portada llega cortada"
[[ "$HOME_HTML" != *"Entorno de pruebas"* ]] && ok "la portada NO lleva la etiqueta del entorno de pruebas" || bad "la portada lleva la etiqueta «Entorno de pruebas»: el modo pruebas está activo en producción"
curl -sI --max-time 30 "$TIENDA/" | grep -qi 'x-robots-tag:.*noindex' && bad "la portada manda X-Robots-Tag noindex (Google dejaría de indexarla)" || ok "la portada es indexable (sin noindex)"
ROBOTS="$(body "$TIENDA/robots.txt")"
# Solo cuenta el grupo «User-agent: *» (los bots bloqueados a propósito tienen su propio grupo con «Disallow: /»).
python3 - "$ROBOTS" <<'PY' && ok "robots.txt deja rastrear el sitio a los buscadores (grupo *)" || bad "robots.txt prohíbe todo el sitio a los buscadores (grupo *)"
import sys
group_agents, in_rules, blocked = [], False, False
for raw in sys.argv[1].splitlines():
    line = raw.split('#')[0].strip()
    if not line or ':' not in line:
        continue
    key, val = (x.strip() for x in line.split(':', 1))
    key = key.lower()
    if key == 'user-agent':
        if in_rules:
            group_agents, in_rules = [], False
        group_agents.append(val)
    else:
        in_rules = True
        if key == 'disallow' and val == '/' and '*' in group_agents:
            blocked = True
sys.exit(1 if blocked else 0)
PY
echo "$ROBOTS" | grep -qi '^Sitemap:' && ok "robots.txt anuncia el sitemap" || bad "robots.txt no anuncia el sitemap"
expect "el sitemap responde" 200 "$(code "$TIENDA/sitemap.xml")"
expect "el listado de escapes responde" 200 "$(code "$TIENDA/escapes")"
expect "el carrito/pago responde" 200 "$(code "$TIENDA/checkout")"
if [[ -n "${SLUG:-}" ]]; then
  FICHA="$(body "$TIENDA/producto/$SLUG")"
  [[ "$FICHA" == *"application/ld+json"* ]] && ok "la ficha de un producto responde con sus datos estructurados" || bad "la ficha /producto/$SLUG no responde o no lleva JSON-LD"
fi
body "$TIENDA/api/catalog/sitemap-count" | grep -q '"total"' && ok "la tienda llega a la API (reescritura /api)" || bad "la tienda no llega a la API por /api"

echo "· panel y asesores"
for u in "$ADMIN" "$ASESORES"; do
  H="$(code "$u/")"; B="$(body "$u/")"
  [[ "$H" == 200 && "$B" == *'id="root"'* ]] && ok "$u responde y carga la aplicación" || bad "$u no responde bien (HTTP $H)"
done

if [[ "$SOLO_WEB" == 1 ]]; then
  [[ "$FAIL" == 0 ]] && { echo "RESULTADO: todo OK (solo web)"; exit 0; } || { echo "RESULTADO: REVISAR"; exit 1; }
fi

echo "· servidor (por SSH)"
if ! "${SSH[@]}" true 2>/dev/null; then
  bad "no se pudo entrar por SSH al VPS (fail2ban, clave o red)"
  echo "RESULTADO: REVISAR"; exit 1
fi
PS="$("${SSH[@]}" "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E 'wg90|k11b|tg1d'")"
for pair in "wg90:backend" "k11b:tienda" "tg1d:panel"; do
  pre="${pair%%:*}"; nombre="${pair#*:}"
  L="$(echo "$PS" | grep "^$pre" | head -1)"
  [[ "$L" == *" Up "* ]] && ok "el contenedor del $nombre está en marcha" || bad "el contenedor del $nombre NO está en marcha (${L:-no existe})"
done
[[ "$(echo "$PS" | grep '^wg90')" == *"(healthy)"* ]] && ok "el backend está «healthy»" || bad "el backend no está «healthy»"
if [[ -n "$REPO" && -n "$COMMIT" ]]; then
  case "$REPO" in backend) pre=wg90;; frontend) pre=k11b;; admin) pre=tg1d;; *) pre="";; esac
  echo "$PS" | grep "^$pre" | grep -q ":$COMMIT" && ok "$REPO corre el commit $COMMIT" || bad "$REPO NO corre el commit $COMMIT (sigue el anterior o el despliegue falló)"
fi

# Migraciones: todas las del repositorio (≥ 008, como lib/migrate.ts) deben estar registradas en producción.
MIGS="$(ls "$ROOT/escapes-backend/migrations" 2>/dev/null | grep -E '^[0-9]{3}_.+\.sql$' | awk '{ if (substr($0,1,3)+0 >= 8) print }' | paste -sd, -)"
if [[ -n "$MIGS" ]]; then
  PEND="$("${SSH[@]}" "docker exec -i hk6mt4abfh8ijg2vak6utvz2 sh -c 'psql -U \$POSTGRES_USER -d escapes_db -tA'" <<< "SELECT coalesce(string_agg(f, ' '), '') FROM unnest(string_to_array('$MIGS', ',')) AS f WHERE f NOT IN (SELECT name FROM schema_migrations);" 2>/dev/null)"
  [[ -z "$PEND" ]] && ok "todas las migraciones del repositorio están aplicadas" || bad "migraciones sin aplicar en producción: $PEND"
else
  bad "no se pudo leer la lista de migraciones del repositorio"
fi

# Registro del backend: nada de modo pruebas, caídas ni conexiones rechazadas (el correo caído del 21/11/2026 era ECONNREFUSED).
ERR="$("${SSH[@]}" "docker logs --since 15m \$(docker ps -q -f name=wg90) 2>&1 | grep -iE '\[STAGING\]|uncaught|unhandled ?rejection|ECONNREFUSED|FATAL|Error: connect' | cut -c1-140 | sort | uniq -c | sort -rn | head -5")"
[[ -z "$ERR" ]] && ok "el registro del backend (15 min) no tiene errores graves ni modo pruebas" || { bad "el registro del backend tiene errores graves:"; echo "$ERR" | sed 's/^/          /'; }

# Correo: el backend tiene que poder abrir el puerto 465 de Poste (si no, no sale ningún correo a clientes).
MAIL="$("${SSH[@]}" "docker exec \$(docker ps -q -f name=wg90) node -e 'const s=require(\"net\").connect(465,\"mail.escapesymas.com\");s.setTimeout(5000);s.on(\"connect\",()=>{console.log(\"ok\");process.exit(0)});s.on(\"error\",e=>{console.log(e.code);process.exit(0)});s.on(\"timeout\",()=>{console.log(\"timeout\");process.exit(0)})'")"
[[ "$MAIL" == ok ]] && ok "el backend conecta con el correo (mail.escapesymas.com:465)" || bad "el backend NO conecta con el correo ($MAIL)"

[[ "$FAIL" == 0 ]] && echo "RESULTADO: todo OK" || { echo "RESULTADO: REVISAR"; exit 1; }
