"""Audio regression tests; every device is mocked, microphone never opens."""
import importlib.util
from pathlib import Path
import queue
import threading
import time
import unittest
from unittest.mock import patch, MagicMock
import numpy as np

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'server' / 'meanvc-realtime.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Pipeline:
    CHUNK = 1280
    def __init__(self):
        self.calls=[]
        self._bn_save_list=[]
    def process_chunk(self, samples):
        assert bridge.torch.is_inference_mode_enabled()
        self.calls.append(threading.current_thread().name)
        self._bn_save_list.append(samples.copy())
        return samples.copy()
    def _reset_vc_kv_cache(self): pass

class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.device = patch.object(bridge.sd, 'query_devices', return_value={'hostapi': 2}).start()
        patch.object(bridge.sd, 'query_hostapis', return_value={'name':'Windows WASAPI'}).start()
        self.input_check=patch.object(bridge.sd, 'check_input_settings').start()
        self.output_check=patch.object(bridge.sd, 'check_output_settings').start()
        self.stream_factory=patch.object(bridge.sd, 'Stream').start()
        self.stream_factory.return_value.latency=(.01,.02)
        self.pipeline=Pipeline()
        self.failures=[]
        self.voice=bridge.BufferedVoiceStream(self.pipeline, bridge.PitchProcessor(), 1, 2, self.failures.append)
    def tearDown(self): patch.stopall()
    def block(self, value=1): return np.full((2560,1), value, np.float32)
    def test_constructor_does_not_start_microphone(self):
        self.stream_factory.return_value.start.assert_not_called()
        self.assertEqual(self.stream_factory.call_args.kwargs['latency'],'low')
        self.assertEqual(self.stream_factory.call_args.kwargs['blocksize'],2560)
    def test_queues_keep_latest_audio_and_are_bounded(self):
        for i in range(100):
            self.voice._enqueue_latest_input((time.monotonic(),i))
            self.voice._enqueue_output((time.monotonic(),i))
        self.assertEqual(self.voice.input_queue.qsize(),1)
        self.assertEqual(self.voice.input_queue.get_nowait()[1],99)
        self.assertEqual(self.voice.output_queue.qsize(),2)
        self.assertEqual(self.voice.input_drops,99)
        self.assertEqual(self.voice.output_drops,98)
    def test_callback_starts_with_one_block_and_never_calls_model(self):
        self.voice._enqueue_output((time.monotonic(),self.block()[:,0]))
        out=self.block(0)
        self.voice._callback(self.block(),out,2560,None,False)
        self.assertEqual(out[-1,0],1)
        self.assertEqual(self.pipeline.calls,[])
        self.assertTrue(self.voice.playback_started)
    def test_stale_audio_is_dropped_and_underrun_fades_to_silence(self):
        self.voice.last_sample=.7
        self.voice._enqueue_output((time.monotonic()-2,self.block()[:,0]))
        out=self.block()
        self.voice._callback(self.block(),out,2560,None,False)
        self.assertEqual(self.voice.output_drops,1)
        self.assertEqual(self.voice.underruns,1)
        self.assertAlmostEqual(float(out[0,0]),.7,places=5)
        self.assertTrue(np.all(out[80:]==0))
    def test_worker_splits_160ms_in_two_and_stops_cleanly(self):
        self.voice.start()
        self.voice._enqueue_latest_input((time.monotonic(),self.block()[:,0]))
        _,samples=self.voice.output_queue.get(timeout=3)
        self.assertEqual(len(samples),2560)
        self.voice.stop()
        self.assertEqual(self.pipeline.calls,['morphlyvc-audio-worker']*2)
        self.assertEqual(self.failures,[])
        self.assertFalse(self.voice.worker.is_alive())
        self.assertEqual(self.pipeline._bn_save_list,[])
        self.stream_factory.return_value.abort.assert_called_once()
        self.stream_factory.return_value.close.assert_called_once()
    def test_driver_mismatch_fails_before_opening_stream(self):
        self.device.side_effect=[{'hostapi':1},{'hostapi':2}]
        with self.assertRaisesRegex(ValueError,'same audio driver'):
            bridge.BufferedVoiceStream(self.pipeline,bridge.PitchProcessor(),1,2,self.failures.append)
        self.assertEqual(self.stream_factory.call_count,1)
    def test_device_enumeration_prefers_wasapi_without_truncating_names(self):
        endpoints=[{'name':'Microphone ABC same prefix One','hostapi':0,'max_input_channels':1,'max_output_channels':0},
                   {'name':'Output','hostapi':0,'max_input_channels':0,'max_output_channels':2},
                   {'name':'Microphone ABC same prefix One','hostapi':1,'max_input_channels':1,'max_output_channels':0},
                   {'name':'Microphone ABC same prefix Two','hostapi':1,'max_input_channels':1,'max_output_channels':0},
                   {'name':'Output','hostapi':1,'max_input_channels':0,'max_output_channels':2}]
        self.device.return_value=endpoints
        with patch.object(bridge.sd,'query_hostapis',return_value=[{'name':'MME','default_input_device':0,'default_output_device':1},{'name':'Windows WASAPI','default_input_device':2,'default_output_device':4}]):
            result=bridge.device_summary()
        self.assertEqual(result['defaultInput'],2)
        self.assertEqual(result['defaultOutput'],4)
        self.assertEqual(len(result['inputs']),3)
        self.assertEqual(result['inputs'][0]['hostapi'],'Windows WASAPI')

if __name__=='__main__': unittest.main()
