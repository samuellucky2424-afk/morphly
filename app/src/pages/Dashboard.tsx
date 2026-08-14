import { useState, useRef, useEffect, useCallback } from 'react';
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
  Sparkles,
  User,
  Send,
} from 'lucide-react';
import { toast } from 'sonner';
import { BACKGROUND_PRESETS } from '@/components/BackgroundReplacer';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { apiFetchWithAuth } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';
import {
  getInstallationId,
  trackConnectionStarted,
  trackConnectionFailed,
  trackFirstFrameReceived,
  trackSessionCompleted,
} from '@/lib/telemetry-client';
import { UpdateBanner } from '@/components/UpdateBanner';
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
  getAdaptiveQualityMode,
  type QualityMode,
  upgradeQualityMode,
} from '@/lib/realtime-quality';


type ConnectionState = 'connecting' | 'connected' | 'generating' | 'disconnected' | 'reconnecting';

type RealtimeStats = {
  timestamp: number;
  video: {
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    framesDroppedDelta: number;
    freezeCountDelta: number;
    bitrate: number;
  } | null;
  outboundVideo: {
    qualityLimitationReason: string;
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    bitrate: number;
  } | null;
  connection: {
    currentRoundTripTime: number | null;
    availableOutgoingBitrate: number | null;
  };
};

type RealtimeClientEventMap = {
  connectionChange: ConnectionState;
  connectionStateChange: ConnectionState;
  stats: RealtimeStats;
  error: { message: string };
  generationTick: { seconds: number };
  diagnostic: unknown;
};

interface RealtimeClient {
  disconnect: () => void;
  set: (config: {
    prompt?: string | null;
    enhance?: boolean;
    image?: string | Blob | File | null;
  }) => Promise<void>;
  setPrompt: (text: string, options?: { enhance?: boolean }) => Promise<void>;
  getConnectionState?: () => ConnectionState;
  on: <K extends keyof RealtimeClientEventMap>(
    event: K,
    listener: (data: RealtimeClientEventMap[K]) => void,
  ) => void;
  off: <K extends keyof RealtimeClientEventMap>(
    event: K,
    listener: (data: RealtimeClientEventMap[K]) => void,
  ) => void;
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
  websocketUrl?: string;
  model?: string;
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

type NetworkInformationLike = EventTarget & {
  downlink?: number;
  addEventListener?: (type: 'change', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: 'change', listener: EventListenerOrEventListenerObject) => void;
};

type VideoElementWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  latencyHint?: string;
};

const BASE_PROMPT = `Substitute the character in the video with the person in the reference image.`;
const DEFAULT_ENHANCE = true;
const POLLING_INTERVAL = 5000; // poll session-status every 5 s for live credit display
const TRANSFORM_SYNC_DEBOUNCE_MS = 180;
const AUTO_DOWNGRADE_SAMPLES = 3;
const AUTO_UPGRADE_SAMPLES = 10;
const RESTART_WATCHDOG_INTERVAL_MS = 3000;
const FREEZE_RESTART_THRESHOLD_MS = 12000;
const INITIAL_PROMPT_INJECTION_DELAY_MS = 500;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;
const RESTART_FAILURES_BEFORE_DOWNGRADE = 2;
const AI_CONNECT_TIMEOUT_MS = 45000;
const AI_CONNECT_MAX_ATTEMPTS = 3;
const MAX_GENERATION_TICK_DELTA_SECONDS = 60;
const DECART_REALTIME_MODEL = 'lucy-2.5';
const MORPHLY_CAM_FRAME_WIDTH = 1280;
const MORPHLY_CAM_FRAME_HEIGHT = 720;
const MORPHLY_CAM_FRAME_INTERVAL_MS = 1000 / 30;
const SELECTED_CAMERA_STORAGE_PREFIX = 'morphly:selected-physical-camera';

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

function buildRealtimeSessionState(transform: TransformState) {
  return {
    prompt: transform.prompt,
    enhance: DEFAULT_ENHANCE,
    image: transform.image ?? null,
  };
}

async function applyRealtimeSessionState(realtimeClient: RealtimeClient, transform: TransformState) {
  await realtimeClient.set(buildRealtimeSessionState(transform));
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

function getStartSessionErrorToast(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return 'Failed to start session';
  }

  switch (error.message) {
    case 'Webcam start failed':
    case 'Decart connection was not established':
      return null;
    case 'Missing session token':
      return 'Failed to start session: missing AI token';
    default:
      return error.message || 'Failed to start session';
  }
}

function getDecartSdkErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown;
      code?: unknown;
      cause?: { message?: unknown } | unknown;
    };

    if (typeof candidate.message === 'string' && candidate.message) {
      return candidate.message;
    }

    if (
      typeof candidate.cause === 'object'
      && candidate.cause !== null
      && 'message' in candidate.cause
      && typeof candidate.cause.message === 'string'
      && candidate.cause.message
    ) {
      return candidate.cause.message;
    }

    if (typeof candidate.code === 'string' && candidate.code) {
      return candidate.code;
    }
  }

  return null;
}

function getNavigatorConnection(): NetworkInformationLike | null {
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };

  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
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

// Preload the SDK module so readiness is visible and cached before Start.
const decartSdkReadyPromise = import('@decartai/sdk');

function Dashboard() {
  const { user, logout } = useAuth();
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
  const [isEngineReady, setIsEngineReady] = useState(false);
  const [engineLoadError, setEngineLoadError] = useState<string | null>(null);
  const [isUpdaterBlocking, setIsUpdaterBlocking] = useState(false);
  const [isTourRunning, setIsTourRunning] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isValidatingImage, setIsValidatingImage] = useState(false);
  const [featureMode, setFeatureMode] = useState<'avatar' | 'background'>('avatar');
  const [activeBgPreset, setActiveBgPreset] = useState<string>('office');
  const [customBgPrompt, setCustomBgPrompt] = useState<string>('');
  const [prompt] = useState(BASE_PROMPT);

  const currentBgPreset = BACKGROUND_PRESETS.find((p) => p.id === activeBgPreset) || BACKGROUND_PRESETS[0];
  const backgroundPrompt = customBgPrompt.trim() || currentBgPreset.prompt;
  const [preferredMode, setPreferredMode] = useState<QualityMode>('hd');
  const [runtimeModeCap, setRuntimeModeCap] = useState<QualityMode>('hd');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [, setUiStatus] = useState('Disconnected');
  const [isSyncingTransform, setIsSyncingTransform] = useState(false);
  const [hasRemoteFrame, setHasRemoteFrame] = useState(false);
  const [, setStreamMetrics] = useState<StreamMetrics>(() => createEmptyStreamMetrics());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const webcamSourceStreamRef = useRef<MediaStream | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const realtimeClientRef = useRef<RealtimeClient | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transformSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTransformRef = useRef<TransformState | null>(null);
  const lastAppliedTransformRef = useRef<TransformState | null>(null);
  const transformInFlightRef = useRef(false);
  const clientSubscriptionsCleanupRef = useRef<(() => void) | null>(null);
  const sessionTokenRef = useRef('');
  const sessionIdRef = useRef('');
  const usageFlushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingBillableSecondsRef = useRef(0);
  const lastBilledGenerationSecondsRef = useRef<number | null>(null);
  const frameCallbackHandleRef = useRef<number | null>(null);
  const lastRemoteFrameAtRef = useRef(0);
  const lastGenerationTickAtRef = useRef(Date.now());
  const frameWatchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const softReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartInFlightRef = useRef(false);
  const safeStopInFlightRef = useRef(false);
  const sessionEverConnectedRef = useRef(false);
  const restartRetryDelayRef = useRef(INITIAL_RETRY_DELAY_MS);
  const restartFailureCountRef = useRef(0);
  const handleStopRef = useRef<((options?: { silent?: boolean }) => Promise<void>) | null>(null);
  const safelyStopSessionRef = useRef<(() => Promise<void>) | null>(null);
  const healthCountersRef = useRef({ poorSamples: 0, healthySamples: 0 });
  const userSelectedModeRef = useRef(false);
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
  const mainVirtualCamLastFrameSentAtRef = useRef(0);

  const promptRef = useRef(prompt);
  const featureModeRef = useRef(featureMode);
  const backgroundPromptRef = useRef(backgroundPrompt);
  const referenceImageRef = useRef(referenceImage);
  const isStreamingRef = useRef(isStreaming);
  const hasRemoteFrameRef = useRef(hasRemoteFrame);
  const connectionStateRef = useRef<ConnectionState>(connectionState);
  const activeModeRef = useRef<QualityMode>('hd');
  const preferredModeRef = useRef(preferredMode);

  const activeMode = clampQualityMode(preferredMode, runtimeModeCap);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    featureModeRef.current = featureMode;
  }, [featureMode]);

  useEffect(() => {
    backgroundPromptRef.current = backgroundPrompt;
  }, [backgroundPrompt]);

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
    activeModeRef.current = activeMode;
  }, [activeMode]);

  useEffect(() => {
    preferredModeRef.current = preferredMode;
  }, [preferredMode]);

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

    void decartSdkReadyPromise
      .then(() => {
        if (!cancelled) {
          setIsEngineReady(true);
          setEngineLoadError(null);
        }
      })
      .catch((error) => {
        console.error('Failed to preload Morphly realtime engine:', error);
        if (!cancelled) {
          setIsEngineReady(false);
          setEngineLoadError('The Morphly engine is not ready yet.');
        }
      });

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

    void claimSignupBonusWelcome()
      .then((showWelcome) => {
        if (!cancelled && showWelcome) {
          toast.success('Welcome to Morphly — 50 free testing credits have been added to your account.');
        }
      })
      .catch((error) => {
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
      });

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
        toast.error('Session auto-ended - Insufficient credits');
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
    pendingBillableSecondsRef.current = 0;
    lastBilledGenerationSecondsRef.current = null;
  }, [clearUsageFlushInterval]);

  const recordBillableGenerationTick = useCallback((tick?: { seconds?: number }) => {
    if (!sessionTokenRef.current || !sessionIdRef.current) {
      return;
    }

    const tickSeconds = Number(tick?.seconds);
    let secondsDelta = 0;

    if (Number.isFinite(tickSeconds) && tickSeconds >= 0) {
      const normalizedTickSeconds = Math.floor(tickSeconds);
      const previousTickSeconds = lastBilledGenerationSecondsRef.current;

      if (previousTickSeconds === null || normalizedTickSeconds < previousTickSeconds) {
        secondsDelta = normalizedTickSeconds > 0 ? normalizedTickSeconds : 0;
      } else {
        secondsDelta = normalizedTickSeconds - previousTickSeconds;
      }

      lastBilledGenerationSecondsRef.current = normalizedTickSeconds;
    } else {
      secondsDelta = 1;
    }

    if (secondsDelta > 0) {
      // Decart reports cumulative generation time and may emit ticks in
      // intervals larger than 10 seconds. Capping every tick at 10 silently
      // discarded real provider usage and made the admin totals too low.
      pendingBillableSecondsRef.current += Math.min(
        secondsDelta,
        MAX_GENERATION_TICK_DELTA_SECONDS,
      );
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
      window.cancelAnimationFrame(mainVirtualCamRenderHandleRef.current);
    }

    mainVirtualCamRenderHandleRef.current = null;
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
      pixels: new Uint8ClampedArray(imageData.data),
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
      willReadFrequently: true,
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

      context.fillStyle = '#000000';
      context.fillRect(0, 0, currentCanvas.width, currentCanvas.height);

      if (currentVideo.readyState >= 2 && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
        drawVideoFrameCover(context, currentVideo, currentCanvas.width, currentCanvas.height);

        const now = currentPopup.performance?.now?.() ?? performance.now();
        if ((now - morphlyCamLastFrameSentAtRef.current) >= MORPHLY_CAM_FRAME_INTERVAL_MS) {
          pushMorphlyCamFrame(currentCanvas, context);
          morphlyCamLastFrameSentAtRef.current = now;
        }
      }

      morphlyCamRenderHandleRef.current = currentPopup.requestAnimationFrame(renderFrame);
    };

    morphlyCamRenderHandleRef.current = popup.requestAnimationFrame(renderFrame);
  }, [pushMorphlyCamFrame, stopMorphlyCamRenderLoop]);

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
      canvas.width = MORPHLY_CAM_FRAME_WIDTH;
      canvas.height = MORPHLY_CAM_FRAME_HEIGHT;
      mainVirtualCamCanvasRef.current = canvas;
    }

    stopMainVirtualCamRenderLoop();
    mainVirtualCamLastFrameSentAtRef.current = 0;

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: true,
    });

    if (!context) {
      return;
    }

    const renderFrame = () => {
      const currentVideo = outputVideoRef.current;
      const currentCanvas = mainVirtualCamCanvasRef.current;

      if (!morphlyCamWindowEnabledRef.current || !currentVideo || !currentCanvas) {
        mainVirtualCamRenderHandleRef.current = null;
        return;
      }

      context.fillStyle = '#000000';
      context.fillRect(0, 0, currentCanvas.width, currentCanvas.height);

      if (currentVideo.readyState >= 2 && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
        drawVideoFrameCover(context, currentVideo, currentCanvas.width, currentCanvas.height);

        const now = performance.now();
        if ((now - mainVirtualCamLastFrameSentAtRef.current) >= MORPHLY_CAM_FRAME_INTERVAL_MS) {
          pushMorphlyCamFrame(currentCanvas, context);
          mainVirtualCamLastFrameSentAtRef.current = now;
        }
      }

      mainVirtualCamRenderHandleRef.current = window.requestAnimationFrame(renderFrame);
    };

    mainVirtualCamRenderHandleRef.current = window.requestAnimationFrame(renderFrame);
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
              background: #000;
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
              background: #000;
            }

            #morphly-cam-output {
              width: 100%;
              height: 100%;
              object-fit: contain;
              background: #000;
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
              color: #f4f4f5;
              background:
                radial-gradient(circle at top, rgba(59, 130, 246, 0.16), transparent 52%),
                linear-gradient(180deg, rgba(10, 10, 10, 0.82), rgba(0, 0, 0, 0.92));
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
              border: 1px solid rgba(255, 255, 255, 0.12);
              border-radius: 999px;
              background: rgba(10, 10, 10, 0.7);
              color: #f4f4f5;
              font-size: 12px;
              letter-spacing: 0.04em;
              backdrop-filter: blur(10px);
              transition: opacity 180ms ease;
            }
          </style>
        </head>
        <body>
          <div id="morphly-cam-root">
            <canvas id="morphly-cam-output" width="${MORPHLY_CAM_FRAME_WIDTH}" height="${MORPHLY_CAM_FRAME_HEIGHT}"></canvas>
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

  const resetHealthCounters = useCallback(() => {
    healthCountersRef.current = {
      poorSamples: 0,
      healthySamples: 0,
    };
  }, []);

  const cleanupClientSubscriptions = useCallback(() => {
    clientSubscriptionsCleanupRef.current?.();
    clientSubscriptionsCleanupRef.current = null;
  }, []);

  const cancelRemoteFrameMonitor = useCallback(() => {
    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;

    if (video?.cancelVideoFrameCallback && frameCallbackHandleRef.current !== null) {
      video.cancelVideoFrameCallback(frameCallbackHandleRef.current);
    }

    frameCallbackHandleRef.current = null;
  }, []);

  const markRemoteFrameFresh = useCallback(() => {
    lastRemoteFrameAtRef.current = performance.now();

    if (!hasRemoteFrameRef.current) {
      hasRemoteFrameRef.current = true;
      setHasRemoteFrame(true);
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

  const disconnectFromDecart = useCallback((options?: { skipStateUpdate?: boolean }) => {
    clearSoftReconnectTimer();
    clearFrameWatchdog();
    cleanupClientSubscriptions();
    sessionEverConnectedRef.current = false;

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
      transformSyncTimerRef.current = null;
    }

    transformInFlightRef.current = false;
    pendingTransformRef.current = null;
    setIsSyncingTransform(false);

    if (realtimeClientRef.current) {
      realtimeClientRef.current.disconnect();
      realtimeClientRef.current = null;
    }

    cancelRemoteFrameMonitor();
    lastRemoteFrameAtRef.current = 0;
    hasRemoteFrameRef.current = false;
    setHasRemoteFrame(false);

    if (outputVideoRef.current) {
      outputVideoRef.current.srcObject = null;
    }

    closeMorphlyCamWindow();

    lastAppliedTransformRef.current = null;
    lastGenerationTickAtRef.current = Date.now();
    setStreamMetrics(createEmptyStreamMetrics());
    if (!options?.skipStateUpdate) {
      setConnectionState('disconnected');
    }
  }, [cancelRemoteFrameMonitor, cleanupClientSubscriptions, clearFrameWatchdog, clearSoftReconnectTimer, closeMorphlyCamWindow]);

  const getDesiredTransformState = useCallback((): TransformState => {
    if (featureModeRef.current === 'background') {
      return {
        prompt: backgroundPromptRef.current,
        enhance: DEFAULT_ENHANCE,
        image: null,
        imageSignature: null,
      };
    }

    return {
      prompt: promptRef.current,
      enhance: DEFAULT_ENHANCE,
      image: referenceImageRef.current?.file ?? null,
      imageSignature: referenceImageRef.current?.signature ?? null,
    };
  }, []);

  const applyTrackProfileWithFallback = useCallback(async (
    track: MediaStreamTrack,
    requestedMode: QualityMode,
  ): Promise<QualityMode> => {
    let attemptedMode = requestedMode;

    while (true) {
      try {
        track.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
        await track.applyConstraints(buildVideoTrackConstraints(attemptedMode));
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
    options?: { forceNewStream?: boolean; silent?: boolean },
  ): Promise<MediaStream | null> => {
    if (!options?.forceNewStream && webcamSourceStreamRef.current) {
      const existingTrack = webcamSourceStreamRef.current.getVideoTracks()[0];

      if (existingTrack && existingTrack.readyState === 'live') {
        try {
          const appliedMode = await applyTrackProfileWithFallback(existingTrack, requestedMode);

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
          buildVideoInputConstraints(attemptedMode, selectedCameraId || undefined),
        );
        const nextTrack = nextStream.getVideoTracks()[0];

        if (nextTrack) {
          try {
            validateOpenedCameraTrack(nextTrack, selectedCameraId);
          } catch (error) {
            nextStream.getTracks().forEach((track) => track.stop());
            throw error;
          }
          nextTrack.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
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
              buildVideoInputConstraints(attemptedMode, selectedCameraId),
            );
            const fallbackTrack = fallbackStream.getVideoTracks()[0];

            if (fallbackTrack) {
              fallbackTrack.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
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
            toast.error(
              isNotReadable
                ? 'Camera or microphone is already in use by another application. Close it and try again.'
                : 'Failed to access camera or microphone. Please check device permissions.',
            );
          }

          return null;
        }

        attemptedMode = downgradeQualityMode(attemptedMode);
      }
    }
  }, [applyTrackProfileWithFallback, selectedCameraId]);

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
      await applyRealtimeSessionState(realtimeClient, nextTransform);

      lastAppliedTransformRef.current = nextTransform;
    } catch (error) {
      console.error('Failed to sync live transformation:', error);
      toast.error('Live style update stalled. Recovering stream...');
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

  const evaluateStreamHealth = useCallback((stats: RealtimeStats) => {
    const profile = QUALITY_MODE_PROFILES[activeModeRef.current];
    const inboundFps = stats.video?.framesPerSecond ?? 0;
    const outboundFps = stats.outboundVideo?.framesPerSecond ?? 0;
    const observedFps = inboundFps || outboundFps;
    const rttMs = stats.connection.currentRoundTripTime !== null
      ? stats.connection.currentRoundTripTime * 1000
      : null;
    const droppedFrames = stats.video?.framesDroppedDelta ?? 0;
    const freezeCount = stats.video?.freezeCountDelta ?? 0;
    const limitation = stats.outboundVideo?.qualityLimitationReason ?? 'none';
    const availableOutgoingBitrate = stats.connection.availableOutgoingBitrate ?? null;
    const counters = healthCountersRef.current;

    const severeDegradation =
      freezeCount > 0 ||
      droppedFrames > 8 ||
      observedFps < Math.max(8, profile.targetFps - 12) ||
      (rttMs !== null && rttMs > 450) ||
      (availableOutgoingBitrate !== null && availableOutgoingBitrate < 900000);

    const poorQuality =
      severeDegradation ||
      limitation === 'bandwidth' ||
      limitation === 'cpu' ||
      droppedFrames > 3 ||
      observedFps < profile.targetFps - 5 ||
      (rttMs !== null && rttMs > 260);

    const healthyQuality =
      !poorQuality &&
      limitation === 'none' &&
      observedFps >= Math.max(18, profile.targetFps - 2) &&
      freezeCount === 0 &&
      droppedFrames <= 1 &&
      (rttMs === null || rttMs < 180);

    if (poorQuality) {
      counters.poorSamples += severeDegradation ? 2 : 1;
      counters.healthySamples = 0;
    } else if (healthyQuality) {
      counters.healthySamples += 1;
      counters.poorSamples = Math.max(0, counters.poorSamples - 1);
    } else {
      counters.poorSamples = Math.max(0, counters.poorSamples - 1);
      counters.healthySamples = 0;
    }

    if (counters.poorSamples >= AUTO_DOWNGRADE_SAMPLES) {
      counters.poorSamples = 0;
      counters.healthySamples = 0;
      setRuntimeModeCap((currentMode) => downgradeQualityMode(currentMode));
    }

    if (counters.healthySamples >= AUTO_UPGRADE_SAMPLES) {
      counters.healthySamples = 0;
      setRuntimeModeCap((currentMode) => upgradeQualityMode(currentMode, preferredModeRef.current));
    }
  }, []);

  const handleRealtimeStats = useCallback((stats: RealtimeStats) => {
    const inboundFps = Math.round(stats.video?.framesPerSecond ?? 0);
    const outboundFps = Math.round(stats.outboundVideo?.framesPerSecond ?? 0);
    const bitrate = stats.video?.bitrate ?? stats.outboundVideo?.bitrate ?? 0;

    setStreamMetrics({
      fps: inboundFps || outboundFps,
      frameWidth: stats.video?.frameWidth ?? stats.outboundVideo?.frameWidth ?? 0,
      frameHeight: stats.video?.frameHeight ?? stats.outboundVideo?.frameHeight ?? 0,
      rttMs: stats.connection.currentRoundTripTime !== null
        ? Math.round(stats.connection.currentRoundTripTime * 1000)
        : null,
      limitation: stats.outboundVideo?.qualityLimitationReason ?? 'none',
      bitrateKbps: Math.round(bitrate / 1000),
    });

    if ((stats.video?.framesPerSecond ?? 0) > 1 || (stats.outboundVideo?.framesPerSecond ?? 0) > 1) {
      markRemoteFrameFresh();
    }

    evaluateStreamHealth(stats);
  }, [evaluateStreamHealth, markRemoteFrameFresh]);

  const connectToDecart = useCallback(async (
    stream: MediaStream,
    apiToken: string,
    initialTransform: TransformState,
    options?: { isRecovery?: boolean; websocketUrl?: string },
  ): Promise<RealtimeClient | null> => {
    try {
      if (morphlyCamWindowEnabledRef.current && morphlyCamWindowRef.current && !morphlyCamWindowRef.current.closed) {
        updateMorphlyCamStatus(options?.isRecovery ? 'Reconnecting Morphly cam...' : 'Connecting Morphly cam...');
        updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
      }

      const { createDecartClient, models } = await import('@decartai/sdk');
      const client = createDecartClient({
        apiKey: apiToken,
        ...(options?.websocketUrl ? { realtimeBaseUrl: options.websocketUrl } : {}),
      });
      const model = models.realtime(DECART_REALTIME_MODEL);

      const realtimeClient = await client.realtime.connect(stream, {
        model,
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

          const playRemote = () => {
            void video.play().catch(() => {});
            markRemoteFrameFresh();
            startRemoteFrameMonitor();
          };

          video.onloadedmetadata = playRemote;

          if (video.readyState >= 2) {
            playRemote();
          }

          syncMorphlyCamStream(
            editedStream,
            options?.isRecovery ? 'Reconnecting Morphly cam...' : 'Connecting Morphly cam...',
          );
        },
        initialState: {
          prompt: {
            text: initialTransform.prompt,
            enhance: DEFAULT_ENHANCE,
          },
          image: initialTransform.image ?? undefined,
        },
      });

      // connect() resolving means the WebRTC/WebSocket handshake is complete and
      // initialState has already been applied by the SDK. Do NOT call set() here
      // again — a redundant set() immediately after connect resets the generation
      // pipeline and causes the visible "hook" freeze on startup.
      sessionEverConnectedRef.current = true;

      cleanupClientSubscriptions();

      // True only once onConnectionChange has seen 'connected'/'generating' at least once.
      // Used to distinguish the SDK's normal post-connect state cycle from a real mid-session reconnect.
      // wasConnectedBeforeLastReconnect must NOT use sessionEverConnectedRef (which is set before
      // handlers register) — otherwise the first 'reconnecting' event always triggers a recovery .set().
      let hasSeenConnectedViaHandler = false;
      let wasConnectedBeforeLastReconnect = false;

      const onConnectionChange = (nextState: ConnectionState) => {
        const previousState = connectionStateRef.current;

        // Some SDK builds emit both events for the same transition; ignore duplicate state notifications.
        if (previousState === nextState) {
          return;
        }

        connectionStateRef.current = nextState;
        setConnectionState(nextState);
        console.log('Realtime state:', nextState);

        if (nextState === 'reconnecting') {
          // Only treat as a true mid-session reconnect if connected was seen through our handler.
          // This prevents the SDK's normal post-connect state cycle from triggering recovery .set().
          wasConnectedBeforeLastReconnect = hasSeenConnectedViaHandler;
          void flushBillableUsage();
          setUiStatus('Reconnecting...');
        }

        if (nextState === 'connected' || nextState === 'generating') {
          hasSeenConnectedViaHandler = true;
          sessionEverConnectedRef.current = true;
          setUiStatus('Live');
          restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
          restartFailureCountRef.current = 0;
        }

        if (nextState === 'disconnected') {
          setUiStatus('Disconnected');
          void flushBillableUsage();
          // Only stop if the session was actually established — not during initial WebSocket handshake.
          if (!restartInFlightRef.current && sessionEverConnectedRef.current) {
            void safelyStopSessionRef.current?.();
          }
        }

        if (
          previousState === 'reconnecting' &&
          (nextState === 'connected' || nextState === 'generating') &&
          wasConnectedBeforeLastReconnect  // Skip on initial connect; only reapply on true SDK-level reconnects.
        ) {
          const recoveryTransform = getDesiredTransformState();
          void sleep(INITIAL_PROMPT_INJECTION_DELAY_MS)
            .then(() => applyRealtimeSessionState(realtimeClient as RealtimeClient, recoveryTransform))
            .then(() => {
              lastAppliedTransformRef.current = recoveryTransform;
            })
            .catch((error) => {
              console.error('Failed to reapply realtime session state after reconnect:', error);
            });
        }

        if (nextState === 'connected' || nextState === 'generating') {
          clearSoftReconnectTimer();
        }

      };

      const onStats = (stats: RealtimeStats) => {
        handleRealtimeStats(stats);
      };

      const onError = (error: { message: string }) => {
        console.error('[Decart] realtime error:', error);
      };

      const onGenerationTick = (tick: { seconds?: number }) => {
        lastGenerationTickAtRef.current = Date.now();
        // Only record billable usage once the user can see AI output.
        // This prevents credit drain during the initial connection phase.
        if (hasRemoteFrameRef.current) {
          recordBillableGenerationTick(tick);
        }
        markRemoteFrameFresh();
      };

      const onDiagnostic = (diagnostic: unknown) => {
        console.log('[AI_WS_DIAGNOSTIC]', diagnostic);
      };

      realtimeClient.on('connectionChange', onConnectionChange);
      realtimeClient.on('stats', onStats);
      realtimeClient.on('error', onError);
      realtimeClient.on('generationTick', onGenerationTick);
      realtimeClient.on('diagnostic', onDiagnostic);

      clientSubscriptionsCleanupRef.current = () => {
        realtimeClient.off('connectionChange', onConnectionChange);
        realtimeClient.off('stats', onStats);
        realtimeClient.off('error', onError);
        realtimeClient.off('generationTick', onGenerationTick);
        realtimeClient.off('diagnostic', onDiagnostic);
      };

      realtimeClientRef.current = realtimeClient as RealtimeClient;
      lastAppliedTransformRef.current = initialTransform;
      lastGenerationTickAtRef.current = Date.now();
      resetHealthCounters();
      setConnectionState(realtimeClient.getConnectionState?.() ?? 'connecting');
      setUiStatus('Live');
      setStreamMetrics(createEmptyStreamMetrics());
      hasRemoteFrameRef.current = false;
      setHasRemoteFrame(false);
      lastRemoteFrameAtRef.current = performance.now();

      if (!options?.isRecovery) {
        toast.success('Connected to AI!');
      }

      return realtimeClient as RealtimeClient;
    } catch (error) {
      console.error('[Decart] SDK error:', error);

      if (!options?.isRecovery) {
        const errorMessage = getDecartSdkErrorMessage(error);
        toast.error(
          errorMessage
            ? `Failed to connect to AI: ${errorMessage}`
            : 'Failed to connect to AI',
        );
      }

      return null;
    }
  }, [
    cleanupClientSubscriptions,
    clearSoftReconnectTimer,
    flushBillableUsage,
    getMorphlyCamGuideMessage,
    handleRealtimeStats,
    markRemoteFrameFresh,
    recordBillableGenerationTick,
    resetHealthCounters,
    syncMorphlyCamStream,
    startRemoteFrameMonitor,
    updateMorphlyCamPlaceholder,
    updateMorphlyCamStatus,
  ]);

  const restartRealtimeSession = useCallback(async (
    reason: string,
    options?: { immediate?: boolean },
  ) => {
    if (!isStreamingRef.current || restartInFlightRef.current || !sessionTokenRef.current) {
      return;
    }

    restartInFlightRef.current = true;
    setUiStatus('Reconnecting...');

    try {
      if (!options?.immediate) {
        await sleep(restartRetryDelayRef.current);
      }

      const existingTrack = webcamSourceStreamRef.current?.getVideoTracks()[0];
      const currentStream = webcamStreamRef.current && webcamSourceStreamRef.current && existingTrack?.readyState === 'live'
        ? webcamStreamRef.current
        : await startWebcam(activeModeRef.current, { forceNewStream: true, silent: true });

      if (!currentStream) {
        return;
      }

      disconnectFromDecart({ skipStateUpdate: true });

      const reconnectedClient = await connectToDecart(
        currentStream,
        sessionTokenRef.current,
        getDesiredTransformState(),
        { isRecovery: true },
      );

      if (!reconnectedClient) {
        throw new Error(`Restart failed: ${reason}`);
      }

      restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
      restartFailureCountRef.current = 0;
      setUiStatus('Live');
    } catch (error) {
      console.error('[Decart] Restart failed:', error);
      restartFailureCountRef.current += 1;
      restartRetryDelayRef.current = Math.min(restartRetryDelayRef.current * 2, MAX_RETRY_DELAY_MS);

      if (restartFailureCountRef.current >= RESTART_FAILURES_BEFORE_DOWNGRADE) {
        setRuntimeModeCap((currentMode) => downgradeQualityMode(currentMode));
      }
    } finally {
      restartInFlightRef.current = false;
    }
  }, [connectToDecart, disconnectFromDecart, getDesiredTransformState, startWebcam]);

  const safelyStopSession = useCallback(async () => {
    if (safeStopInFlightRef.current) {
      return;
    }

    safeStopInFlightRef.current = true;

    try {
      try {
        realtimeClientRef.current?.disconnect();
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
    resetBillableUsageTracking();
    isStreamingRef.current = false;
    restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
    restartFailureCountRef.current = 0;
    setRuntimeModeCap('hd');
    resetHealthCounters();
    clearSoftReconnectTimer();
    clearFrameWatchdog();
    disconnectFromDecart();
    stopWebcam();
    setIsStreaming(false);
    setSessionStatus('IDLE');
    setUiStatus('Disconnected');

    if (!options?.silent) {
      toast.info('Session stopped');
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
    clearSoftReconnectTimer,
    clearUsageFlushInterval,
    disconnectFromDecart,
    flushBillableUsage,
    resetBillableUsageTracking,
    resetHealthCounters,
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
        toast.error('Session auto-ended - Insufficient credits');
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
          toast.error(message);
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

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
    }

    clearSoftReconnectTimer();
    clearFrameWatchdog();
    cleanupClientSubscriptions();
    cancelRemoteFrameMonitor();
    closeMorphlyCamWindow({ clearStream: true });
    realtimeClientRef.current?.disconnect();
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamSourceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, [cancelRemoteFrameMonitor, cleanupClientSubscriptions, clearFrameWatchdog, clearSoftReconnectTimer, clearUsageFlushInterval, closeMorphlyCamWindow]);

  useEffect(() => {
    if (!navigator.mediaDevices) return undefined;

    void refreshCameras({ requestPermission: true });
    return subscribeToCameraDeviceChanges(navigator.mediaDevices, () => {
      void refreshCameras({ notifyIfMissing: true });
    });
  }, [refreshCameras]);

  useEffect(() => {
    const connection = getNavigatorConnection();

    const updateAdaptiveNetworkMode = () => {
      const nextDownlink = connection?.downlink ?? null;
      const recommendedMode = getAdaptiveQualityMode(nextDownlink);

      if (!userSelectedModeRef.current) {
        setPreferredMode(recommendedMode);
      }
    };

    updateAdaptiveNetworkMode();

    if (connection?.addEventListener) {
      connection.addEventListener('change', updateAdaptiveNetworkMode);

      return () => {
        connection.removeEventListener?.('change', updateAdaptiveNetworkMode);
      };
    }

    return undefined;
  }, []);

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
  // This complements the per-tick guard in onGenerationTick and ensures
  // heartbeats are not sent during the connection/loading phase.
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
    if (!isStreaming) {
      clearSoftReconnectTimer();
      return;
    }

    if (connectionState === 'disconnected' && !restartInFlightRef.current && sessionEverConnectedRef.current) {
      clearSoftReconnectTimer();
      void safelyStopSession();
      return undefined;
    }

    if (connectionState === 'connected' || connectionState === 'generating' || connectionState === 'connecting' || connectionState === 'reconnecting') {
      clearSoftReconnectTimer();
    }

    return undefined;
  }, [clearSoftReconnectTimer, connectionState, isStreaming, safelyStopSession]);

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

      const now = Date.now();
      const generationLag = now - lastGenerationTickAtRef.current;
      const frameLag = now - lastRemoteFrameAtRef.current;

      if (generationLag > FREEZE_RESTART_THRESHOLD_MS && frameLag > FREEZE_RESTART_THRESHOLD_MS) {
        console.warn('Stream frozen. Restarting realtime session...');
        void flushBillableUsage();
        void restartRealtimeSession('generation-tick-watchdog');
      }
    }, RESTART_WATCHDOG_INTERVAL_MS);

    return clearFrameWatchdog;
  }, [clearFrameWatchdog, flushBillableUsage, isStreaming, restartRealtimeSession]);

  useEffect(() => {
    if (!isStreaming) {
      return;
    }

    void startWebcam(activeMode, { silent: true }).catch((error) => {
      console.error('Failed to apply camera profile:', error);
    });
  }, [activeMode, isStreaming, startWebcam]);

  useEffect(() => {
    if (!isStreaming || !realtimeClientRef.current) {
      return;
    }

    queueTransformSync(getDesiredTransformState());
  }, [
    isStreaming,
    featureMode,
    backgroundPrompt,
    prompt,
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
      });

      if (stream) {
        await restartRealtimeSession('camera-switched', { immediate: true });
      }

      userInitiatedCameraChangeRef.current = false;
    })();
  }, [activeMode, isStreaming, restartRealtimeSession, selectedCameraId, startWebcam]);

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
    if (featureMode === 'avatar' && !referenceImage) return 'Upload a reference image before starting.';
    if (featureMode === 'avatar' && isValidatingImage) return 'Morphly is checking the reference image.';
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

    if (featureModeRef.current === 'avatar' && !referenceImageRef.current) {
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
    setIsLoading(true);
    try {
      await revalidateStartRequirements();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Morphly could not validate the stream setup.';
      if (/camera|permission/i.test(message)) {
        setCameraError(message);
        void refreshCameras();
      }
      toast.error(message);
      setIsLoading(false);
      return;
    }

    setConnectionState('connecting');
    setUiStatus('Connecting...');
    trackConnectionStarted();
    setRuntimeModeCap('hd');
    resetHealthCounters();
    resetBillableUsageTracking();

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

    // The virtual camera is an optional output. Do not make webcam/Decart startup
    // wait for driver probing or fail when Windows cannot register the device.
    void virtualCameraStartPromise.then((virtualCameraStartResult) => {
      if (virtualCameraStartResult && virtualCameraStartResult.success === false) {
        morphlyCamWindowEnabledRef.current = false;
        const message = virtualCameraStartResult.error || virtualCameraStartResult.message || 'Morphly virtual camera is unavailable';
        console.warn('Morphly virtual camera is unavailable:', message);
        toast.warning(message);
      }
    });

    try {
      const stream = await startWebcam(activeMode, { forceNewStream: true });

      if (!stream) {
        throw new Error('Webcam start failed');
      }

      let realtimeClient: RealtimeClient | null = null;
      let lastConnectError: unknown;

      for (let attempt = 1; attempt <= AI_CONNECT_MAX_ATTEMPTS; attempt += 1) {
        console.log(`[AI_WS] Connection attempt ${attempt}`);
        const startResponse = await apiRequest<AiSessionResponse>('/start-session', {
          method: 'POST',
          body: JSON.stringify({
            userId: user?.id,
            installationId: getInstallationId(),
            platform: window.electron ? 'desktop' : 'web',
          }),
        });

        if (!startResponse.allowed) {
          throw new Error(startResponse.details || startResponse.error || 'Failed to create AI session');
        }

        const sessionToken = startResponse.token || '';
        if (!sessionToken) throw new Error('Missing session token');

        sessionTokenRef.current = sessionToken;
        sessionIdRef.current = startResponse.sessionId || '';

        const websocketUrl = startResponse.websocketUrl || 'wss://api3.decart.ai';
        const parsedWebsocketUrl = new URL(websocketUrl);
        console.log('[AI_DIAGNOSTICS]', {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          online: navigator.onLine,
          pageProtocol: location.protocol,
          pageHost: location.host,
          websocketProtocol: parsedWebsocketUrl.protocol,
          websocketHost: parsedWebsocketUrl.host,
          model: startResponse.model || DECART_REALTIME_MODEL,
          hasToken: Boolean(sessionToken),
          expiresAt: startResponse.expiresAt ?? null,
        });

        if (parsedWebsocketUrl.protocol !== 'wss:') {
          throw new Error(`Unsafe AI WebSocket protocol: ${parsedWebsocketUrl.protocol}`);
        }

        try {
          realtimeClient = await withTimeout(
            connectToDecart(stream, sessionToken, getDesiredTransformState(), { websocketUrl }),
            AI_CONNECT_TIMEOUT_MS,
            `AI connection timed out after ${AI_CONNECT_TIMEOUT_MS / 1000}s`,
          );
          if (!realtimeClient) throw new Error('Decart connection was not established');
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
          disconnectFromDecart({ skipStateUpdate: true });
          if (attempt < AI_CONNECT_MAX_ATTEMPTS) await sleep(attempt * 2000);
        }
      }

      if (!realtimeClient) throw lastConnectError || new Error('Decart connection was not established');

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      pollIntervalRef.current = setInterval(pollSessionStatus, POLLING_INTERVAL);
      // Usage flush interval is started by a useEffect once hasRemoteFrame
      // becomes true, preventing credit drain during the connection phase.
      setIsStreaming(true);
      setSessionStatus('LIVE');
      setUiStatus('Live');
      trackFirstFrameReceived(sessionIdRef.current || undefined);
    } catch (error) {
      console.error('Start session error:', error);
      trackConnectionFailed(sessionIdRef.current || undefined, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      const sessionExpired = error instanceof Error && (
        error.message === 'AUTH_SESSION_REQUIRED' ||
        /missing authorization|invalid or expired access token/i.test(error.message)
      );
      const toastMessage = sessionExpired ? 'Your session expired. Please sign in again.' : getStartSessionErrorToast(error);
      if (toastMessage) {
        toast.error(toastMessage);
      }

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
      disconnectFromDecart();
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
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      toast.error('Select a valid image file.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast.error('The reference image must be 15 MB or smaller.');
      return;
    }

    setIsValidatingImage(true);
    try {
      const bitmap = await createImageBitmap(file);
      bitmap.close();

      setReferenceImage({
        file,
        name: file.name,
        signature: `${file.name}:${file.size}:${file.lastModified}`,
      });
    } catch (error) {
      console.error('Reference image validation failed:', error);
      toast.error('Morphly could not read that image. Select another image file.');
      return;
    } finally {
      setIsValidatingImage(false);
    }

    if (isStreaming) {
      toast.info('Updating reference image...');
    } else {
      toast.success('Reference image selected. Click Start to begin streaming.');
    }
  };

  const handleModeChange = (mode: string) => {
    if (!mode) {
      return;
    }

    userSelectedModeRef.current = true;
    setPreferredMode(mode as QualityMode);
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
      toast.error('Morphly could not change the display mode.');
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
      toast.error('The guide finished, but Morphly could not save the completion state.');
    });
  };

  const handleTourSkip = () => {
    setIsTourRunning(false);
    void updateOnboardingState('skip').catch((error) => {
      console.warn('Unable to save guided-tour skip state:', error);
      toast.error('Morphly could not save the skipped guide state.');
    });
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-black font-sans text-white">
      <main
        data-tour="dashboard"
        className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#000000] shadow-inner"
      >
        <UpdateBanner />
        <video
          id="output"
          ref={outputVideoRef}
          autoPlay
          playsInline
          muted
          onLoadedData={markRemoteFrameFresh}
          onPlaying={markRemoteFrameFresh}
          className="h-full w-full object-cover transition-[opacity,filter] duration-200"
          style={{
            display: isStreaming ? 'block' : 'none',
            opacity: hasRemoteFrame ? 1 : 0.85,
            willChange: 'transform, opacity',
            transform: 'translateZ(0)',
            backfaceVisibility: 'hidden',
            imageRendering: 'auto',
          }}
        />

        {!isStreaming && (
          <div className="flex flex-col items-center justify-center gap-5 text-[#3F3F46]">
            <Monitor className="h-[60px] w-[60px] stroke-[1]" />
            <span className="text-xs font-semibold tracking-[0.2em] text-[#4A4A4A]">CAMERA FEED OFFLINE</span>
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

        {isStreaming && (isLoading || isSyncingTransform || connectionState === 'reconnecting' || !hasRemoteFrame) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20 flex justify-center px-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/55 px-4 py-2 text-xs text-white/90 shadow-xl shadow-black/30 backdrop-blur-md">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              <span>
                {isSyncingTransform
                  ? 'Applying prompt/image changes without reconnecting...'
                  : connectionState === 'reconnecting'
                    ? 'Reconnecting stream...'
                    : 'Preparing realtime output...'}
              </span>
            </div>
          </div>
        )}

        {/* Mode Switcher */}
        <div className="absolute left-6 top-6 z-20 flex items-center gap-1 rounded-full border border-white/10 bg-black/60 p-1 backdrop-blur-md shadow-lg shadow-black/50">
          <button
            type="button"
            onClick={() => setFeatureMode('avatar')}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
              featureMode === 'avatar'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <User className="h-3.5 w-3.5" />
            <span>Avatar Morph</span>
          </button>
          <button
            type="button"
            onClick={() => setFeatureMode('background')}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
              featureMode === 'background'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>AI Background</span>
          </button>
        </div>

        <div className="absolute right-6 top-6 z-20 flex items-center gap-2">
          <button
            type="button"
            title={isFullScreen ? 'Exit full screen' : 'Full screen'}
            aria-label={isFullScreen ? 'Exit full screen' : 'Switch to full screen'}
            onClick={() => void handleFullScreenToggle()}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-white/5 bg-black/40 px-3 text-xs font-semibold text-[#A1A1AA] backdrop-blur-md transition-all hover:scale-105 hover:text-white"
          >
            {isFullScreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            <span>{isFullScreen ? 'Exit Full Screen' : 'Full Screen'}</span>
          </button>
          <button
            data-tour="settings"
            title="Settings"
            aria-label="Open Settings"
            onClick={() => navigate('/settings')}
            className="rounded-full border border-white/5 bg-black/40 p-2.5 text-[#71717A] backdrop-blur-md transition-all hover:scale-110 hover:text-white"
          >
            <Settings className="h-5 w-5" />
          </button>
        </div>
      </main>

      <footer className="relative z-10 flex max-h-[30vh] flex-col gap-1.5 overflow-y-auto border-t border-white/5 bg-[#0A0A0A] px-3 py-1.5">
        {featureMode === 'background' && (
          <div className="flex flex-col gap-1 rounded-lg border border-[#222222] bg-[#111111] px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                AI Background Presets
              </span>
              <span className="text-[9px] text-zinc-500">Live Realtime Transformation</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {BACKGROUND_PRESETS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = activeBgPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setActiveBgPreset(preset.id);
                      setCustomBgPrompt('');
                      if (isStreaming) {
                        toast.info(`Switching background to ${preset.label}...`);
                      }
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[11px] font-medium transition-all ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-950/80 text-emerald-300 shadow-sm'
                        : 'border-[#2A2A2A] bg-[#1A1A1A] text-zinc-300 hover:border-zinc-500 hover:bg-[#242424]'
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 ${isSelected ? 'text-emerald-400' : 'text-zinc-400'}`} />
                    <span>{preset.label}</span>
                  </button>
                );
              })}
              <div className="flex flex-1 min-w-[220px] items-center gap-1">
                <input
                  type="text"
                  placeholder="Custom background (e.g. library with rain)..."
                  value={customBgPrompt}
                  onChange={(e) => setCustomBgPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (customBgPrompt.trim()) {
                        setActiveBgPreset('custom');
                        if (isStreaming) {
                          toast.info('Applying custom background...');
                        }
                      }
                    }
                  }}
                  className="h-[28px] flex-1 rounded-sm border border-[#2A2A2A] bg-[#161616] px-2 text-[11px] text-white placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (customBgPrompt.trim()) {
                      setActiveBgPreset('custom');
                      if (isStreaming) {
                        toast.info('Applying custom background...');
                      }
                    }
                  }}
                  disabled={!customBgPrompt.trim()}
                  className="flex h-[28px] items-center gap-1 rounded-sm border border-[#2A2A2A] bg-[#1E1E1E] px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-[#2A2A2A] disabled:opacity-40"
                >
                  <Send className="h-3 w-3" />
                  <span>Apply</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            data-tour="start-stream"
            onClick={handleStart}
            disabled={Boolean(startBlockReason)}
            className={`flex h-[30px] items-center gap-2 rounded-sm border px-3 transition-all ${
              startBlockReason
                ? 'border-[#133C29] bg-[#122A1F] text-[#22C55E] opacity-50'
                : 'border-[#133C29] bg-[#122A1F] text-[#22C55E] hover:bg-[#153828]'
            }`}
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            <span className="text-[13px] font-semibold tracking-wide">{isLoading ? 'STARTING' : 'Start'}</span>
          </button>

          <button
            data-tour="stop-stream"
            onClick={() => void handleStop()}
            disabled={!isStreaming}
            className="flex h-[30px] items-center gap-2 rounded-sm border border-[#2A2A2A] bg-[#1E1E1E] px-3 text-[#737373] transition-all hover:text-[#A3A3A3]"
          >
            <Square className="h-3.5 w-3.5 fill-current opacity-70" />
            <span className="text-[13px] font-medium">Stop</span>
          </button>

          <button
            data-tour="upload-image"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-[30px] items-center gap-2 rounded-sm border border-[#2A2A2A] bg-[#1E1E1E] px-3 text-[#737373] transition-all hover:text-[#A3A3A3]"
          >
            <Upload className="h-3.5 w-3.5 opacity-80" />
            <span className="text-[13px] font-medium">{referenceImage ? 'Change Image' : 'Upload Image'}</span>
          </button>

          <select
            value={preferredMode}
            onChange={(event) => handleModeChange(event.target.value)}
            title="Select performance mode"
            aria-label="Select performance mode"
            className="h-[30px] min-w-[128px] rounded-sm border border-[#2A2A2A] bg-[#1A1A1A] px-2 text-[11px] font-medium text-[#D4D4D8] transition-colors focus:border-[#3A3A3A] focus:outline-none"
          >
            <option value="fast">Fast Mode</option>
            <option value="balanced">Balanced Mode</option>
            <option value="hd">HD Mode</option>
          </select>

          <div
            data-tour="camera-selector"
            className="min-w-[260px] rounded-lg border border-[#2A2A2A] bg-[#111111] px-2.5 py-1"
          >
            <div className="mb-0.5 flex items-center justify-between gap-3">
              <label htmlFor="physical-camera-selector" className="text-[10px] font-bold uppercase tracking-wider text-[#d4d4d8]">
                Input camera
              </label>
              <button
                type="button"
                onClick={() => void refreshCameras({ requestPermission: true })}
                disabled={isRefreshingCameras || isStreaming || isLoading}
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 transition-colors hover:text-amber-200 disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshingCameras ? 'animate-spin' : ''}`} />
                Refresh Cameras
              </button>
            </div>
            <select
              id="physical-camera-selector"
              value={selectedCameraId}
              onChange={(event) => handleCameraChange(event.target.value)}
              title="Select your physical laptop or USB camera"
              aria-label="Input camera: select your physical laptop or USB camera"
              className="h-[30px] w-full rounded-sm border border-[#2A2A2A] bg-[#1E1E1E] px-2 text-[11px] text-[#D4D4D8] transition-colors focus:border-amber-400 focus:outline-none"
            >
              <option value="">Select your physical laptop or USB camera</option>
              {cameraDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Physical camera ${index + 1}`}
                </option>
              ))}
              {virtualCameraDevices.length > 0 && (
                <optgroup label="Virtual cameras cannot be used as input">
                  {virtualCameraDevices.map((device, index) => (
                    <option key={device.deviceId} value="" disabled>
                      {device.label || `Blocked virtual camera ${index + 1}`}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <p className="mt-0.5 text-[9px] leading-3 text-[#71717A]">
              Morphly Virtual Camera is the output camera. Do not select it here.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <div className="flex items-center gap-3 rounded-xl border border-[#222222] bg-[#111111] px-3 py-1.5">
            <div className="flex flex-col gap-[2px]">
              <span className="text-[8px] font-bold uppercase tracking-widest text-[#A1A1AA]">Credits</span>
              <div className="flex items-center gap-1.5">
                <Coins className="h-3.5 w-3.5 text-blue-400" />
                <span className="text-xs font-bold text-[#22C55E]">{Math.round(credits).toLocaleString()}</span>
              </div>
            </div>
            <button
              data-tour="buy-credits"
              onClick={() => navigate('/subscription')}
              className="ml-1 flex h-[28px] items-center gap-1 rounded-sm bg-[#FFFFFF] px-2.5 text-[11px] font-bold text-[#000000] shadow-sm transition-colors hover:bg-[#E5E5E5]"
            >
              <Plus className="h-3.5 w-3.5 stroke-[3]" />
              Buy Credits
            </button>
          </div>

        </div>
        </div>
        <div
          className={`rounded-md border px-3 py-1 text-[11px] leading-4 ${
            startBlockReason
              ? 'border-amber-400/20 bg-amber-400/5 text-amber-100'
              : 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200'
          }`}
          role="status"
          aria-live="polite"
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
