import { Router } from 'express';
import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import os from 'os';
import { execSync } from 'child_process';
import { authenticateRequest } from '../utils.js';
import fs from 'fs';
import { enrichCatalog, type EnrichStats } from '../lib/catalog-enrich.js';
import { refreshCompatModels } from '../lib/compat.js';
import { LATEST_CATALOG_JSON } from '../bihrService.js';
import { cacheBust } from '../lib/cache.js';
import { repairProductImages } from '../lib/bihr-images.js';
import { getImageAudit, filterAuditItems, auditToCsv, recheckProductImages } from '../lib/image-audit.js';

export const adminRouter = Router();

// Middleware: Verify Admin Role
function requireAdmin(req: any, res: any, next: any) {
  const auth = authenticateRequest(req);
  if (auth && auth.role === 'admin') {
    req.user = auth;
    return next();
  }
  return res.status(401).json({ error: 'No autorizado como administrador' });
}

// GET /api/admin/catalog-stats
adminRouter.get('/admin/catalog-stats', requireAdmin, async (_req: any, res: any) => {
  try {
    const [totRes, pubRes, imgRes, stockRes] = await Promise.all([
      db.execute(sql`SELECT count(*) as count FROM products`),
      db.execute(sql`SELECT count(*) as count FROM products WHERE status = 'published'`),
      db.execute(sql`SELECT count(*) as count FROM products WHERE images IS NOT NULL AND images::text != '[]' AND images::text != 'null'`),
      db.execute(sql`SELECT count(*) as count FROM products WHERE stock > 0`),
    ]);

    res.json({
      total: Number(totRes.rows[0]?.count || 0),
      published: Number(pubRes.rows[0]?.count || 0),
      withImages: Number(imgRes.rows[0]?.count || 0),
      inStock: Number(stockRes.rows[0]?.count || 0),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/disk-usage
adminRouter.get('/admin/disk-usage', requireAdmin, async (_req: any, res: any) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    const cpuLoad = os.loadavg()[0];
    const cpuCores = os.cpus().length;
    const cpuPercent = Math.min(Math.round((cpuLoad / cpuCores) * 100), 100);

    let diskStats = { total: '115G', used: '20.5G', free: '94.5G', percent: '18%' };
    try {
      const dfOutput = execSync('df -h / | tail -n 1').toString();
      const parts = dfOutput.split(/\s+/);
      if (parts.length >= 5) {
        diskStats = {
          total: parts[1],
          used: parts[2],
          free: parts[3],
          percent: parts[4],
        };
      }
    } catch (e) {}

    res.json({
      memory: { total: totalMem, free: freeMem, used: usedMem, percent: memPercent },
      cpu: { loadAvg: cpuLoad, cores: cpuCores, percent: cpuPercent },
      disk: diskStats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/admin/dashboard-stats
adminRouter.get('/admin/dashboard-stats', requireAdmin, async (_req: any, res: any) => {
  try {
    const uR = await db.execute(sql`SELECT count(*) as count FROM users`);
    const pR = await db.execute(sql`SELECT count(*) as count FROM forum_posts`);
    const oR = await db.execute(sql`SELECT count(*) as count FROM orders`);
    const sR = await db.execute(sql`SELECT COALESCE(SUM(total), 0) as total FROM orders`);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    const cpuLoad = os.loadavg()[0];
    const cpuCores = os.cpus().length;
    const cpuPercent = Math.min(Math.round((cpuLoad / cpuCores) * 100), 100);

    let diskStats = { total: '115G', used: '20.5G', free: '94.5G', percent: '18%' };
    try {
      const dfOutput = execSync('df -h / | tail -n 1').toString();
      const parts = dfOutput.split(/\s+/);
      if (parts.length >= 5) {
        diskStats = {
          total: parts[1],
          used: parts[2],
          free: parts[3],
          percent: parts[4],
        };
      }
    } catch (e) {}

    res.json({
      users: Number(uR.rows[0]?.count || 0),
      posts: Number(pR.rows[0]?.count || 0),
      orders: Number(oR.rows[0]?.count || 0),
      sales: Number(sR.rows[0]?.total || 0) / 100,
      vps: {
        memoryPercent: memPercent,
        cpuPercent: cpuPercent,
        diskPercent: diskStats.percent,
        diskFree: diskStats.free,
        diskUsed: diskStats.used,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Enriquecimiento del catálogo (variantes, atributos, duplicados) a partir del
// último catálogo de Bihr descargado. Tarda varios minutos: se lanza en segundo
// plano y se consulta el estado.
let enrichState: { status: 'idle' | 'running' | 'done' | 'error'; startedAt?: string; finishedAt?: string; stats?: EnrichStats; error?: string } = { status: 'idle' };

adminRouter.post('/admin/catalog/enrich', requireAdmin, async (_req: any, res: any) => {
  if (enrichState.status === 'running') return res.status(409).json({ error: 'Ya hay un enriquecimiento en curso', state: enrichState });
  if (!fs.existsSync(LATEST_CATALOG_JSON)) {
    return res.status(400).json({ error: 'No hay catálogo de Bihr descargado. Lanza antes una sincronización de catálogo.' });
  }
  const csvDir = [process.env.CATALOG_CSV_DIR, '/app/server/uploads/catalog-csv', '/app/server/catalog-csv']
    .find((d) => d && fs.existsSync(d)) || '';
  enrichState = { status: 'running', startedAt: new Date().toISOString() };
  enrichCatalog(LATEST_CATALOG_JSON, csvDir)
    .then(async (stats) => {
      enrichState = { ...enrichState, status: 'done', finishedAt: new Date().toISOString(), stats };
      await refreshCompatModels().catch(() => {});
      await cacheBust('cache:products');
      await cacheBust('cache:filters');
    })
    .catch((e: any) => {
      enrichState = { ...enrichState, status: 'error', finishedAt: new Date().toISOString(), error: e?.message || String(e) };
    });
  return res.status(202).json(enrichState);
});

adminRouter.get('/admin/catalog/enrich', requireAdmin, (_req: any, res: any) => res.json(enrichState));

// POST /api/admin/products/:id/repair-images
// Vuelve a descargar las fotos del proveedor de UN producto y las guarda en local.
// Devuelve qué fuentes se probaron y qué contestó cada una (para ver el motivo si no hay foto).
adminRouter.post('/admin/products/:id(\\d+)/repair-images', requireAdmin, async (req: any, res: any) => {
  const id = parseInt(req.params.id, 10);
  try {
    const result = await repairProductImages(id);
    if (result.saved > 0) {
      // Listados, compatibilidades por moto y sugerencias del buscador guardan las fotos de la ficha.
      await Promise.all([cacheBust('cache:products'), cacheBust('compat:prod'), cacheBust('cache:suggest')]);
      await recheckProductImages(id).catch((e: any) => console.error('[IMAGE AUDIT RECHECK]:', e.message));
    }
    console.log(`[REPAIR IMAGES] producto ${id}: ${result.saved} fotos guardadas (${req.user?.email || req.user?.id || 'admin'})`);
    return res.json(result);
  } catch (err: any) {
    console.error('[REPAIR IMAGES ERROR]:', err.message);
    return res.status(/Ya se están/.test(err.message) ? 409 : 500).json({ error: err.message });
  }
});

// GET /api/admin/catalog/image-audit
// Productos de la tienda que se ven sin imagen (ver lib/image-audit.ts).
// Filtros: problem=sin_foto|foto_remota|fichero_perdido, stock=1 (solo con stock), q=texto,
// page, limit; refresh=1 vuelve a recorrer el catálogo; format=csv descarga todos los que cumplan el filtro.
adminRouter.get('/admin/catalog/image-audit', requireAdmin, async (req: any, res: any) => {
  try {
    const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
    const audit = await getImageAudit({ refresh: one(req.query.refresh) === '1' });
    const items = filterAuditItems(audit.items, { problem: one(req.query.problem), q: one(req.query.q), onlyInStock: one(req.query.stock) === '1' });
    if (one(req.query.format) === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="productos-sin-imagen-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(auditToCsv(items));
    }
    const limit = Math.min(Math.max(parseInt(one(req.query.limit), 10) || 50, 1), 200);
    const page = Math.max(parseInt(one(req.query.page), 10) || 1, 1);
    return res.json({ summary: audit.summary, total: items.length, page, limit, items: items.slice((page - 1) * limit, page * limit) });
  } catch (err: any) {
    console.error('[IMAGE AUDIT ERROR]:', err.message);
    return res.status(500).json({ error: err.message });
  }
});
