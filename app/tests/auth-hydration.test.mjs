import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/context/AuthContext.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const states = [], effects = [], calls = [], navigations = [];
  let listener;
  const session = { access_token: 'fixture-token', user: { id: 'fixture-user', email: 'person@example.test', user_metadata: {} } };
  const admin = deferred(), wallet = deferred();
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useState: initial => { const index = states.length; states.push(initial); return [initial, value => { states[index] = value; }]; },
    useEffect: effect => { effects.push(effect); },
    useCallback: callback => callback,
    useRef: value => ({ current: value }),
  };
  const auth = {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: callback => { listener = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signInWithPassword: async () => { listener('SIGNED_IN', session); return { data: { session }, error: null }; },
    signOut: async () => { listener('SIGNED_OUT', null); },
  };
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'react-router-dom': { useNavigate: () => (...args) => navigations.push(args) },
    '@/lib/routes': { getDefaultRoute: isAdmin => isAdmin ? '/admin' : '/dashboard', ROUTES: { PUBLIC: { LOGIN: '/login' } } },
    '@/lib/supabase': { supabase: { auth } },
    '@/lib/api-client': { apiFetch: path => { calls.push(path); return path === '/admin-me' ? admin.promise : wallet.promise; } },
    '@/lib/telemetry-client': { trackLogin() {} },
    '@/lib/auth-flow': { normalizeEmail: value => value.trim().toLowerCase() },
    '@/utils/referralCode': {}, '@/lib/account': {},
  };
  const context = vm.createContext({ exports: {}, require: name => modules[name], AbortSignal, console });
  vm.runInContext(compiled, context);
  const provider = context.exports.AuthProvider({ children: null }).props.value;
  effects.forEach(effect => effect());
  return { provider, calls, states, navigations, admin, wallet, emit: () => listener('SIGNED_IN', session) };
}

test('login and repeated auth events share wallet/admin work and start both requests concurrently', async () => {
  const h = harness();
  await tick();
  const login = h.provider.login('person@example.test', 'password');
  h.emit();
  await tick();
  assert.deepEqual(h.calls, ['/ensure-user-wallet', '/admin-me']);
  h.admin.resolve({ ok: true, json: async () => ({ isAdmin: true, role: 'owner' }) });
  h.wallet.resolve({ ok: true });
  await login;
  assert.equal(h.states[0].isAdmin, true);
  assert.equal(h.navigations[0][0], '/admin');
  h.emit();
  await tick();
  assert.equal(h.calls.length, 2);
});

test('a slow account check cannot restore the user or redirect after logout', async () => {
  const h = harness();
  await tick();
  const login = h.provider.login('person@example.test', 'password');
  await tick();
  await h.provider.logout();
  h.admin.resolve({ ok: true, json: async () => ({ isAdmin: true, role: 'owner' }) });
  h.wallet.resolve({ ok: true });
  await login;
  assert.equal(h.states[0], null);
  assert.deepEqual(h.navigations.map(entry => entry[0]), ['/login']);
});

test('account-access failures stay visible instead of sending an administrator to the user dashboard', async () => {
  const h = harness();
  await tick();
  const login = h.provider.login('person@example.test', 'password');
  h.admin.resolve({ ok: false, status: 504 });
  h.wallet.resolve({ ok: true });
  await login;
  assert.match(h.states[3], /Unable to check account access/);
  assert.equal(h.navigations.length, 0);
});
