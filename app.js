const express = require('express');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequestAnalyzer } = require('./lib/request-analysis');
const { AnalysisError } = require('./lib/analysis-provider');
const { createPayPal, SafeError } = require('./lib/paypal');

function createApp(paypal = createPayPal(), analyzer = createRequestAnalyzer()) {
  const app = express();
  const sessions = new Set();
  app.disable('x-powered-by');
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
    try { res.json(await analyzer.analyze(req.body)); }
    catch (error) { res.status(error instanceof AnalysisError ? error.status : 500).json({ error: error instanceof AnalysisError ? error.message : 'AI analysis failed. No action was taken.' }); }
  });
  app.use('/api/paypal', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && origin !== 'http://127.0.0.1:3000') return res.status(403).json({ error: 'Request origin is not allowed.' });
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON requests are required.' });
    const cookie = req.get('cookie') || '';
    let session = cookie.match(/(?:^|;\s*)sandbox_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
    if (!sessions.has(session)) {
      session = randomUUID(); sessions.add(session);
      res.cookie('sandbox_session', session, { httpOnly: true, sameSite: 'strict', path: '/api/paypal' });
    }
    req.sandboxSession = session;
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
  app.use('/api/paypal', express.json({ limit: '2kb' }));
  app.get('/api/paypal/config', route(() => paypal.config()));
  app.post('/api/paypal/orders', route(req => paypal.create(req.sandboxSession)));
  app.post('/api/paypal/orders/:id/authorize', route(req => paypal.authorize(req.params.id, req.sandboxSession)));
  app.post('/api/paypal/orders/:id/cancel', route(req => paypal.cancel(req.params.id, req.sandboxSession)));
  app.post('/api/paypal/orders/:id/void', route(req => paypal.void(req.params.id, req.sandboxSession, req.body)));
  app.get('/api/paypal/orders/:id', route(req => paypal.status(req.params.id, req.sandboxSession)));
  app.use((error, req, res, next) => { res.status(400).json({ error: 'Invalid JSON request.' }); });
  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}
const app = createApp();
module.exports = app;
module.exports.createApp = createApp;
