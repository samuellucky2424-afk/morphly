export function selectableVoiceOutputs(devices, inputId) {
  const input = devices?.inputs.find(device => device.id === inputId);
  // Keep speakers visible even when no microphone exists or is selected yet.
  // Once selected, a duplex PortAudio stream requires matching host APIs.
  return devices?.outputs.filter(device => (!input || device.hostapi === input.hostapi)
    && !/\bCABLE In\s+\d+ch\b/i.test(device.name)) || [];
}
