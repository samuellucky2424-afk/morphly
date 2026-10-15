import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioWaveform,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cloud,
  Download,
  ExternalLink,
  FileAudio,
  LoaderCircle,
  Mic,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  Volume2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  LiveVoiceChanger,
  MAX_VOICE_UPLOAD_BYTES,
  VOICE_UPLOAD_ACCEPT,
  deleteVoice,
  isVirtualMicrophonePlaybackDevice,
  listAudioDevices,
  listVoices,
  uploadContentType,
  uploadVoice,
  type AudioDeviceOption,
  type LiveVoiceStats,
  type VoiceOption,
} from '@/lib/voice-changer';

type RuntimeState = 'stopped' | 'starting' | 'running';
type ReadinessItem = { label: string; detail: string; ready: boolean };
type AudioDevices = { inputs: AudioDeviceOption[]; outputs: AudioDeviceOption[]; virtualMicrophoneReady: boolean; labelsHidden: boolean };

const SELECTED_VOICE_KEY = 'morphly.voiceChanger.voiceId';
const selectTriggerClass = 'h-9 w-full min-w-0 rounded-md border-border bg-background text-[11px] text-foreground shadow-none hover:bg-background focus-visible:ring-ring/40';
const selectContentClass = 'morphly-voice-device-menu w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] max-h-[var(--radix-select-content-available-height)] border-border bg-background text-foreground';

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return 'Microphone access is blocked. Allow microphone access for Morphly in Windows Privacy settings, then try again.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'The selected microphone is not connected. Refresh devices.';
  if (error instanceof Error && error.message === 'AUTH_SESSION_REQUIRED') return 'Sign in again to use the voice changer.';
  return error instanceof Error && error.message ? error.message : fallback;
}

function ReadinessRow({ item }: { item: ReadinessItem }) {
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${
        item.ready ? 'border-success/20 bg-success-soft text-success' : 'border-border bg-muted text-muted-foreground'}`}>
        {item.ready ? <Check aria-hidden="true" className="size-2.5" /> : <CircleAlert aria-hidden="true" className="size-2.5" />}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-foreground">{item.label}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{item.detail}</p>
      </div>
    </div>
  );
}

export function VoiceChangerPanel() {
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(() => localStorage.getItem(SELECTED_VOICE_KEY));
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [routing, setRouting] = useState<{ input: string | null; output: string | null }>({ input: null, output: null });
  const [removeBackgroundNoise, setRemoveBackgroundNoise] = useState(false);
  const [hasConsent, setHasConsent] = useState(false);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('stopped');
  const [stats, setStats] = useState<LiveVoiceStats | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changerRef = useRef<LiveVoiceChanger | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const refreshVoices = useCallback(async () => {
    try {
      const next = await listVoices();
      setVoices(next);
      setVoicesError(null);
      setVoiceId(current => (current && next.some(voice => voice.id === current) ? current : next[0]?.id ?? null));
    } catch (requestError) {
      setVoicesError(errorMessage(requestError, 'Unable to load voices.'));
    }
  }, []);

  const refreshDevices = useCallback(async (requestAccess = false) => {
    try {
      const next = await listAudioDevices({ requestAccess });
      setDevices(next);
      setRouting(current => ({
        input: next.inputs.some(device => device.id === current.input) ? current.input
          : next.inputs.find(device => device.id === 'default')?.id ?? next.inputs[0]?.id ?? null,
        output: next.outputs.some(device => device.id === current.output) ? current.output
          : next.outputs.find(device => isVirtualMicrophonePlaybackDevice(device.name))?.id
            ?? next.outputs.find(device => device.id === 'default')?.id ?? next.outputs[0]?.id ?? null,
      }));
      if (requestAccess) setError(null);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Unable to list audio devices.'));
    }
  }, []);

  useEffect(() => {
    void refreshVoices();
    void refreshDevices();
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      void changerRef.current?.stop();
      changerRef.current = null;
    };
  }, [refreshVoices, refreshDevices]);

  useEffect(() => {
    if (voiceId) localStorage.setItem(SELECTED_VOICE_KEY, voiceId);
  }, [voiceId]);

  const runtimeActive = runtimeState !== 'stopped';
  const selectedVoice = voices?.find(voice => voice.id === voiceId) ?? null;
  const serviceReady = voices !== null && !voicesError;
  const ownVoices = voices?.filter(voice => voice.own) ?? [];
  const libraryVoices = voices?.filter(voice => !voice.own) ?? [];

  const handleUploadChange = (file: File | null) => {
    setError(null);
    if (!file) { setUploadFile(null); return; }
    if (!uploadContentType(file)) { setError('Upload a WAV, MP3, M4A, OGG, WEBM or FLAC voice recording.'); return; }
    if (file.size > MAX_VOICE_UPLOAD_BYTES) { setError('Voice recordings must be 3 MB or smaller.'); return; }
    setUploadFile(file);
    setUploadName(file.name.replace(/\.[^.]+$/, '').slice(0, 80));
  };

  const handleUpload = async () => {
    if (!uploadFile) return;
    if (!hasConsent) { setError('Confirm you have permission to use this voice before uploading it.'); return; }
    setIsUploading(true);
    setError(null);
    try {
      const voice = await uploadVoice(uploadFile, uploadName.trim() || 'My voice');
      setVoices(current => [voice, ...(current ?? []).filter(item => item.id !== voice.id)]);
      setVoiceId(voice.id);
      setUploadFile(null);
      setUploadName('');
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    } catch (requestError) {
      setError(errorMessage(requestError, 'Unable to upload the voice.'));
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteVoice = async () => {
    if (!selectedVoice?.own || !window.confirm(`Delete the voice "${selectedVoice.name}"?`)) return;
    setIsBusy(true);
    setError(null);
    try {
      await deleteVoice(selectedVoice.id);
      const remaining = (voices ?? []).filter(voice => voice.id !== selectedVoice.id);
      setVoices(remaining);
      setVoiceId(remaining[0]?.id ?? null);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Unable to delete the voice.'));
    } finally {
      setIsBusy(false);
    }
  };

  const canStart = serviceReady && Boolean(selectedVoice) && routing.input !== null && routing.output !== null
    && hasConsent && !isBusy && !isUploading;

  const handleStart = async () => {
    if (!canStart || !selectedVoice || routing.input === null || routing.output === null) return;
    setIsBusy(true);
    setError(null);
    setRuntimeState('starting');
    const changer = new LiveVoiceChanger({
      voiceId: selectedVoice.id,
      inputDeviceId: routing.input,
      outputDeviceId: routing.output,
      removeBackgroundNoise,
      onStats: setStats,
      onError: setError,
      onFatal: (message) => {
        changerRef.current = null;
        setRuntimeState('stopped');
        setStats(null);
        setError(`Voice conversion stopped. ${message}`);
      },
    });
    try {
      await changer.start();
      changerRef.current = changer;
      setRuntimeState('running');
      void refreshDevices();
    } catch (startError) {
      await changer.stop();
      setRuntimeState('stopped');
      setError(errorMessage(startError, 'Unable to start voice conversion.'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleStop = async () => {
    setIsBusy(true);
    try {
      await changerRef.current?.stop();
    } finally {
      changerRef.current = null;
      setRuntimeState('stopped');
      setStats(null);
      setIsBusy(false);
    }
  };

  const readinessItems: ReadinessItem[] = [
    { label: 'Voice service', detail: serviceReady ? 'Connected to the Morphly voice service' : voicesError || 'Connecting to the voice service', ready: serviceReady },
    {
      label: 'Microphone privacy',
      detail: runtimeActive ? 'Microphone is open for live conversion' : 'Microphone is closed and will open only after Start',
      ready: Boolean(devices?.inputs.length),
    },
    { label: 'Voice profile', detail: selectedVoice ? `${selectedVoice.name} is selected` : 'Choose a voice or upload your own', ready: Boolean(selectedVoice) },
  ];
  const completedChecks = readinessItems.filter(item => item.ready).length;
  const startRequirement = voicesError ? voicesError
    : !serviceReady ? 'Connecting to the voice service...'
      : !selectedVoice ? 'Choose a voice or upload a voice recording.'
        : routing.input === null ? 'Select a microphone input.'
          : routing.output === null ? 'Select a converted voice output.'
            : !hasConsent ? 'Confirm permission to use the selected voice.'
              : 'Ready to convert your voice after each phrase.';
  const runtimeMessage = runtimeState === 'starting' ? 'Opening the microphone...'
    : stats?.pending ? `Converting ${stats.pending === 1 ? 'a phrase' : `${stats.pending} phrases`}...`
      : stats?.listening ? 'Listening...'
        : stats?.lastLatencyMs ? `Live · last phrase converted in ${(stats.lastLatencyMs / 1000).toFixed(1)} s`
          : 'Live · speak, then pause briefly to hear your converted voice';
  const stateLabel = runtimeState === 'running' ? 'Live' : runtimeState === 'starting' ? 'Starting'
    : serviceReady ? 'Ready' : voicesError ? 'Setup needed' : 'Connecting';
  const connecting = !serviceReady && !voicesError;
  const virtualMicrophoneReady = Boolean(devices?.virtualMicrophoneReady);

  const [isInstallingVbCable, setIsInstallingVbCable] = useState(false);
  const [cableFeedback, setCableFeedback] = useState<{ message: string; failed: boolean } | null>(null);
  const installVirtualMicrophone = async () => {
    setError(null);
    if (!window.electron?.isElectron) {
      window.open('https://vb-audio.com/Cable/', '_blank', 'noopener,noreferrer');
      return;
    }
    setIsInstallingVbCable(true);
    setCableFeedback(null);
    try {
      const result = await window.electron.invoke('virtual-microphone:install') as { success: boolean; error?: string; restartRequired?: boolean };
      if (!result.success) {
        setCableFeedback({ message: result.error || 'VB-CABLE installation failed.', failed: !result.restartRequired });
        return;
      }
      setCableFeedback({ failed: false, message: result.restartRequired
        ? 'VB-CABLE is installed. Restart Windows to finish setup, then reopen Morphly.'
        : 'VB-CABLE is installed and ready. Use CABLE Output as the microphone in your calling app.' });
      void refreshDevices();
    } catch (installError) {
      setCableFeedback({ failed: true, message: installError instanceof Error ? installError.message : 'Unable to install VB-CABLE.' });
    } finally {
      setIsInstallingVbCable(false);
    }
  };

  return (
    <aside data-morphly-voice-panel className="flex w-full min-w-0 max-w-full shrink-0 flex-col border-b border-border bg-background text-foreground md:w-[clamp(320px,27vw,380px)] md:border-b-0 md:border-r">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/25 bg-accent">
            <AudioWaveform aria-hidden="true" className="size-[18px] text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">MorphlyVC</h2>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">Live voice processing</p>
          </div>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-2">
          <Badge
            variant="outline"
            className={runtimeActive || serviceReady
              ? 'h-6 rounded border-success/25 bg-success-soft px-2 text-[10px] font-medium text-success'
              : connecting
                ? 'h-6 rounded border-primary/25 bg-accent px-2 text-[10px] font-medium text-primary'
                : 'h-6 rounded border-warning/25 bg-warning-soft px-2 text-[10px] font-medium text-warning'}
          >
            <span className={`size-1.5 rounded-full ${runtimeActive || serviceReady ? 'bg-success' : connecting ? 'bg-primary' : 'bg-warning'}`} />
            {stateLabel}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => { void refreshVoices(); void refreshDevices(); }}
            title="Refresh MorphlyVC status"
            aria-label="Refresh MorphlyVC status"
            className="size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </header>

      <div
        role="region"
        aria-label="Voice settings"
        tabIndex={0}
        className="morphly-voice-settings min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <div className="w-full min-w-0 break-words">
          {voicesError ? (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-warning/20 bg-warning-soft px-3 py-2 text-[11px] font-medium text-warning" role="status">
              <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
              {voicesError}
            </div>
          ) : null}

          {error ? (
            <div className="mx-4 mt-3 rounded-md border border-destructive/25 bg-danger-soft px-3 py-2 text-[11px] leading-5 text-destructive" role="alert">
              {error}
            </div>
          ) : null}

          <section aria-labelledby="voice-profile-heading" className="border-b border-border px-4 py-4">
            <div className="mb-2.5">
              <h3 id="voice-profile-heading" className="text-xs font-semibold text-foreground">Voice profile</h3>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">Choose a voice, or upload a clear, consented recording.</p>
            </div>

            <div className="min-w-0 space-y-1.5">
              <label htmlFor="voice-changer-voice" className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <UserRound aria-hidden="true" className="size-3.5 text-muted-foreground" />
                Voice
              </label>
              <div className="flex min-w-0 items-center gap-1.5">
                <Select value={voiceId ?? ''} onValueChange={setVoiceId} disabled={runtimeActive || !voices?.length}>
                  <SelectTrigger id="voice-changer-voice" className={selectTriggerClass}>
                    <SelectValue placeholder={voices === null ? 'Loading voices...' : voices.length ? 'Select a voice' : 'No voices yet — upload one'}
                      className="block min-w-0 flex-1 truncate text-left" />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" className={selectContentClass}>
                    {ownVoices.length ? (
                      <SelectGroup>
                        <SelectLabel className="text-[10px] text-muted-foreground">My voices</SelectLabel>
                        {ownVoices.map(voice => (
                          <SelectItem key={voice.id} value={voice.id} className="whitespace-normal break-words [&>span:last-child]:min-w-0">{voice.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                    {libraryVoices.length ? (
                      <SelectGroup>
                        <SelectLabel className="text-[10px] text-muted-foreground">Voice library</SelectLabel>
                        {libraryVoices.map(voice => (
                          <SelectItem key={voice.id} value={voice.id} className="whitespace-normal break-words [&>span:last-child]:min-w-0">{voice.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                  </SelectContent>
                </Select>
                {selectedVoice?.previewUrl ? (
                  <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" title="Preview voice" aria-label="Preview voice"
                    onClick={() => void new Audio(selectedVoice.previewUrl!).play().catch(() => undefined)}>
                    <Play aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
                {selectedVoice?.own ? (
                  <Button type="button" variant="outline" size="icon" className="size-9 shrink-0 text-destructive hover:text-destructive"
                    title="Delete this voice" aria-label="Delete this voice" disabled={runtimeActive || isBusy} onClick={() => void handleDeleteVoice()}>
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>

            <label
              htmlFor="voice-changer-upload"
              className="group mt-3 flex min-h-14 cursor-pointer items-center gap-2.5 rounded-md border border-dashed border-border bg-background px-3 outline-none transition-colors duration-200 hover:border-primary/50 hover:bg-accent focus-within:border-primary/25 focus-within:ring-2 focus-within:ring-ring/20"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded border border-border bg-background text-muted-foreground transition-colors group-hover:text-primary">
                <FileAudio aria-hidden="true" className="size-4" />
              </div>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-foreground" title={uploadFile?.name}>
                  {uploadFile?.name || 'Upload a voice recording'}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">WAV, MP3, M4A · up to 3 MB · 1+ minute works best</span>
              </span>
              <span className="shrink-0 rounded border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors group-hover:border-primary/30 group-hover:text-foreground">
                Browse
              </span>
            </label>
            <input
              ref={uploadInputRef}
              id="voice-changer-upload"
              type="file"
              accept={VOICE_UPLOAD_ACCEPT}
              className="sr-only"
              disabled={runtimeActive || isUploading}
              onChange={(event) => handleUploadChange(event.target.files?.[0] ?? null)}
            />
            {uploadFile ? (
              <div className="mt-2 flex min-w-0 items-center gap-1.5">
                <input
                  type="text"
                  value={uploadName}
                  maxLength={80}
                  onChange={(event) => setUploadName(event.target.value)}
                  placeholder="Voice name"
                  aria-label="Voice name"
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
                <Button type="button" size="sm" className="h-8 shrink-0 text-[11px]" disabled={isUploading || !hasConsent} onClick={() => void handleUpload()}
                  title={hasConsent ? 'Create this voice' : 'Confirm permission below first'}>
                  {isUploading ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Sparkles aria-hidden="true" className="size-3.5" />}
                  {isUploading ? 'Creating...' : 'Create voice'}
                </Button>
              </div>
            ) : null}
            {uploadFile && !hasConsent ? (
              <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">Tick “I have permission to use this voice responsibly” below to create it.</p>
            ) : null}
          </section>

          <section aria-labelledby="audio-routing-heading" className="border-b border-border px-4 py-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 id="audio-routing-heading" className="text-xs font-semibold text-foreground">Audio routing</h3>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">Microphone remains closed until Start.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void refreshDevices(true)} disabled={runtimeActive || isBusy}>
                <RefreshCw aria-hidden="true" className="mr-1.5 size-3.5" />Refresh devices
              </Button>
            </div>

            <p role="status" className="mb-3 text-xs leading-5 text-muted-foreground">
              {!devices ? 'Detecting microphones and speakers...'
                : devices.labelsHidden ? 'Select Refresh devices and allow microphone access to see device names.'
                  : !devices.inputs.length || !devices.outputs.length
                    ? `${!devices.inputs.length ? 'No microphone detected. ' : ''}${!devices.outputs.length ? 'No speaker detected. ' : ''}Connect or enable the device in Windows Sound settings, then refresh devices.`
                    : `${devices.inputs.length} microphones and ${devices.outputs.length} outputs detected.`}
            </p>

            <div className="space-y-2.5">
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="voice-changer-input-device" className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Mic aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  Microphone input
                </label>
                <Select value={routing.input ?? ''} onValueChange={(value) => setRouting(current => ({ ...current, input: value }))} disabled={runtimeActive}>
                  <SelectTrigger id="voice-changer-input-device" className={selectTriggerClass}>
                    <SelectValue placeholder="Select microphone" className="block min-w-0 flex-1 truncate text-left" />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" className={selectContentClass}>
                    {devices?.inputs.map(device => (
                      <SelectItem key={device.id} value={device.id} className="whitespace-normal break-words [&>span:last-child]:min-w-0">{device.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-0 space-y-1.5">
                <label htmlFor="voice-changer-output-device" className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Volume2 aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  Converted voice output
                </label>
                <Select value={routing.output ?? ''} onValueChange={(value) => setRouting(current => ({ ...current, output: value }))} disabled={runtimeActive}>
                  <SelectTrigger id="voice-changer-output-device" className={selectTriggerClass}>
                    <SelectValue placeholder="Select converted output" className="block min-w-0 flex-1 truncate text-left" />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" className={selectContentClass}>
                    {devices?.outputs.map(device => (
                      <SelectItem key={device.id} value={device.id} className="whitespace-normal break-words [&>span:last-child]:min-w-0">{device.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className={`rounded-md border p-2.5 ${virtualMicrophoneReady ? 'border-success/20 bg-success-soft' : 'border-border bg-background'}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`flex items-center gap-2 text-[11px] font-medium ${virtualMicrophoneReady ? 'text-success' : 'text-foreground'}`}>
                      <span className={`size-2 shrink-0 rounded-full ${virtualMicrophoneReady ? 'bg-success' : 'bg-muted'}`} />
                      {virtualMicrophoneReady ? 'Virtual microphone connected' : 'Virtual microphone unavailable'}
                    </p>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      {virtualMicrophoneReady
                        ? 'Use CABLE Output as the microphone in WhatsApp and calling apps.'
                        : window.electron?.isElectron
                          ? 'Install Cable downloads the free VB-CABLE driver from vb-audio.com and sends your converted voice to calling apps.'
                          : 'Install VB-CABLE from vb-audio.com to send your converted voice to calling apps.'}
                    </p>
                  </div>
                  {!virtualMicrophoneReady ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isInstallingVbCable || runtimeActive}
                      onClick={() => void installVirtualMicrophone()}
                      className="h-8 shrink-0 gap-1.5 rounded border-border bg-background text-[11px] text-foreground hover:bg-background disabled:opacity-50"
                    >
                      {isInstallingVbCable ? (
                        <><LoaderCircle aria-hidden="true" className="size-3 animate-spin" /><span>Checking / installing...</span></>
                      ) : (
                        <>
                          <span>Install Cable</span>
                          {window.electron?.isElectron ? <Download aria-hidden="true" className="size-3" /> : <ExternalLink aria-hidden="true" className="size-3" />}
                        </>
                      )}
                    </Button>
                  ) : null}
                </div>
                {isInstallingVbCable ? (
                  <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
                    Downloading VB-CABLE from vb-audio.com. When Windows asks for administrator permission, choose Yes. The VB-CABLE installer will open and install the driver; close its window when it says installation is complete.
                  </p>
                ) : cableFeedback ? (
                  <p role={cableFeedback.failed ? 'alert' : 'status'} className={`mt-2 text-xs leading-5 ${cableFeedback.failed ? 'text-destructive' : 'text-success'}`}>
                    {cableFeedback.message}
                  </p>
                ) : null}
              </div>
            </div>
            {runtimeActive ? <p className="mt-3 text-xs text-warning">Stop conversion before changing audio devices.</p> : null}
          </section>

          <section aria-labelledby="voice-options-heading" className="border-b border-border px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 id="voice-options-heading" className="text-xs font-semibold text-foreground">Remove background noise</h3>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">Cleans your microphone before conversion. Leave off in quiet rooms.</p>
              </div>
              <Switch checked={removeBackgroundNoise} onCheckedChange={setRemoveBackgroundNoise} disabled={runtimeActive} aria-label="Remove background noise" />
            </div>
          </section>

          <Collapsible>
            <div className="border-b border-border">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group flex min-h-10 w-full items-center justify-between px-4 py-2.5 text-left text-[11px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                >
                  <span className="flex items-center gap-2.5">
                    {completedChecks === readinessItems.length
                      ? <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
                      : <CircleAlert aria-hidden="true" className="size-4 text-warning" />}
                    System readiness
                    <span className="font-normal tabular-nums text-muted-foreground">{completedChecks}/{readinessItems.length}</span>
                  </span>
                  <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                {runtimeActive && stats ? (
                  <div className="mx-4 mb-3 space-y-1 rounded border border-border bg-background p-3 text-xs leading-5">
                    <p className="font-semibold">Conversion</p>
                    <p>Phrases converted: {stats.phrases}</p>
                    <p className="text-muted-foreground">Last phrase: {stats.lastLatencyMs ? `${(stats.lastLatencyMs / 1000).toFixed(1)} s` : '—'} · In progress: {stats.pending}</p>
                  </div>
                ) : null}
                <div className="divide-y divide-border border-t border-border px-4">
                  {readinessItems.map(item => <ReadinessRow key={item.label} item={item} />)}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>

          <div className="flex items-center justify-between px-4 py-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><Cloud aria-hidden="true" className="size-3" />ElevenLabs speech-to-speech</span>
          </div>
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-background p-3">
        {runtimeActive ? (
          <div className="mb-2 flex items-center gap-2 rounded border border-success/20 bg-success-soft px-2.5 py-2 text-[11px] text-success">
            <AudioWaveform aria-hidden="true" className="size-4" />
            Live voice processing is active
          </div>
        ) : (
          <label className="mb-2 flex cursor-pointer items-start gap-2 text-[11px] leading-4 text-muted-foreground">
            <Checkbox
              checked={hasConsent}
              onCheckedChange={(checked) => setHasConsent(checked === true)}
              className="mt-0.5 size-4 shrink-0 border-border data-[state=checked]:border-primary/25 data-[state=checked]:bg-primary"
            />
            <span>I have permission to use this voice responsibly.</span>
          </label>
        )}

        {runtimeActive ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleStop()}
            disabled={isBusy && runtimeState !== 'starting'}
            className="h-9 w-full rounded-md border-destructive/25 bg-danger-soft text-xs font-semibold text-destructive hover:bg-danger-soft hover:text-destructive"
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
            className="h-9 w-full rounded-md bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {isBusy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" className="fill-current" />}
            Start voice conversion
          </Button>
        )}

        <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-4" role="status" aria-live="polite" aria-atomic="true">
          <ShieldCheck aria-hidden="true" className={`mt-0.5 size-3.5 shrink-0 ${canStart || runtimeActive ? 'text-success' : 'text-muted-foreground'}`} />
          <span className={canStart || runtimeActive ? 'text-success' : 'text-muted-foreground'}>
            {runtimeActive ? runtimeMessage : startRequirement}
          </span>
        </div>
      </footer>
    </aside>
  );
}
