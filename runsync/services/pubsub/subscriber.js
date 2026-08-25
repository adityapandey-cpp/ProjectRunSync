const Redis = require('ioredis');

/**
 * DEDICATED SUBSCRIBER CLIENT
 * -------------------------------------------------------------------------
 * ioredis rule: once a connection issues SUBSCRIBE/PSUBSCRIBE, that
 * connection is locked into subscriber mode and can only issue
 * SUBSCRIBE/UNSUBSCRIBE/PSUBSCRIBE/PUNSUBSCRIBE/PING/QUIT until it
 * unsubscribes from everything. It CANNOT run GET/SET/DEL etc.
 *
 * To guarantee we never violate that, this file creates and owns its own,
 * completely separate ioredis instance, used ONLY for SUBSCRIBE and message
 * handling. It never touches cache commands. The regular command client and
 * the publisher client live in config/redis.js.
 */

if (!process.env.REDIS_URL) {
  console.warn('[Redis:Subscriber] REDIS_URL is not set. Pub/Sub will fail.');
}

const subscriberClient = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // subscriber connections should retry indefinitely, not fail fast
  enableReadyCheck: true,
  connectionName: 'runsync-subscriber-client',
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
});

subscriberClient.on('connect', () => console.log('[Redis:Subscriber] Connected'));
subscriberClient.on('error', (err) => console.error('[Redis:Subscriber] Error:', err.message));

// Registry of channel -> Set of handler functions.
// Lets multiple parts of the app subscribe to the same channel without
// stepping on each other's `message` listeners.
const handlers = new Map();

subscriberClient.on('message', (channel, message) => {
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;

  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch (err) {
    console.error(`[Redis:Subscriber] Failed to parse message on "${channel}":`, err.message);
    return;
  }

  for (const handler of channelHandlers) {
    try {
      handler(parsed);
    } catch (err) {
      console.error(`[Redis:Subscriber] Handler error on "${channel}":`, err.message);
    }
  }
});

/**
 * Subscribe to a Redis channel and attach a handler.
 * Safe to call multiple times for the same channel (adds another handler).
 */
async function subscribeToChannel(channel, handler) {
  if (!handlers.has(channel)) {
    handlers.set(channel, new Set());
    try {
      await subscriberClient.subscribe(channel);
      console.log(`[Redis:Subscriber] Subscribed to "${channel}"`);
    } catch (err) {
      console.error(`[Redis:Subscriber] Failed to subscribe to "${channel}":`, err.message);
      handlers.delete(channel);
      throw err;
    }
  }
  handlers.get(channel).add(handler);
}

/**
 * Remove a specific handler from a channel; unsubscribes from Redis
 * entirely once no handlers remain for that channel.
 */
async function unsubscribeHandler(channel, handler) {
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;

  channelHandlers.delete(handler);

  if (channelHandlers.size === 0) {
    handlers.delete(channel);
    try {
      await subscriberClient.unsubscribe(channel);
      console.log(`[Redis:Subscriber] Unsubscribed from "${channel}"`);
    } catch (err) {
      console.error(`[Redis:Subscriber] Failed to unsubscribe from "${channel}":`, err.message);
    }
  }
}

module.exports = {
  subscriberClient,
  subscribeToChannel,
  unsubscribeHandler,
};
