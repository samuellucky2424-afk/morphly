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
    URL, URLSearchParams, AbortSignal, console,
  });
  vm.runInContext(source + '\nrenderAll = () => {};', context);
  return { context, element, run: code => vm.runInContext(code, context) };
}

test('reports render progressively, share duplicate loads and never exceed two active requests', async () => {
  const h = harness();
  const calls = [];
  let active = 0, peak = 0;
  h.context.request = path => {
    const task = deferred();
    calls.push({ path, ...task });
    peak = Math.max(peak, ++active);
    return task.promise.finally(() => active--);
  };
  h.run('AdminAPI.request = request');
  const load = h.run('loadLiveData()');
  assert.equal(load, h.run('loadLiveData()'));
  assert.equal(calls.length, 2);
  calls[0].resolve({ signups: 42 });
  await tick();
  assert.equal(h.run('baseMetrics.signups'), 42, 'overview must paint while users is pending');
  assert.equal(calls.length, 3);
  calls[1].reject(new Error('Database timeout'));
  await tick();
  assert.equal(h.run('state.loadErrors.users'), 'Database timeout');
  for (let i = 2; i < 8; i++) { calls[i].resolve({}); await tick(); }
  assert.equal((await load).failures, 1);
  assert.equal(peak, 2);
  assert.equal(calls.length, 8);
  assert.equal(h.element('#refreshDataButton').disabled, false);
});

test('changed filters discard old responses and queue one fresh load without overlap', async () => {
  const h = harness();
  const calls = [];
  h.context.request = path => { const task = deferred(); calls.push({ path, ...task }); return task.promise; };
  h.run('AdminAPI.request = request');
  const load = h.run('loadLiveData()');
  h.run('state.period = "7"; loadLiveData()');
  assert.equal(calls.length, 2);
  calls[0].resolve({ signups: 999 }); calls[1].resolve({ users: [] });
  await tick();
  assert.equal(h.run('baseMetrics.signups'), 0);
  assert.equal(calls.length, 4);
  assert.match(calls[2].path, /days=7/);
  for (let i = 2; i < 10; i++) { calls[i].resolve(i === 2 ? { signups: 7 } : {}); await tick(); }
  await load;
  assert.equal(h.run('baseMetrics.signups'), 7);
});

test('admin login gives immediate feedback, prevents repeated submissions and recovers from errors', async () => {
  const h = harness();
  const authTask = deferred();
  let attempts = 0;
  h.context.window.supabase = { createClient: () => ({ auth: {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange() {},
    signInWithPassword: () => { attempts++; return authTask.promise; },
  } }) };
  h.context.fetch = async () => ({ json: async () => ({ supabaseUrl: 'https://example.test', supabaseAnonKey: 'public-fixture' }) });
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
