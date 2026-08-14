import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createDecartClient, models, type RealTimeClient } from '@decartai/sdk';
import {
  Briefcase,
  Home,
  Trees,
  Camera,
  VideoOff,
  Loader2,
  Send,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetchWithAuth } from '@/lib/api-client';

export interface BackgroundPreset {
  id: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  prompt: string;
  avatarPrompt?: string;
  snippet?: string;
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'original',
    label: 'Original Room (Natural Camera)',
    description: 'Keep your real camera background',
    icon: Camera,
    prompt: '',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image.',
    snippet: '',
  },
  {
    id: 'office',
    label: 'Executive Office (Sitting at Desk)',
    description: 'Sitting in black leather chair at wooden desk with laptop & paperwork',
    icon: Briefcase,
    prompt: 'Change the background to a realistic executive office with a black leather desk chair, wooden desk with laptop and paperwork, window blinds, and natural warm indoor lighting, photorealistic real photo camera shot.',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image sitting naturally upright in a black leather executive office chair behind a wooden desk with an open laptop, notebooks, pen, window blinds, and natural warm indoor lighting, photorealistic candid webcam shot.',
    snippet: 'a realistic executive office with a black leather desk chair, wooden desk with laptop and paperwork, window blinds, and natural warm indoor lighting, photorealistic real photo.',
  },
  {
    id: 'room',
    label: 'Modern Living Room (Sunlit Interior)',
    description: 'Inside a bright modern home with wooden staircase and sunlit glass doors',
    icon: Home,
    prompt: 'Change the background to a bright modern home interior with an open wooden staircase, tall glass patio doors, clean architecture, indoor potted plants, and natural soft daylight, photorealistic real photo camera shot.',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image naturally inside a clean modern home interior with an open wooden staircase, tall sunlit glass doors, indoor potted plants, and soft natural daylight, photorealistic candid home webcam shot.',
    snippet: 'a bright modern home interior with an open wooden staircase, tall glass patio doors, clean architecture, and natural soft daylight, photorealistic real photo.',
  },
  {
    id: 'garden',
    label: 'Sunny Garden (Outdoor Lawn)',
    description: 'Sitting outdoors in a lush green backyard garden with trees and sunlight',
    icon: Trees,
    prompt: 'Change the background to a lush green backyard garden with leafy trees, blooming flowers, manicured green grass lawn, low wall, and warm natural outdoor sunlight, photorealistic real photo camera shot.',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image sitting comfortably outdoors in a lush green backyard garden with leafy green trees, grass lawn, low wall, and warm natural outdoor sunlight, photorealistic candid outdoor shot.',
    snippet: 'a lush green backyard garden with leafy trees, blooming flowers, manicured green grass lawn, and warm natural outdoor sunlight, photorealistic real photo.',
  },
];

export function buildDecartTransformPrompt(
  hasReferenceImage: boolean,
  presetId: string,
  customText: string = '',
): string {
  const customTrimmed = customText.trim();
  if (customTrimmed) {
    const cleanCustom = customTrimmed.replace(/^change the background to\s+/i, '');
    if (hasReferenceImage) {
      return `Substitute the character in the video with the person in the reference image, and change the background to ${cleanCustom}, natural room lighting, photorealistic candid shot.`;
    }
    return `Change the background to ${cleanCustom}, natural room lighting, photorealistic candid shot.`;
  }

  const preset = BACKGROUND_PRESETS.find((p) => p.id === presetId) || BACKGROUND_PRESETS[0];
  if (preset.id === 'original' || !preset.prompt) {
    return hasReferenceImage
      ? 'Substitute the character in the video with the person in the reference image.'
      : '';
  }

  if (hasReferenceImage && preset.avatarPrompt) {
    return preset.avatarPrompt;
  }

  if (hasReferenceImage && preset.snippet) {
    return `Substitute the character in the video with the person in the reference image naturally fitting into ${preset.snippet}`;
  }

  return preset.prompt;
}

export interface BackgroundReplacerProps {
  onStreamStateChange?: (isStreaming: boolean) => void;
  className?: string;
}

export function BackgroundReplacer({ onStreamStateChange, className = '' }: BackgroundReplacerProps) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [connectionState, setConnectionState] = useState<string>('disconnected');
  const [activePreset, setActivePreset] = useState<string>('office');
  const [customPrompt, setCustomPrompt] = useState('');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const realtimeClientRef = useRef<RealTimeClient | null>(null);

  const fetchClientToken = async (): Promise<{ token: string; websocketUrl?: string }> => {
    const response = await apiFetchWithAuth('/start-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'desktop' }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.details || errData.error || 'Failed to start AI session');
    }

    const data = await response.json();
    if (!data.allowed || !data.token) {
      throw new Error(data.details || data.error || 'AI session was not permitted');
    }

    return { token: data.token, websocketUrl: data.websocketUrl };
  };

  const stopStream = useCallback(() => {
    if (realtimeClientRef.current) {
      try {
        realtimeClientRef.current.disconnect();
      } catch (e) {
        console.warn('Error disconnecting realtime client:', e);
      }
      realtimeClientRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (outputVideoRef.current) {
      outputVideoRef.current.srcObject = null;
    }

    setIsStreaming(false);
    setIsLoading(false);
    setConnectionState('disconnected');
    setStatusMessage('');
    onStreamStateChange?.(false);
  }, [onStreamStateChange]);

  useEffect(() => {
    return () => {
      stopStream();
    };
  }, [stopStream]);

  const startStream = async () => {
    setError(null);
    setIsLoading(true);
    setStatusMessage('Accessing camera...');

    try {
      const model = models.realtime('lucy-latest');

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: model.width || 1280 },
          height: { ideal: model.height || 720 },
          frameRate: { ideal: typeof model.fps === 'number' ? model.fps : 30 },
        },
        audio: false,
      });
      localStreamRef.current = stream;

      setStatusMessage('Creating AI session...');
      const { token, websocketUrl } = await fetchClientToken();

      setStatusMessage('Connecting to Decart Realtime...');
      const client = createDecartClient({
        apiKey: token,
        ...(websocketUrl ? { realtimeBaseUrl: websocketUrl } : {}),
      });

      const initialPreset = BACKGROUND_PRESETS.find((p) => p.id === activePreset);
      const initialPrompt = customPrompt.trim() || initialPreset?.prompt || BACKGROUND_PRESETS[0].prompt;

      const rtClient = await client.realtime.connect(stream, {
        model,
        mirror: 'auto',
        initialState: {
          prompt: {
            text: initialPrompt,
            enhance: true,
          },
        },
        onRemoteStream: (remoteStream: MediaStream) => {
          if (outputVideoRef.current) {
            outputVideoRef.current.srcObject = remoteStream;
            void outputVideoRef.current.play().catch(console.error);
          }
        },
      });

      rtClient.on('connectionChange', (state) => {
        setConnectionState(state);
        if (state === 'disconnected') {
          stopStream();
        }
      });

      rtClient.on('error', (err: { message: string }) => {
        console.error('[Decart Realtime Error]', err);
        setError(err.message || 'Stream error');
      });

      realtimeClientRef.current = rtClient;
      setIsStreaming(true);
      setStatusMessage('Live');
      onStreamStateChange?.(true);
      toast.success('Live background replacement active!');
    } catch (err: any) {
      console.error('Background replacer error:', err);
      const msg = err.message || 'Failed to start background replacement';
      setError(msg);
      toast.error(msg);
      stopStream();
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectPreset = async (presetId: string) => {
    setActivePreset(presetId);
    setCustomPrompt('');
    const preset = BACKGROUND_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    if (realtimeClientRef.current && isStreaming) {
      try {
        setStatusMessage(`Switching to ${preset.label}...`);
        await realtimeClientRef.current.setPrompt(preset.prompt, { enhance: true });
        setStatusMessage('Live');
        toast.success(`Background updated: ${preset.label}`);
      } catch (err: any) {
        console.error('Failed to update prompt:', err);
        setError('Failed to switch background. Please try another.');
      }
    }
  };

  const handleCustomPromptSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customPrompt.trim()) return;

    setActivePreset('custom');
    if (realtimeClientRef.current && isStreaming) {
      try {
        setStatusMessage('Applying custom background...');
        const fullPrompt = customPrompt.toLowerCase().startsWith('change the background to')
          ? customPrompt
          : `Change the background to ${customPrompt}`;
        await realtimeClientRef.current.setPrompt(fullPrompt, { enhance: true });
        setStatusMessage('Live');
        toast.success('Custom background applied!');
      } catch (err: any) {
        console.error('Failed to apply custom prompt:', err);
        setError(err.message || 'Failed to apply custom background');
      }
    }
  };

  return (
    <div className={`flex flex-col h-full w-full max-w-5xl mx-auto p-4 gap-4 text-white ${className}`}>
      <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-400" />
            AI Live Background Replacement
          </h2>
          <p className="text-xs text-zinc-400">Decart Realtime API • Sub-500ms zero-latency video restyling</p>
        </div>
        <div className="flex items-center gap-3">
          {connectionState !== 'disconnected' && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950/80 border border-emerald-500/30 text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              {statusMessage || connectionState}
            </span>
          )}
          {!isStreaming ? (
            <button
              onClick={startStream}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-semibold text-xs transition disabled:opacity-50 shadow-lg shadow-emerald-900/30"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
              {isLoading ? 'Connecting...' : 'Start Background Camera'}
            </button>
          ) : (
            <button
              onClick={stopStream}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-600 font-semibold text-xs transition shadow-lg shadow-red-950/40"
            >
              <VideoOff className="w-4 h-4" />
              Stop Stream
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="underline ml-2">Dismiss</button>
        </div>
      )}

      <div className="relative aspect-video w-full rounded-2xl bg-zinc-950 border border-zinc-800 overflow-hidden flex items-center justify-center shadow-2xl">
        <video
          ref={outputVideoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover transition-opacity duration-300 ${
            isStreaming ? 'opacity-100' : 'opacity-0 hidden'
          }`}
        />

        {!isStreaming && !isLoading && (
          <div className="flex flex-col items-center gap-3 text-zinc-500 p-6 text-center">
            <Camera className="w-12 h-12 stroke-[1.2] text-zinc-600" />
            <div>
              <p className="text-sm font-semibold text-zinc-300">Live Background Replacement Ready</p>
              <p className="text-xs text-zinc-500 mt-1">Select a background preset below and start your camera feed.</p>
            </div>
          </div>
        )}

        {isLoading && (
          <div className="flex flex-col items-center gap-3 text-zinc-300">
            <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
            <p className="text-sm">{statusMessage || 'Initializing realtime connection...'}</p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 bg-zinc-900/70 p-4 rounded-xl border border-zinc-800">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
            Preset Backgrounds
          </label>
          <span className="text-[10px] text-zinc-500">Instant live switching</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
          {BACKGROUND_PRESETS.map((preset) => {
            const Icon = preset.icon;
            const isSelected = activePreset === preset.id;
            return (
              <button
                key={preset.id}
                onClick={() => handleSelectPreset(preset.id)}
                className={`flex flex-col items-center text-center gap-2 p-2.5 rounded-lg border text-xs font-medium transition-all ${
                  isSelected
                    ? 'bg-blue-600/20 border-blue-500 text-blue-300 shadow-md shadow-blue-900/30 scale-[1.02]'
                    : 'bg-zinc-800/60 border-zinc-700/60 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-500'
                }`}
              >
                <Icon className={`w-5 h-5 ${isSelected ? 'text-blue-400' : 'text-zinc-400'}`} />
                <span className="text-[11px] font-semibold">{preset.label}</span>
              </button>
            );
          })}
        </div>

        <form onSubmit={handleCustomPromptSubmit} className="flex gap-2 mt-1">
          <input
            type="text"
            placeholder="Type a custom background prompt (e.g. cozy library with soft rain outside)..."
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={!customPrompt.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white border border-zinc-700 transition disabled:opacity-40"
          >
            <Send className="w-3.5 h-3.5" />
            Apply
          </button>
        </form>
      </div>
    </div>
  );
}

export default BackgroundReplacer;
