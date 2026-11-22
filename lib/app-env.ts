/**
 * Entorno de pruebas (staging): reglas para que una copia de la tienda NUNCA hable con el mundo real.
 *
 * Se activa con APP_ENV=staging. Sin esa variable todo funciona exactamente igual que siempre (producción).
 * Hay tres capas, de fuera adentro:
 *  1. El entorno de pruebas se despliega sin claves de producción (otra BD, otro Redis, Stripe en modo prueba, sin SMTP/VAPID/tracking).
 *  2. `enforceStagingSafety()` (se ejecuta antes que nada, ver `staging-guard.ts`) se niega a arrancar si detecta una clave
 *     de producción o una base de datos que no se llame «…staging…», y cierra la salida a Internet (`fetch`) salvo a lo permitido.
 *  3. Cada salida concreta (correo, avisos push, eventos de publicidad, trabajos programados) comprueba `isStaging()`.
 *
 * Variables del entorno de pruebas:
 *  - STAGING_MAIL_ALLOW   direcciones EXACTAS (separadas por comas) a las que sí puede escribir; vacío = a nadie.
 *  - STAGING_FETCH_ALLOW  dominios a los que `fetch` puede salir (además de localhost); vacío = a ninguno.
 *  - STAGING_JOBS         trabajos programados que SÍ se activan (nombres separados por comas, o `all`); vacío = ninguno.
 *  - STAGING_ORIGINS      orígenes https de la tienda y el panel de pruebas para CORS.
 */

export type Env = Record<string, string | undefined>;

export function isStaging(env: Env = process.env): boolean {
  return env.APP_ENV === 'staging';
}

function list(value: string | undefined): string[] {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ── Correo ───────────────────────────────────────────────────────────────

const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+/g;

/** Separa los destinatarios de un correo en los permitidos (lista exacta de STAGING_MAIL_ALLOW) y los bloqueados. */
export function splitStagingRecipients(to: string, env: Env = process.env): { allowed: string[]; blocked: string[] } {
  const allow = new Set(list(env.STAGING_MAIL_ALLOW));
  const all = [...String(to || '').matchAll(ADDRESS)].map((m) => m[0].toLowerCase());
  return { allowed: all.filter((a) => allow.has(a)), blocked: all.filter((a) => !allow.has(a)) };
}

// ── Trabajos programados ─────────────────────────────────────────────────

/** ¿Debe correr este trabajo? En producción siempre; en pruebas solo si está en STAGING_JOBS (o `all`). */
export function jobEnabled(name: string, env: Env = process.env): boolean {
  if (!isStaging(env)) return true;
  const on = list(env.STAGING_JOBS);
  return on.includes('all') || on.includes(name.toLowerCase());
}

/** `setInterval` de un trabajo de negocio: en pruebas no se programa salvo que se pida. */
export function scheduleJob(name: string, fn: () => void, everyMs: number): ReturnType<typeof setInterval> | null {
  if (!jobEnabled(name)) return null;
  return setInterval(fn, everyMs);
}

/** `setTimeout` de un trabajo de negocio (primera pasada diferida): en pruebas no se programa salvo que se pida. */
export function deferJob(name: string, fn: () => void, delayMs: number): ReturnType<typeof setTimeout> | null {
  if (!jobEnabled(name)) return null;
  return setTimeout(fn, delayMs);
}

// ── Salida a Internet ────────────────────────────────────────────────────

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** ¿Puede `fetch` salir a este host desde el entorno de pruebas? Solo localhost y lo listado en STAGING_FETCH_ALLOW. */
export function isFetchHostAllowed(host: string, env: Env = process.env): boolean {
  const h = String(host || '').toLowerCase();
  if (LOCAL_HOSTS.includes(h)) return true;
  return list(env.STAGING_FETCH_ALLOW).some((d) => h === d || h.endsWith(`.${d}`));
}

let fetchGuarded = false;

/** Sustituye `fetch` por una versión que rechaza cualquier host no permitido. Idempotente. */
export function installStagingFetchGuard(env: Env = process.env): void {
  if (fetchGuarded) return;
  fetchGuarded = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: any, init?: any) => {
    let host = '';
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      host = new URL(raw).hostname;
    } catch { /* URL relativa o rara: se deja pasar al fetch original, que fallará solo */ }
    if (host && !isFetchHostAllowed(host, env)) {
      console.warn(`[STAGING] salida a Internet bloqueada: ${host}`);
      return Promise.reject(new Error(`Entorno de pruebas: salida a ${host} bloqueada`));
    }
    return original(input, init);
  }) as typeof fetch;
}

// ── Comprobación de arranque ─────────────────────────────────────────────

/** Variables que son secretos de producción y que el entorno de pruebas no debe tener. */
const PRODUCTION_SECRETS = [
  'META_ACCESS_TOKEN', 'GA4_API_SECRET', 'TIKTOK_EVENTS_TOKEN', 'VAPID_PRIVATE_KEY',
  'BIHR_MACKEY', 'WOO_KEY', 'WOO_SECRET', 'STRIPE_SECRET_KEY',
];

/**
 * Problemas que impiden arrancar el entorno de pruebas (lista vacía = seguro). No mira nada si no es staging.
 * `STRIPE_SECRET_KEY` solo vale si es una clave de prueba (sk_test_…); en pruebas lo normal es no definirla y usar `STRIPE_TEST_SECRET_KEY`.
 */
export function stagingSafetyProblems(env: Env = process.env): string[] {
  if (!isStaging(env)) return [];
  const problems: string[] = [];

  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY']) {
    if (/^(sk|rk)_live_/.test(env[name] || '')) problems.push(`${name} es una clave de Stripe de PRODUCCIÓN`);
  }
  for (const name of PRODUCTION_SECRETS) {
    if (name === 'STRIPE_SECRET_KEY') continue; // se valora arriba (sk_test_ sí se admite)
    if (env[name]) problems.push(`${name} está definida: es un secreto de producción`);
  }

  const url = env.DATABASE_URL || '';
  let dbName = '';
  try { dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { /* sin URL válida */ }
  if (!dbName) problems.push('DATABASE_URL no es válida o no trae el nombre de la base de datos');
  else if (!/staging|pruebas/i.test(dbName)) problems.push(`la base de datos «${dbName}» no parece de pruebas (su nombre debe llevar «staging» o «pruebas»)`);

  if (!env.JWT_SECRET) problems.push('JWT_SECRET no está definida (debe ser distinta a la de producción)');
  return problems;
}

/** Aborta el arranque si el entorno de pruebas no es seguro; si lo es, cierra la salida a Internet. No hace nada en producción. */
export function enforceStagingSafety(env: Env = process.env): void {
  if (!isStaging(env)) return;
  const problems = stagingSafetyProblems(env);
  if (problems.length) {
    console.error(`[STAGING] ARRANQUE ABORTADO: el entorno de pruebas no es seguro:\n - ${problems.join('\n - ')}`);
    throw new Error(`Entorno de pruebas inseguro: ${problems.length} problema(s)`);
  }
  installStagingFetchGuard(env);
  console.log('[STAGING] Modo pruebas activo: correo, avisos push, eventos de publicidad, trabajos programados y salida a Internet bloqueados.');
}
