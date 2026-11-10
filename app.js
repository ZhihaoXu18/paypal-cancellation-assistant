const express = require('express');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createRequestAnalyzer, matchRequestToOrder } = require('./lib/request-analysis');
const { AnalysisError } = require('./lib/analysis-provider');
const { createPayPal, SafeError } = require('./lib/paypal');
const { createConditionCases } = require('./lib/condition-cases');
const { createShopify, ShopifyError } = require('./lib/shopify');
const { createMockAnalyzer } = require('./lib/mock-demo');

function createApp(paypal = createPayPal(), analyzer = createRequestAnalyzer(), shopify = createShopify(), cases = createConditionCases(), options = {}) {
  const app = express();
  const mockDemo = options.mockDemo === true;
  const sessionCookie = mockDemo ? 'mock_sandbox_session' : 'sandbox_session';
  const ownerCookie = mockDemo ? 'mock_condition_cases' : 'condition_cases';
  const cookiePrefix = mockDemo ? '/demo' : '';
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
  if (mockDemo) {
    app.use('/api', (req, res, next) => {
      if (!['/health', '/analysis/config', '/analysis', '/analysis/condition-review', '/analysis/condition-cases'].includes(req.path) &&
        !/^\/analysis\/condition-cases\/[a-f0-9-]+$/.test(req.path)) {
        return res.status(403).json({ error: 'Mock demo: external integrations and payment operations are disabled.' });
      }
      next();
    });
  } else {
    // A separate app instance, in-memory store and cookies keep demo findings out of real records.
    app.use('/demo', createApp({}, createMockAnalyzer(), {}, createConditionCases(), { mockDemo: true }));
    app.get('/mock-demo', (req, res) => res.sendFile(path.join(__dirname, 'public/mock-demo.html')));
  }
  app.use('/api', (req, res, next) => {
    const cookie = req.get('cookie') || '';
    let session = cookie.match(new RegExp(`(?:^|;\\s*)${sessionCookie}=([a-f0-9-]{36})(?:;|$)`))?.[1];
    if (!sessions.has(session)) {
      session = randomUUID(); sessions.add(session);
      res.cookie(sessionCookie, session, { httpOnly: true, sameSite: 'strict', path: cookiePrefix + '/api' });
      // Remove the previous narrower cookie so analysis and payment routes share one owner.
      if (!mockDemo) res.clearCookie('sandbox_session', { path: '/api/paypal' });
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
  function validateApiRequest(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && origin !== 'http://127.0.0.1:3000') return res.status(403).json({ error: 'Request origin is not allowed.' });
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON requests are required.' });
    next();
  }
  const reviewJson = express.json({ limit: '24kb' });
  app.post('/api/analysis', validateApiRequest, reviewJson, async (req, res) => {
    const pending = { id: randomUUID() };
    reviews.set(req.sandboxSession, pending);
    try {
      const result = await analyzer.analyze(req.body);
      const review = matchRequestToOrder(result.analysis, req.body.selectedOrderId);
      // A newer analysis in the same session supersedes this result, even if it finishes first.
      if (reviews.get(req.sandboxSession) !== pending) return res.status(409).json({ error: 'Analysis superseded. Analyze the current request again.' });
      Object.assign(pending, { review, selectedOrderId: req.body.selectedOrderId,
        conditionalCancellation: result.analysis.intent === 'cancellation_request' && !!review.blockingReason,
        messageDigest: digest(req.body.message), expiresAt: Date.now() + 15 * 60 * 1000 });
      res.json({ ...result, review: { ...review, reviewId: pending.id } });
    }
    catch (error) { res.status(error instanceof AnalysisError ? error.status : 500).json({ error: error instanceof AnalysisError ? error.message : 'AI analysis failed. No action was taken.' }); }
  });
  function caseOwner(req, res, next) {
    const cookie = req.get('cookie') || '';
    let owner = cookie.match(new RegExp(`(?:^|;\\s*)${ownerCookie}=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:;|$)`))?.[1];
    if (!owner) {
      owner = randomUUID();
      res.cookie(ownerCookie, owner, { httpOnly: true, sameSite: 'strict', path: cookiePrefix + '/api/analysis', maxAge: 365 * 86400000 });
    }
    req.caseOwner = owner;
    next();
  }
  function caseRoute(handler) {
    return (req, res) => {
      try { handler(req, res); }
      catch { res.status(500).json({ error: 'Could not access saved reviews. Try again before relying on a finding.' }); }
    };
  }
  function findingFrom(body) {
    const { outcome, evidence } = body || {};
    if (!['met', 'not_met', 'unknown'].includes(outcome) ||
      typeof evidence !== 'string' || !evidence.trim() || evidence.length > 500) return null;
    return { outcome, evidence: evidence.trim(), recordedAt: new Date().toISOString() };
  }
  function findingRevision(previous, finding) {
    if (!previous) return { finding, priorFindings: [] };
    const current = previous.finding;
    const history = previous.priorFindings || [];
    if (current.outcome === finding.outcome && current.evidence === finding.evidence) {
      return { finding: current, priorFindings: history };
    }
    return { finding, priorFindings: [current, ...history].slice(0, 25) };
  }
  function reviewContext(body, previous = {}) {
    const context = {};
    for (const [field, limit] of [['conditionSummary', 240], ['supportTicket', 64]]) {
      const value = body?.[field];
      if (value === undefined) {
        if (previous[field] !== undefined) context[field] = previous[field];
        continue;
      }
      if (typeof value !== 'string' || value.length > limit) return null;
      const trimmed = value.trim();
      if (field === 'supportTicket' && trimmed && !/^[A-Za-z0-9#][A-Za-z0-9#_.-]*$/.test(trimmed)) return null;
      context[field] = trimmed;
    }
    return context;
  }
  const invalidContext = 'Use a condition summary of up to 240 characters and a ticket ID of up to 64 characters (no spaces or URLs).';
  const invalidFinding = 'Choose a finding and enter an evidence note (1–500 characters).';
  app.get('/api/analysis/condition-cases', validateApiRequest, caseOwner, caseRoute((req, res) => {
    const records = cases.list(req.caseOwner).sort((a, b) => b.finding.recordedAt.localeCompare(a.finding.recordedAt));
    res.json({ cases: records.map(({ id, subject, finding }) => ({ id, subject, outcome: finding.outcome, recordedAt: finding.recordedAt })) });
  }));
  app.get('/api/analysis/condition-cases/:id', validateApiRequest, caseOwner, caseRoute((req, res) => {
    const record = cases.get(req.caseOwner, req.params.id);
    if (!record) return res.status(404).json({ error: 'Saved review not found in this browser.' });
    res.json({ case: record });
  }));
  app.post('/api/analysis/condition-cases/:id', validateApiRequest, reviewJson, caseOwner, caseRoute((req, res) => {
    const record = cases.get(req.caseOwner, req.params.id);
    if (!record) return res.status(404).json({ error: 'Saved review not found in this browser.' });
    if (record.version !== req.body?.version) return res.status(409).json({ error: 'This review has changed. Reopen it before saving.' });
    const finding = findingFrom(req.body);
    if (!finding) return res.status(400).json({ error: invalidFinding });
    const context = reviewContext(req.body, record);
    if (!context) return res.status(400).json({ error: invalidContext });
    const updated = { ...record, ...context, version: record.version + 1, ...findingRevision(record, finding) };
    cases.save(req.caseOwner, updated);
    res.json({ case: updated });
  }));
  app.post('/api/analysis/condition-review', validateApiRequest, reviewJson, caseOwner, caseRoute((req, res) => {
    const current = reviews.get(req.sandboxSession);
    const { reviewId, message, subject } = req.body || {};
    if (!current?.conditionalCancellation || current.id !== reviewId || current.expiresAt <= Date.now() ||
      typeof message !== 'string' || message.length > 4000 || digest(message) !== current.messageDigest) {
      return res.status(409).json({ error: 'Analyze the current conditional cancellation request again before saving a finding.' });
    }
    const finding = findingFrom(req.body);
    if (!finding) return res.status(400).json({ error: invalidFinding });
    if (subject !== undefined && (typeof subject !== 'string' || subject.length > 120)) {
      return res.status(400).json({ error: 'Review label must be at most 120 characters.' });
    }
    const previous = current.caseId && cases.get(req.caseOwner, current.caseId);
    if (previous && previous.version !== req.body.version) return res.status(409).json({ error: 'This review has changed. Reopen it before saving.' });
    const context = reviewContext(req.body, previous || {});
    if (!context) return res.status(400).json({ error: invalidContext });
    const record = { ...previous, ...context, id: previous?.id || randomUUID(), subject: subject?.trim() || previous?.subject || 'Conditional cancellation',
      version: (previous?.version || 0) + 1, ...findingRevision(previous, finding) };
    cases.save(req.caseOwner, record);
    current.caseId = record.id;
    res.json({ finding: record.finding, case: record });
  }));
  app.post('/api/analysis/condition-cases/:id/shopify-snapshot', validateApiRequest, reviewJson, caseOwner, async (req, res) => {
    const { orderId, confirmed, version } = req.body || {};
    if (confirmed !== true || typeof orderId !== 'string' || !/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,24}$/.test(orderId)) {
      return res.status(400).json({ error: 'Confirm the order and enter a valid Shopify order ID.' });
    }
    const conflict = 'This review changed. Reopen it before saving a Shopify snapshot.';
    try {
      const record = cases.get(req.caseOwner, req.params.id);
      if (!record) return res.status(404).json({ error: 'Saved review not found in this browser.' });
      if (record.version !== version) return res.status(409).json({ error: conflict });
      const result = await shopify.order(orderId);
      if (result.orderId !== orderId) return res.status(502).json({ error: 'Shopify returned a different order. No snapshot was saved.' });
      // Read the current revision again because the Shopify request may take time.
      const latest = cases.get(req.caseOwner, req.params.id);
      if (!latest || latest.version !== version) return res.status(409).json({ error: conflict });
      const { orderNumber, paymentStatus, fulfillmentStatus, queriedAt, source } = result;
      const shopifySnapshot = { orderId, orderNumber, paymentStatus, fulfillmentStatus, queriedAt, source };
      const updated = { ...latest, version: version + 1, shopifySnapshot };
      cases.save(req.caseOwner, updated);
      return res.json({ version: updated.version, shopifySnapshot });
    } catch (error) {
      const known = error instanceof ShopifyError;
      return res.status(known ? error.status : 500).json({
        error: known ? error.message : 'Could not retrieve and save the Shopify snapshot. Try again.',
      });
    }
  });
  app.get('/api/shopify/order', validateApiRequest, async (req, res) => {
    try { res.json(await shopify.order(req.query.id)); }
    catch (error) {
      const known = error instanceof ShopifyError;
      res.status(known ? error.status : 500).json({ error: known ? error.message : 'Shopify lookup failed. No order state is assumed.',
        ...(known ? { category: error.category, field: error.field, errorType: error.errorType } : {}) });
    }
  });
  app.use('/api/paypal', validateApiRequest);
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
  if (mockDemo) app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/mock-demo.html')));
  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}
const app = createApp();
module.exports = app;
module.exports.createApp = createApp;
