/**
 * Avisos de piezas nuevas para la moto del cliente.
 *
 * - «Avísame cuando haya piezas para mi moto» (botón de la web, con o sin cuenta).
 * - Motos guardadas en el garaje de los clientes registrados con el correo verificado.
 *
 * Al crear un aviso se apuntan como vistos los recambios compatibles que ya
 * había (moto_alert_seen). Después de cada actualización del catálogo de Bihr
 * (y una vez al día) `runMotoAlerts` busca los compatibles que aún no estaban,
 * sean productos nuevos o compatibilidades nuevas en productos que ya existían,
 * y manda un solo correo por cliente con las novedades de todas sus motos.
 *
 * Como mucho un correo cada MIN_GAP_DAYS por cliente: lo que llegue entre medias
 * espera al siguiente. Cada correo lleva baja de esa moto y de todos los avisos.
 */
import crypto from 'crypto';
import { pool } from '../db.js';
import { sendEmail } from './email.js';
import {
  BRAND, BRAND_URL, C, MONO, button, escapeHtml, eur, absUrl, heading, greeting, p, note, shell,
} from './email-templates.js';
import { compatibleSkus, parseBikeLabel, bikeLabel } from './moto-catalog.js';

const MIN_GAP_DAYS = 3;
const PRODUCTS_PER_BIKE = 6;

export interface Moto { brand: string; model: string; year: string }

const motoKey = (m: Moto) => `${m.brand}|${m.model}|${m.year}`;
export const normEmail = (e: unknown) => String(e || '').trim().toLowerCase();

/** SKUs compatibles que se venden ahora mismo (lo mismo que enseña la web). */
async function sellableSkus(m: Moto): Promise<string[]> {
  const skus = await compatibleSkus(m.brand, m.model, m.year);
  if (skus.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT sku FROM products WHERE status = 'published' AND price > 0 AND sku = ANY($1)`, [skus]);
  return rows.map((r: any) => r.sku);
}

async function markSeen(alertId: number, skus: string[]) {
  if (skus.length === 0) return;
  await pool.query(
    `INSERT INTO moto_alert_seen (alert_id, sku) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [alertId, skus]);
}

/**
 * Crea el aviso (o lo reactiva si el cliente se había dado de baja de esa moto)
 * y apunta como vistos los recambios que ya hay. `created` es false si ya existía activo.
 */
export async function createMotoAlert(a: Moto & { email: string; userId?: number | null; source: 'boton' | 'garaje' }) {
  const email = normEmail(a.email);
  if (a.source === 'boton') await pool.query(`DELETE FROM moto_alert_optout WHERE email = $1`, [email]);
  const { rows: [old] } = await pool.query(
    `SELECT id, token, unsubscribed_at FROM moto_alerts WHERE lower(email) = $1 AND brand = $2 AND model = $3 AND year = $4`,
    [email, a.brand, a.model, a.year || '']);
  if (old) {
    // Pedirlo otra vez con el botón reactiva la baja; el garaje respeta las bajas.
    if (!old.unsubscribed_at || a.source !== 'boton') return { id: old.id as number, token: old.token as string, created: false };
    await pool.query(`UPDATE moto_alerts SET unsubscribed_at = NULL, user_id = COALESCE(user_id, $2) WHERE id = $1`, [old.id, a.userId || null]);
    return { id: old.id as number, token: old.token as string, created: true };
  }
  const { rows: [row] } = await pool.query(
    `INSERT INTO moto_alerts (email, user_id, brand, model, year, source, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (lower(email), brand, model, year) DO UPDATE SET email = moto_alerts.email
     RETURNING id, token`,
    [email, a.userId || null, a.brand, a.model, a.year || '', a.source, crypto.randomBytes(24).toString('hex')]);
  await markSeen(row.id, await sellableSkus(a));
  return { id: row.id as number, token: row.token as string, created: true };
}

/** Baja de un aviso (o de todos los del mismo correo con `all`). */
export async function unsubscribeMotoAlert(token: string, all: boolean): Promise<{ ok: boolean; label?: string }> {
  const { rows: [a] } = await pool.query(`SELECT id, email, brand, model, year FROM moto_alerts WHERE token = $1`, [token]);
  if (!a) return { ok: false };
  if (all) {
    await pool.query(`INSERT INTO moto_alert_optout (email) VALUES ($1) ON CONFLICT DO NOTHING`, [normEmail(a.email)]);
    await pool.query(`UPDATE moto_alerts SET unsubscribed_at = NOW() WHERE lower(email) = $1 AND unsubscribed_at IS NULL`, [normEmail(a.email)]);
  } else {
    await pool.query(`UPDATE moto_alerts SET unsubscribed_at = NOW() WHERE id = $1 AND unsubscribed_at IS NULL`, [a.id]);
  }
  return { ok: true, label: bikeLabel(a.brand, a.model, a.year) };
}

/** Avisos de las motos del garaje: el cliente puede desactivarlos en su perfil. */
export async function garageAlertsEnabled(email: string): Promise<boolean> {
  const { rowCount } = await pool.query(`SELECT 1 FROM moto_alert_optout WHERE email = $1`, [normEmail(email)]);
  return !rowCount;
}

export async function setGarageAlertsEnabled(email: string, enabled: boolean) {
  const e = normEmail(email);
  if (enabled) {
    await pool.query(`DELETE FROM moto_alert_optout WHERE email = $1`, [e]);
    await pool.query(`UPDATE moto_alerts SET unsubscribed_at = NULL WHERE lower(email) = $1 AND source = 'garaje'`, [e]);
  } else {
    await pool.query(`INSERT INTO moto_alert_optout (email) VALUES ($1) ON CONFLICT DO NOTHING`, [e]);
  }
}

/** Crea los avisos de las motos nuevas del garaje y quita los de motos borradas. */
async function syncGarageAlerts() {
  const { rows: users } = await pool.query(
    `SELECT id, email, garage FROM users
     WHERE email_verified AND garage IS NOT NULL AND garage NOT IN ('', '[]', 'null')`);
  const wanted = new Set<string>();
  for (const u of users) {
    let bikes: string[] = [];
    try { bikes = JSON.parse(u.garage); } catch { continue; }
    if (!Array.isArray(bikes)) continue;
    for (const label of bikes) {
      const m = parseBikeLabel(String(label));
      if (!m) continue;
      wanted.add(`${normEmail(u.email)}|${motoKey(m)}`);
      const { rowCount } = await pool.query(
        `SELECT 1 FROM moto_alerts WHERE lower(email) = $1 AND brand = $2 AND model = $3 AND year = $4`,
        [normEmail(u.email), m.brand, m.model, m.year]);
      if (!rowCount) await createMotoAlert({ ...m, email: u.email, userId: u.id, source: 'garaje' });
    }
  }
  // Motos que el cliente quitó del garaje (las bajas se guardan para respetarlas si la vuelve a añadir).
  const { rows: existing } = await pool.query(
    `SELECT id, email, brand, model, year FROM moto_alerts WHERE source = 'garaje' AND unsubscribed_at IS NULL`);
  const gone = existing.filter((a: any) => !wanted.has(`${normEmail(a.email)}|${motoKey(a)}`)).map((a: any) => a.id);
  if (gone.length) await pool.query(`DELETE FROM moto_alerts WHERE id = ANY($1)`, [gone]);
}

interface CardRow { sku: string; name: string; price: number; sale_price: number | null; promo_price: number | null; stock: number; images: any; family_code: string | null }

/** Una fila por modelo (familia): la variante con stock y más barata. */
function familyCards(rows: CardRow[]) {
  const eff = (r: CardRow) => (r.promo_price && r.promo_price > 0 ? r.promo_price : r.sale_price && r.sale_price > 0 && r.sale_price < r.price ? r.sale_price : r.price);
  const groups = new Map<string, CardRow[]>();
  for (const r of rows) {
    const k = r.family_code || r.sku;
    (groups.get(k) || groups.set(k, []).get(k)!).push(r);
  }
  return [...groups.values()].map((list) => {
    const rep = [...list].sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || eff(a) - eff(b))[0];
    const img = Array.isArray(rep.images) ? rep.images[0]?.src : '';
    return { sku: rep.sku, name: rep.name, cents: eff(rep), from: list.length > 1, inStock: rep.stock > 0, image: img || '' };
  }).sort((a, b) => Number(b.inStock) - Number(a.inStock));
}

function productRows(cards: ReturnType<typeof familyCards>): string {
  const rows = cards.map((c) => {
    const url = `${BRAND_URL}/producto/${encodeURIComponent(c.sku)}`;
    const thumb = c.image
      ? `<a href="${escapeHtml(url)}"><img src="${escapeHtml(absUrl(c.image))}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:contain;border:1px solid ${C.border};border-radius:6px;background:#ffffff"></a>`
      : '';
    return `<tr>
        <td width="64" style="padding:10px 0;border-bottom:1px solid ${C.border};vertical-align:middle">${thumb}</td>
        <td style="padding:10px;border-bottom:1px solid ${C.border};vertical-align:middle;font-size:14px;line-height:1.4;font-weight:600">
          <a href="${escapeHtml(url)}" style="color:${C.text};text-decoration:none">${escapeHtml(c.name)}</a>
        </td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid ${C.border};vertical-align:middle;white-space:nowrap;font-family:${MONO};font-size:14px;font-weight:700;color:${C.text}">${c.from ? '<span style="font-weight:400;font-size:11px;color:' + C.muted + '">desde </span>' : ''}${eur(c.cents)}</td>
      </tr>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 4px;border-top:1px solid ${C.border}">${rows}</table>`;
}

const bikeUrl = (label: string) => `${BRAND_URL}/?moto=${encodeURIComponent(label)}`;
const unsubUrl = (token: string, all = false) => `${BRAND_URL}/api/moto-alerts/baja?token=${token}${all ? '&todas=1' : ''}`;

interface BikeNews { alertId: number; token: string; label: string; total: number; cards: ReturnType<typeof familyCards> }

function renderNewsEmail(name: string, news: BikeNews[]) {
  const one = news.length === 1;
  const subject = one ? `Piezas nuevas para tu ${news[0].label} · ${BRAND}` : `Piezas nuevas para tus motos · ${BRAND}`;
  const sections = news.map((n) => `
    <h2 style="margin:22px 0 4px;font-family:${MONO};font-size:16px;font-weight:700;text-transform:uppercase;color:${C.text}">${escapeHtml(n.label)}</h2>
    ${p(`${n.total === 1 ? 'Ha llegado <strong>1 recambio nuevo</strong> compatible' : `Han llegado <strong>${n.total} recambios nuevos</strong> compatibles`} con tu moto.`, 'margin:0 0 6px')}
    ${productRows(n.cards)}
    ${n.total > n.cards.length ? note(`Y ${n.total - n.cards.length} más en la web.`) : ''}
    ${button(bikeUrl(n.label), one ? 'Ver todo para mi moto' : `Ver todo para mi ${n.label}`)}
    ${note(`¿No quieres más avisos de esta moto? <a href="${escapeHtml(unsubUrl(n.token))}" style="color:${C.muted}">Darme de baja</a>.`)}`).join('');
  const html = shell(`
    ${heading(one ? 'Novedades para tu moto' : 'Novedades para tus motos')}
    ${greeting(name)}
    ${p('Acabamos de actualizar el catálogo y hay recambios nuevos que encajan con tu moto.')}
    ${sections}
    ${note(`Te escribimos porque pediste avisos de piezas nuevas o guardaste la moto en tu garaje de ${BRAND}. <a href="${escapeHtml(unsubUrl(news[0].token, true))}" style="color:${C.muted}">No quiero ningún aviso más</a>.`)}
  `, one ? `Recambios nuevos para tu ${news[0].label}.` : 'Recambios nuevos para tus motos.');
  const text = `Hola${name ? ` ${name}` : ''},

Hay recambios nuevos compatibles con tu moto en ${BRAND}:

${news.map((n) => `${n.label}: ${n.total} nuevo${n.total === 1 ? '' : 's'}
${n.cards.map((c) => `- ${c.name}: ${c.from ? 'desde ' : ''}${eur(c.cents)}`).join('\n')}
Ver todo: ${bikeUrl(n.label)}
Baja de esta moto: ${unsubUrl(n.token)}`).join('\n\n')}

No quiero ningún aviso más: ${unsubUrl(news[0].token, true)}`;
  return { subject, html, text };
}

/** Correo de confirmación al pulsar el botón. */
export async function sendAlertConfirmation(email: string, m: Moto, token: string) {
  const label = bikeLabel(m.brand, m.model, m.year);
  const current = (await sellableSkus(m)).length;
  const html = shell(`
    ${heading('Te avisaremos')}
    ${p(`Cuando lleguen recambios nuevos para tu <strong style="color:${C.text}">${escapeHtml(label)}</strong> te mandaremos un correo con ellos.`)}
    ${current > 0 ? p(`Ahora mismo ya tenemos ${current} compatible${current === 1 ? '' : 's'}:`) + button(bikeUrl(label), 'Ver recambios para mi moto') : p('Ahora mismo aún no tenemos ninguno, pero estamos ampliando el catálogo. Si lo necesitas antes, escríbenos y lo buscamos nosotros.')}
    ${note(`¿No lo has pedido tú o ya no te interesa? <a href="${escapeHtml(unsubUrl(token))}" style="color:${C.muted}">Darme de baja</a>.`)}
  `, `Te avisaremos de las piezas nuevas para tu ${label}.`);
  const text = `Cuando lleguen recambios nuevos para tu ${label} te mandaremos un correo con ellos.

${current > 0 ? `Ya tenemos ${current} compatibles: ${bikeUrl(label)}` : 'Ahora mismo aún no tenemos ninguno, pero estamos ampliando el catálogo.'}

Darme de baja: ${unsubUrl(token)}`;
  await sendEmail({ to: email, subject: `Te avisaremos de las piezas para tu ${label} · ${BRAND}`, html, text, template: 'moto_alert_confirm' });
}

let running = false;

/** Busca novedades y manda los correos. Devuelve un resumen para los logs y el admin. */
export async function runMotoAlerts(reason = 'manual') {
  if (running) return { skipped: true };
  running = true;
  const stats = { reason, alerts: 0, withNews: 0, emails: 0, waiting: 0 };
  try {
    await syncGarageAlerts();
    const { rows: alerts } = await pool.query(
      `SELECT a.id, a.email, a.user_id, a.brand, a.model, a.year, a.token, a.last_sent_at, u.first_name
       FROM moto_alerts a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.unsubscribed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM moto_alert_optout o WHERE o.email = lower(a.email))`);
    stats.alerts = alerts.length;

    const sellable = new Map<string, string[]>();
    const byEmail = new Map<string, { name: string; recent: boolean; items: { alert: any; fresh: string[] }[] }>();
    for (const a of alerts) {
      const key = motoKey(a);
      if (!sellable.has(key)) sellable.set(key, await sellableSkus(a));
      const skus = sellable.get(key)!;
      if (skus.length === 0) continue;
      const { rows: seen } = await pool.query(`SELECT sku FROM moto_alert_seen WHERE alert_id = $1`, [a.id]);
      const seenSet = new Set(seen.map((r: any) => r.sku));
      const fresh = skus.filter((s) => !seenSet.has(s));
      if (fresh.length === 0) continue;
      stats.withNews++;
      const e = normEmail(a.email);
      const entry = byEmail.get(e) || { name: a.first_name || '', recent: false, items: [] };
      if (a.last_sent_at && Date.now() - new Date(a.last_sent_at).getTime() < MIN_GAP_DAYS * 86_400_000) entry.recent = true;
      entry.items.push({ alert: a, fresh });
      byEmail.set(e, entry);
    }

    for (const [email, entry] of byEmail) {
      // Como mucho un correo cada MIN_GAP_DAYS: las novedades esperan al siguiente.
      if (entry.recent) { stats.waiting++; continue; }
      const news: BikeNews[] = [];
      for (const { alert, fresh } of entry.items) {
        const { rows } = await pool.query(
          `SELECT sku, name, price, sale_price, promo_price, stock, images, family_code
           FROM products WHERE status = 'published' AND price > 0 AND sku = ANY($1)`, [fresh]);
        const cards = familyCards(rows);
        if (cards.length === 0) continue;
        news.push({ alertId: alert.id, token: alert.token, label: bikeLabel(alert.brand, alert.model, alert.year), total: cards.length, cards: cards.slice(0, PRODUCTS_PER_BIKE) });
      }
      if (news.length === 0) continue;
      const mail = renderNewsEmail(entry.name, news);
      const res = await sendEmail({ to: email, ...mail, template: 'moto_alert_news' });
      if (res.status === 'permanent_failure') {
        console.warn(`[MOTO ALERTS] No se pudo enviar a ${email}: ${res.lastError}`);
        continue;
      }
      stats.emails++;
      for (const { alert, fresh } of entry.items) {
        await markSeen(alert.id, fresh);
        await pool.query(`UPDATE moto_alerts SET last_sent_at = NOW() WHERE id = $1`, [alert.id]);
      }
    }
    console.log('[MOTO ALERTS]', JSON.stringify(stats));
    return stats;
  } finally {
    running = false;
  }
}
