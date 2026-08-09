import { getRedisClient } from '../redis.js';

/**
 * Read a JSON-serialized value from the shared Redis cache.
 *
 * Returns `null` on miss, on Redis being unavailable, or on any parse/transport
 * error. Callers should treat a `null` result as a cache miss and continue to
 * compute the value themselves — caching is best-effort.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const client = await getRedisClient();
    if (!client) return null;
    const raw = await client.get(key);
    if (raw === null || raw === undefined) return null;
    // The node-redis client types `get` as `string | Buffer`; coerce defensively
    // so JSON.parse always sees a string.
    const str = typeof raw === 'string' ? raw : raw.toString('utf8');
    return JSON.parse(str) as T;
  } catch (err) {
    console.error('[CACHE GET ERROR]:', err);
    return null;
  }
}

/**
 * JSON-serialize `value` and write it to Redis with the given TTL (seconds).
 *
 * Errors are swallowed and logged: a cache write must never break the request
 * path. If Redis is unreachable the call is a no-op.
 */
export async function cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    const client = await getRedisClient();
    if (!client) return;
    await client.set(key, JSON.stringify(value), { EX: ttl });
  } catch (err) {
    console.error('[CACHE SET ERROR]:', err);
  }
}

/**
 * Invalidate every key under `prefix` using a paged `SCAN` + `DEL`.
 *
 * We deliberately use `SCAN` rather than `KEYS` so the bust never blocks the
 * Redis server, even when the keyspace is large. Safe to call from request
 * handlers.
 */
export async function cacheBust(prefix: string): Promise<void> {
  try {
    const client = await getRedisClient();
    if (!client) return;
    let cursor: number | string = 0;
    do {
      const reply = await client.scan(String(cursor) as any, { MATCH: `${prefix}*`, COUNT: 100 });
      cursor = Number(reply.cursor);
      const keys = reply.keys;
      if (keys && keys.length > 0) {
        await client.del(keys);
      }
    } while (Number(cursor) !== 0);
  } catch (err) {
    console.error('[CACHE BUST ERROR]:', err);
  }
}