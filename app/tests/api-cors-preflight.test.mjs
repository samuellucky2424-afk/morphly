import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyApiCors } from '../server/api-cors.js';

function response() {
  return { headers: {}, statusCode: 200, ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; return this; } };
}

test('the desktop CORS preflight is answered before any route handler', () => {
  const res = response();
  assert.equal(applyApiCors({ method: 'OPTIONS', headers: { origin: 'null' } }, res), true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-headers'], /Authorization/);
  assert.match(res.headers['access-control-allow-methods'], /POST/);

  const post = response();
  assert.equal(applyApiCors({ method: 'POST', headers: {} }, post), false, 'real requests continue to their handler');
  assert.equal(post.ended, false);
  assert.equal(post.headers['access-control-allow-origin'], '*');
});

test('the router applies the preflight to every route, including firebase-register', () => {
  const router = readFileSync(new URL('../server/api-router.js', import.meta.url), 'utf8');
  const body = router.slice(router.indexOf('export async function handleApiRoute'));
  assert.ok(body.indexOf('applyApiCors(req, res)') < body.indexOf('routeHandler(req, res)'));
  assert.ok(body.indexOf('applyApiCors(req, res)') < body.indexOf('if (!routeHandler)'));
  assert.match(router, /'firebase-register': firebaseRegisterHandler/);
});
