#!/usr/bin/env bash
# Circuito de entrega con puerta de calidad. Lleva lo que haya commiteado en `mejoras/2026-10` hasta producción:
#
#   rama → tipos en local → push de la RAMA → CI de GitHub en verde → (entorno de pruebas) → main → despliegue → prueba en producción
#
#   scripts/factory/ship.sh <backend|frontend|admin> [--pruebas] [--sin-ci] [--sin-prueba] [--hasta-ci]
#
#   --pruebas      antes de tocar main, despliega la rama en el entorno de pruebas y pasa verify-staging.sh
#                  (para migraciones, pagos y cambios de riesgo; lo de /root/staging debe estar al día).
#   --sin-ci       se salta la puerta del CI (solo urgencias: lo que falle llegará a producción). Avisa a gritos.
#   --sin-prueba   no pasa smoke-prod.sh después del despliegue (no recomendado).
#   --hasta-ci     se detiene tras el CI en verde: no toca main ni despliega.
#
# Nunca fuerza nada (sin --force, sin merge commit) y nunca vuelve atrás por su cuenta: si la prueba de producción
# falla, lo dice y deja la decisión (revertir o corregir) a quien lo lanzó. Un push a main despliega solo en Coolify.
# Orden cuando un cambio toca varios repos: backend → frontend → admin, uno detrás de otro y esperando a cada uno.
#
# Códigos de salida: 0 todo bien · 2 no se pudo empezar (rama, tipos, push) · 3 CI en rojo o sin CI ·
#                    4 el entorno de pruebas falló · 5 fallo en el despliegue · 6 la prueba de producción dice REVISAR
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FACTORY="$ROOT/escapes-backend/scripts/factory"
BRANCH="mejoras/2026-10"
VPS="${VPS:-root@13.140.220.42}"
SSH=(ssh -i "$HOME/.ssh/id_ed25519" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 "$VPS")

WHAT="${1:-}"; shift || true
PRUEBAS=0; SIN_CI=0; SIN_PRUEBA=0; HASTA_CI=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pruebas) PRUEBAS=1;; --sin-ci) SIN_CI=1;; --sin-prueba) SIN_PRUEBA=1;; --hasta-ci) HASTA_CI=1;;
    *) echo "Argumento desconocido: $1"; exit 2;;
  esac; shift
done
case "$WHAT" in
  backend) DIR=escapes-backend; PREFIX=wg90;;
  frontend) DIR=escapes-frontend; PREFIX=k11b;;
  admin) DIR=escapes-admin; PREFIX=tg1d;;
  *) sed -n 2,19p "${BASH_SOURCE[0]}"; exit 2;;
esac

die() { local c="$1"; shift; echo "✗ $*" >&2; exit "$c"; }
step() { echo; echo "▶ $*"; }
cd "$ROOT/$DIR" || die 2 "no existe $ROOT/$DIR"

step "Comprobaciones previas ($DIR)"
[[ "$(git branch --show-current)" == "$BRANCH" ]] || die 2 "hay que estar en la rama $BRANCH (estás en $(git branch --show-current))"
git fetch -q origin main "$BRANCH" 2>/dev/null || die 2 "no se pudo consultar GitHub (git fetch)"
git merge-base --is-ancestor main HEAD || die 2 "main local tiene commits que la rama no tiene: pon la rama al día antes"
git merge-base --is-ancestor origin/main HEAD || die 2 "origin/main tiene commits que la rama no tiene: pon la rama al día antes"
AHEAD="$(git rev-list --count origin/main..HEAD)"
[[ "$AHEAD" -gt 0 ]] || die 2 "no hay nada que subir: la rama no va por delante de main"
SHA="$(git rev-parse --short HEAD)"; FULL="$(git rev-parse HEAD)"
OWNER_REPO="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
echo "  $AHEAD commit(s) por subir; último: $SHA — $(git log -1 --format=%s)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "  ⚠ hay cambios SIN commitear en $DIR (¿de otro agente?). No se suben y no se tocan."
fi

step "Tipos en local (tsc, con nice)"
if [[ "$DIR" == escapes-backend ]]; then nice -n 15 npx tsc --noEmit -p . ; else nice -n 15 npx tsc --noEmit; fi \
  && echo "  tsc sin errores" || die 2 "tsc falla: corrígelo antes de subir"

step "Subiendo la RAMA (main no se toca todavía)"
git push -q origin "$BRANCH" || die 2 "git push de la rama falló (¿alguien subió algo? no se fuerza nunca)"
echo "  rama subida"

# ---------- puerta del CI ----------
gh_get() { curl -s --max-time 30 ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} -H 'Accept: application/vnd.github+json' "$1"; }
ci_state() {
  gh_get "https://api.github.com/repos/$OWNER_REPO/actions/runs?head_sha=$FULL&per_page=30" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('error'); sys.exit()
if 'workflow_runs' not in d:
    print('error'); sys.exit()
latest = {}
for r in sorted(d['workflow_runs'], key=lambda r: r['created_at']):
    if r['name'].startswith('CI'):
        latest[r['name']] = r          # el intento más reciente de cada workflow
runs = list(latest.values())
if not runs: print('none'); sys.exit()
if any(r['status'] != 'completed' for r in runs): print('pending'); sys.exit()
bad = [r for r in runs if r['conclusion'] != 'success']
print('failure %d' % bad[0]['id'] if bad else 'success')
"
}
ci_detail() {
  gh_get "https://api.github.com/repos/$OWNER_REPO/actions/runs/$1/jobs" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit()
for j in d.get('jobs', []):
    if j['conclusion'] not in ('success', 'skipped'):
        steps = [s['name'] for s in j['steps'] if s['conclusion'] not in ('success', 'skipped', None)]
        print('    ✗ ' + j['name'] + (' → paso: ' + ', '.join(steps) if steps else ''))
print('    detalle: https://github.com/$OWNER_REPO/actions/runs/$1')
"
}

if [[ "$SIN_CI" == 1 ]]; then
  step "CI"
  echo "  ⚠⚠ SE SALTA LA PUERTA DEL CI (--sin-ci): si algo falla en GitHub, llegará igualmente a producción."
else
  step "Esperando al CI de GitHub para $SHA (la puerta: sin verde no se toca main)"
  START=$SECONDS; ERRS=0
  while :; do
    S="$(ci_state)"
    case "${S%% *}" in
      success) echo "  CI en verde ($(( SECONDS - START )) s)"; break;;
      failure) echo "  CI EN ROJO:"; ci_detail "${S#* }"; die 3 "el CI falla: corrige, vuelve a commitear y repite. main NO se ha tocado";;
      none)    (( SECONDS - START > 240 )) && die 3 "pasaron 4 min y GitHub no ha lanzado ningún CI para $SHA (¿el workflow no corre en esta rama? usa --sin-ci solo si es una urgencia)";;
      error)   ERRS=$((ERRS+1)); [[ $ERRS -ge 6 ]] && die 3 "no se puede consultar el CI en GitHub (límite de peticiones o red); exporta GH_TOKEN o usa --sin-ci";;
      pending) ERRS=0;;
    esac
    (( SECONDS - START > 1500 )) && die 3 "el CI lleva más de 25 min: algo va mal en GitHub"
    sleep 30
  done
fi
[[ "$HASTA_CI" == 1 ]] && { echo; echo "RESULTADO: CI en verde; no se ha tocado main (--hasta-ci)"; exit 0; }

# ---------- entorno de pruebas ----------
if [[ "$PRUEBAS" == 1 ]]; then
  step "Entorno de pruebas: desplegar la rama y verificar (puede tardar varios minutos)"
  "${SSH[@]}" 'bash /root/staging/deploy-staging.sh' 2>&1 | tail -25 | sed 's/^/  /'
  VER="$("${SSH[@]}" 'bash /root/staging/verify-staging.sh' 2>&1)"; echo "$VER" | tail -40 | sed 's/^/  /'
  echo "$VER" | grep -q '^RESULTADO: todo OK' || die 4 "el entorno de pruebas dice REVISAR: main NO se ha tocado"
  echo "  Ahora prueba tu cambio en https://pruebas.escapesymas.com si hace falta."
fi

# ---------- paso a main (despliega solo en Coolify) ----------
step "Pasando a main (sin merge commit) — esto despliega en producción"
git checkout -q main || die 2 "no se pudo cambiar a main (¿cambios locales que chocan?)"
if ! git merge -q --ff-only "$BRANCH"; then git checkout -q "$BRANCH"; die 2 "main no admite fast-forward desde la rama"; fi
git push -q origin main "$BRANCH"; RC=$?
git checkout -q "$BRANCH"
[[ $RC -eq 0 ]] || die 2 "git push de main falló (si llegó a medias, revisa GitHub antes de repetir)"
echo "  main = $SHA"

# ---------- espera al despliegue de Coolify ----------
step "Esperando al despliegue en Coolify ($DIR, commit $SHA)"
DEP="$("${SSH[@]}" "
for i in \$(seq 1 80); do
  r=\$(docker exec coolify-db psql -U coolify -d coolify -tA -c \"select status from application_deployment_queues where commit like '$SHA%' order by id desc limit 1\" 2>/dev/null)
  case \"\$r\" in finished|failed|cancelled*) echo \"\$r\"; exit;; esac
  if [ -z \"\$r\" ] && [ \$i -ge 16 ]; then echo sin-despliegue; exit; fi
  sleep 15
done
echo agotado" 2>/dev/null)"
case "$DEP" in
  finished) echo "  despliegue terminado";;
  sin-despliegue) die 5 "Coolify no ha creado ningún despliegue para $SHA en 4 min (¿el webhook de GitHub?). Despliega a mano con «Deploy» en coolify.escapesymas.com";;
  failed|cancelled*) die 5 "el despliegue de Coolify terminó «$DEP»: revisa su log en coolify.escapesymas.com. La web anterior sigue en marcha";;
  *) die 5 "el despliegue no terminó en 20 min (estado: ${DEP:-desconocido})";;
esac

# el contenedor nuevo tarda unos segundos en reemplazar al viejo
"${SSH[@]}" "for i in \$(seq 1 24); do docker ps --format '{{.Image}}' | grep -q '^$PREFIX[a-z0-9]*:$FULL' && exit 0; sleep 5; done; exit 1" 2>/dev/null \
  && echo "  el contenedor nuevo ya corre" || echo "  ⚠ el contenedor nuevo no aparece aún; la prueba lo dirá"

# ---------- prueba en producción ----------
if [[ "$SIN_PRUEBA" == 1 ]]; then
  echo; echo "RESULTADO: desplegado $SHA; prueba de producción OMITIDA (--sin-prueba)"; exit 0
fi
step "Prueba automática en producción"
OUT="$(bash "$FACTORY/smoke-prod.sh" --repo "$WHAT" --commit "$SHA" 2>&1)"; echo "$OUT" | sed 's/^/  /'
if echo "$OUT" | grep -q '^RESULTADO: todo OK'; then
  echo; echo "RESULTADO: $DIR $SHA desplegado y verificado en producción"; exit 0
fi
echo
echo "✗ La prueba de producción dice REVISAR. Producción YA corre $SHA."
echo "  Para volver atrás: git revert $SHA (en $DIR) y repetir ship.sh; no se hace solo."
echo "RESULTADO: REVISAR"; exit 6
