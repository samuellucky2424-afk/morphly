// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import {
  CLONE_AUDIO_TYPES, MAX_CLONE_BYTES, MAX_CONVERT_BYTES,
  canUseVoice, decodeBase64Audio, describeElevenLabsError, findUsableVoice, getElevenLabsClient,
  getStsModel, invalidateVoiceCache, listAccountVoices, normalizeVoiceName, ownerTag, readStream,
  toPublicVoice, voiceOwner,
} from '../elevenlabs-voice.js';

const METHODS = { voices: 'GET', clone: 'POST', convert: 'POST', delete: 'POST' };

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
    if (!client) return res.status(503).json({ error: 'The voice changer is not configured on this server yet.' });

    const context = await auth(req, supabase);
    if (context.error) return res.status(context.status).json({ error: context.error });
    const userId = context.user.id;

    try {
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

      // convert: 16 kHz mono 16-bit PCM from the microphone → converted MP3.
      const audio = decodeBase64Audio(req.body?.audio, MAX_CONVERT_BYTES);
      if (!audio || audio.length % 2 !== 0) return res.status(400).json({ error: 'Invalid audio segment.' });
      const stream = await client.speechToSpeech.convert(voiceId, {
        audio: { data: audio, filename: 'speech.pcm', contentType: 'application/octet-stream' },
        fileFormat: 'pcm_s16le_16',
        modelId: getStsModel(),
        outputFormat: 'mp3_44100_128',
        removeBackgroundNoise: req.body?.removeBackgroundNoise === true,
        optimizeStreamingLatency: 3,
      });
      const converted = await readStream(stream);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 200;
      return res.end(converted);
    } catch (error) {
      const failure = describeElevenLabsError(error);
      console.warn('[voice] ElevenLabs request failed', { action, status: error?.statusCode || null });
      return res.status(failure.status).json({ error: failure.error });
    }
  };
}

export default createVoiceHandler;
