/**
 * Visitas, embudo y carritos de la web para un periodo cualquiera (informe de la Vista general).
 *
 * Usa los mismos datos y definiciones que «Estadísticas web» (base de Umami: un visitante = una sesión que ha visto
 * al menos una página; excluye el tráfico propio de Canarias), pero con fechas libres en lugar de los cinco periodos
 * fijos de allí. Todas las consultas van parametrizadas con el inicio y el final (`timestamptz`) del periodo.
 */
import { getUmamiPool, getInternalFilterSql } from './umami-db.js';

export interface VisitsSummary {
  visitors: number;
  pageviews: number;
  /** Visitantes que solo vieron una página. */
  bounces: number;
  mobile: number;
  /** Visitantes que han llegado a cada paso (cada uno cuenta una vez). */
  productViews: number;
  addToCart: number;
  checkout: number;
  purchase: number;
  chat: number;
  signUps: number;
  searchSessions: number;
  noResultSessions: number;
  /** Veces que se llegó a una página que no existe (404). */
  notFoundEvents: number;
  /** Veces que se añadió algo al carrito (un visitante puede sumar varias). */
  addToCartEvents: number;
  /** Euros en productos añadidos al carrito (precio × cantidad de cada «añadir»). */
  cartValue: number;
}

export interface VisitsDay {
  date: string;
  visitors: number;
  pageviews: number;
  carts: number;
  checkouts: number;
  cartValue: number;
}

export interface VisitsDetail {
  byDay: VisitsDay[];
  topPages: { path: string; title: string; views: number; visitors: number }[];
  sources: { name: string; visitors: number }[];
  cities: { city: string; country: string; visitors: number }[];
  devices: { device: string; visitors: number }[];
  topSearches: { term: string; count: number }[];
  noResultSearches: { term: string; count: number }[];
  topBikes: { term: string; count: number }[];
}

const n = (v: unknown): number => Number(v) || 0;
const round2 = (v: number): number => Math.round(v * 100) / 100;

const RANGE = `e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz`;

/** Resumen de visitantes, embudo y carritos del periodo [from, to). */
export async function getVisitsSummary(from: string, to: string, excludeInternal = true): Promise<VisitsSummary> {
  const pool = getUmamiPool();
  const internal = getInternalFilterSql(excludeInternal, 's');
  const [sessions, cart] = await Promise.all([
    pool.query(
      `WITH sess AS (
         SELECT e.session_id,
                COUNT(*) FILTER (WHERE e.event_type = 1) AS pv,
                COUNT(*) FILTER (WHERE e.event_name = 'view_product_detail') AS pd,
                COUNT(*) FILTER (WHERE e.event_name = 'add_to_cart') AS atc,
                COUNT(*) FILTER (WHERE e.event_name IN ('checkout_start', 'checkout_payment')) AS co,
                COUNT(*) FILTER (WHERE e.event_name = 'purchase') AS pu,
                COUNT(*) FILTER (WHERE e.event_name IN ('chat_open', 'chat_proposal_open')) AS chat,
                COUNT(*) FILTER (WHERE e.event_name = 'sign_up') AS su,
                COUNT(*) FILTER (WHERE e.event_name = 'search') AS se,
                COUNT(*) FILTER (WHERE e.event_name = 'search_no_results') AS nr,
                COUNT(*) FILTER (WHERE e.event_name = 'not_found') AS nf,
                MAX(s.device) AS device
           FROM website_event e
           JOIN session s ON s.session_id = e.session_id
          WHERE ${RANGE} ${internal}
          GROUP BY e.session_id
         HAVING COUNT(*) FILTER (WHERE e.event_type = 1) > 0)
       SELECT COUNT(*) AS visitors, COALESCE(SUM(pv), 0) AS pageviews,
              COUNT(*) FILTER (WHERE pv = 1) AS bounces,
              COUNT(*) FILTER (WHERE device = 'mobile') AS mobile,
              COUNT(*) FILTER (WHERE pd > 0) AS product_views,
              COUNT(*) FILTER (WHERE atc > 0) AS add_to_cart,
              COUNT(*) FILTER (WHERE co > 0) AS checkout,
              COUNT(*) FILTER (WHERE pu > 0) AS purchase,
              COUNT(*) FILTER (WHERE chat > 0) AS chat,
              COUNT(*) FILTER (WHERE su > 0) AS sign_ups,
              COUNT(*) FILTER (WHERE se > 0) AS search_sessions,
              COUNT(*) FILTER (WHERE nr > 0) AS no_result_sessions,
              COALESCE(SUM(nf), 0) AS not_found_events,
              COALESCE(SUM(atc), 0) AS add_to_cart_events
         FROM sess`,
      [from, to]),
    pool.query(
      `SELECT COALESCE(SUM(v.number_value * COALESCE(q.number_value, 1)), 0) AS cart_value
         FROM website_event e
         JOIN session s ON s.session_id = e.session_id
         JOIN event_data v ON v.website_event_id = e.event_id AND v.data_key = 'value'
         LEFT JOIN event_data q ON q.website_event_id = e.event_id AND q.data_key = 'quantity'
        WHERE e.event_name = 'add_to_cart' AND ${RANGE} ${internal}`,
      [from, to]),
  ]);
  const r = sessions.rows[0] || {};
  return {
    visitors: n(r.visitors),
    pageviews: n(r.pageviews),
    bounces: n(r.bounces),
    mobile: n(r.mobile),
    productViews: n(r.product_views),
    addToCart: n(r.add_to_cart),
    checkout: n(r.checkout),
    purchase: n(r.purchase),
    chat: n(r.chat),
    signUps: n(r.sign_ups),
    searchSessions: n(r.search_sessions),
    noResultSessions: n(r.no_result_sessions),
    notFoundEvents: n(r.not_found_events),
    addToCartEvents: n(r.add_to_cart_events),
    cartValue: round2(n(cart.rows[0]?.cart_value)),
  };
}

/** Series por día, páginas, orígenes, ciudades, dispositivos y búsquedas del periodo [from, to). */
export async function getVisitsDetail(from: string, to: string, excludeInternal = true): Promise<VisitsDetail> {
  const pool = getUmamiPool();
  const internal = getInternalFilterSql(excludeInternal, 's');
  const DAY = `to_char(e.created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD')`;

  const [days, dayCart, pages, sources, cities, devices, terms] = await Promise.all([
    pool.query(
      `SELECT ${DAY} AS d,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_type = 1) AS visitors,
              COUNT(*) FILTER (WHERE e.event_type = 1) AS pageviews,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name = 'add_to_cart') AS carts,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name IN ('checkout_start', 'checkout_payment')) AS checkouts
         FROM website_event e JOIN session s ON s.session_id = e.session_id
        WHERE ${RANGE} ${internal}
        GROUP BY 1 ORDER BY 1`,
      [from, to]),
    pool.query(
      `SELECT ${DAY} AS d, SUM(v.number_value * COALESCE(q.number_value, 1)) AS value
         FROM website_event e
         JOIN session s ON s.session_id = e.session_id
         JOIN event_data v ON v.website_event_id = e.event_id AND v.data_key = 'value'
         LEFT JOIN event_data q ON q.website_event_id = e.event_id AND q.data_key = 'quantity'
        WHERE e.event_name = 'add_to_cart' AND ${RANGE} ${internal}
        GROUP BY 1`,
      [from, to]),
    pool.query(
      `SELECT e.url_path AS path,
              COALESCE((ARRAY_AGG(e.page_title ORDER BY e.created_at DESC) FILTER (WHERE e.page_title <> ''))[1], '') AS title,
              COUNT(*) AS views, COUNT(DISTINCT e.session_id) AS visitors
         FROM website_event e JOIN session s ON s.session_id = e.session_id
        WHERE e.event_type = 1 AND ${RANGE} ${internal}
        GROUP BY e.url_path ORDER BY views DESC, visitors DESC LIMIT 10`,
      [from, to]),
    // Origen de cada visitante = el referrer de la primera página que vio en el periodo.
    pool.query(
      `SELECT CASE
                WHEN f.referrer_domain LIKE '%google%' THEN 'Google'
                WHEN f.referrer_domain IS NULL OR f.referrer_domain = '' OR f.referrer_domain LIKE '%escapesymas%' THEN 'Directo / sin origen'
                WHEN f.referrer_domain LIKE '%bing%' THEN 'Bing'
                WHEN f.referrer_domain LIKE '%duckduckgo%' THEN 'DuckDuckGo'
                WHEN f.referrer_domain LIKE '%yahoo%' THEN 'Yahoo'
                WHEN f.referrer_domain LIKE '%instagram%' THEN 'Instagram'
                WHEN f.referrer_domain LIKE '%tiktok%' THEN 'TikTok'
                WHEN f.referrer_domain LIKE '%facebook%' THEN 'Facebook'
                ELSE f.referrer_domain
              END AS name, COUNT(*) AS visitors
         FROM (SELECT DISTINCT ON (e.session_id) e.session_id, e.referrer_domain
                 FROM website_event e JOIN session s ON s.session_id = e.session_id
                WHERE e.event_type = 1 AND ${RANGE} ${internal}
                ORDER BY e.session_id, e.created_at ASC) f
        GROUP BY 1 ORDER BY visitors DESC LIMIT 8`,
      [from, to]),
    pool.query(
      `SELECT COALESCE(NULLIF(s.city, ''), 'Desconocida') AS city, COALESCE(s.country, 'ES') AS country, COUNT(DISTINCT s.session_id) AS visitors
         FROM website_event e JOIN session s ON s.session_id = e.session_id
        WHERE e.event_type = 1 AND ${RANGE} ${internal}
        GROUP BY 1, 2 ORDER BY visitors DESC LIMIT 8`,
      [from, to]),
    pool.query(
      `SELECT COALESCE(s.device, 'desktop') AS device, COUNT(DISTINCT s.session_id) AS visitors
         FROM website_event e JOIN session s ON s.session_id = e.session_id
        WHERE e.event_type = 1 AND ${RANGE} ${internal}
        GROUP BY 1 ORDER BY visitors DESC`,
      [from, to]),
    pool.query(
      `SELECT e.event_name, LOWER(TRIM(ed.string_value)) AS term, COUNT(*) AS n
         FROM website_event e
         JOIN session s ON s.session_id = e.session_id
         JOIN event_data ed ON ed.website_event_id = e.event_id
        WHERE ((e.event_name IN ('search', 'search_no_results') AND ed.data_key = 'query')
            OR (e.event_name = 'bike_selected' AND ed.data_key = 'bike'))
          AND COALESCE(TRIM(ed.string_value), '') <> ''
          AND ${RANGE} ${internal}
        GROUP BY e.event_name, LOWER(TRIM(ed.string_value))
        ORDER BY n DESC`,
      [from, to]),
  ]);

  const cartByDay = new Map<string, number>(dayCart.rows.map((r: any) => [r.d, round2(n(r.value))]));
  const termList = (name: string) =>
    terms.rows.filter((r: any) => r.event_name === name).slice(0, 8).map((r: any) => ({ term: String(r.term), count: n(r.n) }));

  return {
    byDay: days.rows.map((r: any) => ({
      date: r.d, visitors: n(r.visitors), pageviews: n(r.pageviews), carts: n(r.carts), checkouts: n(r.checkouts), cartValue: cartByDay.get(r.d) || 0,
    })),
    topPages: pages.rows.map((r: any) => ({ path: String(r.path), title: String(r.title || ''), views: n(r.views), visitors: n(r.visitors) })),
    sources: sources.rows.map((r: any) => ({ name: String(r.name || 'Otros'), visitors: n(r.visitors) })),
    cities: cities.rows.map((r: any) => ({ city: String(r.city), country: String(r.country), visitors: n(r.visitors) })),
    devices: devices.rows.map((r: any) => ({ device: String(r.device), visitors: n(r.visitors) })),
    topSearches: termList('search'),
    noResultSearches: termList('search_no_results'),
    topBikes: termList('bike_selected'),
  };
}
