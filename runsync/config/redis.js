const Redis = require('ioredis');

/**
 * MAIN REDIS CLIENT
 * -------------------------------------------------------------------------
 * This client is reserved for regular command operations: GET, SET, DEL,
 * EXPIRE, cache reads/writes, and rate-limit-redis storage.
 *
 * IMPORTANT: This client must NEVER be put into subscriber mode (SUBSCRIBE /
 * PSUBSCRIBE). Once an ioredis connection issues a SUBSCRIBE command, the
 * ioredis client enters "subscriber mode" and refuses to run any other
 * command on that same connection until it unsubscribes. To avoid ever
 * hitting that restriction, all pub/sub subscription logic lives in its own
 * dedicated connection: services/pubsub/subscriber.js
 *
 * A separate lightweight publisher connection is also exposed here since
 * PUBLISH is a normal command (not a mode-switching one) and is safe to run
 * alongside GET/SET on a shared connection. We still keep it as its own
 * instance to avoid any contention with cache traffic under load.
 */

const redisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
};

if (!process.env.REDIS_URL) {
  console.warn('[Redis] REDIS_URL is not set. Redis-dependent features will fail.');
}

const redisClient = new Redis(process.env.REDIS_URL, {
  ...redisOptions,
  connectionName: 'runsync-main-command-client',
});

redisClient.on('connect', () => console.log('[Redis] Main command client connected'));
redisClient.on('error', (err) => console.error('[Redis] Main client error:', err.message));

// Dedicated PUBLISH-only client. PUBLISH is a normal (non-blocking-mode)
// command, but we isolate it from the cache-command client so pub/sub
// traffic for the multiplayer feature never queues behind cache I/O.
const publisherClient = new Redis(process.env.REDIS_URL, {
  ...redisOptions,
  connectionName: 'runsync-publisher-client',
});

publisherClient.on('connect', () => console.log('[Redis] Publisher client connected'));
publisherClient.on('error', (err) => console.error('[Redis] Publisher client error:', err.message));

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Get a JSON value from cache. Returns null if missing or on parse failure.
 */
async function cacheGet(key) {
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[Redis] cacheGet failed for key "${key}":`, err.message);
    return null;
  }
}

/**
 * Set a JSON value in cache with a TTL (seconds).
 */
async function cacheSet(key, value, ttlSeconds) {
  try {
    const raw = JSON.stringify(value);
    if (ttlSeconds) {
      await redisClient.set(key, raw, 'EX', ttlSeconds);
    } else {
      await redisClient.set(key, raw);
    }
    return true;
  } catch (err) {
    console.error(`[Redis] cacheSet failed for key "${key}":`, err.message);
    return false;
  }
}

/**
 * Delete one or more cache keys.
 */
async function cacheDel(...keys) {
  try {
    if (keys.length === 0) return 0;
    return await redisClient.del(...keys);
  } catch (err) {
    console.error(`[Redis] cacheDel failed for keys "${keys.join(', ')}":`, err.message);
    return 0;
  }
}

module.exports = {
  redisClient,
  publisherClient,
  cacheGet,
  cacheSet,
  cacheDel,
};
