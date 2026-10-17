const express = require('express');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createRequestAnalyzer, matchRequestToOrder } = require('./lib/request-analysis');
const { AnalysisError } = require('./lib/analysis-provider');
const { createPayPal, SafeError } = require('./lib/paypal');

function createApp(paypal = createPayPal(), analyzer = createRequestAnalyzer()) {
  const app = express();
  const sessions = new Set();
  const reviews = new Map();
  const digest = message => createHash('sha256').update(message).digest('hex');
  function requireCancellationReview(req) {
    const review = reviews.get(req.sandboxSession);
    const confirmation = req.body || {};
    if (!review?.review?.canReviewCancellation || review.id !== confirmation.reviewId ||
      review.selectedOrderId !== req.params.id || review.expiresAt <= Date.now() ||
      typeof confirmation.message !== 'string' || digest(confirmation.message) !== review.messageDigest || confirmation.confirmed !== true) {
      throw new SafeError('A current matching cancellation review and explicit merchant confirmation are required. Resolve references and analyze again.', 409);
    }
    return review;
  }
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    const cookie = req.get('cookie') || '';
    let session = cookie.match(/(?:^|;\s*)sandbox_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
    if (!sessions.has(session)) {
      session = randomUUID(); sessions.add(session);
      res.cookie('sandbox_session', session, { httpOnly: true, sameSite: 'strict', path: '/api' });
      // Remove the previous narrower cookie so analysis and payment routes share one owner.
      res.clearCookie('sandbox_session', { path: '/api/paypal' });
    }
    req.sandboxSession = session;
    next();
  });
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', application: 'paypal-cancellation-assistant' });
  });
  app.get('/api/analysis/config', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ configured: analyzer.configured === true });
  });
  app.post('/api/analysis', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('origin') && req.get('origin') !== 'http://127.0.0.1:3000') return res.status(403).json({ error: 'Request origin is not allowed.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON requests are required.' });
    next();
  }, express.json({ limit: '24kb' }), async (req, res) => {
    const pending = { id: randomUUID() };
    reviews.set(req.sandboxSession, pending);
    try {
      const result = await analyzer.analyze(req.body);
      const review = matchRequestToOrder(result.analysis, req.body.selectedOrderId);
      // A newer analysis in the same session supersedes this result, even if it finishes first.
      if (reviews.get(req.sandboxSession) !== pending) return res.status(409).json({ error: 'Analysis superseded. Analyze the current request again.' });
      Object.assign(pending, { review, selectedOrderId: req.body.selectedOrderId,
        messageDigest: digest(req.body.message), expiresAt: Date.now() + 15 * 60 * 1000 });
      res.json({ ...result, review: { ...review, reviewId: pending.id } });
    }
    catch (error) { res.status(error instanceof AnalysisError ? error.status : 500).json({ error: error instanceof AnalysisError ? error.message : 'AI analysis failed. No action was taken.' }); }
  });
  app.use('/api/paypal', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && origin !== 'http://127.0.0.1:3000') return res.status(403).json({ error: 'Request origin is not allowed.' });
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON requests are required.' });
    next();
  });
  const route = (handler) => async (req, res) => {
    try {
      if (req.method === 'POST' && req.path.endsWith('/authorize')) console.log(`Sandbox authorization callback received for order ${req.params.id}.`);
      res.json(await handler(req));
    }
    catch (error) {
      console.warn(error instanceof SafeError ? error.message : 'Sandbox operation failed; raw details suppressed.');
      res.status(error instanceof SafeError ? error.status : 500).json({ error: error instanceof SafeError ? error.message : 'Sandbox operation failed.' });
    }
  };
  const paymentJson = express.json({ limit: '2kb' });
  const reviewJson = express.json({ limit: '24kb' });
  app.use('/api/paypal', (req, res, next) => {
    const parser = /\/orders\/[^/]+\/(?:cancel|void)$/.test(req.path) ? reviewJson : paymentJson;
    parser(req, res, next);
  });
  app.get('/api/paypal/config', route(() => paypal.config()));
  app.post('/api/paypal/orders', route(req => paypal.create(req.sandboxSession)));
  app.post('/api/paypal/orders/:id/authorize', route(req => paypal.authorize(req.params.id, req.sandboxSession)));
  app.post('/api/paypal/orders/:id/cancel', route(req => {
    requireCancellationReview(req);
    return paypal.cancel(req.params.id, req.sandboxSession);
  }));
  app.post('/api/paypal/orders/:id/void', route(req => {
    requireCancellationReview(req);
    return paypal.void(req.params.id, req.sandboxSession, req.body);
  }));
  app.get('/api/paypal/orders/:id', route(req => paypal.status(req.params.id, req.sandboxSession)));
  app.use((error, req, res, next) => { res.status(400).json({ error: 'Invalid JSON request.' }); });
  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}
const app = createApp();
module.exports = app;
module.exports.createApp = createApp;
