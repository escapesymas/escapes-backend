import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  isStaging, splitStagingRecipients, jobEnabled, isFetchHostAllowed, stagingSafetyProblems, enforceStagingSafety, installStagingFetchGuard,
} from './app-env.js';

const STAGING_OK = {
  APP_ENV: 'staging',
  DATABASE_URL: 'postgres://u:p@db-pruebas:5432/escapes_staging',
  JWT_SECRET: 'distinta-de-produccion',
  STRIPE_TEST_SECRET_KEY: 'sk_test_123',
};

describe('modo pruebas', () => {
  it('solo se activa con APP_ENV=staging', () => {
    expect(isStaging({ APP_ENV: 'staging' })).toBe(true);
    expect(isStaging({ APP_ENV: 'production' })).toBe(false);
    expect(isStaging({})).toBe(false);
    expect(isStaging({ APP_ENV: 'Staging ' })).toBe(false);
  });
});

describe('correo en pruebas', () => {
  const env = { APP_ENV: 'staging', STAGING_MAIL_ALLOW: 'Adrian@Escapesymas.com, otro@x.es' };
  it('solo salen las direcciones exactas de la lista (sin distinguir mayúsculas)', () => {
    expect(splitStagingRecipients('adrian@escapesymas.com', env)).toEqual({ allowed: ['adrian@escapesymas.com'], blocked: [] });
    expect(splitStagingRecipients('"Adrián" <ADRIAN@escapesymas.com>, cliente@gmail.com', env)).toEqual({
      allowed: ['adrian@escapesymas.com'], blocked: ['cliente@gmail.com'],
    });
  });
  it('un dominio permitido no basta: otro buzón del mismo dominio se bloquea', () => {
    expect(splitStagingRecipients('info@escapesymas.com', env).allowed).toEqual([]);
  });
  it('sin lista, no sale nada', () => {
    expect(splitStagingRecipients('a@b.com', { APP_ENV: 'staging' })).toEqual({ allowed: [], blocked: ['a@b.com'] });
  });
});

describe('trabajos programados', () => {
  it('en producción siempre corren', () => {
    expect(jobEnabled('carritos-abandonados', {})).toBe(true);
    expect(jobEnabled('lo-que-sea', { APP_ENV: 'production', STAGING_JOBS: '' })).toBe(true);
  });
  it('en pruebas ninguno corre salvo los que se pidan en STAGING_JOBS', () => {
    expect(jobEnabled('carritos-abandonados', { APP_ENV: 'staging' })).toBe(false);
    expect(jobEnabled('carritos-abandonados', { APP_ENV: 'staging', STAGING_JOBS: 'promociones, Carritos-Abandonados' })).toBe(true);
    expect(jobEnabled('chat', { APP_ENV: 'staging', STAGING_JOBS: 'promociones' })).toBe(false);
    expect(jobEnabled('chat', { APP_ENV: 'staging', STAGING_JOBS: 'all' })).toBe(true);
  });
});

describe('salida a Internet en pruebas', () => {
  const env = { APP_ENV: 'staging', STAGING_FETCH_ALLOW: 'meili.interno, api.stripe.com' };
  it('solo localhost y lo permitido (incluidos subdominios)', () => {
    expect(isFetchHostAllowed('localhost', env)).toBe(true);
    expect(isFetchHostAllowed('127.0.0.1', env)).toBe(true);
    expect(isFetchHostAllowed('api.stripe.com', env)).toBe(true);
    expect(isFetchHostAllowed('x.meili.interno', env)).toBe(true);
    expect(isFetchHostAllowed('api.mybihr.com', env)).toBe(false);
    expect(isFetchHostAllowed('api.stripe.com.evil.com', env)).toBe(false);
    expect(isFetchHostAllowed('evilapi.stripe.com.mx', env)).toBe(false);
  });
});

describe('comprobación de arranque', () => {
  it('en producción no mira nada', () => {
    expect(stagingSafetyProblems({ STRIPE_SECRET_KEY: 'sk_live_x', DATABASE_URL: 'postgres://u@h/escapes_db' })).toEqual([]);
    expect(() => enforceStagingSafety({ STRIPE_SECRET_KEY: 'sk_live_x' })).not.toThrow();
  });
  it('un entorno de pruebas limpio es seguro', () => {
    expect(stagingSafetyProblems(STAGING_OK)).toEqual([]);
  });
  it('rechaza claves de Stripe de producción, en cualquiera de las dos variables', () => {
    expect(stagingSafetyProblems({ ...STAGING_OK, STRIPE_SECRET_KEY: 'sk_live_abc' }).join()).toContain('STRIPE_SECRET_KEY');
    expect(stagingSafetyProblems({ ...STAGING_OK, STRIPE_TEST_SECRET_KEY: 'rk_live_abc' }).join()).toContain('STRIPE_TEST_SECRET_KEY');
  });
  it('una clave de prueba de Stripe en STRIPE_SECRET_KEY se admite', () => {
    expect(stagingSafetyProblems({ ...STAGING_OK, STRIPE_SECRET_KEY: 'sk_test_abc' })).toEqual([]);
  });
  it('rechaza los secretos de producción (publicidad, avisos push, proveedor)', () => {
    for (const name of ['META_ACCESS_TOKEN', 'GA4_API_SECRET', 'TIKTOK_EVENTS_TOKEN', 'VAPID_PRIVATE_KEY', 'BIHR_MACKEY', 'WOO_KEY', 'WOO_SECRET']) {
      expect(stagingSafetyProblems({ ...STAGING_OK, [name]: 'x' }).join()).toContain(name);
    }
  });
  it('la base de datos tiene que llamarse «staging» o «pruebas»', () => {
    expect(stagingSafetyProblems({ ...STAGING_OK, DATABASE_URL: 'postgres://u:p@h:5432/escapes_db' }).join()).toContain('escapes_db');
    expect(stagingSafetyProblems({ ...STAGING_OK, DATABASE_URL: 'postgres://u:p@h:5432/escapes_pruebas' })).toEqual([]);
    expect(stagingSafetyProblems({ ...STAGING_OK, DATABASE_URL: undefined }).join()).toContain('DATABASE_URL');
    expect(stagingSafetyProblems({ ...STAGING_OK, DATABASE_URL: 'esto no es una url' }).join()).toContain('DATABASE_URL');
  });
  it('exige JWT_SECRET propia', () => {
    expect(stagingSafetyProblems({ ...STAGING_OK, JWT_SECRET: undefined }).join()).toContain('JWT_SECRET');
  });
  it('enforceStagingSafety aborta con claves de producción', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => enforceStagingSafety({ ...STAGING_OK, STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(/inseguro/);
    err.mockRestore();
  });
});

describe('cierre de fetch', () => {
  const original = globalThis.fetch;
  afterAll(() => { globalThis.fetch = original; });

  it('rechaza hosts de fuera y deja pasar localhost', async () => {
    const stub = vi.fn(async () => new Response('ok'));
    globalThis.fetch = stub as any;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installStagingFetchGuard({ APP_ENV: 'staging' });

    await expect(fetch('https://api.mybihr.com/x')).rejects.toThrow(/bloqueada/);
    await expect(fetch(new URL('https://graph.facebook.com/v18.0/1/events'))).rejects.toThrow(/bloqueada/);
    expect(stub).not.toHaveBeenCalled();

    await expect(fetch('http://localhost:3001/api/health')).resolves.toBeInstanceOf(Response);
    expect(stub).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
