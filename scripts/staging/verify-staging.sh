#!/usr/bin/env bash
# Comprueba, desde el propio VPS, que el entorno de pruebas ya desplegado funciona Y sigue aislado. No imprime contraseñas.
#   ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes root@13.140.220.42 'bash /root/staging/verify-staging.sh'
set -uo pipefail
CRED="${CRED:-/root/staging-credenciales.txt}"
WEB_PW="$(awk '/^web:/ {print $4}' "$CRED")"
ADMIN_PW="$(awk '/^admin@pruebas.invalid/ {print $2}' "$CRED" | tail -1)"
CLIENTE_PW="$(awk '/^cliente@pruebas.invalid/ {print $2}' "$CRED" | tail -1)"
TIENDA=https://pruebas.escapesymas.com
PANEL=https://admin.pruebas.escapesymas.com
FAIL=0
ok()  { echo "  OK    $*"; }
bad() { echo "  FALLA $*"; FAIL=1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }
body() { curl -s --max-time 30 "$@"; }

echo "· acceso (contraseña de Traefik)"
[[ "$(code "$TIENDA/")" == 401 ]] && ok "la tienda sin contraseña da 401" || bad "la tienda sin contraseña NO da 401"
[[ "$(code "$PANEL/")" == 401 ]] && ok "el panel sin contraseña da 401" || bad "el panel sin contraseña NO da 401"
[[ "$(code -u "pruebas:$WEB_PW" "$TIENDA/")" == 200 ]] && ok "la tienda con contraseña da 200" || bad "la tienda con contraseña no da 200"
[[ "$(code -u "pruebas:$WEB_PW" "$PANEL/")" == 200 ]] && ok "el panel con contraseña da 200" || bad "el panel con contraseña no da 200"

echo "· no indexable"
body -u "pruebas:$WEB_PW" "$TIENDA/robots.txt" | grep -q "Disallow: /" && ok "robots.txt de la tienda prohíbe todo" || bad "robots.txt de la tienda no prohíbe todo"
curl -sI -u "pruebas:$WEB_PW" "$TIENDA/" | grep -qi "x-robots-tag: noindex" && ok "la tienda manda X-Robots-Tag noindex" || bad "la tienda no manda noindex"
curl -sI -u "pruebas:$WEB_PW" "$PANEL/" | grep -qi "x-robots-tag: noindex" && ok "el panel manda X-Robots-Tag noindex" || bad "el panel no manda noindex"
body -u "pruebas:$WEB_PW" "$TIENDA/" | grep -qi "Entorno de pruebas" && ok "la tienda muestra la etiqueta «Entorno de pruebas»" || bad "la tienda no muestra la etiqueta"

echo "· funciona (datos copiados, sin clientes)"
N="$(body -u "pruebas:$WEB_PW" "$TIENDA/api/catalog/products?limit=1" | tr -d '\n' | grep -o '"id"' | wc -l)"
[[ "$N" -ge 1 ]] && ok "el catálogo responde con productos a través de la tienda" || bad "el catálogo no devuelve productos"
COUNTS="$(docker exec escapes-staging-db psql -U staging -d escapes_staging -tAc "SELECT (SELECT count(*) FROM products)||' productos, '||(SELECT count(*) FROM users)||' usuarios, '||(SELECT count(*) FROM orders)||' pedidos, '||(SELECT count(*) FROM push_subscriptions)||' suscripciones push, '||(SELECT count(*) FROM carts)||' carritos'")"
echo "        base de pruebas: $COUNTS"
[[ "$(docker exec escapes-staging-db psql -U staging -d escapes_staging -tAc "SELECT (SELECT count(*) FROM orders)+(SELECT count(*) FROM push_subscriptions)+(SELECT count(*) FROM carts)+(SELECT count(*) FROM cart_abandoned_emails)+(SELECT count(*) FROM chat_messages)+(SELECT count(*) FROM email_send_queue)")" == 0 ]] \
  && ok "no hay pedidos, carritos, chats, suscripciones ni cola de correo copiados" || bad "hay datos de clientes en la base de pruebas"
[[ "$(docker exec escapes-staging-db psql -U staging -d escapes_staging -tAc "SELECT count(*) FROM users WHERE email NOT LIKE '%@pruebas.invalid'")" == 0 ]] \
  && ok "todos los usuarios son cuentas de pruebas (@pruebas.invalid)" || bad "hay usuarios que no son de pruebas"

echo "· cuentas de pruebas (login por dentro de la red)"
login() { docker exec -e U="$1" -e P="$2" escapes-staging-backend node -e "
fetch('http://localhost:3001/api/auth?action=login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:process.env.U,password:process.env.P})})
 .then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('error');process.exit(0)})"; }
[[ "$(login admin@pruebas.invalid "$ADMIN_PW")" == 200 ]] && ok "entra el administrador de pruebas" || bad "no entra el administrador de pruebas"
[[ "$(login cliente@pruebas.invalid "$CLIENTE_PW")" == 200 ]] && ok "entra el cliente de pruebas" || bad "no entra el cliente de pruebas"
[[ "$(login admin@pruebas.invalid "contraseña-incorrecta")" == 401 ]] && ok "una contraseña incorrecta da 401" || bad "una contraseña incorrecta no da 401"

echo "· bloqueos en el proceso real del backend"
R="$(docker exec escapes-staging-backend node -e "
import('./dist/lib/email.js').then(m=>m.sendEmail({to:'cliente-real@gmail.com',subject:'[PRUEBA] comprobación del bloqueo',text:'x'})).then(r=>{console.log(JSON.stringify(r));process.exit(0)}).catch(e=>{console.log('error '+e.message);process.exit(0)})")"
echo "$R" | grep -q 'staging-bloqueado' && ok "un correo a un cliente se descarta (no sale)" || bad "el correo no se bloqueó: $R"
docker exec escapes-staging-backend node -e "import('./dist/lib/staging-guard.js').then(()=>fetch('https://api.mybihr.com/')).then(()=>process.exit(1),e=>{console.log(e.message);process.exit(0)})" | grep -qi "bloqueada" && ok "fetch a un proveedor está bloqueado por el código" || bad "fetch a un proveedor no está bloqueado por el código"
J="$(docker logs escapes-staging-backend 2>&1 | grep -ciE 'ABANDONED CART.*(sent|Stage)|\[CHAT JOBS\]|\[PROMOS\]')"
[[ "$J" == 0 ]] && ok "ningún trabajo programado ha corrido" || bad "han corrido $J trabajos programados"
docker exec escapes-staging-backend sh -c 'env | grep -E "^(STRIPE_SECRET_KEY|META_ACCESS_TOKEN|GA4_API_SECRET|TIKTOK_EVENTS_TOKEN|VAPID_PRIVATE_KEY|BIHR_MACKEY|SMTP_PASSWORD)="' | grep -q . \
  && bad "hay secretos de producción en el entorno del backend" || ok "no hay secretos de producción en el entorno del backend"

echo "· producción intacta"
[[ "$(code https://escapesymas.com/)" == 200 ]] && ok "la tienda real responde" || bad "la tienda real no responde"
[[ "$(code https://api.escapesymas.com/api/health)" == 200 ]] && ok "la API real responde" || bad "la API real no responde"
curl -s https://escapesymas.com/robots.txt | grep -q "Allow: /" && ok "robots.txt real sigue permitiendo el rastreo" || bad "robots.txt real cambió"

[[ "$FAIL" == 0 ]] && echo "RESULTADO: todo OK" || { echo "RESULTADO: REVISAR"; exit 1; }
