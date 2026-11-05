import { apiFetchWithAuth } from './api-client';

export type VoiceOption = {
  id: string;
  name: string;
  category: string | null;
  previewUrl: string | null;
  own: boolean;
};

export const MAX_VOICE_UPLOAD_BYTES = 3 * 1024 * 1024;
const TARGET_SAMPLE_RATE = 16000;
const MAX_SEGMENT_MS = 6000;
const SILENCE_FLUSH_MS = 550;
const PRE_ROLL_MS = 250;
const MIN_SPEECH_MS = 350;
const MAX_IN_FLIGHT = 3;

const EXTENSION_TYPES: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac',
};
export const VOICE_UPLOAD_ACCEPT = Object.keys(EXTENSION_TYPES).map(extension => `.${extension}`).join(',') + ',audio/*';

export class VoiceServiceError extends Error {
  status: number;
  code: string | null;
  fatal: boolean;
  constructor(message: string, status: number, code: string | null, fatal: boolean) {
    super(message);
    this.name = 'VoiceServiceError';
    this.status = status;
    this.code = code;
    this.fatal = fatal;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string; code?: string; fatal?: boolean };
  if (!response.ok) {
    throw new VoiceServiceError(data.error || `Voice request failed (${response.status}).`, response.status,
      data.code ?? null, Boolean(data.fatal) || response.status === 401 || response.status === 403);
  }
  return data;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function uploadContentType(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const fromName = EXTENSION_TYPES[extension];
  if (file.type && file.type.startsWith('audio/')) return file.type === 'audio/x-wav' ? 'audio/wav' : file.type;
  return fromName || null;
}

export async function listVoices(): Promise<VoiceOption[]> {
  const { voices } = await readJson<{ voices: VoiceOption[] }>(await apiFetchWithAuth('/voice-voices'));
  return voices;
}

export async function uploadVoice(file: File, name: string): Promise<VoiceOption> {
  const contentType = uploadContentType(file);
  if (!contentType) throw new Error('Upload a WAV, MP3, M4A, OGG, WEBM or FLAC voice recording.');
  if (file.size > MAX_VOICE_UPLOAD_BYTES) throw new Error('Voice recordings must be 3 MB or smaller.');
  const audio = toBase64(new Uint8Array(await file.arrayBuffer()));
  const { voice } = await readJson<{ voice: VoiceOption }>(await apiFetchWithAuth('/voice-clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, fileName: file.name, contentType, audio }),
  }));
  return voice;
}

export async function deleteVoice(voiceId: string): Promise<void> {
  await readJson(await apiFetchWithAuth('/voice-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceId }),
  }));
}

export const VOICE_CREDITS_PER_SECOND = 2;
const VOICE_BILLING_INTERVAL_MS = 2000;

export type VoiceBillingState = { closed: boolean; outOfCredits: boolean; paidUntilMs: number; remainingCredits: number };

// Starts, renews (reserving a few seconds ahead) or closes the paid voice
// session. The server charges 2 credits per second and refunds unused time.
export async function updateVoiceSession(sessionId: string, close = false): Promise<VoiceBillingState> {
  return readJson<VoiceBillingState>(await apiFetchWithAuth('/voice-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, close }),
    keepalive: close,
  }));
}

async function convertSegment(voiceId: string, sessionId: string, pcm: Int16Array, removeBackgroundNoise: boolean, signal: AbortSignal) {
  const response = await apiFetchWithAuth('/voice-convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceId, sessionId, removeBackgroundNoise, audio: toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) }),
    signal,
  });
  if (!response.ok) await readJson(response);
  return response.arrayBuffer();
}

export type AudioDeviceOption = { id: string; name: string };

export function isVirtualMicrophonePlaybackDevice(name: string) {
  return /\bCABLE(?:-[A-D])? Input\b/i.test(name) || /VB-Audio.+Cable Input/i.test(name);
}

export function isVirtualMicrophoneRecordingDevice(name: string) {
  return /\bCABLE(?:-[A-D])? Output\b/i.test(name) || /VB-Audio.+Cable Output/i.test(name);
}

export async function listAudioDevices({ requestAccess = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) throw new Error('This device does not support audio device selection.');
  let devices = await navigator.mediaDevices.enumerateDevices();
  // Device names stay hidden until microphone access has been granted once.
  if (requestAccess && devices.some(device => device.kind === 'audioinput' && !device.label)) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const named = (kind: MediaDeviceKind) => devices
    .filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'communications')
    .map((device, index) => ({ id: device.deviceId, name: device.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${index + 1}` }));
  const inputs = named('audioinput');
  const physicalInputs = inputs.filter(({ name }) => !isVirtualMicrophoneRecordingDevice(name));
  return {
    inputs: physicalInputs.length ? physicalInputs : inputs,
    outputs: named('audiooutput'),
    virtualMicrophoneReady: named('audiooutput').some(({ name }) => isVirtualMicrophonePlaybackDevice(name))
      && inputs.some(({ name }) => isVirtualMicrophoneRecordingDevice(name)),
    labelsHidden: devices.some(device => device.kind === 'audioinput' && !device.label),
  };
}

export type LiveVoiceStats = { phrases: number; lastLatencyMs: number | null; pending: number; listening: boolean };

export type LiveVoiceOptions = {
  voiceId: string;
  inputDeviceId: string;
  outputDeviceId: string;
  removeBackgroundNoise: boolean;
  /** Browser echoCancellation / noiseSuppression / autoGainControl. Off by default for clearer STS input. */
  micProcessing?: boolean;
  onStats: (stats: LiveVoiceStats) => void;
  onError: (message: string) => void;
  /** Account or configuration failure: conversion has stopped. */
  onFatal: (message: string) => void;
  /** Latest wallet balance after each billing update. */
  onCredits?: (credits: number) => void;
};

type AudioContextWithSink = AudioContext & { setSinkId?: (id: string) => Promise<void> };

function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

// Mild peak normalize / soft limit so quiet clones stay audible.
function normalizePlaybackBuffer(buffer: AudioBuffer): AudioBuffer {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) peak = Math.max(peak, Math.abs(data[index]));
  }
  if (peak === 0) return buffer;
  const target = 0.89;
  let gain = 1;
  if (peak > target) gain = target / peak;
  else if (peak < 0.25) gain = Math.min(2.2, target / peak);
  if (Math.abs(gain - 1) < 0.05) return buffer;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      const sample = data[index] * gain;
      data[index] = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    }
  }
  return buffer;
}

// OfflineAudioContext resamples with the browser's quality path (anti-aliased)
// instead of a crude box-average downsample that dulls consonants.
async function resampleToPcm16(input: Float32Array, sourceRate: number): Promise<Int16Array> {
  if (!input.length) return new Int16Array(0);
  if (Math.abs(sourceRate - TARGET_SAMPLE_RATE) < 1) return floatToInt16(input);
  const frameCount = Math.max(1, Math.ceil(input.length * TARGET_SAMPLE_RATE / sourceRate));
  const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const buffer = offline.createBuffer(1, input.length, sourceRate);
  buffer.copyToChannel(input.slice(), 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return floatToInt16(rendered.getChannelData(0));
}

function concatFloat(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

// ElevenLabs speech-to-speech converts whole utterances, so the live changer
// detects phrases on the microphone, converts each one, and plays results in
// order on the selected output (normally VB-CABLE "CABLE Input").
export class LiveVoiceChanger {
  private options: LiveVoiceOptions;
  private stream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private playbackContext: AudioContextWithSink | null = null;
  private processor: ScriptProcessorNode | null = null;
  private abort = new AbortController();
  private preRoll: Float32Array[] = [];
  private segment: Float32Array[] = [];
  private captureSampleRate = TARGET_SAMPLE_RATE;
  private speechMs = 0;
  private silenceMs = 0;
  private noiseFloor = 0.004;
  private sequence = 0;
  private nextToPlay = 0;
  private finished = new Map<number, AudioBuffer | null>();
  private inFlight = 0;
  private playAt = 0;
  private stats: LiveVoiceStats = { phrases: 0, lastLatencyMs: null, pending: 0, listening: false };
  private stopped = false;
  private sessionId = crypto.randomUUID();
  private billingTimer: ReturnType<typeof setInterval> | null = null;
  private billingFailures = 0;
  private sessionOpen = false;

  constructor(options: LiveVoiceOptions) {
    this.options = options;
  }

  private applyBilling(state: VoiceBillingState) {
    if (Number.isFinite(state.remainingCredits)) this.options.onCredits?.(Math.floor(state.remainingCredits));
    if (state.outOfCredits) {
      void this.stop();
      this.options.onFatal(`You have run out of credits. The voice changer costs ${VOICE_CREDITS_PER_SECOND} credits per second; buy more credits to continue.`);
    }
  }

  private async renewBilling() {
    if (this.stopped) return;
    try {
      this.applyBilling(await updateVoiceSession(this.sessionId));
      this.billingFailures = 0;
    } catch (error) {
      if (this.stopped) return;
      this.billingFailures += 1;
      // A brief network blip is tolerated; paid time covers ~5 seconds.
      if ((error instanceof VoiceServiceError && error.fatal) || this.billingFailures >= 3) {
        void this.stop();
        this.options.onFatal(error instanceof Error ? error.message : 'Voice billing failed.');
      }
    }
  }

  async start() {
    // Pay for the first seconds before the microphone opens.
    const initial = await updateVoiceSession(this.sessionId);
    this.sessionOpen = true;
    if (initial.outOfCredits) {
      await this.stop();
      throw new Error(`Not enough credits. The voice changer costs ${VOICE_CREDITS_PER_SECOND} credits per second.`);
    }
    this.applyBilling(initial);
    this.billingTimer = setInterval(() => void this.renewBilling(), VOICE_BILLING_INTERVAL_MS);
    // Browser mic "cleaning" muddies speech-to-speech. Keep it off unless the
    // user opts in. Never stack browser noiseSuppression with ElevenLabs denoise.
    const micProcessing = this.options.micProcessing === true;
    const removeNoise = this.options.removeBackgroundNoise === true;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.options.inputDeviceId ? { exact: this.options.inputDeviceId } : undefined,
        channelCount: 1,
        echoCancellation: micProcessing,
        noiseSuppression: micProcessing && !removeNoise,
        autoGainControl: micProcessing,
      },
    });
    this.playbackContext = new AudioContext() as AudioContextWithSink;
    if (this.options.outputDeviceId && this.options.outputDeviceId !== 'default') {
      if (!this.playbackContext.setSinkId) throw new Error('This app version cannot choose an audio output. Update Morphly.');
      await this.playbackContext.setSinkId(this.options.outputDeviceId);
    }
    this.captureContext = new AudioContext();
    await Promise.all([this.playbackContext.resume(), this.captureContext.resume()]);
    if (this.playbackContext.state === 'suspended' || this.captureContext.state === 'suspended') {
      throw new Error('Audio is blocked in this window. Click Start voice conversion again after clicking inside Morphly, or allow sound for this app in your browser or system settings.');
    }
    const source = this.captureContext.createMediaStreamSource(this.stream);
    this.processor = this.captureContext.createScriptProcessor(2048, 1, 1);
    this.captureSampleRate = this.captureContext.sampleRate;
    this.processor.onaudioprocess = (event) => this.handleAudio(event.inputBuffer.getChannelData(0), this.captureSampleRate);
    // A muted gain keeps the processor running without echoing the microphone.
    const mute = this.captureContext.createGain();
    mute.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(mute);
    mute.connect(this.captureContext.destination);
    this.emit();
  }

  async stop() {
    const wasStopped = this.stopped;
    this.stopped = true;
    if (this.billingTimer) clearInterval(this.billingTimer);
    this.billingTimer = null;
    // Close the paid session once so unused reserved seconds are refunded.
    if (!wasStopped && this.sessionOpen) {
      this.sessionOpen = false;
      void updateVoiceSession(this.sessionId, true)
        .then(state => { if (Number.isFinite(state.remainingCredits)) this.options.onCredits?.(Math.floor(state.remainingCredits)); })
        .catch(() => { /* The server closes abandoned sessions after 30 seconds. */ });
    }
    this.abort.abort();
    this.processor?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    await Promise.allSettled([this.captureContext?.close(), this.playbackContext?.close()]);
    this.stream = null;
    this.captureContext = null;
    this.playbackContext = null;
  }

  private emit() {
    this.options.onStats({ ...this.stats, pending: this.inFlight });
  }

  private handleAudio(samples: Float32Array, sampleRate: number) {
    if (this.stopped) return;
    let energy = 0;
    for (let index = 0; index < samples.length; index += 1) energy += samples[index] * samples[index];
    const rms = Math.sqrt(energy / samples.length);
    const blockMs = (samples.length / sampleRate) * 1000;
    // Copy: ScriptProcessor reuses the underlying buffer between callbacks.
    const frame = samples.slice();
    const speaking = rms > Math.max(0.012, this.noiseFloor * 3);
    if (!speaking) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;

    if (!this.segment.length) {
      this.preRoll.push(frame);
      while (this.preRoll.length * blockMs > PRE_ROLL_MS) this.preRoll.shift();
      if (!speaking) return;
      this.segment = [...this.preRoll];
      this.preRoll = [];
      this.speechMs = 0;
      this.silenceMs = 0;
      if (!this.stats.listening) { this.stats.listening = true; this.emit(); }
      return;
    }

    this.segment.push(frame);
    if (speaking) { this.speechMs += blockMs; this.silenceMs = 0; } else { this.silenceMs += blockMs; }
    const durationMs = this.segment.length * blockMs;
    if (this.silenceMs >= SILENCE_FLUSH_MS || durationMs >= MAX_SEGMENT_MS) this.flush();
  }

  private flush() {
    const segment = this.segment;
    const speechMs = this.speechMs;
    const sampleRate = this.captureSampleRate;
    this.segment = [];
    this.stats.listening = false;
    if (speechMs < MIN_SPEECH_MS) { this.emit(); return; }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.options.onError('Your connection is too slow for live conversion; a phrase was skipped.');
      this.emit();
      return;
    }
    const id = this.sequence++;
    void this.convert(id, concatFloat(segment), sampleRate);
  }

  private async convert(id: number, floatSamples: Float32Array, sampleRate: number) {
    this.inFlight += 1;
    this.emit();
    const startedAt = performance.now();
    let decoded: AudioBuffer | null = null;
    let lastMessage = 'Voice conversion failed.';
    try {
      const pcm = await resampleToPcm16(floatSamples, sampleRate);
      if (this.stopped) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const mp3 = await convertSegment(this.options.voiceId, this.sessionId, pcm, this.options.removeBackgroundNoise, this.abort.signal);
          if (this.stopped || !this.playbackContext) return;
          decoded = normalizePlaybackBuffer(await this.playbackContext.decodeAudioData(mp3.slice(0)));
          this.stats.phrases += 1;
          this.stats.lastLatencyMs = Math.round(performance.now() - startedAt);
          lastMessage = '';
          break;
        } catch (error) {
          if (this.stopped) return;
          lastMessage = error instanceof Error ? error.message : 'Voice conversion failed.';
          if (error instanceof VoiceServiceError && error.fatal) {
            void this.stop();
            this.options.onFatal(lastMessage);
            return;
          }
          if (attempt === 0) {
            this.options.onError('Conversion hiccup — retrying that phrase…');
            continue;
          }
          this.options.onError(`Could not convert that phrase after retrying. ${lastMessage}`);
        }
      }
    } catch (error) {
      if (this.stopped) return;
      lastMessage = error instanceof Error ? error.message : 'Voice conversion failed.';
      this.options.onError(lastMessage);
    } finally {
      this.inFlight -= 1;
      this.finished.set(id, decoded);
      this.playReady();
      this.emit();
    }
  }

  private playReady() {
    const context = this.playbackContext;
    while (context && !this.stopped && this.finished.has(this.nextToPlay)) {
      const buffer = this.finished.get(this.nextToPlay);
      this.finished.delete(this.nextToPlay);
      this.nextToPlay += 1;
      if (!buffer) continue;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      this.playAt = Math.max(context.currentTime + 0.02, this.playAt);
      source.start(this.playAt);
      this.playAt += buffer.duration;
    }
  }
}
