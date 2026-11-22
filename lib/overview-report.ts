/**
 * Informe de la Vista general del panel: todos los KPIs de un periodo, comparados con el anterior equivalente.
 *
 * Es la única fuente de números de la pantalla, del PDF y del informe de la IA: así no pueden contradecirse.
 * Definiciones (se enseñan también en el panel y en el PDF):
 *  · Ventas = pedidos pagados que no están cancelados ni reembolsados, IVA incluido (igual que Contabilidad, pero sin
 *    contar los «pendientes de pago»; esos salen aparte).
 *  · Los días son naturales en hora peninsular (Europe/Madrid).
 *  · Visitas y embudo: las estadísticas web (Umami) sin el tráfico propio de Canarias.
 *  · Carritos «ahora» es una foto del momento: no tiene periodo anterior con el que comparar.
 */
import { pool } from '../db.js';
import { listDays, resolvePeriod, type ComparisonMode, type ResolvedPeriod } from './overview-period.js';
import { getVisitsDays, getVisitsDetail, getVisitsSince, getVisitsSummary, type VisitsDetail, type VisitsSummary } from './overview-visits.js';

export type KpiUnit = 'eur' | 'int' | 'pct' | 'dec';
export type KpiGroup = 'ventas' | 'visitas' | 'carritos' | 'clientes' | 'atencion' | 'catalogo';

export interface Kpi {
  id: string;
  group: KpiGroup;
  label: string;
  value: number;
  /** Valor del periodo de comparación; null si el dato es una foto del momento o no hay datos de ese periodo (`noPrev`). */
  prev: number | null;
  unit: KpiUnit;
  /** Qué dirección es buena: «up» (subir es bueno), «down» (bajar es bueno) o neutro. */
  good: 'up' | 'down' | null;
  hint?: string;
  /** El periodo de comparación es anterior a los primeros datos que hay: no se compara (no es lo mismo que «cero»). */
  noPrev?: boolean;
}

export interface FunnelStep { key: string; label: string; current: number; previous: number | null }

export interface OverviewReport {
  period: ResolvedPeriod;
  generatedAt: string;
  excludeInternal: boolean;
  /** Indicadores clave que se destacan arriba (ids de `kpis`). */
  headline: string[];
  kpis: Kpi[];
  sales: {
    byDay: { date: string; orders: number; revenue: number }[];
    topProducts: { name: string; sku: string; units: number; revenue: number }[];
    payments: { method: string; orders: number; revenue: number }[];
    coupons: { code: string; orders: number; discount: number }[];
  };
  visits: VisitsDetail | null;
  /** Series por día del periodo de comparación, alineadas por posición con las del periodo (null = sin dato). */
  compareSeries: { revenue: (number | null)[]; visitors: (number | null)[]; carts: (number | null)[] } | null;
  /** Primer día con datos de la tienda y de las estadísticas web (YYYY-MM-DD). */
  dataSince: { store: string | null; visits: string | null };
  funnel: FunnelStep[];
  carts: {
    active: { count: number; value: number; guests: number; stale: number };
    /** Los 5 carritos activos de más valor. */
    top: { id: number; email: string | null; value: number; items: number; updatedAt: string }[];
  };
  warnings: string[];
}

const n = (v: unknown): number => Number(v) || 0;
const eur = (cents: unknown): number => Math.round(n(cents)) / 100;
const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const pct = (a: number, b: number): number => (b > 0 ? round2((a / b) * 100) : 0);

/** Condición sobre `orders.created_at` (timestamp UTC sin zona) para el periodo [$1, $2). */
const ORDER_RANGE = `o.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') AND o.created_at < ($2::timestamptz AT TIME ZONE 'UTC')`;
/** Pedido válido (no cancelado ni reembolsado) y pagado. */
const VALID = `o.status NOT IN ('cancelled', 'refunded')`;
const PAID = `(${VALID} AND (o.paid_at IS NOT NULL OR o.status <> 'pending'))`;

interface SalesAgg {
  orders: number; revenueCents: number; shippingCents: number; discountCents: number; taxCents: number;
  buyers: number; couponOrders: number;
  pendingOrders: number; pendingCents: number; cancelled: number; refundedOrders: number; refundedCents: number;
  units: number; costCents: number;
}

async function salesAgg(from: string, to: string): Promise<SalesAgg> {
  const [orders, items] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE ${PAID}) AS orders,
              COALESCE(SUM(o.total) FILTER (WHERE ${PAID}), 0) AS revenue,
              COALESCE(SUM(o.shipping_cost) FILTER (WHERE ${PAID}), 0) AS shipping,
              COALESCE(SUM(o.discount_amount) FILTER (WHERE ${PAID}), 0) AS discounts,
              COALESCE(SUM(COALESCE((SELECT i.tax_amount FROM invoices i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1),
                                    ROUND(o.total * 21 / 121.0))) FILTER (WHERE ${PAID}), 0) AS tax,
              COUNT(DISTINCT COALESCE(o.user_id::text, 'invitado-' || o.id::text)) FILTER (WHERE ${PAID}) AS buyers,
              COUNT(*) FILTER (WHERE ${PAID} AND COALESCE(o.promo_code, '') <> '') AS coupon_orders,
              COUNT(*) FILTER (WHERE ${VALID} AND NOT (o.paid_at IS NOT NULL OR o.status <> 'pending')) AS pending_orders,
              COALESCE(SUM(o.total) FILTER (WHERE ${VALID} AND NOT (o.paid_at IS NOT NULL OR o.status <> 'pending')), 0) AS pending_value,
              COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
              COUNT(*) FILTER (WHERE o.status = 'refunded') AS refunded_orders,
              COALESCE(SUM(o.refunded_amount), 0) AS refunded
         FROM orders o WHERE ${ORDER_RANGE}`,
      [from, to]),
    pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS units, COALESCE(SUM(COALESCE(p.cost, 0) * oi.quantity), 0) AS cost
         FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products p ON p.id = oi.product_id
        WHERE ${ORDER_RANGE} AND ${PAID}`,
      [from, to]),
  ]);
  const o = orders.rows[0] || {};
  return {
    orders: n(o.orders), revenueCents: n(o.revenue), shippingCents: n(o.shipping), discountCents: n(o.discounts), taxCents: n(o.tax),
    buyers: n(o.buyers), couponOrders: n(o.coupon_orders),
    pendingOrders: n(o.pending_orders), pendingCents: n(o.pending_value), cancelled: n(o.cancelled),
    refundedOrders: n(o.refunded_orders), refundedCents: n(o.refunded),
    units: n(items.rows[0]?.units), costCents: n(items.rows[0]?.cost),
  };
}

interface PeopleAgg {
  newCustomers: number; aiChats: number; aiAnonymous: number; aiHandoffs: number; aiTurns: number;
  advisorChats: number; advisorWaitMin: number | null; chatOrders: number; chatOrdersPaid: number;
  reviews: number; reviewsAvg: number | null; refundRequests: number;
}

/** Clientes nuevos, atención (asistente IA y asesores), reseñas y solicitudes de reembolso del periodo [from, to). */
async function peopleAgg(from: string, to: string): Promise<PeopleAgg> {
  const UTC_RANGE = (col: string) => `${col} >= ($1::timestamptz AT TIME ZONE 'UTC') AND ${col} < ($2::timestamptz AT TIME ZONE 'UTC')`;
  const TZ_RANGE = (col: string) => `${col} >= $1::timestamptz AND ${col} < $2::timestamptz`;
  const [users, ai, chats, chatOrders, reviews, refunds] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer' AND ${UTC_RANGE('created_at')}`, [from, to]),
    pool.query(
      `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE user_id = 0) AS anon,
              COUNT(*) FILTER (WHERE handoff_conversation_id IS NOT NULL) AS handoffs, COALESCE(SUM(turns), 0) AS turns
         FROM ai_chat_sessions WHERE ${TZ_RANGE('created_at')}`, [from, to]),
    pool.query(
      `SELECT COUNT(*) AS n,
              AVG(EXTRACT(EPOCH FROM (taken_at - created_at)) / 60) FILTER (WHERE taken_at IS NOT NULL) AS wait_min
         FROM chat_conversations WHERE ${TZ_RANGE('created_at')}`, [from, to]),
    pool.query(
      `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'ordered') AS ordered
         FROM chat_orders WHERE ${TZ_RANGE('created_at')}`, [from, to]),
    pool.query(`SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE ${TZ_RANGE('created_at')}`, [from, to]),
    pool.query(`SELECT COUNT(*) AS n FROM refund_requests WHERE ${TZ_RANGE('created_at')}`, [from, to]),
  ]);
  return {
    newCustomers: n(users.rows[0]?.n),
    aiChats: n(ai.rows[0]?.n), aiAnonymous: n(ai.rows[0]?.anon), aiHandoffs: n(ai.rows[0]?.handoffs), aiTurns: n(ai.rows[0]?.turns),
    advisorChats: n(chats.rows[0]?.n),
    advisorWaitMin: chats.rows[0]?.wait_min == null ? null : round1(n(chats.rows[0].wait_min)),
    chatOrders: n(chatOrders.rows[0]?.n), chatOrdersPaid: n(chatOrders.rows[0]?.ordered),
    reviews: n(reviews.rows[0]?.n), reviewsAvg: reviews.rows[0]?.avg == null ? null : round1(n(reviews.rows[0].avg)),
    refundRequests: n(refunds.rows[0]?.n),
  };
}

interface AbandonAgg { detected: number; valueCents: number; emailed: number; recovered: number; recoveredCents: number }

/** Carritos abandonados que ha detectado el sistema de recordatorios, y los que han vuelto a comprar. */
async function abandonAgg(from: string, to: string): Promise<AbandonAgg> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE first_added_at >= $1::timestamptz AND first_added_at < $2::timestamptz) AS detected,
            COALESCE(SUM(cart_total_cents) FILTER (WHERE first_added_at >= $1::timestamptz AND first_added_at < $2::timestamptz), 0) AS value,
            COUNT(*) FILTER (WHERE first_added_at >= $1::timestamptz AND first_added_at < $2::timestamptz AND emails_sent > 0) AS emailed,
            COUNT(*) FILTER (WHERE recovered_at >= $1::timestamptz AND recovered_at < $2::timestamptz) AS recovered,
            COALESCE(SUM(cart_total_cents) FILTER (WHERE recovered_at >= $1::timestamptz AND recovered_at < $2::timestamptz), 0) AS recovered_value
       FROM cart_abandoned_emails`,
    [from, to]);
  const r = rows[0] || {};
  return { detected: n(r.detected), valueCents: n(r.value), emailed: n(r.emailed), recovered: n(r.recovered), recoveredCents: n(r.recovered_value) };
}

/** Carritos que hay ahora mismo en la tienda (foto del momento). */
async function activeCarts(): Promise<OverviewReport['carts']> {
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id, c.items, c.updated_at, u.email,
            (c.updated_at < (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours') AS stale
       FROM carts c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.is_deleted = 0`);
  const list = rows
    .map((r: any) => {
      let items: any[] = [];
      try { const parsed = JSON.parse(r.items || '[]'); if (Array.isArray(parsed)) items = parsed; } catch { /* carrito con datos rotos: no cuenta */ }
      const units = items.reduce((s, i) => s + (Number(i?.quantity) || 1), 0);
      const value = items.reduce((s, i) => s + (Number(i?.price) || 0) * (Number(i?.quantity) || 1), 0);
      return { id: Number(r.id), email: r.email ? String(r.email) : null, value: round2(value), items: units, updatedAt: new Date(r.updated_at).toISOString(), guest: !r.user_id, stale: !!r.stale };
    })
    .filter((c) => c.items > 0);
  return {
    active: {
      count: list.length,
      value: round2(list.reduce((s, c) => s + c.value, 0)),
      guests: list.filter((c) => c.guest).length,
      stale: list.filter((c) => c.stale).length,
    },
    top: [...list].sort((a, b) => b.value - a.value).slice(0, 5).map(({ guest: _g, stale: _s, ...c }) => c),
  };
}

export interface OverviewData {
  salesCur: SalesAgg; salesPrev: SalesAgg;
  peopleCur: PeopleAgg; peoplePrev: PeopleAgg;
  abandonCur: AbandonAgg; abandonPrev: AbandonAgg;
  visitsCur: VisitsSummary | null; visitsPrev: VisitsSummary | null;
  googleCur: number | null; googlePrev: number | null;
  customersTotal: number;
  products: { published: number; inStock: number };
  cartsNow: OverviewReport['carts'];
  /** ¿Hay datos del periodo de comparación? (tienda: pedidos, clientes, chats…; visitas: estadísticas web). Por defecto sí. */
  prevAvail?: { store: boolean; visits: boolean };
}

const k = (id: string, group: KpiGroup, label: string, value: number, prev: number | null, unit: KpiUnit, good: Kpi['good'], hint?: string): Kpi =>
  ({ id, group, label, value, prev, unit, good, ...(hint ? { hint } : {}) });

/** Convierte los datos en bruto en la lista de KPIs (función pura: se prueba sin base de datos). */
export function buildKpis(d: OverviewData): Kpi[] {
  const s = d.salesCur, sp = d.salesPrev;
  const rev = eur(s.revenueCents), revP = eur(sp.revenueCents);
  const base = eur(s.revenueCents - s.taxCents), baseP = eur(sp.revenueCents - sp.taxCents);
  const margin = base - eur(s.costCents), marginP = baseP - eur(sp.costCents);
  const avg = s.orders ? rev / s.orders : 0, avgP = sp.orders ? revP / sp.orders : 0;
  const out: Kpi[] = [
    k('sales_revenue', 'ventas', 'Ventas (IVA incluido)', round2(rev), round2(revP), 'eur', 'up', 'Pedidos pagados, sin cancelados ni reembolsados.'),
    k('sales_orders', 'ventas', 'Pedidos pagados', s.orders, sp.orders, 'int', 'up'),
    k('sales_avg', 'ventas', 'Ticket medio', round2(avg), round2(avgP), 'eur', 'up', 'Ventas entre pedidos pagados.'),
    k('sales_units', 'ventas', 'Unidades vendidas', s.units, sp.units, 'int', 'up'),
    k('sales_base', 'ventas', 'Base imponible', round2(base), round2(baseP), 'eur', 'up', 'Ventas sin IVA (según factura o 21 %).'),
    k('sales_margin', 'ventas', 'Margen bruto estimado', round2(margin), round2(marginP), 'eur', 'up', 'Base imponible menos el coste de los productos. Sin coste no hay margen: el catálogo tiene productos sin coste.'),
    k('sales_margin_pct', 'ventas', 'Margen sobre la base', base > 0 ? round1((margin / base) * 100) : 0, baseP > 0 ? round1((marginP / baseP) * 100) : 0, 'pct', 'up'),
    k('sales_shipping', 'ventas', 'Envíos cobrados', eur(s.shippingCents), eur(sp.shippingCents), 'eur', null),
    k('sales_discounts', 'ventas', 'Descuentos aplicados', eur(s.discountCents), eur(sp.discountCents), 'eur', null),
    k('sales_coupon_orders', 'ventas', 'Pedidos con cupón', s.couponOrders, sp.couponOrders, 'int', null),
    k('sales_pending', 'ventas', 'Pedidos sin pagar', s.pendingOrders, sp.pendingOrders, 'int', 'down', `Valor: ${eur(s.pendingCents).toFixed(2)} €. Empezaron a pagar y no terminaron.`),
    k('sales_cancelled', 'ventas', 'Pedidos cancelados', s.cancelled, sp.cancelled, 'int', 'down'),
    k('sales_refunded', 'ventas', 'Importe reembolsado', eur(s.refundedCents), eur(sp.refundedCents), 'eur', 'down'),
  ];

  const v = d.visitsCur, vp = d.visitsPrev;
  if (v && vp) {
    out.push(
      k('visitors', 'visitas', 'Visitantes únicos', v.visitors, vp.visitors, 'int', 'up'),
      k('pageviews', 'visitas', 'Páginas vistas', v.pageviews, vp.pageviews, 'int', 'up'),
      k('pages_per_visitor', 'visitas', 'Páginas por visitante', v.visitors ? round1(v.pageviews / v.visitors) : 0, vp.visitors ? round1(vp.pageviews / vp.visitors) : 0, 'dec', 'up'),
      k('bounce_rate', 'visitas', 'Rebote (solo una página)', pct(v.bounces, v.visitors), pct(vp.bounces, vp.visitors), 'pct', 'down', 'Visitantes que ven una sola página y se van.'),
      k('mobile_pct', 'visitas', 'Visitas desde el móvil', pct(v.mobile, v.visitors), pct(vp.mobile, vp.visitors), 'pct', null),
      ...(d.googleCur != null && d.googlePrev != null
        ? [k('google_visitors', 'visitas', 'Visitantes desde Google', d.googleCur, d.googlePrev, 'int', 'up')] : []),
      k('product_views', 'visitas', 'Ven la ficha de un producto', v.productViews, vp.productViews, 'int', 'up'),
      k('search_visitors', 'visitas', 'Visitantes que buscan', v.searchSessions, vp.searchSessions, 'int', null),
      k('no_results', 'visitas', 'Visitantes con una búsqueda sin resultados', v.noResultSessions, vp.noResultSessions, 'int', 'down'),
      k('not_found', 'visitas', 'Páginas no encontradas (404)', v.notFoundEvents, vp.notFoundEvents, 'int', 'down'),
      k('chat_opens', 'visitas', 'Visitantes que abren el chat', v.chat, vp.chat, 'int', 'up'),
      k('conv_rate', 'visitas', 'Conversión (pedidos entre visitantes)', pct(s.orders, v.visitors), pct(sp.orders, vp.visitors), 'pct', 'up', 'Pedidos pagados entre visitantes únicos.'),
    );
  }

  if (v && vp) {
    out.push(
      k('carts_added', 'carritos', 'Visitantes que añaden al carrito', v.addToCart, vp.addToCart, 'int', 'up'),
      k('carts_added_rate', 'carritos', 'Visitantes que añaden al carrito (%)', pct(v.addToCart, v.visitors), pct(vp.addToCart, vp.visitors), 'pct', 'up'),
      k('carts_added_value', 'carritos', 'Valor añadido a carritos', v.cartValue, vp.cartValue, 'eur', 'up', 'Suma de todo lo que se ha añadido al carrito (precio × cantidad).'),
      k('carts_avg_value', 'carritos', 'Valor medio por visitante con carrito', v.addToCart ? round2(v.cartValue / v.addToCart) : 0, vp.addToCart ? round2(vp.cartValue / vp.addToCart) : 0, 'eur', 'up'),
      k('checkout_starts', 'carritos', 'Visitantes que empiezan a pagar', v.checkout, vp.checkout, 'int', 'up'),
      k('cart_to_checkout', 'carritos', 'Del carrito al pago (%)', pct(v.checkout, v.addToCart), pct(vp.checkout, vp.addToCart), 'pct', 'up', 'De los que añaden algo, cuántos llegan a empezar el pago.'),
    );
  }
  const a = d.abandonCur, ap = d.abandonPrev;
  out.push(
    k('carts_active', 'carritos', 'Carritos activos ahora', d.cartsNow.active.count, null, 'int', null, 'Foto del momento (no depende del periodo).'),
    k('carts_active_value', 'carritos', 'Valor en carritos activos', d.cartsNow.active.value, null, 'eur', null, 'Foto del momento.'),
    k('carts_stale', 'carritos', 'Carritos sin tocar desde hace más de 24 h', d.cartsNow.active.stale, null, 'int', null, 'Foto del momento: los que más riesgo tienen de perderse.'),
    k('abandoned_detected', 'carritos', 'Carritos abandonados detectados', a.detected, ap.detected, 'int', 'down', 'Clientes con cuenta que dejaron productos en el carrito.'),
    k('abandoned_value', 'carritos', 'Valor de los carritos abandonados', eur(a.valueCents), eur(ap.valueCents), 'eur', 'down'),
    k('abandoned_emailed', 'carritos', 'Carritos con recordatorio enviado', a.emailed, ap.emailed, 'int', null),
    k('abandoned_recovered', 'carritos', 'Carritos recuperados', a.recovered, ap.recovered, 'int', 'up'),
    k('abandoned_recovered_value', 'carritos', 'Valor recuperado', eur(a.recoveredCents), eur(ap.recoveredCents), 'eur', 'up'),
  );

  const p = d.peopleCur, pp = d.peoplePrev;
  out.push(
    k('customers_total', 'clientes', 'Clientes registrados', d.customersTotal, null, 'int', null, 'Total de cuentas de cliente hoy.'),
    k('customers_new', 'clientes', 'Clientes nuevos', p.newCustomers, pp.newCustomers, 'int', 'up'),
    k('buyers', 'clientes', 'Compradores distintos', s.buyers, sp.buyers, 'int', 'up'),
    k('ai_chats', 'atencion', 'Conversaciones con el asistente IA', p.aiChats, pp.aiChats, 'int', 'up'),
    k('ai_anonymous', 'atencion', 'Del asistente, de visitantes sin cuenta', p.aiAnonymous, pp.aiAnonymous, 'int', null),
    k('ai_handoff_rate', 'atencion', 'Conversaciones con IA que acaban con un asesor (%)', pct(p.aiHandoffs, p.aiChats), pct(pp.aiHandoffs, pp.aiChats), 'pct', null, 'Cuanto más bajo, más resuelve la IA sola.'),
    k('advisor_chats', 'atencion', 'Chats con un asesor', p.advisorChats, pp.advisorChats, 'int', null),
    ...(p.advisorWaitMin != null || pp.advisorWaitMin != null
      ? [k('advisor_wait', 'atencion', 'Espera media hasta la primera respuesta (min)', p.advisorWaitMin ?? 0, pp.advisorWaitMin, 'dec', 'down')] : []),
    k('advisor_orders', 'atencion', 'Propuestas de pedido de asesores', p.chatOrders, pp.chatOrders, 'int', 'up'),
    k('reviews_new', 'atencion', 'Reseñas nuevas', p.reviews, pp.reviews, 'int', 'up'),
    ...(p.reviewsAvg != null ? [k('reviews_avg', 'atencion', 'Nota media de las reseñas nuevas', p.reviewsAvg, pp.reviewsAvg, 'dec', 'up')] : []),
    k('refund_requests', 'atencion', 'Solicitudes de reembolso', p.refundRequests, pp.refundRequests, 'int', 'down'),
    k('products_published', 'catalogo', 'Productos publicados', d.products.published, null, 'int', null, 'Foto del momento.'),
    k('products_in_stock', 'catalogo', 'Productos con stock', d.products.inStock, null, 'int', null, 'Foto del momento (copia diaria del catálogo del proveedor).'),
    k('products_in_stock_pct', 'catalogo', 'Productos publicados con stock (%)', pct(d.products.inStock, d.products.published), null, 'pct', null),
  );
  return applyAvailability(out, d.prevAvail);
}

/** KPIs que salen de las estadísticas web (el resto sale de la base de datos de la tienda). */
const VISITS_KPIS = new Set(['carts_added', 'carts_added_rate', 'carts_added_value', 'carts_avg_value', 'checkout_starts', 'cart_to_checkout']);
const sources = (kpi: Kpi): ('store' | 'visits')[] =>
  kpi.id === 'conv_rate' ? ['store', 'visits'] : kpi.group === 'visitas' || VISITS_KPIS.has(kpi.id) ? ['visits'] : ['store'];

/** Si no hay datos del periodo de comparación, el KPI no se compara (`noPrev`) en lugar de comparar con un cero inventado. */
export function applyAvailability(list: Kpi[], avail?: { store: boolean; visits: boolean }): Kpi[] {
  if (!avail) return list;
  return list.map((x) => (x.prev == null || sources(x).every((s) => avail[s]) ? x : { ...x, prev: null, noPrev: true }));
}

const HEADLINE = ['sales_revenue', 'sales_orders', 'sales_avg', 'visitors', 'conv_rate', 'carts_added', 'carts_active_value', 'customers_new'];

/** Rellena los días sin ventas con ceros para que la gráfica no tenga huecos. */
function fillSalesDays(rows: { d: string; orders: unknown; revenue: unknown }[], from: string, to: string) {
  const byDate = new Map(rows.map((r) => [r.d, { orders: n(r.orders), revenue: eur(r.revenue) }]));
  return listDays(from, to).map((date) => ({ date, ...(byDate.get(date) || { orders: 0, revenue: 0 }) }));
}

let storeSinceCache: { at: number; value: string | null } | null = null;

/** Primer día con datos de la tienda (pedidos o clientes), en hora de Madrid. */
async function getStoreSince(): Promise<string | null> {
  if (storeSinceCache && Date.now() - storeSinceCache.at < 6 * 3_600_000) return storeSinceCache.value;
  const { rows } = await pool.query(
    `SELECT to_char((LEAST((SELECT MIN(created_at) FROM orders), (SELECT MIN(created_at) FROM users)) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS d`);
  const value = rows[0]?.d ? String(rows[0].d) : null;
  storeSinceCache = { at: Date.now(), value };
  return value;
}

/** Alinea por posición una serie de días del periodo de comparación con la del periodo (mismo número de huecos). */
export function alignSeries(prevDays: string[], values: Map<string, number>, length: number, available: boolean): (number | null)[] {
  return Array.from({ length }, (_, i) => (available && i < prevDays.length ? values.get(prevDays[i]) ?? 0 : null));
}

const cache = new Map<string, { at: number; result: Promise<OverviewReport> }>();
const CACHE_MS = 60_000;

export function getOverviewReport(input: { preset?: unknown; from?: unknown; to?: unknown; compare?: unknown }, excludeInternal = true): Promise<OverviewReport> {
  const period = resolvePeriod(input);
  const key = `${period.from}|${period.to}|${period.compare}|${excludeInternal}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = computeReport(period, excludeInternal);
  cache.set(key, { at: Date.now(), result });
  result.catch(() => { if (cache.get(key)?.result === result) cache.delete(key); });
  if (cache.size > 40) for (const [kk, vv] of cache) if (Date.now() - vv.at > CACHE_MS) cache.delete(kk);
  return result;
}

async function computeReport(period: ResolvedPeriod, excludeInternal: boolean): Promise<OverviewReport> {
  // Límites exactos (con el cambio horario de Madrid) de los dos periodos, calculados por Postgres.
  // En «Hoy», el periodo de comparación termina a esta misma hora (`prevUntil`) en lugar de al acabar el día.
  const { rows: b } = await pool.query(
    `SELECT ($1::date)::timestamp AT TIME ZONE 'Europe/Madrid' AS f, (($2::date) + 1)::timestamp AT TIME ZONE 'Europe/Madrid' AS t,
            ($3::date)::timestamp AT TIME ZONE 'Europe/Madrid' AS pf,
            CASE WHEN $5::time IS NULL THEN (($4::date) + 1)::timestamp AT TIME ZONE 'Europe/Madrid'
                 ELSE (($4::date) + $5::time)::timestamp AT TIME ZONE 'Europe/Madrid' END AS pt`,
    [period.from, period.to, period.prevFrom, period.prevTo, period.prevUntil]);
  const iso = (v: Date) => new Date(v).toISOString();
  const [from, to, pFrom, pTo] = [iso(b[0].f), iso(b[0].t), iso(b[0].pf), iso(b[0].pt)];
  const warnings: string[] = [];

  const safe = async <T>(what: string, p: Promise<T>): Promise<T | null> => {
    try { return await p; } catch (e: any) {
      console.error(`[OVERVIEW] ${what}:`, e?.message || e);
      warnings.push(`${what} no están disponibles ahora; el informe sale sin ese apartado.`);
      return null;
    }
  };

  const [storeSince, visitsSince] = await Promise.all([getStoreSince().catch(() => null), getVisitsSince().catch(() => null)]);
  // Sin datos de ese periodo (anterior a lo primero que hay) no se compara: «0» sería inventado.
  const prevAvail = { store: !storeSince || period.prevTo >= storeSince, visits: !!visitsSince && period.prevTo >= visitsSince };
  const partial = (since: string | null, what: string) =>
    since && period.prevFrom < since && period.prevTo >= since ? `${what} solo hay datos desde el ${since.split('-').reverse().join('/')}: la comparación cubre solo parte del periodo.` : null;

  const [salesCur, salesPrev, peopleCur, peoplePrev, abandonCur, abandonPrev, cartsNow, visitsCur, visitsPrev, visitsDetail, google, extra, prevSeries] = await Promise.all([
    salesAgg(from, to), salesAgg(pFrom, pTo),
    peopleAgg(from, to), peopleAgg(pFrom, pTo),
    abandonAgg(from, to), abandonAgg(pFrom, pTo),
    activeCarts(),
    safe('Las estadísticas de visitas', getVisitsSummary(from, to, excludeInternal)),
    safe('Las estadísticas de visitas del periodo de comparación', getVisitsSummary(pFrom, pTo, excludeInternal)),
    safe('El detalle de visitas', getVisitsDetail(from, to, excludeInternal)),
    safe('Los orígenes de tráfico', googleCounts(from, to, pFrom, pTo, excludeInternal)),
    Promise.all([
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer'`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'published') AS pub, COUNT(*) FILTER (WHERE status = 'published' AND stock > 0) AS in_stock FROM products`),
      pool.query(
        `SELECT to_char((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS d, COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue
           FROM orders o WHERE ${ORDER_RANGE} AND ${PAID} GROUP BY 1`, [from, to]),
      pool.query(
        `SELECT p.name, p.sku, SUM(oi.quantity) AS units, SUM(oi.price * oi.quantity) AS revenue
           FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products p ON p.id = oi.product_id
          WHERE ${ORDER_RANGE} AND ${PAID} AND p.name IS NOT NULL
          GROUP BY p.name, p.sku ORDER BY revenue DESC LIMIT 8`, [from, to]),
      pool.query(
        `SELECT COALESCE(NULLIF(o.payment_method, ''), 'otro') AS method, COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue
           FROM orders o WHERE ${ORDER_RANGE} AND ${PAID} GROUP BY 1 ORDER BY revenue DESC`, [from, to]),
      pool.query(
        `SELECT UPPER(o.promo_code) AS code, COUNT(*) AS orders, COALESCE(SUM(o.discount_amount), 0) AS discount
           FROM orders o WHERE ${ORDER_RANGE} AND ${PAID} AND COALESCE(o.promo_code, '') <> ''
          GROUP BY 1 ORDER BY orders DESC LIMIT 5`, [from, to]),
    ]),
    Promise.all([
      pool.query(
        `SELECT to_char((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS d, COALESCE(SUM(o.total), 0) AS revenue
           FROM orders o WHERE ${ORDER_RANGE} AND ${PAID} GROUP BY 1`, [pFrom, pTo]),
      safe('Las visitas por día del periodo de comparación', getVisitsDays(pFrom, pTo, excludeInternal)),
    ]),
  ]);
  const [customers, products, byDay, topProducts, payments, coupons] = extra;
  const [prevSales, prevVisitDays] = prevSeries;

  const data: OverviewData = {
    salesCur, salesPrev, peopleCur, peoplePrev, abandonCur, abandonPrev,
    visitsCur, visitsPrev,
    googleCur: google?.cur ?? null, googlePrev: google?.prev ?? null,
    customersTotal: n(customers.rows[0]?.n),
    products: { published: n(products.rows[0]?.pub), inStock: n(products.rows[0]?.in_stock) },
    cartsNow,
    prevAvail,
  };

  const funnel: FunnelStep[] = visitsCur && visitsPrev ? [
    { key: 'visitors', label: 'Visitantes', current: visitsCur.visitors, previous: prevAvail.visits ? visitsPrev.visitors : null },
    { key: 'product', label: 'Ven una ficha', current: visitsCur.productViews, previous: prevAvail.visits ? visitsPrev.productViews : null },
    { key: 'cart', label: 'Añaden al carrito', current: visitsCur.addToCart, previous: prevAvail.visits ? visitsPrev.addToCart : null },
    { key: 'checkout', label: 'Empiezan a pagar', current: visitsCur.checkout, previous: prevAvail.visits ? visitsPrev.checkout : null },
    { key: 'order', label: 'Pedido pagado', current: salesCur.orders, previous: prevAvail.visits && prevAvail.store ? salesPrev.orders : null },
  ] : [];

  const currentDays = listDays(period.from, period.to);
  const prevDays = listDays(period.prevFrom, period.prevTo);
  const compareSeries: OverviewReport['compareSeries'] = {
    revenue: alignSeries(prevDays, new Map((prevSales.rows as any[]).map((r) => [r.d, eur(r.revenue)])), currentDays.length, prevAvail.store),
    visitors: alignSeries(prevDays, new Map((prevVisitDays || []).map((r) => [r.date, r.visitors])), currentDays.length, prevAvail.visits && !!prevVisitDays),
    carts: alignSeries(prevDays, new Map((prevVisitDays || []).map((r) => [r.date, r.carts])), currentDays.length, prevAvail.visits && !!prevVisitDays),
  };
  for (const w of [partial(storeSince, 'De las ventas, los clientes y la atención de ese periodo'), partial(visitsSince, 'De las visitas')]) if (w) warnings.push(w);

  return {
    period,
    generatedAt: new Date().toISOString(),
    excludeInternal,
    headline: HEADLINE,
    kpis: buildKpis(data),
    sales: {
      byDay: fillSalesDays(byDay.rows as any, period.from, period.to),
      topProducts: topProducts.rows.map((r: any) => ({ name: String(r.name), sku: String(r.sku || ''), units: n(r.units), revenue: eur(r.revenue) })),
      payments: payments.rows.map((r: any) => ({ method: String(r.method), orders: n(r.orders), revenue: eur(r.revenue) })),
      coupons: coupons.rows.map((r: any) => ({ code: String(r.code), orders: n(r.orders), discount: eur(r.discount) })),
    },
    visits: visitsDetail,
    compareSeries,
    dataSince: { store: storeSince, visits: visitsSince },
    funnel,
    carts: cartsNow,
    warnings,
  };
}

/** Visitantes que llegaron desde Google en cada periodo (origen = referrer de su primera página del periodo). */
async function googleCounts(from: string, to: string, pFrom: string, pTo: string, excludeInternal: boolean): Promise<{ cur: number; prev: number }> {
  const { getUmamiPool, getInternalFilterSql } = await import('./umami-db.js');
  const internal = getInternalFilterSql(excludeInternal, 's');
  const one = async (f: string, t: string) => {
    const { rows } = await getUmamiPool().query(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT ON (e.session_id) e.session_id, e.referrer_domain
           FROM website_event e JOIN session s ON s.session_id = e.session_id
          WHERE e.event_type = 1 AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz ${internal}
          ORDER BY e.session_id, e.created_at ASC) f
        WHERE f.referrer_domain LIKE '%google%'`, [f, t]);
    return n(rows[0]?.n);
  };
  const [cur, prev] = await Promise.all([one(from, to), one(pFrom, pTo)]);
  return { cur, prev };
}
