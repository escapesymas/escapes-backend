import pkg from 'pg';
import {
  type VisitorSignals, type VisitorTier,
  signalsFromRow, visitorTier, visitorScore, compareVisitors, emptySignals,
} from './visitor-score.js';
const { Pool } = pkg;

let umamiPool: any = null;

/**
 * Obtiene o inicializa el pool de conexiones hacia la base de datos de Umami.
 * Si no se define UMAMI_DATABASE_URL explícitamente en el entorno, se deriva
 * de DATABASE_URL cambiando la base de datos a /umami.
 */
export function getUmamiPool(): any {
  if (umamiPool) return umamiPool;

  let connectionString = process.env.UMAMI_DATABASE_URL;
  if (!connectionString && process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      u.pathname = '/umami';
      connectionString = u.toString();
    } catch (e: any) {
      console.error('[UMAMI DB] No se pudo derivar la URL de Umami de DATABASE_URL:', e.message);
    }
  }

  if (!connectionString) {
    throw new Error('UMAMI_DATABASE_URL no configurada y no se pudo derivar de DATABASE_URL');
  }

  umamiPool = new Pool({
    connectionString,
    ssl: false,
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Una consulta de estadísticas que se descontrole no debe dejar a Postgres trabajando minutos: el cliente HTTP
    // que se rinde no la cancela, y el panel las repite cada pocos segundos.
    statement_timeout: 15_000,
    max: 10,
  });

  umamiPool.on('error', (err: any) => {
    console.error('[UMAMI DB] Error en conexión ociosa de Umami:', err.message);
  });

  return umamiPool;
}

export interface SessionEventItem {
  eventId: string;
  createdAt: string;
  timeFormatted: string;
  /** Día (DD/MM, hora de Madrid): una sesión de Umami puede abarcar varios días. */
  dateFormatted: string;
  secondsFromStart: number;
  timeOnPageSeconds: number | null;
  eventType: number;
  eventName: string;
  urlPath: string;
  pageTitle: string;
  referrerDomain: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  eventData: { key: string; value: string }[];
}

export interface SessionDetailResponse {
  session: {
    sessionId: string;
    city: string;
    region: string;
    country: string;
    device: string;
    os: string;
    browser: string;
    screen: string;
    language: string;
    sessionStart: string;
    lastActiveAt: string;
    durationSeconds: number;
    totalEvents: number;
    initialReferrer: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
  };
  /** Resumen para ver de un vistazo si es un visitante que interesa (misma puntuación que el listado). */
  summary: {
    signals: VisitorSignals;
    tier: VisitorTier;
    score: number;
    /** Euros en productos que añadió al carrito (precio × cantidad en cada «añadir»). */
    cartValue: number;
  };
  events: SessionEventItem[];
}

/** Búsquedas y motos que un visitante ha escrito o elegido (para enseñarlas junto a su fila). */
export interface VisitorInterests {
  searches: string[];
  bikes: string[];
}

export interface RealtimeActiveUser extends VisitorInterests {
  sessionId: string;
  city: string;
  region: string;
  country: string;
  device: string;
  os: string;
  browser: string;
  lastActiveAt: string;
  sessionStart: string;
  secondsAgo: number;
  /** Eventos (páginas y acciones) en los últimos 30 minutos. */
  totalEvents: number;
  currentPage: string;
  pageTitle: string;
  referrerDomain: string | null;
  /** Lo hecho en su visita actual (que puede haber empezado hace más de 30 minutos). */
  signals: VisitorSignals;
  tier: VisitorTier;
  score: number;
  cartValue: number;
  visitStart: string;
  durationSeconds: number;
}

export interface RealtimePageView {
  eventId: string;
  sessionId: string;
  createdAt: string;
  secondsAgo: number;
  urlPath: string;
  pageTitle: string;
  referrerDomain: string | null;
  city: string;
  country: string;
  device: string;
}

export interface RealtimeStatsResponse {
  online5m: number;
  online15m: number;
  online30m: number;
  users: RealtimeActiveUser[];
  recentPageviews: RealtimePageView[];
  timestamp: string;
}

export interface AnalyticsStatsResponse {
  overview: {
    totalVisitors: number;
    totalPageviews: number;
    googleVisitors: number;
    directVisitors: number;
    mobileVisitors: number;
    mobilePercent: number;
    avgPagesPerVisit: number;
  };
  timeSeries: {
    label: string;
    visitors: number;
    pageviews: number;
    google: number;
  }[];
  topPages: {
    path: string;
    /** Título más reciente de la página (en una ficha de producto es su nombre). */
    title: string;
    views: number;
    visitors: number;
  }[];
  topReferrers: {
    domain: string;
    visitors: number;
    views: number;
  }[];
  topLocations: {
    city: string;
    region: string;
    country: string;
    visitors: number;
  }[];
  devices: {
    device: string;
    count: number;
    percent: number;
  }[];
  operatingSystems: {
    os: string;
    count: number;
    percent: number;
  }[];
  browsers: {
    browser: string;
    count: number;
    percent: number;
  }[];
}

export type StatsRange = 'today' | '24h' | '7d' | '30d' | 'all';

/** Condición SQL (sobre `e.created_at`) del periodo pedido; por horas si es hoy o 24 h, por días en el resto. */
function getRangeFilter(range: StatsRange): { clause: string; isHourly: boolean } {
  const startOfTodayMadrid = `e.created_at >= (NOW() AT TIME ZONE 'Europe/Madrid')::date::timestamp AT TIME ZONE 'Europe/Madrid'`;
  switch (range) {
    case '24h': return { clause: `e.created_at >= NOW() - INTERVAL '24 hours'`, isHourly: true };
    case '7d': return { clause: `e.created_at >= NOW() - INTERVAL '7 days'`, isHourly: false };
    case '30d': return { clause: `e.created_at >= NOW() - INTERVAL '30 days'`, isHourly: false };
    case 'all': return { clause: `e.created_at >= '2026-01-01 00:00:00'`, isHourly: false };
    case 'today':
    default: return { clause: startOfTodayMadrid, isHourly: true };
  }
}

/**
 * Columnas COUNT de lo que ha hecho un visitante (las que lee `signalsFromRow`) sobre las filas `alias` de website_event.
 * Se reutilizan en el tiempo real, en el listado de destacados y en el detalle.
 */
export function signalColumnsSql(alias: string): string {
  return `
      COUNT(*) FILTER (WHERE ${alias}.event_type = 1) AS pageviews,
      COUNT(*) FILTER (WHERE ${alias}.event_name = 'view_product_detail') AS product_views,
      COUNT(DISTINCT ${alias}.visit_id) AS visits,
      COUNT(*) FILTER (WHERE ${alias}.event_name = 'add_to_cart') AS add_to_cart,
      COUNT(*) FILTER (WHERE ${alias}.event_name IN ('checkout_start', 'checkout_payment')) AS checkout,
      COUNT(*) FILTER (WHERE ${alias}.event_name = 'purchase') AS purchase,
      COUNT(*) FILTER (WHERE ${alias}.event_name IN ('chat_open', 'chat_proposal_open')) AS chat,
      COUNT(*) FILTER (WHERE ${alias}.event_name = 'sign_up') AS sign_up,
      COUNT(*) FILTER (WHERE ${alias}.event_name = 'search') AS searches,
      COUNT(*) FILTER (WHERE ${alias}.event_name = 'search_no_results') AS no_results,
      COUNT(*) FILTER (WHERE ${alias}.event_name = 'bike_selected') AS bikes`;
}

/**
 * Valor en euros de los «añadir al carrito» (precio × cantidad) de cada visitante sobre las filas `alias`.
 * Devuelve `session_id, cart_value`; solo salen los que han añadido algo.
 */
export function cartValueSql(alias: string, where: string): string {
  return `
    SELECT ${alias}.session_id, SUM(v.number_value * COALESCE(q.number_value, 1)) AS cart_value
    FROM website_event ${alias}
    JOIN event_data v ON v.website_event_id = ${alias}.event_id AND v.data_key = 'value'
    LEFT JOIN event_data q ON q.website_event_id = ${alias}.event_id AND q.data_key = 'quantity'
    WHERE ${alias}.event_name = 'add_to_cart' AND ${where}
    GROUP BY ${alias}.session_id`;
}

/** Búsquedas y motos de un conjunto de visitantes (hasta 3 búsquedas y 2 motos cada uno, las más recientes primero). */
async function loadInterests(sessionIds: string[], whereClause: string): Promise<Map<string, VisitorInterests>> {
  const out = new Map<string, VisitorInterests>();
  if (!sessionIds.length) return out;
  const res = await getUmamiPool().query(
    `SELECT e.session_id, e.event_name, ed.string_value AS value
       FROM website_event e
       JOIN event_data ed ON ed.website_event_id = e.event_id
      WHERE e.session_id = ANY($1::uuid[]) AND ${whereClause}
        AND ((e.event_name IN ('search', 'search_no_results') AND ed.data_key = 'query')
          OR (e.event_name = 'bike_selected' AND ed.data_key = 'bike'))
      ORDER BY e.created_at DESC`,
    [sessionIds]);
  for (const r of res.rows) {
    const item = out.get(r.session_id) || { searches: [], bikes: [] };
    const list = r.event_name === 'bike_selected' ? item.bikes : item.searches;
    const value = String(r.value || '').trim();
    if (value && !list.includes(value) && list.length < (r.event_name === 'bike_selected' ? 2 : 3)) list.push(value);
    out.set(r.session_id, item);
  }
  return out;
}

/** Cláusula SQL para excluir tráfico interno de pruebas (Canarias) si excludeInternal es true */
export function getInternalFilterSql(excludeInternal: boolean, sessionAlias: string = 's'): string {
  if (!excludeInternal) return '';
  return `
    AND COALESCE(${sessionAlias}.region, '') != 'ES-CN'
    AND COALESCE(${sessionAlias}.city, '') NOT IN ('Vecindario', 'Santa Brígida', 'Santa Cruz de Tenerife', 'Las Palmas de Gran Canaria', 'Telde', 'Arucas', 'Gáldar', 'Maspalomas', 'Arrecife', 'Puerto del Rosario')
  `;
}

/**
 * Umami guarda el referrer de cada página: la primera trae el de Google, pero las siguientes de la misma
 * visita traen la página anterior de la propia web («Interno»). Para no perder el origen, cada vista hereda
 * el referrer de la primera página de su visita: usar `vs.referrer_domain` en lugar de `e.referrer_domain`.
 */
export function visitSourceJoin(eventAlias: string = 'e'): string {
  return `
    LEFT JOIN LATERAL (
      SELECT f.referrer_domain
      FROM website_event f
      WHERE f.visit_id = ${eventAlias}.visit_id
        AND f.event_type = 1
      ORDER BY f.created_at ASC
      LIMIT 1
    ) vs ON true`;
}

/**
 * Consulta usuarios y actividad en tiempo real (últimos 30 minutos).
 */
export async function getRealtimeData(excludeInternal: boolean = true): Promise<RealtimeStatsResponse> {
  const pool = getUmamiPool();
  const internalFilter = getInternalFilterSql(excludeInternal, 's');

  // `vis` mide la visita completa de cada visitante activo (puede haber empezado hace más de 30 minutos) y `hist` cuántas
  // visitas ha hecho en 30 días: quien vuelve a entrar interesa más que quien pasa una vez.
  const usersQuery = `
    WITH active_sessions AS (
      SELECT
        s.session_id,
        s.browser,
        s.os,
        s.device,
        s.country,
        s.region,
        s.city,
        s.created_at AS session_start,
        MAX(e.created_at) AS last_active_at,
        COUNT(e.event_id) AS total_events,
        (ARRAY_AGG(e.visit_id ORDER BY e.created_at DESC))[1] AS visit_id
      FROM session s
      JOIN website_event e ON e.session_id = s.session_id
      WHERE e.created_at >= NOW() - INTERVAL '30 minutes'
        ${internalFilter}
      GROUP BY s.session_id, s.browser, s.os, s.device, s.country, s.region, s.city, s.created_at
    ),
    vis AS (
      SELECT a.session_id, MIN(v.created_at) AS visit_start, ${signalColumnsSql('v')}
      FROM active_sessions a
      JOIN website_event v ON v.session_id = a.session_id AND v.visit_id = a.visit_id
      GROUP BY a.session_id
    ),
    hist AS (
      SELECT a.session_id, COUNT(DISTINCT h.visit_id) AS visits_30d
      FROM active_sessions a
      JOIN website_event h ON h.session_id = a.session_id AND h.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY a.session_id
    ),
    cart AS (
      ${cartValueSql('c', 'c.visit_id IN (SELECT visit_id FROM active_sessions)')}
    )
    SELECT
      a.session_id,
      COALESCE(a.city, 'Desconocida') AS city,
      COALESCE(a.region, '') AS region,
      COALESCE(a.country, 'ES') AS country,
      COALESCE(a.device, 'desktop') AS device,
      COALESCE(a.os, 'Unknown') AS os,
      COALESCE(a.browser, 'Unknown') AS browser,
      a.last_active_at,
      a.session_start,
      ROUND(EXTRACT(EPOCH FROM (NOW() - a.last_active_at))) AS seconds_ago,
      a.total_events,
      vis.visit_start,
      COALESCE(cart.cart_value, 0) AS cart_value,
      vis.pageviews, vis.product_views, hist.visits_30d AS visits, vis.add_to_cart, vis.checkout, vis.purchase,
      vis.chat, vis.sign_up, vis.searches, vis.no_results, vis.bikes,
      latest_event.url_path AS current_page,
      latest_event.page_title,
      latest_event.referrer_domain
    FROM active_sessions a
    JOIN vis ON vis.session_id = a.session_id
    JOIN hist ON hist.session_id = a.session_id
    LEFT JOIN cart ON cart.session_id = a.session_id
    JOIN LATERAL (
      SELECT e.url_path, e.page_title, vs.referrer_domain
      FROM website_event e
      ${visitSourceJoin('e')}
      WHERE e.session_id = a.session_id
      ORDER BY e.created_at DESC
      LIMIT 1
    ) latest_event ON true
    ORDER BY a.last_active_at DESC;
  `;

  const recentPvQuery = `
    SELECT 
      e.event_id,
      e.session_id,
      e.created_at,
      ROUND(EXTRACT(EPOCH FROM (NOW() - e.created_at))) AS seconds_ago,
      e.url_path,
      COALESCE(e.page_title, '') AS page_title,
      vs.referrer_domain,
      COALESCE(s.city, 'Desconocida') AS city,
      COALESCE(s.country, 'ES') AS country,
      COALESCE(s.device, 'desktop') AS device
    FROM website_event e
    JOIN session s ON s.session_id = e.session_id
    ${visitSourceJoin('e')}
    WHERE e.event_type = 1
      AND e.created_at >= NOW() - INTERVAL '30 minutes'
      ${internalFilter}
    ORDER BY e.created_at DESC
    LIMIT 20;
  `;

  const [usersRes, pvsRes] = await Promise.all([
    pool.query(usersQuery),
    pool.query(recentPvQuery),
  ]);

  const interests = await loadInterests(usersRes.rows.map((r: any) => r.session_id), `e.created_at >= NOW() - INTERVAL '24 hours'`);

  const users: RealtimeActiveUser[] = usersRes.rows.map((r: any) => {
    const signals = signalsFromRow(r);
    const lastMs = new Date(r.last_active_at).getTime();
    const startMs = new Date(r.visit_start).getTime();
    return {
      sessionId: r.session_id,
      city: r.city,
      region: r.region,
      country: r.country,
      device: r.device,
      os: r.os,
      browser: r.browser,
      lastActiveAt: r.last_active_at,
      sessionStart: r.session_start,
      secondsAgo: Math.max(0, parseInt(r.seconds_ago, 10) || 0),
      totalEvents: parseInt(r.total_events, 10) || 1,
      currentPage: r.current_page || '/',
      pageTitle: r.page_title || '',
      referrerDomain: r.referrer_domain || null,
      signals,
      tier: visitorTier(signals),
      score: visitorScore(signals),
      cartValue: Number(r.cart_value) || 0,
      visitStart: r.visit_start,
      durationSeconds: Math.max(0, Math.round((lastMs - startMs) / 1000)),
      searches: interests.get(r.session_id)?.searches || [],
      bikes: interests.get(r.session_id)?.bikes || [],
    };
  });

  const online5m = users.filter((u) => u.secondsAgo <= 300).length;
  const online15m = users.filter((u) => u.secondsAgo <= 900).length;
  const online30m = users.length;

  const recentPageviews: RealtimePageView[] = pvsRes.rows.map((r: any) => ({
    eventId: r.event_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
    secondsAgo: Math.max(0, parseInt(r.seconds_ago, 10) || 0),
    urlPath: r.url_path || '/',
    pageTitle: r.page_title,
    referrerDomain: r.referrer_domain || null,
    city: r.city,
    country: r.country,
    device: r.device,
  }));

  return {
    online5m,
    online15m,
    online30m,
    users,
    recentPageviews,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Consulta agregada para el panel de estadísticas con distintos rangos temporales.
 */
export async function getAnalyticsStats(
  range: StatsRange = 'today',
  excludeInternal: boolean = true
): Promise<AnalyticsStatsResponse> {
  const pool = getUmamiPool();
  const internalFilter = getInternalFilterSql(excludeInternal, 's');
  // «Hoy» empieza a medianoche en hora peninsular (Europe/Madrid).
  const { clause: dateFilterClause, isHourly } = getRangeFilter(range);

  // 1. Resumen general
  const overviewQuery = `
    SELECT 
      COUNT(DISTINCT s.session_id) AS total_visitors,
      COUNT(e.event_id) AS total_pageviews,
      COUNT(DISTINCT CASE WHEN vs.referrer_domain LIKE '%google%' THEN s.session_id END) AS google_visitors,
      COUNT(DISTINCT CASE WHEN vs.referrer_domain IS NULL OR vs.referrer_domain = '' THEN s.session_id END) AS direct_visitors,
      COUNT(DISTINCT CASE WHEN s.device = 'mobile' THEN s.session_id END) AS mobile_visitors
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    ${visitSourceJoin('e')}
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter};
  `;

  // 2. Gráfico temporal (por hora si hoy/24h, por día si >= 7d)
  const timeSeriesQuery = isHourly
    ? `
      SELECT 
        TO_CHAR((e.created_at AT TIME ZONE 'Europe/Madrid'), 'HH24:00') AS label,
        COUNT(DISTINCT s.session_id) AS visitors,
        COUNT(e.event_id) AS pageviews,
        COUNT(DISTINCT CASE WHEN vs.referrer_domain LIKE '%google%' THEN s.session_id END) AS google
      FROM session s
      JOIN website_event e ON e.session_id = s.session_id
      ${visitSourceJoin('e')}
      WHERE ${dateFilterClause}
        AND e.event_type = 1
        ${internalFilter}
      GROUP BY 1
      ORDER BY 1 ASC;
    `
    : `
      SELECT 
        TO_CHAR((e.created_at AT TIME ZONE 'Europe/Madrid'), 'DD Mon') AS label,
        COUNT(DISTINCT s.session_id) AS visitors,
        COUNT(e.event_id) AS pageviews,
        COUNT(DISTINCT CASE WHEN vs.referrer_domain LIKE '%google%' THEN s.session_id END) AS google
      FROM session s
      JOIN website_event e ON e.session_id = s.session_id
      ${visitSourceJoin('e')}
      WHERE ${dateFilterClause}
        AND e.event_type = 1
        ${internalFilter}
      GROUP BY TO_CHAR((e.created_at AT TIME ZONE 'Europe/Madrid'), 'YYYY-MM-DD'), 1
      ORDER BY TO_CHAR((e.created_at AT TIME ZONE 'Europe/Madrid'), 'YYYY-MM-DD') ASC;
    `;

  // 3. Páginas más vistas
  const topPagesQuery = `
    SELECT
      e.url_path AS path,
      COALESCE((ARRAY_AGG(e.page_title ORDER BY e.created_at DESC) FILTER (WHERE e.page_title <> ''))[1], '') AS title,
      COUNT(e.event_id) AS views,
      COUNT(DISTINCT s.session_id) AS visitors
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter}
    GROUP BY e.url_path
    ORDER BY views DESC, visitors DESC
    LIMIT 25;
  `;

  // 4. Referrers / Fuentes de tráfico
  const topReferrersQuery = `
    SELECT 
      CASE 
        WHEN vs.referrer_domain LIKE '%google%' THEN 'Google Orgánico'
        WHEN vs.referrer_domain IS NULL OR vs.referrer_domain = '' THEN 'Directo / Sin Referrer'
        WHEN vs.referrer_domain LIKE '%bing%' THEN 'Bing'
        WHEN vs.referrer_domain LIKE '%duckduckgo%' THEN 'DuckDuckGo'
        WHEN vs.referrer_domain LIKE '%yahoo%' THEN 'Yahoo'
        WHEN vs.referrer_domain LIKE '%instagram%' THEN 'Instagram'
        WHEN vs.referrer_domain LIKE '%tiktok%' THEN 'TikTok'
        WHEN vs.referrer_domain LIKE '%facebook%' THEN 'Facebook'
        ELSE COALESCE(vs.referrer_domain, 'Otros')
      END AS domain,
      COUNT(DISTINCT s.session_id) AS visitors,
      COUNT(e.event_id) AS views
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    ${visitSourceJoin('e')}
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter}
    GROUP BY 1
    ORDER BY visitors DESC, views DESC
    LIMIT 15;
  `;

  // 5. Ubicaciones (ciudades y países)
  const topLocationsQuery = `
    SELECT 
      COALESCE(s.city, 'Desconocida') AS city,
      COALESCE(s.region, '') AS region,
      COALESCE(s.country, 'ES') AS country,
      COUNT(DISTINCT s.session_id) AS visitors
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter}
    GROUP BY 1, 2, 3
    ORDER BY visitors DESC
    LIMIT 20;
  `;

  // 6. Dispositivos
  const devicesQuery = `
    SELECT 
      COALESCE(s.device, 'desktop') AS device,
      COUNT(DISTINCT s.session_id) AS visitors
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter}
    GROUP BY 1
    ORDER BY visitors DESC;
  `;

  // 7. Sistemas Operativos
  const osQuery = `
    SELECT 
      COALESCE(s.os, 'Desconocido') AS os,
      COUNT(DISTINCT s.session_id) AS visitors
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter}
    GROUP BY 1
    ORDER BY visitors DESC
    LIMIT 10;
  `;

  // 8. Navegadores
  const browsersQuery = `
    SELECT 
      COALESCE(s.browser, 'Desconocido') AS browser,
      COUNT(DISTINCT s.session_id) AS visitors
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter}
    GROUP BY 1
    ORDER BY visitors DESC
    LIMIT 10;
  `;

  const [
    overviewRes,
    timeSeriesRes,
    topPagesRes,
    topReferrersRes,
    topLocationsRes,
    devicesRes,
    osRes,
    browsersRes,
  ] = await Promise.all([
    pool.query(overviewQuery),
    pool.query(timeSeriesQuery),
    pool.query(topPagesQuery),
    pool.query(topReferrersQuery),
    pool.query(topLocationsQuery),
    pool.query(devicesQuery),
    pool.query(osQuery),
    pool.query(browsersQuery),
  ]);

  const totalVisitors = parseInt(overviewRes.rows[0]?.total_visitors, 10) || 0;
  const totalPageviews = parseInt(overviewRes.rows[0]?.total_pageviews, 10) || 0;
  const googleVisitors = parseInt(overviewRes.rows[0]?.google_visitors, 10) || 0;
  const directVisitors = parseInt(overviewRes.rows[0]?.direct_visitors, 10) || 0;
  const mobileVisitors = parseInt(overviewRes.rows[0]?.mobile_visitors, 10) || 0;
  const mobilePercent = totalVisitors > 0 ? Math.round((mobileVisitors / totalVisitors) * 1000) / 10 : 0;
  const avgPagesPerVisit = totalVisitors > 0 ? Math.round((totalPageviews / totalVisitors) * 10) / 10 : 0;

  const formatWithPercent = (rows: any[], total: number, key: string) => {
    return rows.map((r) => {
      const count = parseInt(r.visitors, 10) || 0;
      const pct = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
      return {
        [key]: r[key],
        count,
        percent: pct,
      };
    });
  };

  return {
    overview: {
      totalVisitors,
      totalPageviews,
      googleVisitors,
      directVisitors,
      mobileVisitors,
      mobilePercent,
      avgPagesPerVisit,
    },
    timeSeries: timeSeriesRes.rows.map((r: any) => ({
      label: r.label,
      visitors: parseInt(r.visitors, 10) || 0,
      pageviews: parseInt(r.pageviews, 10) || 0,
      google: parseInt(r.google, 10) || 0,
    })),
    topPages: topPagesRes.rows.map((r: any) => ({
      path: r.path,
      title: r.title || '',
      views: parseInt(r.views, 10) || 0,
      visitors: parseInt(r.visitors, 10) || 0,
    })),
    topReferrers: topReferrersRes.rows.map((r: any) => ({
      domain: r.domain,
      visitors: parseInt(r.visitors, 10) || 0,
      views: parseInt(r.views, 10) || 0,
    })),
    topLocations: topLocationsRes.rows.map((r: any) => ({
      city: r.city,
      region: r.region,
      country: r.country,
      visitors: parseInt(r.visitors, 10) || 0,
    })),
    devices: formatWithPercent(devicesRes.rows, totalVisitors, 'device') as any,
    operatingSystems: formatWithPercent(osRes.rows, totalVisitors, 'os') as any,
    browsers: formatWithPercent(browsersRes.rows, totalVisitors, 'browser') as any,
  };
}

/**
 * Obtiene el recorrido detallado paso a paso de un visitante específico:
 * metadatos de su sesión y secuencia cronológica de todas las páginas y eventos.
 */
export async function getSessionDetail(sessionId: string): Promise<SessionDetailResponse | null> {
  const pool = getUmamiPool();

  const sessionQuery = `
    SELECT 
      s.session_id,
      COALESCE(s.city, 'Desconocida') AS city,
      COALESCE(s.region, '') AS region,
      COALESCE(s.country, 'ES') AS country,
      COALESCE(s.device, 'desktop') AS device,
      COALESCE(s.os, 'Unknown') AS os,
      COALESCE(s.browser, 'Unknown') AS browser,
      COALESCE(s.screen, '') AS screen,
      COALESCE(s.language, '') AS language,
      s.created_at AS session_start
    FROM session s
    WHERE s.session_id = $1
    LIMIT 1;
  `;

  const eventsQuery = `
    SELECT 
      e.event_id,
      e.created_at,
      TO_CHAR((e.created_at AT TIME ZONE 'Europe/Madrid'), 'HH24:MI:SS') AS time_formatted,
      TO_CHAR((e.created_at AT TIME ZONE 'Europe/Madrid'), 'DD/MM') AS date_formatted,
      e.visit_id,
      e.event_type,
      COALESCE(e.event_name, 'pageview') AS event_name,
      e.url_path,
      COALESCE(e.page_title, '') AS page_title,
      e.referrer_domain,
      e.utm_source,
      e.utm_medium,
      e.utm_campaign,
      COALESCE(
        json_agg(
          json_build_object(
            'key', ed.data_key,
            'value', COALESCE(ed.string_value, ed.number_value::text)
          )
        ) FILTER (WHERE ed.data_key IS NOT NULL),
        '[]'
      ) AS event_data
    FROM website_event e
    LEFT JOIN event_data ed ON ed.website_event_id = e.event_id
    WHERE e.session_id = $1
    GROUP BY e.event_id, e.created_at, e.visit_id, e.event_type, e.event_name, e.url_path, e.page_title, e.referrer_domain, e.utm_source, e.utm_medium, e.utm_campaign
    ORDER BY e.created_at ASC;
  `;

  const [sRes, eRes] = await Promise.all([
    pool.query(sessionQuery, [sessionId]),
    pool.query(eventsQuery, [sessionId]),
  ]);

  if (sRes.rows.length === 0) return null;

  const sRow = sRes.rows[0];
  const eRows = eRes.rows;

  const sessionStartMs = new Date(sRow.session_start).getTime();
  const lastActiveAtMs = eRows.length > 0 ? new Date(eRows[eRows.length - 1].created_at).getTime() : sessionStartMs;
  const durationSeconds = Math.max(0, Math.round((lastActiveAtMs - sessionStartMs) / 1000));

  const events: SessionEventItem[] = eRows.map((r: any, idx: number) => {
    const curMs = new Date(r.created_at).getTime();
    const secondsFromStart = Math.max(0, Math.round((curMs - sessionStartMs) / 1000));

    let timeOnPageSeconds: number | null = null;
    if (idx < eRows.length - 1) {
      const nextMs = new Date(eRows[idx + 1].created_at).getTime();
      timeOnPageSeconds = Math.max(0, Math.round((nextMs - curMs) / 1000));
    }

    return {
      eventId: r.event_id,
      createdAt: r.created_at,
      timeFormatted: r.time_formatted,
      dateFormatted: r.date_formatted,
      secondsFromStart,
      timeOnPageSeconds,
      eventType: r.event_type,
      eventName: r.event_name,
      urlPath: r.url_path || '/',
      pageTitle: r.page_title,
      referrerDomain: r.referrer_domain || null,
      utmSource: r.utm_source || null,
      utmMedium: r.utm_medium || null,
      utmCampaign: r.utm_campaign || null,
      eventData: Array.isArray(r.event_data) ? r.event_data : [],
    };
  });

  const firstEvent = events[0];

  // Mismo resumen que el listado de destacados, calculado con los eventos de esta sesión.
  const count = (pred: (ev: SessionEventItem) => boolean) => events.filter(pred).length;
  const named = (...names: string[]) => (ev: SessionEventItem) => names.includes(ev.eventName);
  const signals: VisitorSignals = {
    ...emptySignals(),
    pageviews: count((ev) => ev.eventType === 1),
    productViews: count(named('view_product_detail')),
    visits: new Set(eRows.map((r: any) => r.visit_id)).size,
    addToCart: count(named('add_to_cart')),
    checkout: count(named('checkout_start', 'checkout_payment')),
    purchase: count(named('purchase')),
    chat: count(named('chat_open', 'chat_proposal_open')),
    signUp: count(named('sign_up')),
    searches: count(named('search')),
    noResults: count(named('search_no_results')),
    bikes: count(named('bike_selected')),
  };
  const dataNumber = (ev: SessionEventItem, key: string) => Number(ev.eventData.find((d) => d.key === key)?.value) || 0;
  const cartValue = events
    .filter((ev) => ev.eventName === 'add_to_cart')
    .reduce((sum, ev) => sum + dataNumber(ev, 'value') * (dataNumber(ev, 'quantity') || 1), 0);

  return {
    summary: { signals, tier: visitorTier(signals), score: visitorScore(signals), cartValue },
    session: {
      sessionId: sRow.session_id,
      city: sRow.city,
      region: sRow.region,
      country: sRow.country,
      device: sRow.device,
      os: sRow.os,
      browser: sRow.browser,
      screen: sRow.screen,
      language: sRow.language,
      sessionStart: sRow.session_start,
      lastActiveAt: eRows.length > 0 ? eRows[eRows.length - 1].created_at : sRow.session_start,
      durationSeconds,
      totalEvents: events.length,
      initialReferrer: firstEvent?.referrerDomain || null,
      utmSource: firstEvent?.utmSource || null,
      utmMedium: firstEvent?.utmMedium || null,
      utmCampaign: firstEvent?.utmCampaign || null,
    },
    events,
  };
}

/* ───────────────────────── Visitantes por prioridad, embudo y eventos ───────────────────────── */

/** Un visitante del periodo con lo que ha hecho y su prioridad. */
export interface VisitorRow extends VisitorInterests {
  sessionId: string;
  city: string;
  region: string;
  country: string;
  device: string;
  os: string;
  browser: string;
  firstSeen: string;
  lastSeen: string;
  secondsAgo: number;
  entryPage: string;
  entryReferrer: string | null;
  lastPage: string;
  lastTitle: string;
  signals: VisitorSignals;
  tier: VisitorTier;
  score: number;
  cartValue: number;
}

export interface EventSummaryRow {
  name: string;
  label: string;
  /** Eventos que cuentan como intención de compra: el panel los destaca. */
  important: boolean;
  count: number;
  sessions: number;
}

export interface TermRow {
  term: string;
  count: number;
  sessions: number;
}

export interface VisitorInsights {
  summary: {
    visitors: number;
    /** Visitantes por nivel de prioridad. */
    tiers: Record<VisitorTier, number>;
    /** Visitantes que han llegado a cada paso (cada uno cuenta una vez; no son pasos obligatorios entre sí). */
    funnel: { visitors: number; productViews: number; addToCart: number; checkout: number; purchase: number };
    /** Euros en productos añadidos al carrito por todos los visitantes del periodo. */
    cartValue: number;
  };
  /** Los de más prioridad primero (hasta 100). */
  visitors: VisitorRow[];
  events: EventSummaryRow[];
  topSearches: TermRow[];
  noResultSearches: TermRow[];
  topBikes: TermRow[];
}

/** Nombre en español de cada evento y si indica intención de compra; el orden es el de la tabla del panel. */
const EVENT_INFO: [name: string, label: string, important: boolean][] = [
  ['purchase', 'Compra', true],
  ['checkout_payment', 'Paso de pago', true],
  ['checkout_start', 'Inicio de pago', true],
  ['add_to_cart', 'Añadido al carrito', true],
  // Pago (23/11/2026): dónde se pierden los que pulsan «Tramitar pedido».
  ['payment_error', 'Error al pagar', true],
  ['payment_cancel', 'Cerró la ventana de pago', true],
  ['checkout_error', 'Error en el formulario de pago', false],
  ['checkout_back', 'Volvió al carrito desde el pago', false],
  ['moto_alert_done', 'Aviso de moto activado', true],
  ['moto_alert_start', 'Pulsó «Avísame» de una moto', false],
  ['contact_submit', 'Mensaje de contacto enviado', true],
  ['chat_open', 'Chat abierto', true],
  ['chat_proposal_open', 'Propuesta del chat abierta', true],
  ['sign_up', 'Registro de cuenta', true],
  ['login', 'Inicio de sesión', false],
  ['email_verified', 'Email verificado', false],
  ['view_product_detail', 'Ficha de producto vista', false],
  ['bike_selected', 'Moto elegida', false],
  ['search', 'Búsqueda', false],
  ['search_suggestion_click', 'Sugerencia de búsqueda pulsada', false],
  ['search_no_results', 'Búsqueda sin resultados', false],
  ['not_found', 'Página no encontrada (404)', false],
];

const MAX_VISITORS = 100;

async function computeVisitorInsights(range: StatsRange, excludeInternal: boolean): Promise<VisitorInsights> {
  const pool = getUmamiPool();
  const internalFilter = getInternalFilterSql(excludeInternal, 's');
  const { clause } = getRangeFilter(range);

  // Los mismos visitantes que cuenta «Visitantes únicos»: los que han visto al menos una página en el periodo.
  const sessionsQuery = `
    SELECT e.session_id, MIN(e.created_at) AS first_seen, MAX(e.created_at) AS last_seen, ${signalColumnsSql('e')}
    FROM website_event e
    JOIN session s ON s.session_id = e.session_id
    WHERE ${clause} ${internalFilter}
    GROUP BY e.session_id
    HAVING COUNT(*) FILTER (WHERE e.event_type = 1) > 0`;

  const eventsQuery = `
    SELECT e.event_name, COUNT(*) AS n, COUNT(DISTINCT e.session_id) AS sessions
    FROM website_event e
    JOIN session s ON s.session_id = e.session_id
    WHERE e.event_type = 2 AND e.event_name IS NOT NULL AND ${clause} ${internalFilter}
    GROUP BY e.event_name`;

  const termsQuery = `
    SELECT e.event_name, LOWER(TRIM(ed.string_value)) AS term, COUNT(*) AS n, COUNT(DISTINCT e.session_id) AS sessions
    FROM website_event e
    JOIN session s ON s.session_id = e.session_id
    JOIN event_data ed ON ed.website_event_id = e.event_id
    WHERE ((e.event_name IN ('search', 'search_no_results') AND ed.data_key = 'query')
        OR (e.event_name = 'bike_selected' AND ed.data_key = 'bike'))
      AND COALESCE(TRIM(ed.string_value), '') <> ''
      AND ${clause} ${internalFilter}
    GROUP BY e.event_name, LOWER(TRIM(ed.string_value))
    ORDER BY n DESC`;

  const [sessionsRes, eventsRes, termsRes, cartRes] = await Promise.all([
    pool.query(sessionsQuery),
    pool.query(eventsQuery),
    pool.query(termsQuery),
    pool.query(cartValueSql('e', clause)),
  ]);

  const cartBySession = new Map<string, number>(cartRes.rows.map((r: any) => [r.session_id, Number(r.cart_value) || 0]));

  type Ranked = { sessionId: string; firstSeen: string; lastSeen: string; lastSeenMs: number; signals: VisitorSignals; tier: VisitorTier; score: number; cartValue: number };
  const ranked: Ranked[] = sessionsRes.rows.map((r: any) => {
    const signals = signalsFromRow(r);
    return {
      sessionId: r.session_id,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      lastSeenMs: new Date(r.last_seen).getTime(),
      signals,
      tier: visitorTier(signals),
      score: visitorScore(signals),
      cartValue: cartBySession.get(r.session_id) || 0,
    };
  });
  ranked.sort(compareVisitors);

  const tiers: Record<VisitorTier, number> = { hot: 0, engaged: 0, browsing: 0, bounce: 0 };
  const funnel = { visitors: ranked.length, productViews: 0, addToCart: 0, checkout: 0, purchase: 0 };
  let cartValue = 0;
  for (const v of ranked) {
    tiers[v.tier]++;
    if (v.signals.productViews > 0) funnel.productViews++;
    if (v.signals.addToCart > 0) funnel.addToCart++;
    if (v.signals.checkout > 0) funnel.checkout++;
    if (v.signals.purchase > 0) funnel.purchase++;
    cartValue += v.cartValue;
  }

  // Datos de ubicación, origen y páginas solo de los que se van a enseñar.
  const top = ranked.slice(0, MAX_VISITORS);
  const topIds = top.map((v) => v.sessionId);
  const [detailRes, interests] = topIds.length
    ? await Promise.all([
        pool.query(
          `SELECT s.session_id, COALESCE(s.city, 'Desconocida') AS city, COALESCE(s.region, '') AS region,
                  COALESCE(s.country, 'ES') AS country, COALESCE(s.device, 'desktop') AS device,
                  COALESCE(s.os, 'Unknown') AS os, COALESCE(s.browser, 'Unknown') AS browser,
                  fp.url_path AS entry_page, fp.referrer_domain AS entry_referrer,
                  lp.url_path AS last_page, lp.page_title AS last_title
             FROM session s
             LEFT JOIN LATERAL (
               SELECT e.url_path, e.referrer_domain FROM website_event e
                WHERE e.session_id = s.session_id AND e.event_type = 1 AND ${clause}
                ORDER BY e.created_at ASC LIMIT 1) fp ON true
             LEFT JOIN LATERAL (
               SELECT e.url_path, e.page_title FROM website_event e
                WHERE e.session_id = s.session_id AND e.event_type = 1 AND ${clause}
                ORDER BY e.created_at DESC LIMIT 1) lp ON true
            WHERE s.session_id = ANY($1::uuid[])`,
          [topIds]),
        loadInterests(topIds, clause),
      ])
    : [{ rows: [] as any[] }, new Map<string, VisitorInterests>()];
  const detailById = new Map<string, any>(detailRes.rows.map((r: any) => [r.session_id, r]));
  const now = Date.now();

  const visitors: VisitorRow[] = top.map((v) => {
    const d = detailById.get(v.sessionId) || {};
    const i = interests.get(v.sessionId);
    return {
      sessionId: v.sessionId,
      city: d.city || 'Desconocida',
      region: d.region || '',
      country: d.country || 'ES',
      device: d.device || 'desktop',
      os: d.os || 'Unknown',
      browser: d.browser || 'Unknown',
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      secondsAgo: Math.max(0, Math.round((now - v.lastSeenMs) / 1000)),
      entryPage: d.entry_page || '/',
      entryReferrer: d.entry_referrer || null,
      lastPage: d.last_page || '/',
      lastTitle: d.last_title || '',
      signals: v.signals,
      tier: v.tier,
      score: v.score,
      cartValue: v.cartValue,
      searches: i?.searches || [],
      bikes: i?.bikes || [],
    };
  });

  const known = new Map(EVENT_INFO.map(([name, label, important], idx) => [name, { label, important, idx }]));
  const events: EventSummaryRow[] = eventsRes.rows
    .map((r: any) => {
      const info = known.get(r.event_name);
      return {
        name: r.event_name,
        label: info?.label || r.event_name,
        important: info?.important ?? false,
        count: parseInt(r.n, 10) || 0,
        sessions: parseInt(r.sessions, 10) || 0,
        idx: info?.idx ?? 999,
      };
    })
    .sort((a: any, b: any) => a.idx - b.idx || b.count - a.count)
    .map(({ idx: _idx, ...rest }: any) => rest);

  const terms = (names: string[], limit: number): TermRow[] =>
    termsRes.rows
      .filter((r: any) => names.includes(r.event_name))
      .map((r: any) => ({ term: r.term, count: parseInt(r.n, 10) || 0, sessions: parseInt(r.sessions, 10) || 0 }))
      .sort((a: TermRow, b: TermRow) => b.count - a.count)
      .slice(0, limit);

  return {
    summary: { visitors: ranked.length, tiers, funnel, cartValue: Math.round(cartValue * 100) / 100 },
    visitors,
    events,
    topSearches: terms(['search'], 10),
    noResultSearches: terms(['search_no_results'], 10),
    topBikes: terms(['bike_selected'], 10),
  };
}

// El panel lo pide cada 30 s desde cada pantalla abierta: se calcula una vez por periodo y se reparte (caché en memoria).
const insightsCache = new Map<string, { at: number; result: Promise<VisitorInsights> }>();

export function getVisitorInsights(range: StatsRange = 'today', excludeInternal: boolean = true): Promise<VisitorInsights> {
  const key = `${range}|${excludeInternal}`;
  const ttl = range === 'all' ? 120_000 : 30_000;
  const hit = insightsCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.result;
  const result = computeVisitorInsights(range, excludeInternal);
  insightsCache.set(key, { at: Date.now(), result });
  // Un fallo no se queda en caché.
  result.catch(() => { if (insightsCache.get(key)?.result === result) insightsCache.delete(key); });
  return result;
}

/* ───────────────────────── De un carrito a la visita que lo creó ───────────────────────── */

export interface CartSessionMatch {
  sessionId: string;
  /** Productos del carrito que esa visita añadió, sobre el total de productos del carrito. */
  matched: number;
  total: number;
  lastAddAt: string;
  /** Segundos entre el último «añadir» de la visita y el último guardado del carrito. */
  gapSeconds: number;
  confidence: 'alta' | 'media' | 'baja';
  /** Otras visitas que también añadieron alguno de esos productos en ese tiempo. */
  otherCandidates: number;
}

/**
 * El carrito guarda su propio token y Umami su propio identificador de visita: no hay vínculo directo. Se cruzan por los
 * productos: la visita que añadió (evento add_to_cart) los productos del carrito poco antes de que se guardara.
 * `cartUpdatedAt` es la fecha de última modificación del carrito en ISO UTC.
 */
export async function findSessionForCart(productIds: number[], cartUpdatedAt: string): Promise<CartSessionMatch | null> {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))];
  const updatedMs = new Date(cartUpdatedAt).getTime();
  if (!ids.length || !Number.isFinite(updatedMs)) return null;

  const res = await getUmamiPool().query(
    `SELECT e.session_id, COUNT(DISTINCT ed.number_value) AS matched, MAX(e.created_at) AS last_add
       FROM website_event e
       JOIN event_data ed ON ed.website_event_id = e.event_id AND ed.data_key = 'product_id'
      WHERE e.event_name = 'add_to_cart'
        AND ed.number_value = ANY($1::numeric[])
        AND e.created_at <= $2::timestamptz + INTERVAL '2 minutes'
        AND e.created_at >= $2::timestamptz - INTERVAL '30 days'
      GROUP BY e.session_id
      ORDER BY matched DESC, ABS(EXTRACT(EPOCH FROM ($2::timestamptz - MAX(e.created_at)))) ASC
      LIMIT 5`,
    [ids, new Date(updatedMs).toISOString()]);
  if (!res.rows.length) return null;

  const best = res.rows[0];
  const matched = parseInt(best.matched, 10) || 0;
  const gapSeconds = Math.round((updatedMs - new Date(best.last_add).getTime()) / 1000);
  const coverage = matched / ids.length;
  const ambiguous = res.rows.length > 1 && (parseInt(res.rows[1].matched, 10) || 0) === matched;

  let confidence: CartSessionMatch['confidence'] = 'baja';
  if (coverage === 1 && gapSeconds <= 900 && gapSeconds >= -120) confidence = 'alta';
  else if (coverage >= 0.5 && gapSeconds <= 86_400) confidence = 'media';
  if (confidence === 'alta' && ambiguous) confidence = 'media';

  return {
    sessionId: best.session_id,
    matched,
    total: ids.length,
    lastAddAt: new Date(best.last_add).toISOString(),
    gapSeconds,
    confidence,
    otherCandidates: res.rows.length - 1,
  };
}
