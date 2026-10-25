"""Speech to text the way beiyege-01/dsh-voice-ai-girlfriend does it (user 10-21: "复刻一模一样的步骤"), i.e. its bridge
/api/stt with the FunASR backend: the page cuts your speech into utterances itself (its mic-capture worklet: 16 kHz PCM16 in
40 ms chunks, −35 dB noise gate; an utterance ends after 1.8 s of silence) and POSTs each WHOLE utterance; Paraformer-large
transcribes it in one pass, no streaming partials. Model = the repo's iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-
vocab8404 as k2-fsa's sherpa-onnx export (sherpa-onnx-paraformer-zh-2023-09-14, int8) — the same network, run with the ONNX
Runtime the engine already has (no PyTorch). Like the repo: no punctuation model; an empty result is logged and returned empty.
One addition: this export invents text for audio with no speech in it (zeros → "嗯没有没有", −30 dB noise → "好的好的好的", measured
10-21), and the repo's gate turns quiet rooms into exactly that, so an utterance Silero VAD v4 (the barge-in model) hears under
0.1 s of voice in is returned empty without decoding (noise peaks at p 0.25, a 0.3 s word reads 0.26 s; ~9 ms per audio second).
Silence around real speech is harmless (tested: 1 s lead + 1.8 s tail → the same text).
Model files: GF_HOME/models/asr/paraformer/<name>/{model.int8.onnx, tokens.txt}."""
import glob, os, threading
import numpy as np

SR = 16000


def model_path(models_dir):
    m = sorted(glob.glob(os.path.join(models_dir, "asr", "paraformer", "*", "model.int8.onnx")))
    return m[-1] if m else None


def decode(body, content_type=""):
    """the request body → 16 kHz mono float32: raw little-endian PCM16 at 16 kHz (the worklet's output) or a WAV"""
    if content_type == "audio/wav" or body[:4] == b"RIFF":
        import io, wave
        with wave.open(io.BytesIO(body)) as w:
            sr, ch = w.getframerate(), w.getnchannels()
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
        if ch > 1: x = x.reshape(-1, ch).mean(1)
        if sr != SR:
            from scipy.signal import resample_poly
            g = int(np.gcd(sr, SR)); x = resample_poly(x, SR // g, sr // g).astype(np.float32)
        return np.ascontiguousarray(x, np.float32)
    return np.frombuffer(body[:len(body) // 2 * 2], "<i2").astype(np.float32) / 32768.0


class STT:
    """one Paraformer recognizer for the engine (utterances are decoded one at a time, as the repo's queue drains them)"""
    def __init__(self, path, threads=4, vad_path=None):
        import sherpa_onnx
        self.rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=path, tokens=os.path.join(os.path.dirname(path), "tokens.txt"), num_threads=threads,
            sample_rate=SR, feature_dim=80, decoding_method="greedy_search")
        self.lock = threading.Lock()
        self.vad = None
        if vad_path:
            import bargein
            self.vad = bargein._session(vad_path)
        self.transcribe(np.zeros(SR // 2, np.float32))             # warm

    def speech_seconds(self, x):
        """seconds of voice Silero hears (p ≥ 0.5 per 32 ms window, fresh state); None without the model"""
        if self.vad is None: return None
        h = np.zeros((2, 1, 64), np.float32); c = np.zeros((2, 1, 64), np.float32); n = 0
        for i in range(0, len(x) - 511, 512):
            o, h, c = self.vad.run(None, {"input": np.asarray(x[i:i + 512], np.float32)[None], "sr": np.array(SR, np.int64), "h": h, "c": c})
            n += float(o[0, 0]) >= 0.5
        return n * 512 / SR

    def transcribe(self, x):
        with self.lock:
            s = self.rec.create_stream(); s.accept_waveform(SR, np.asarray(x, np.float32)); self.rec.decode_stream(s)
            return (s.result.text or "").strip()
