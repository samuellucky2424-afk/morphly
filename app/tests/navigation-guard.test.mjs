import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindowTarget } from '../electron/navigation-guard.js';

test('packaged windows stay on local files and open Flutterwave externally', () => {
  assert.equal(classifyWindowTarget('file:///C:/Morphly/app/index.html'), 'allow');
  assert.equal(classifyWindowTarget('https://checkout.flutterwave.com/v3/hosted/pay/abc'), 'external');
  assert.equal(classifyWindowTarget('https://evil.example/phish'), 'deny');
  assert.equal(classifyWindowTarget('http://localhost:5173/'), 'deny');
  assert.equal(classifyWindowTarget('http://localhost:5173/', { packaged: false }), 'allow');
});
