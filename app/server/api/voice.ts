// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import { randomUUID } from 'node:crypto';
import { rateLimit } from '../request-rate-limit.js';
import {
  CLONE_AUDIO_TYPES, MAX_CLONE_BYTES, MAX_CONVERT_BYTES,
  STS_OPTIMIZE_STREAMING_LATENCY, STS_STREAM_OUTPUT_FORMAT, STS_VOICE_SETTINGS_JSON,
  beginStreamedAudio, canUseVoice, decodeBase64Audio, describeElevenLabsError, elevenLabsErrorDetail, findUsableVoice, getElevenLabsClient,
  getStsModel, invalidateVoiceCache, listAccountVoices, normalizeVoiceName, ownerTag, pipeAudioStream,
  toPublicVoice, voiceOwner,
} from '../elevenlabs-voice.js';

const METHODS = { voices: 'GET', clone: 'POST', convert: 'POST', delete: 'POST', session: 'POST' };
export const VOICE_CREDITS_PER_SECOND = 2;

// Voice sessions are stored per account so one user's id can never address
// another user's billing record.
export function voiceBillingSessionId(userId, clientSessionId) {
  const id = typeof clientSessionId === 'string' ? clientSessionId.trim() : '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
  return `voice_${userId}_${id}`;
}

// Morphly voice changer backed by ElevenLabs. The API key stays on the server;
// every request requires a signed-in, active Morphly account.
export function createVoiceHandler(action, { getClient = getElevenLabsClient, auth = authenticateRequestUser,
  admin = () => supabaseAdmin } = {}) {
  return async function voiceHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== METHODS[action]) return res.status(405).json({ error: 'Method not allowed' });

    const supabase = admin();
    if (!supabase) return res.status(503).json({ error: supabaseAdminConfigError || 'Accounts are not configured' });
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'The voice changer is not configured on this server yet.', code: 'not_configured', fatal: true });

    const context = await auth(req, supabase);
    if (context.error) return res.status(context.status).json({ error: context.error });
    const userId = context.user.id;

    try {
      if (action === 'session') {
        // Start / keep alive (every few seconds) / stop live voice conversion.
        // Billing reserves a few seconds ahead at 2 credits per second (4 in
        // total for seconds that overlap Plus video) and refunds unused time.
        const sessionId = voiceBillingSessionId(userId, req.body?.sessionId);
        if (!sessionId) return res.status(400).json({ error: 'Invalid voice session.' });
        const close = req.body?.close === true;
        const { data, error } = await supabase.rpc('authorize_voice_usage', { p_user: userId, p_session: sessionId, p_close: close });
        if (error) {
          const busy = error.code === '23505';
          return res.status(busy ? 409 : 503).json({ error: busy ? error.message : 'Voice billing is unavailable right now. Try again shortly.',
            code: busy ? 'voice_session_active' : 'billing_unavailable', fatal: true });
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.json({
          closed: Boolean(data.closed),
          outOfCredits: Boolean(data.outOfCredits),
          paidUntilMs: Number(data.startedAtMs) + Number(data.authorizedSeconds) * 1000,
          remainingCredits: data.remainingCredits,
          creditsPerSecond: VOICE_CREDITS_PER_SECOND,
        });
      }

      if (action === 'voices') {
        const voices = (await listAccountVoices(client))
          .filter(voice => canUseVoice(voice, userId))
          .map(voice => toPublicVoice(voice, userId))
          .sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ voices });
      }

      if (action === 'clone') {
        const contentType = String(req.body?.contentType || '').toLowerCase().split(';')[0].trim();
        if (!CLONE_AUDIO_TYPES.includes(contentType)) {
          return res.status(400).json({ error: 'Upload a WAV, MP3, M4A, OGG, WEBM or FLAC voice recording.' });
        }
        const audio = decodeBase64Audio(req.body?.audio, MAX_CLONE_BYTES);
        if (!audio) return res.status(400).json({ error: 'Voice recordings must be 3 MB or smaller.' });
        const name = normalizeVoiceName(req.body?.name);
        const created = await client.voices.ivc.create({
          name,
          description: ownerTag(userId),
          files: [{ data: audio, filename: normalizeVoiceName(req.body?.fileName, 'voice') + '.' + (contentType.split('/')[1] || 'wav'), contentType }],
          removeBackgroundNoise: req.body?.removeBackgroundNoise === true,
        });
        invalidateVoiceCache();
        return res.json({ voice: { id: created.voiceId, name, category: 'cloned', previewUrl: null, own: true },
          requiresVerification: Boolean(created.requiresVerification) });
      }

      const voiceId = typeof req.body?.voiceId === 'string' ? req.body.voiceId.trim() : '';
      if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) return res.status(400).json({ error: 'Choose a voice first.' });
      const voice = await findUsableVoice(client, voiceId, userId);
      if (!voice) return res.status(404).json({ error: 'That voice is not available. Choose another voice.' });

      if (action === 'delete') {
        if (voiceOwner(voice) !== userId) return res.status(403).json({ error: 'You can only delete voices you uploaded.' });
        await client.voices.delete(voiceId);
        invalidateVoiceCache();
        return res.json({ deleted: true });
      }

      // convert: 16 kHz mono 16-bit PCM from the microphone → streamed MP3.
      // There is no flash/turbo speech-to-speech model. The stream endpoint
      // (POST /v1/voice-changer/{voice_id}/stream) plus pcm_s16le_16 input,
      // a low-bitrate MP3, and optimize_streaming_latency 3 is the fastest
      // documented path that still runs the text normalizer.
      const audio = decodeBase64Audio(req.body?.audio, MAX_CONVERT_BYTES);
      if (!audio || audio.length % 2 !== 0) return res.status(400).json({ error: 'Invalid audio segment.' });
      if (!rateLimit(`voice-convert:${userId}`, { limit: 30, windowMs: 10_000 })) {
        return res.status(429).json({ error: 'Too many voice conversions. Wait a moment and try again.', code: 'rate_limited', fatal: false });
      }
      const sessionId = voiceBillingSessionId(userId, req.body?.sessionId);
      const slot = randomUUID();
      const paid = sessionId ? await supabase.rpc('bill_voice_convert', { p_user: userId, p_session: sessionId, p_bytes: audio.length, p_slot: slot }) : null;
      if (paid?.error?.code === 'voice_busy') {
        return res.status(429).json({ error: paid.error.message, code: 'voice_busy', fatal: false });
      }
      if (paid?.error || !paid?.data?.accepted) {
        return res.status(402).json({ error: 'Your voice conversion time is not paid for. Check your credits, then start voice conversion again.',
          code: 'billing_required', fatal: true });
      }
      let stream;
      let streaming = false;
      try {
      stream = await client.speechToSpeech.stream(voiceId, {
        audio: { data: audio, filename: 'speech.pcm', contentType: 'application/octet-stream' },
        fileFormat: 'pcm_s16le_16',
        modelId: getStsModel(),
        outputFormat: STS_STREAM_OUTPUT_FORMAT,
        removeBackgroundNoise: req.body?.removeBackgroundNoise === true,
        optimizeStreamingLatency: STS_OPTIMIZE_STREAMING_LATENCY,
        // speech-to-speech types voice_settings as a JSON string, and
        // @elevenlabs/elevenlabs-js appends that field with String(value).
        // An object becomes "[object Object]", which ElevenLabs rejects
        // (invalid_voice_settings) and leaves the caller with no audio.
        // Keys are the API's snake_case names.
        voiceSettings: STS_VOICE_SETTINGS_JSON,
      });
      // Headers go out before the body so a new client can play the first
      // MP3 bytes while ElevenLabs is still synthesizing the rest. Older
      // clients keep calling this route and decoding the completed MP3.
        beginStreamedAudio(res);
        streaming = true;
        await pipeAudioStream(stream, res);
      } catch (streamError) {
        if (!streaming) throw streamError;
        const detail = elevenLabsErrorDetail(streamError);
        console.warn('[voice] ElevenLabs stream failed after audio started', { action, status: detail.status, code: detail.code, message: detail.message });
        if (!res.writableEnded && typeof res.end === 'function') {
          try { res.end(); } catch { /* the response is already closed */ }
        }
      } finally {
        await supabase.rpc('release_voice_convert', { p_user: userId, p_session: sessionId, p_slot: slot }).catch(() => {});
      }
      return;
    } catch (error) {
      const failure = describeElevenLabsError(error);
      const detail = elevenLabsErrorDetail(error);
      console.warn('[voice] ElevenLabs request failed', { action, status: detail.status, code: detail.code, message: detail.message });
      return res.status(failure.status).json({ error: failure.error, code: failure.code, fatal: failure.fatal });
    }
  };
}

export default createVoiceHandler;
