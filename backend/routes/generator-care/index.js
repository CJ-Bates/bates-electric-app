// backend/routes/generator-care/index.js
// Office dashboard API for the Generator Care program, split into focused
// sub-routers (pure structural refactor of the former single-file router —
// every route keeps its exact path, middleware, and behavior). Mounted by
// server.js at /api/generator-care.

const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

// All routes require office role — applied ONCE here, before every sub-router,
// exactly as the monolith's single router.use() did.
router.use(requireAuth, requireRole('office'));

// Sub-routers mount at the router root and keep their full unchanged paths
// (e.g. '/subscriptions/:id/change-plan'). No two routes share a method +
// pattern, so mount order cannot change which handler matches.
router.use(require('./subscriptions'));
router.use(require('./visits'));
router.use(require('./addons'));
router.use(require('./charges'));
router.use(require('./accounting'));
router.use(require('./metrics'));
router.use(require('./techs'));
router.use(require('./admin'));

module.exports = router;
