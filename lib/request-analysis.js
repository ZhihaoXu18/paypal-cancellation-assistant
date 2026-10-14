const { createAnalysisProvider, AnalysisError } = require('./analysis-provider');
const INTENTS = new Set(['cancellation_request', 'refund_request', 'status_question', 'other', 'unclear']);
const hasOnly = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
const list = value => Array.isArray(value) && value.length <= 20 && value.every(text);
function explicitReferences(message) {
  const result = new Set();
  // Conservative extraction: PayPal IDs, known order/demo prefixes, order-labelled tokens, and hash-prefixed numbers.
  for (const match of message.matchAll(/\b(?=[A-Z0-9]{0,16}[A-Z])[A-Z0-9]{17}\b|\b(?:ORDER|DEMO)-[A-Za-z0-9-]+\b|#\d+\b|\border\s+(?:id\s*[:#]?\s*|#)?([A-Za-z0-9][A-Za-z0-9-]{0,63})/gi)) {
    const candidate = match[1] || match[0];
    if (/\d/.test(candidate) && candidate.length <= 64) result.add(candidate.replace(/^#/, ''));
  }
  // A source-labelled order establishes its alphabetic prefix. Recognize complete
  // identifiers with that same prefix elsewhere, including corrections, without
  // treating unrelated numbers, dates, or arbitrary SKU prefixes as orders.
  const prefixes = new Set([...result].map(reference => /^([A-Za-z]+)-[A-Za-z0-9-]+$/.exec(reference)?.[1]?.toLowerCase()).filter(Boolean));
  for (const match of message.matchAll(/(?<![A-Za-z0-9_-])([A-Za-z]+)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9_-])/g)) {
    if (prefixes.has(match[1].toLowerCase()) && /\d/.test(match[0]) && match[0].length <= 64) result.add(match[0]);
  }
  return [...result].sort((left, right) => message.indexOf(left) - message.indexOf(right));
}
function validate(raw, message, selectedOrderId) {
  // These diagnostics are fixed literals, never values or property names from model output.
  const invalid = (rule, field) => { throw new AnalysisError(`AI returned invalid or unsupported analysis. [validation.rule=${rule}, field=${field}] No action was taken.`); };
  const keys = ['intent', 'orderReferences', 'reason', 'supportingQuotes', 'missingInformation', 'clarificationQuestions'];
  if (!hasOnly(raw, keys)) invalid('exact_fields', 'analysis');
  if (!INTENTS.has(raw.intent)) invalid('allowed_intent', 'intent');
  if (!list(raw.supportingQuotes) || !raw.supportingQuotes.length) invalid('nonempty_text_list', 'supportingQuotes');
  if (!raw.supportingQuotes.every(quote => message.includes(quote))) invalid('verbatim_evidence', 'supportingQuotes');
  if (!list(raw.missingInformation)) invalid('text_list', 'missingInformation');
  if (!list(raw.clarificationQuestions)) invalid('text_list', 'clarificationQuestions');
  if (!Array.isArray(raw.orderReferences) || raw.orderReferences.length > 20) invalid('bounded_array', 'orderReferences');
  const detected = explicitReferences(message);
  for (const item of raw.orderReferences) {
    if (!hasOnly(item, ['reference', 'quote'])) invalid('exact_fields', 'orderReferences');
    if (!text(item.reference)) invalid('bounded_text', 'orderReferences.reference');
    if (!text(item.quote)) invalid('bounded_text', 'orderReferences.quote');
    if (!message.includes(item.quote)) invalid('verbatim_evidence', 'orderReferences.quote');
    if (!item.quote.includes(item.reference)) invalid('reference_in_quote', 'orderReferences.reference');
    if (!detected.includes(item.reference)) invalid('explicit_reference', 'orderReferences.reference');
  }
  if (raw.reason !== null) {
    if (!hasOnly(raw.reason, ['text', 'quote'])) invalid('exact_fields', 'reason');
    if (!text(raw.reason.text)) invalid('bounded_text', 'reason.text');
    if (!text(raw.reason.quote)) invalid('bounded_text', 'reason.quote');
    if (!message.includes(raw.reason.quote)) invalid('verbatim_evidence', 'reason.quote');
    if (!raw.reason.quote.includes(raw.reason.text)) invalid('text_in_quote', 'reason.text');
  }
  const orderReferences = detected.map(reference => raw.orderReferences.find(item => item.reference === reference) || { reference, quote: reference });
  const reviewFlags = [];
  const missingInformation = [...raw.missingInformation];
  const clarificationQuestions = [...raw.clarificationQuestions];
  if (!detected.length) {
    reviewFlags.push('missing_order_reference');
    missingInformation.push('An explicit order identifier is required. The selected order is context only.');
    clarificationQuestions.push('What is the exact order ID for this request?');
  }
  if (/\b(?:first|second|third|last|other|another|previous|next)\s+order\b|\b(?:this|that|my)\s+order\b/i.test(message)) {
    reviewFlags.push('ambiguous_order_reference');
    clarificationQuestions.push('Which exact order ID does the relative order reference refer to?');
  }
  if (detected.length > 1 || (selectedOrderId !== undefined && detected.some(reference => reference !== selectedOrderId))) {
    reviewFlags.push('conflicting_order_references');
    clarificationQuestions.push('Please confirm the exact order ID; the message references multiple orders or differs from the selected order.');
  }
  if (/ignore\s+(?:all|previous|the|application|merchant\s+approval)|system\s+prompt|override|\b(?:call|execute|invoke)\b.{0,80}\b(?:paypal|void|capture|refund|endpoint)\b/is.test(message)) reviewFlags.push('untrusted_instructions_present');
  return { intent: raw.intent, orderReferences, reason: raw.reason, supportingQuotes: raw.supportingQuotes,
    missingInformation: [...new Set(missingInformation)], clarificationQuestions: [...new Set(clarificationQuestions)],
    reviewFlags, requiresMerchantReview: true, customerClaimsVerified: false,
    explicitSelectedOrderMatch: detected.length === 1 && detected[0] === selectedOrderId && !reviewFlags.includes('ambiguous_order_reference'),
  };
}
function createRequestAnalyzer(provider = createAnalysisProvider()) {
  return {
    configured: provider.configured,
    async analyze({ message, selectedOrderId } = {}) {
      if (typeof message !== 'string' || !message.trim() || message.length > 4000 || (selectedOrderId !== undefined && (typeof selectedOrderId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(selectedOrderId)))) throw new AnalysisError('Enter a customer request of 1–4000 characters; any selected order ID must be valid.', 400);
      if (!provider.configured) throw new AnalysisError('AI not configured', 503);
      let raw;
      try { raw = await provider.analyze(message); }
      catch (error) { if (error instanceof AnalysisError) throw error; throw new AnalysisError('AI provider failed. No order or payment action was taken.'); }
      const analysis = validate(raw, message, selectedOrderId);
      return { selectedOrderId, source: 'AI analysis', customerClaims: 'Unverified customer claims', analysis,
        review: matchRequestToOrder(analysis, selectedOrderId) };
    },
  };
}
function matchRequestToOrder(analysis, selectedOrderId) {
  const references = analysis.orderReferences;
  const status = !references.length ? 'missing_reference'
    : analysis.reviewFlags.includes('ambiguous_order_reference') ? 'ambiguous_reference'
    : references.length > 1 ? 'multiple_references'
    : !selectedOrderId ? 'no_selected_order'
    : references[0].reference !== selectedOrderId ? 'mismatched' : 'matched';
  return { status, requiresManualResolution: status !== 'matched',
    canReviewCancellation: status === 'matched' && analysis.intent === 'cancellation_request',
    customerAuthenticated: false, cancellationApproved: false };
}
module.exports = { createRequestAnalyzer, validate, matchRequestToOrder };
