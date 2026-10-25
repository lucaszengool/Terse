"""Barge-in (打断) the way beiyege-01/dsh-voice-ai-girlfriend does it (bridge/voice_bridge.py VADSession + /api/vad; user 10-21:
"和 github 一样用这个打断模型"): while she speaks, the page streams its microphone (16 kHz mono PCM16, any chunk size) to
/vad; Silero VAD v4 — a neural voice detector, so noise / music / her own voice from the speakers don't trip it the way a
loudness threshold does — runs on continuous 512-sample windows; "speech_start" once sustained speech reaches 384 ms, and the
page stops her. The repo's settings, verbatim: threshold 0.6, min_silence 64 ms, speech_pad 30 ms, min_speech 384 ms, the
iterator = huggingface/speech-to-speech VADIterator (its model reset after 500 ms idle included).
Model: the official silero-vad v4.0 release (MIT), its ONNX export — the same network as the repo's files/silero_vad.jit,
run with ONNX Runtime (no PyTorch in the engine); models/silero-vad/silero_vad_v4.{onnx,jit}."""
import os, threading
import numpy as np

_SESS = {}
_LOCK = threading.Lock()


def model_path(models_dir):
    p = os.path.join(models_dir, "silero-vad", "silero_vad_v4.onnx")
    return p if os.path.exists(p) else None


def _session(path):
    with _LOCK:
        if path not in _SESS:
            import onnxruntime as ort
            so = ort.SessionOptions(); so.intra_op_num_threads = 1; so.inter_op_num_threads = 1
            _SESS[path] = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        return _SESS[path]


class BargeIn:
    """one per microphone stream (the model's h / c state is per stream)"""

    def __init__(self, path, threshold=0.6, sampling_rate=16000, min_silence_duration_ms=64, speech_pad_ms=30, min_speech_ms=384):
        self.sess = _session(path)
        self.threshold, self.sr = threshold, sampling_rate
        self.min_silence_samples = int(sampling_rate * min_silence_duration_ms / 1000)
        self.speech_pad_samples = int(sampling_rate * speech_pad_ms / 1000)
        self._model_reset_idle_samples = int(sampling_rate * 500 / 1000)
        self.min_speech_ms = min_speech_ms
        self._buf = b""
        self.reset_states()

    def _reset_model(self):
        self.h = np.zeros((2, 1, 64), np.float32); self.c = np.zeros((2, 1, 64), np.float32)

    def reset_states(self):
        self._reset_model()
        self._model_idle_samples = 0; self.triggered = False; self.temp_end = 0; self.current_sample = 0
        self.active_speech_samples = 0; self.speech_started = False

    def _prob(self, x):
        out, self.h, self.c = self.sess.run(None, {"input": x[None], "sr": np.array(self.sr, np.int64), "h": self.h, "c": self.c})
        return float(out[0, 0])

    def _step(self, x):
        """VADIterator.__call__ on one 512-sample window → True at the end of an utterance"""
        n = len(x); self.current_sample += n
        p = self._prob(x)
        if p >= self.threshold and not self.triggered:
            self._model_idle_samples = 0; self.triggered = True; self.active_speech_samples = n
            return False
        if not self.triggered:
            if p < self.threshold - 0.15:
                self._model_idle_samples += n
                if self._model_idle_samples >= self._model_reset_idle_samples:
                    self._reset_model(); self._model_idle_samples = 0
            else:
                self._model_idle_samples = 0
            return False
        if p >= self.threshold - 0.15:
            self.active_speech_samples += n
            if self.temp_end:
                self.temp_end = 0
                return False
        if p < self.threshold - 0.15:
            if not self.temp_end: self.temp_end = self.current_sample
            if self.current_sample - self.temp_end < self.min_silence_samples: return False
            self.temp_end = 0; self.triggered = False; self.active_speech_samples = 0
            self._reset_model(); self._model_idle_samples = 0
            return True
        return False

    def feed(self, pcm16):
        """one 16 kHz PCM16 chunk (any size) → events: "speech_start" (sustained voice ≥ 384 ms), "speech_end\""""
        self._buf += pcm16
        out = []
        while len(self._buf) >= 1024:                       # 512 int16 samples: continuous windows, never zero-padded
            x = np.frombuffer(self._buf[:1024], np.int16).astype(np.float32) / 32768.0
            self._buf = self._buf[1024:]
            end = self._step(x)
            if self.triggered and not self.speech_started and self.active_speech_samples / 16.0 >= self.min_speech_ms:
                self.speech_started = True; out.append("speech_start")
            if end:
                self.speech_started = False; out.append("speech_end")
        return out
