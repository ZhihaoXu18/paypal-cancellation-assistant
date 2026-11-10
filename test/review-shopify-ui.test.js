const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Homepage loads Shopify review controls when a saved review is opened, without querying Shopify', async () => {
  assert.match(fs.readFileSync('public/index.html', 'utf8'), /<script src="\/review-shopify.js" defer><\/script>/);
  assert.doesNotMatch(fs.readFileSync('public/mock-demo.html', 'utf8'), /review-shopify\.js/);
  const nodes = new Map(), calls = [];
  function node(tag = '') {
    return { tag, value: '', text: '', children: [], handlers: {},
      get textContent() { return this.text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(' '); },
      set textContent(v) { this.text = v; },
      append(...items) { for (const item of items) { if (typeof item !== 'string') item.parent = this; this.children.push(item); } },
      replaceChildren() { this.children = []; this.text = ''; },
      before(item) { const siblings = this.parent.children; item.parent = this.parent; siblings.splice(siblings.indexOf(this), 0, item); },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      contains(item) { return this === item || this.children.some(c => typeof c !== 'string' && c.contains(item)); },
      addEventListener(event, callback) { this.handlers[event] = callback; }, setAttribute() {},
    };
  }
  const record = { id: 'fixture-review', version: 1, subject: 'Fictional warehouse follow-up', finding: {
    outcome: 'unknown', evidence: 'Fictional warehouse note', recordedAt: '2026-11-09T00:00:00Z',
  } };
  const context = vm.createContext({ URLSearchParams, encodeURIComponent,
    window: { location: { pathname: '/' } },
    document: { documentElement: { dataset: {} },
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
      createElement: node, head: { append() { assert.fail('External SDK must not load'); } },
    },
    fetch: async (url, options = {}) => {
      calls.push([url, options]);
      let body;
      if (url === '/api/paypal/config') return { ok: false, json: async () => ({ error: 'Not configured' }) };
      if (url === '/api/health') body = { status: 'ok' };
      else if (url === '/api/analysis/config') body = { configured: false };
      else if (url === '/api/analysis/condition-cases') body = { cases: [record] };
      else if (url === '/api/analysis/condition-cases/' + record.id && !options.method?.includes('POST')) body = { case: record };
      else assert.fail('Unexpected request: ' + url);
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('public/review-shopify.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const button = nodes.get('condition-cases-list').children[0].children[0];
  await button.handlers.click();
  const panel = nodes.get('condition-case-detail');
  assert.match(panel.textContent, /Save review finding.*Shopify order on this review/);
  assert.match(panel.textContent, /No Shopify order snapshot saved/);
  assert.match(panel.textContent, /Query Shopify and save snapshot/);
  const section = panel.children.at(-1);
  const form = section.children.at(-1);
  await form.handlers.submit({ preventDefault() {} });
  assert.ok(calls.every(([url]) => !url.includes('shopify')));
  // The renderer hook stays off the mock demo even if the script exists in a test context.
  context.window.location.pathname = '/mock-demo';
  panel.replaceChildren();
  vm.runInContext('renderConditionFinding(document.getElementById("condition-case-detail"), ' + JSON.stringify(record) + ', true)', context);
  assert.doesNotMatch(panel.textContent, /Shopify order on this review/);
});
