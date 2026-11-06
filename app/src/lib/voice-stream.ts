// Phrase capture and streamed-MP3 playback helpers for the live voice changer.
// Kept free of browser and network imports so tests can drive them directly.

// A short pause still ends a phrase, but we no longer wait 550ms, and a
// run-on utterance is sent before the old 6s cap so conversion can start.
export const SILENCE_FLUSH_MS = 400;
export const MAX_SEGMENT_MS = 4000;

// A few MP3 frames at 22.05 kHz / 32 kbps (~200 bytes each). Enough to decode
// a prefix without waiting for the rest of the phrase.
export const MP3_PLAYBACK_MIN_BYTES = 768;
const MP3_PLAYBACK_MIN_SLICE_SECONDS = 0.045;

export function shouldFlushLiveSegment(silenceMs: number, durationMs: number): boolean {
  return silenceMs >= SILENCE_FLUSH_MS || durationMs >= MAX_SEGMENT_MS;
}

export function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

type DecodedAudio = { duration: number };

// Reads a voice-convert response as it arrives. Falls back to the full body
// when the runtime has no stream reader, which is what older callers do.
export async function readConvertedAudio(
  response: { body?: ReadableStream<Uint8Array> | null; arrayBuffer: () => Promise<ArrayBuffer> },
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
): Promise<void> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.byteLength) await onChunk(all);
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.byteLength) await onChunk(value);
    }
  } finally {
    if (typeof reader.releaseLock === 'function') reader.releaseLock();
  }
}

// Bytes for one phrase. The player can pull chunks before the request finishes.
export class PhraseAudioBuffer {
  private chunks: Uint8Array[] = [];
  private closed = false;
  private failed: Error | null = null;
  private waiting: (() => void) | null = null;

  push(chunk: Uint8Array) {
    if (this.closed || !chunk?.byteLength) return;
    this.chunks.push(chunk.slice());
    this.wake();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  fail(error: Error) {
    if (this.closed) {
      this.failed ??= error;
      return;
    }
    this.failed = error;
    this.closed = true;
    this.wake();
  }

  async take(index: number): Promise<Uint8Array | null> {
    while (index >= this.chunks.length && !this.closed) {
      await new Promise<void>(resolve => { this.waiting = resolve; });
    }
    if (index < this.chunks.length) return this.chunks[index];
    if (this.failed) throw this.failed;
    return null;
  }

  private wake() {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.();
  }
}

// Decodes the MP3 gathered so far and asks the caller to schedule only the
// new tail. Decode errors on a short prefix wait for more bytes; a failure
// of the finished file is raised so the phrase can be retried.
export class StreamingMp3Queue<T extends DecodedAudio> {
  started = false;
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private scheduled = 0;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly decode: (bytes: Uint8Array) => Promise<T>;
  private readonly start: (decoded: T, offsetSeconds: number) => void;
  private readonly minBytes: number;
  private readonly minSliceSeconds: number;

  constructor(
    decode: (bytes: Uint8Array) => Promise<T>,
    start: (decoded: T, offsetSeconds: number) => void,
    minBytes = MP3_PLAYBACK_MIN_BYTES,
    minSliceSeconds = MP3_PLAYBACK_MIN_SLICE_SECONDS,
  ) {
    this.decode = decode;
    this.start = start;
    this.minBytes = minBytes;
    this.minSliceSeconds = minSliceSeconds;
  }

  push(chunk: Uint8Array): Promise<void> {
    if (!chunk?.byteLength || this.closed) return Promise.resolve();
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
    return this.run(() => this.drain());
  }

  close(): Promise<void> {
    this.closed = true;
    return this.run(() => this.drain());
  }

  private run(task: () => Promise<void>): Promise<void> {
    const result = this.chain.then(task, task);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async drain(): Promise<void> {
    if (!this.closed && this.byteLength < this.minBytes) return;
    if (!this.byteLength) return;
    const bytes = concatUint8(this.chunks);
    let decoded: T;
    try {
      decoded = await this.decode(bytes);
    } catch (error) {
      if (this.closed) throw error;
      return;
    }
    const duration = decoded?.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      if (this.closed) throw new Error('Converted audio was empty.');
      return;
    }
    const minSlice = this.closed ? 0.005 : this.minSliceSeconds;
    if (duration <= this.scheduled + minSlice) return;
    const offset = this.scheduled;
    this.start(decoded, offset);
    this.scheduled = duration;
    this.started = true;
  }
}
