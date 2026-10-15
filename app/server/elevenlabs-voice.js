// @ts-nocheck
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

// Voices uploaded from Morphly live in the shared ElevenLabs account. Each one
// is tagged with its owner so a user's cloned voice is never listed for, or
// usable by, another Morphly account. Voices added in the ElevenLabs dashboard
// (untagged) and premade voices are available to everyone.
const OWNER_TAG_PREFIX = 'morphly-owner:';
const VOICE_CACHE_MS = 60_000;
export const DEFAULT_STS_MODEL = 'eleven_multilingual_sts_v2';
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

export async function readStream(stream) {
  if (Buffer.isBuffer(stream) || stream instanceof Uint8Array) return Buffer.from(stream);
  if (stream instanceof ArrayBuffer) return Buffer.from(stream);
  const chunks = [];
  if (typeof stream?.getReader === 'function') {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } else {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
export function describeElevenLabsError(error) {
  const { status, code, message } = elevenLabsErrorDetail(error);
  const providerCode = code || (status ? `http_${status}` : 'network_error');
  const result = (httpStatus, text, fatal = false) => ({ status: httpStatus, error: text, code: providerCode, fatal });
  if (code === 'detected_unusual_activity' || /unusual activity|free tier usage disabled/i.test(message || '')) {
    return result(503, 'ElevenLabs blocked this request: its free plan cannot be used from a server. Upgrade the ElevenLabs account to a paid plan (Starter or higher).', true);
  }
  if (code === 'missing_permissions' || /permission/i.test(message || '')) {
    return result(503, 'The ElevenLabs API key is missing a permission. In ElevenLabs → API keys, enable "Speech to Speech" and "Voices" (read and write), then try again.', true);
  }
  if (code === 'quota_exceeded' || /quota|credits/i.test(message || '')) {
    return result(503, 'The ElevenLabs account has no credits left. Add credits or upgrade the plan, then try again.', true);
  }
  if (code === 'invalid_api_key' || status === 401) {
    return result(503, 'ElevenLabs rejected the server API key. Check ELEVENLABS_API_KEY on the server.', true);
  }
  if (code === 'voice_limit_reached') return result(409, 'The voice library is full. Delete a voice you uploaded, then try again.');
  if (status === 402 || code === 'payment_required' || code === 'paid_plan_required') {
    return result(503, message || 'This ElevenLabs feature needs a paid ElevenLabs plan.', true);
  }
  if (status === 429) return result(429, 'The voice service is busy. Wait a moment, then try again.');
  if (status === 403) return result(503, message || 'ElevenLabs refused this request for the current account.', true);
  if (status === 400 || status === 422) return result(400, message || 'The voice service rejected this audio.');
  if (status === 404) return result(404, 'That voice is no longer available. Choose another voice.', true);
  return result(502, 'The voice service could not complete the request. Try again.');
}
