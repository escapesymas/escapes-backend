/**
 * Impuesto según el destino (tabla tax_rules, migración 010).
 * Los precios del catálogo incluyen el IVA español: CATALOG_VAT_RATE.
 */
import { pool } from '../db.js';

export const CATALOG_VAT_RATE = 21;

export interface TaxRule { rate: number; label: string; note: string | null; country: string; prefix: string }

let cache: { rules: TaxRule[]; at: number } | null = null;

async function loadRules(): Promise<TaxRule[]> {
  if (cache && Date.now() - cache.at < 300_000) return cache.rules;
  const r = await pool.query(
    `SELECT country, postcode_prefix, rate, label, invoice_note FROM tax_rules WHERE active`
  ).catch(() => ({ rows: [] as any[] }));
  const rules = r.rows.map((x: any) => ({
    country: String(x.country).toUpperCase(), prefix: String(x.postcode_prefix || ''),
    rate: Number(x.rate), label: x.label, note: x.invoice_note || null,
  }));
  cache = { rules, at: Date.now() };
  return rules;
}

/** Regla más específica para país + código postal (prefijo más largo). Por defecto, IVA español. */
export async function resolveTax(country?: string, postcode?: string): Promise<TaxRule> {
  const c = String(country || 'ES').trim().toUpperCase().slice(0, 2) || 'ES';
  const cp = String(postcode || '').replace(/\s+/g, '');
  const match = (await loadRules())
    .filter((r) => r.country === c && cp.startsWith(r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return match || { rate: CATALOG_VAT_RATE, label: `IVA ${CATALOG_VAT_RATE}%`, note: null, country: c, prefix: '' };
}

/** Importe con IVA español → importe con el impuesto del destino (céntimos). */
export function toDestinationCents(cents: number, rate: number): number {
  if (rate === CATALOG_VAT_RATE) return cents;
  return Math.round((cents / (1 + CATALOG_VAT_RATE / 100)) * (1 + rate / 100));
}

/** Cuota de impuesto contenida en un total (céntimos). */
export function taxInTotal(totalCents: number, rate: number): number {
  return rate > 0 ? Math.round(totalCents - totalCents / (1 + rate / 100)) : 0;
}

export function invalidateTaxCache() { cache = null; }
