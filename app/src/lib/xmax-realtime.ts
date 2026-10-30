// Plus engine: Xmax X2.1 realtime (@xmaxai/web-sdk).
// The browser only ever receives a short-lived temporary key (tk-…) minted by
// /api/start-session with the server-side XMAX_API_KEY; the permanent key never
// reaches client code.
import type { RealtimeMediaStream } from '@xmaxai/web-sdk';

export const XMAX_REALTIME_MODEL = 'x2.1';
export const XMAX_DEFAULT_PROMPT = '视频中角色替换成参考图中角色'; // "Replace the person in the video with the reference character"

export type XmaxConnectionState = 'connecting' | 'connected' | 'generating' | 'disconnected' | 'reconnecting';

export interface XmaxConnectOptions {
  temporaryKey: string;
  /** Data URL or remote URL of the user's reference image. Uploaded to Xmax storage when not already remote. */
  referenceImage: string;
  prompt?: string;
  container?: HTMLElement | null;
  onConnectionChange?: (state: XmaxConnectionState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onFirstFrame?: () => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

export interface XmaxRealtimeSession {
  readonly sessionId: string | null;
  getConnectionState(): XmaxConnectionState;
  setReference(referenceImage: string, prompt?: string): Promise<void>;
  disconnect(): Promise<void>;
}

const mapState = (value: string): XmaxConnectionState => {
  switch (value) {
    case 'Generating': return 'generating';
    case 'Connected': case 'Starting': return 'connected';
    case 'Idle': case 'Disconnecting': return 'disconnected';
    default: return 'connecting';
  }
};

function describeReason(reason: unknown): string {
  if (!reason) return '';
  if (typeof reason === 'string') return reason.slice(0, 120);
  const r = reason as { kind?: unknown; message?: unknown; code?: unknown };
  return [r.kind, r.code, r.message].filter(v => v !== undefined && v !== null && v !== '').map(String).join(': ').slice(0, 160);
}

async function dataUrlToBlob(value: string): Promise<Blob> {
  const response = await fetch(value);
  return response.blob();
}

export async function connectXmaxRealtime(options: XmaxConnectOptions): Promise<XmaxRealtimeSession> {
  if (!options.temporaryKey?.startsWith('tk-')) throw new Error('Plus did not receive a valid temporary session key.');
  const sdk = await import('@xmaxai/web-sdk');
  const client = new sdk.XmaxClient(new sdk.XmaxConfiguration({
    apiKey: options.temporaryKey,
    environment: sdk.XmaxEnvironment.global,
  }));
  const realtime = client.createRealtimeManager(new sdk.RealtimeConfiguration({
    model: sdk.RealtimeModel.x2_1,
    isAdaptiveQualityEnabled: true,
  }));

  let state: XmaxConnectionState = 'connecting';
  let sessionId: string | null = null;
  let closed = false;
  let firstFrame = false;
  let hasProgressed = false;
  let lastReason = '';
  let localStream: RealtimeMediaStream | null = null;
  let view: InstanceType<typeof sdk.XmaxRealtimeDualVideoView> | null = null;
  const setState = (next: XmaxConnectionState) => {
    if (closed && next !== 'disconnected') return;
    if (next === state) return;
    state = next;
    options.onConnectionChange?.(next);
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    try { await realtime.close(); } catch { /* already closed */ }
    try { view?.detach?.(); } catch { /* ignore */ }
    setState('disconnected');
  };
  options.signal?.addEventListener('abort', () => { void close(); }, { once: true });

  const resolveReference = async (image: string): Promise<string> => {
    if (/^https:\/\//i.test(image)) return image;
    const blob = await dataUrlToBlob(image);
    const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
    const stored = await client.createStorageService().uploadImage({
      data: blob, fileName: `morphly-reference.${extension}`, contentType: blob.type || 'image/jpeg',
    });
    return stored.url;
  };

  try {
    await realtime.setStateListener((snapshot) => {
      if (snapshot.sessionID) sessionId = snapshot.sessionID;
      let next = mapState(String(snapshot.connectionState));
      // The SDK reports Idle before connecting; only treat Idle/Disconnecting as an
      // end once the session has actually progressed past connecting.
      if (next === 'disconnected' && !hasProgressed && !closed) next = 'connecting';
      if (next === 'connected' || next === 'generating') hasProgressed = true;
      if (next === 'disconnected' && snapshot.reason) lastReason = describeReason(snapshot.reason);
      if (next === 'generating' && !firstFrame) { firstFrame = true; options.onFirstFrame?.(); }
      if (next === 'disconnected' && !closed) {
        options.onError?.(new Error(`Plus video service ended the session${lastReason ? ` (${lastReason})` : ''}. You were not charged; please try again.`));
      }
      setState(next);
    });

    const referencePath = await resolveReference(options.referenceImage);
    localStream = await realtime.createLocalCameraStream({
      preset: sdk.RealtimeCameraPreset.resolution1920x1080,
      position: sdk.CameraPosition.front,
      useMicrophone: false,
    });
    if (options.container) {
      view = new sdk.XmaxRealtimeDualVideoView();
      view.attach(options.container);
      view.localTrack = localStream.videoTrack;
    }
    const remoteStream = await realtime.startGeneration({
      localStream,
      context: new sdk.RealtimeContext({ prompt: options.prompt || XMAX_DEFAULT_PROMPT, referencePath }),
    });
    if (view) view.remoteTrack = remoteStream.videoTrack;
    const track = remoteStream.videoTrack?.mediaStreamTrack;
    if (track) options.onRemoteStream?.(new MediaStream([track]));
  } catch (error) {
    await close();
    throw error instanceof Error ? error : new Error('Plus could not start generation.');
  }

  return {
    get sessionId() { return sessionId; },
    getConnectionState: () => state,
    setReference: async (image, prompt) => {
      // Reuses the current camera stream; startGeneration updates conditions on an active task.
      if (!localStream || closed) return;
      const referencePath = await resolveReference(image);
      await realtime.startGeneration({
        localStream: localStream as RealtimeMediaStream,
        context: new sdk.RealtimeContext({ prompt: prompt || XMAX_DEFAULT_PROMPT, referencePath }),
      });
    },
    disconnect: close,
  };
}
