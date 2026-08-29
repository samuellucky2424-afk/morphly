import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePublicBuildEnvironment } from '../src/lib/public-env-validation.ts';

const validEnvironment = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'public-anon-key-with-enough-characters',
};

test('a valid public Supabase build configuration is accepted', () => {
  assert.doesNotThrow(() => validatePublicBuildEnvironment(validEnvironment));
});

test('quoted, malformed, and placeholder Supabase URLs fail the build', () => {
  for (const value of ['"https://example.supabase.co"', 'YOUR_SUPABASE_URL', 'not-a-url']) {
    assert.throws(
      () => validatePublicBuildEnvironment({ ...validEnvironment, VITE_SUPABASE_URL: value }),
      /VITE_SUPABASE_URL/,
    );
  }
});

test('missing and placeholder public keys fail without including their value in the error', () => {
  const placeholder = 'REPLACE_ME';
  assert.throws(
    () => validatePublicBuildEnvironment({ ...validEnvironment, VITE_SUPABASE_ANON_KEY: placeholder }),
    (error) => error instanceof Error &&
      /VITE_SUPABASE_ANON_KEY/.test(error.message) &&
      !error.message.includes(placeholder),
  );
});

test('configuration errors are suitable for development startup and do not claim the app is corrupt', () => {
  assert.throws(
    () => validatePublicBuildEnvironment({ ...validEnvironment, VITE_SUPABASE_ANON_KEY: '' }),
    (error) => error instanceof Error &&
      error.message.startsWith('Morphly public client configuration is invalid:') &&
      !/production build/i.test(error.message),
  );
});
