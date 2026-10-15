import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceHandler } from '../server/api/voice.ts';
import { invalidateVoiceCache, ownerTag, describeElevenLabsError, normalizeVoiceName } from '../server/elevenlabs-voice.js';

const premade = { voiceId: 'premadeVoice01', name: 'Rachel', category: 'premade', description: 'Calm', previewUrl: 'https://x/p.mp3' };
const mine = { voiceId: 'ownerVoice0001', name: 'My clone', category: 'cloned', description: ownerTag('owner') };
const theirs = { voiceId: 'otherVoice0001', name: 'Private', category: 'cloned', description: ownerTag('someone-else') };

function fakeClient(calls = {}) {
  return {
    voices: {
      search: async () => ({ voices: [theirs, premade, mine], hasMore: false }),
      get: async id => [premade, mine, theirs].find(voice => voice.voiceId === id) || Promise.reject(new Error('missing')),
      delete: async id => { calls.deleted = id; return {}; },
      ivc: { create: async request => { calls.clone = request; return { voiceId: 'newVoice000001', requiresVerification: false }; } },
    },
    speechToSpeech: {
      convert: async (voiceId, request) => {
        calls.convert = { voiceId, request };
        return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
      },
    },
  };
}

function handler(action, { client = fakeClient(), user = 'owner', authError } = {}) {
  return createVoiceHandler(action, {
    getClient: () => client,
    admin: () => ({}),
    auth: async () => authError ? { error: authError, status: 401 } : { user: { id: user } },
  });
}

async function call(action, { method = action === 'voices' ? 'GET' : 'POST', body = {}, ...options } = {}) {
  invalidateVoiceCache();
  const response = {
    headers: {}, statusCode: 200, body: undefined, ended: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end(value) { this.ended = value; return this; },
  };
  await handler(action, options)({ method, body, headers: {} }, response);
  return response;
}

const pcm = Buffer.alloc(3200).toString('base64');

test('voice routes require configuration and a signed-in account', async () => {
  const unconfigured = createVoiceHandler('voices', { getClient: () => null, admin: () => ({}), auth: async () => ({ user: { id: 'owner' } }) });
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await unconfigured({ method: 'GET', headers: {} }, response);
  assert.equal(response.code, 503);
  assert.equal((await call('voices', { authError: 'Unauthorized' })).statusCode, 401);
  assert.equal((await call('convert', { method: 'GET' })).statusCode, 405);
});

test('voice list shows library voices and only the caller\'s own uploads', async () => {
  const { body } = await call('voices');
  assert.deepEqual(body.voices.map(voice => voice.id), ['ownerVoice0001', 'premadeVoice01']);
  assert.equal(body.voices[0].own, true);
  assert.equal(body.voices[1].previewUrl, 'https://x/p.mp3');
});

test('uploading a voice clones it under the caller\'s ownership', async () => {
  const calls = {};
  const response = await call('clone', { client: fakeClient(calls),
    body: { name: 'Studio take.wav', fileName: 'take.wav', contentType: 'audio/wav', audio: Buffer.from('RIFF....').toString('base64') } });
  assert.equal(response.body.voice.id, 'newVoice000001');
  assert.equal(calls.clone.name, 'Studio take');
  assert.equal(calls.clone.description, ownerTag('owner'));
  assert.equal(calls.clone.files[0].contentType, 'audio/wav');
  assert.equal((await call('clone', { body: { contentType: 'text/plain', audio: 'aGk=' } })).statusCode, 400);
  const tooLarge = Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
  assert.equal((await call('clone', { body: { contentType: 'audio/mpeg', audio: tooLarge } })).statusCode, 400);
});

test('conversion sends 16 kHz PCM and returns converted audio for an allowed voice', async () => {
  const calls = {};
  const response = await call('convert', { client: fakeClient(calls), body: { voiceId: 'premadeVoice01', audio: pcm } });
  assert.equal(response.headers['content-type'], 'audio/mpeg');
  assert.deepEqual([...response.ended], [1, 2, 3]);
  assert.equal(calls.convert.voiceId, 'premadeVoice01');
  assert.equal(calls.convert.request.fileFormat, 'pcm_s16le_16');
  assert.equal(calls.convert.request.audio.data.length, 3200);
});

test('conversion and deletion reject other accounts\' voices and oversized audio', async () => {
  assert.equal((await call('convert', { body: { voiceId: 'otherVoice0001', audio: pcm } })).statusCode, 404);
  assert.equal((await call('convert', { body: { voiceId: 'premadeVoice01', audio: Buffer.alloc(16000 * 2 * 16).toString('base64') } })).statusCode, 400);
  assert.equal((await call('convert', { body: { voiceId: '../bad', audio: pcm } })).statusCode, 400);
  assert.equal((await call('delete', { body: { voiceId: 'premadeVoice01' } })).statusCode, 403);
  const calls = {};
  assert.equal((await call('delete', { client: fakeClient(calls), body: { voiceId: 'ownerVoice0001' } })).body.deleted, true);
  assert.equal(calls.deleted, 'ownerVoice0001');
});

test('provider failures become safe user messages', () => {
  assert.equal(describeElevenLabsError({ statusCode: 401 }).status, 503);
  assert.equal(describeElevenLabsError({ statusCode: 429 }).status, 429);
  assert.match(describeElevenLabsError({ statusCode: 400, body: { detail: { status: 'voice_limit_reached' } } }).error, /library is full/);
  assert.equal(normalizeVoiceName('  '), 'My voice');
});

test('account problems are explained precisely and marked fatal so live conversion stops', () => {
  const cases = [
    [{ statusCode: 401, body: { detail: { status: 'detected_unusual_activity', message: 'Free Tier usage disabled' } } }, /free plan/, 'detected_unusual_activity'],
    [{ statusCode: 401, body: { detail: { status: 'missing_permissions', message: 'The API key is missing the permission speech_to_speech' } } }, /Speech to Speech/, 'missing_permissions'],
    [{ statusCode: 401, body: { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota' } } }, /no credits left/, 'quota_exceeded'],
    [{ statusCode: 401, body: { detail: { status: 'invalid_api_key' } } }, /ELEVENLABS_API_KEY/, 'invalid_api_key'],
    [{ statusCode: 401, body: JSON.stringify({ detail: { status: 'missing_permissions' } }) }, /Speech to Speech/, 'missing_permissions'],
  ];
  for (const [error, message, code] of cases) {
    const failure = describeElevenLabsError(error);
    assert.equal(failure.status, 503);
    assert.equal(failure.fatal, true);
    assert.equal(failure.code, code);
    assert.match(failure.error, message);
  }
  assert.equal(describeElevenLabsError({ statusCode: 429 }).fatal, false);
  assert.equal(describeElevenLabsError(new Error('socket hang up')).code, 'network_error');
});

test('conversion failures return the ElevenLabs reason to the app', async () => {
  const client = fakeClient();
  client.speechToSpeech.convert = async () => { throw Object.assign(new Error('Status 401'), { statusCode: 401, body: { detail: { status: 'missing_permissions', message: 'missing speech_to_speech' } } }); };
  const originalWarn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args);
  try {
    const response = await call('convert', { client, body: { voiceId: 'premadeVoice01', audio: pcm } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'missing_permissions');
    assert.equal(response.body.fatal, true);
    assert.match(response.body.error, /Speech to Speech/);
    assert.equal(logged[0][1].code, 'missing_permissions');
  } finally { console.warn = originalWarn; }
});
