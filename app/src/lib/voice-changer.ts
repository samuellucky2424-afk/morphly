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

async function convertSegment(voiceId: string, pcm: Int16Array, removeBackgroundNoise: boolean, signal: AbortSignal) {
  const response = await apiFetchWithAuth('/voice-convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceId, removeBackgroundNoise, audio: toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) }),
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
  onStats: (stats: LiveVoiceStats) => void;
  onError: (message: string) => void;
  /** Account or configuration failure: conversion has stopped. */
  onFatal: (message: string) => void;
};

type AudioContextWithSink = AudioContext & { setSinkId?: (id: string) => Promise<void> };

function downsample(input: Float32Array, sourceRate: number): Int16Array {
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function concat(chunks: Int16Array[]): Int16Array {
  const output = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
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
  private preRoll: Int16Array[] = [];
  private segment: Int16Array[] = [];
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

  constructor(options: LiveVoiceOptions) {
    this.options = options;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.options.inputDeviceId ? { exact: this.options.inputDeviceId } : undefined,
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
    });
    this.playbackContext = new AudioContext() as AudioContextWithSink;
    if (this.options.outputDeviceId && this.options.outputDeviceId !== 'default') {
      if (!this.playbackContext.setSinkId) throw new Error('This app version cannot choose an audio output. Update Morphly.');
      await this.playbackContext.setSinkId(this.options.outputDeviceId);
    }
    this.captureContext = new AudioContext();
    const source = this.captureContext.createMediaStreamSource(this.stream);
    this.processor = this.captureContext.createScriptProcessor(2048, 1, 1);
    const sampleRate = this.captureContext.sampleRate;
    this.processor.onaudioprocess = (event) => this.handleAudio(event.inputBuffer.getChannelData(0), sampleRate);
    // A muted gain keeps the processor running without echoing the microphone.
    const mute = this.captureContext.createGain();
    mute.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(mute);
    mute.connect(this.captureContext.destination);
    this.emit();
  }

  async stop() {
    this.stopped = true;
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
    const pcm = downsample(samples, sampleRate);
    const speaking = rms > Math.max(0.012, this.noiseFloor * 3);
    if (!speaking) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;

    if (!this.segment.length) {
      this.preRoll.push(pcm);
      while (this.preRoll.length * blockMs > PRE_ROLL_MS) this.preRoll.shift();
      if (!speaking) return;
      this.segment = [...this.preRoll];
      this.preRoll = [];
      this.speechMs = 0;
      this.silenceMs = 0;
      if (!this.stats.listening) { this.stats.listening = true; this.emit(); }
      return;
    }

    this.segment.push(pcm);
    if (speaking) { this.speechMs += blockMs; this.silenceMs = 0; } else { this.silenceMs += blockMs; }
    const durationMs = this.segment.length * blockMs;
    if (this.silenceMs >= SILENCE_FLUSH_MS || durationMs >= MAX_SEGMENT_MS) this.flush();
  }

  private flush() {
    const segment = this.segment;
    const speechMs = this.speechMs;
    this.segment = [];
    this.stats.listening = false;
    if (speechMs < MIN_SPEECH_MS) { this.emit(); return; }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.options.onError('Your connection is too slow for live conversion; a phrase was skipped.');
      this.emit();
      return;
    }
    const id = this.sequence++;
    void this.convert(id, concat(segment));
  }

  private async convert(id: number, pcm: Int16Array) {
    this.inFlight += 1;
    this.emit();
    const startedAt = performance.now();
    let decoded: AudioBuffer | null = null;
    try {
      const mp3 = await convertSegment(this.options.voiceId, pcm, this.options.removeBackgroundNoise, this.abort.signal);
      if (this.stopped || !this.playbackContext) return;
      decoded = await this.playbackContext.decodeAudioData(mp3);
      this.stats.phrases += 1;
      this.stats.lastLatencyMs = Math.round(performance.now() - startedAt);
    } catch (error) {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : 'Voice conversion failed.';
      if (error instanceof VoiceServiceError && error.fatal) {
        void this.stop();
        this.options.onFatal(message);
        return;
      }
      this.options.onError(message);
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
