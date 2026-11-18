/**
 * Periodos del informe de la Vista general.
 *
 * Todo se calcula en días naturales de hora peninsular (Europe/Madrid), igual que «Hoy» en las estadísticas web.
 * Cada periodo lleva su periodo de comparación (el anterior equivalente) para poder enseñar las variaciones.
 */

export type PeriodPreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'prev_month' | 'year' | 'custom';

/** Con qué se compara: el periodo anterior equivalente o las mismas fechas del año pasado. */
export type ComparisonMode = 'prev' | 'yoy';
export const COMPARISON_MODES: ComparisonMode[] = ['prev', 'yoy'];

export const PERIOD_PRESETS: PeriodPreset[] = ['today', 'yesterday', '7d', '30d', 'month', 'prev_month', 'year', 'custom'];

export interface ResolvedPeriod {
  preset: PeriodPreset;
  compare: ComparisonMode;
  label: string;
  /** Primer día (YYYY-MM-DD, hora de Madrid), incluido. */
  from: string;
  /** Último día (YYYY-MM-DD), incluido. */
  to: string;
  days: number;
  /** Periodo con el que se compara. */
  prevFrom: string;
  prevTo: string;
  prevLabel: string;
}

/** Máximo de días de un periodo personalizado (un año y poco: las estadísticas web empiezan en enero de 2026). */
export const MAX_CUSTOM_DAYS = 400;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Fecha de hoy en Madrid como YYYY-MM-DD. */
export function madridToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function toUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return fromUtc(toUtc(date) + n * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1;
}

function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  return fromUtc(toUtc(s)) === s;
}

/** La misma fecha un año antes (el 29 de febrero cae en el 28). */
export function minusOneYear(date: string): string {
  const y = Number(date.slice(0, 4)) - 1;
  const same = `${y}${date.slice(4)}`;
  return isRealDate(same) ? same : `${y}-02-28`;
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function lastOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return fromUtc(Date.UTC(y, m, 0));
}

/** «1/11/2026» */
export function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d}/${m}/${y}`;
}

function monthName(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} de ${y}`;
}

export function rangeText(from: string, to: string): string {
  return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
}

/**
 * Convierte lo que pide el panel (`preset`, y `from`/`to` si es personalizado) en un periodo concreto.
 * Un periodo personalizado incorrecto (fechas inventadas, al revés, demasiado largo) se corrige: nunca falla.
 */
export function resolvePeriod(input: { preset?: unknown; from?: unknown; to?: unknown; compare?: unknown }, now: Date = new Date()): ResolvedPeriod {
  const today = madridToday(now);
  const preset: PeriodPreset = PERIOD_PRESETS.includes(input.preset as PeriodPreset) ? (input.preset as PeriodPreset) : '30d';
  const compare: ComparisonMode = input.compare === 'yoy' ? 'yoy' : 'prev';

  let from = today;
  let to = today;
  let label = '';
  let prevFrom = '';
  let prevTo = '';
  let prevLabel = '';

  // Periodo anterior de la misma duración, justo antes.
  const before = (f: string, t: string) => {
    const days = daysBetween(f, t);
    return { f: addDays(f, -days), t: addDays(f, -1) };
  };

  switch (preset) {
    case 'today':
      label = 'Hoy';
      prevFrom = prevTo = addDays(today, -1);
      prevLabel = 'Ayer';
      break;
    case 'yesterday':
      from = to = addDays(today, -1);
      label = 'Ayer';
      prevFrom = prevTo = addDays(today, -2);
      prevLabel = 'Antes de ayer';
      break;
    case '7d': {
      from = addDays(today, -6);
      label = 'Últimos 7 días';
      const p = before(from, to);
      prevFrom = p.f; prevTo = p.t; prevLabel = '7 días anteriores';
      break;
    }
    case 'month': {
      // Mes en curso hasta hoy, comparado con los mismos días del mes anterior.
      from = firstOfMonth(today);
      label = `Mes en curso (${monthName(today)})`;
      const prevMonthLast = addDays(from, -1);
      prevFrom = firstOfMonth(prevMonthLast);
      const sameDay = `${prevMonthLast.slice(0, 7)}-${today.slice(8)}`;
      prevTo = sameDay > prevMonthLast ? prevMonthLast : sameDay;
      prevLabel = `${monthName(prevMonthLast)} (mismos días)`;
      break;
    }
    case 'prev_month': {
      const prevMonthLast = addDays(firstOfMonth(today), -1);
      from = firstOfMonth(prevMonthLast);
      to = prevMonthLast;
      label = `Mes anterior (${monthName(from)})`;
      const beforeLast = addDays(from, -1);
      prevFrom = firstOfMonth(beforeLast);
      prevTo = beforeLast;
      prevLabel = monthName(prevFrom);
      break;
    }
    case 'year': {
      from = `${today.slice(0, 4)}-01-01`;
      label = `Año en curso (${today.slice(0, 4)})`;
      const y = Number(today.slice(0, 4)) - 1;
      prevFrom = `${y}-01-01`;
      // Mismo día del año anterior (el 29 de febrero cae en el 28).
      const same = `${y}-${today.slice(5)}`;
      prevTo = isRealDate(same) ? same : `${y}-02-28`;
      prevLabel = `Mismos días de ${y}`;
      break;
    }
    case 'custom': {
      let f = isRealDate(input.from) ? input.from : addDays(today, -29);
      let t = isRealDate(input.to) ? input.to : today;
      if (t > today) t = today;
      if (f > t) f = t;
      if (daysBetween(f, t) > MAX_CUSTOM_DAYS) f = addDays(t, -(MAX_CUSTOM_DAYS - 1));
      from = f;
      to = t;
      label = `Del ${rangeText(from, to).replace(' – ', ' al ')}`;
      const p = before(from, to);
      prevFrom = p.f; prevTo = p.t; prevLabel = 'Periodo anterior';
      break;
    }
    case '30d':
    default:
      from = addDays(today, -29);
      label = 'Últimos 30 días';
      {
        const p = before(from, to);
        prevFrom = p.f; prevTo = p.t; prevLabel = '30 días anteriores';
      }
      break;
  }

  // Mismas fechas del año pasado: sustituye al periodo anterior calculado arriba.
  if (compare === 'yoy') {
    prevFrom = minusOneYear(from);
    prevTo = minusOneYear(to);
    prevLabel = from.slice(0, 4) === to.slice(0, 4) ? `Mismo periodo de ${Number(from.slice(0, 4)) - 1}` : 'Mismo periodo del año pasado';
  }

  return { preset, compare, label, from, to, days: daysBetween(from, to), prevFrom, prevTo, prevLabel };
}

/** Lista de días (YYYY-MM-DD) de un periodo, para rellenar los huecos de las series. */
export function listDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}
