import { useCallback, useEffect, useState } from 'react';
import {
  AudioWaveform,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cpu,
  ExternalLink,
  FileAudio,
  LoaderCircle,
  Mic,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Volume2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';

type MeanVcModel = '40ms' | '120ms';
type MeanVcDevice = 'cpu' | 'cuda';
type MeanVcRuntimeState = 'stopped' | 'starting' | 'running' | 'failed';

type MeanVcModelStatus = {
  ready: boolean;
  missingFiles: string[];
};

type MeanVcStatus = {
  repository: {
    available: boolean;
    path: string;
  };
  python: {
    available: boolean;
    version: string | null;
    dependenciesAvailable: boolean;
    dependencyError: string | null;
  };
  models: Record<MeanVcModel, MeanVcModelStatus>;
  preload?: {
    engineState: 'loading' | 'ready' | 'failed' | 'stopped';
    engineMessage: string;
    microphoneOpen: boolean;
    voiceState: 'empty' | 'loading' | 'ready' | 'failed';
    preparedReferenceId: string | null;
  };
  standalone?: Record<MeanVcModel, {
    available: boolean;
    installing: boolean;
    progress: number;
    downloadedBytes: number;
    expectedBytes: number;
    path: string;
    engineReady?: boolean;
    engineInstalled?: boolean;
    engineError?: string | null;
    pythonVersion?: string | null;
    audioDevices?: {
      defaultInput: number;
      defaultOutput: number;
      inputName: string;
      outputName: string;
      inputCount: number;
      outputCount: number;
      inputs: Array<{ id: number; name: string; hostapi: string }>;
      outputs: Array<{ id: number; name: string; hostapi: string }>;
    } | null;
  }>;
  runtime: {
    state: MeanVcRuntimeState;
    message: string;
    pid: number | null;
    configuration: {
      model: MeanVcModel;
      device: MeanVcDevice;
      referenceId: string;
      pitch: number;
      inputDevice: number | null;
      outputDevice: number | null;
    } | null;
    startedAt: string | null;
    logs: Array<{
      source: string;
      message: string;
      timestamp: string;
    }>;
  };
};

type ApiError = {
  error?: string;
};

type ReadinessItem = {
  label: string;
  detail: string;
  ready: boolean;
};

async function readApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json() as T & ApiError;
  if (!response.ok) {
    throw new Error(data.error || `MorphlyVC request failed (${response.status}).`);
  }
  return data;
}

const MORPHLY_VC_ROUTES = {
  status: { path: '/api/local/meanvc/status', method: 'GET' },
  reference: { path: '/api/local/meanvc/reference', method: 'POST' },
  prepare: { path: '/api/local/meanvc/prepare', method: 'POST' },
  start: { path: '/api/local/meanvc/start', method: 'POST' },
  pitch: { path: '/api/local/meanvc/pitch', method: 'POST' },
  stop: { path: '/api/local/meanvc/stop', method: 'POST' },
} as const;

type MorphlyVcAction = keyof typeof MORPHLY_VC_ROUTES;

function usesPackagedVoiceBridge() {
  return window.location.protocol === 'file:' && Boolean(window.electron?.isElectron);
}

async function requestMorphlyVc<T>(action: MorphlyVcAction, payload?: Record<string, unknown> | File): Promise<T> {
  if (usesPackagedVoiceBridge()) {
    if (!window.electron) {
      throw new Error('The MorphlyVC desktop bridge is unavailable.');
    }

    if (action === 'reference') {
      if (!(payload instanceof File)) {
        throw new Error('Choose a valid WAV reference recording.');
      }
      return window.electron.invoke('morphlyvc:reference', {
        data: new Uint8Array(await payload.arrayBuffer()),
        fileName: payload.name,
      }) as Promise<T>;
    }

    return window.electron.invoke(`morphlyvc:${action}`, payload ?? {}) as Promise<T>;
  }

  const route = MORPHLY_VC_ROUTES[action];
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (payload instanceof File) {
    headers['Content-Type'] = 'audio/wav';
    headers['X-MeanVC-Filename'] = encodeURIComponent(payload.name);
    body = payload;
  } else if (route.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload ?? {});
  }

  return readApiResponse<T>(await fetch(route.path, { method: route.method, headers, body }));
}

function isVirtualMicrophonePlaybackDevice(name: string) {
  return /\bCABLE Input\b/i.test(name) || /VB-Audio.+Cable Input/i.test(name);
}

function isMultiChannelVirtualCableDevice(name: string) {
  return /\bCABLE In\s+\d+ch\b/i.test(name);
}

function isVirtualMicrophoneRecordingDevice(name: string) {
  return /\bCABLE Output\b/i.test(name) || /VB-Audio.+Cable Output/i.test(name);
}

function getSelectableMicrophoneInputs(devices: NonNullable<MeanVcStatus['standalone']>['40ms']['audioDevices']) {
  if (!devices) return [];
  const physicalInputs = devices.inputs.filter(({ name }) => !isVirtualMicrophoneRecordingDevice(name));
  return physicalInputs.length > 0 ? physicalInputs : devices.inputs;
}

function ReadinessRow({ item }: { item: ReadinessItem }) {
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <span
        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${
          item.ready
            ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
            : 'border-white/10 bg-white/[0.03] text-zinc-500'
        }`}
      >
        {item.ready
          ? <Check aria-hidden="true" className="size-2.5" />
          : <CircleAlert aria-hidden="true" className="size-2.5" />}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-zinc-200">{item.label}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-zinc-500">{item.detail}</p>
      </div>
    </div>
  );
}

export function MeanVcPanel() {
  const [status, setStatus] = useState<MeanVcStatus | null>(null);
  const model: MeanVcModel = '40ms';
  const device: MeanVcDevice = 'cpu';
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [hasConsent, setHasConsent] = useState(false);
  const [pitchSemitones, setPitchSemitones] = useState(0);
  const [inputDevice, setInputDevice] = useState<number | null>(null);
  const [outputDevice, setOutputDevice] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await requestMorphlyVc<MeanVcStatus>('status');
      const devices = nextStatus.standalone?.['40ms'].audioDevices;
      const virtualMicrophoneOutput = devices?.outputs.find(({ name }) => isVirtualMicrophonePlaybackDevice(name));
      const selectableInputs = getSelectableMicrophoneInputs(devices);
      const preferredInput = selectableInputs.find(({ id }) => id === devices?.defaultInput)?.id
        ?? selectableInputs[0]?.id
        ?? null;
      setInputDevice((current) => (
        selectableInputs.some(({ id }) => id === current) ? current : preferredInput
      ));
      setOutputDevice((current) => (
        devices?.outputs.some(({ id, name }) => id === current && !isMultiChannelVirtualCableDevice(name))
          ? current
          : virtualMicrophoneOutput?.id ?? devices?.defaultOutput ?? null
      ));
      setStatus(nextStatus);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to reach the local MorphlyVC service.');
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refreshStatus();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [refreshStatus]);

  const installing40ms = Boolean(status?.standalone?.['40ms'].installing);
  const installing120ms = Boolean(status?.standalone?.['120ms'].installing);
  const runtimeState = status?.runtime.state;
  const engineState = status?.preload?.engineState;
  const voiceState = status?.preload?.voiceState;
  const engineWarming = !status || engineState === 'loading';

  useEffect(() => {
    const installationActive = installing40ms || installing120ms;
    if (
      runtimeState !== 'starting'
      && runtimeState !== 'running'
      && engineState !== 'loading'
      && voiceState !== 'loading'
      && !installationActive
    ) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 2000);

    return () => window.clearInterval(interval);
  }, [
    refreshStatus,
    installing40ms,
    installing120ms,
    runtimeState,
    engineState,
    voiceState,
  ]);

  const selectedModelStatus = status?.models[model];
  const standaloneStatus = status?.standalone?.[model];
  const pythonReady = Boolean(status?.python.available && status.python.dependenciesAvailable);
  const bundledEngineReady = Boolean(standaloneStatus?.engineInstalled && standaloneStatus.engineReady);
  const runtimeReady = Boolean(
    bundledEngineReady
    || (
      status?.repository.available
      && pythonReady
      && selectedModelStatus?.ready
    ),
  );
  const runtimeActive = status?.runtime.state === 'starting' || status?.runtime.state === 'running';
  const voiceReady = Boolean(
    referenceId
    && status?.preload?.voiceState === 'ready'
    && status.preload.preparedReferenceId === referenceId,
  );
  const canStart = runtimeReady
    && Boolean(referenceFile)
    && voiceReady
    && inputDevice !== null
    && outputDevice !== null
    && hasConsent
    && !isBusy;
  const readinessItems: ReadinessItem[] = [
    {
      label: 'Model memory',
      detail: status?.preload?.engineMessage || 'Starting the local MorphlyVC engine',
      ready: bundledEngineReady,
    },
    {
      label: 'Microphone privacy',
      detail: status?.preload?.microphoneOpen
        ? `${standaloneStatus?.audioDevices?.inputName || 'Microphone'} is connected for live conversion`
        : 'Microphone is closed and will open only after Start',
      ready: bundledEngineReady,
    },
    {
      label: 'Voice profile',
      detail: voiceReady
        ? 'Selected voice is prepared for immediate start'
        : status?.preload?.voiceState === 'loading'
          ? 'Preparing the selected voice without opening the microphone'
          : 'Core model is ready; choose a WAV voice when needed',
      ready: voiceReady || bundledEngineReady || Boolean(selectedModelStatus?.ready),
    },
  ];
  const completedChecks = readinessItems.filter((item) => item.ready).length;
  const startRequirement = standaloneStatus?.installing
    ? `Installing the local voice engine — ${standaloneStatus.progress}% complete.`
    : engineWarming
      ? 'MorphlyVC is warming up. Your microphone remains off.'
    : !runtimeReady
      ? 'The local voice engine must finish setup before it can start.'
    : !referenceFile
      ? 'Select a WAV voice profile to continue.'
      : status?.preload?.voiceState === 'loading'
        ? 'Preparing the selected voice profile...'
        : !voiceReady
          ? 'Waiting for the selected voice profile to become ready.'
      : inputDevice === null
        ? 'Select a microphone input.'
        : outputDevice === null
          ? 'Select a speaker output.'
          : !hasConsent
            ? 'Confirm permission to use the selected voice.'
            : 'Ready to convert your microphone in real time.';

  useEffect(() => {
    if (
      !runtimeReady
      || !referenceId
      || runtimeActive
      || voiceReady
      || status?.preload?.voiceState === 'loading'
      || status?.preload?.voiceState === 'failed'
    ) {
      return;
    }

    let cancelled = false;
    void requestMorphlyVc<MeanVcStatus>('prepare', { referenceId })
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
          setError(null);
        }
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to prepare the selected voice.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [referenceId, runtimeActive, runtimeReady, status?.preload?.voiceState, voiceReady]);

  const handleReferenceChange = async (file: File | null) => {
    setReferenceId(null);
    setError(null);

    if (!file) {
      setReferenceFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.wav')) {
      setReferenceFile(null);
      setError('Choose a WAV recording for the target voice.');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setReferenceFile(null);
      setError('Reference recordings must be 25 MB or smaller.');
      return;
    }

    setReferenceFile(file);
    setIsBusy(true);
    try {
      const upload = await requestMorphlyVc<{ referenceId: string }>('reference', file);
      setReferenceId(upload.referenceId);
      await refreshStatus();
    } catch (requestError) {
      setReferenceFile(null);
      setError(requestError instanceof Error ? requestError.message : 'Unable to upload the selected voice.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleStart = async () => {
    if (!referenceFile || !canStart) {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      const nextReferenceId = referenceId;
      if (!nextReferenceId) return;

      setStatus(await requestMorphlyVc<MeanVcStatus>('start', {
        model,
        device,
        referenceId: nextReferenceId,
        pitch: pitchSemitones,
        inputDevice,
        outputDevice,
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to start MorphlyVC.');
    } finally {
      setIsBusy(false);
    }
  };

  const handlePitchCommit = async (nextPitch: number) => {
    setPitchSemitones(nextPitch);
    if (!runtimeActive) {
      return;
    }

    setError(null);
    try {
      setStatus(await requestMorphlyVc<MeanVcStatus>('pitch', { pitch: nextPitch }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to update the live pitch.');
    }
  };

  const handleStop = async () => {
    setIsBusy(true);
    setError(null);
    try {
      setStatus(await requestMorphlyVc<MeanVcStatus>('stop'));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to stop MorphlyVC.');
    } finally {
      setIsBusy(false);
    }
  };

  const stateLabel = status?.runtime.state === 'running'
    ? 'Live'
    : status?.runtime.state === 'starting'
      ? 'Starting'
      : engineWarming
        ? 'Warming up'
      : runtimeReady
        ? 'Ready'
        : 'Setup needed';
  const audioDevices = standaloneStatus?.audioDevices;
  const selectableMicrophoneInputs = getSelectableMicrophoneInputs(audioDevices);
  const virtualMicrophoneOutput = audioDevices?.outputs.find(({ name }) => isVirtualMicrophonePlaybackDevice(name));
  const virtualMicrophoneInput = audioDevices?.inputs.find(({ name }) => isVirtualMicrophoneRecordingDevice(name));
  const virtualMicrophoneReady = Boolean(virtualMicrophoneOutput && virtualMicrophoneInput);

  const openVirtualMicrophoneSetup = async () => {
    setError(null);
    try {
      if (window.electron?.isElectron) {
        await window.electron.invoke('virtual-microphone:open-setup');
      } else {
        window.open('https://vb-audio.com/Cable/', '_blank', 'noopener,noreferrer');
      }
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : 'Unable to open virtual microphone setup.');
    }
  };

  return (
    <aside data-morphly-voice-panel className="flex w-[clamp(340px,27vw,380px)] shrink-0 flex-col overflow-hidden border-r border-[#252833] bg-[#111318] text-zinc-100">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-[#252833] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-blue-400/25 bg-blue-500/10">
            <AudioWaveform aria-hidden="true" className="size-[18px] text-blue-300" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold tracking-[-0.01em] text-white">MorphlyVC</h2>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">Live voice processing</p>
          </div>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-2">
          <Badge
            variant="outline"
            className={runtimeActive
              ? 'h-6 rounded border-emerald-400/25 bg-emerald-400/10 px-2 text-[10px] font-medium text-emerald-300'
              : runtimeReady || engineWarming
                ? 'h-6 rounded border-blue-400/25 bg-blue-400/10 px-2 text-[10px] font-medium text-blue-300'
                : 'h-6 rounded border-amber-400/25 bg-amber-400/10 px-2 text-[10px] font-medium text-amber-200'}
          >
            <span className={`size-1.5 rounded-full ${runtimeActive ? 'bg-emerald-300' : runtimeReady || engineWarming ? 'bg-blue-300' : 'bg-amber-300'}`} />
            {standaloneStatus?.installing ? `Installing ${standaloneStatus.progress}%` : stateLabel}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void refreshStatus()}
            title="Refresh MorphlyVC status"
            aria-label="Refresh MorphlyVC status"
            className="size-8 rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-blue-400/50"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 min-w-0 flex-1 overflow-x-hidden">
        <div className="w-full min-w-0 overflow-x-hidden">
          {!runtimeReady ? (
            <div className={`mx-4 mt-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${
              engineWarming
                ? 'border-blue-400/20 bg-blue-400/[0.06]'
                : 'border-amber-400/20 bg-amber-400/[0.07]'
            }`} role="status">
              <span className={`flex items-center gap-2 text-[11px] font-medium ${engineWarming ? 'text-blue-100' : 'text-amber-100'}`}>
                {engineWarming
                  ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-blue-300" />
                  : <CircleAlert aria-hidden="true" className="size-4 text-amber-300" />}
                {engineWarming ? 'Preparing local engine' : 'Engine setup incomplete'}
              </span>
              <span className={`text-[11px] tabular-nums ${engineWarming ? 'text-blue-200/70' : 'text-amber-200/70'}`}>
                {completedChecks}/{readinessItems.length}
              </span>
            </div>
          ) : null}

          {error ? (
            <div className="mx-4 mt-3 rounded-md border border-red-400/25 bg-red-400/[0.08] px-3 py-2 text-[11px] leading-5 text-red-200" role="alert">
              {error}
            </div>
          ) : null}

          <section aria-labelledby="voice-profile-heading" className="border-b border-[#252833] px-4 py-4">
            <div className="mb-2.5">
              <h3 id="voice-profile-heading" className="text-xs font-semibold text-zinc-100">Voice profile</h3>
              <p className="mt-1 text-[11px] leading-4 text-zinc-500">Choose a clear, consented WAV recording.</p>
            </div>

            <label
              htmlFor="meanvc-reference"
              className="group flex min-h-14 cursor-pointer items-center gap-2.5 rounded-md border border-dashed border-[#3a3e49] bg-[#0d0f14] px-3 outline-none transition-colors duration-200 hover:border-blue-400/50 hover:bg-blue-400/[0.03] focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-400/20"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded border border-[#30343e] bg-[#171920] text-zinc-500 transition-colors group-hover:text-blue-300">
                <FileAudio aria-hidden="true" className="size-4" />
              </div>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-zinc-200" title={referenceFile?.name}>
                  {referenceFile?.name || 'Select reference recording'}
                </span>
                <span className="mt-0.5 block text-[10px] text-zinc-500">WAV · up to 25 MB</span>
              </span>
              <span className="rounded border border-[#363a45] bg-[#1b1e25] px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors group-hover:border-blue-400/30 group-hover:text-white">
                Browse
              </span>
            </label>
            <input
              id="meanvc-reference"
              type="file"
              accept=".wav,audio/wav"
              className="sr-only"
              onChange={(event) => void handleReferenceChange(event.target.files?.[0] ?? null)}
            />
          </section>

          <section aria-labelledby="conversion-profile-heading" className="border-b border-[#252833] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 id="conversion-profile-heading" className="text-xs font-semibold text-zinc-100">Engine</h3>
                <p className="mt-1 text-[11px] text-zinc-500">Quality · 160 ms buffer · local processing</p>
              </div>
              <span className={`flex shrink-0 items-center gap-1.5 text-[10px] font-medium ${runtimeReady ? 'text-emerald-300' : engineWarming ? 'text-blue-300' : 'text-amber-300'}`}>
                <span className={`size-1.5 rounded-full ${runtimeReady ? 'bg-emerald-300' : engineWarming ? 'bg-blue-300' : 'bg-amber-300'}`} />
                {runtimeReady ? 'Ready' : engineWarming ? 'Loading' : 'Check setup'}
              </span>
            </div>
          </section>

          <section aria-labelledby="audio-routing-heading" className="border-b border-[#252833] px-4 py-4">
            <div className="mb-3">
              <h3 id="audio-routing-heading" className="text-xs font-semibold text-zinc-100">Audio routing</h3>
              <p className="mt-1 text-[11px] leading-4 text-zinc-500">Microphone remains closed until Start.</p>
            </div>

            <div className="space-y-2.5">
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="meanvc-input-device" className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                  <Mic aria-hidden="true" className="size-3.5 text-zinc-500" />
                  Microphone input
                </label>
                <Select
                  value={inputDevice === null ? undefined : String(inputDevice)}
                  onValueChange={(value) => setInputDevice(Number(value))}
                  disabled={runtimeActive}
                >
                  <SelectTrigger id="meanvc-input-device" className="h-9 w-full min-w-0 rounded-md border-[#30343e] bg-[#0d0f14] text-[11px] text-zinc-200 shadow-none hover:bg-[#16181f] focus-visible:ring-blue-400/40">
                    <SelectValue placeholder="Select microphone" />
                  </SelectTrigger>
                  <SelectContent className="border-[#303542] bg-[#171a22] text-zinc-200">
                    {selectableMicrophoneInputs.map((audioDevice) => (
                      <SelectItem key={audioDevice.id} value={String(audioDevice.id)}>
                        {audioDevice.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-0 space-y-1.5">
                <label htmlFor="meanvc-output-device" className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                  <Volume2 aria-hidden="true" className="size-3.5 text-zinc-500" />
                  Converted voice output
                </label>
                <Select
                  value={outputDevice === null ? undefined : String(outputDevice)}
                  onValueChange={(value) => setOutputDevice(Number(value))}
                  disabled={runtimeActive}
                >
                  <SelectTrigger id="meanvc-output-device" className="h-9 w-full min-w-0 rounded-md border-[#30343e] bg-[#0d0f14] text-[11px] text-zinc-200 shadow-none hover:bg-[#16181f] focus-visible:ring-blue-400/40">
                    <SelectValue placeholder="Select converted output" />
                  </SelectTrigger>
                  <SelectContent className="border-[#303542] bg-[#171a22] text-zinc-200">
                    {standaloneStatus?.audioDevices?.outputs
                      .filter(({ name }) => !isMultiChannelVirtualCableDevice(name))
                      .map((audioDevice) => (
                      <SelectItem key={audioDevice.id} value={String(audioDevice.id)}>
                        {audioDevice.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className={`rounded-md border p-2.5 ${
                virtualMicrophoneReady
                  ? 'border-emerald-400/20 bg-emerald-400/[0.055]'
                  : 'border-[#303542] bg-[#101219]'
              }`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`flex items-center gap-2 text-[11px] font-medium ${
                      virtualMicrophoneReady ? 'text-emerald-200' : 'text-zinc-300'
                    }`}>
                      <span className={`size-2 rounded-full ${virtualMicrophoneReady ? 'bg-emerald-300' : 'bg-zinc-600'}`} />
                      {virtualMicrophoneReady ? 'Virtual microphone connected' : 'Virtual microphone unavailable'}
                    </p>
                    <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                      {virtualMicrophoneReady
                        ? 'Use CABLE Output as the microphone in WhatsApp and calling apps.'
                        : 'Install VB-CABLE, then refresh the device list.'}
                    </p>
                  </div>
                  {!virtualMicrophoneReady ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void openVirtualMicrophoneSetup()}
                      className="h-8 shrink-0 rounded border-[#363b48] bg-[#1b1e25] text-[11px] text-zinc-200 hover:bg-[#252832]"
                    >
                      Setup
                      <ExternalLink aria-hidden="true" className="size-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
            {runtimeActive ? (
              <p className="mt-3 text-xs text-amber-200/70">Stop conversion before changing audio devices.</p>
            ) : null}
          </section>

          <section aria-labelledby="voice-tuning-heading" className="border-b border-[#252833] px-4 py-4">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h3 id="voice-tuning-heading" className="text-xs font-semibold text-zinc-100">Voice pitch</h3>
                <p className="mt-1 text-[11px] text-zinc-500">Adjust tone in semitones</p>
              </div>
              <Badge
                variant="outline"
                className="h-6 rounded border-blue-400/20 bg-blue-400/[0.06] font-mono text-[10px] tabular-nums text-blue-200"
              >
                {pitchSemitones > 0 ? '+' : ''}{pitchSemitones} st
              </Badge>
            </div>

            <div className="rounded-md border border-[#30343e] bg-[#0d0f14] px-3 py-3">
              <div className="mb-3 flex items-center justify-between text-[10px] text-zinc-500">
                <span>Deeper</span>
                <span className="font-medium text-zinc-300">
                  {pitchSemitones < 0 ? 'Low' : pitchSemitones > 0 ? 'Bright' : 'Natural'}
                </span>
                <span>Brighter</span>
              </div>
              <Slider
                aria-label="Voice pitch in semitones"
                min={-12}
                max={12}
                step={1}
                value={[pitchSemitones]}
                onValueChange={([value]) => setPitchSemitones(value)}
                onValueCommit={([value]) => void handlePitchCommit(value)}
                disabled={isBusy}
                className="[&_[data-slot=slider-range]]:bg-blue-400 [&_[data-slot=slider-thumb]]:border-blue-300"
              />
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                {[
                  { label: 'Deep', value: -4 },
                  { label: 'Natural', value: 0 },
                  { label: 'Bright', value: 4 },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    disabled={isBusy}
                    aria-pressed={pitchSemitones === preset.value}
                    onClick={() => void handlePitchCommit(preset.value)}
                    className={`h-7 rounded border px-2 text-[10px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                      pitchSemitones === preset.value
                        ? 'border-blue-400/35 bg-blue-400/15 text-blue-200'
                        : 'border-[#303542] bg-[#1a1d26] text-zinc-400 hover:bg-[#222631] hover:text-zinc-200'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-2 text-[10px] leading-4 text-zinc-500">
              {runtimeActive ? 'Pitch changes are applied when you release the control.' : 'This setting is applied when conversion starts.'}
            </p>
          </section>

          <Collapsible>
            <div className="border-b border-[#252833]">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group flex min-h-10 w-full items-center justify-between px-4 py-2.5 text-left text-[11px] font-medium text-zinc-300 transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/50"
                >
                  <span className="flex items-center gap-2.5">
                    {runtimeReady
                      ? <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-300" />
                      : <CircleAlert aria-hidden="true" className="size-4 text-amber-300" />}
                    System readiness
                    <span className="font-normal tabular-nums text-zinc-500">{completedChecks}/{readinessItems.length}</span>
                  </span>
                  <ChevronDown aria-hidden="true" className="size-3.5 text-zinc-500 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="divide-y divide-[#252833] border-t border-[#252833] px-4">
                  {readinessItems.map((item) => <ReadinessRow key={item.label} item={item} />)}
                </div>

                {status?.runtime.logs.length ? (
                  <div className="mx-4 mb-3 rounded border border-[#292d38] bg-[#0c0e13] p-2.5" role="log" aria-label="MorphlyVC runtime log">
                    {status.runtime.logs.slice(-4).map((entry) => (
                      <p key={`${entry.timestamp}-${entry.message}`} className="truncate font-mono text-[10px] leading-5 text-zinc-500" title={entry.message}>
                        {entry.message}
                      </p>
                    ))}
                  </div>
                ) : null}
              </CollapsibleContent>
            </div>
          </Collapsible>

          <div className="flex items-center justify-between px-4 py-3 text-[10px] text-zinc-600">
            <span className="flex items-center gap-1.5"><Cpu aria-hidden="true" className="size-3" />MorphlyVC CPU · 160 ms</span>
            <span>Apache-2.0</span>
          </div>
        </div>
      </ScrollArea>

      <footer className="shrink-0 border-t border-[#292d38] bg-[#0f1116] p-3">
        {runtimeActive ? (
          <div className="mb-2 flex items-center gap-2 rounded border border-emerald-400/20 bg-emerald-400/[0.06] px-2.5 py-2 text-[11px] text-emerald-200">
            <AudioWaveform aria-hidden="true" className="size-4" />
            Live voice processing is active
          </div>
        ) : (
          <label className="mb-2 flex cursor-pointer items-start gap-2 text-[11px] leading-4 text-zinc-400">
            <Checkbox
              checked={hasConsent}
              onCheckedChange={(checked) => setHasConsent(checked === true)}
              className="mt-0.5 size-4 border-white/25 data-[state=checked]:border-blue-500 data-[state=checked]:bg-blue-600"
            />
            <span>I have permission to use this voice responsibly.</span>
          </label>
        )}

        {runtimeActive ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleStop()}
            disabled={isBusy}
            className="h-9 w-full rounded-md border-red-400/25 bg-red-400/[0.07] text-xs font-semibold text-red-200 hover:bg-red-400/10 hover:text-red-100"
          >
            {isBusy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Square aria-hidden="true" className="fill-current" />}
            Stop voice conversion
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void handleStart()}
            disabled={!canStart}
            title={startRequirement}
            className="h-9 w-full rounded-md bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:bg-[#242832] disabled:text-zinc-500"
          >
            {isBusy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" className="fill-current" />}
            Start voice conversion
          </Button>
        )}

        <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-4" role="status" aria-live="polite" aria-atomic="true">
          <ShieldCheck aria-hidden="true" className={`mt-0.5 size-3.5 shrink-0 ${canStart || runtimeActive ? 'text-emerald-300' : 'text-zinc-600'}`} />
          <span className={canStart || runtimeActive ? 'text-emerald-200/80' : 'text-zinc-500'}>
            {runtimeActive ? status?.runtime.message : startRequirement}
          </span>
        </div>
      </footer>
    </aside>
  );
}
