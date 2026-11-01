import pkg from 'pg';
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
  events: SessionEventItem[];
}

export interface RealtimeActiveUser {
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
  totalEvents: number;
  currentPage: string;
  pageTitle: string;
  referrerDomain: string | null;
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

/** Cláusula SQL para excluir tráfico interno de pruebas (Canarias) si excludeInternal es true */
function getInternalFilterSql(excludeInternal: boolean, sessionAlias: string = 's'): string {
  if (!excludeInternal) return '';
  return `
    AND COALESCE(${sessionAlias}.region, '') != 'ES-CN'
    AND COALESCE(${sessionAlias}.city, '') NOT IN ('Vecindario', 'Santa Brígida', 'Santa Cruz de Tenerife', 'Las Palmas de Gran Canaria', 'Telde', 'Arucas', 'Gáldar', 'Maspalomas', 'Arrecife', 'Puerto del Rosario')
  `;
}

/**
 * Consulta usuarios y actividad en tiempo real (últimos 30 minutos).
 */
export async function getRealtimeData(excludeInternal: boolean = true): Promise<RealtimeStatsResponse> {
  const pool = getUmamiPool();
  const internalFilter = getInternalFilterSql(excludeInternal, 's');

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
        COUNT(e.event_id) AS total_events
      FROM session s
      JOIN website_event e ON e.session_id = s.session_id
      WHERE e.created_at >= NOW() - INTERVAL '30 minutes'
        ${internalFilter}
      GROUP BY s.session_id, s.browser, s.os, s.device, s.country, s.region, s.city, s.created_at
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
      latest_event.url_path AS current_page,
      latest_event.page_title,
      latest_event.referrer_domain
    FROM active_sessions a
    JOIN LATERAL (
      SELECT url_path, page_title, referrer_domain
      FROM website_event e
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
      e.referrer_domain,
      COALESCE(s.city, 'Desconocida') AS city,
      COALESCE(s.country, 'ES') AS country,
      COALESCE(s.device, 'desktop') AS device
    FROM website_event e
    JOIN session s ON s.session_id = e.session_id
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

  const users: RealtimeActiveUser[] = usersRes.rows.map((r: any) => ({
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
  }));

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
  range: 'today' | '24h' | '7d' | '30d' | 'all' = 'today',
  excludeInternal: boolean = true
): Promise<AnalyticsStatsResponse> {
  const pool = getUmamiPool();
  const internalFilter = getInternalFilterSql(excludeInternal, 's');

  let dateFilterClause = '';
  let isHourly = false;

  switch (range) {
    case 'today':
      // Inicio del día en hora peninsular (Europe/Madrid)
      dateFilterClause = `e.created_at >= (NOW() AT TIME ZONE 'Europe/Madrid')::date::timestamp AT TIME ZONE 'Europe/Madrid'`;
      isHourly = true;
      break;
    case '24h':
      dateFilterClause = `e.created_at >= NOW() - INTERVAL '24 hours'`;
      isHourly = true;
      break;
    case '7d':
      dateFilterClause = `e.created_at >= NOW() - INTERVAL '7 days'`;
      isHourly = false;
      break;
    case '30d':
      dateFilterClause = `e.created_at >= NOW() - INTERVAL '30 days'`;
      isHourly = false;
      break;
    case 'all':
      dateFilterClause = `e.created_at >= '2026-01-01 00:00:00'`;
      isHourly = false;
      break;
    default:
      dateFilterClause = `e.created_at >= (NOW() AT TIME ZONE 'Europe/Madrid')::date::timestamp AT TIME ZONE 'Europe/Madrid'`;
      isHourly = true;
  }

  // 1. Resumen general
  const overviewQuery = `
    SELECT 
      COUNT(DISTINCT s.session_id) AS total_visitors,
      COUNT(e.event_id) AS total_pageviews,
      COUNT(DISTINCT CASE WHEN e.referrer_domain LIKE '%google%' THEN s.session_id END) AS google_visitors,
      COUNT(DISTINCT CASE WHEN e.referrer_domain IS NULL OR e.referrer_domain = '' THEN s.session_id END) AS direct_visitors,
      COUNT(DISTINCT CASE WHEN s.device = 'mobile' THEN s.session_id END) AS mobile_visitors
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
    WHERE ${dateFilterClause}
      AND e.event_type = 1
      ${internalFilter};
  `;

  // 2. Gráfico temporal (por hora si hoy/24h, por día si >= 7d)
  const timeSeriesQuery = isHourly
    ? `
      SELECT 
        TO_CHAR(e.created_at + INTERVAL '1 hour', 'HH24:00') AS label,
        COUNT(DISTINCT s.session_id) AS visitors,
        COUNT(e.event_id) AS pageviews,
        COUNT(DISTINCT CASE WHEN e.referrer_domain LIKE '%google%' THEN s.session_id END) AS google
      FROM session s
      JOIN website_event e ON e.session_id = s.session_id
      WHERE ${dateFilterClause}
        AND e.event_type = 1
        ${internalFilter}
      GROUP BY 1
      ORDER BY 1 ASC;
    `
    : `
      SELECT 
        TO_CHAR(e.created_at + INTERVAL '1 hour', 'DD Mon') AS label,
        COUNT(DISTINCT s.session_id) AS visitors,
        COUNT(e.event_id) AS pageviews,
        COUNT(DISTINCT CASE WHEN e.referrer_domain LIKE '%google%' THEN s.session_id END) AS google
      FROM session s
      JOIN website_event e ON e.session_id = s.session_id
      WHERE ${dateFilterClause}
        AND e.event_type = 1
        ${internalFilter}
      GROUP BY TO_CHAR(e.created_at + INTERVAL '1 hour', 'YYYY-MM-DD'), 1
      ORDER BY TO_CHAR(e.created_at + INTERVAL '1 hour', 'YYYY-MM-DD') ASC;
    `;

  // 3. Páginas más vistas
  const topPagesQuery = `
    SELECT 
      e.url_path AS path,
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
        WHEN e.referrer_domain LIKE '%google%' THEN 'Google Orgánico'
        WHEN e.referrer_domain IS NULL OR e.referrer_domain = '' THEN 'Directo / Sin Referrer'
        WHEN e.referrer_domain LIKE '%bing%' THEN 'Bing'
        WHEN e.referrer_domain LIKE '%duckduckgo%' THEN 'DuckDuckGo'
        WHEN e.referrer_domain LIKE '%yahoo%' THEN 'Yahoo'
        WHEN e.referrer_domain LIKE '%instagram%' THEN 'Instagram'
        WHEN e.referrer_domain LIKE '%tiktok%' THEN 'TikTok'
        WHEN e.referrer_domain LIKE '%facebook%' THEN 'Facebook'
        ELSE COALESCE(e.referrer_domain, 'Otros')
      END AS domain,
      COUNT(DISTINCT s.session_id) AS visitors,
      COUNT(e.event_id) AS views
    FROM session s
    JOIN website_event e ON e.session_id = s.session_id
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
      TO_CHAR(e.created_at + INTERVAL '1 hour', 'HH24:MI:SS') AS time_formatted,
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
    GROUP BY e.event_id, e.created_at, e.event_type, e.event_name, e.url_path, e.page_title, e.referrer_domain, e.utm_source, e.utm_medium, e.utm_campaign
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

  return {
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
