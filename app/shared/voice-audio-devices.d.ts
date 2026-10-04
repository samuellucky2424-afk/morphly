type AudioEndpoint = { id: number; name: string; hostapi: string };
export function selectableVoiceOutputs(devices: { inputs: AudioEndpoint[]; outputs: AudioEndpoint[] } | null | undefined, inputId: number | null): AudioEndpoint[];
