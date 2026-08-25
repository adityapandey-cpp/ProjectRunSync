const express = require('express');
const Run = require('../models/Run');
const { protect } = require('../middleware/auth');
const { generalLimiter } = require('../middleware/rateLimiter');
const { cacheGet, cacheSet, cacheDel } = require('../config/redis');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const RUNS_CACHE_TTL = 3600; // 1 hour
const AI_PLAN_CACHE_TTL = 86400; // 24 hours (used only for key naming/invalidation here)

const runsCacheKey = (userId) => `runs:${userId}`;
const aiPlanCacheKey = (userId) => `ai:plan:${userId}`;

const VALID_TYPES = ['easy', 'long', 'tempo', 'speed'];

// All run routes require auth
router.use(protect);
router.use(generalLimiter);

// POST /api/runs
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { type, distance, time, date } = req.body;
    const userId = req.user.id;

    if (!type || distance === undefined || time === undefined) {
      return res.status(400).json({
        success: false,
        error: 'type, distance, and time are required.',
      });
    }

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `type must be one of: ${VALID_TYPES.join(', ')}`,
      });
    }

    if (typeof distance !== 'number' || distance <= 0) {
      return res.status(400).json({ success: false, error: 'distance must be a positive number (km).' });
    }

    if (typeof time !== 'number' || time <= 0) {
      return res.status(400).json({ success: false, error: 'time must be a positive number (seconds).' });
    }

    const run = await Run.create({
      userId,
      type,
      distance,
      time,
      date: date ? new Date(date) : undefined,
    });

    // Cache invalidation policy: any new run invalidates the user's run
    // list cache AND their AI-generated plan, since the plan was based on
    // now-stale run history.
    await cacheDel(runsCacheKey(userId), aiPlanCacheKey(userId));

    return res.status(201).json({ success: true, data: run });
  }),
);

// GET /api/runs
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const cacheKey = runsCacheKey(userId);

    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, source: 'cache', data: cached });
    }

    const runs = await Run.find({ userId }).sort({ date: -1 }).lean();

    await cacheSet(cacheKey, runs, RUNS_CACHE_TTL);

    return res.status(200).json({ success: true, source: 'db', data: runs });
  }),
);

// GET /api/runs/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const run = await Run.findOne({ _id: req.params.id, userId: req.user.id });

    if (!run) {
      return res.status(404).json({ success: false, error: 'Run not found.' });
    }

    return res.status(200).json({ success: true, data: run });
  }),
);

// DELETE /api/runs/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const run = await Run.findOneAndDelete({ _id: req.params.id, userId });

    if (!run) {
      return res.status(404).json({ success: false, error: 'Run not found.' });
    }

    await cacheDel(runsCacheKey(userId), aiPlanCacheKey(userId));

    return res.status(200).json({ success: true, data: run });
  }),
);

module.exports = router;
