import { useState, useRef, useEffect, useCallback } from 'react';
import './dashboard.css';
import { CustomerEngagement } from '@/components/CustomerEngagement';
import { useNavigate } from 'react-router-dom';
import {
  Upload,
  Play,
  Square,
  Monitor,
  Settings,
  Maximize,
  Minimize,
  Plus,
  Coins,
  LoaderCircle,
  RefreshCw,
  CircleAlert,
  X,
} from 'lucide-react';
import type { RealTimeClient as DecartRealtimeSession } from '@decartai/sdk';
import { BACKGROUND_PRESETS, buildXmaxTransformPrompt } from '@/lib/background-presets';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { apiFetchWithAuth } from '@/lib/api-client';
import {
  CREDITS_PER_SECOND,
  CREDITS_PER_SECOND_BLENDED,
  CREDITS_PER_SECOND_STANDARD,
  getCreditRatePerSecond,
} from '@/lib/billing';
import {
  getInstallationId,
  trackConnectionStarted,
  trackConnectionFailed,
  trackFirstFrameReceived,
  trackSessionCompleted,
} from '@/lib/telemetry-client';
import { UpdateBanner } from '@/components/UpdateBanner';
import { MeanVcPanel } from '@/components/MeanVcPanel';
import { MorphlyDashboardTour } from '@/components/onboarding/MorphlyDashboardTour';
import {
  claimSignupBonusWelcome,
  getOnboardingState,
  shouldAutoStartOnboarding,
  updateOnboardingState,
} from '@/lib/account';
import {
  getDesktopUpdateState,
  subscribeToDesktopUpdateState,
} from '@/lib/desktop-updater';
import {
  isVirtualCamera,
  subscribeToCameraDeviceChanges,
} from '@/utils/cameraDeviceClassifier';
import {
  enumeratePhysicalCameras,
  validateOpenedCameraTrack,
  validateSelectedPhysicalCamera,
} from '@/utils/physicalCameraAccess';
import {
  QUALITY_MODE_PROFILES,
  buildVideoInputConstraints,
  buildVideoTrackConstraints,
  clampQualityMode,
  downgradeQualityMode,
  type QualityMode,
} from '@/lib/realtime-quality';
import {
  XMAX_REALTIME_MODEL,
  buildXmaxRealtimeContext,
  getXmaxRealtimeUserMessage,
  prepareXmaxReferenceImage,
} from '@/lib/xmax-realtime';
import {
  DECART_REALTIME_PROVIDER,
  DECART_REALTIME_MODEL,
  DEFAULT_REALTIME_PROVIDER,
  REALTIME_PROVIDER_OPTIONS,
  getDecartRealtimeUserMessage,
  getRealtimeProviderLabel,
  resolveRealtimeModel,
  resolveRealtimeProvider,
  type RealtimeProvider,
} from '@/lib/realtime-provider';
import { getNextVirtualCameraFrameClock } from '@/lib/virtual-camera-timing';


type ConnectionState = 'connecting' | 'connected' | 'generating' | 'disconnected' | 'reconnecting';

interface RealtimeClient {
  disconnect: () => Promise<void>;
  setTransform: (transform: TransformState) => Promise<void>;
  getConnectionState: () => ConnectionState;
  getSessionUid: () => string | null;
}

type AiSessionResponse = {
  allowed: boolean;
  token?: string;
  error?: string;
  details?: string;
  providerStatus?: number;
  credits?: number;
  maxSeconds?: number;
  sessionId?: string;
  expiresAt?: string | null;
  model?: string;
  provider?: RealtimeProvider;
  startupTimings?: {
    totalMs: number;
    authorizationMs: number;
    validationMs: number;
    sessionRecordMs: number;
    providerCredentialMs: number;
    auditMs: number;
  };
};

type ReferenceImage = {
  file: File;
  name: string;
  signature: string;
};

type TransformState = {
  prompt: string;
  enhance: boolean;
  image: File | null;
  imageSignature: string | null;
};

type StreamMetrics = {
  fps: number;
  frameWidth: number;
  frameHeight: number;
  rttMs: number | null;
  limitation: string;
  bitrateKbps: number;
};

type DashboardError = {
  title: string;
  message: string;
  canRetry?: boolean;
};

type VideoElementWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  latencyHint?: string;
};

type VirtualCameraProfile = {
  mode: 'low' | 'balanced' | 'high';
  width: number;
  height: number;
  frameRate: number;
};

const BASE_PROMPT = `Substitute the character in the video with the person in the reference image.`;
const DEFAULT_ENHANCE = true;
const POLLING_INTERVAL = 5000; // poll session-status every 5 s for live credit display
const TRANSFORM_SYNC_DEBOUNCE_MS = 180;
const RESTART_WATCHDOG_INTERVAL_MS = 3000;
const FREEZE_RESTART_THRESHOLD_MS = 12000;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;
const AI_CONNECT_TIMEOUT_MS: Record<RealtimeProvider, number> = {
  xmax: 30000,
  decart: 45000,
};
const AI_FIRST_FRAME_TIMEOUT_MS = 15000;
const AI_CONNECT_MAX_ATTEMPTS: Record<RealtimeProvider, number> = {
  xmax: 2,
  // The Pro SDK already retries WebRTC internally with exponential backoff.
  decart: 1,
};
const PRO_CAMERA_FPS = 30;
const DEFAULT_VIRTUAL_CAMERA_PROFILE: VirtualCameraProfile = {
  mode: 'low',
  width: 640,
  height: 360,
  frameRate: 24,
};
const MORPHLY_CAM_POPUP_WIDTH = 640;
const MORPHLY_CAM_POPUP_HEIGHT = 360;
const MORPHLY_CAM_POPUP_FRAME_INTERVAL_MS = 1000 / 24;
const SELECTED_CAMERA_STORAGE_PREFIX = 'morphly:selected-physical-camera';

function buildProviderVideoTrackConstraints(
  mode: QualityMode,
  provider: RealtimeProvider,
): MediaTrackConstraints {
  const constraints = buildVideoTrackConstraints(mode);

  if (provider === 'decart') {
    constraints.frameRate = {
      ideal: PRO_CAMERA_FPS,
      max: PRO_CAMERA_FPS,
      min: 24,
    };
  }

  return constraints;
}

function buildProviderVideoInputConstraints(
  mode: QualityMode,
  provider: RealtimeProvider,
  deviceId?: string,
): MediaStreamConstraints {
  const constraints = buildVideoInputConstraints(mode, deviceId);

  if (provider === 'decart' && typeof constraints.video === 'object') {
    constraints.video.frameRate = {
      ideal: PRO_CAMERA_FPS,
      max: PRO_CAMERA_FPS,
      min: 24,
    };
  }

  return constraints;
}

function isVirtualCameraProfile(value: unknown): value is VirtualCameraProfile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<VirtualCameraProfile>;
  return (
    (candidate.mode === 'low' || candidate.mode === 'balanced' || candidate.mode === 'high') &&
    Number.isInteger(candidate.width) && Number(candidate.width) > 0 &&
    Number.isInteger(candidate.height) && Number(candidate.height) > 0 &&
    Number.isInteger(candidate.frameRate) && Number(candidate.frameRate) > 0
  );
}

function createEmptyStreamMetrics(): StreamMetrics {
  return {
    fps: 0,
    frameWidth: 0,
    frameHeight: 0,
    rttMs: null,
    limitation: 'none',
    bitrateKbps: 0,
  };
}

function buildTransformSignature(transform: TransformState): string {
  return [
    transform.prompt,
    DEFAULT_ENHANCE ? 'enhance' : 'base',
    transform.imageSignature ?? 'no-image',
  ].join('|');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function drawVideoFrameCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetWidth: number,
  targetHeight: number,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
    return;
  }

  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  let sourceX = 0;
  let sourceY = 0;
  let sourceDrawWidth = sourceWidth;
  let sourceDrawHeight = sourceHeight;

  if (sourceAspect > targetAspect) {
    sourceDrawWidth = Math.max(1, Math.round(sourceHeight * targetAspect));
    sourceX = Math.max(0, Math.floor((sourceWidth - sourceDrawWidth) / 2));
  } else if (sourceAspect < targetAspect) {
    sourceDrawHeight = Math.max(1, Math.round(sourceWidth / targetAspect));
    sourceY = Math.max(0, Math.floor((sourceHeight - sourceDrawHeight) / 2));
  }

  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceDrawWidth,
    sourceDrawHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  );
}

function drawBottomUpVirtualCameraFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetWidth: number,
  targetHeight: number,
) {
  // DirectShow RGB bitmaps with a positive height are bottom-up. Draw the
  // dedicated publisher canvas upside-down so consumers display it upright;
  // the Media Foundation bridge restores top-down row order while converting
  // the same pixels to NV12/YUY2 for modern apps such as WhatsApp.
  context.save();
  context.translate(0, targetHeight);
  context.scale(1, -1);
  try {
    drawVideoFrameCover(context, video, targetWidth, targetHeight);
  } finally {
    context.restore();
  }
}

function getStartSessionErrorMessage(error: unknown, provider: RealtimeProvider): string | null {
  if (!(error instanceof Error)) {
    return 'Failed to start session';
  }

  switch (error.message) {
    case 'Webcam start failed':
    case 'Xmax connection was not established':
    case 'Decart connection was not established':
      return null;
    case 'Missing session token':
      return `Failed to start ${getRealtimeProviderLabel(provider)}: missing AI token`;
    default: {
      const fallback = (error.message || 'Failed to start session')
        .replace(/\bXmax\b/gi, 'Plus')
        .replace(/\bDecart\b/gi, 'Pro');
      return provider === DECART_REALTIME_PROVIDER
        ? getDecartRealtimeUserMessage(error, fallback)
        : fallback;
    }
  }
}

function getRealtimeSdkErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown;
      code?: unknown;
      cause?: { message?: unknown } | unknown;
    };

    if (
      typeof candidate.cause === 'object'
      && candidate.cause !== null
      && 'message' in candidate.cause
      && typeof candidate.cause.message === 'string'
      && candidate.cause.message
    ) {
      return candidate.cause.message;
    }

    if (typeof candidate.message === 'string' && candidate.message) {
      return candidate.message;
    }

    if (typeof candidate.code === 'string' && candidate.code) {
      return candidate.code;
    }
  }

  return null;
}

async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await apiFetchWithAuth(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.details || errorData.error || errorData.message || `API Error: ${response.statusText}`);
  }

  return response.json();
}

// Preload both SDK modules so selecting an engine never starts with a bundle download.
const xmaxSdkReadyPromise = import('@xmaxai/sdk-global');
const decartSdkReadyPromise = import('@decartai/sdk');

function Dashboard() {
  const { user, logout } = useAuth();
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const { credits, setCredits, setSessionStatus } = useApp();
  const navigate = useNavigate();

  const [isStreaming, setIsStreaming] = useState(false);
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [allVideoInputDevices, setAllVideoInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [virtualCameraDevices, setVirtualCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [cameraPermission, setCameraPermission] = useState<PermissionState | 'unsupported' | 'unknown'>('unknown');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRefreshingCameras, setIsRefreshingCameras] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<RealtimeProvider>(DEFAULT_REALTIME_PROVIDER);
  const [engineReadiness, setEngineReadiness] = useState<Record<RealtimeProvider, boolean>>({
    xmax: false,
    decart: false,
  });
  const [engineLoadErrors, setEngineLoadErrors] = useState<Record<RealtimeProvider, string | null>>({
    xmax: null,
    decart: null,
  });
  const [isUpdaterBlocking, setIsUpdaterBlocking] = useState(false);
  const [isTourRunning, setIsTourRunning] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isValidatingImage, setIsValidatingImage] = useState(false);
  const [activeBgPreset, setActiveBgPreset] = useState<string>('original');
  const [customBgPrompt, setCustomBgPrompt] = useState<string>('');
  const [prompt] = useState(BASE_PROMPT);

  const isBlendedMode = Boolean(referenceImage) && (activeBgPreset !== 'original' || Boolean(customBgPrompt.trim()));
  const currentCreditRate = getCreditRatePerSecond(
    Boolean(referenceImage),
    activeBgPreset !== 'original' || Boolean(customBgPrompt.trim()),
  );

  const activePrompt = buildXmaxTransformPrompt(
    Boolean(referenceImage),
    activeBgPreset,
    customBgPrompt,
  );
  const [preferredMode, setPreferredMode] = useState<QualityMode>('hd');
  const [runtimeModeCap, setRuntimeModeCap] = useState<QualityMode>('hd');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [uiStatus, setUiStatus] = useState('Disconnected');
  const [isSyncingTransform, setIsSyncingTransform] = useState(false);
  const [hasRemoteFrame, setHasRemoteFrame] = useState(false);
  const [, setStreamMetrics] = useState<StreamMetrics>(() => createEmptyStreamMetrics());
  const [dashboardError, setDashboardError] = useState<DashboardError | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const dashboardErrorRef = useRef<HTMLDivElement>(null);
  const webcamSourceStreamRef = useRef<MediaStream | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const realtimeClientRef = useRef<RealtimeClient | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transformSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTransformRef = useRef<TransformState | null>(null);
  const lastAppliedTransformRef = useRef<TransformState | null>(null);
  const xmaxReferenceUrlCacheRef = useRef<Map<string, string>>(new Map());
  const transformInFlightRef = useRef(false);
  const sessionTokenRef = useRef('');
  const sessionIdRef = useRef('');
  const sessionProviderRef = useRef<RealtimeProvider>(DEFAULT_REALTIME_PROVIDER);
  const sessionRealtimeModelRef = useRef<string>(XMAX_REALTIME_MODEL);
  const usageFlushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const generationMeterIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingBillableSecondsRef = useRef(0);
  const lastGenerationMeterAtRef = useRef(0);
  const frameCallbackHandleRef = useRef<number | null>(null);
  const firstFrameReadyRef = useRef<(() => void) | null>(null);
  const lastRemoteFrameAtRef = useRef(0);
  const frameWatchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const softReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartInFlightRef = useRef(false);
  const safeStopInFlightRef = useRef(false);
  const sessionEverConnectedRef = useRef(false);
  const firstFrameTrackedRef = useRef(false);
  const restartRetryDelayRef = useRef(INITIAL_RETRY_DELAY_MS);
  const restartFailureCountRef = useRef(0);
  const handleStopRef = useRef<((options?: { silent?: boolean }) => Promise<void>) | null>(null);
  const safelyStopSessionRef = useRef<(() => Promise<void>) | null>(null);
  const restartRealtimeSessionRef = useRef<((
    reason: string,
    options?: { immediate?: boolean },
  ) => Promise<void>) | null>(null);
  const userInitiatedCameraChangeRef = useRef(false);
  const previousCameraIdRef = useRef('');
  const selectedCameraIdRef = useRef('');
  const morphlyCamWindowRef = useRef<Window | null>(null);
  const morphlyCamVideoRef = useRef<HTMLVideoElement | null>(null);
  const morphlyCamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const morphlyCamStatusRef = useRef<HTMLDivElement | null>(null);
  const morphlyCamPlaceholderRef = useRef<HTMLDivElement | null>(null);
  const morphlyCamWindowEnabledRef = useRef(false);
  const latestRemoteStreamRef = useRef<MediaStream | null>(null);
  const morphlyCamRenderHandleRef = useRef<number | null>(null);
  const morphlyCamLastFrameSentAtRef = useRef(0);
  const mainVirtualCamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mainVirtualCamRenderHandleRef = useRef<number | null>(null);
  const mainVirtualCamUsesVideoFrameCallbackRef = useRef(false);
  const mainVirtualCamLastFrameSentAtRef = useRef(-1);
  const virtualCameraProfileRef = useRef<VirtualCameraProfile>(DEFAULT_VIRTUAL_CAMERA_PROFILE);

  const promptRef = useRef(prompt);
  const activePromptRef = useRef(activePrompt);
  const activeBgPresetRef = useRef(activeBgPreset);
  const customBgPromptRef = useRef(customBgPrompt);
  const isBlendedModeRef = useRef(isBlendedMode);
  const referenceImageRef = useRef(referenceImage);
  const isStreamingRef = useRef(isStreaming);
  const hasRemoteFrameRef = useRef(hasRemoteFrame);
  const connectionStateRef = useRef<ConnectionState>(connectionState);
  const activeModeRef = useRef<QualityMode>('hd');

  const isEngineReady = engineReadiness[selectedProvider];
  const engineLoadError = engineLoadErrors[selectedProvider];
  const activeProviderLabel = getRealtimeProviderLabel(selectedProvider);
  const activeMode = selectedProvider === 'decart'
    ? 'hd'
    : clampQualityMode(preferredMode, runtimeModeCap);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    activePromptRef.current = activePrompt;
  }, [activePrompt]);

  useEffect(() => {
    activeBgPresetRef.current = activeBgPreset;
  }, [activeBgPreset]);

  useEffect(() => {
    customBgPromptRef.current = customBgPrompt;
  }, [customBgPrompt]);

  useEffect(() => {
    isBlendedModeRef.current = isBlendedMode;
  }, [isBlendedMode]);

  useEffect(() => {
    referenceImageRef.current = referenceImage;
  }, [referenceImage]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    hasRemoteFrameRef.current = hasRemoteFrame;
  }, [hasRemoteFrame]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    if (!dashboardError) return;
    const focusFrame = window.requestAnimationFrame(() => dashboardErrorRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [dashboardError]);

  useEffect(() => {
    activeModeRef.current = activeMode;
  }, [activeMode]);

  useEffect(() => {
    selectedCameraIdRef.current = selectedCameraId;
  }, [selectedCameraId]);

  useEffect(() => {
    const syncBrowserFullScreen = () => {
      if (!window.electron?.isElectron) {
        setIsFullScreen(Boolean(document.fullscreenElement));
      }
    };

    document.addEventListener('fullscreenchange', syncBrowserFullScreen);

    if (!window.electron?.isElectron) {
      syncBrowserFullScreen();
      return () => {
        document.removeEventListener('fullscreenchange', syncBrowserFullScreen);
      };
    }

    void window.electron.invoke('window:get-full-screen')
      .then((fullScreen) => setIsFullScreen(Boolean(fullScreen)))
      .catch((error) => {
        console.warn('Unable to read full-screen state:', error);
      });

    const unsubscribe = window.electron.on(
      'window:full-screen-changed',
      (fullScreen: boolean) => setIsFullScreen(Boolean(fullScreen)),
    );

    return () => {
      document.removeEventListener('fullscreenchange', syncBrowserFullScreen);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const preloadProvider = (
      provider: RealtimeProvider,
      readyPromise: Promise<unknown>,
    ) => readyPromise
      .then(() => {
        if (cancelled) return;
        setEngineReadiness((current) => ({ ...current, [provider]: true }));
        setEngineLoadErrors((current) => ({ ...current, [provider]: null }));
      })
      .catch((error) => {
        console.error(`Failed to preload ${provider} realtime engine:`, error);
        if (cancelled) return;
        setEngineReadiness((current) => ({ ...current, [provider]: false }));
        setEngineLoadErrors((current) => ({
          ...current,
          [provider]: `${getRealtimeProviderLabel(provider)} is not ready yet.`,
        }));
      });

    void Promise.allSettled([
      preloadProvider('xmax', xmaxSdkReadyPromise),
      preloadProvider('decart', decartSdkReadyPromise),
    ]);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const applyUpdateState = (state: {
      checkInProgress?: boolean;
      downloadInProgress?: boolean;
      installInProgress?: boolean;
    }) => {
      setIsUpdaterBlocking(Boolean(
        state.checkInProgress || state.downloadInProgress || state.installInProgress,
      ));
    };

    void getDesktopUpdateState().then(applyUpdateState).catch((error) => {
      console.warn('Unable to read desktop updater state:', error);
    });

    return subscribeToDesktopUpdateState(applyUpdateState);
  }, []);

  useEffect(() => {
    if (!user?.id) return undefined;

    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | null = null;

    void claimSignupBonusWelcome().catch((error) => {
      console.warn('Unable to claim signup welcome message:', error);
    });

    void getOnboardingState()
      .then((onboarding) => {
        if (cancelled || !shouldAutoStartOnboarding(onboarding)) return;

        startTimer = setTimeout(() => {
          if (!cancelled) setIsTourRunning(true);
        }, 450);
      })
      .catch((error) => {
        console.warn('Unable to load guided-tour state:', error);
      })
      .finally(() => { if (!cancelled) setOnboardingChecked(true); });

    return () => {
      cancelled = true;
      if (startTimer) clearTimeout(startTimer);
    };
  }, [user?.id]);

  const clearUsageFlushInterval = useCallback(() => {
    if (usageFlushIntervalRef.current) {
      clearInterval(usageFlushIntervalRef.current);
      usageFlushIntervalRef.current = null;
    }
  }, []);

  const clearGenerationMeterInterval = useCallback(() => {
    if (generationMeterIntervalRef.current) {
      clearInterval(generationMeterIntervalRef.current);
      generationMeterIntervalRef.current = null;
    }
    lastGenerationMeterAtRef.current = 0;
  }, []);

  const flushBillableUsage = useCallback(async (options?: { keepalive?: boolean; suppressAutoStop?: boolean }) => {
    if (!user?.id || !sessionIdRef.current) {
      return true;
    }

    const secondsDelta = Math.floor(pendingBillableSecondsRef.current);
    if (secondsDelta <= 0) {
      return true;
    }

    pendingBillableSecondsRef.current -= secondsDelta;

    try {
      const response = await apiRequest<{
        remainingCredits?: number;
        shouldStop?: boolean;
      }>('/heartbeat', {
        method: 'POST',
        keepalive: options?.keepalive,
        body: JSON.stringify({
          userId: user.id,
          sessionId: sessionIdRef.current,
          secondsDelta,
        }),
      });

      if (response.remainingCredits !== undefined) {
        setCredits(response.remainingCredits);
      }

      if (response.shouldStop && !options?.suppressAutoStop) {
        await handleStopRef.current?.({ silent: true });
        setDashboardError({
          title: 'Session ended',
          message: 'Your credit balance is too low to continue. Add credits, then start again.',
        });
      }

      return true;
    } catch (error) {
      pendingBillableSecondsRef.current += secondsDelta;
      console.error('Failed to record billable usage:', error);
      return false;
    }
  }, [setCredits, user?.id]);

  const resetBillableUsageTracking = useCallback(() => {
    clearUsageFlushInterval();
    clearGenerationMeterInterval();
    pendingBillableSecondsRef.current = 0;
  }, [clearGenerationMeterInterval, clearUsageFlushInterval]);

  const recordBillableGenerationTime = useCallback(() => {
    if (!sessionTokenRef.current || !sessionIdRef.current) {
      return;
    }

    const now = Date.now();
    if (lastGenerationMeterAtRef.current === 0) {
      lastGenerationMeterAtRef.current = now;
      return;
    }

    const secondsDelta = Math.min(
      60,
      Math.floor((now - lastGenerationMeterAtRef.current) / 1000),
    );

    if (secondsDelta > 0) {
      lastGenerationMeterAtRef.current += secondsDelta * 1000;
      // Xmax bills while generation is running. Meter elapsed time only after
      // a decoded remote frame is visible, so low-power frame rates do not
      // change customer billing.
      // In simultaneous Avatar + Background blending mode, users are charged 4 credits/sec
      // (2x multiplier on 2 credits/sec base unit).
      // In single mode (Avatar only or Background only), charge normal 2 credits/sec.
      const billingMultiplier = isBlendedModeRef.current
        ? CREDITS_PER_SECOND_BLENDED / CREDITS_PER_SECOND_STANDARD
        : 1;
      pendingBillableSecondsRef.current += Math.min(
        secondsDelta,
        60,
      ) * billingMultiplier;
    }
  }, []);

  const resetMorphlyCamRefs = useCallback(() => {
    if (morphlyCamWindowRef.current && morphlyCamRenderHandleRef.current !== null) {
      morphlyCamWindowRef.current.cancelAnimationFrame(morphlyCamRenderHandleRef.current);
    }

    morphlyCamRenderHandleRef.current = null;
    morphlyCamLastFrameSentAtRef.current = 0;
    morphlyCamWindowRef.current = null;
    morphlyCamVideoRef.current = null;
    morphlyCamCanvasRef.current = null;
    morphlyCamStatusRef.current = null;
    morphlyCamPlaceholderRef.current = null;
    morphlyCamWindowEnabledRef.current = false;
  }, []);

  const updateMorphlyCamPlaceholder = useCallback((message: string | null) => {
    const placeholder = morphlyCamPlaceholderRef.current;

    if (!placeholder) {
      return;
    }

    if (!message) {
      placeholder.style.opacity = '0';
      placeholder.style.pointerEvents = 'none';
      return;
    }

    placeholder.textContent = message;
    placeholder.style.opacity = '1';
    placeholder.style.pointerEvents = 'auto';
  }, []);

  const getMorphlyCamGuideMessage = useCallback((hasLiveVideo: boolean) => {
    if (hasLiveVideo) {
      return 'Capture this window in SplitCam or OBS. If you need a webcam device, route it through SplitCam or OBS Virtual Camera.';
    }

    if (isStreamingRef.current) {
      return 'Waiting for Morphly video. Keep this window selected in SplitCam or OBS Window Capture.';
    }

    return 'Start Morphly first, then capture this window in SplitCam or OBS. This window is not a standalone webcam device.';
  }, []);

  const updateMorphlyCamStatus = useCallback((message: string | null) => {
    const status = morphlyCamStatusRef.current;

    if (!status) {
      return;
    }

    if (!message) {
      status.textContent = '';
      status.style.opacity = '0';
      return;
    }

    status.textContent = message;
    status.style.opacity = '1';
  }, []);

  const stopMorphlyCamRenderLoop = useCallback(() => {
    const popup = morphlyCamWindowRef.current;
    if (popup && morphlyCamRenderHandleRef.current !== null) {
      popup.cancelAnimationFrame(morphlyCamRenderHandleRef.current);
    }

    morphlyCamRenderHandleRef.current = null;
  }, []);

  const stopMainVirtualCamRenderLoop = useCallback(() => {
    if (mainVirtualCamRenderHandleRef.current !== null) {
      const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
      if (mainVirtualCamUsesVideoFrameCallbackRef.current && video?.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(mainVirtualCamRenderHandleRef.current);
      } else {
        window.cancelAnimationFrame(mainVirtualCamRenderHandleRef.current);
      }
    }

    mainVirtualCamRenderHandleRef.current = null;
    mainVirtualCamUsesVideoFrameCallbackRef.current = false;
  }, []);

  const pushMorphlyCamFrame = useCallback((canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
    if (!window.electron?.sendVirtualCameraFrame) {
      return;
    }

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    window.electron.sendVirtualCameraFrame({
      width: canvas.width,
      height: canvas.height,
      stride: canvas.width * 4,
      pixels: imageData.data,
    });
  }, []);

  const startMorphlyCamRenderLoop = useCallback(() => {
    const popup = morphlyCamWindowRef.current;
    const video = morphlyCamVideoRef.current;
    const canvas = morphlyCamCanvasRef.current;

    if (!popup || popup.closed || !video || !canvas) {
      return;
    }

    stopMorphlyCamRenderLoop();
    morphlyCamLastFrameSentAtRef.current = 0;

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });

    if (!context) {
      return;
    }

    const renderFrame = () => {
      const currentPopup = morphlyCamWindowRef.current;
      const currentVideo = morphlyCamVideoRef.current;
      const currentCanvas = morphlyCamCanvasRef.current;

      if (!currentPopup || currentPopup.closed || !currentVideo || !currentCanvas) {
        morphlyCamRenderHandleRef.current = null;
        return;
      }

      if (currentVideo.readyState >= 2 && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
        const now = currentPopup.performance?.now?.() ?? performance.now();
        if ((now - morphlyCamLastFrameSentAtRef.current) >= MORPHLY_CAM_POPUP_FRAME_INTERVAL_MS) {
          context.fillStyle = '#000000';
          context.fillRect(0, 0, currentCanvas.width, currentCanvas.height);
          drawVideoFrameCover(context, currentVideo, currentCanvas.width, currentCanvas.height);
          morphlyCamLastFrameSentAtRef.current = now;
        }
      }

      morphlyCamRenderHandleRef.current = currentPopup.requestAnimationFrame(renderFrame);
    };

    morphlyCamRenderHandleRef.current = popup.requestAnimationFrame(renderFrame);
  }, [stopMorphlyCamRenderLoop]);

  const startMainVirtualCamRenderLoop = useCallback(() => {
    if (!morphlyCamWindowEnabledRef.current) {
      return;
    }

    const video = outputVideoRef.current;
    if (!video) {
      return;
    }

    let canvas = mainVirtualCamCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      mainVirtualCamCanvasRef.current = canvas;
    }

    const profile = virtualCameraProfileRef.current;
    if (canvas.width !== profile.width || canvas.height !== profile.height) {
      canvas.width = profile.width;
      canvas.height = profile.height;
    }

    stopMainVirtualCamRenderLoop();
    mainVirtualCamLastFrameSentAtRef.current = -1;

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: true,
    });

    if (!context) {
      return;
    }

    const renderContext = context;

    function scheduleNextFrame() {
      const currentVideo = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
      if (!currentVideo || !morphlyCamWindowEnabledRef.current) {
        mainVirtualCamRenderHandleRef.current = null;
        mainVirtualCamUsesVideoFrameCallbackRef.current = false;
        return;
      }

      if (currentVideo.requestVideoFrameCallback) {
        mainVirtualCamUsesVideoFrameCallbackRef.current = true;
        mainVirtualCamRenderHandleRef.current = currentVideo.requestVideoFrameCallback(renderFrame);
      } else {
        mainVirtualCamUsesVideoFrameCallbackRef.current = false;
        mainVirtualCamRenderHandleRef.current = window.requestAnimationFrame(renderFrame);
      }
    }

    function renderFrame(now: number) {
      const currentVideo = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
      const currentCanvas = mainVirtualCamCanvasRef.current;

      if (!morphlyCamWindowEnabledRef.current || !currentVideo || !currentCanvas) {
        mainVirtualCamRenderHandleRef.current = null;
        mainVirtualCamUsesVideoFrameCallbackRef.current = false;
        return;
      }

      if (
        currentVideo.readyState >= 2 &&
        currentVideo.videoWidth > 0 &&
        currentVideo.videoHeight > 0
      ) {
        const currentProfile = virtualCameraProfileRef.current;
        const frameIntervalMs = 1000 / currentProfile.frameRate;
        const nextFrameClock = getNextVirtualCameraFrameClock(
          mainVirtualCamLastFrameSentAtRef.current,
          now,
          frameIntervalMs,
        );
        if (nextFrameClock !== null) {
          if (currentCanvas.width !== currentProfile.width || currentCanvas.height !== currentProfile.height) {
            currentCanvas.width = currentProfile.width;
            currentCanvas.height = currentProfile.height;
          }

          renderContext.fillStyle = '#000000';
          renderContext.fillRect(0, 0, currentCanvas.width, currentCanvas.height);
          drawBottomUpVirtualCameraFrame(
            renderContext,
            currentVideo,
            currentCanvas.width,
            currentCanvas.height,
          );
          pushMorphlyCamFrame(currentCanvas, renderContext);
          mainVirtualCamLastFrameSentAtRef.current = nextFrameClock;
        }
      }

      scheduleNextFrame();
    }

    scheduleNextFrame();
  }, [pushMorphlyCamFrame, stopMainVirtualCamRenderLoop]);

  const renderMorphlyCamWindowShell = useCallback((popup: Window) => {
    const doc = popup.document;

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Morphly cam</title>
          <style>
            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              background: #fff;
              overflow: hidden;
              font-family: Arial, sans-serif;
            }

            body {
              display: flex;
              align-items: center;
              justify-content: center;
            }

            #morphly-cam-root {
              position: relative;
              width: 100vw;
              height: 100vh;
              background: #fff;
            }

            #morphly-cam-output {
              width: 100%;
              height: 100%;
              object-fit: contain;
              background: #fff;
            }

            #morphly-cam-video {
              position: absolute;
              width: 1px;
              height: 1px;
              opacity: 0;
              pointer-events: none;
            }

            #morphly-cam-placeholder {
              position: absolute;
              inset: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px;
              text-align: center;
              color: #20252d;
              background: #f6f7f9;
              font-size: 14px;
              line-height: 1.7;
              letter-spacing: 0.01em;
              transition: opacity 180ms ease;
            }

            #morphly-cam-status {
              position: absolute;
              left: 50%;
              bottom: 24px;
              transform: translateX(-50%);
              padding: 10px 14px;
              border: 1px solid #e1e4e9;
              border-radius: 999px;
              background: rgba(255, 255, 255, 0.95);
              color: #20252d;
              font-size: 12px;
              letter-spacing: 0.04em;
              backdrop-filter: blur(10px);
              transition: opacity 180ms ease;
            }
          </style>
        </head>
        <body>
          <div id="morphly-cam-root">
            <canvas id="morphly-cam-output" width="${MORPHLY_CAM_POPUP_WIDTH}" height="${MORPHLY_CAM_POPUP_HEIGHT}"></canvas>
            <video id="morphly-cam-video" autoplay playsinline muted></video>
            <div id="morphly-cam-placeholder">
              Start Morphly first, then capture this window in SplitCam or OBS. This window is not a standalone webcam device.
            </div>
            <div id="morphly-cam-status">Connecting Morphly cam...</div>
          </div>
        </body>
      </html>
    `);
    doc.close();
    doc.title = 'Morphly cam';

    morphlyCamCanvasRef.current = doc.getElementById('morphly-cam-output') as HTMLCanvasElement | null;
    morphlyCamVideoRef.current = doc.getElementById('morphly-cam-video') as HTMLVideoElement | null;
    morphlyCamStatusRef.current = doc.getElementById('morphly-cam-status') as HTMLDivElement | null;
    morphlyCamPlaceholderRef.current = doc.getElementById('morphly-cam-placeholder') as HTMLDivElement | null;

    if (latestRemoteStreamRef.current && morphlyCamVideoRef.current) {
      morphlyCamVideoRef.current.srcObject = latestRemoteStreamRef.current;
      void morphlyCamVideoRef.current.play().catch(() => {});
      startMorphlyCamRenderLoop();
      updateMorphlyCamStatus(null);
      updateMorphlyCamPlaceholder(null);
    } else {
      updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
    }

    popup.onbeforeunload = () => {
      stopMorphlyCamRenderLoop();
      resetMorphlyCamRefs();
    };
  }, [getMorphlyCamGuideMessage, resetMorphlyCamRefs, startMorphlyCamRenderLoop, stopMorphlyCamRenderLoop, updateMorphlyCamPlaceholder, updateMorphlyCamStatus]);

  const ensureMorphlyCamWindow = useCallback((statusMessage: string) => {
    if (typeof window === 'undefined') {
      return null;
    }

    const popup = morphlyCamWindowRef.current;
    if (!popup) {
      return null;
    }

    if (popup.closed) {
      resetMorphlyCamRefs();
      return null;
    }

    if (!popup.document.getElementById('morphly-cam-output') || !popup.document.getElementById('morphly-cam-video')) {
      renderMorphlyCamWindowShell(popup);
    }

    popup.document.title = 'Morphly cam';
    updateMorphlyCamStatus(statusMessage);

    if (!latestRemoteStreamRef.current) {
      updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
    }

    return popup;
  }, [getMorphlyCamGuideMessage, renderMorphlyCamWindowShell, resetMorphlyCamRefs, updateMorphlyCamPlaceholder, updateMorphlyCamStatus]);

  const syncMorphlyCamStream = useCallback((stream: MediaStream, statusMessage?: string | null) => {
    latestRemoteStreamRef.current = stream;

    if (!morphlyCamWindowEnabledRef.current) {
      return;
    }

    startMainVirtualCamRenderLoop();

    const popup = ensureMorphlyCamWindow(statusMessage ?? 'Preparing Morphly cam...');
    if (!popup || popup.closed) {
      return;
    }

    const popupVideo = morphlyCamVideoRef.current;
    if (!popupVideo) {
      return;
    }

    if (popupVideo.srcObject !== stream) {
      popupVideo.srcObject = stream;
    }

    popupVideo.playbackRate = 1;
    popupVideo.onloadedmetadata = () => {
      void popupVideo.play().catch(() => {});
      startMorphlyCamRenderLoop();
      updateMorphlyCamStatus(null);
      updateMorphlyCamPlaceholder(null);
    };

    if (popupVideo.readyState >= 2) {
      void popupVideo.play().catch(() => {});
      startMorphlyCamRenderLoop();
      updateMorphlyCamStatus(null);
      updateMorphlyCamPlaceholder(null);
    }
  }, [ensureMorphlyCamWindow, startMainVirtualCamRenderLoop, startMorphlyCamRenderLoop, updateMorphlyCamPlaceholder, updateMorphlyCamStatus]);

  const closeMorphlyCamWindow = useCallback((options?: { clearStream?: boolean }) => {
    if (options?.clearStream) {
      latestRemoteStreamRef.current = null;
    }

    stopMorphlyCamRenderLoop();
    stopMainVirtualCamRenderLoop();

    if (morphlyCamVideoRef.current) {
      morphlyCamVideoRef.current.srcObject = null;
    }

    const popup = morphlyCamWindowRef.current;
    if (popup && !popup.closed) {
      popup.close();
    }

    resetMorphlyCamRefs();
  }, [resetMorphlyCamRefs, stopMainVirtualCamRenderLoop, stopMorphlyCamRenderLoop]);

  const clearSoftReconnectTimer = useCallback(() => {
    if (softReconnectTimerRef.current) {
      clearTimeout(softReconnectTimerRef.current);
      softReconnectTimerRef.current = null;
    }
  }, []);

  const clearFrameWatchdog = useCallback(() => {
    if (frameWatchdogIntervalRef.current) {
      clearInterval(frameWatchdogIntervalRef.current);
      frameWatchdogIntervalRef.current = null;
    }
  }, []);

  const cancelRemoteFrameMonitor = useCallback(() => {
    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;

    if (video?.cancelVideoFrameCallback && frameCallbackHandleRef.current !== null) {
      video.cancelVideoFrameCallback(frameCallbackHandleRef.current);
    }

    frameCallbackHandleRef.current = null;
  }, []);

  const markRemoteFrameFresh = useCallback(() => {
    const confirmStartupFrame = firstFrameReadyRef.current;
    if (confirmStartupFrame) {
      confirmStartupFrame();
      return;
    }

    lastRemoteFrameAtRef.current = Date.now();

    if (!hasRemoteFrameRef.current) {
      hasRemoteFrameRef.current = true;
      setHasRemoteFrame(true);
      setUiStatus('Live');
    }
  }, []);

  const startRemoteFrameMonitor = useCallback(() => {
    cancelRemoteFrameMonitor();

    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
    if (!video?.requestVideoFrameCallback) {
      return;
    }

    const onFrame: VideoFrameRequestCallback = () => {
      markRemoteFrameFresh();
      frameCallbackHandleRef.current = video.requestVideoFrameCallback?.(onFrame) ?? null;
    };

    frameCallbackHandleRef.current = video.requestVideoFrameCallback(onFrame);
  }, [cancelRemoteFrameMonitor, markRemoteFrameFresh]);

  const stopWebcam = useCallback(() => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamStreamRef.current = null;
    }

    if (webcamSourceStreamRef.current) {
      webcamSourceStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamSourceStreamRef.current = null;
    }

    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }
  }, []);

  const disconnectRealtime = useCallback((options?: { skipStateUpdate?: boolean }) => {
    clearSoftReconnectTimer();
    clearFrameWatchdog();
    sessionEverConnectedRef.current = false;

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
      transformSyncTimerRef.current = null;
    }

    transformInFlightRef.current = false;
    pendingTransformRef.current = null;
    setIsSyncingTransform(false);

    if (realtimeClientRef.current) {
      void realtimeClientRef.current.disconnect().catch((error) => {
        console.warn('Failed to disconnect realtime session cleanly:', error);
      });
      realtimeClientRef.current = null;
    }

    cancelRemoteFrameMonitor();
    firstFrameReadyRef.current = null;
    lastRemoteFrameAtRef.current = 0;
    hasRemoteFrameRef.current = false;
    setHasRemoteFrame(false);

    if (outputVideoRef.current) {
      outputVideoRef.current.srcObject = null;
    }

    if (options?.skipStateUpdate) {
      latestRemoteStreamRef.current = null;
      updateMorphlyCamStatus('Reconnecting Morphly cam...');
      updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
    } else {
      closeMorphlyCamWindow();
    }

    lastAppliedTransformRef.current = null;
    setStreamMetrics(createEmptyStreamMetrics());
    if (!options?.skipStateUpdate) {
      setConnectionState('disconnected');
    }
  }, [
    cancelRemoteFrameMonitor,
    clearFrameWatchdog,
    clearSoftReconnectTimer,
    closeMorphlyCamWindow,
    getMorphlyCamGuideMessage,
    updateMorphlyCamPlaceholder,
    updateMorphlyCamStatus,
  ]);

  const getDesiredTransformState = useCallback((): TransformState => ({
    prompt: activePromptRef.current,
    enhance: DEFAULT_ENHANCE,
    image: referenceImageRef.current?.file ?? null,
    imageSignature: referenceImageRef.current?.signature ?? null,
  }), []);

  const applyTrackProfileWithFallback = useCallback(async (
    track: MediaStreamTrack,
    requestedMode: QualityMode,
    provider: RealtimeProvider,
  ): Promise<QualityMode> => {
    let attemptedMode = requestedMode;

    while (true) {
      try {
        track.contentHint = QUALITY_MODE_PROFILES[attemptedMode].contentHint;
        await track.applyConstraints(buildProviderVideoTrackConstraints(attemptedMode, provider));
        return attemptedMode;
      } catch (error) {
        if (attemptedMode === 'fast') {
          throw error;
        }

        attemptedMode = downgradeQualityMode(attemptedMode);
      }
    }
  }, []);

  const startWebcam = useCallback(async (
    requestedMode: QualityMode,
    options?: { forceNewStream?: boolean; silent?: boolean; provider?: RealtimeProvider },
  ): Promise<MediaStream | null> => {
    const provider = options?.provider ?? selectedProvider;
    if (!options?.forceNewStream && webcamSourceStreamRef.current) {
      const existingTrack = webcamSourceStreamRef.current.getVideoTracks()[0];

      if (existingTrack && existingTrack.readyState === 'live') {
        try {
          const appliedMode = await applyTrackProfileWithFallback(existingTrack, requestedMode, provider);

          webcamStreamRef.current = webcamSourceStreamRef.current;

          if (appliedMode !== requestedMode) {
            setRuntimeModeCap((currentMode) => clampQualityMode(currentMode, appliedMode));
          }

          if (webcamVideoRef.current) {
            webcamVideoRef.current.srcObject = webcamSourceStreamRef.current;
          }

          return webcamSourceStreamRef.current;
        } catch (error) {
          console.warn('Failed to update camera constraints in place:', error);
        }
      }
    }

    let attemptedMode = requestedMode;

    while (true) {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia(
          buildProviderVideoInputConstraints(attemptedMode, provider, selectedCameraId || undefined),
        );
        const nextTrack = nextStream.getVideoTracks()[0];

        if (nextTrack) {
          try {
            validateOpenedCameraTrack(nextTrack, selectedCameraId);
          } catch (error) {
            nextStream.getTracks().forEach((track) => track.stop());
            throw error;
          }
          nextTrack.contentHint = QUALITY_MODE_PROFILES[attemptedMode].contentHint;
        }

        const previousSourceStream = webcamSourceStreamRef.current;
        webcamSourceStreamRef.current = nextStream;
        webcamStreamRef.current = nextStream;

        if (webcamVideoRef.current) {
          webcamVideoRef.current.srcObject = nextStream;
        }

        if (previousSourceStream && previousSourceStream !== nextStream) {
          previousSourceStream.getTracks().forEach((track) => track.stop());
        }

        if (attemptedMode !== requestedMode) {
          setRuntimeModeCap((currentMode) => clampQualityMode(currentMode, attemptedMode));
        }

        return nextStream;
      } catch (error) {
        const isNotReadable =
          error instanceof DOMException && error.name === 'NotReadableError';

        // Retry the same exact physical device once in case the operating
        // system releases a transient camera lock between requests.
        if (isNotReadable && selectedCameraId) {
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia(
              buildProviderVideoInputConstraints(attemptedMode, provider, selectedCameraId),
            );
            const fallbackTrack = fallbackStream.getVideoTracks()[0];

            if (fallbackTrack) {
              fallbackTrack.contentHint = QUALITY_MODE_PROFILES[attemptedMode].contentHint;
            }
            if (!fallbackTrack) {
              fallbackStream.getTracks().forEach((track) => track.stop());
              throw new Error('The selected camera did not provide a video track.');
            }
            try {
              validateOpenedCameraTrack(fallbackTrack, selectedCameraId);
            } catch (error) {
              fallbackStream.getTracks().forEach((track) => track.stop());
              throw error;
            }

            const previousSourceStream = webcamSourceStreamRef.current;
            webcamSourceStreamRef.current = fallbackStream;
            webcamStreamRef.current = fallbackStream;

            if (webcamVideoRef.current) {
              webcamVideoRef.current.srcObject = fallbackStream;
            }

            if (previousSourceStream && previousSourceStream !== fallbackStream) {
              previousSourceStream.getTracks().forEach((track) => track.stop());
            }

            return fallbackStream;
          } catch {
            // fallback also failed — fall through to the give-up path below
          }
        }

        if (attemptedMode === 'fast') {
          console.error('Webcam error:', error);

          if (!options?.silent) {
            setDashboardError({
              title: 'Camera unavailable',
              message: isNotReadable
                ? 'Your camera or microphone is already in use by another application. Close it, then try again.'
                : 'Morphly could not access your camera or microphone. Check device permissions, then try again.',
              canRetry: true,
            });
          }

          return null;
        }

        attemptedMode = downgradeQualityMode(attemptedMode);
      }
    }
  }, [applyTrackProfileWithFallback, selectedCameraId, selectedProvider]);

  const flushTransformSync = useCallback(async (nextTransform: TransformState) => {
    const realtimeClient = realtimeClientRef.current;
    if (!realtimeClient) {
      return;
    }

    const nextSignature = buildTransformSignature(nextTransform);
    const lastSignature = lastAppliedTransformRef.current
      ? buildTransformSignature(lastAppliedTransformRef.current)
      : null;

    if (nextSignature === lastSignature) {
      return;
    }

    if (transformInFlightRef.current) {
      pendingTransformRef.current = nextTransform;
      return;
    }

    transformInFlightRef.current = true;
    setIsSyncingTransform(true);

    try {
      await realtimeClient.setTransform(nextTransform);

      lastAppliedTransformRef.current = nextTransform;
    } catch (error) {
      console.error('Failed to sync live transformation:', error);
      const fallback = 'Morphly could not apply that live update. The previous style is still active.';
      setDashboardError({
        title: 'Update not applied',
        message: sessionProviderRef.current === 'decart'
          ? getDecartRealtimeUserMessage(error, fallback)
          : getXmaxRealtimeUserMessage(error, fallback),
      });
    } finally {
      transformInFlightRef.current = false;
      setIsSyncingTransform(false);

      if (pendingTransformRef.current) {
        const queuedTransform = pendingTransformRef.current;
        pendingTransformRef.current = null;

        if (
          !lastAppliedTransformRef.current ||
          buildTransformSignature(queuedTransform) !== buildTransformSignature(lastAppliedTransformRef.current)
        ) {
          void flushTransformSync(queuedTransform);
        }
      }
    }
  }, []);

  const queueTransformSync = useCallback((nextTransform: TransformState, immediate = false) => {
    pendingTransformRef.current = nextTransform;

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
    }

    transformSyncTimerRef.current = setTimeout(() => {
      transformSyncTimerRef.current = null;
      const queuedTransform = pendingTransformRef.current;
      pendingTransformRef.current = null;

      if (queuedTransform) {
        void flushTransformSync(queuedTransform);
      }
    }, immediate ? 0 : TRANSFORM_SYNC_DEBOUNCE_MS);
  }, [flushTransformSync]);

  const connectToXmax = useCallback(async (
    stream: MediaStream,
    apiToken: string,
    initialTransform: TransformState,
    options?: { isRecovery?: boolean; modelName?: typeof XMAX_REALTIME_MODEL },
  ): Promise<RealtimeClient> => {
    let activeRealtimeClient: RealtimeClient | null = null;
    let activeRealtimeSession: { disconnect: () => Promise<void> } | null = null;
    let firstFrameSettled = false;
    let firstFrameDelivered = false;
    let resolveFirstFrame: (() => void) | null = null;
    let rejectFirstFrame: ((error: Error) => void) | null = null;
    const firstFramePromise = new Promise<void>((resolve, reject) => {
      resolveFirstFrame = resolve;
      rejectFirstFrame = reject;
    });
    void firstFramePromise.catch(() => {});

    const confirmFirstFrame = () => {
      if (firstFrameSettled) return;
      firstFrameSettled = true;
      firstFrameDelivered = true;
      if (firstFrameReadyRef.current === confirmFirstFrame) {
        firstFrameReadyRef.current = null;
      }
      markRemoteFrameFresh();
      resolveFirstFrame?.();
    };

    const failBeforeFirstFrame = (error: unknown) => {
      if (firstFrameSettled) return;
      firstFrameSettled = true;
      if (firstFrameReadyRef.current === confirmFirstFrame) {
        firstFrameReadyRef.current = null;
      }
      rejectFirstFrame?.(new Error(
        getRealtimeSdkErrorMessage(error) || 'Plus failed before delivering video output.',
      ));
    };

    try {
      cancelRemoteFrameMonitor();
      hasRemoteFrameRef.current = false;
      setHasRemoteFrame(false);
      lastRemoteFrameAtRef.current = 0;
      firstFrameReadyRef.current = confirmFirstFrame;
      setUiStatus(options?.isRecovery ? 'Reconnecting Plus...' : 'Connecting to Plus...');

      if (morphlyCamWindowEnabledRef.current && morphlyCamWindowRef.current && !morphlyCamWindowRef.current.closed) {
        updateMorphlyCamStatus(options?.isRecovery ? 'Reconnecting Morphly cam...' : 'Connecting Morphly cam...');
        updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
      }

      const {
        createXmaxClient,
        models,
      } = await import('@xmaxai/sdk-global');
      const client = createXmaxClient({
        apiKey: apiToken,
      });
      const model = models.realtime(options?.modelName || XMAX_REALTIME_MODEL);
      const resolveContext = async (transform: TransformState) => {
        let refImageUrl: string | null = null;

        if (transform.image && transform.imageSignature) {
          refImageUrl = xmaxReferenceUrlCacheRef.current.get(transform.imageSignature) ?? null;
          if (!refImageUrl) {
            const upload = await client.files.uploadAndCheckImage(transform.image);
            refImageUrl = upload.url;
            xmaxReferenceUrlCacheRef.current.set(transform.imageSignature, refImageUrl);
          }
        }

        return buildXmaxRealtimeContext(transform, refImageUrl);
      };
      const initialContext = await resolveContext(initialTransform);
      const qualityProfile = QUALITY_MODE_PROFILES[activeModeRef.current];
      const streamSetting = {
        width: qualityProfile.width,
        height: qualityProfile.height,
        fps: qualityProfile.targetFps,
        maxKbps: qualityProfile.maxKbps,
        contentHint: qualityProfile.contentHint,
      };

      const realtimeSession = await client.realtime.connect(stream, {
        model,
        stream: streamSetting,
        audio: { publish: false, subscribe: false },
        context: initialContext,
        autoStart: true,
        onRemoteStream: (editedStream: MediaStream) => {
          const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
          if (!video) {
            return;
          }

          if (video.srcObject !== editedStream) {
            video.srcObject = editedStream;
          }

          video.playbackRate = 1;
          video.latencyHint = 'interactive';

          let readinessArmed = false;
          const playRemote = () => {
            if (readinessArmed) return;
            readinessArmed = true;
            void video.play().catch(() => {});

            if (video.requestVideoFrameCallback) {
              frameCallbackHandleRef.current = video.requestVideoFrameCallback(() => {
                frameCallbackHandleRef.current = null;
                confirmFirstFrame();
                startRemoteFrameMonitor();
              });
              return;
            }

            const confirmLoadedFrame = () => {
              if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
                confirmFirstFrame();
                startRemoteFrameMonitor();
              }
            };

            video.addEventListener('loadeddata', confirmLoadedFrame, { once: true });
            confirmLoadedFrame();
          };

          video.onloadedmetadata = playRemote;
          playRemote();

          syncMorphlyCamStream(
            editedStream,
            options?.isRecovery ? 'Reconnecting Morphly cam...' : 'Connecting Morphly cam...',
          );
        },
        onRemoteVideoFirstFrame: (info) => {
          console.info(`[Xmax] remote output received: ${info.width}x${info.height}`);
          setStreamMetrics((current) => ({
            ...current,
            frameWidth: info.width,
            frameHeight: info.height,
          }));
          confirmFirstFrame();
          startRemoteFrameMonitor();
        },
        onStateChange: (state) => {
          const nextState: ConnectionState = state === 'running'
            ? 'generating'
            : state === 'idle'
              ? 'connected'
              : 'disconnected';
          connectionStateRef.current = nextState;
          setConnectionState(nextState);

          if (nextState === 'connected' || nextState === 'generating') {
            sessionEverConnectedRef.current = true;
            restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
            restartFailureCountRef.current = 0;
            setDashboardError((current) => current?.title === 'Plus stream interrupted' ? null : current);
            setUiStatus(hasRemoteFrameRef.current ? 'Live' : 'Preparing Plus output...');
          }
        },
        onDisconnect: (reason) => {
          connectionStateRef.current = 'disconnected';
          setConnectionState('disconnected');
          setUiStatus('Disconnected');
          void flushBillableUsage();

          if (!hasRemoteFrameRef.current) {
            failBeforeFirstFrame(new Error(`Plus disconnected before delivering video output (${reason}).`));
          } else if (reason !== 'client' && !restartInFlightRef.current && isStreamingRef.current) {
            void restartRealtimeSessionRef.current?.(`xmax-disconnect-${reason}`);
          }
        },
        onError: (message, error) => {
          const hadFirstFrame = firstFrameDelivered;
          console.error(`[Xmax] realtime error (${error.code}): ${message}`);
          failBeforeFirstFrame(error);
          if (hadFirstFrame) {
            setDashboardError({
              title: 'Plus stream interrupted',
              message: getXmaxRealtimeUserMessage(error),
            });
          }
        },
      });
      activeRealtimeSession = realtimeSession;
      const mapSessionState = (): ConnectionState => realtimeSession.state === 'running'
        ? 'generating'
        : realtimeSession.state === 'idle'
          ? 'connected'
          : 'disconnected';
      const realtimeClient: RealtimeClient = {
        disconnect: () => realtimeSession.disconnect(),
        setTransform: async (transform) => {
          await realtimeSession.set(await resolveContext(transform));
        },
        getConnectionState: mapSessionState,
        getSessionUid: () => realtimeSession.getSessionUid(),
      };
      activeRealtimeClient = realtimeClient;
      sessionEverConnectedRef.current = true;

      realtimeClientRef.current = realtimeClient;
      const currentState = realtimeClient.getConnectionState();
      connectionStateRef.current = currentState;
      setConnectionState(currentState);
      setUiStatus('Preparing Plus output...');
      setStreamMetrics(createEmptyStreamMetrics());

      lastAppliedTransformRef.current = initialTransform;
      console.log('[Xmax] X2 startup context acknowledged.');

      await withTimeout(
        firstFramePromise,
        AI_FIRST_FRAME_TIMEOUT_MS,
        `Plus connected but no video output arrived within ${AI_FIRST_FRAME_TIMEOUT_MS / 1000}s.`,
      );

      if (!firstFrameTrackedRef.current) {
        firstFrameTrackedRef.current = true;
        trackFirstFrameReceived(sessionIdRef.current || undefined);
      }

      return realtimeClient;
    } catch (error) {
      firstFrameSettled = true;
      if (firstFrameReadyRef.current === confirmFirstFrame) {
        firstFrameReadyRef.current = null;
      }
      const errorMessage = getRealtimeSdkErrorMessage(error) || 'Unknown Xmax SDK error';
      console.error(`[Xmax] SDK error: ${errorMessage}`);
      if (realtimeClientRef.current === activeRealtimeClient) {
        realtimeClientRef.current = null;
      }
      if (activeRealtimeSession) {
        await activeRealtimeSession.disconnect().catch(() => {});
      }
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }, [
    cancelRemoteFrameMonitor,
    flushBillableUsage,
    getMorphlyCamGuideMessage,
    markRemoteFrameFresh,
    syncMorphlyCamStream,
    startRemoteFrameMonitor,
    updateMorphlyCamPlaceholder,
    updateMorphlyCamStatus,
  ]);

  const connectToDecart = useCallback(async (
    stream: MediaStream,
    apiToken: string,
    initialTransform: TransformState,
    options?: { isRecovery?: boolean; modelName?: typeof DECART_REALTIME_MODEL },
  ): Promise<RealtimeClient> => {
    let activeRealtimeClient: RealtimeClient | null = null;
    let activeRealtimeSession: DecartRealtimeSession | null = null;
    let firstFrameSettled = false;
    let firstFrameDelivered = false;
    let resolveFirstFrame: (() => void) | null = null;
    let rejectFirstFrame: ((error: Error) => void) | null = null;
    const firstFramePromise = new Promise<void>((resolve, reject) => {
      resolveFirstFrame = resolve;
      rejectFirstFrame = reject;
    });
    void firstFramePromise.catch(() => {});

    const confirmFirstFrame = () => {
      if (firstFrameSettled) return;
      firstFrameSettled = true;
      firstFrameDelivered = true;
      if (firstFrameReadyRef.current === confirmFirstFrame) {
        firstFrameReadyRef.current = null;
      }
      markRemoteFrameFresh();
      resolveFirstFrame?.();
    };

    const failBeforeFirstFrame = (error: unknown) => {
      if (firstFrameSettled) return;
      firstFrameSettled = true;
      if (firstFrameReadyRef.current === confirmFirstFrame) {
        firstFrameReadyRef.current = null;
      }
      rejectFirstFrame?.(new Error(
        getRealtimeSdkErrorMessage(error) || 'Pro failed before delivering video output.',
      ));
    };

    try {
      cancelRemoteFrameMonitor();
      hasRemoteFrameRef.current = false;
      setHasRemoteFrame(false);
      lastRemoteFrameAtRef.current = 0;
      firstFrameReadyRef.current = confirmFirstFrame;
      setUiStatus(options?.isRecovery ? 'Reconnecting Pro...' : 'Connecting to Pro...');

      if (morphlyCamWindowEnabledRef.current && morphlyCamWindowRef.current && !morphlyCamWindowRef.current.closed) {
        updateMorphlyCamStatus(options?.isRecovery ? 'Reconnecting Morphly cam...' : 'Connecting Morphly cam...');
        updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
      }

      const { createDecartClient, models } = await import('@decartai/sdk');
      const client = createDecartClient({ apiKey: apiToken });
      const model = models.realtime(options?.modelName || DECART_REALTIME_MODEL);
      const initialInput = {
        prompt: initialTransform.prompt,
        enhance: initialTransform.enhance,
        ...(initialTransform.image ? { image: initialTransform.image } : {}),
      };

      const handleConnectionChange = (nextState: ConnectionState) => {
        connectionStateRef.current = nextState;
        setConnectionState(nextState);

        if (nextState === 'connected' || nextState === 'generating') {
          sessionEverConnectedRef.current = true;
          restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
          restartFailureCountRef.current = 0;
          setDashboardError((current) => current?.title === 'Pro stream interrupted' ? null : current);
          setUiStatus(hasRemoteFrameRef.current ? 'Live' : 'Preparing Pro output...');
          return;
        }

        if (nextState === 'disconnected') {
          setUiStatus('Disconnected');
          void flushBillableUsage();

          if (!hasRemoteFrameRef.current) {
            failBeforeFirstFrame(new Error('Pro disconnected before delivering video output.'));
          } else if (!restartInFlightRef.current && isStreamingRef.current) {
            void restartRealtimeSessionRef.current?.('decart-disconnected');
          }
        }
      };

      const realtimeSession = await client.realtime.connect(stream, {
        model,
        mirror: 'auto',
        resolution: '720p',
        onConnectionChange: handleConnectionChange,
        onRemoteStream: (editedStream: MediaStream) => {
          const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
          if (!video) return;

          if (video.srcObject !== editedStream) {
            video.srcObject = editedStream;
          }

          video.playbackRate = 1;
          video.latencyHint = 'interactive';

          let readinessArmed = false;
          const playRemote = () => {
            if (readinessArmed) return;
            readinessArmed = true;
            void video.play().catch(() => {});

            if (video.requestVideoFrameCallback) {
              frameCallbackHandleRef.current = video.requestVideoFrameCallback(() => {
                frameCallbackHandleRef.current = null;
                setStreamMetrics((current) => ({
                  ...current,
                  frameWidth: video.videoWidth,
                  frameHeight: video.videoHeight,
                }));
                confirmFirstFrame();
                startRemoteFrameMonitor();
              });
              return;
            }

            const confirmLoadedFrame = () => {
              if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
                setStreamMetrics((current) => ({
                  ...current,
                  frameWidth: video.videoWidth,
                  frameHeight: video.videoHeight,
                }));
                confirmFirstFrame();
                startRemoteFrameMonitor();
              }
            };

            video.addEventListener('loadeddata', confirmLoadedFrame, { once: true });
            confirmLoadedFrame();
          };

          video.onloadedmetadata = playRemote;
          playRemote();

          syncMorphlyCamStream(
            editedStream,
            options?.isRecovery ? 'Reconnecting Morphly cam...' : 'Connecting Morphly cam...',
          );
        },
      });
      activeRealtimeSession = realtimeSession;

      const handleError = (error: unknown) => {
        const hadFirstFrame = firstFrameDelivered;
        console.error('[Decart] realtime error:', error);
        failBeforeFirstFrame(error);
        if (hadFirstFrame) {
          setDashboardError({
            title: 'Pro stream interrupted',
            message: getDecartRealtimeUserMessage(error),
          });
        }
      };
      realtimeSession.on('error', handleError);

      // Establish transport before requesting generation. Sending an image in
      // initialState makes provider-side moderation, quota, and credit errors
      // look like reconnectable handshake failures inside the SDK. Applying
      // the initial input after connect surfaces those permanent errors at once.
      setUiStatus('Preparing Pro output...');
      const initialUpdatePromise = realtimeSession.set(initialInput);
      void initialUpdatePromise.catch(() => {});
      await Promise.race([initialUpdatePromise, firstFramePromise]);

      const realtimeClient: RealtimeClient = {
        disconnect: async () => {
          realtimeSession.off('error', handleError);
          realtimeSession.disconnect();
        },
        setTransform: async (transform) => {
          await realtimeSession.set({
            prompt: transform.prompt,
            enhance: transform.enhance,
            image: transform.image,
          });
        },
        getConnectionState: () => realtimeSession.getConnectionState(),
        getSessionUid: () => realtimeSession.sessionId,
      };
      activeRealtimeClient = realtimeClient;
      sessionEverConnectedRef.current = true;
      realtimeClientRef.current = realtimeClient;

      const currentState = realtimeClient.getConnectionState();
      connectionStateRef.current = currentState;
      setConnectionState(currentState);
      setUiStatus('Preparing Pro output...');
      setStreamMetrics(createEmptyStreamMetrics());
      lastAppliedTransformRef.current = initialTransform;
      console.log('[Decart] Lucy 2.5 startup state acknowledged.');

      await withTimeout(
        firstFramePromise,
        AI_FIRST_FRAME_TIMEOUT_MS,
        `Pro connected but no video output arrived within ${AI_FIRST_FRAME_TIMEOUT_MS / 1000}s.`,
      );

      if (!firstFrameTrackedRef.current) {
        firstFrameTrackedRef.current = true;
        trackFirstFrameReceived(sessionIdRef.current || undefined);
      }

      return realtimeClient;
    } catch (error) {
      firstFrameSettled = true;
      if (firstFrameReadyRef.current === confirmFirstFrame) {
        firstFrameReadyRef.current = null;
      }
      const errorMessage = getRealtimeSdkErrorMessage(error) || 'Unknown Decart SDK error';
      console.error(`[Decart] SDK error: ${errorMessage}`);
      if (realtimeClientRef.current === activeRealtimeClient) {
        realtimeClientRef.current = null;
      }
      activeRealtimeSession?.disconnect();
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }, [
    cancelRemoteFrameMonitor,
    flushBillableUsage,
    getMorphlyCamGuideMessage,
    markRemoteFrameFresh,
    syncMorphlyCamStream,
    startRemoteFrameMonitor,
    updateMorphlyCamPlaceholder,
    updateMorphlyCamStatus,
  ]);

  const connectToRealtimeProvider = useCallback(async (
    provider: RealtimeProvider,
    stream: MediaStream,
    apiToken: string,
    initialTransform: TransformState,
    options?: { isRecovery?: boolean; modelName?: string },
  ) => {
    if (provider === 'decart') {
      return connectToDecart(stream, apiToken, initialTransform, {
        isRecovery: options?.isRecovery,
        modelName: options?.modelName === DECART_REALTIME_MODEL
          ? DECART_REALTIME_MODEL
          : DECART_REALTIME_MODEL,
      });
    }

    return connectToXmax(stream, apiToken, initialTransform, {
      isRecovery: options?.isRecovery,
      modelName: options?.modelName === XMAX_REALTIME_MODEL
        ? XMAX_REALTIME_MODEL
        : XMAX_REALTIME_MODEL,
    });
  }, [connectToDecart, connectToXmax]);

  const restartRealtimeSession = useCallback(async (
    reason: string,
    options?: { immediate?: boolean },
  ) => {
    if (!isStreamingRef.current || restartInFlightRef.current || !sessionTokenRef.current) {
      return;
    }

    restartInFlightRef.current = true;
    setUiStatus('Reconnecting...');
    const recoveryProvider = sessionProviderRef.current;
    const recoveryProviderLabel = getRealtimeProviderLabel(recoveryProvider);

    try {
      if (!options?.immediate) {
        await sleep(restartRetryDelayRef.current);
      }

      if (!isStreamingRef.current || !sessionTokenRef.current) {
        return;
      }

      const existingTrack = webcamSourceStreamRef.current?.getVideoTracks()[0];
      const currentStream = webcamStreamRef.current && webcamSourceStreamRef.current && existingTrack?.readyState === 'live'
        ? webcamStreamRef.current
        : await startWebcam(activeModeRef.current, {
            forceNewStream: true,
            silent: true,
            provider: recoveryProvider,
          });

      if (!currentStream) {
        throw new Error(`The selected camera is unavailable during ${recoveryProviderLabel} recovery.`);
      }

      disconnectRealtime({ skipStateUpdate: true });

      const reconnectedClient = await connectToRealtimeProvider(
        recoveryProvider,
        currentStream,
        sessionTokenRef.current,
        getDesiredTransformState(),
        {
          isRecovery: true,
          modelName: sessionRealtimeModelRef.current,
        },
      );

      if (!reconnectedClient) {
        throw new Error(`Restart failed: ${reason}`);
      }

      restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
      restartFailureCountRef.current = 0;
      setUiStatus('Live');
    } catch (error) {
      console.error(`[${recoveryProviderLabel}] Restart failed:`, error);
      restartFailureCountRef.current += 1;
      restartRetryDelayRef.current = Math.min(restartRetryDelayRef.current * 2, MAX_RETRY_DELAY_MS);

      if (isStreamingRef.current && sessionTokenRef.current) {
        clearSoftReconnectTimer();
        softReconnectTimerRef.current = setTimeout(() => {
          softReconnectTimerRef.current = null;
          void restartRealtimeSessionRef.current?.('retry-after-failed-restart', { immediate: true });
        }, restartRetryDelayRef.current);
      }
    } finally {
      restartInFlightRef.current = false;
    }
  }, [clearSoftReconnectTimer, connectToRealtimeProvider, disconnectRealtime, getDesiredTransformState, startWebcam]);

  useEffect(() => {
    restartRealtimeSessionRef.current = restartRealtimeSession;
    return () => {
      restartRealtimeSessionRef.current = null;
    };
  }, [restartRealtimeSession]);

  const safelyStopSession = useCallback(async () => {
    if (safeStopInFlightRef.current) {
      return;
    }

    safeStopInFlightRef.current = true;

    try {
      try {
        await realtimeClientRef.current?.disconnect();
      } catch (error) {
        console.warn('Failed to disconnect realtime client cleanly:', error);
      }

      await handleStopRef.current?.({ silent: true });
    } finally {
      safeStopInFlightRef.current = false;
    }
  }, []);

  const handleStop = useCallback(async (options?: { silent?: boolean }) => {
    const activeUserId = user?.id;
    const activeSessionId = sessionIdRef.current || undefined;
    const shouldEndSession = Boolean(sessionTokenRef.current);

    if (connectionStateRef.current === 'generating') {
      recordBillableGenerationTime();
    }
    clearGenerationMeterInterval();
    clearUsageFlushInterval();
    const usageFlushed = await flushBillableUsage({ keepalive: true, suppressAutoStop: true });
    const finalSecondsDelta = usageFlushed ? 0 : Math.floor(pendingBillableSecondsRef.current);

    const endSessionPromise = shouldEndSession
      ? apiRequest<{ remainingCredits?: number }>('/end-session', {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({
            userId: activeUserId,
            sessionId: activeSessionId,
            secondsDelta: finalSecondsDelta > 0 ? finalSecondsDelta : undefined,
          }),
        })
      : null;

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    // Disarm the virtual camera publisher and disable the popup window
    morphlyCamWindowEnabledRef.current = false;
    if (window.electron) {
      void window.electron.invoke('virtual-camera:stop').catch((err: unknown) => {
        console.warn('Failed to stop virtual camera publisher:', err);
      });
    }

    sessionTokenRef.current = '';
    sessionIdRef.current = '';
    sessionProviderRef.current = DEFAULT_REALTIME_PROVIDER;
    sessionRealtimeModelRef.current = XMAX_REALTIME_MODEL;
    xmaxReferenceUrlCacheRef.current.clear();
    firstFrameTrackedRef.current = false;
    resetBillableUsageTracking();
    isStreamingRef.current = false;
    restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
    restartFailureCountRef.current = 0;
    setRuntimeModeCap('hd');
    clearSoftReconnectTimer();
    clearFrameWatchdog();
    disconnectRealtime();
    stopWebcam();
    setIsStreaming(false);
    setSessionStatus('IDLE');
    setUiStatus('Disconnected');

    if (!options?.silent) {
      trackSessionCompleted(activeSessionId);
    }

    if (endSessionPromise) {
      void endSessionPromise
        .then((response) => {
          if (response.remainingCredits !== undefined) {
            setCredits(response.remainingCredits);
          }
        })
        .catch((error) => {
          console.error('Stop session error:', error);
        });
    }
  }, [
    clearFrameWatchdog,
    clearGenerationMeterInterval,
    clearSoftReconnectTimer,
    clearUsageFlushInterval,
    disconnectRealtime,
    flushBillableUsage,
    recordBillableGenerationTime,
    resetBillableUsageTracking,
    setCredits,
    setSessionStatus,
    stopWebcam,
    user?.id,
  ]);

  useEffect(() => {
    handleStopRef.current = handleStop;
  }, [handleStop]);

  useEffect(() => {
    safelyStopSessionRef.current = safelyStopSession;
  }, [safelyStopSession]);

  // Polls /api/session-status every 5 s while streaming.
  // The server computes the live remaining balance from recorded generation time.
  // Credits are deducted server-side by end-session.
  const pollSessionStatus = useCallback(async () => {
    if (!user?.id) return;
    try {
      const response = await apiRequest<{
        credits: number;
        remainingCredits?: number;
        shouldStop: boolean;
        forceEnd?: boolean;
      }>(`/session-status?userId=${user.id}`);

      const live = response.remainingCredits ?? response.credits;
      setCredits(live);

      if (response.shouldStop || response.forceEnd) {
        await handleStop({ silent: true });
        setDashboardError({
          title: 'Session ended',
          message: 'Your credit balance is too low to continue. Add credits, then start again.',
        });
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, [handleStop, setCredits, user?.id]);

  const refreshCameras = useCallback(async (
    options?: { requestPermission?: boolean; notifyIfMissing?: boolean },
  ) => {
    setIsRefreshingCameras(true);

    try {
      const result = await enumeratePhysicalCameras({
        requestPermission: options?.requestPermission,
      });
      const previousSelection = selectedCameraIdRef.current;
      const storageKey = user?.id
        ? `${SELECTED_CAMERA_STORAGE_PREFIX}:${user.id}`
        : SELECTED_CAMERA_STORAGE_PREFIX;
      const storedSelection = localStorage.getItem(storageKey) || '';
      const physicalIds = new Set(result.physicalCameras.map((device) => device.deviceId));

      setAllVideoInputDevices(result.allVideoInputs);
      setCameraDevices(result.physicalCameras);
      setVirtualCameraDevices(result.virtualCameras);
      setCameraPermission(result.permission);
      setCameraError(null);

      if (previousSelection && physicalIds.has(previousSelection)) {
        return result;
      }

      if (previousSelection && !physicalIds.has(previousSelection)) {
        const message = 'The selected camera is no longer available. Please select another physical camera.';
        selectedCameraIdRef.current = '';
        setSelectedCameraId('');
        localStorage.removeItem(storageKey);
        setCameraError(message);

        if (options?.notifyIfMissing) {
          setDashboardError({
            title: 'Camera disconnected',
            message,
          });
        }

        if (isStreamingRef.current) {
          void safelyStopSessionRef.current?.();
        }
      }

      const nextSelection = physicalIds.has(storedSelection)
        ? storedSelection
        : result.physicalCameras.length === 1
          ? result.physicalCameras[0].deviceId
          : '';

      selectedCameraIdRef.current = nextSelection;
      setSelectedCameraId(nextSelection);
      if (nextSelection) localStorage.setItem(storageKey, nextSelection);

      if (result.physicalCameras.length === 0) {
        setCameraError(
          'No physical camera was detected. Connect or enable your laptop camera, allow camera permission, then refresh the camera list.',
        );
      }

      return result;
    } catch (error) {
      console.error('Failed to enumerate cameras:', error);
      const permissionDenied = error instanceof DOMException
        && ['NotAllowedError', 'SecurityError'].includes(error.name);
      const message = permissionDenied
        ? 'Camera permission is required. Allow access, then refresh the camera list.'
        : 'No physical camera was detected. Connect or enable your laptop camera, allow camera permission, then refresh the camera list.';
      setCameraPermission(permissionDenied ? 'denied' : 'unknown');
      setAllVideoInputDevices([]);
      setCameraDevices([]);
      setVirtualCameraDevices([]);
      setCameraError(message);
      return null;
    } finally {
      setIsRefreshingCameras(false);
    }
  }, [user?.id]);

  useEffect(() => () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    clearUsageFlushInterval();
    clearGenerationMeterInterval();

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
    }

    clearSoftReconnectTimer();
    clearFrameWatchdog();
    cancelRemoteFrameMonitor();
    closeMorphlyCamWindow({ clearStream: true });
    void realtimeClientRef.current?.disconnect();
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamSourceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, [cancelRemoteFrameMonitor, clearFrameWatchdog, clearGenerationMeterInterval, clearSoftReconnectTimer, clearUsageFlushInterval, closeMorphlyCamWindow]);

  useEffect(() => {
    if (!navigator.mediaDevices) return undefined;

    void refreshCameras({ requestPermission: true });
    return subscribeToCameraDeviceChanges(navigator.mediaDevices, () => {
      void refreshCameras({ notifyIfMissing: true });
    });
  }, [refreshCameras]);

  useEffect(() => {
    if (!isStreaming) {
      hasRemoteFrameRef.current = false;
      clearFrameWatchdog();
      setHasRemoteFrame(false);
      return undefined;
    }

    return undefined;
  }, [clearFrameWatchdog, isStreaming]);

  // Start the usage-flush interval only once the user can see AI output.
  useEffect(() => {
    if (!isStreaming || !hasRemoteFrame) {
      return;
    }

    if (usageFlushIntervalRef.current) {
      return;
    }

    usageFlushIntervalRef.current = setInterval(() => {
      void flushBillableUsage();
    }, POLLING_INTERVAL);
  }, [isStreaming, hasRemoteFrame, flushBillableUsage]);

  useEffect(() => {
    if (!isStreaming || !hasRemoteFrame || connectionState !== 'generating') {
      clearGenerationMeterInterval();
      return undefined;
    }

    recordBillableGenerationTime();
    generationMeterIntervalRef.current = setInterval(
      recordBillableGenerationTime,
      1000,
    );

    return clearGenerationMeterInterval;
  }, [
    clearGenerationMeterInterval,
    connectionState,
    hasRemoteFrame,
    isStreaming,
    recordBillableGenerationTime,
  ]);

  useEffect(() => {
    if (!isStreaming) {
      clearSoftReconnectTimer();
      return;
    }

    if (connectionState === 'disconnected' && !restartInFlightRef.current && sessionEverConnectedRef.current) {
      clearSoftReconnectTimer();
      void restartRealtimeSession(`${sessionProviderRef.current}-disconnected-state`);
      return undefined;
    }

    if (connectionState === 'connected' || connectionState === 'generating' || connectionState === 'connecting' || connectionState === 'reconnecting') {
      clearSoftReconnectTimer();
    }

    return undefined;
  }, [clearSoftReconnectTimer, connectionState, isStreaming, restartRealtimeSession]);

  useEffect(() => {
    if (!isStreaming) {
      clearFrameWatchdog();
      return;
    }

    clearFrameWatchdog();
    frameWatchdogIntervalRef.current = setInterval(() => {
      const currentState = connectionStateRef.current;
      if (!['connected', 'generating', 'reconnecting'].includes(currentState)) {
        return;
      }

      const frameLag = Date.now() - lastRemoteFrameAtRef.current;

      if (frameLag > FREEZE_RESTART_THRESHOLD_MS) {
        console.warn('Stream frozen. Restarting realtime session...');
        void flushBillableUsage();
        void restartRealtimeSession('remote-frame-watchdog');
      }
    }, RESTART_WATCHDOG_INTERVAL_MS);

    return clearFrameWatchdog;
  }, [clearFrameWatchdog, flushBillableUsage, isStreaming, restartRealtimeSession]);

  useEffect(() => {
    if (!isStreaming) {
      return;
    }

    void startWebcam(activeMode, { silent: true, provider: selectedProvider }).catch((error) => {
      console.error('Failed to apply camera profile:', error);
    });
  }, [activeMode, isStreaming, selectedProvider, startWebcam]);

  useEffect(() => {
    if (!isStreaming || !realtimeClientRef.current) {
      return;
    }

    queueTransformSync(getDesiredTransformState());
  }, [
    isStreaming,
    activePrompt,
    getDesiredTransformState,
    queueTransformSync,
    referenceImage?.file,
    referenceImage?.signature,
  ]);

  useEffect(() => {
    if (!selectedCameraId) {
      return;
    }

    if (!previousCameraIdRef.current) {
      previousCameraIdRef.current = selectedCameraId;
      return;
    }

    if (previousCameraIdRef.current === selectedCameraId) {
      return;
    }

    previousCameraIdRef.current = selectedCameraId;

    if (!isStreaming) {
      userInitiatedCameraChangeRef.current = false;
      return;
    }

    if (!userInitiatedCameraChangeRef.current) {
      return;
    }

    if (!['connected', 'generating'].includes(connectionStateRef.current)) {
      return;
    }

    void (async () => {
      const stream = await startWebcam(activeMode, {
        forceNewStream: true,
        silent: true,
        provider: selectedProvider,
      });

      if (stream) {
        await restartRealtimeSession('camera-switched', { immediate: true });
      }

      userInitiatedCameraChangeRef.current = false;
    })();
  }, [activeMode, isStreaming, restartRealtimeSession, selectedCameraId, selectedProvider, startWebcam]);

  const selectedVideoDevice = allVideoInputDevices.find((device) =>
    device.deviceId === selectedCameraId);
  const selectedDeviceIsVirtual = Boolean(
    selectedVideoDevice && isVirtualCamera(selectedVideoDevice.label),
  );

  const getStartBlockReason = () => {
    if (!selectedCameraId) return 'Select your physical laptop camera first.';
    if (selectedDeviceIsVirtual) {
      return 'Virtual cameras cannot be used as the Morphly input. Select your integrated or USB hardware camera.';
    }
    if (cameraPermission === 'denied') {
      return 'Camera permission is required. Allow access, then refresh the camera list.';
    }
    if (!referenceImage && activeBgPreset === 'original' && !customBgPrompt.trim()) {
      return 'Upload a reference image before starting.';
    }
    if (isValidatingImage) return 'Morphly is checking the reference image.';
    if (credits < CREDITS_PER_SECOND) {
      return 'You do not have enough credits. Buy credits to continue.';
    }
    if (!isEngineReady) return engineLoadError || 'The Morphly engine is not ready yet.';
    if (isUpdaterBlocking) return 'Wait for the application update process to finish.';
    if (isLoading) return 'Morphly is already starting.';
    if (isStreaming) return 'Morphly is already streaming.';
    return null;
  };

  const startBlockReason = getStartBlockReason();

  const revalidateStartRequirements = async () => {
    const latestCameras = await enumeratePhysicalCameras();
    const selectedDevice = validateSelectedPhysicalCamera(
      selectedCameraIdRef.current,
      latestCameras.allVideoInputs,
    );

    if (!referenceImageRef.current && activeBgPresetRef.current === 'original' && !customBgPromptRef.current.trim()) {
      throw new Error('Upload a reference image before starting.');
    }
    if (!isEngineReady) {
      throw new Error(engineLoadError || 'The Morphly engine is not ready yet.');
    }
    if (credits < CREDITS_PER_SECOND) {
      throw new Error('You do not have enough credits. Buy credits to continue.');
    }
    if (isUpdaterBlocking) {
      throw new Error('Wait for the application update process to finish.');
    }

    if (window.electron?.invoke) {
      const trustedValidation = await window.electron.invoke('camera:validate-selection', {
        selectedDeviceId: selectedDevice.deviceId,
        selectedLabel: selectedDevice.label,
        availableDevices: latestCameras.allVideoInputs.map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          kind: device.kind,
        })),
      });

      if (!trustedValidation?.valid) {
        throw new Error(trustedValidation?.error || 'The selected camera could not be validated.');
      }
    }

    setAllVideoInputDevices(latestCameras.allVideoInputs);
    setCameraDevices(latestCameras.physicalCameras);
    setVirtualCameraDevices(latestCameras.virtualCameras);
    setCameraPermission(latestCameras.permission);
  };

  const handleStart = async () => {
    const requestedProvider = selectedProvider;
    const requestedProviderLabel = getRealtimeProviderLabel(requestedProvider);
    const startupStartedAt = performance.now();
    setDashboardError(null);
    setIsLoading(true);
    setUiStatus('Checking stream setup...');
    try {
      await revalidateStartRequirements();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Morphly could not validate the stream setup.';
      if (/camera|permission/i.test(message)) {
        setCameraError(message);
        void refreshCameras();
      }
      setDashboardError({
        title: 'Check your stream setup',
        message,
        canRetry: true,
      });
      setIsLoading(false);
      return;
    }

    setConnectionState('connecting');
    setUiStatus('Connecting...');
    trackConnectionStarted(undefined, { provider: requestedProvider });
    setRuntimeModeCap('hd');
    resetBillableUsageTracking();
    firstFrameTrackedRef.current = false;

    // Arm the virtual camera publisher. The live frames come from the main
    // Morphly output stream; the popup, if opened, is only an optional mirror.
    morphlyCamWindowEnabledRef.current = true;
    const virtualCameraStartPromise = window.electron
      ? window.electron.invoke('virtual-camera:start').catch((err: unknown) => {
          console.warn('Failed to arm virtual camera publisher:', err);
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown virtual camera error',
          };
        })
      : Promise.resolve(null);

    // The virtual camera is an optional output. Do not make webcam/provider startup
    // wait for driver probing or fail when Windows cannot register the device.
    void virtualCameraStartPromise.then((virtualCameraStartResult) => {
      if (virtualCameraStartResult && virtualCameraStartResult.success === false) {
        morphlyCamWindowEnabledRef.current = false;
        const message = virtualCameraStartResult.error || virtualCameraStartResult.message || 'Morphly virtual camera is unavailable';
        console.warn('Morphly virtual camera is unavailable:', message);
        setDashboardError({
          title: 'Virtual camera unavailable',
          message,
        });
      } else if (isVirtualCameraProfile(virtualCameraStartResult?.profile)) {
        virtualCameraProfileRef.current = virtualCameraStartResult.profile;
        console.info(
          `Morphly virtual camera using ${virtualCameraStartResult.profile.mode} profile: ` +
          `${virtualCameraStartResult.profile.width}x${virtualCameraStartResult.profile.height}` +
          `@${virtualCameraStartResult.profile.frameRate}`,
        );
      }
    });

    try {
      setUiStatus('Opening camera...');
      const stream = await startWebcam(activeMode, {
        forceNewStream: true,
        provider: requestedProvider,
      });

      if (!stream) {
        throw new Error('Webcam start failed');
      }

      let realtimeClient: RealtimeClient | null = null;
      let lastConnectError: unknown;
      const maxConnectAttempts = AI_CONNECT_MAX_ATTEMPTS[requestedProvider];

      for (let attempt = 1; attempt <= maxConnectAttempts; attempt += 1) {
        const authorizationStartedAt = performance.now();
        setUiStatus(`Authorizing ${requestedProviderLabel}...`);
        console.log(`[AI_WS] ${requestedProviderLabel} connection attempt ${attempt}/${maxConnectAttempts}`);
        const startResponse = await apiRequest<AiSessionResponse>('/start-session', {
          method: 'POST',
          body: JSON.stringify({
            userId: user?.id,
            installationId: getInstallationId(),
            platform: window.electron ? 'desktop' : 'web',
            provider: requestedProvider,
          }),
        });

        if (!startResponse.allowed) {
          throw new Error(startResponse.details || startResponse.error || 'Failed to create AI session');
        }

        const sessionToken = startResponse.token || '';
        if (!sessionToken) throw new Error('Missing session token');

        sessionTokenRef.current = sessionToken;
        sessionIdRef.current = startResponse.sessionId || '';

        const responseProvider = resolveRealtimeProvider(startResponse.provider);
        if (responseProvider !== requestedProvider) {
          throw new Error(
            `${requestedProviderLabel} is not enabled on the connected Morphly server yet.`,
          );
        }

        sessionProviderRef.current = requestedProvider;

        const realtimeModel = resolveRealtimeModel(requestedProvider, startResponse.model);
        sessionRealtimeModelRef.current = realtimeModel;
        const authorizationMs = Math.round(performance.now() - authorizationStartedAt);
        console.log('[AI_DIAGNOSTICS]', {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          online: navigator.onLine,
          pageProtocol: location.protocol,
          pageHost: location.host,
          provider: requestedProvider,
          model: realtimeModel,
          hasToken: Boolean(sessionToken),
          expiresAt: startResponse.expiresAt ?? null,
          authorizationMs,
          serverTimings: startResponse.startupTimings ?? null,
        });

        try {
          setUiStatus(`Connecting to ${requestedProviderLabel}...`);
          const providerConnectStartedAt = performance.now();
          realtimeClient = await withTimeout(
            connectToRealtimeProvider(requestedProvider, stream, sessionToken, getDesiredTransformState(), {
              modelName: realtimeModel,
            }),
            AI_CONNECT_TIMEOUT_MS[requestedProvider],
            `${requestedProviderLabel} connection timed out after ${AI_CONNECT_TIMEOUT_MS[requestedProvider] / 1000}s`,
          );
          if (!realtimeClient) throw new Error(`${requestedProviderLabel} connection was not established`);
          console.info('[AI_STARTUP]', {
            provider: requestedProvider,
            authorizationMs,
            providerConnectMs: Math.round(performance.now() - providerConnectStartedAt),
            totalMs: Math.round(performance.now() - startupStartedAt),
          });
          if (startResponse.credits !== undefined) setCredits(startResponse.credits);
          break;
        } catch (error) {
          lastConnectError = error;
          await apiRequest('/end-session', {
            method: 'POST',
            body: JSON.stringify({ userId: user?.id, sessionId: sessionIdRef.current || undefined }),
          }).catch((endError) => console.error('Failed to end unsuccessful AI session:', endError));
          sessionTokenRef.current = '';
          sessionIdRef.current = '';
          disconnectRealtime({ skipStateUpdate: true });
          if (attempt < maxConnectAttempts) {
            setUiStatus(`Retrying ${requestedProviderLabel}...`);
            await sleep(attempt * 1500);
          } else {
            break;
          }
        }
      }

      if (!realtimeClient) {
        throw lastConnectError || new Error(`${requestedProviderLabel} connection was not established`);
      }

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      pollIntervalRef.current = setInterval(pollSessionStatus, POLLING_INTERVAL);
      // Usage flush interval is started by a useEffect once hasRemoteFrame
      // becomes true, preventing credit drain during the connection phase.
      setIsStreaming(true);
      setSessionStatus('LIVE');
      setUiStatus('Live');
    } catch (error) {
      console.error('Start session error:', error);
      trackConnectionFailed(sessionIdRef.current || undefined, {
        reason: error instanceof Error ? error.message : 'unknown',
        provider: requestedProvider,
      });
      const sessionExpired = error instanceof Error && (
        error.message === 'AUTH_SESSION_REQUIRED' ||
        /missing authorization|invalid or expired access token/i.test(error.message)
      );
      const errorMessage = sessionExpired
        ? 'Your session expired. Please sign in again.'
        : getStartSessionErrorMessage(error, requestedProvider);
      setDashboardError({
        title: `${requestedProviderLabel} could not start`,
        message: errorMessage || `${requestedProviderLabel} could not establish the realtime connection. Check your connection, then try again.`,
        canRetry: !sessionExpired,
      });

      if (sessionTokenRef.current) {
        await apiRequest('/end-session', {
          method: 'POST',
          body: JSON.stringify({ userId: user?.id, sessionId: sessionIdRef.current || undefined }),
        }).catch((rollbackError) => {
          console.error('Failed to roll back session start:', rollbackError);
        });
      }

      sessionTokenRef.current = '';
      morphlyCamWindowEnabledRef.current = false;
      stopWebcam();
      disconnectRealtime();
      closeMorphlyCamWindow({ clearStream: true });
      setIsStreaming(false);
      setSessionStatus('IDLE');
      setUiStatus('Disconnected');
      if (sessionExpired) {
        await logout();
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setDashboardError(null);
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setIsValidatingImage(true);
    try {
      const preparedFile = await prepareXmaxReferenceImage(file);

      setReferenceImage({
        file: preparedFile,
        name: file.name,
        signature: `${preparedFile.name}:${preparedFile.size}:${preparedFile.lastModified}`,
      });
    } catch (error) {
      console.error('Reference image validation failed:', error);
      setDashboardError({
        title: 'Image not accepted',
        message: error instanceof Error
          ? error.message
          : 'Morphly could not read that image. Select another image file.',
      });
      return;
    } finally {
      setIsValidatingImage(false);
    }

  };

  const handleModeChange = (mode: string) => {
    if (!mode) {
      return;
    }

    setPreferredMode(mode as QualityMode);
  };

  const handleProviderChange = (provider: string) => {
    if (isLoading || isStreaming) return;
    setDashboardError(null);
    setSelectedProvider(resolveRealtimeProvider(provider));
    setRuntimeModeCap('hd');
  };

  const handleFullScreenToggle = async () => {
    try {
      if (window.electron?.isElectron) {
        const nextState = await window.electron.invoke('window:toggle-full-screen');
        setIsFullScreen(Boolean(nextState));
        return;
      }

      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.error('Unable to change full-screen mode:', error);
      setDashboardError({
        title: 'Display mode unavailable',
        message: 'Morphly could not change the display mode. Try again or use the window controls.',
      });
    }
  };

  const handleCameraChange = (cameraId: string) => {
    if (cameraId === selectedCameraId) {
      return;
    }

    userInitiatedCameraChangeRef.current = true;
    selectedCameraIdRef.current = cameraId;
    setSelectedCameraId(cameraId);
    setCameraError(null);
    setDashboardError(null);

    const storageKey = user?.id
      ? `${SELECTED_CAMERA_STORAGE_PREFIX}:${user.id}`
      : SELECTED_CAMERA_STORAGE_PREFIX;
    if (cameraId) {
      localStorage.setItem(storageKey, cameraId);
    } else {
      localStorage.removeItem(storageKey);
    }
  };

  const handleTourFinish = () => {
    setIsTourRunning(false);
    void updateOnboardingState('complete').catch((error) => {
      console.warn('Unable to save guided-tour completion:', error);
      setDashboardError({
        title: 'Guide preference not saved',
        message: 'The guide finished, but Morphly could not save the completion state.',
      });
    });
  };

  const handleTourSkip = () => {
    setIsTourRunning(false);
    void updateOnboardingState('skip').catch((error) => {
      console.warn('Unable to save guided-tour skip state:', error);
      setDashboardError({
        title: 'Guide preference not saved',
        message: 'Morphly could not save the skipped guide state.',
      });
    });
  };

  return (
    <div className="morphly-dashboard flex flex-col bg-background font-sans text-foreground">
      <CustomerEngagement paused={!onboardingChecked || isTourRunning || isStreaming || isLoading || isUpdaterBlocking} />
      <main className="morphly-dashboard-main flex min-w-0 bg-background">
        <MeanVcPanel />
        <section
          data-tour="dashboard"
          aria-label="Live streaming preview"
              className="morphly-dashboard-preview relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-background"
        >
          <UpdateBanner />
        <video
          id="output"
          ref={outputVideoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain transition-[opacity,filter] duration-200"
          style={{
            display: isStreaming || isLoading ? 'block' : 'none',
            opacity: hasRemoteFrame ? 1 : 0.82,
            willChange: 'transform, opacity',
            // Mirror the self-preview without altering the remote
            // MediaStream used by the virtual camera and downstream viewers.
            transform: 'translateZ(0) scaleX(-1)',
            transformOrigin: 'center',
            backfaceVisibility: 'hidden',
            imageRendering: 'auto',
          }}
        />

        {!isStreaming && !isLoading && (
              <div className="flex max-w-xs flex-col items-center justify-center px-8 py-7 text-center">
                <div className="grid size-10 place-items-center rounded-md border border-border bg-background text-muted-foreground">
                  <Monitor aria-hidden="true" className="size-5 stroke-[1.4]" />
                </div>
                <h2 className="mt-3 text-xs font-semibold text-foreground">Preview offline</h2>
                <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">Choose a camera and image to begin.</p>
          </div>
        )}

        <input
          type="file"
          title="Upload image"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          className="hidden"
          id="image-upload"
        />

        {dashboardError && (
          <div className="pointer-events-none absolute inset-x-0 top-16 z-30 flex justify-center px-4">
            <div
              ref={dashboardErrorRef}
              data-testid="dashboard-error-panel"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              aria-labelledby="dashboard-error-title"
              aria-describedby="dashboard-error-message"
              tabIndex={-1}
              className="pointer-events-auto flex w-full max-w-xl items-start gap-3 rounded-lg border border-destructive/25 bg-background p-3.5 text-foreground shadow-[0_18px_45px_rgba(0,0,0,0.32)] outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-md bg-danger-soft text-destructive">
                <CircleAlert aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0 flex-1 py-0.5">
                <h2 id="dashboard-error-title" className="text-sm font-semibold leading-5 text-foreground">
                  {dashboardError.title}
                </h2>
                <p id="dashboard-error-message" className="mt-1 text-xs leading-5 text-muted-foreground">
                  {dashboardError.message}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {dashboardError.canRetry && (
                  <button
                    type="button"
                    onClick={() => void handleStart()}
                    disabled={Boolean(startBlockReason)}
                    className="min-h-11 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Try again
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDashboardError(null)}
                  aria-label="Dismiss error"
                  title="Dismiss error"
                  className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {(isStreaming || isLoading) && (isLoading || isSyncingTransform || connectionState === 'reconnecting' || !hasRemoteFrame) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20 flex justify-center px-6">
                <div className="inline-flex items-center gap-2 rounded-md border border-primary/20 bg-background px-3 py-2 text-[11px] font-medium text-foreground backdrop-blur-md">
                  <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-primary" />
              <span>
                {isSyncingTransform
                  ? 'Applying prompt/image changes without reconnecting...'
                  : connectionState === 'reconnecting'
                    ? 'Reconnecting stream...'
                    : uiStatus}
              </span>
            </div>
          </div>
        )}

            <div className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 backdrop-blur-md">
              <span className={`size-1.5 rounded-full ${isStreaming ? 'bg-success' : 'bg-muted'}`} />
              <span className="flex flex-col">
                <span className="text-[11px] font-semibold text-foreground">Live output</span>
                <span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                  {activeProviderLabel} realtime
                </span>
          </span>
        </div>

            <div className="absolute right-4 top-4 z-20 flex items-center gap-1.5">
          <button
            type="button"
            title={isFullScreen ? 'Exit full screen' : 'Full screen'}
            aria-label={isFullScreen ? 'Exit full screen' : 'Switch to full screen'}
            onClick={() => void handleFullScreenToggle()}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-[11px] font-medium text-muted-foreground backdrop-blur-md transition-colors duration-200 hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {isFullScreen ? <Minimize aria-hidden="true" className="size-4" /> : <Maximize aria-hidden="true" className="size-4" />}
            <span className="hidden sm:inline">{isFullScreen ? 'Exit Full Screen' : 'Full Screen'}</span>
          </button>
          <button
            data-tour="settings"
            title="Settings"
            aria-label="Open Settings"
            onClick={() => navigate('/settings')}
                className="grid size-9 place-items-center rounded-md border border-border bg-background text-muted-foreground backdrop-blur-md transition-colors duration-200 hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Settings aria-hidden="true" className="size-4" />
          </button>
        </div>
        </section>
      </main>

      <footer aria-label="Live session controls" className="morphly-session-controls relative z-10 flex shrink-0 flex-col gap-1 border-t border-border bg-background px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 sm:flex-1 sm:basis-auto">
            <div className="morphly-session-actions flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:border-r sm:border-border sm:pr-2">
            <button
              data-tour="start-stream"
              onClick={handleStart}
              disabled={Boolean(startBlockReason)}
              title={startBlockReason || 'Start live stream'}
              className={`flex h-9 items-center gap-2 rounded-md border px-3 text-[11px] font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/50 disabled:cursor-not-allowed ${
                startBlockReason
                  ? 'border-border bg-background text-muted-foreground'
                  : 'border-primary bg-primary text-primary-foreground hover:bg-primary-hover'
              }`}
            >
              {isLoading ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Play aria-hidden="true" className="size-3.5 fill-current" />}
              <span>{isLoading ? 'Starting' : 'Go live'}</span>
            </button>

            <button
              data-tour="stop-stream"
              onClick={() => void handleStop()}
              disabled={!isStreaming}
              className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-[11px] font-medium text-foreground transition-colors duration-200 hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Square aria-hidden="true" className="size-3 fill-current opacity-70" />
              <span>Stop</span>
            </button>

            <button
              data-tour="upload-image"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-[11px] font-medium text-foreground transition-colors duration-200 hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Upload aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>{referenceImage ? 'Change Image' : 'Upload Image'}</span>
            </button>

            {referenceImage && (
              <button
                type="button"
                onClick={() => {
                  setReferenceImage(null);
                  if (fileInputRef.current) {
                    fileInputRef.current.value = '';
                  }
                }}
                className="flex h-9 items-center rounded-md border border-border bg-background px-3 text-[11px] font-medium text-muted-foreground transition-colors duration-200 hover:border-destructive/25 hover:bg-danger-soft hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
              >
                <span>Clear Avatar</span>
              </button>
            )}

            <select
              data-testid="realtime-provider-selector"
              value={selectedProvider}
              onChange={(event) => handleProviderChange(event.target.value)}
              disabled={isLoading || isStreaming}
              title={isLoading || isStreaming
                ? 'Stop the live session before switching engines'
                : 'Select realtime video engine'}
              aria-label="Realtime video engine"
              className="h-9 min-w-[104px] rounded-md border border-border bg-background px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-background focus:border-primary/25 focus:outline-none focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {REALTIME_PROVIDER_OPTIONS.map((provider) => (
                <option key={provider.value} value={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>

            <select
              value={selectedProvider === 'decart' ? 'hd' : preferredMode}
              onChange={(event) => handleModeChange(event.target.value)}
              disabled={selectedProvider === 'decart'}
              title={selectedProvider === 'decart'
                ? 'Pro uses its optimized 720p profile'
                : 'Select performance mode'}
              aria-label="Select performance mode"
              className="h-9 min-w-[108px] rounded-md border border-border bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-background focus:border-primary/25 focus:outline-none focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="fast">Fast Mode</option>
              <option value="balanced">Balanced Mode</option>
              <option value="hd">HD 720p</option>
            </select>
            </div>

            {/* Input Camera Dropdown */}
            <div
              data-tour="camera-selector"
              className="morphly-session-field flex min-w-0 basis-full flex-col justify-center rounded-md border border-border bg-background px-2.5 sm:max-w-[215px] sm:flex-1 sm:basis-[170px]"
            >
              <div className="mb-0.5 flex items-center justify-between gap-2 leading-none">
                <label htmlFor="physical-camera-selector" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Input camera
                </label>
                <button
                  type="button"
                  onClick={() => void refreshCameras({ requestPermission: true })}
                  disabled={isRefreshingCameras || isStreaming || isLoading}
                  title="Refresh cameras"
                  aria-label="Refresh camera list"
                  className="inline-flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
                >
                  <RefreshCw aria-hidden="true" className={`size-3 ${isRefreshingCameras ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <select
                id="physical-camera-selector"
                value={selectedCameraId}
                onChange={(event) => handleCameraChange(event.target.value)}
                title="Select your physical laptop or USB camera"
                aria-label="Input camera: select your physical laptop or USB camera"
                className="h-5 w-full min-w-0 border-0 bg-transparent p-0 text-xs font-medium text-foreground outline-none focus:text-foreground"
              >
                <option value="">Select camera</option>
                {cameraDevices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Physical camera ${index + 1}`}
                  </option>
                ))}
                {virtualCameraDevices.length > 0 && (
                  <optgroup label="Virtual cameras (blocked)">
                    {virtualCameraDevices.map((device, index) => (
                      <option key={device.deviceId} value="" disabled>
                        {device.label || `Blocked virtual camera ${index + 1}`}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            {/* AI Background Dropdown Selector */}
            <div
              data-tour="background-selector"
              className="morphly-session-field flex min-w-0 basis-full flex-col justify-center rounded-md border border-border bg-background px-2.5 sm:max-w-[220px] sm:flex-1 sm:basis-[180px]"
            >
              <div className="mb-0.5 flex items-center justify-between gap-2 leading-none">
                <label htmlFor="background-preset-selector" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  AI background
                </label>
                <span className={`text-[10px] font-semibold tabular-nums ${isBlendedMode ? 'text-warning' : 'text-muted-foreground'}`}>
                  {currentCreditRate} cr/s
                </span>
              </div>
              <select
                id="background-preset-selector"
                value={activeBgPreset}
                onChange={(event) => {
                  const newPreset = event.target.value;
                  setActiveBgPreset(newPreset);
                  setCustomBgPrompt('');
                }}
                title="Select AI background"
                aria-label="Select AI background"
                className="h-5 w-full min-w-0 border-0 bg-transparent p-0 text-xs font-medium text-foreground outline-none focus:text-foreground"
              >
                {BACKGROUND_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="flex h-10 items-center gap-2.5 rounded-md border border-border bg-background px-2.5">
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Credits</span>
                  <span className={`text-[10px] font-semibold ${isBlendedMode ? 'text-warning' : 'text-muted-foreground'}`}>
                    ({currentCreditRate} cr/s)
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Coins aria-hidden="true" className="size-3.5 text-primary" />
                  <span className="text-xs font-semibold tabular-nums text-foreground">{Math.round(credits).toLocaleString()}</span>
                </div>
              </div>
              <button
                data-tour="buy-credits"
                onClick={() => navigate('/subscription')}
                className="flex h-7 items-center gap-1 rounded bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground transition-colors duration-200 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Plus aria-hidden="true" className="size-3.5 stroke-[2.5]" />
                Buy
              </button>
            </div>
          </div>
        </div>
        <div
          className={`flex min-h-6 min-w-0 items-center break-words rounded border px-2.5 text-[10px] leading-4 [overflow-wrap:anywhere] ${
            startBlockReason
              ? 'border-warning/15 bg-warning-soft text-warning'
              : 'border-success/15 bg-success-soft text-success'
          }`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {cameraError || startBlockReason || `Ready to start with ${selectedVideoDevice?.label || 'the selected physical camera'}.`}
        </div>
      </footer>
      <MorphlyDashboardTour
        run={isTourRunning}
        onFinish={handleTourFinish}
        onSkip={handleTourSkip}
      />
    </div>
  );
}

export default Dashboard;
