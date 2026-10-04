"""Optional real-model smoke test. Run with the bundled Python from its runtime directory.

All sounddevice entry points are mocked; synthetic audio never reaches a device.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path.cwd()))
spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'server' / 'meanvc-realtime.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.patch_torch_jit()
parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=12)
parser.add_argument('--check-speaker', action='store_true')
args = parser.parse_args()
blocks = max(75, round(args.seconds * 1000 / bridge.AUDIO_BLOCK_MS))

with patch.object(bridge.sd, 'Stream') as stream_factory, \
     patch.object(bridge.sd, 'query_devices', return_value={'hostapi': 2}), \
     patch.object(bridge.sd, 'query_hostapis', return_value={'name': 'Windows WASAPI'}), \
     patch.object(bridge.sd, 'check_input_settings'), \
     patch.object(bridge.sd, 'check_output_settings'):
    pipeline = bridge.load_pipeline(argparse.Namespace(steps=2), None)
    assert pipeline.spk_model is None, 'Unused speaker model still occupies live memory'
    if args.check_speaker:
        import soundfile as sf
        with tempfile.TemporaryDirectory(prefix='morphly-cpu-test-') as directory:
            reference = Path(directory) / 'synthetic-reference.wav'
            phase = np.arange(16000 * 3)
            sf.write(reference, .05 * np.sin(2 * np.pi * 180 * phase / 16000), 16000)
            pipeline.update_speaker(str(reference))
        assert tuple(pipeline.vc_spk_emb.shape) == (1, 256)
        assert bridge.torch.isfinite(pipeline.vc_spk_emb).all()
        assert pipeline.spk_model is None, 'Speaker model retained after reference extraction'
    stream_factory.assert_not_called()  # Warm models without a voice profile or microphone.
    stream_factory.return_value.latency = (0.01, 0.01)
    failures = []
    pitch = bridge.PitchProcessor()
    voice = bridge.BufferedVoiceStream(pipeline, pitch, 1, 2, failures.append)
    voice.start()
    outputs = []
    started = time.monotonic()
    try:
        for index in range(blocks):
            if index == blocks // 3: pitch.set_semitones(4)
            if index == blocks * 2 // 3: pitch.set_semitones(-4)
            phase = np.arange(2560) + index * 2560
            samples = (0.025 * np.sin(2 * np.pi * 180 * phase / 16000)).astype(np.float32).reshape(-1, 1)
            output = np.zeros_like(samples)
            voice._callback(samples, output, 2560, None, False)
            assert np.isfinite(output).all(), 'Audio contains non-finite samples'
            outputs.append(output.copy())
            delay = started + (index + 1) * .16 - time.monotonic()
            if delay > 0: time.sleep(delay)
    finally:
        voice.stop()
    assert not failures, failures
    assert len(voice.processing_ms) >= 30, 'Worker did not sustain processing'
    assert any(np.any(block) for block in outputs), 'No converted synthetic output'
    assert not voice.worker.is_alive(), 'Worker did not stop'
    assert float(np.percentile(voice.processing_ms, 95)) < bridge.AUDIO_BLOCK_MS, 'CPU missed the live audio deadline'
    assert voice.input_drops == 0, 'CPU could not keep up with live input'
    assert voice.underruns <= 1, 'Repeated playback gaps'
    print('SMOKE PASS ' + json.dumps({
        'microphoneOpened': False, 'seconds': blocks * .16, 'modelSteps': pipeline._num_steps,
        'speakerReloadChecked': args.check_speaker,
        'cpuPrecision': pipeline.cpu_precision,
        'deviceBlockMs': 160, 'pitches': [0, 4, -4],
        'meanProcessingMs': round(float(np.mean(voice.processing_ms)), 1),
        'p95ProcessingMs': round(float(np.percentile(voice.processing_ms, 95)), 1),
        'inputDrops': voice.input_drops, 'outputDrops': voice.output_drops,
        'underruns': voice.underruns,
    }))
