import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../../morphly-admin-dashboard/app.js', import.meta.url), 'utf8'))
  .replace(/init\(\)\.catch\(.*\);\s*$/, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', disabled: false, hidden: false, handlers: {},
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute() {},
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    window: { location: { origin: 'https://example.test' } },
    document: { querySelector: element, querySelectorAll: () => [] },
    URL, URLSearchParams, AbortSignal, AbortController, console,
  });
  vm.runInContext(source + '\nrenderAll = () => {};', context);
  return { context, element, run: code => vm.runInContext(code, context) };
}

test('overview loads alone and shares duplicate requests', async () => {
  const h = harness();
  const task = deferred();
  const calls = [];
  h.context.request = path => { calls.push(path); return task.promise; };
  h.run('AdminAPI.request = request');
  const load = h.run('loadLiveData()');
  assert.equal(load, h.run('loadLiveData()'));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /admin-overview/);
  task.resolve({ signups: 42, revenueNGN: 500, buyers: 2, pendingPayments: 3 });
  await load;
  assert.equal(h.run('filteredMetrics().signups'), 42);
  assert.equal(h.run('filteredMetrics().revenue'), 500);
  assert.equal(h.run('filteredMetrics().buyers'), 2);
  assert.equal(h.run('filteredMetrics().pendingPayments'), 3);
  assert.equal(calls.length, 1, 'hidden tabs must not load');
});

test('transaction dependencies render progressively and never exceed two active requests', async () => {
  const h = harness();
  const calls = [];
  let active = 0, peak = 0;
  h.context.request = path => {
    const task = deferred();
    calls.push({ path, ...task });
    peak = Math.max(peak, ++active);
    return task.promise.finally(() => active--);
  };
  h.run('AdminAPI.request = request; state.activeView = "transactions"');
  const load = h.run('loadLiveData()');
  assert.equal(load, h.run('loadLiveData()'));
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /admin-transactions/);
  calls[0].resolve({ transactions: [{ id: 'payment-1', status: 'pending' }] });
  await tick();
  assert.equal(h.run('transactions.length'), 1, 'transactions must paint while users is pending');
  assert.equal(calls.length, 3);
  calls[1].reject(new Error('Database timeout'));
  await tick();
  assert.equal(h.run('state.loadErrors.users'), 'Database timeout');
  calls[2].resolve({});
  assert.equal((await load).failures, 1);
  assert.equal(peak, 2);
  assert.equal(calls.length, 3);
  assert.equal(h.element('#refreshDataButton').disabled, false);
});

test('changed filters discard old responses and queue one fresh load without overlap', async () => {
  const h = harness();
  const calls = [];
  h.context.request = path => { const task = deferred(); calls.push({ path, ...task }); return task.promise; };
  h.run('AdminAPI.request = request');
  const load = h.run('loadLiveData()');
  h.run('state.period = "7"; loadLiveData()');
  assert.equal(calls.length, 1);
  calls[0].resolve({ signups: 999 });
  await tick();
  assert.equal(h.run('baseMetrics.signups'), 0);
  assert.equal(calls.length, 2);
  assert.match(calls[1].path, /days=7/);
  calls[1].resolve({ signups: 7 });
  await load;
  assert.equal(h.run('baseMetrics.signups'), 7);
});

test('changing tabs aborts the obsolete request and loads only the new tab', async () => {
  const h = harness();
  const calls = [];
  h.context.request = (path, { signal }) => {
    const task = deferred();
    signal.addEventListener('abort', () => task.reject(signal.reason), { once: true });
    calls.push({ path, signal, ...task });
    return task.promise;
  };
  h.run('AdminAPI.request = request');
  const load = h.run('loadLiveData()');
  h.run('state.activeView = "usage"; loadLiveData()');
  assert.equal(calls[0].signal.aborted, true);
  await tick();
  assert.equal(calls.length, 2);
  assert.match(calls[1].path, /admin-usage/);
  calls[1].resolve({ totals: { sessions: 8 } });
  await load;
  assert.equal(h.run('state.usage.totals.sessions'), 8);
  assert.equal(h.run('Object.keys(state.loadErrors).length'), 0);
});

test('every other tab requests only its own report', async () => {
  for (const view of ['users', 'usage', 'referrals', 'packages', 'logs', 'developer', 'communications']) {
    const h = harness();
    const calls = [];
    h.context.request = async path => { calls.push(path); return {}; };
    h.run(`AdminAPI.request = request; state.activeView = "${view}"`);
    await h.run('loadLiveData()');
    assert.equal(calls.length, ['developer', 'communications'].includes(view) ? 0 : 1, view);
  }
});

test('admin login gives immediate feedback, prevents repeated submissions and recovers from errors', async () => {
  const h = harness();
  const authTask = deferred();
  let attempts = 0;
  h.context.window.morphlyFirebase = { createClient: () => ({ auth: {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange() {},
    signInWithPassword: () => { attempts++; return authTask.promise; },
  } }) };
  h.context.fetch = async () => ({ json: async () => ({ firebaseConfig: { apiKey: 'public-fixture' } }) });
  await h.run('init()');
  const button = h.element('#adminLoginForm button[type="submit"]');
  const submit = h.element('#adminLoginForm').handlers.submit;
  const pending = submit({ preventDefault() {} });
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Signing in...');
  await submit({ preventDefault() {} });
  assert.equal(attempts, 1);
  authTask.reject(new Error('Network unavailable'));
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Sign in');
  assert.equal(h.element('#loginError').textContent, 'Network unavailable');
});
