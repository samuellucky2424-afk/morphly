import test from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { createVoiceHandler } from '../server/api/voice.ts';
import {
  STS_OPTIMIZE_STREAMING_LATENCY, STS_STREAM_OUTPUT_FORMAT, STS_VOICE_SETTINGS_JSON,
  invalidateVoiceCache, ownerTag, describeElevenLabsError, normalizeVoiceName,
} from '../server/elevenlabs-voice.js';
import {
  MAX_SEGMENT_MS, MP3_PLAYBACK_MIN_BYTES, PhraseAudioBuffer, SILENCE_FLUSH_MS, StreamingMp3Queue,
  readConvertedAudio, shouldFlushLiveSegment,
} from '../src/lib/voice-stream.ts';

const STS_VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.8,
  style: 0,
  use_speaker_boost: true,
};

// The speech-to-speech client puts voiceSettings on the multipart body with
// String(value). Capture that field the way a live stream request would send it.
async function voiceSettingsOnTheWire(request) {
  let form;
  let requestUrl = '';
  const client = new ElevenLabsClient({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (url, init) => {
      requestUrl = String(url);
      form = init.body;
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  await client.speechToSpeech.stream('premadeVoice01', request);
  const field = form.get('voice_settings');
  const encoded = typeof field === 'string' ? field : await field.text();
  const fileFormatField = form.get('file_format');
  const fileFormat = typeof fileFormatField === 'string' ? fileFormatField : await fileFormatField.text();
  return { encoded, requestUrl, fileFormat };
}

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
      convert: async () => { throw new Error('speechToSpeech.convert waits for the whole file'); },
      stream: async (voiceId, request) => {
        calls.stream = { voiceId, request };
        return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
      },
    },
  };
}

function handler(action, { client = fakeClient(), user = 'owner', authError,
  rpc = async name => name === 'voice_session_active' ? { data: { active: true }, error: null } : { data: {}, error: null } } = {}) {
  return createVoiceHandler(action, {
    getClient: () => client,
    admin: () => ({ rpc }),
    auth: async () => authError ? { error: authError, status: 401 } : { user: { id: user } },
  });
}

function createResponse() {
  const chunks = [];
  return {
    headers: {}, statusCode: 200, body: undefined, ended: undefined, chunks,
    headersFlushed: false, writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    write(value) { chunks.push(Buffer.from(value)); return true; },
    flush() { this.flushed = true; },
    flushHeaders() { this.headersFlushed = true; },
    end(value) {
      if (value != null) chunks.push(Buffer.from(value));
      this.writableEnded = true;
      this.ended = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      return this;
    },
  };
}

async function call(action, { method = action === 'voices' ? 'GET' : 'POST', body = {}, ...options } = {}) {
  invalidateVoiceCache();
  const response = createResponse();
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

test('conversion streams 16 kHz PCM with max safe latency settings and a complete MP3 body', async () => {
  const calls = {};
  const response = await call('convert', { client: fakeClient(calls), body: { voiceId: 'premadeVoice01', sessionId: '12345678-1234', audio: pcm },
    rpc: async (name, args) => { calls.billing = { name, args }; return { data: { active: true }, error: null }; } });
  assert.equal(response.headers['content-type'], 'audio/mpeg');
  assert.equal(response.headers['cache-control'], 'no-store, no-transform');
  assert.equal(response.headers['x-accel-buffering'], 'no');
  assert.equal(response.headersFlushed, true);
  // Older clients read the finished body. Streaming must still deliver every byte.
  assert.deepEqual([...response.ended], [1, 2, 3]);
  assert.equal(calls.billing.name, 'voice_session_active');
  assert.equal(calls.billing.args.p_session, 'voice_owner_12345678-1234');
  assert.equal(calls.stream.voiceId, 'premadeVoice01');
  assert.equal(calls.stream.request.fileFormat, 'pcm_s16le_16');
  assert.equal(calls.stream.request.audio.data.length, 3200);
  assert.equal(STS_OPTIMIZE_STREAMING_LATENCY, 3);
  assert.equal(STS_STREAM_OUTPUT_FORMAT, 'mp3_22050_32');
  assert.equal(calls.stream.request.optimizeStreamingLatency, 3);
  assert.equal(calls.stream.request.outputFormat, 'mp3_22050_32');
  assert.equal(calls.stream.request.removeBackgroundNoise, false);
  assert.equal(calls.stream.request.voiceSettings, STS_VOICE_SETTINGS_JSON);
  assert.equal(typeof calls.stream.request.voiceSettings, 'string');
  assert.deepEqual(JSON.parse(STS_VOICE_SETTINGS_JSON), STS_VOICE_SETTINGS);
  const wire = await voiceSettingsOnTheWire(calls.stream.request);
  assert.notEqual(wire.encoded, '[object Object]');
  assert.deepEqual(JSON.parse(wire.encoded), STS_VOICE_SETTINGS);
  const url = new URL(wire.requestUrl);
  assert.match(url.pathname, /\/v1\/voice-changer\/premadeVoice01\/stream$/);
  assert.equal(url.searchParams.get('optimize_streaming_latency'), '3');
  assert.equal(url.searchParams.get('output_format'), 'mp3_22050_32');
  assert.equal(wire.fileFormat, 'pcm_s16le_16');
});

test('conversion writes the first audio chunk before the voice service finishes the phrase', async () => {
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  let sawFirst = () => {};
  const firstWrite = new Promise(resolve => { sawFirst = resolve; });
  const calls = {};
  const client = fakeClient(calls);
  client.speechToSpeech.stream = async (voiceId, request) => {
    calls.stream = { voiceId, request };
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array([9, 8, 7]));
        await gate;
        controller.enqueue(new Uint8Array([6]));
        controller.close();
      },
    });
  };
  invalidateVoiceCache();
  const response = createResponse();
  const originalWrite = response.write.bind(response);
  response.write = (value) => {
    writes += 1;
    if (writes === 1) {
      assert.equal(response.headersFlushed, true);
      sawFirst();
    }
    return originalWrite(value);
  };
  const pending = handler('convert', { client })({
    method: 'POST',
    headers: {},
    body: { voiceId: 'premadeVoice01', sessionId: '12345678-1234', audio: pcm, removeBackgroundNoise: true },
  }, response);
  try {
    await Promise.race([
      firstWrite,
      new Promise((_, reject) => setTimeout(() => reject(new Error('handler buffered the voice stream')), 1000)),
    ]);
    assert.equal(writes, 1);
    assert.deepEqual([...response.chunks[0]], [9, 8, 7]);
    assert.equal(calls.stream.request.removeBackgroundNoise, true);
  } finally {
    release();
    await pending;
  }
  assert.deepEqual([...response.ended], [9, 8, 7, 6]);
});

test('a stream failure after the first byte keeps the audio response instead of JSON', async () => {
  const client = fakeClient();
  client.speechToSpeech.stream = async () => new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      await new Promise(resolve => setTimeout(resolve, 0));
      controller.error(Object.assign(new Error('reset'), { statusCode: 502 }));
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await call('convert', { client, body: { voiceId: 'premadeVoice01', sessionId: '12345678-1234', audio: pcm } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, undefined);
    assert.equal(response.headers['content-type'], 'audio/mpeg');
    assert.deepEqual([...response.ended], [1, 2]);
  } finally {
    console.warn = originalWarn;
  }
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

test('conversion requires an active paid voice session', async () => {
  const client = fakeClient();
  const response = await call('convert', { client, body: { voiceId: 'premadeVoice01', sessionId: '12345678-1234', audio: pcm },
    rpc: async () => ({ data: { active: false }, error: null }) });
  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, 'billing_required');
  assert.equal(response.body.fatal, true);
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
    [{ statusCode: 401, body: { detail: { status: 'invalid_api_key' } } }, /key on the server is invalid/, 'invalid_api_key'],
    [{ statusCode: 401, body: JSON.stringify({ detail: { status: 'missing_permissions' } }) }, /Speech to Speech/, 'missing_permissions'],
    [{ statusCode: 401, body: { detail: { status: 'some_new_reason', message: 'ElevenLabs says no' } } }, /refused this request/, 'some_new_reason'],
    [{ statusCode: 402, body: { detail: { status: 'payment_required', message: 'Upgrade your ElevenLabs plan' } } }, /paid voice service subscription/, 'payment_required'],
    [{ statusCode: 401, body: { detail: { status: 'payment_issue' } } }, /failed or unpaid payment/, 'payment_issue'],
  ];
  for (const [error, message, code] of cases) {
    const failure = describeElevenLabsError(error);
    assert.equal(failure.status, 503);
    assert.equal(failure.fatal, true);
    assert.equal(failure.code, code);
    assert.match(failure.error, message);
    assert.ok(failure.error.endsWith(`(code: ${code})`), 'the reason code is shown for support');
    assert.doesNotMatch(failure.error, /eleven\s*labs/i, 'user-facing text never names the provider');
  }
  assert.doesNotMatch(describeElevenLabsError({ statusCode: 400, body: { detail: { message: 'ElevenLabs rejected audio' } } }).error, /eleven/i);
  assert.equal(describeElevenLabsError({ statusCode: 429 }).fatal, false);
  assert.equal(describeElevenLabsError(new Error('socket hang up')).code, 'network_error');
});

test('live capture flushes sooner than the old 550ms / 6s limits', () => {
  assert.ok(SILENCE_FLUSH_MS < 550);
  assert.ok(MAX_SEGMENT_MS < 6000);
  assert.equal(SILENCE_FLUSH_MS, 400);
  assert.equal(MAX_SEGMENT_MS, 4000);
  assert.equal(shouldFlushLiveSegment(399, 3999), false);
  assert.equal(shouldFlushLiveSegment(400, 100), true);
  assert.equal(shouldFlushLiveSegment(0, 4000), true);
});

test('playback reads and schedules audio before the phrase body is finished', async () => {
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      await gate;
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const seen = [];
  let sawFirst = () => {};
  const firstChunk = new Promise(resolve => { sawFirst = resolve; });
  const pending = readConvertedAudio({ body: stream, arrayBuffer: async () => { throw new Error('full body'); } }, async (chunk) => {
    seen.push([...chunk]);
    if (seen.length === 1) sawFirst();
  });
  try {
    await Promise.race([
      firstChunk,
      new Promise((_, reject) => setTimeout(() => reject(new Error('client waited for the full body')), 1000)),
    ]);
    assert.deepEqual(seen, [[1, 2]]);
  } finally {
    release();
    await pending;
  }
  assert.deepEqual(seen, [[1, 2], [3]]);

  const fallback = [];
  await readConvertedAudio({
    body: null,
    arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer,
  }, chunk => { fallback.push(...chunk); });
  assert.deepEqual(fallback, [4, 5, 6]);

  const starts = [];
  const queue = new StreamingMp3Queue(
    async (bytes) => {
      if (bytes.byteLength < 8) throw new Error('incomplete mp3');
      return { duration: bytes.byteLength / 10 };
    },
    (decoded, offset) => starts.push({ duration: decoded.duration, offset }),
    4,
    0.05,
  );
  await queue.push(new Uint8Array([1, 2]));
  assert.equal(starts.length, 0);
  assert.equal(queue.started, false);
  await queue.push(new Uint8Array([3, 4, 5, 6, 7, 8]));
  assert.equal(queue.started, true);
  assert.deepEqual(starts, [{ duration: 0.8, offset: 0 }]);
  await queue.push(new Uint8Array([9, 10]));
  assert.deepEqual(starts, [{ duration: 0.8, offset: 0 }, { duration: 1, offset: 0.8 }]);
  await queue.close();
  assert.equal(starts.length, 2);

  const tail = [];
  const short = new StreamingMp3Queue(
    async (bytes) => ({ duration: bytes.byteLength / 10 }),
    (decoded, offset) => tail.push({ duration: decoded.duration, offset }),
    MP3_PLAYBACK_MIN_BYTES,
  );
  await short.push(new Uint8Array(10));
  assert.equal(tail.length, 0);
  await short.close();
  assert.deepEqual(tail, [{ duration: 1, offset: 0 }]);

  const phrase = new PhraseAudioBuffer();
  const taken = phrase.take(0);
  phrase.push(Uint8Array.from([7]));
  assert.deepEqual([...(await taken)], [7]);
  phrase.finish();
  assert.equal(await phrase.take(1), null);
});

test('conversion failures return the ElevenLabs reason to the app', async () => {
  const client = fakeClient();
  client.speechToSpeech.stream = async () => { throw Object.assign(new Error('Status 401'), { statusCode: 401, body: { detail: { status: 'missing_permissions', message: 'missing speech_to_speech' } } }); };
  const originalWarn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args);
  try {
    const response = await call('convert', { client, body: { voiceId: 'premadeVoice01', sessionId: '12345678-1234', audio: pcm } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'missing_permissions');
    assert.equal(response.body.fatal, true);
    assert.match(response.body.error, /Speech to Speech/);
    assert.equal(logged[0][1].code, 'missing_permissions');
  } finally { console.warn = originalWarn; }
});
