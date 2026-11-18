/**
 * PDF del informe de la Vista general (A4, vectorial: texto seleccionable y gráficas nítidas al imprimir).
 * Usa solo las fuentes estándar de PDF (Helvetica), así que todo el texto pasa por `winAnsi` para no sacar caracteres que no tienen glifo.
 */
import PDFDocument from 'pdfkit';
import {
  DEVICE_NAMES, GROUP_ORDER, GROUP_TITLES, PAYMENT_NAMES, cityLabel, deltaOf, fmtDateTime, fmtDay, fmtValue, type Delta,
} from './overview-format.js';
import type { Kpi, OverviewReport } from './overview-report.js';

const C = {
  ink: '#111827', muted: '#6B7280', line: '#E5E7EB', band: '#0A0A0B', accent: '#FACC15', amber: '#F59E0B',
  prev: '#CBD5E1', good: '#15803D', bad: '#B91C1C', zebra: '#F9FAFB', head: '#1F2937',
};
const M = 40;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const W = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 54;

/** Caracteres que sí tienen glifo en las fuentes estándar (WinAnsi); el resto se sustituye o se quita. */
const WIN_EXTRA = new Set([8364, 8211, 8212, 8216, 8217, 8220, 8221, 8226, 8230, 8482, 402, 710, 732, 352, 353, 338, 339, 381, 382, 376, 8218, 8222, 8224, 8225, 8240, 8249, 8250]);
const SUBST: Record<string, string> = { '−': '-', '→': '->', '←': '<-', '≈': '~', '≥': '>=', '≤': '<=', '✓': 'OK', '▲': '+', '▼': '-', ' ': ' ', ' ': ' ', '​': '' };

export function winAnsi(input: string): string {
  let out = '';
  for (const ch of String(input)) {
    const code = ch.codePointAt(0)!;
    if (SUBST[ch] !== undefined) out += SUBST[ch];
    else if (code <= 255 || WIN_EXTRA.has(code)) out += ch;
    // lo demás (emojis, símbolos, chino) no existe en Helvetica: se omite
  }
  return out;
}

type Doc = InstanceType<typeof PDFDocument>;

function ensureSpace(doc: Doc, h: number): void {
  if (doc.y + h > BOTTOM) doc.addPage();
}

function sectionTitle(doc: Doc, text: string): void {
  ensureSpace(doc, 70);
  doc.moveDown(0.6);
  const y = doc.y;
  doc.rect(M, y + 1, 3, 13).fill(C.accent);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(winAnsi(text), M + 10, y, { width: W - 10 });
  doc.moveTo(M, doc.y + 4).lineTo(M + W, doc.y + 4).lineWidth(0.5).strokeColor(C.line).stroke();
  doc.y += 10;
  doc.x = M;
}

/** Triángulo de variación (se dibuja: «▲» no existe en las fuentes estándar). */
function deltaMark(doc: Doc, x: number, y: number, d: Delta): void {
  if (d.dir === 'none' || d.dir === 'flat') return;
  const color = d.sentiment === 'good' ? C.good : d.sentiment === 'bad' ? C.bad : C.muted;
  doc.save().fillColor(color);
  if (d.dir === 'down') doc.polygon([x, y], [x + 6, y], [x + 3, y + 5]).fill();
  else doc.polygon([x, y + 5], [x + 6, y + 5], [x + 3, y]).fill();
  doc.restore();
}

function deltaColor(d: Delta): string {
  return d.sentiment === 'good' ? C.good : d.sentiment === 'bad' ? C.bad : C.muted;
}

/** Tarjetas con los indicadores clave (4 por fila). */
function kpiCards(doc: Doc, kpis: Kpi[]): void {
  const cols = 4;
  const gap = 8;
  const cw = (W - gap * (cols - 1)) / cols;
  const ch = 64;
  let y = doc.y;
  kpis.forEach((k, i) => {
    const col = i % cols;
    if (col === 0 && i > 0) y += ch + gap;
    const x = M + col * (cw + gap);
    doc.roundedRect(x, y, cw, ch, 4).lineWidth(0.7).strokeColor(C.line).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(C.muted).text(winAnsi(k.label.toUpperCase()), x + 8, y + 8, { width: cw - 16, height: 18, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.ink).text(winAnsi(fmtValue(k.value, k.unit)), x + 8, y + 27, { width: cw - 16, lineBreak: false });
    const d = deltaOf(k);
    if (d.dir !== 'none') {
      deltaMark(doc, x + 8, y + 51, d);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(deltaColor(d)).text(winAnsi(`${d.text}  vs. anterior`), x + (d.dir === 'flat' ? 8 : 18), y + 49, { width: cw - 24, lineBreak: false });
    } else {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text('Foto del momento', x + 8, y + 50, { width: cw - 16, lineBreak: false });
    }
  });
  doc.y = y + ch + gap;
  doc.x = M;
}

interface Col { title: string; width: number; align?: 'left' | 'right' }

/** Tabla sencilla con cabecera oscura y filas cebreadas. Devuelve la «y» final. */
function table(doc: Doc, x: number, y: number, cols: Col[], rows: (string | { text: string; color?: string; bold?: boolean })[][], opts: { rowH?: number } = {}): number {
  const rowH = opts.rowH ?? 17;
  const total = cols.reduce((s, c) => s + c.width, 0);
  doc.rect(x, y, total, rowH).fill(C.head);
  let cx = x;
  for (const c of cols) {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF').text(winAnsi(c.title.toUpperCase()), cx + 6, y + 5.5, { width: c.width - 12, align: c.align || 'left', lineBreak: false });
    cx += c.width;
  }
  let cy = y + rowH;
  rows.forEach((row, i) => {
    if (i % 2 === 1) doc.rect(x, cy, total, rowH).fill(C.zebra);
    let rx = x;
    row.forEach((cell, j) => {
      const c = cols[j];
      const text = typeof cell === 'string' ? cell : cell.text;
      const color = typeof cell === 'string' ? C.ink : cell.color || C.ink;
      const bold = typeof cell === 'string' ? false : !!cell.bold;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color)
        .text(winAnsi(text), rx + 6, cy + 4.5, { width: c.width - 12, align: c.align || 'left', lineBreak: false, ellipsis: true, height: rowH });
      rx += c.width;
    });
    cy += rowH;
  });
  doc.moveTo(x, cy).lineTo(x + total, cy).lineWidth(0.5).strokeColor(C.line).stroke();
  return cy;
}

/** Gráfica de barras (una por día) con la cifra máxima y las fechas de los extremos. */
function barChart(doc: Doc, x: number, y: number, w: number, h: number, title: string, data: { label: string; value: number }[], format: (v: number) => string, color: string): void {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink).text(winAnsi(title), x, y, { width: w, lineBreak: false });
  const top = y + 16;
  const plotH = h - 16 - 14;
  const max = Math.max(...data.map((d) => d.value), 0);
  doc.rect(x, top, w, plotH).lineWidth(0.5).strokeColor(C.line).stroke();
  if (!data.length || max <= 0) {
    doc.font('Helvetica').fontSize(8).fillColor(C.muted).text('Sin datos en el periodo', x, top + plotH / 2 - 4, { width: w, align: 'center', lineBreak: false });
    return;
  }
  const slot = w / data.length;
  const bw = Math.max(0.6, Math.min(slot * 0.7, 14));
  data.forEach((d, i) => {
    if (d.value <= 0) return;
    const bh = Math.max(0.8, (d.value / max) * (plotH - 4));
    doc.rect(x + i * slot + (slot - bw) / 2, top + plotH - bh, bw, bh).fill(color);
  });
  doc.font('Helvetica').fontSize(7).fillColor(C.muted);
  doc.text(winAnsi(`máx. ${format(max)}`), x + 3, top + 2, { width: w - 6, align: 'right', lineBreak: false });
  const first = data[0].label, last = data[data.length - 1].label, mid = data[Math.floor(data.length / 2)].label;
  doc.text(winAnsi(first), x, top + plotH + 3, { width: w / 3, align: 'left', lineBreak: false });
  if (data.length > 2) doc.text(winAnsi(mid), x + w / 3, top + plotH + 3, { width: w / 3, align: 'center', lineBreak: false });
  doc.text(winAnsi(last), x + (2 * w) / 3, top + plotH + 3, { width: w / 3, align: 'right', lineBreak: false });
}

/** Embudo: barras horizontales con el porcentaje que pasa de un paso al siguiente. */
function funnel(doc: Doc, steps: OverviewReport['funnel']): void {
  const max = Math.max(...steps.map((s) => s.current), 1);
  const labelW = 120;
  const barX = M + labelW;
  const barMax = W - labelW - 130;
  steps.forEach((s, i) => {
    ensureSpace(doc, 26);
    const y = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor(C.ink).text(winAnsi(s.label), M, y + 4, { width: labelW - 6, lineBreak: false });
    const bw = Math.max(2, (s.current / max) * barMax);
    doc.rect(barX, y + 2, barMax, 14).fill(C.zebra);
    doc.rect(barX, y + 2, bw, 14).fill(C.amber);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(winAnsi(String(s.current)), barX + barMax + 8, y + 4, { width: 40, lineBreak: false });
    const prevStep = i > 0 ? steps[i - 1].current : 0;
    const conv = i > 0 && prevStep > 0 ? `${((s.current / prevStep) * 100).toFixed(1).replace('.', ',')} % del paso anterior` : i === 0 ? `antes: ${s.previous}` : '';
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(winAnsi(conv), barX + barMax + 44, y + 5, { width: 90, lineBreak: false });
    doc.y = y + 22;
    doc.x = M;
  });
}

/** Línea con partes en negrita (**así**). */
function richLine(doc: Doc, text: string, x: number, width: number, size: number, color: string): void {
  const parts = winAnsi(text).split('**');
  parts.forEach((p, i) => {
    if (!p) return;
    doc.font(i % 2 === 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color)
      .text(p, i === 0 ? x : undefined, undefined, { width, continued: i < parts.length - 1, lineGap: 2 });
  });
  if (parts.length === 1 || parts[parts.length - 1] === '') doc.text('', x, undefined, { width });
}

/** Texto en Markdown sencillo (títulos «##», listas y negritas) tal y como lo escribe la IA. */
function markdownBlock(doc: Doc, md: string): void {
  const lines = md.replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { doc.moveDown(0.3); continue; }
    ensureSpace(doc, 30);
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) {
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.ink).text(winAnsi(h[1].replace(/\*\*/g, '')), M, undefined, { width: W });
      doc.moveDown(0.15);
      continue;
    }
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const bullet = li[1] ? `${li[1]}.` : '•';
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.muted).text(winAnsi(bullet), M + 4, y, { width: 16, lineBreak: false });
      doc.y = y;
      richLine(doc, li[2], M + 20, W - 20, 9, C.ink);
      doc.moveDown(0.15);
      continue;
    }
    richLine(doc, line, M, W, 9, C.ink);
    doc.moveDown(0.15);
  }
  doc.x = M;
}

const eurFmt = (v: number) => fmtValue(v, 'eur');

export function buildOverviewPdf(report: OverviewReport, aiText?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: M, bufferPages: true,
      info: { Title: `Informe de la tienda · ${report.period.label}`, Author: 'Escapes y Más', Subject: 'Informe de rendimiento', Creator: 'Panel de Escapes y Más' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // ── Cabecera ──
      doc.rect(0, 0, PAGE_W, 96).fill(C.band);
      doc.rect(0, 96, PAGE_W, 3).fill(C.accent);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.accent).text('ESCAPES Y MÁS', M, 24, { characterSpacing: 2 });
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#FFFFFF').text('Informe de la tienda', M, 38);
      doc.font('Helvetica').fontSize(10).fillColor('#D1D5DB').text(winAnsi(report.period.label), M, 68);
      doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text(winAnsi(`Generado el ${fmtDateTime(report.generatedAt)}`), M, 34, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text(winAnsi(`Comparado con: ${report.period.prevLabel}`), M, 46, { width: W, align: 'right' });
      doc.y = 114;
      doc.x = M;

      // ── Indicadores clave ──
      const byId = new Map(report.kpis.map((k) => [k.id, k]));
      const headline = report.headline.map((id) => byId.get(id)).filter((k): k is Kpi => !!k);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text('Indicadores clave', M, doc.y);
      doc.y += 6;
      kpiCards(doc, headline);
      if (report.warnings.length) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.bad).text(winAnsi(report.warnings.join(' ')), M, doc.y, { width: W });
        doc.moveDown(0.5);
      }

      // ── Gráficas por día ──
      ensureSpace(doc, 150);
      const gy = doc.y + 4;
      const half = (W - 14) / 2;
      barChart(doc, M, gy, half, 120, 'Ventas por día (€)', report.sales.byDay.map((d) => ({ label: fmtDay(d.date), value: d.revenue })), eurFmt, C.amber);
      barChart(doc, M + half + 14, gy, half, 120, 'Visitantes por día', (report.visits?.byDay || []).map((d) => ({ label: fmtDay(d.date), value: d.visitors })), (v) => String(Math.round(v)), C.head);
      doc.y = gy + 128;
      doc.x = M;

      // ── Embudo ──
      if (report.funnel.length) {
        sectionTitle(doc, 'Del visitante al pedido');
        funnel(doc, report.funnel);
      }

      // ── Todos los KPIs por grupo ──
      for (const g of GROUP_ORDER) {
        const ks = report.kpis.filter((k) => k.group === g);
        if (!ks.length) continue;
        ensureSpace(doc, 17 * Math.min(ks.length, 4) + 60);
        sectionTitle(doc, GROUP_TITLES[g]);
        const cols: Col[] = [{ title: 'Indicador', width: 230 }, { title: 'Periodo', width: 95, align: 'right' }, { title: 'Anterior', width: 95, align: 'right' }, { title: 'Variación', width: 95, align: 'right' }];
        // La tabla se parte por páginas de 30 filas como máximo para no cortarse a mitad de una fila.
        for (let i = 0; i < ks.length; ) {
          const room = Math.floor((BOTTOM - doc.y - 6) / 17) - 1;
          if (room < 3) { doc.addPage(); continue; }
          const slice = ks.slice(i, i + Math.min(room, 30));
          const rows = slice.map((k) => {
            const d = deltaOf(k);
            return [
              k.label,
              { text: fmtValue(k.value, k.unit), bold: true },
              k.prev == null ? { text: 'foto del momento', color: C.muted } : fmtValue(k.prev, k.unit),
              { text: d.text || '-', color: deltaColor(d), bold: true },
            ];
          });
          doc.y = table(doc, M, doc.y, cols, rows) + 4;
          doc.x = M;
          i += slice.length;
          if (i < ks.length) doc.addPage();
        }
      }

      // ── Listados: lo más vendido, lo más visto… ──
      const v = report.visits;
      sectionTitle(doc, 'Qué se vende y qué se ve');
      if (report.sales.topProducts.length) {
        ensureSpace(doc, 20 + report.sales.topProducts.length * 17);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text('Productos más vendidos', M, doc.y);
        doc.y += 4;
        doc.y = table(doc, M, doc.y, [{ title: 'Producto', width: 355 }, { title: 'Uds.', width: 50, align: 'right' }, { title: 'Ventas', width: 110, align: 'right' }],
          report.sales.topProducts.map((p) => [`${p.name}`, String(p.units), { text: eurFmt(p.revenue), bold: true }])) + 10;
        doc.x = M;
      } else {
        doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text('No ha habido ventas en el periodo.', M, doc.y);
        doc.moveDown(0.8);
      }
      if (v?.topPages.length) {
        ensureSpace(doc, 20 + v.topPages.length * 17);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text('Páginas más vistas', M, doc.y);
        doc.y += 4;
        doc.y = table(doc, M, doc.y, [{ title: 'Página', width: 355 }, { title: 'Vistas', width: 60, align: 'right' }, { title: 'Visitantes', width: 100, align: 'right' }],
          v.topPages.map((p) => [p.title ? `${p.path}  ·  ${p.title}` : p.path, String(p.views), String(p.visitors)])) + 10;
        doc.x = M;
      }
      if (v) {
        const cw = (W - 20) / 3;
        const small = [
          { t: 'De dónde vienen', rows: v.sources.slice(0, 6).map((s) => [s.name, String(s.visitors)]) },
          { t: 'Dispositivos', rows: v.devices.map((d) => [DEVICE_NAMES[d.device] || d.device, String(d.visitors)]) },
          { t: 'Ciudades', rows: v.cities.slice(0, 6).map((c) => [cityLabel(c.city, c.country), String(c.visitors)]) },
        ];
        const h = 22 + (Math.max(...small.map((s) => s.rows.length), 1) + 1) * 17;
        ensureSpace(doc, h);
        const y0 = doc.y;
        let endY = y0;
        small.forEach((s, i) => {
          const x = M + i * (cw + 10);
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(s.t, x, y0, { width: cw, lineBreak: false });
          const cols: Col[] = [{ title: i === 0 ? 'Origen' : i === 1 ? 'Tipo' : 'Ciudad', width: cw - 58 }, { title: 'Visitantes', width: 58, align: 'right' }];
          endY = Math.max(endY, table(doc, x, y0 + 14, cols, s.rows));
        });
        doc.y = endY + 10;
        doc.x = M;

        const lists = [
          { t: 'Búsquedas más frecuentes', rows: v.topSearches.map((s) => [s.term, String(s.count)]) },
          { t: 'Búsquedas sin resultados', rows: v.noResultSearches.map((s) => [s.term, String(s.count)]) },
          { t: 'Motos que eligen', rows: v.topBikes.map((s) => [s.term, String(s.count)]) },
        ];
        const h2 = 22 + (Math.max(...lists.map((s) => s.rows.length), 1) + 1) * 17;
        ensureSpace(doc, h2);
        const y1 = doc.y;
        let end1 = y1;
        lists.forEach((s, i) => {
          const x = M + i * (cw + 10);
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(s.t, x, y1, { width: cw, lineBreak: false });
          if (s.rows.length) end1 = Math.max(end1, table(doc, x, y1 + 14, [{ title: 'Término', width: cw - 40 }, { title: 'Veces', width: 40, align: 'right' }], s.rows));
          else doc.font('Helvetica').fontSize(8).fillColor(C.muted).text('Sin datos', x, y1 + 16, { width: cw, lineBreak: false });
        });
        doc.y = Math.max(end1, y1 + 30) + 10;
        doc.x = M;
      }

      if (report.sales.payments.length || report.sales.coupons.length) {
        ensureSpace(doc, 80);
        const y2 = doc.y;
        const hw = (W - 14) / 2;
        let e2 = y2;
        if (report.sales.payments.length) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text('Métodos de pago', M, y2, { width: hw, lineBreak: false });
          e2 = Math.max(e2, table(doc, M, y2 + 14, [{ title: 'Método', width: hw - 110 }, { title: 'Pedidos', width: 50, align: 'right' }, { title: 'Importe', width: 60, align: 'right' }],
            report.sales.payments.map((p) => [PAYMENT_NAMES[p.method] || p.method, String(p.orders), eurFmt(p.revenue)])));
        }
        if (report.sales.coupons.length) {
          const x = M + hw + 14;
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text('Cupones usados', x, y2, { width: hw, lineBreak: false });
          e2 = Math.max(e2, table(doc, x, y2 + 14, [{ title: 'Cupón', width: hw - 110 }, { title: 'Pedidos', width: 50, align: 'right' }, { title: 'Descuento', width: 60, align: 'right' }],
            report.sales.coupons.map((c) => [c.code, String(c.orders), eurFmt(c.discount)])));
        }
        doc.y = e2 + 10;
        doc.x = M;
      }

      // ── Carritos activos ──
      sectionTitle(doc, 'Carritos activos ahora');
      doc.font('Helvetica').fontSize(9).fillColor(C.ink).text(
        winAnsi(`${report.carts.active.count} carritos con productos, por valor de ${eurFmt(report.carts.active.value)} (${report.carts.active.guests} de invitados y ${report.carts.active.stale} sin tocar desde hace más de 24 horas).`),
        M, doc.y, { width: W });
      doc.moveDown(0.5);
      if (report.carts.top.length) {
        ensureSpace(doc, 20 + report.carts.top.length * 17);
        doc.y = table(doc, M, doc.y, [{ title: 'Carrito', width: 90 }, { title: 'Cliente', width: 120 }, { title: 'Uds.', width: 60, align: 'right' }, { title: 'Valor', width: 100, align: 'right' }, { title: 'Última actividad', width: 145, align: 'right' }],
          report.carts.top.map((c) => [`#${c.id}`, c.email ? 'Con cuenta' : 'Invitado', String(c.items), { text: eurFmt(c.value), bold: true }, fmtDateTime(c.updatedAt)])) + 8;
        doc.x = M;
      }

      // ── Análisis de la IA ──
      if (aiText && aiText.trim()) {
        doc.addPage();
        sectionTitle(doc, 'Análisis y recomendaciones (IA)');
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.muted).text('Texto generado por inteligencia artificial a partir de los datos de este informe. Revisa las cifras importantes antes de tomar decisiones.', M, doc.y, { width: W });
        doc.moveDown(0.6);
        markdownBlock(doc, aiText);
      }

      // ── Cómo se calculan los datos ──
      ensureSpace(doc, 120);
      sectionTitle(doc, 'Cómo se calculan los datos');
      const notes = [
        'Ventas: pedidos pagados que no están cancelados ni reembolsados, IVA incluido. Los pedidos sin pagar salen aparte.',
        'Margen bruto estimado: base imponible menos el coste de los productos vendidos; los productos sin coste cuentan como coste 0.',
        'Los días son naturales en hora peninsular (Europe/Madrid). Cada periodo se compara con el anterior de la misma duración.',
        `Visitas y embudo: estadísticas web propias, ${report.excludeInternal ? 'sin' : 'con'} el tráfico de pruebas de Canarias. Un visitante es una sesión que ha visto al menos una página.`,
        'Carritos activos, clientes registrados y catálogo son una foto del momento en que se generó el informe.',
      ];
      for (const n of notes) {
        const y = doc.y;
        doc.font('Helvetica').fontSize(8).fillColor(C.muted).text('•', M + 2, y, { width: 10, lineBreak: false });
        doc.y = y;
        doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(winAnsi(n), M + 14, y, { width: W - 14 });
        doc.moveDown(0.2);
      }

      // ── Pie de página en todas las hojas ──
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const saved = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.moveTo(M, PAGE_H - 40).lineTo(M + W, PAGE_H - 40).lineWidth(0.5).strokeColor(C.line).stroke();
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
          .text(winAnsi(`Escapes y Más · Informe de la tienda · ${report.period.label}`), M, PAGE_H - 32, { width: W - 80, lineBreak: false })
          .text(`Página ${i + 1} de ${range.count}`, M + W - 80, PAGE_H - 32, { width: 80, align: 'right', lineBreak: false });
        doc.page.margins.bottom = saved;
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
