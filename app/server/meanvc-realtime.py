"""Headless bridge for Morphly's bundled MeanVC2 CPU runtime."""

from __future__ import annotations

import argparse
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
        self.input_queue: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=4)
        self.output_queue: queue.Queue[np.ndarray] = queue.Queue(maxsize=6)
        self.stop_event = threading.Event()
        self.playback_started = False
        self.last_underrun_log_at = 0.0
        self.worker = threading.Thread(target=self._process, name="morphlyvc-audio-worker", daemon=True)
        self.stream = sd.Stream(
            samplerate=SAMPLE_RATE,
            blocksize=self.chunk_size,
            device=(input_device, output_device),
            channels=1,
            callback=self._callback,
            dtype="float32",
            latency="high",
        )

    def _enqueue_latest_input(self, samples: np.ndarray) -> None:
        try:
            self.input_queue.put_nowait(samples)
        except queue.Full:
            try:
                self.input_queue.get_nowait()
            except queue.Empty:
                pass
            self.input_queue.put_nowait(samples)
            print("[Audio] Input queue recovered from an overrun.", file=sys.stderr, flush=True)

    def _enqueue_output(self, samples: np.ndarray) -> None:
        try:
            self.output_queue.put_nowait(samples)
        except queue.Full:
            try:
                self.output_queue.get_nowait()
            except queue.Empty:
                pass
            self.output_queue.put_nowait(samples)

    def _process(self) -> None:
        continuous_output = np.array([], dtype=np.float32)
        chunk_count = 0
        try:
            while not self.stop_event.is_set():
                try:
                    samples = self.input_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                if samples is None:
                    break

                if len(samples) != self.chunk_size:
                    raise RuntimeError(
                        f"MorphlyVC received {len(samples)} samples instead of a full "
                        f"{AUDIO_BLOCK_MS} ms device buffer."
                    )

                for offset in range(0, self.chunk_size, self.model_chunk_size):
                    model_input = samples[offset:offset + self.model_chunk_size]
                    converted = self.pipeline.process_chunk(model_input)
                    if converted is not None and len(converted) > 0:
                        tuned = self.pitch_processor.process(np.asarray(converted, dtype=np.float32))
                        continuous_output = np.concatenate([continuous_output, tuned])

                    chunk_count += 1
                    if chunk_count % 50 == 0:
                        self.pipeline._reset_vc_kv_cache()

                while len(continuous_output) >= self.chunk_size:
                    self._enqueue_output(continuous_output[:self.chunk_size].copy())
                    continuous_output = continuous_output[self.chunk_size:]
        except Exception as error:
            self.on_error(error)

    def _callback(self, indata, outdata, _frames, _time_info, status) -> None:
        if status:
            print(f"[Audio] {status}", file=sys.stderr, flush=True)

        self._enqueue_latest_input(indata[:, 0].copy().astype(np.float32))
        outdata.fill(0)

        # Two ready blocks add one safety block for occasional CPU spikes. This
        # prevents the zero-filled gaps that sound like coughing or a sore throat.
        if not self.playback_started:
            if self.output_queue.qsize() < 2:
                return
            self.playback_started = True

        try:
            block = self.output_queue.get_nowait()
        except queue.Empty:
            now = time.monotonic()
            if now - self.last_underrun_log_at >= 2.0:
                print("[Audio] Output buffer underrun; holding silence briefly.", file=sys.stderr, flush=True)
                self.last_underrun_log_at = now
            return

        available = min(len(outdata), len(block))
        outdata[:available, 0] = block[:available]

    def start(self) -> None:
        self.worker.start()
        self.stream.start()

    def stop(self) -> None:
        self.stop_event.set()
        try:
            self.input_queue.put_nowait(None)
        except queue.Full:
            pass
        try:
            self.stream.stop()
        finally:
            self.stream.close()
        self.worker.join(timeout=2.0)


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
    seen_inputs: set[str] = set()
    seen_outputs: set[str] = set()

    for index, device in enumerate(devices):
        hostapi_index = int(device["hostapi"])
        if hostapi_index not in {0, 1}:
            continue
        hostapi_name = sd.query_hostapis(hostapi_index)["name"]
        name = str(device["name"])
        identity = name[:20].rstrip().lower()
        if device["max_input_channels"] > 0 and identity not in seen_inputs:
            seen_inputs.add(identity)
            input_devices.append({"id": index, "name": name, "hostapi": hostapi_name})
        if device["max_output_channels"] > 0 and identity not in seen_outputs:
            seen_outputs.add(identity)
            output_devices.append({"id": index, "name": name, "hostapi": hostapi_name})

    return {
        "defaultInput": int(default_input),
        "defaultOutput": int(default_output),
        "inputName": devices[default_input]["name"],
        "outputName": devices[default_output]["name"],
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

    pipeline.reset()
    pipeline.warmup()
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
        try:
            audio_stream.stop()
        finally:
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
        nonlocal audio_stream
        stop_audio()
        prepare_voice(command)
        pitch_processor.set_semitones(float(command.get("pitch", 0.0)))
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
    output_buffer = np.array([], dtype=np.float32)
    pitch_processor = PitchProcessor(args.pitch)
    callback_failure: list[Exception] = []
    chunk_count = 0

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

    def process_audio(indata, outdata, _frames, _time_info, status) -> None:
        nonlocal output_buffer, chunk_count
        if status:
            print(f"[Audio] {status}", file=sys.stderr, flush=True)
        try:
            converted = pipeline.process_chunk(indata[:, 0].copy().astype(np.float32))
            if converted is not None and len(converted) > 0:
                tuned = pitch_processor.process(np.asarray(converted, dtype=np.float32))
                output_buffer = np.concatenate([output_buffer, tuned])

            required = len(outdata)
            available = min(required, len(output_buffer))
            if available:
                outdata[:available, 0] = output_buffer[:available]
                output_buffer = output_buffer[available:]
            if available < required:
                outdata[available:, 0] = 0.0

            chunk_count += 1
            if chunk_count % 50 == 0:
                pipeline._reset_vc_kv_cache()
        except Exception as error:
            outdata.fill(0)
            callback_failure.append(error)
            stop_event.set()

    with sd.Stream(
        samplerate=SAMPLE_RATE,
        blocksize=pipeline.CHUNK,
        device=(input_device, output_device),
        channels=1,
        callback=process_audio,
        dtype="float32",
    ):
        print(
            f"[Stream] Running input={input_device} output={output_device} chunk={pipeline.CHUNK} pitch={pitch_processor.semitones:+.1f}",
            flush=True,
        )
        while not stop_event.wait(0.25):
            pass

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
