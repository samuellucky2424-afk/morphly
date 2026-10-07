import { VIDU_REALTIME_MODEL } from './realtime-provider';
import type { RtcEngine } from 'aliyun-rtc-sdk';

let rtcReadyPromise: Promise<typeof import('aliyun-rtc-sdk')['default']> | null = null;

export function prepareViduRtc() {
  if (!rtcReadyPromise) {
    rtcReadyPromise = import('aliyun-rtc-sdk').then(async ({ default: AliRtcEngine }) => {
      // Load and check the browser before creating a short-lived provider session.
      AliRtcEngine.setLogLevel(AliRtcEngine.AliRtcLogLevel.NONE);
      const support = await AliRtcEngine.isSupported();
      if (!support.support) {
        throw new Error('This browser cannot run Plus video. Use an updated Chrome or Edge.');
      }
      return AliRtcEngine;
    }).catch(error => {
      rtcReadyPromise = null;
      throw error;
    });
  }
  return rtcReadyPromise;
}

export type ViduConnectionState = 'connecting' | 'connected' | 'generating' | 'disconnected' | 'reconnecting';
export interface ViduTransformInput {
  prompt?: string;
  enhance?: boolean;
  image?: Blob | string | null;
  editingType?: 'style_transfer' | 'subject_replacement' | 'background_replacement' | 'virtual_tryon';
}
export interface ViduClientOptions {
  apiKey?: string;
  baseUrl?: string;
  liveId?: string;
  traceId?: string;
  renderUid?: string;
  rtc?: Record<string, unknown> | null;
  maxSeconds?: number;
  expiresAt?: string | null;
  serverNow?: number;
  signal?: AbortSignal;
  modelName?: string;
  mirror?: 'auto' | boolean;
  resolution?: '720p' | '1080p' | '540p';
  onConnectionChange?: (state: ViduConnectionState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onError?: (error: unknown) => void;
}
export interface ViduRealtimeSession {
  sessionId: string;
  getConnectionState: () => ViduConnectionState;
  set: (input: ViduTransformInput) => Promise<void>;
  disconnect: () => Promise<void>;
  on: (event: 'error', handler: (error: unknown) => void) => void;
  off: (event: 'error', handler: (error: unknown) => void) => void;
}

export async function encodeViduReference(image: Blob | string): Promise<string> {
  if (typeof image === 'string') return image;
  if (image.size > 2_000_000) throw new Error('Choose a reference image under 2 MB for Plus.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the Plus reference image.'));
    reader.readAsDataURL(image);
  });
}

export function buildViduSocketUrl(baseUrl: string, liveId: string, connId: string, secret: string): string {
  const url = new URL('/live/ws/live/connect', baseUrl);
  if (url.protocol !== 'https:' || !['api.vidu.com', 'api.vidu.cn'].includes(url.hostname)) {
    throw new Error('Unsupported Plus server address.');
  }
  url.protocol = 'wss:';
  url.search = new URLSearchParams({ live_id: liveId, conn_id: connId, client_secret: secret }).toString();
  return url.toString();
}

export class ViduRealtimeClient {
  private apiKey: string;
  private baseUrl: string;
  constructor(options: { apiKey: string; baseUrl?: string }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.vidu.com';
  }

  async connect(inputStream: MediaStream, options: ViduClientOptions = {}): Promise<ViduRealtimeSession> {
    const liveId = options.liveId;
    const renderUid = options.renderUid;
    const rtc = options.rtc;
    if (!liveId || !renderUid || typeof rtc?.token !== 'string' || typeof rtc.user_id !== 'string'
      || !this.apiKey || this.apiKey.startsWith('mock_') || this.apiKey.startsWith('vda_')) {
      throw new Error('Plus requires real Vidu session credentials. Restart the session.');
    }
    const credentialExpiries = [Number(rtc.token_expire_at) * 1000, Date.parse(options.expiresAt || '')]
      .filter(value => Number.isFinite(value) && value > 0 && value <= 8.64e15);
    const clockOffsetMs = typeof options.serverNow === 'number' && Number.isFinite(options.serverNow)
      ? options.serverNow - Date.now() : 0;
    const credentialDeadline = credentialExpiries.length ? Math.min(...credentialExpiries) - clockOffsetMs : Infinity;
    const credentialsExpired = () => Date.now() >= credentialDeadline;
    const expiredMessage = 'Plus session credentials expired. Start a new session.';
    if (credentialsExpired()) throw new Error(expiredMessage);
    const inputTrack = inputStream.getVideoTracks()[0];
    if (!inputTrack || inputTrack.readyState !== 'live') throw new Error('Plus requires an active camera.');
    const AliRtcEngine = await prepareViduRtc();
    if (options.signal?.aborted) throw new Error('Plus session was cancelled.');
    if (credentialsExpired()) throw new Error(expiredMessage);
    // DEBUG (0) prints join credentials and signed stream URLs to the console.
    // Keep our scoped diagnostics below instead of the SDK's raw transport logs.
    AliRtcEngine.setLogLevel(AliRtcEngine.AliRtcLogLevel.NONE);
    let engine: RtcEngine | null = AliRtcEngine.getInstance();
    const cameraTrack = inputTrack.clone();
    const connId = crypto.randomUUID();
    let socket: WebSocket | null = null;
    let sequence = 1;
    let state: ViduConnectionState = 'connecting';
    let stopped = false;
    let ready = false;
    let cleanupPromise: Promise<void> | null = null;
    let published = false;
    let receivedVideo = false;
    let initRetry: ReturnType<typeof setTimeout> | undefined;
    let socketRetry: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let socketAttempts = 0;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let credentialTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<(error: unknown) => void>();
    let rejectStartup: (error: Error) => void = () => {};
    let resolveInit: () => void = () => {};
    let resolveVideo: () => void = () => {};
    const initPromise = new Promise<void>(resolve => { resolveInit = resolve; });
    const videoPromise = new Promise<void>(resolve => { resolveVideo = resolve; });
    const failurePromise = new Promise<never>((_, reject) => { rejectStartup = reject; });
    void failurePromise.catch(() => {});
    const changeState = (next: ViduConnectionState) => {
      state = next;
      options.onConnectionChange?.(next);
    };
    const send = (type: number, payload: Record<string, unknown>) => {
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('Plus signaling connection is closed.');
      socket.send(JSON.stringify({ type, live_id: liveId, conn_id: connId, seq_id: sequence++, payload }));
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      stopped = true;
      clearTimeout(initRetry);
      clearTimeout(socketRetry);
      clearTimeout(handshakeTimer);
      clearTimeout(sessionTimer);
      clearTimeout(credentialTimer);
      clearTimeout(startupTimer);
      window.removeEventListener('pagehide', onPageHide);
      options.signal?.removeEventListener('abort', onAbort);
      // Hang up before any database requests or RTC teardown; this stops provider billing.
      if (socket?.readyState === WebSocket.OPEN) {
        try { send(5, { hangup: { hangup_reason: 'user_hangup' } }); } catch { /* Already closed. */ }
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
      cameraTrack.stop();
      const currentEngine = engine;
      engine = null;
      currentEngine?.removeAllListeners();
      cleanupPromise = Promise.resolve().then(() => currentEngine?.destroy()).catch(() => {});
      return cleanupPromise;
    };
    const fail = (message: string, reason?: string) => {
      if (stopped) return;
      const error = Object.assign(new Error(message), { code: reason === 'ws_handshake_failed' ? 'VIDU_SIGNALING_UNREACHABLE' : undefined });
      console.warn('[Vidu] session diagnostics', JSON.stringify({
        liveId, traceId: options.traceId, reason, initialized: ready,
        published, receivedVideo,
      }));
      rejectStartup(error);
      void cleanup();
      options.onError?.(error);
      for (const listener of listeners) listener(error);
      changeState('disconnected');
    };
    function onAbort() { fail('Plus session was cancelled.'); }
    function onPageHide() { fail('Plus session ended when leaving the page.'); }
    const assertActive = () => { if (stopped) throw new Error('Plus session was cancelled.'); };

    try {
      changeState('connecting');
      window.addEventListener('pagehide', onPageHide);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      startupTimer = setTimeout(() => fail('Plus connection timed out before receiving generated video.'), 35000);
      if (credentialDeadline - Date.now() <= 155000) {
        // Later deadlines cannot be reached within the startup + session duration caps.
        credentialTimer = setTimeout(() => {
          if (credentialsExpired()) fail(expiredMessage, 'credentials_expired');
        }, Math.max(0, credentialDeadline - Date.now()));
      }
      engine.on('videoSubscribeStateChanged', (userId: string, _old: number, next: number) => {
        if (String(userId) !== renderUid || next !== 3 || stopped) return;
        void engine?.getVideoTrack({ userId, streamType: 0 }).then(track => {
          if (!track || stopped) return;
          receivedVideo = true;
          options.onRemoteStream?.(new MediaStream([track]));
          resolveVideo();
          if (ready) changeState('generating');
        }).catch(() => fail('Plus could not receive its generated video track.'));
      });
      engine.on('remoteUserOffLineNotify', (uid: string) => {
        if (String(uid) === renderUid) fail('Plus rendering ended. Start a new session.');
      });
      engine.on('bye', () => fail('Plus RTC session ended. Start a new session.'));
      engine.on('authInfoExpired', () => fail('Plus session expired. Start a new session.'));
      // Supply our already selected camera track; do not open another camera or microphone.
      await Promise.race([engine.publishLocalAudioStream(false), failurePromise]);
      assertActive();
      engine.setDefaultSubscribeAllRemoteAudioStreams(false);
      engine.setDefaultSubscribeAllRemoteVideoStreams(true);
      await Promise.race([engine.switchCamera(undefined, cameraTrack), failurePromise]);
      assertActive();
      const preparedTrack = await Promise.race([engine.getVideoTrack({ streamType: 0 }), failurePromise]);
      assertActive();
      if (!preparedTrack) throw new Error('Plus could not prepare the selected camera track.');
      const connectSignaling = () => {
      clearTimeout(socketRetry);
      if (stopped) return;
      if (credentialsExpired()) { fail(expiredMessage, 'credentials_expired'); return; }
      socketAttempts++;
      const currentSocket = new WebSocket(buildViduSocketUrl(options.baseUrl || this.baseUrl, liveId, connId, this.apiKey));
      socket = currentSocket;
      let retryScheduled = false;
      const retryHandshake = (closeCode?: number) => {
        if (stopped || retryScheduled || socket !== currentSocket) return;
        clearTimeout(handshakeTimer);
        clearTimeout(initRetry);
        // Retry only before initialization: reuse the live ID and connection ID,
        // never create another paid stream or replay initialization after success.
        if (ready) { fail('Vidu signaling disconnected. Start a new session.', 'ws_disconnected'); return; }
        retryScheduled = true;
        currentSocket.onopen = null; currentSocket.onmessage = null;
        currentSocket.onerror = null; currentSocket.onclose = null;
        currentSocket.close();
        if (socketAttempts >= 3 || (closeCode !== undefined && [1008, 4001, 4003].includes(closeCode))) {
          fail(typeof navigator !== 'undefined' && /Edg\//.test(navigator.userAgent)
            ? 'Plus signaling could not connect in Edge. Try this session in Chrome. Browser or network filtering may be blocking the connection.'
            : 'Plus signaling could not connect. Retry. Browser or network filtering may be blocking the connection.', 'ws_handshake_failed');
          return;
        }
        changeState('reconnecting');
        socketRetry = setTimeout(connectSignaling, socketAttempts * 1000);
      };
      handshakeTimer = setTimeout(() => retryHandshake(), 7000);
      currentSocket.onopen = () => {
        clearTimeout(handshakeTimer);
        if (credentialsExpired()) { fail(expiredMessage, 'credentials_expired'); return; }
        if (!stopped) { changeState('connecting'); send(1, { conn_init: { version: 1 } }); }
      };
      currentSocket.onerror = () => retryHandshake();
      currentSocket.onclose = event => retryHandshake(event.code);
      currentSocket.onmessage = event => {
        if (stopped || retryScheduled || socket !== currentSocket) return;
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 2) {
          const ack = message.payload?.conn_init_ack;
          if (ack?.success) {
            clearTimeout(initRetry);
            if (!ready) {
              ready = true;
              changeState('connected');
              sessionTimer = setTimeout(() => fail('Plus quality-test session finished. Start again to continue.'),
                Math.max(1, Math.min(options.maxSeconds || 120, 120)) * 1000);
              resolveInit();
            }
          } else if (ack?.error_code === 'NOT_READY') {
            clearTimeout(initRetry);
            initRetry = setTimeout(() => {
              if (credentialsExpired()) { fail(expiredMessage, 'credentials_expired'); return; }
              if (!stopped) { try { send(1, { conn_init: { version: 1 } }); } catch { fail('Plus signaling disconnected.'); } }
            }, 2000);
          } else fail(`Plus initialization failed (${ack?.error_code || 'unknown'}).`);
        } else if (message.type === 6) {
          const rawReason = message.payload?.hangup?.hangup_reason;
          const reason = typeof rawReason === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rawReason)
            ? rawReason : 'unknown';
          fail(reason === 'sip_close'
            ? 'Plus’s rendering connection closed before the session finished (sip_close). Please try again.'
            : `Vidu ended this session (${reason}). Please try again.`, reason);
        } else if (message.type === 14 && message.payload?.switch_prompt_ack?.success === false) {
          fail(`Plus could not change the image (${message.payload.switch_prompt_ack.error_code || 'unknown'}).`);
        }
      };
      };
      connectSignaling();
      await Promise.race([initPromise, failurePromise]);
      assertActive();
      await Promise.race([engine.joinChannel(rtc.token, rtc.user_id), failurePromise]);
      assertActive();
      await Promise.race([engine.publishLocalVideoStream(true), failurePromise]);
      published = true;
      await Promise.race([videoPromise, failurePromise]);
      assertActive();
      clearTimeout(startupTimer);
      changeState('generating');
      return {
        sessionId: liveId,
        getConnectionState: () => state,
        set: async input => {
          assertActive();
          const image = input.image ? await encodeViduReference(input.image) : null;
          assertActive();
          if (!image && !input.editingType) return;
          send(13, { switch_prompt: {
            ...(image ? { prompts: [{ type: 'image', content: image }] } : {}),
            editing_type: 'subject_replacement',
          } });
        },
        disconnect: async () => { await cleanup(); state = 'disconnected'; },
        on: (_event, handler) => { listeners.add(handler); },
        off: (_event, handler) => { listeners.delete(handler); },
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}
export function createViduClient(options: { apiKey: string; baseUrl?: string }) { return new ViduRealtimeClient(options); }
export const models = { realtime: (modelName: string = VIDU_REALTIME_MODEL) => modelName };
