const express = require('express');
const Run = require('../models/Run');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimiter');
const { cacheGet, cacheSet } = require('../config/redis');
const { generateCoachingPlan, GeminiError } = require('../services/gemini');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const AI_PLAN_CACHE_TTL = 86400; // 24 hours
const aiPlanCacheKey = (userId) => `ai:plan:${userId}`;

router.use(protect);

// GET /api/ai/plan — returns a cached or freshly generated 7-day training plan
router.get(
  '/plan',
  aiLimiter,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const cacheKey = aiPlanCacheKey(userId);

    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, source: 'cache', data: cached });
    }

    const [recentRuns, user] = await Promise.all([
      Run.find({ userId }).sort({ date: -1 }).limit(10).lean(),
      User.findById(userId).lean(),
    ]);

    let plan;
    try {
      plan = await generateCoachingPlan(recentRuns, user?.name);
    } catch (err) {
      if (err instanceof GeminiError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      throw err;
    }

    await cacheSet(cacheKey, plan, AI_PLAN_CACHE_TTL);

    return res.status(200).json({ success: true, source: 'gemini', data: plan });
  }),
);

// POST /api/ai/plan/refresh — force-regenerate, bypassing cache
router.post(
  '/plan/refresh',
  aiLimiter,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const cacheKey = aiPlanCacheKey(userId);

    const [recentRuns, user] = await Promise.all([
      Run.find({ userId }).sort({ date: -1 }).limit(10).lean(),
      User.findById(userId).lean(),
    ]);

    let plan;
    try {
      plan = await generateCoachingPlan(recentRuns, user?.name);
    } catch (err) {
      if (err instanceof GeminiError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      throw err;
    }

    await cacheSet(cacheKey, plan, AI_PLAN_CACHE_TTL);

    return res.status(200).json({ success: true, source: 'gemini', data: plan });
  }),
);

module.exports = router;
