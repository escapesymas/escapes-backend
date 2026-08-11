# Meilisearch setup

The `/api/catalog/products?search=` endpoint supports Meilisearch as a
typo-tolerant fuzzy search backend. It's optional: with `MEILISEARCH_HOST`
unset, the endpoint falls back to a Postgres `ILIKE` query unchanged.

## Why

Postgres `ILIKE` over 100k products is slow (~600ms on a busy VPS) and
doesn't tolerate typos. Meilisearch handles 100k docs in <10ms with
typo tolerance, prefix matching, and `typoTolerance` settings that work
out of the box for motorcycle part numbers (`ARAI`, `NGK`, `RST`).

The Meili index only stores the fields needed for **scoring** (id, name,
sku, brand, supplier_code, description, category_id). Structural
filters (price range, in_stock, brand, category) stay in Postgres so we
don't have to maintain a second source of truth for facets.

## Quick start — local Docker

```bash
docker run -d --name meilisearch \
  -p 7700:7700 \
  -v /data/meili-data:/meili_data \
  -e MEILI_ENV=development \
  getmeili/meilisearch:v1.10
```

Add to `.env`:

```
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=                  # leave empty for dev; required for prod
MEILISEARCH_INDEX=products
```

Trigger a one-time reindex:

```bash
curl -X POST http://localhost:3001/api/admin/reindex-search \
  -H "x-admin-key: $ADMIN_KEY"
```

The reindex chunks the products table into 1000-doc batches and pushes
them to Meilisearch. With 100k products, expect ~10-30 seconds on a
modest VPS.

## Production — Coolify

1. Add a Meilisearch service to the Coolify dashboard (Docker image
   `getmeili/meilisearch:v1.10`, persistent volume for `/meili_data`).
2. Set a master key: `MEILI_MASTER_KEY=...` and expose port 7700 on a
   private network shared with the backend container.
3. In the backend container's env vars, set:
   ```
   MEILISEARCH_HOST=http://meilisearch:7700
   MEILISEARCH_API_KEY=<same master key>
   MEILISEARCH_INDEX=products
   ```
4. Trigger reindex from the admin endpoint or via the startup hook.
5. Smoke-test: `curl http://localhost:3001/api/catalog/products?search=arai` —
   the response should still be valid JSON, with the response time
   noticeably lower than 600ms.

## Indexing strategy

- **Reindex frequency**: full reindex is slow (10-30s) and rarely needed.
  Run it once on boot and on-demand from the admin endpoint. There is
  currently no delta-indexing — that's a future iteration if product
  churn justifies it.
- **Read budget**: the search query has a 1.5s timeout. If Meilisearch
  is slow or unreachable, the endpoint silently falls back to ILIKE so
  the catalog never breaks.
- **Failure modes**:
  - MEILISEARCH_HOST unset → ILIKE always (logs banner on boot).
  - Meilisearch down → ILIKE for that request (logs warning, then silent).
  - Meilisearch slow (>1.5s) → ILIKE for that request.

## Rollback

To revert to Postgres-only search, unset `MEILISEARCH_HOST` and restart
the backend. No code changes needed — the fallback path is the original
ILIKE logic.