import { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Play, Square, Clock, Zap, X, Activity, AlertTriangle, Camera, Monitor, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';

interface RealtimeClient {
  disconnect: () => void;
  set: (config: { prompt?: string; enhance?: boolean; image?: string | Blob | File }) => Promise<void>;
  setPrompt: (text: string, options?: { enhance?: boolean }) => Promise<void>;
}

const API_URL = import.meta.env.VITE_API_URL || '/api';

async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`API Error: ${response.statusText}`);
  }
  return response.json();
}

function Dashboard() {
  const { user } = useAuth();
  const { balance, setBalance, setSessionStatus } = useApp();
  const [isStreaming, setIsStreaming] = useState(false);
  const [isObsMode, setIsObsMode] = useState(false);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showLowBalanceWarning, setShowLowBalanceWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplyingPrompt, setIsApplyingPrompt] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [aiConnected, setAiConnected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const realtimeClientRef = useRef<RealtimeClient | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const PRICE_PER_SECOND = 69.2;
  const LOW_BALANCE_THRESHOLD = 5000;
  const POLLING_INTERVAL = 2000;


  useEffect(() => {
    if (balance <= LOW_BALANCE_THRESHOLD && balance > 0 && isStreaming) {
      setShowLowBalanceWarning(true);
    } else {
      setShowLowBalanceWarning(false);
    }
  }, [balance, isStreaming]);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (realtimeClientRef.current) {
        realtimeClientRef.current.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isObsMode) {
        setIsObsMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isObsMode]);

  const startWebcam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 }, 
          frameRate: { ideal: 30 },
          facingMode: 'user' 
        },
        audio: false
      });
      webcamStreamRef.current = stream;
      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (error) {
      console.error('Webcam error:', error);
      toast.error('Failed to access webcam. Please allow camera permissions.');
      return null;
    }
  };

  const stopWebcam = () => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach(track => track.stop());
      webcamStreamRef.current = null;
    }
    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }
  };

  const connectToDecart = async (stream: MediaStream, apiToken: string): Promise<RealtimeClient | null> => {
    try {
      const { createDecartClient, models } = await import('@decartai/sdk');
      
      const client = createDecartClient({
        apiKey: apiToken
      });
      
      const model = models.realtime('lucy_2_rt');

      console.log('[Decart] Connecting to Decart...');

      const realtimeClient = await client.realtime.connect(stream, {
        model,
        onRemoteStream: (editedStream: MediaStream) => {
          console.log('[Decart] STREAM RECEIVED', editedStream);
          console.log('[Decart] Stream tracks:', editedStream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.label}`));

          const video = outputVideoRef.current;
          if (!video) {
            console.error('[Decart] Video element not found!');
            return;
          }

          // Clear any previous stream
          if (video.srcObject) {
            video.srcObject = null;
          }

          video.srcObject = editedStream;

          // Low-latency playback settings
          video.playbackRate = 1.0;
          (video as any).latencyHint = 'interactive';

          video.onloadedmetadata = () => {
            console.log('[Decart] Video metadata loaded, attempting play...');
            video.play().catch((err) => {
              console.error('[Decart] Video play failed:', err);
            });
          };

          // Fallback: if metadata already loaded, play immediately
          if (video.readyState >= 2) {
            video.play().catch(() => {});
          }
        },
        initialState: {
          prompt: {
            text: prompt || "A person looking professional",
            enhance: true
          }
        }
      });

      console.log('[Decart] Connected! Client:', realtimeClient);

      realtimeClientRef.current = realtimeClient as any;
      setAiConnected(true);
      toast.success('Connected to AI!');

      // FIX 3: Apply transformation immediately after connecting
      try {
        const currentPrompt = prompt || 'A person looking professional';
        console.log('[Decart] Applying initial transformation:', currentPrompt);

        if (uploadedImage) {
          const imgResponse = await fetch(uploadedImage);
          const imgBlob = await imgResponse.blob();
          console.log('[Decart] Sending image blob:', imgBlob.type, imgBlob.size, 'bytes');
          await (realtimeClient as any).set({
            prompt: currentPrompt,
            enhance: true,
            image: imgBlob
          });
        } else {
          await (realtimeClient as any).setPrompt(currentPrompt, { enhance: true });
        }
        console.log('[Decart] Initial transformation applied successfully');
      } catch (setError) {
        console.error('[Decart] Failed to apply initial transformation:', setError);
      }

      return realtimeClient as any;
    } catch (error: any) {
      console.error('[Decart] SDK error:', error);
      console.error('[Decart] Error details:', error?.message, error?.code, error?.status);
      toast.error('Failed to connect to AI: ' + (error?.message || 'Unknown error'));
      
      // Fallback: show webcam
      if (outputVideoRef.current) {
        outputVideoRef.current.srcObject = stream;
      }
      
      const mockClient: RealtimeClient = {
        disconnect: () => {},
        set: async () => {},
        setPrompt: async () => {}
      };
      
      realtimeClientRef.current = mockClient;
      return mockClient;
    }
  };

  const applyTransformation = async () => {
    if (!prompt.trim()) {
      toast.error('Please enter a transformation prompt');
      return;
    }

    setIsApplyingPrompt(true);
    try {
      if (realtimeClientRef.current) {
        console.log('[Decart] Applying transformation with prompt:', prompt);

        // If image is uploaded, use set() with both prompt and image
        if (uploadedImage) {
          // Convert data URL to Blob
          console.log('[Decart] Image URL type:', uploadedImage.startsWith('data:') ? 'Data URL' : 'Remote URL');
          const response = await fetch(uploadedImage);
          const blob = await response.blob();
          console.log('[Decart] Image blob:', blob.type, blob.size, 'bytes');
          await realtimeClientRef.current.set({
            prompt: prompt,
            enhance: true,
            image: blob
          });
        } else {
          console.log('[Decart] No image, sending prompt only');
          await realtimeClientRef.current.setPrompt(prompt, { enhance: true });
        }
        console.log('[Decart] Transformation applied successfully');
        toast.success('Transformation applied!');
      } else {
        console.error('[Decart] Cannot apply - client not connected');
        toast.error('AI not connected');
      }
    } catch (error) {
      console.error('[Decart] Apply transformation error:', error);
      toast.error('Failed to apply transformation');
    }
    setIsApplyingPrompt(false);
  };

  const disconnectFromDecart = () => {
    if (realtimeClientRef.current) {
      realtimeClientRef.current.disconnect();
      realtimeClientRef.current = null;
    }
    if (outputVideoRef.current) {
      outputVideoRef.current.srcObject = null;
    }
  };

  const pollSessionStatus = useCallback(async () => {
    try {
      const response = await apiRequest<{ balance: number; secondsUsed: number; cost: number; remainingBalance?: number; shouldStop: boolean; forceEnd?: boolean }>(`/session-status?userId=${user?.id}`);
      
      const latestBalance = response.remainingBalance !== undefined ? response.remainingBalance : response.balance;
      setBalance(latestBalance);
      setElapsedSeconds(response.secondsUsed);

      if (response.shouldStop || response.forceEnd) {
        handleStop();
        toast.error('Session auto-ended (Rule: Safety Constraint Met)');
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, []);

  const handleStart = async () => {
    setIsLoading(true);
    setAiConnected(false);
    try {
      // Try to start session on backend
      let sessionToken = '';
      try {
        const startResponse = await apiRequest<{ allowed: boolean; token?: string; error?: string }>('/start-session', {
          method: 'POST',
          body: JSON.stringify({ userId: user?.id })
        });
        
        if (!startResponse.allowed) {
          toast.error(startResponse.error || 'Insufficient balance');
          setIsLoading(false);
          return;
        }
        
        sessionToken = startResponse.token || '';
      } catch (e) {
        toast.error('Failed to authenticate start session with backend.');
        setIsLoading(false);
        return;
      }

      // Start webcam
      const stream = await startWebcam();
      if (!stream) {
        setIsLoading(false);
        return;
      }

      // Connect to AI using backend token
      await connectToDecart(stream, sessionToken);

      setIsStreaming(true);
      setSessionStatus('LIVE');
      
      // Start polling if backend is available
      try {
        pollIntervalRef.current = setInterval(pollSessionStatus, POLLING_INTERVAL);
      } catch {
        console.warn('Polling not available');
      }
      
      toast.success('Stream started! Click "Apply" to transform.');
    } catch (error) {
      console.error('Start session error:', error);
      toast.error('Failed to start session');
      stopWebcam();
      disconnectFromDecart();
    }
    setIsLoading(false);
  };

  const handleStop = async () => {
    try {
      await apiRequest('/end-session', { 
        method: 'POST',
        body: JSON.stringify({ userId: user?.id })
      });
    } catch (error) {
      console.error('Stop session error:', error);
    }

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    disconnectFromDecart();
    stopWebcam();
    
    setIsStreaming(false);
    setSessionStatus('IDLE');
    setElapsedSeconds(0);
    
    toast.info('Session stopped');
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setUploadedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
      toast.success('Image selected');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const inputEvent = new Event('change', { bubbles: true });
      Object.defineProperty(inputEvent, 'target', { value: { files: dataTransfer.files } });
      fileInputRef.current?.dispatchEvent(inputEvent);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const removeImage = () => {
    setUploadedImage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const formatTime = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatRemainingTime = (amount: number) => {
    const totalMinutes = Math.floor(amount / PRICE_PER_SECOND / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  };

  const getRemainingSeconds = () => {
    return Math.floor(balance / PRICE_PER_SECOND);
  };

  return (
    <div>

      <div className="grid grid-cols-12 gap-5">
        <div className="col-span-12 lg:col-span-10 space-y-4">
          <div className="space-y-6">
            <div className="flex items-center justify-end">
              {isStreaming && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-full shadow-lg shadow-red-500/10 animate-pulse">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                  <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">Streaming</span>
                  </div>
                )}
              </div>
              <div className={isObsMode ? "fixed inset-0 z-[9999] bg-black flex flex-col" : "aspect-video bg-gradient-to-br from-[#18181b] via-[#131316] to-[#0f0f10] rounded-2xl border border-[#1f1f23] overflow-hidden relative group shadow-2xl shadow-black/30"}>
                {!isObsMode && <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>}
                
                {/* OBS Mode Instructions - Hidden after entering full screen */}
                {!isObsMode && isStreaming && (
                  <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center backdrop-blur-sm" style={{ display: 'none' }}></div>
                )}
                {isObsMode && (
                  <div className="absolute top-4 right-4 bg-black/70 text-[#a1a1aa] px-4 py-2.5 rounded-xl text-xs font-medium backdrop-blur border border-white/10 flex items-center gap-3 z-50 shadow-2xl">
                    <span className="flex items-center gap-2">
                      <Monitor className="w-3.5 h-3.5 text-emerald-400" />
                      OBS Capture Active
                    </span>
                    <div className="w-px h-3 bg-white/20"></div>
                    <span className="flex items-center gap-1.5">
                      Press <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-white font-bold">ESC</kbd> to exit
                    </span>
                  </div>
                )}

                <div className={isObsMode ? "w-full h-full relative" : "w-full h-full flex items-center justify-center relative"}>
                  {/* Always render video so ref is available when onRemoteStream fires */}
                  <video 
                    id="output"
                    ref={outputVideoRef}
                    autoPlay 
                    playsInline
                    muted
                    disablePictureInPicture
                    className={isObsMode ? "w-full h-full object-cover" : "w-full h-full object-cover rounded-2xl"}
                    style={{ background: 'black', display: isStreaming ? 'block' : 'none', willChange: 'contents' }}
                  />
                  {!isStreaming && !isObsMode && (
                    <div className="text-center">
                      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-[#1f1f23] to-[#18181b] flex items-center justify-center mx-auto mb-4 shadow-2xl shadow-black/40 border border-[#27272a]/50">
                        <Camera className="w-8 h-8 text-[#52525b]" />
                      </div>
                      <p className="text-base text-[#a1a1aa] mb-1 font-medium">No active stream</p>
                      <p className="text-xs text-[#52525b]">Add a prompt and click Start</p>
                    </div>
                  )}
                </div>
              </div>
              {!isObsMode && (
                <div className="flex items-center gap-4 text-sm text-[#71717a]">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-red-500 animate-pulse' : 'bg-[#52525b]'}`} />
                    Webcam: {isStreaming ? 'Active' : 'Inactive'}
                  </div>
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400" />
                    Rate: ₦{PRICE_PER_SECOND}/sec
                  </div>
                </div>
              )}
            </div>

            <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
              <CardContent className="p-4">
                <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Button 
                      className="h-9 px-5 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold rounded-lg shadow-xl shadow-blue-600/30 transition-all duration-300 text-xs hover:shadow-blue-500/40 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                      onClick={handleStart}
                      disabled={isStreaming || isLoading}
                    >
                      <Play className="w-3.5 h-3.5 mr-1.5" />
                      {isLoading ? 'Starting...' : 'Start'}
                    </Button>
                    <Button 
                      variant="ghost"
                      className="h-9 px-4 text-[#71717a] hover:text-white hover:bg-[#18181b] font-medium rounded-lg transition-all duration-300 text-xs border border-[#27272a]/50 hover:border-[#3f3f46] disabled:opacity-50"
                      onClick={handleStop}
                      disabled={!isStreaming}
                    >
                      <Square className="w-3.5 h-3.5 mr-1.5" />
                      Stop
                    </Button>
                    <div className="w-px h-7 bg-[#27272a] mx-0.5"></div>
                    <Button 
                      variant="outline"
                      className="h-9 px-3 text-[#a1a1aa] hover:text-white hover:bg-emerald-500/10 hover:border-emerald-500/30 font-medium rounded-lg transition-all duration-300 text-xs border-[#27272a]/50 bg-[#18181b]/50 disabled:opacity-50"
                      onClick={() => setIsObsMode(true)}
                      disabled={!isStreaming}
                    >
                      <Monitor className="w-3.5 h-3.5 mr-1.5 text-emerald-500" />
                      OBS
                    </Button>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-left">
                      <p className="text-[9px] font-medium text-[#71717a] uppercase tracking-widest mb-0.5">Elapsed</p>
                      <p className="text-base font-bold text-white font-mono tabular-nums tracking-tight">
                        {formatTime(elapsedSeconds)}
                      </p>
                    </div>
                    <div className="w-px h-8 bg-[#27272a]"></div>
                    <div className="text-left">
                      <p className="text-[9px] font-medium text-[#71717a] uppercase tracking-widest mb-0.5">Balance</p>
                      <p className={`text-base font-bold tracking-tight ${balance <= LOW_BALANCE_THRESHOLD ? 'text-amber-400' : 'text-white'}`}>
                        ₦{Math.round(balance).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
              <CardHeader className="pb-3 border-b border-[#1f1f23]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center border border-blue-500/20 shadow-lg shadow-blue-500/10">
                      <Activity className="w-3.5 h-3.5 text-blue-500" />
                    </div>
                    <div>
                      <CardTitle className="text-sm font-semibold text-white tracking-tight">Session Stats</CardTitle>
                      <p className="text-[10px] text-[#71717a] mt-0.5">Usage metrics</p>
                    </div>
                  </div>
                  {balance <= LOW_BALANCE_THRESHOLD && isStreaming && (
                    <Button className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-white font-bold px-3 h-8 rounded-lg shadow-lg shadow-amber-500/30 transition-all duration-300 animate-pulse text-xs">
                      <Wallet className="w-3 h-3 mr-1" />
                      Add
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-3">
                {showLowBalanceWarning && (
                  <div className="mb-3 p-3 bg-gradient-to-r from-amber-500/15 to-orange-500/10 border border-amber-500/30 rounded-lg flex items-center gap-2 animate-pulse">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs font-bold text-amber-400">⚠️ Low credits!</p>
                      <p className="text-[10px] text-white mt-0.5">
                        <span className="font-bold text-amber-400">{getRemainingSeconds()}s</span> remaining
                      </p>
                    </div>
                    <Button className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-black font-bold px-3 h-8 rounded-lg shadow-lg shadow-amber-500/30 transition-all duration-200 text-xs">
                      <Wallet className="w-3 h-3 mr-1" />
                      Add
                    </Button>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-[#18181b]/60 border border-[#1f1f23] hover:border-[#27272a] transition-all duration-200">
                    <div className="w-8 h-8 rounded-lg bg-[#1f1f23] flex items-center justify-center flex-shrink-0 border border-[#27272a]">
                      <Clock className="w-3.5 h-3.5 text-[#a1a1aa]" />
                    </div>
                    <div>
                      <p className="text-[9px] font-medium text-[#71717a] uppercase tracking-widest mb-0.5">Time</p>
                      <p className="text-base font-bold text-white font-mono tabular-nums tracking-tight">{formatTime(elapsedSeconds)}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-[#18181b]/60 border border-[#1f1f23] hover:border-[#27272a] transition-all duration-200">
                    <div className="w-8 h-8 rounded-lg bg-[#1f1f23] flex items-center justify-center flex-shrink-0 border border-[#27272a]">
                      <Wallet className="w-3.5 h-3.5 text-[#a1a1aa]" />
                    </div>
                    <div>
                      <p className="text-[9px] font-medium text-[#71717a] uppercase tracking-widest mb-0.5">Credits</p>
                      <p className="text-base font-bold text-white font-mono tabular-nums tracking-tight">{formatRemainingTime(balance)}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/20 hover:border-amber-500/30 transition-all duration-200">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center flex-shrink-0 border border-amber-500/30">
                      <Zap className="w-3.5 h-3.5 text-amber-400" />
                    </div>
                    <div>
                      <p className="text-[9px] font-medium text-[#71717a] uppercase tracking-widest mb-0.5">Rate</p>
                      <p className="text-base font-bold text-white tracking-tight">₦{PRICE_PER_SECOND}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="col-span-12 lg:col-span-2 space-y-3">
            <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-xl shadow-2xl shadow-black/20">
              <CardHeader className="pb-2 border-b border-[#1f1f23] px-4 pt-4">
                <CardTitle className="text-xs font-semibold text-white tracking-tight flex items-center gap-1.5">
                  Transform Prompt
                  {aiConnected && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                <Input 
                  placeholder="Describe your look..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isStreaming) {
                      applyTransformation();
                    }
                  }}
                  className="h-9 bg-[#18181b] border-[#27272a] text-white placeholder:text-[#52525b] rounded-lg text-xs focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20 transition-all duration-200 shadow-lg shadow-black/10"
                />
                <Button 
                  onClick={applyTransformation}
                  disabled={!isStreaming || !prompt.trim() || isApplyingPrompt}
                  className="w-full h-8 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-bold rounded-lg shadow-lg shadow-purple-500/30 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                >
                  <Zap className="w-3 h-3 mr-1" />
                  {isApplyingPrompt ? 'Applying...' : 'Apply'}
                </Button>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-xl shadow-2xl shadow-black/20">
              <CardHeader className="pb-2 border-b border-[#1f1f23] px-4 pt-4">
                <CardTitle className="text-xs font-semibold text-white tracking-tight">Reference Image</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/*"
                  className="hidden"
                  id="image-upload"
                />
                <div
                  className={`border-2 border-dashed rounded-lg p-3 text-center transition-all duration-300 cursor-pointer ${
                    isDragging 
                      ? 'border-blue-500 bg-blue-500/5 shadow-lg shadow-blue-500/10' 
                      : 'border-[#3f3f46] hover:border-[#52525b] hover:bg-[#1a1a1e]'
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                >
                  {uploadedImage ? (
                    <div className="relative">
                      <img 
                        src={uploadedImage} 
                        alt="Uploaded" 
                        className="w-full h-20 object-cover rounded-lg border border-[#27272a] shadow-lg"
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeImage();
                        }}
                        className="absolute top-1 right-1 w-5 h-5 bg-[#18181b]/90 backdrop-blur-sm rounded-lg flex items-center justify-center hover:bg-red-500/90 transition-all duration-200 border border-[#27272a] shadow-lg"
                      >
                        <X className="w-3 h-3 text-white" />
                      </button>
                      <p className="text-[10px] text-emerald-400 font-semibold mt-2">Image uploaded</p>
                    </div>
                  ) : (
                    <>
                      <div className="w-8 h-8 rounded-lg bg-[#1f1f23] flex items-center justify-center mx-auto mb-2 border border-[#27272a] shadow-lg">
                        <Upload className="w-3.5 h-3.5 text-[#71717a]" />
                      </div>
                      <p className="text-[10px] font-semibold text-[#a1a1aa] mb-1">Drag & drop</p>
                      <p className="text-[9px] text-[#52525b]">PNG, JPG</p>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>



            <div className="bg-gradient-to-r from-blue-600/10 to-purple-600/10 border border-blue-500/20 rounded-lg p-3">
              <h3 className="text-[10px] font-semibold text-white mb-1.5 flex items-center gap-1.5">
                <Zap className="w-3 h-3 text-amber-400" />
                Tips
              </h3>
              <ul className="space-y-0.5 text-[9px] text-[#71717a]">
                <li>• Specific prompts = better results</li>
                <li>• Reference images help guide</li>
                <li>• Auto-stops at zero balance</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
}

export default Dashboard;
