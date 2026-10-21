import { VIDU_REALTIME_MODEL } from './realtime-provider';
import { getTrustedApiOrigin } from './api-client';
import type { RtcEngine } from 'aliyun-rtc-sdk';

type CameraRtcEngine = RtcEngine & { startPreview(): Promise<void> };

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
type ViduStartupPhase = 'camera_preparing' | 'camera_prepared' | 'signaling_open' | 'initialized'
  | 'rtc_joining' | 'rtc_joined' | 'camera_preview' | 'publishing' | 'published'
  | 'renderer_online' | 'renderer_subscribing' | 'renderer_subscribed' | 'video_received';

// AliRtcErrorType values from the pinned AliRTC 7.1.9 SDK. Audio, screen and
// optional secondary-video failures do not stop this camera-only startup.
const RTC_CAMERA_FAILURES = new Set([17039620, 17039621, 17039622, 17039623]);
const RTC_VIDEO_PUBLISH_FAILURES = new Set([16843857, 16974597, 16843782]);
const RTC_VIDEO_SUBSCRIBE_FAILURES = new Set([16844114, 16974852, 16844112]);
const RENDERER_SUBSCRIBE_RETRIES = 3;
const RTC_JOIN_FAILURES = new Set([33620481, 33620482, 33620484, 33620483, 33620485,
  16908804, 16974081, 16974338]);

function numericRtcCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 2147483647
    ? value : undefined;
}

function rtcErrorCode(error: unknown): number | undefined {
  if (typeof error === 'number') return numericRtcCode(error);
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; errorCode?: unknown };
  return numericRtcCode(candidate.code) ?? numericRtcCode(candidate.errorCode);
}
export interface ViduProxySignaling {
  transport: 'proxy';
  path: '/api/vidu/live';
  connectionId: string;
  origin?: string;
}
export interface ViduTransformInput {
  prompt?: string;
  enhance?: boolean;
  image?: Blob | string | null;
  editingType?: 'style_transfer' | 'subject_replacement' | 'background_replacement' | 'virtual_tryon';
}
export interface ViduClientOptions {
  apiKey?: string;
  baseUrl?: string;
  signaling?: ViduProxySignaling;
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

export function buildViduProxySocketUrl(signaling: ViduProxySignaling): string {
  const trustedOrigin = getTrustedApiOrigin();
  if (!signaling || signaling.transport !== 'proxy' || signaling.path !== '/api/vidu/live'
    || typeof signaling.connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(signaling.connectionId)
    || !trustedOrigin || (signaling.origin !== undefined && signaling.origin !== trustedOrigin)) {
    throw new Error('Unsupported Plus relay address. Start a new session.');
  }
  const url = new URL('/api/vidu/live', trustedOrigin);
  url.protocol = 'wss:';
  return url.toString();
}

export class ViduRealtimeClient {
  private apiKey: string;
  private baseUrl: string;
  private signaling?: ViduProxySignaling;
  constructor(options: { apiKey: string; baseUrl?: string; signaling?: ViduProxySignaling }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.vidu.com';
    this.signaling = options.signaling;
  }

  async connect(inputStream: MediaStream, options: ViduClientOptions = {}): Promise<ViduRealtimeSession> {
    const liveId = options.liveId;
    const renderUid = options.renderUid;
    const rtc = options.rtc;
    if (!liveId || !renderUid || typeof rtc?.token !== 'string' || typeof rtc.user_id !== 'string'
      || !this.apiKey || this.apiKey.startsWith('mock_') || this.apiKey.startsWith('vda_')) {
      throw new Error('Plus requires real Vidu session credentials. Restart the session.');
    }
    const signaling = options.signaling === undefined ? this.signaling : options.signaling;
    const proxyUrl = signaling === undefined ? null : buildViduProxySocketUrl(signaling);
    if (proxyUrl && !/^[A-Za-z0-9_.-]{1,12000}$/.test(this.apiKey)) {
      throw new Error('Plus relay session credentials are invalid. Start a new session.');
    }
    const startupTimeoutMs = proxyUrl ? 120000 : 35000;
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
    // startPreview is present in pinned 7.1.9, but absent from our narrow shim.
    let engine: CameraRtcEngine | null = AliRtcEngine.getInstance() as CameraRtcEngine;
    const cameraTrack = inputTrack.clone();
    const connId = signaling?.connectionId || crypto.randomUUID();
    let socket: WebSocket | null = null;
    let sequence = 1;
    let state: ViduConnectionState = 'connecting';
    let stopped = false;
    let ready = false;
    let cleanupPromise: Promise<void> | null = null;
    let published = false;
    let receivedVideo = false;
    let rendererSubscriptionRequested = false;
    let startupComplete = false;
    const startupStartedAt = Date.now();
    let lastPhase: ViduStartupPhase = 'camera_preparing';
    let startupFailure: Error | null = null;
    let initRetry: ReturnType<typeof setTimeout> | undefined;
    let socketRetry: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let socketAttempts = 0;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let credentialTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let subscribeRetry: ReturnType<typeof setTimeout> | undefined;
    let subscribeRetries = 0;
    const listeners = new Set<(error: unknown) => void>();
    let rejectStartup: (error: Error) => void = () => {};
    let resolveInit: () => void = () => {};
    let resolveVideo: () => void = () => {};
    let resolvePublished: () => void = () => {};
    const initPromise = new Promise<void>(resolve => { resolveInit = resolve; });
    const videoPromise = new Promise<void>(resolve => { resolveVideo = resolve; });
    const publishedPromise = new Promise<void>(resolve => { resolvePublished = resolve; });
    const failurePromise = new Promise<never>((_, reject) => { rejectStartup = reject; });
    void failurePromise.catch(() => {});
    const changeState = (next: ViduConnectionState) => {
      state = next;
      options.onConnectionChange?.(next);
    };
    const logStartup = (event: 'phase' | 'rtc_error' | 'rtc_connection_state' | 'camera_exception'
      | 'video_publish_state' | 'renderer_subscription_state' | 'startup_failed',
    codes: { code?: unknown; stateCode?: unknown; reasonCode?: unknown } = {}) => {
      const safeCodes: Record<string, number> = {};
      for (const [name, value] of Object.entries(codes)) {
        const code = numericRtcCode(value);
        if (code !== undefined) safeCodes[name] = code;
      }
      const details = JSON.stringify({ event, phase: lastPhase,
        elapsedMs: Math.max(0, Date.now() - startupStartedAt), ...safeCodes });
      if (event === 'startup_failed') console.warn('[Vidu] startup', details);
      else console.info('[Vidu] startup', details);
    };
    const recordPhase = (phase: ViduStartupPhase, code?: unknown) => {
      lastPhase = phase;
      logStartup('phase', { code });
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
      clearTimeout(subscribeRetry);
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
      // Media and signaling stop above even if SDK destruction never settles.
      cleanupPromise = new Promise<void>(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(destroyTimer);
          resolve();
        };
        const destroyTimer = setTimeout(finish, 2000);
        void Promise.resolve().then(() => currentEngine?.destroy()).catch(() => {}).then(finish);
      });
      return cleanupPromise;
    };
    const fail = (message: string, reason?: string, rawCode?: unknown) => {
      if (stopped) return;
      const code = numericRtcCode(rawCode);
      const context = code === undefined ? `Stage: ${lastPhase}.` : `RTC code: ${code}. Stage: ${lastPhase}.`;
      const error = Object.assign(new Error(`${message} ${context}`), {
        code: reason === 'ws_handshake_failed' ? 'VIDU_SIGNALING_UNREACHABLE' : undefined,
        rtcCode: code, startupPhase: lastPhase,
      });
      startupFailure = error;
      logStartup('startup_failed', { code });
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
      startupTimer = setTimeout(() => fail('Plus connection timed out before receiving generated video.'), startupTimeoutMs);
      if (credentialDeadline - Date.now() <= startupTimeoutMs + 120000) {
        // Later deadlines cannot be reached within the startup + session duration caps.
        credentialTimer = setTimeout(() => {
          if (credentialsExpired()) fail(expiredMessage, 'credentials_expired');
        }, Math.max(0, credentialDeadline - Date.now()));
      }
      const rendererError = (error: unknown, uid?: string) => {
        if (stopped || startupComplete || receivedVideo || (uid !== undefined && String(uid) !== renderUid)) return;
        const code = rtcErrorCode(error);
        if (code === undefined || !RTC_VIDEO_SUBSCRIBE_FAILURES.has(code)) return;
        // The SDK abandons a subscription when media does not arrive within
        // ~1.5 s, which is common while the renderer is still starting or on a
        // slow network. Re-subscribe a few times before ending the session.
        if (subscribeRetries < RENDERER_SUBSCRIBE_RETRIES && engine?.subscribeRemoteMediaStream) {
          subscribeRetries += 1;
          rendererSubscriptionRequested = false;
          logStartup('renderer_subscription_state', { code, stateCode: subscribeRetries });
          clearTimeout(subscribeRetry);
          subscribeRetry = setTimeout(() => {
            if (stopped || receivedVideo) return;
            rendererSubscriptionRequested = true;
            try { engine?.subscribeRemoteMediaStream?.(renderUid, 1, true, false); }
            catch { rendererSubscriptionRequested = false; }
          }, 1000 * subscribeRetries);
          return;
        }
        fail('Plus could not receive the renderer video. Start a new session.', 'rtc_subscribe_failed', code);
      };
      engine.on('occurError', (error, uid) => {
        if (stopped || startupComplete) return;
        const code = rtcErrorCode(error);
        logStartup('rtc_error', { code });
        const localError = uid === undefined || String(uid) === rtc.user_id;
        if (code !== undefined && localError && RTC_CAMERA_FAILURES.has(code)) {
          fail('Plus could not use the selected camera. Start a new session.', 'rtc_camera_failed', code);
        } else if (code !== undefined && localError && RTC_VIDEO_PUBLISH_FAILURES.has(code)) {
          fail('Plus could not publish the camera video. Start a new session.', 'rtc_publish_failed', code);
        } else if (code !== undefined && localError && RTC_JOIN_FAILURES.has(code)) {
          fail('Plus could not join its video room. Start a new session.', 'rtc_join_failed', code);
        } else rendererError(error, uid);
      });
      // 7.1.9 forwards this internal event through occurError. Register the alias
      // for SDK builds that expose it, while using the public event above.
      (engine as RtcEngine & { on(event: 'remoteSubscribeError', handler: typeof rendererError): void })
        .on('remoteSubscribeError', rendererError);
      engine.on('localDeviceException', (device, exception) => {
        if (stopped || startupComplete) return;
        if ((device === 4 && [9, 10, 11].includes(exception)) || (device === 6 && exception === 13)) {
          logStartup('camera_exception', { code: exception, stateCode: device });
          fail('Plus lost access to the selected camera. Start a new session.', 'rtc_camera_failed', exception);
        }
      });
      engine.on('connectionStatusChange', (status, reason) => {
        if (stopped || startupComplete) return;
        logStartup('rtc_connection_state', { stateCode: status, reasonCode: reason });
        if (status === 5 || (status === 1 && reason === 8)) {
          fail('Plus could not connect to its video room. Start a new session.', 'rtc_join_failed', reason);
        }
      });
      engine.on('videoPublishStateChanged', (_old, next) => {
        if (stopped) return;
        logStartup('video_publish_state', { stateCode: next });
        // State 1 may precede SDK retries; only state 3 confirms publication.
        if (next === 3 && !published) {
          published = true;
          recordPhase('published', next);
          resolvePublished();
        }
      });
      engine.on('remoteUserOnLineNotify', uid => {
        if (stopped || receivedVideo || String(uid) !== renderUid) return;
        recordPhase('renderer_online');
        if (rendererSubscriptionRequested || !engine?.subscribeRemoteMediaStream) return;
        rendererSubscriptionRequested = true;
        try { engine.subscribeRemoteMediaStream(renderUid, 1, true, false); }
        catch { rendererSubscriptionRequested = false; }
      });
      engine.on('videoSubscribeStateChanged', (userId: string, _old: number, next: number) => {
        if (String(userId) !== renderUid || stopped || receivedVideo) return;
        if (next === 2) recordPhase('renderer_subscribing', next);
        else if (next === 3) recordPhase('renderer_subscribed', next);
        else logStartup('renderer_subscription_state', { stateCode: next });
        if (next !== 3) return;
        void engine?.getVideoTrack({ userId, streamType: 0 }).then(track => {
          if (stopped) return;
          if (!track || track.readyState === 'ended') {
            fail('Plus subscribed to its renderer but received no usable video track. Start a new session.', 'rtc_video_track_missing');
            return;
          }
          receivedVideo = true;
          recordPhase('video_received');
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
      engine.setDefaultSubscribeAllRemoteVideoStreams(false);
      await Promise.race([engine.switchCamera(undefined, cameraTrack), failurePromise]);
      assertActive();
      const preparedTrack = await Promise.race([engine.getVideoTrack({ streamType: 0 }), failurePromise]);
      assertActive();
      if (!preparedTrack) throw new Error('Plus could not prepare the selected camera track.');
      recordPhase('camera_prepared');
      const connectSignaling = () => {
      clearTimeout(socketRetry);
      if (stopped) return;
      if (credentialsExpired()) { fail(expiredMessage, 'credentials_expired'); return; }
      socketAttempts++;
      const currentSocket = proxyUrl
        ? new WebSocket(proxyUrl, ['morphly.plus', `morphly-ticket.${this.apiKey}`])
        : new WebSocket(buildViduSocketUrl(options.baseUrl || this.baseUrl, liveId, connId, this.apiKey));
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
          fail('Plus signaling could not connect. Start a new session and try again.', 'ws_handshake_failed');
          return;
        }
        changeState('reconnecting');
        socketRetry = setTimeout(connectSignaling, socketAttempts * 1000);
      };
      handshakeTimer = setTimeout(() => retryHandshake(), proxyUrl ? 120000 : 7000);
      currentSocket.onopen = () => {
        clearTimeout(handshakeTimer);
        if (credentialsExpired()) { fail(expiredMessage, 'credentials_expired'); return; }
        if (!stopped) { recordPhase('signaling_open'); changeState('connecting'); send(1, { conn_init: { version: 1 } }); }
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
              recordPhase('initialized');
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
          } else fail('Plus could not initialize this session. Start a new session.', 'initialization_failed', ack?.error_code);
        } else if (message.type === 6) {
          const rawReason = message.payload?.hangup?.hangup_reason;
          const reason = typeof rawReason === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rawReason)
            ? rawReason : 'unknown';
          fail(reason === 'sip_close'
            ? 'Plus’s rendering connection closed before the session finished (sip_close). Please try again.'
            : `Vidu ended this session (${reason}). Please try again.`, reason);
        } else if (message.type === 14 && message.payload?.switch_prompt_ack?.success === false) {
          fail('Plus could not change the reference image. Start a new session.', 'image_update_failed', message.payload.switch_prompt_ack.error_code);
        }
      };
      };
      connectSignaling();
      await Promise.race([initPromise, failurePromise]);
      assertActive();
      recordPhase('rtc_joining');
      await Promise.race([engine.joinChannel(rtc.token, rtc.user_id), failurePromise]);
      assertActive();
      recordPhase('rtc_joined');
      recordPhase('camera_preview');
      await Promise.race([engine.startPreview(), failurePromise]);
      assertActive();
      recordPhase('publishing');
      await Promise.race([engine.publishLocalVideoStream(true), failurePromise]);
      assertActive();
      await Promise.race([publishedPromise, failurePromise]);
      await Promise.race([videoPromise, failurePromise]);
      assertActive();
      startupComplete = true;
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
      if (!startupFailure && !stopped) {
        const failedPhase = lastPhase as ViduStartupPhase;
        const message = failedPhase === 'rtc_joining'
          ? 'Plus could not join its video room. Start a new session.'
          : failedPhase === 'publishing' || failedPhase === 'published'
            ? 'Plus could not publish the camera video. Start a new session.'
            : 'Plus could not complete video startup. Start a new session.';
        // SDK errors can embed RTC credentials or signed URLs in their message.
        fail(message, 'rtc_startup_failed', rtcErrorCode(error));
      }
      await cleanup();
      throw startupFailure || new Error('Plus video startup was cancelled.');
    }
  }
}
export function createViduClient(options: { apiKey: string; baseUrl?: string; signaling?: ViduProxySignaling }) { return new ViduRealtimeClient(options); }
export const models = { realtime: (modelName: string = VIDU_REALTIME_MODEL) => modelName };
