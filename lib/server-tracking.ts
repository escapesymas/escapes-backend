import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[SERVER TRACKING] DATABASE_URL not set — dedup disabled');
}

const pool = connectionString
  ? new Pool({ connectionString, max: 2 })
  : null as any;

const db = pool ? drizzle(pool) : null;

interface ServerEvent {
  eventName: string;
  eventId: string;
  userEmail?: string;
  userAgent?: string;
  clientIp?: string;
  payload: Record<string, any>;
}

interface MetaConfig {
  pixelId: string;
  accessToken: string;
}

interface GA4Config {
  measurementId: string;
  apiSecret: string;
}

const META = (() => {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!pixelId || !accessToken) return null;
  return { pixelId, accessToken } satisfies MetaConfig;
})();

const GA4 = (() => {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) return null;
  return { measurementId, apiSecret } satisfies GA4Config;
})();

function sha256(input: string): string {
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.createHash('sha256').update(input.trim().toLowerCase()).digest('hex');
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseMs = 500): Promise<T | null> {
  let lastErr: any = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
  console.error(`[SERVER TRACKING] Failed after ${retries + 1} attempts:`, lastErr?.message);
  return null;
}

/**
 * Marca un event_id como procesado atómicamente para una plataforma.
 * Devuelve true si es nuevo (se debe enviar), false si ya fue procesado (skip).
 *
 * Usa INSERT ... ON CONFLICT DO NOTHING con UNIQUE(event_id, platform).
 * Si la BD falla, retorna true (fail-open) para no bloquear el tracking —
 * el coste de un evento duplicado es menor que perder tracking completamente.
 */
export async function markEventProcessed(
  eventId: string,
  platform: 'meta' | 'ga4',
  eventName: string
): Promise<boolean> {
  if (!db) {
    return true;
  }
  try {
    const result = await db.execute(sql`
      INSERT INTO processed_events (event_id, platform, event_name)
      VALUES (${eventId}, ${platform}, ${eventName})
      ON CONFLICT (event_id, platform) DO NOTHING
      RETURNING id
    `);
    return result.rows.length > 0;
  } catch (err: any) {
    console.error('[DEDUPE ERROR]:', err?.message);
    return true;
  }
}

export async function sendMetaEvent(event: ServerEvent): Promise<boolean> {
  if (!META) return false;

  const alreadyProcessed = !(await markEventProcessed(event.eventId, 'meta', event.eventName));
  if (alreadyProcessed) {
    console.log(`[DEDUPE] Meta event ${event.eventId} (${event.eventName}) already processed, skipping`);
    return false;
  }

  const url = `https://graph.facebook.com/v18.0/${META.pixelId}/events`;
  const userData: Record<string, any> = {
    client_ip: event.clientIp,
    client_user_agent: event.userAgent,
    event_id: event.eventId,
    action_source: 'website',
  };
  if (event.userEmail) userData.em = sha256(event.userEmail);

  const customData: Record<string, any> = {};
  for (const [k, v] of Object.entries(event.payload)) {
    customData[k] = v;
  }

  const body = {
    data: [{
      event_name: event.eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: event.eventId,
      event_source_url: process.env.SITE_URL || 'https://escapesymas.com',
      action_source: 'website',
      user_data: userData,
      custom_data: customData,
    }],
    access_token: META.accessToken,
  };

  const result = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`Meta API ${r.status}: ${await r.text()}`);
    return true;
  });
  return result === true;
}

export async function sendGA4Event(event: ServerEvent): Promise<boolean> {
  if (!GA4) return false;

  const alreadyProcessed = !(await markEventProcessed(event.eventId, 'ga4', event.eventName));
  if (alreadyProcessed) {
    console.log(`[DEDUPE] GA4 event ${event.eventId} (${event.eventName}) already processed, skipping`);
    return false;
  }

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${GA4.measurementId}&api_secret=${GA4.apiSecret}`;

  const body = {
    client_id: event.clientIp || '0.0.0.0',
    events: [{
      name: event.eventName,
      params: {
        ...event.payload,
        event_id: event.eventId,
        engagement_time_msec: 1,
        session_id: Math.floor(Date.now() / 1000 / 1000 / 30),
      },
    }],
  };

  const result = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`GA4 API ${r.status}`);
    return true;
  });
  return result === true;
}

export async function sendServerSideEvent(event: ServerEvent): Promise<{ meta: boolean; ga4: boolean }> {
  const [meta, ga4] = await Promise.all([
    sendMetaEvent(event),
    sendGA4Event(event),
  ]);
  return { meta, ga4 };
}

export function isServerTrackingConfigured(): { meta: boolean; ga4: boolean } {
  return { meta: !!META, ga4: !!GA4 };
}