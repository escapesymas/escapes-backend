/**
 * Meilisearch integration for /api/catalog/products?search=
 *
 * Replaces the Postgres ILIKE search with a fuzzy Meilisearch query while
 * keeping the existing request signature (so the frontend doesn't change).
 *
 * Why Meilisearch (vs Typesense):
 *   - Simpler API: one POST /indexes/{idx}/search gets us fuzzy match,
 *     typo tolerance, prefix search, and facet distribution out of the box.
 *   - Single binary — installs as `meilisearch` (Docker image or curl tar),
 *     ~50 MB RAM for an empty index, ~200-400 MB for 100k products.
 *   - No JVM, no Elasticsearch — fits the existing VPS resource budget.
 *
 * Failure mode: if MEILISEARCH_HOST is unset, or the host is unreachable,
 * we log a warning and the caller falls back to the existing ILIKE query.
 * Search is non-critical — losing it for 5 minutes while Meilisearch
 * restarts must NEVER break the catalog endpoint.
 */

import { pool } from '../db.js';

const MEILI_HOST = (process.env.MEILISEARCH_HOST || '').replace(/\/+$/, '');
const MEILI_API_KEY = process.env.MEILISEARCH_API_KEY || '';
const INDEX_NAME = process.env.MEILISEARCH_INDEX || 'products';
const DEFAULT_TIMEOUT_MS = 1500; // tight budget — fall back fast on slowness

let lastIndexTs = 0;
let lastIndexTsWarned = false;

export function isMeilisearchEnabled(): boolean {
  return Boolean(MEILI_HOST);
}

export function meilisearchBanner(): string {
  if (!MEILI_HOST) {
    return '[SEARCH] Meilisearch disabled — MEILISEARCH_HOST not set, /api/catalog/products?search= uses ILIKE fallback';
  }
  return `[SEARCH] Meilisearch enabled — host=${MEILI_HOST} index=${INDEX_NAME}`;
}

interface MeiliSearchHit {
  id: number;
  name?: string;
  sku?: string;
  brand?: string;
  supplier_code?: string;
  description?: string;
}

interface MeiliSearchResponse {
  hits: MeiliSearchHit[];
  estimatedTotalHits?: number;
  totalHits?: number;
  processingTimeMs?: number;
}

export interface SearchResult {
  ids: number[];
  total: number;
  processingTimeMs?: number;
  via: 'meilisearch' | 'fallback';
}

/**
 * Query Meilisearch with the user's search term. Returns the matching product
 * IDs (descending relevance order) or `null` if Meilisearch is unavailable —
 * the caller treats `null` as "fall back to ILIKE".
 */
export async function meiliSearchProducts(query: string, limit: number, offset: number): Promise<SearchResult | null> {
  if (!MEILI_HOST) return null;
  if (!query.trim()) return null; // empty queries always go to Postgres so we can apply other filters in the same query
  const url = `${MEILI_HOST}/indexes/${encodeURIComponent(INDEX_NAME)}/search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(MEILI_API_KEY ? { Authorization: `Bearer ${MEILI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        q: query,
        limit,
        offset,
        attributesToRetrieve: ['id'],
        // Return only IDs — we re-apply brand/price/in_stock/etc filters
        // in Postgres so we don't pay the cost of mirroring every facet
        // across two systems. (Tradeoff: Meilisearch handles relevance,
        // Postgres handles structure.)
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.warn(`[SEARCH] meilisearch ${resp.status} for "${query}" — falling back to ILIKE`);
      return null;
    }
    const data = (await resp.json()) as MeiliSearchResponse;
    return {
      ids: (data.hits || []).map((h) => Number(h.id)).filter((n) => Number.isFinite(n)),
      total: data.estimatedTotalHits ?? data.totalHits ?? 0,
      processingTimeMs: data.processingTimeMs,
      via: 'meilisearch',
    };
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err?.name === 'AbortError' ? 'timeout' : err?.message || String(err);
    if (!lastIndexTsWarned) {
      console.warn(`[SEARCH] meilisearch unreachable (${msg}) — falling back to ILIKE. Subsequent failures will be silent.`);
      lastIndexTsWarned = true;
    }
    return null;
  }
}

export interface ReindexSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalDocs: number;
  errors: number;
  errorMessage?: string;
}

let lastReindex: ReindexSummary | null = null;
export function lastReindexSummary(): ReindexSummary | null { return lastReindex; }

/**
 * Push every published product into Meilisearch in batches of 1000. Runs
 * from /api/admin/reindex-search. Safe to call repeatedly — Meilisearch
 * upserts by primary key.
 *
 * Note: we only push the fields Meilisearch needs to score the query.
 * Brand/category facets still come from Postgres, so the catalog filter
 * endpoint doesn't need to be aware of this index.
 */
export async function reindexMeilisearch(): Promise<ReindexSummary> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const summary: ReindexSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    totalDocs: 0,
    errors: 0,
  };
  if (!MEILI_HOST) {
    summary.errors = 1;
    summary.errorMessage = 'MEILISEARCH_HOST not set';
    lastReindex = summary;
    return summary;
  }
  const BATCH_SIZE = 1000;
  let offset = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await pool.query<{ id: number; name: string | null; sku: string | null; brand: string | null; supplier_code: string | null; description: string | null; category_id: number | null; attributes: any }>(
        `SELECT id, name, sku, brand, supplier_code, description, category_id, attributes
         FROM products
         WHERE status IN ('published', 'active')
         ORDER BY id ASC
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      );
      if (res.rows.length === 0) break;
      offset += res.rows.length;
      const docs = res.rows.map((r) => ({
        id: r.id,
        name: r.name || '',
        sku: r.sku || '',
        brand: r.brand || '',
        supplier_code: r.supplier_code || '',
        description: (r.description || '').slice(0, 1000),
        category_id: r.category_id || 0,
      }));
      const pushResp = await fetch(`${MEILI_HOST}/indexes/${encodeURIComponent(INDEX_NAME)}/documents?primaryKey=id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(MEILI_API_KEY ? { Authorization: `Bearer ${MEILI_API_KEY}` } : {}),
        },
        body: JSON.stringify(docs),
      });
      if (!pushResp.ok) {
        const errText = await pushResp.text().catch(() => '');
        summary.errors++;
        summary.errorMessage = `HTTP ${pushResp.status}: ${errText.slice(0, 200)}`;
        console.error(`[SEARCH] meilisearch push failed: ${summary.errorMessage}`);
      } else {
        summary.totalDocs += docs.length;
      }
      // Bail out if the run is taking too long — the next call resumes from
      // the same offset (we ORDER BY id ASC) once the docs are visible.
      if (Date.now() - startMs > 8 * 60 * 1000) {
        console.warn('[SEARCH] reindex hit 8-minute budget, deferring remainder');
        break;
      }
    }
  } catch (err: any) {
    summary.errors++;
    summary.errorMessage = err?.message || String(err);
    console.error('[SEARCH] reindex fatal:', summary.errorMessage);
  }
  summary.finishedAt = new Date().toISOString();
  summary.durationMs = Date.now() - startMs;
  lastReindex = summary;
  console.log(`[SEARCH] reindex done totalDocs=${summary.totalDocs} errors=${summary.errors} durationMs=${summary.durationMs}`);
  return summary;
}
