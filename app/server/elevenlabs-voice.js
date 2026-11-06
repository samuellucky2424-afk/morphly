// @ts-nocheck
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

// Voices uploaded from Morphly live in the shared ElevenLabs account. Each one
// is tagged with its owner so a user's cloned voice is never listed for, or
// usable by, another Morphly account. Voices added in the ElevenLabs dashboard
// (untagged) and premade voices are available to everyone.
const OWNER_TAG_PREFIX = 'morphly-owner:';
const VOICE_CACHE_MS = 60_000;
export const DEFAULT_STS_MODEL = 'eleven_multilingual_sts_v2';
// Speech-to-speech has no flash/turbo model. Level 3 is the strongest
// optimize_streaming_latency setting that keeps the text normalizer on.
// Level 4 is slightly faster and can mispronounce numbers and dates.
export const STS_OPTIMIZE_STREAMING_LATENCY = 3;
// Smallest MP3 the voice-changer stream accepts. Lower bitrate starts
// playback sooner than mp3_44100_128; the bytes stay a normal MP3 so older
// desktop clients can still decode the finished body.
export const STS_STREAM_OUTPUT_FORMAT = 'mp3_22050_32';
export const STS_STREAM_CONTENT_TYPE = 'audio/mpeg';
export const STS_VOICE_SETTINGS_JSON = JSON.stringify({
  stability: 0.45,
  similarity_boost: 0.8,
  style: 0,
  use_speaker_boost: true,
});
export const MAX_CLONE_BYTES = 3 * 1024 * 1024; // keeps base64 JSON under Vercel's 4.5 MB body limit
export const MAX_CONVERT_BYTES = 16000 * 2 * 15; // 15 s of 16 kHz mono 16-bit PCM
export const CLONE_AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/x-flac'];

export function getElevenLabsApiKey(env = process.env) {
  return env.ELEVENLABS_API_KEY?.trim() || null;
}

export function getStsModel(env = process.env) {
  return env.ELEVENLABS_STS_MODEL?.trim() || DEFAULT_STS_MODEL;
}

let cachedClient = null;
let cachedKey = null;
export function getElevenLabsClient(env = process.env) {
  const apiKey = getElevenLabsApiKey(env);
  if (!apiKey) return null;
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new ElevenLabsClient({ apiKey });
    cachedKey = apiKey;
  }
  return cachedClient;
}

export function ownerTag(userId) {
  return `${OWNER_TAG_PREFIX}${userId}`;
}

export function voiceOwner(voice) {
  const description = typeof voice?.description === 'string' ? voice.description.trim() : '';
  return description.startsWith(OWNER_TAG_PREFIX) ? description.slice(OWNER_TAG_PREFIX.length) : null;
}

export function canUseVoice(voice, userId) {
  const owner = voiceOwner(voice);
  return owner === null || owner === userId;
}

export function toPublicVoice(voice, userId) {
  const voiceId = voice.voiceId ?? voice.voice_id;
  return {
    id: voiceId,
    name: voice.name || 'Untitled voice',
    category: voice.category || null,
    previewUrl: voice.previewUrl ?? voice.preview_url ?? null,
    own: voiceOwner(voice) === userId,
  };
}

let voiceCache = { at: 0, voices: [] };
export function invalidateVoiceCache() {
  voiceCache = { at: 0, voices: [] };
}

export async function listAccountVoices(client, { now = Date.now() } = {}) {
  if (voiceCache.voices.length && now - voiceCache.at < VOICE_CACHE_MS) return voiceCache.voices;
  const voices = [];
  let nextPageToken;
  for (let page = 0; page < 10; page += 1) {
    const response = await client.voices.search({ pageSize: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    voices.push(...(response.voices || []));
    if (!response.hasMore || !response.nextPageToken) break;
    nextPageToken = response.nextPageToken;
  }
  voiceCache = { at: now, voices };
  return voices;
}

export async function findUsableVoice(client, voiceId, userId) {
  const cached = voiceCache.voices.find(voice => (voice.voiceId ?? voice.voice_id) === voiceId);
  const voice = cached || await client.voices.get(voiceId).catch(() => null);
  return voice && canUseVoice(voice, userId) ? voice : null;
}

export function decodeBase64Audio(value, maxBytes) {
  if (typeof value !== 'string' || !value) return null;
  const base64 = value.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > maxBytes) return null;
  return buffer;
}

export function normalizeVoiceName(value, fallback = 'My voice') {
  const name = typeof value === 'string' ? value.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
  return (name || fallback).slice(0, 80);
}

function toAudioBuffer(chunk) {
  if (!chunk) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(chunk);
}

export async function readStream(stream) {
  if (Buffer.isBuffer(stream) || stream instanceof Uint8Array) return Buffer.from(stream);
  if (stream instanceof ArrayBuffer) return Buffer.from(stream);
  const chunks = [];
  if (typeof stream?.getReader === 'function') {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = toAudioBuffer(value);
        if (buffer.length) chunks.push(buffer);
      }
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
  } else {
    for await (const chunk of stream) {
      const buffer = toAudioBuffer(chunk);
      if (buffer.length) chunks.push(buffer);
    }
  }
  return Buffer.concat(chunks);
}

// Send headers immediately so proxies and the browser do not wait for the
// whole voice-changer body before the first byte can be played.
export function beginStreamedAudio(res, contentType = STS_STREAM_CONTENT_TYPE) {
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

// Forward each upstream chunk as it arrives. Clients that still read the
// finished body (arrayBuffer / decodeAudioData) receive the same bytes; they
// just wait until the last write. When `res.write` is missing, fall back to
// one buffered end() so the response is still a complete audio file.
export async function pipeAudioStream(stream, res) {
  if (typeof res.write !== 'function') {
    res.end(await readStream(stream));
    return;
  }
  const writeChunk = (chunk) => {
    const buffer = toAudioBuffer(chunk);
    if (!buffer.length) return;
    res.write(buffer);
    if (typeof res.flush === 'function') res.flush();
  };
  if (Buffer.isBuffer(stream) || stream instanceof Uint8Array || stream instanceof ArrayBuffer) {
    writeChunk(stream);
    res.end();
    return;
  }
  if (typeof stream?.getReader === 'function') {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writeChunk(value);
      }
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
    res.end();
    return;
  }
  for await (const chunk of stream) writeChunk(chunk);
  res.end();
}

// ElevenLabs errors carry a statusCode and a JSON body with detail.status
// (a machine code such as "missing_permissions") and detail.message.
export function elevenLabsErrorDetail(error) {
  const status = Number(error?.statusCode || error?.status) || null;
  let body = error?.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* plain text */ } }
  const detail = body?.detail ?? body;
  const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : null;
  const code = detail && typeof detail === 'object' ? String(detail.status || detail.code || '') || null : null;
  return { status, code, message: message ? message.slice(0, 300) : null };
}

// `fatal` errors are account/configuration problems: retrying the next phrase
// cannot succeed, so the client stops live conversion and shows the reason.
// User-facing text never names the provider. Every message carries the
// provider's reason code so support can identify the cause; the full provider
// message is written to the server log only.
const brandless = (text) => String(text).replace(/eleven\s*labs/gi, 'voice service');

export function describeElevenLabsError(error) {
  const { status, code, message } = elevenLabsErrorDetail(error);
  const providerCode = code || (status ? `http_${status}` : 'network_error');
  const result = (httpStatus, text, fatal = false) => ({
    status: httpStatus, error: `${brandless(text)} (code: ${providerCode})`, code: providerCode, fatal,
  });
  const text = message || '';
  if (code === 'detected_unusual_activity' || /unusual activity|free tier/i.test(text)) {
    return result(503, 'The voice service account is on a free plan, which cannot be used by Morphly. Upgrade the voice service subscription to a paid plan.', true);
  }
  if (code === 'missing_permissions' || /permission/i.test(text)) {
    return result(503, 'The voice service key is missing the Speech to Speech or Voices permission. Update the key permissions, then try again.', true);
  }
  if (code === 'quota_exceeded' || /quota|credits|character limit/i.test(text)) {
    return result(503, 'The voice service account has no credits left. Add credits or upgrade the subscription, then try again.', true);
  }
  if (code === 'payment_issue') {
    return result(503, 'The voice service subscription has a failed or unpaid payment. Update the payment method or pay the outstanding invoice, then try again.', true);
  }
  if (status === 402 || /payment|subscription|paid[ _]plan|upgrade|\bplan\b/i.test(`${code || ''} ${text}`)) {
    return result(503, 'The voice changer needs a paid voice service subscription. Upgrade the subscription, then try again.', true);
  }
  if (code === 'invalid_api_key' || code === 'api_key_invalid') {
    return result(503, 'The voice service key on the server is invalid. Replace it, then try again.', true);
  }
  if (status === 401) return result(503, 'The voice service refused this request for the current account.', true);
  if (code === 'voice_limit_reached') return result(409, 'The voice library is full. Delete a voice you uploaded, then try again.');
  if (status === 429) return result(429, 'The voice service is busy. Wait a moment, then try again.');
  if (status === 403) return result(503, 'The voice service refused this request for the current account.', true);
  if (status === 400 || status === 422) return result(400, message || 'The voice service rejected this audio.');
  if (status === 404) return result(404, 'That voice is no longer available. Choose another voice.', true);
  return result(502, 'The voice service could not complete the request. Try again.');
}
