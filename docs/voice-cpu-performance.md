# Local CPU voice performance

Measured September 28, 2026 on the affected Intel i5-1135G7 laptop, 4 physical cores / 8 logical processors, 16 GB RAM. Microphones and output devices were mocked throughout testing. VoiceAI remained open and at one observation consumed about three CPU cores. These measurements reflect that competing workload, not an isolated hardware specification.

## Findings

The unmodified two-step FP32 bridge took 123.23 ms mean / 180.77 ms p95 for each 80 ms audio chunk. It cannot sustain live audio at that rate. A separate worker-thread sweep confirmed that adding threads did not fix this: two-step means were 119.24, 118.82 and 113.47 ms at 1, 2 and 4 threads. One-step FP32 reached 72.01 ms mean / 78.84 ms p95 at one thread, leaving little headroom.

Quantizing the VC linear layers produced 71.31 ms mean / 78.57 ms p95 with two steps, and 52.25 ms mean / 57.44 ms p95 with one step. Only VC traces are quantized; the ASR trace does not support this conversion. Dynamic INT8 and fewer flow-matching steps can change voice fidelity. Synthetic tests establish throughput and finite output, not perceptual equivalence.

## Changes

- Quantize all four VC traces together during startup. Unsupported conversion keeps all original float models. The bundled model files remain untouched.
- Keep one inference thread. Before capture, measure synthetic inference on the audio worker and reduce the requested step count until p95 is below 75% of the model-block duration, or one step is reached. A CPU that still misses the deadline reports that condition; calibration cannot guarantee sufficient hardware capacity.
- Defer the large WavLM speaker model until a reference is selected, then keep only its 256-element embedding during live conversion. Model loading and garbage collection stay outside audio processing.
- Finish worker warmup before opening capture, and fail without opening the microphone if warmup fails.
- Report actual precision and step count alongside processing, queue and device-latency metrics. Keep the existing bounded queues and 160 ms device blocks for scheduling tolerance.

The installed application's resident Python process continues using its loaded code until Morphly fully exits and restarts. Do not start a second voice changer alongside Morphly when checking normal performance. Prefer matching WASAPI microphone/output devices.

## Validation and local installation

The final 60-second synthetic playback test passed with reference loading/release and pitch changes: 114.5 ms mean / 119.5 ms p95 per 160 ms device block in the final rolling window, zero input/output drops and one startup underrun. The release includes 13 Python regression tests for buffering and CPU setup; the broader development checkout also passed its translation-related regressions.

The installed bridge could not be patched from this non-administrator session: Windows denied creation of the backup under `Program Files`, before any installed file was modified. To apply the tested source to this machine, run `app/scripts/install-local-voice-cpu-fix.ps1` from an administrator PowerShell. It backs up the existing bridge, verifies both copies by hash, and rolls back if replacement fails. Fully quit and reopen Morphly afterward. The normal release build also includes the updated source bridge. The administrator installation script was syntax-checked; its privileged replacement has not been executed.

## Reproduction

Run from the downloaded `runtime-40ms` directory with its bundled Python, using the absolute source path in place of `<repo>`:

```powershell
./python.exe '<repo>/app/server/meanvc-realtime.py' --benchmark
./python.exe '<repo>/app/server/meanvc-realtime.py' --benchmark --cpu-precision float32 --fixed-steps --steps 2
./python.exe '<repo>/app/tests/voice-buffer.test.py'
./python.exe '<repo>/app/tests/voice-cpu.test.py'
./python.exe '<repo>/app/tests/voice-runtime-smoke.py' --seconds 60 --check-speaker
```

The smoke test generates a temporary synthetic reference, verifies speaker extraction and release, exercises pitches 0 / +4 / -4, and asserts finite audio, CPU deadline compliance, no input drops and at most one initial playback underrun. It never opens a real audio device. Live microphone-to-headphone delay and perceived voice quality still require a listening test.
