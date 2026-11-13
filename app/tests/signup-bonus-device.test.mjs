import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFirebaseOperations } from '../server/firebase-operations.js';

function memoryDb() {
  const rows = new Map();
  let pending = Promise.resolve();
  const snapshot = path => {
    const data = rows.get(path);
    return { id: path.split('/')[1], ref: document(path), exists: rows.has(path), data: () => data ? { ...data } : undefined };
  };
  function document(path) {
    return { path, id: path.split('/')[1], async get() { return snapshot(path); } };
  }
  function matches(query) {
    const docs = [...rows.entries()]
      .filter(([path, row]) => path.startsWith(`${query.name}/`) && (!query.field || row[query.field] === query.value))
      .map(([path]) => snapshot(path));
    return { size: docs.length, docs, empty: docs.length === 0 };
  }
  return {
    collection(name) {
      return { doc: id => document(`${name}/${id}`), where: (field, _op, value) => ({ name, field, value }) };
    },
    runTransaction(fn) {
      const result = pending.then(() => fn({
        get: async target => target.path ? snapshot(target.path) : matches(target),
        update(target, change) { rows.set(target.path, { ...rows.get(target.path), ...change }); },
        set(target, data) { rows.set(target.path, { ...(rows.get(target.path) || {}), ...data }); },
        create(target, data) { if (rows.has(target.path)) throw new Error('already exists'); rows.set(target.path, { ...data }); },
      }));
      pending = result.then(() => {}, () => {});
      return result;
    },
    rows: () => [...rows.entries()],
  };
}

test('a second account on the same device still receives its own signup bonus', async () => {
  const db = memoryDb();
  const ops = createFirebaseOperations(db, {});
  await ops.provision({ id: 'first', email: 'first@example.com' });
  await ops.provision({ id: 'first', email: 'first@example.com' });
  await ops.provision({ id: 'second', email: 'second@example.com' });
  const wallets = db.rows().filter(([path]) => path.startsWith('wallets/')).map(([, row]) => row);
  const bonuses = db.rows().filter(([, row]) => row.transaction_type === 'signup_bonus').map(([, row]) => row);
  assert.deepEqual(wallets.map(row => row.credits).sort(), [50, 50]);
  assert.deepEqual(bonuses.map(row => row.reference).sort(), ['signup_bonus:first', 'signup_bonus:second']);
  assert.equal(bonuses.length, 2);
});

test('session start does not gate the signup bonus or a new session on the installation id', () => {
  const start = readFileSync(new URL('../server/api/start-session.ts', import.meta.url), 'utf8');
  const register = readFileSync(new URL('../server/firebase-operations.js', import.meta.url), 'utf8');
  assert.match(register, /signup_bonus:\$\{uid\}/);
  assert.doesNotMatch(register, /installation/);
  assert.match(start, /installationId/);
  assert.doesNotMatch(start, /installationId[\s\S]{0,120}(deny|blocked|another account|signup_bonus)/i);
});
