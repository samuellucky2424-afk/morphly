"""Headless bridge for Morphly's bundled MeanVC2 CPU runtime."""

from __future__ import annotations

import argparse
from collections import deque
import json
import queue
import signal
import sys
import threading
import time
from pathlib import Path

import numpy as np
import soxr
import sounddevice as sd
import torch
import torch.jit as torch_jit
from audiotsm import wsola
from audiotsm.io.array import ArrayReader, ArrayWriter


RUNTIME_ROOT = Path.cwd()
SAMPLE_RATE = 16000
MODEL_BLOCK_MS = 80
MODEL_BLOCK_SAMPLES = SAMPLE_RATE * MODEL_BLOCK_MS // 1000
AUDIO_BLOCK_MS = 160
AUDIO_BLOCK_SAMPLES = SAMPLE_RATE * AUDIO_BLOCK_MS // 1000


class PitchProcessor:
    """Low-latency streaming pitch shift using resampling plus WSOLA."""

    def __init__(self, semitones: float = 0.0, sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self._lock = threading.Lock()
        self._semitones = 0.0
        self._resampler = None
        self._tsm = None
        self._output = np.array([], dtype=np.float32)
        self.set_semitones(semitones)

    @property
    def semitones(self) -> float:
        return self._semitones

    def set_semitones(self, semitones: float) -> None:
        value = float(max(-12.0, min(12.0, semitones)))
        with self._lock:
            if abs(value - self._semitones) < 0.01 and self._resampler is not None:
                return
            self._semitones = value
            self._output = np.array([], dtype=np.float32)
            if abs(value) < 0.01:
                self._resampler = None
                self._tsm = None
                return

            ratio = 2.0 ** (value / 12.0)
            self._resampler = soxr.ResampleStream(
                self.sample_rate,
                self.sample_rate / ratio,
                1,
                dtype="float32",
                quality="HQ",
            )
            self._tsm = wsola(
                channels=1,
                speed=1.0 / ratio,
                frame_length=640,
                synthesis_hop=320,
                tolerance=160,
            )

    def process(self, samples: np.ndarray) -> np.ndarray:
        with self._lock:
            if self._resampler is None or self._tsm is None:
                return samples

            resampled = self._resampler.resample_chunk(samples, last=False)
            if len(resampled):
                reader = ArrayReader(resampled.reshape(1, -1))
                writer = ArrayWriter(1)
                self._tsm.run(reader, writer, flush=False)
                produced = writer.data[0]
                if len(produced):
                    self._output = np.concatenate([self._output, produced])

            required = len(samples)
            shifted = np.zeros(required, dtype=np.float32)
            available = min(required, len(self._output))
            if available:
                shifted[:available] = self._output[:available]
                self._output = self._output[available:]
            return shifted


class BufferedVoiceStream:
    """Keep model inference away from PortAudio's deadline-sensitive callback."""

    def __init__(self, pipeline, pitch_processor, input_device: int, output_device: int, on_error):
        self.pipeline = pipeline
        self.pitch_processor = pitch_processor
        self.on_error = on_error
        self.model_chunk_size = int(pipeline.CHUNK)
        self.chunk_size = AUDIO_BLOCK_SAMPLES
        if self.model_chunk_size != MODEL_BLOCK_SAMPLES:
            raise RuntimeError(
                f"MorphlyVC expected an {MODEL_BLOCK_MS} ms model block "
                f"({MODEL_BLOCK_SAMPLES} samples), received {self.model_chunk_size}."
            )
        # Live speech must not accumulate seconds of stale audio after a CPU spike.
        self.input_queue = queue.Queue(maxsize=1)
        self.output_queue = queue.Queue(maxsize=2)
        self.stop_event = threading.Event()
        self.playback_started = False
        self.underruns = 0
        self.input_drops = 0
        self.output_drops = 0
        self.device_warnings = 0
        self.processing_ms = deque(maxlen=60)
        self.last_report_at = time.monotonic()
        self.last_sample = 0.0
        self.recovering = True
        self.fade_samples = min(80, self.chunk_size)
        self.fade_in = np.linspace(0, 1, self.fade_samples, dtype=np.float32)
        self.target_output_blocks = 1
        self.worker = threading.Thread(target=self._process, name="morphlyvc-audio-worker", daemon=True)
        input_info = sd.query_devices(input_device)
        output_info = sd.query_devices(output_device)
        if input_info['hostapi'] != output_info['hostapi']:
            raise ValueError('Choose microphone and output devices using the same audio driver (for example, WASAPI).')
        self.hostapi = sd.query_hostapis(input_info['hostapi'])['name']
        extra = sd.WasapiSettings(auto_convert=True) if self.hostapi == 'Windows WASAPI' else None
        sd.check_input_settings(device=input_device, samplerate=SAMPLE_RATE, channels=1, dtype='float32', extra_settings=extra)
        sd.check_output_settings(device=output_device, samplerate=SAMPLE_RATE, channels=1, dtype='float32', extra_settings=extra)
        self.stream = sd.Stream(
            samplerate=SAMPLE_RATE,
            blocksize=self.chunk_size,
            device=(input_device, output_device),
            channels=1,
            callback=self._callback,
            dtype="float32",
            latency="low",
            extra_settings=(extra, extra),
        )

    def _enqueue_latest_input(self, samples: tuple[float, np.ndarray]) -> None:
        try:
            self.input_queue.put_nowait(samples)
        except queue.Full:
            try:
                self.input_queue.get_nowait()
            except queue.Empty:
                pass
            self.input_queue.put_nowait(samples)
            self.input_drops += 1

    def _enqueue_output(self, samples: tuple[float, np.ndarray]) -> None:
        try:
            self.output_queue.put_nowait(samples)
        except queue.Full:
            try:
                self.output_queue.get_nowait()
            except queue.Empty:
                pass
            self.output_queue.put_nowait(samples)
            self.output_drops += 1

    @torch.inference_mode()
    def _process(self) -> None:
        continuous_output = np.array([], dtype=np.float32)
        chunk_count = 0
        try:
            while not self.stop_event.is_set():
                try:
                    entry = self.input_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                if entry is None:
                    break
                captured_at, samples = entry
                if time.monotonic() - captured_at > AUDIO_BLOCK_MS / 1000 * 2:
                    self.input_drops += 1
                    continue

                if len(samples) != self.chunk_size:
                    raise RuntimeError(
                        f"MorphlyVC received {len(samples)} samples instead of a full "
                        f"{AUDIO_BLOCK_MS} ms device buffer."
                    )

                started = time.perf_counter()
                for offset in range(0, self.chunk_size, self.model_chunk_size):
                    model_input = samples[offset:offset + self.model_chunk_size]
                    converted = self.pipeline.process_chunk(model_input)
                    # Upstream retains every ASR feature for offline file export.
                    # Live sessions never export these tensors; release them so
                    # a long stream cannot steadily consume more RAM.
                    saved_features = getattr(self.pipeline, '_bn_save_list', None)
                    if saved_features is not None:
                        saved_features.clear()
                    if converted is not None and len(converted) > 0:
                        tuned = self.pitch_processor.process(np.asarray(converted, dtype=np.float32))
                        continuous_output = np.concatenate([continuous_output, tuned])

                    chunk_count += 1
                    if chunk_count % 50 == 0:
                        self.pipeline._reset_vc_kv_cache()

                while len(continuous_output) >= self.chunk_size:
                    self._enqueue_output((captured_at, continuous_output[:self.chunk_size].copy()))
                    continuous_output = continuous_output[self.chunk_size:]
                self.processing_ms.append((time.perf_counter() - started) * 1000)
                if time.monotonic() - self.last_report_at >= 2:
                    self.report_performance()
        except Exception as error:
            self.on_error(error)

    def _callback(self, indata, outdata, _frames, _time_info, status) -> None:
        # No logging, model calls or blocking I/O on the audio callback thread.
        outdata.fill(0)
        if self.stop_event.is_set():
            return
        if status:
            self.device_warnings += 1

        self._enqueue_latest_input((time.monotonic(), indata[:, 0].copy()))

        # Start with one block. Add one safety block only when measured processing
        # approaches the audio deadline; never allow an unbounded backlog.
        if not self.playback_started:
            if self.output_queue.qsize() < self.target_output_blocks:
                return
            self.playback_started = True

        try:
            captured_at, block = self.output_queue.get_nowait()
            while time.monotonic() - captured_at > AUDIO_BLOCK_MS / 1000 * 3:
                self.output_drops += 1
                captured_at, block = self.output_queue.get_nowait()
        except queue.Empty:
            self.underruns += 1
            outdata[:self.fade_samples, 0] = self.last_sample * (1 - self.fade_in)
            self.last_sample = 0.0
            self.recovering = True
            self.playback_started = False
            return

        available = min(len(outdata), len(block))
        outdata[:available, 0] = block[:available]
        if self.recovering:
            outdata[:self.fade_samples, 0] *= self.fade_in
            self.recovering = False
        self.last_sample = float(outdata[-1, 0])

    def report_performance(self) -> None:
        p95 = float(np.percentile(self.processing_ms, 95)) if self.processing_ms else 0.0
        self.target_output_blocks = 2 if p95 > AUDIO_BLOCK_MS * .8 else 1
        latency = self.stream.latency
        print('[Performance] ' + json.dumps({
            'blockMs': AUDIO_BLOCK_MS, 'processingMs': round(float(np.mean(self.processing_ms)), 1) if self.processing_ms else 0,
            'p95Ms': round(p95, 1), 'realTimeFactor': round(p95 / AUDIO_BLOCK_MS, 2),
            'inputLatencyMs': round(latency[0] * 1000, 1), 'outputLatencyMs': round(latency[1] * 1000, 1),
            'inputQueueMs': self.input_queue.qsize() * AUDIO_BLOCK_MS,
            'outputQueueMs': self.output_queue.qsize() * AUDIO_BLOCK_MS,
            'underruns': self.underruns, 'inputDrops': self.input_drops, 'outputDrops': self.output_drops,
            'deviceWarnings': self.device_warnings, 'hostapi': self.hostapi,
            'threads': torch.get_num_threads(),
        }), flush=True)
        self.last_report_at = time.monotonic()

    def start(self) -> None:
        self.worker.start()
        try:
            self.stream.start()
        except Exception:
            self.stop()
            raise
        self.report_performance()

    def stop(self) -> None:
        self.stop_event.set()
        try:
            self.input_queue.put_nowait(None)
        except queue.Full:
            pass
        try:
            self.stream.abort()
        finally:
            self.stream.close()
        self.worker.join(timeout=5.0)
        if self.worker.is_alive():
            raise RuntimeError('Audio processing did not stop safely. Restart Morphly before starting another voice session.')


def patch_torch_jit() -> None:
    """Match the compatibility patch used by the official MeanVC2 launcher."""
    original_script = torch_jit.script

    def safe_script(obj, *args, **kwargs):
        try:
            return original_script(obj, *args, **kwargs)
        except OSError:
            return obj

    torch_jit.script = safe_script


def device_summary() -> dict[str, object]:
    devices = sd.query_devices()
    default_input, default_output = sd.default.device
    input_devices: list[dict[str, object]] = []
    output_devices: list[dict[str, object]] = []
    hostapis = sd.query_hostapis()
    # Prefer full-name WASAPI endpoints. Do not collapse different microphones
    # sharing a 20-character prefix or assume host API indices are fixed.
    priority = {'Windows WASAPI': 0, 'Core Audio': 0, 'ALSA': 0, 'Windows DirectSound': 1, 'MME': 2}
    ordered = sorted(enumerate(devices), key=lambda entry: priority.get(hostapis[int(entry[1]['hostapi'])]['name'], 3))
    for index, device in ordered:
        hostapi_index = int(device["hostapi"])
        hostapi_name = hostapis[hostapi_index]["name"]
        if hostapi_name == 'Windows WDM-KS':
            # Raw kernel pins often include disconnected/exclusive endpoints.
            # Shared-mode WASAPI exposes the corresponding usable devices.
            continue
        name = str(device["name"])
        if name in {'Microsoft Sound Mapper - Input', 'Microsoft Sound Mapper - Output', 'Primary Sound Capture Driver', 'Primary Sound Driver'}:
            continue
        if device["max_input_channels"] > 0:
            input_devices.append({"id": index, "name": name, "hostapi": hostapi_name})
        if device["max_output_channels"] > 0:
            output_devices.append({"id": index, "name": name, "hostapi": hostapi_name})

    common = next((item['hostapi'] for item in input_devices if any(out['hostapi'] == item['hostapi'] for out in output_devices)), None)
    if common:
        api = next(api for api in hostapis if api['name'] == common)
        default_input = next((item['id'] for item in input_devices if item['id'] == api['default_input_device']), next(item['id'] for item in input_devices if item['hostapi'] == common))
        default_output = next((item['id'] for item in output_devices if item['id'] == api['default_output_device']), next(item['id'] for item in output_devices if item['hostapi'] == common))
    else:
        default_input = input_devices[0]['id'] if input_devices else -1
        default_output = output_devices[0]['id'] if output_devices else -1

    return {
        "defaultInput": int(default_input),
        "defaultOutput": int(default_output),
        "inputName": devices[default_input]["name"] if default_input >= 0 else '',
        "outputName": devices[default_output]["name"] if default_output >= 0 else '',
        "inputCount": len(input_devices),
        "outputCount": len(output_devices),
        "inputs": input_devices,
        "outputs": output_devices,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Morphly MeanVC2 realtime bridge")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--load-check", action="store_true")
    parser.add_argument("--dsp-check", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--benchmark", action="store_true", help="Measure synthetic inference only; never opens a microphone")
    parser.add_argument("--benchmark-blocks", type=int, default=80)
    parser.add_argument("--target-spk", type=Path)
    parser.add_argument("--input-device", type=int)
    parser.add_argument("--output-device", type=int)
    parser.add_argument("--steps", type=int, default=2, choices=range(1, 5))
    parser.add_argument("--pitch", type=float, default=0.0)
    return parser.parse_args()


def load_pipeline(args: argparse.Namespace, target_wav: Path | None):
    """Load the heavy model stack, optionally deferring the target voice."""
    from src import vc_pipeline_jit as vc_module

    def report_progress(message: str, percent: int) -> None:
        print(f"[Load] {percent}% {message}", flush=True)

    if target_wav is not None:
        pipeline = vc_module.VCPipelineJIT(
            target_wav=str(target_wav.resolve()),
            device="cpu",
            progress_callback=report_progress,
            num_steps=args.steps,
        )
    else:
        # The upstream constructor expects an embedding immediately. A neutral
        # in-memory vector lets Morphly warm every heavy network before a user
        # supplies a voice. update_speaker() replaces it before audio starts.
        original_extract = vc_module._run_rt_jit.extract_embedding

        def neutral_embedding(_model, _target_wav, device="cpu"):
            return torch.zeros((1, 256), dtype=torch.float32, device=device)

        vc_module._run_rt_jit.extract_embedding = neutral_embedding
        try:
            pipeline = vc_module.VCPipelineJIT(
                target_wav="MorphlyVC idle profile",
                device="cpu",
                progress_callback=report_progress,
                num_steps=args.steps,
            )
        finally:
            vc_module._run_rt_jit.extract_embedding = original_extract

    with torch.inference_mode():
        pipeline.reset()
        pipeline.warmup()
        # Warm the steady-state VC trace as well as the first three ASR chunks.
        for _ in range(8):
            pipeline.process_chunk(np.zeros(pipeline.CHUNK, dtype=np.float32))
    pipeline.reset()
    return pipeline


def run_warm_engine(args: argparse.Namespace, devices: dict[str, object], stop_event: threading.Event) -> int:
    """Keep models resident while opening audio devices only for live sessions."""
    print(f"[Devices] Ready {json.dumps(devices, ensure_ascii=True)}", flush=True)
    pipeline = load_pipeline(args, None)
    commands: queue.Queue[dict[str, object]] = queue.Queue()
    pitch_processor = PitchProcessor(args.pitch)
    audio_stream = None
    prepared_target: str | None = None

    def receive_commands() -> None:
        try:
            for line in sys.stdin:
                try:
                    commands.put(json.loads(line))
                except Exception as error:
                    print(f"[Control] {error}", file=sys.stderr, flush=True)
        finally:
            stop_event.set()

    threading.Thread(target=receive_commands, name="morphlyvc-controls", daemon=True).start()

    def stop_audio() -> None:
        nonlocal audio_stream
        if audio_stream is None:
            return
        audio_stream.stop()
        audio_stream = None
        pipeline.reset()

    def prepare_voice(command: dict[str, object]) -> str:
        nonlocal prepared_target
        target = Path(str(command.get("target_spk", "")))
        if not target.is_file():
            raise FileNotFoundError("A valid WAV target voice is required.")
        resolved_target = str(target.resolve())
        reference_id = str(command.get("reference_id", "unknown"))
        if prepared_target != resolved_target:
            print(f"[Voice] Loading reference={reference_id}", flush=True)
            pipeline.update_speaker(resolved_target)
            pipeline.reset()
            prepared_target = resolved_target
        print(f"[Voice] Ready reference={reference_id}", flush=True)
        return resolved_target

    def start_audio(command: dict[str, object]) -> None:
        nonlocal audio_stream, pitch_processor
        stop_audio()
        prepare_voice(command)
        pitch_processor = PitchProcessor(float(command.get("pitch", 0.0)))
        input_device = int(command.get("input_device", devices["defaultInput"]))
        output_device = int(command.get("output_device", devices["defaultOutput"]))
        audio_stream = BufferedVoiceStream(
            pipeline,
            pitch_processor,
            input_device,
            output_device,
            lambda error: commands.put({"type": "audio-error", "message": str(error)}),
        )
        audio_stream.start()
        print(
            f"[Stream] Running input={input_device} output={output_device} "
            f"chunk={pipeline.CHUNK} pitch={pitch_processor.semitones:+.1f}",
            flush=True,
        )

    print("[Engine] Ready microphone=closed", flush=True)
    while not stop_event.is_set():
        try:
            command = commands.get(timeout=0.25)
        except queue.Empty:
            continue

        command_type = command.get("type")
        try:
            if command_type == "prepare":
                if audio_stream is not None:
                    raise RuntimeError("Stop live conversion before changing the voice profile.")
                prepare_voice(command)
            elif command_type == "start":
                start_audio(command)
            elif command_type == "pitch":
                pitch_processor.set_semitones(float(command["semitones"]))
                print(f"[Pitch] {pitch_processor.semitones:+.1f} semitones", flush=True)
            elif command_type == "stop":
                stop_audio()
                print("[Stream] Stopped", flush=True)
                print("[Engine] Ready microphone=closed", flush=True)
            elif command_type == "audio-error":
                stop_audio()
                print(f"[Stream] Error {command.get('message', 'Audio processing failed.')}", file=sys.stderr, flush=True)
                print("[Engine] Ready microphone=closed", flush=True)
            elif command_type == "shutdown":
                stop_event.set()
            else:
                raise ValueError(f"Unknown command: {command_type}")
        except Exception as error:
            print(f"[Control] {error}", file=sys.stderr, flush=True)

    stop_audio()
    print("[Engine] Stopped", flush=True)
    return 0


def main() -> int:
    args = parse_args()
    patch_torch_jit()
    if args.benchmark:
        pipeline = load_pipeline(args, None)
        samples = np.random.default_rng(7).normal(0, .03, pipeline.CHUNK).astype(np.float32)
        timings = []
        with torch.inference_mode():
            for index in range(max(20, min(1000, args.benchmark_blocks))):
                started = time.perf_counter()
                pipeline.process_chunk(samples)
                if index % 50 == 49:
                    pipeline._reset_vc_kv_cache()
                if index >= 10:
                    timings.append((time.perf_counter() - started) * 1000)
        print('[Benchmark] ' + json.dumps({'microphoneOpen': False, 'modelBlockMs': MODEL_BLOCK_MS, 'audioBlockMs': AUDIO_BLOCK_MS, 'threads': torch.get_num_threads(), 'meanMs': round(float(np.mean(timings)), 2), 'p95Ms': round(float(np.percentile(timings, 95)), 2), 'maxMs': round(max(timings), 2)}), flush=True)
        return 0
    devices = device_summary()
    if args.check:
        print(f"[Check] Ready {json.dumps(devices, ensure_ascii=True)}", flush=True)
        return 0

    if args.dsp_check:
        processor = PitchProcessor(4.0)
        signal_chunk = np.random.default_rng(42).standard_normal(1280).astype(np.float32)
        started = time.perf_counter()
        output_samples = 0
        for _ in range(30):
            output_samples += np.count_nonzero(processor.process(signal_chunk))
        elapsed_ms = (time.perf_counter() - started) * 1000 / 30
        print(f"[DSP] Ready average_ms={elapsed_ms:.2f} output_samples={output_samples}", flush=True)
        return 0

    stop_event = threading.Event()

    def request_stop(_signum=None, _frame=None) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    if args.serve:
        return run_warm_engine(args, devices, stop_event)

    if args.target_spk is None or not args.target_spk.is_file():
        raise FileNotFoundError("A valid WAV target voice is required.")

    pipeline = load_pipeline(args, args.target_spk)

    if args.load_check:
        print("[Model] Ready", flush=True)
        return 0

    input_device = args.input_device if args.input_device is not None else devices["defaultInput"]
    output_device = args.output_device if args.output_device is not None else devices["defaultOutput"]
    pitch_processor = PitchProcessor(args.pitch)
    callback_failure: list[Exception] = []

    def receive_commands() -> None:
        for line in sys.stdin:
            try:
                command = json.loads(line)
                if command.get("type") == "pitch":
                    pitch_processor.set_semitones(float(command["semitones"]))
                    print(f"[Pitch] {pitch_processor.semitones:+.1f} semitones", flush=True)
            except Exception as error:
                print(f"[Control] {error}", file=sys.stderr, flush=True)

    threading.Thread(target=receive_commands, name="meanvc-controls", daemon=True).start()

    def failed(error):
        callback_failure.append(error)
        stop_event.set()

    audio_stream = BufferedVoiceStream(pipeline, pitch_processor, input_device, output_device, failed)
    try:
        audio_stream.start()
        print(
            f"[Stream] Running input={input_device} output={output_device} chunk={pipeline.CHUNK} pitch={pitch_processor.semitones:+.1f}",
            flush=True,
        )
        while not stop_event.wait(0.25):
            pass
    finally:
        audio_stream.stop()

    if callback_failure:
        raise callback_failure[0]

    print("[Stream] Stopped", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"[Fatal] {error}", file=sys.stderr, flush=True)
        raise
