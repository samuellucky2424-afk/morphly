import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function inspectConfig(overrides) {
  const env = { ...process.env };
  delete env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete env.FIREBASE_PROJECT_ID;
  delete env.VERCEL;
  Object.assign(env, overrides);
  const source = "const m = await import('./server/firebase-admin.js'); console.log(JSON.stringify({error:m.firebaseAdminConfigError,configured:m.firebaseAdmin!==null}));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('hosted Firebase cannot silently fall back to unavailable application-default credentials', () => {
  assert.deepEqual(inspectConfig({ VERCEL: '1', FIREBASE_PROJECT_ID: 'fixture-project' }),
    { error: 'Missing Firebase server credential', configured: false });
});

test('missing Firebase project remains a configuration failure before initialization', () => {
  assert.deepEqual(inspectConfig({ VERCEL: '1' }), { error: 'Missing FIREBASE_PROJECT_ID', configured: false });
});
