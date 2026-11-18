/** Formato en español de los números del informe de la Vista general (lo usan el PDF y el texto que se le da a la IA). */
import type { Kpi, KpiUnit } from './overview-report.js';

// `useGrouping: 'always'`: el español no agrupa por defecto los números de 4 cifras («1173»), pero en un informe se lee mejor «1.173».
const num = (v: number, min: number, max: number): string =>
  new Intl.NumberFormat('es-ES', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: 'always' } as unknown as Intl.NumberFormatOptions).format(v);

export function fmtValue(v: number, unit: KpiUnit): string {
  switch (unit) {
    case 'eur': return `${num(v, 2, 2)} €`;
    case 'int': return num(Math.round(v), 0, 0);
    case 'pct': return `${num(v, v !== 0 && Math.abs(v) < 1 ? 2 : 1, v !== 0 && Math.abs(v) < 1 ? 2 : 1)} %`;
    case 'dec': return num(v, 1, 1);
  }
}

export interface Delta {
  /** Texto corto: «+12,3 %», «−3,1 pp», «nuevo», «=». Vacío si no hay con qué comparar. */
  text: string;
  dir: 'up' | 'down' | 'flat' | 'new' | 'none';
  /** Si el cambio es bueno o malo para el negocio (según `good` del KPI). */
  sentiment: 'good' | 'bad' | 'neutral';
}

/** Variación de un KPI respecto al periodo anterior. Desde cero no se calcula un porcentaje (sería infinito). */
export function deltaOf(k: Pick<Kpi, 'value' | 'prev' | 'unit' | 'good'>): Delta {
  if (k.prev == null) return { text: '', dir: 'none', sentiment: 'neutral' };
  const diff = k.value - k.prev;
  const eps = k.unit === 'eur' || k.unit === 'pct' || k.unit === 'dec' ? 0.005 : 0.5;
  if (Math.abs(diff) < eps) return { text: '=', dir: 'flat', sentiment: 'neutral' };
  const dir = diff > 0 ? 'up' : 'down';
  const sentiment: Delta['sentiment'] = k.good == null ? 'neutral' : (dir === 'up') === (k.good === 'up') ? 'good' : 'bad';
  if (k.unit === 'pct') return { text: `${diff > 0 ? '+' : '−'}${num(Math.abs(diff), 1, 1)} pp`, dir, sentiment };
  if (k.prev === 0) return { text: 'nuevo', dir: 'new', sentiment };
  const p = (diff / Math.abs(k.prev)) * 100;
  const shown = Math.abs(p) >= 1000 ? `${num(Math.round(Math.abs(p)), 0, 0)}` : num(Math.abs(p), 1, 1);
  return { text: `${p > 0 ? '+' : '−'}${shown} %`, dir, sentiment };
}

/** «18/11/2026, 22:30» en hora de Madrid. */
export function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** «2026-11-05» → «5/11». */
export function fmtDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d}/${m}`;
}

export const GROUP_TITLES: Record<string, string> = {
  ventas: 'Ventas y pedidos',
  visitas: 'Visitas a la web',
  carritos: 'Carritos',
  clientes: 'Clientes',
  atencion: 'Atención al cliente',
  catalogo: 'Catálogo',
};

export const GROUP_ORDER = ['ventas', 'visitas', 'carritos', 'clientes', 'atencion', 'catalogo'] as const;

export const DEVICE_NAMES: Record<string, string> = { mobile: 'Móvil', desktop: 'Ordenador', laptop: 'Portátil', tablet: 'Tablet' };

export const PAYMENT_NAMES: Record<string, string> = { card: 'Tarjeta', paypal: 'PayPal', bizum: 'Bizum', transfer: 'Transferencia', otro: 'Otro' };

/** Ciudad para enseñar: «Desconocida» sin país no dice nada, y la misma ciudad de otro país no es la misma. */
export function cityLabel(city: string, country: string): string {
  return country && country !== 'ES' ? `${city} (${country})` : city;
}
