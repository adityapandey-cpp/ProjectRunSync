const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redisClient } = require('../config/redis');

/**
 * Creates an express-rate-limit middleware backed by our main Redis command
 * client (NOT the subscriber client — rate-limit-redis issues normal
 * INCR/PEXPIRE commands, which the subscriber connection cannot run once
 * it's in subscriber mode).
 */
function createRateLimiter({ windowMs, max, message, keyPrefix }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: keyPrefix || 'rl:',
    }),
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: message || 'Too many requests. Please try again later.',
      });
    },
  });
}

// General API limiter
const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  message: 'Too many requests from this IP. Please try again in a few minutes.',
  keyPrefix: 'rl:general:',
});

// Stricter limiter for auth endpoints (login/register brute-force protection)
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts. Please try again in a few minutes.',
  keyPrefix: 'rl:auth:',
});

// AI endpoints hit an external paid API — keep this tight
const aiLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15,
  message: 'AI coaching request limit reached. Please try again later.',
  keyPrefix: 'rl:ai:',
});

module.exports = { generalLimiter, authLimiter, aiLimiter, createRateLimiter };
