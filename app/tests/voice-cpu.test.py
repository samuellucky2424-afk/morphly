"""CPU setup regressions; no models or audio devices are opened."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import numpy as np

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'server' / 'meanvc-realtime.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class CpuTests(unittest.TestCase):
    def pipeline(self):
        return SimpleNamespace(CHUNK=1280, cpu_precision='int8', _bn_save_list=[],
                               reset=MagicMock(), process_chunk=MagicMock(return_value=np.zeros(1280)))

    def calibrate(self, pipeline, fixed=False):
        clock = [0.0]
        def tick():
            # Two steps miss the CPU-headroom target; one step meets it.
            clock[0] += .070 if pipeline._num_steps == 2 else .040
            return clock[0]
        with patch.object(bridge.time, 'perf_counter', side_effect=tick), patch.object(bridge.torch, 'set_num_threads'):
            bridge.prepare_cpu_stream(pipeline, 2, fixed)

    def test_slow_cpu_selects_one_step_and_resets_streaming_state(self):
        pipeline = self.pipeline()
        self.calibrate(pipeline)
        self.assertEqual(pipeline._num_steps, 1)
        self.assertEqual(pipeline.reset.call_count, 3)
        self.assertEqual(pipeline._bn_save_list, [])

    def test_fixed_quality_setting_preserves_requested_steps(self):
        pipeline = self.pipeline()
        self.calibrate(pipeline, fixed=True)
        self.assertEqual(pipeline._num_steps, 2)

    def test_invalid_model_output_fails_before_devices_can_open(self):
        pipeline = self.pipeline()
        pipeline.process_chunk.return_value = np.array([np.nan])
        with self.assertRaisesRegex(RuntimeError, 'invalid audio'):
            self.calibrate(pipeline)

    def test_unsupported_quantization_keeps_all_original_models(self):
        names = ('vc_jit_cold', 'vc_jit_t4', 'vc_jit_t8', 'vc_jit_steady')
        originals = {name: MagicMock() for name in names}
        pipeline = SimpleNamespace(**originals)
        with patch('torch.ao.quantization.quantize_dynamic_jit', side_effect=[MagicMock(), RuntimeError('unsupported')]):
            bridge.optimize_cpu_models(pipeline, 'int8')
        self.assertEqual(pipeline.cpu_precision, 'float32')
        for name, original in originals.items():
            self.assertIs(getattr(pipeline, name), original)


if __name__ == '__main__':
    unittest.main()
