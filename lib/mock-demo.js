const { createRequestAnalyzer } = require('./request-analysis');
const { AnalysisError } = require('./analysis-provider');

const DEMO_MESSAGE = "Please cancel order 1001 only if it hasn't shipped yet.";
function createMockAnalyzer() {
  const analyzer = createRequestAnalyzer({
    configured: true,
    async analyze(message) {
      if (message !== DEMO_MESSAGE) throw new AnalysisError('Mock demo accepts only the fixed fictional example.', 400);
      return {
        intent: 'cancellation_request', orderReferences: [{ reference: '1001', quote: 'order 1001' }], reason: null,
        cancellationConditions: [{ text: "only if it hasn't shipped yet", quote: "only if it hasn't shipped yet." }],
        unmetConditionRequirements: [], supportingQuotes: [DEMO_MESSAGE], missingInformation: [], clarificationQuestions: [],
      };
    },
  });
  return { configured: true, async analyze(input) {
    return { ...await analyzer.analyze(input), source: 'Mock demo — fixed fictional analysis' };
  } };
}
module.exports = { createMockAnalyzer, DEMO_MESSAGE };
