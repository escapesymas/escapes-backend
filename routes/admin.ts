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
