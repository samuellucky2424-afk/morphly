import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFails, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const collections = ['users', 'wallets', 'wallet_ledger', 'transactions', 'sessions', 'admin_users', 'payment_checkouts', 'translation_sessions'];

const testEnv = await initializeTestEnvironment({
  projectId: 'morphly-rules-test',
  firestore: { rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
});

try {
  const anon = testEnv.unauthenticatedContext();
  const user = testEnv.authenticatedContext('attacker');
  for (const name of collections) {
    for (const context of [anon, user]) {
      const ref = doc(context.firestore(), name, 'target');
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, { credits: 999999, role: 'super_admin' }));
    }
  }
  assert.ok(true);
} finally {
  await testEnv.cleanup();
}

console.log('firestore rules denied client reads and writes');
