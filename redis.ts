import redis from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

type RedisClient = ReturnType<typeof redis.createClient>;

let redisClient: RedisClient | null = null;
let connectingPromise: Promise<RedisClient | null> | null = null;

function connectWithTimeout(client: RedisClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis connect timeout')), timeoutMs);
    client.connect()
      .then(() => { clearTimeout(timer); resolve(); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

export async function getRedisClient(): Promise<RedisClient | null> {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async (): Promise<RedisClient | null> => {
    try {
      const newClient: RedisClient = redis.createClient({
        url: REDIS_URL,
        socket: { connectTimeout: 1500, reconnectStrategy: false },
      });
      newClient.on('error', () => {
        // swallow errors once client is created; do not null out mid-operation
      });
      await connectWithTimeout(newClient, 2000);
      redisClient = newClient;
      console.log('[REDIS] Connected successfully');
      return newClient;
    } catch (error) {
      console.error('[REDIS] Failed to connect:', (error as Error).message);
      return null;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const client = await getRedisClient();
  
  if (!client) {
    console.warn('[RATE LIMIT] Redis unavailable, allowing request');
    return { allowed: true, remaining: maxRequests - 1, resetTime: Date.now() + windowMs };
  }

  const now = Date.now();
  const windowKey = `ratelimit:${key}:${Math.floor(now / windowMs)}`;
  const fullKey = `${windowKey}:${now}`;

  try {
    const current = parseInt(String(await client.incr(windowKey)));
    
    if (current === 1) {
      await client.expire(windowKey, Math.ceil(windowMs / 1000));
    }

    const ttl = parseInt(String(await client.ttl(windowKey)));
    const resetTime = now + (ttl > 0 ? ttl * 1000 : windowMs);

    return {
      allowed: current <= maxRequests,
      remaining: Math.max(0, maxRequests - current),
      resetTime,
    };
  } catch (error) {
    console.error('[RATE LIMIT] Redis error:', error);
    return { allowed: true, remaining: maxRequests - 1, resetTime: now + windowMs };
  }
}

export async function closeRedis() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
}