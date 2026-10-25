"""Hands-free voice input (10-21, user: "实时语音识别 … 能实时对话然后实时回复 … 很快的模型"), fully local:

  Silero VAD (sherpa-onnx, 0.6 MB)       — when you start / stop talking (32 ms windows)
  SenseVoice-Small int8 (sherpa-onnx)    — non-autoregressive, the whole utterance in one pass: ~0.1–0.3 s for a
                                           1–3 s sentence on this Intel CPU, ~0.5 s for 5.6 s (CPU capped at 38 %)

The page streams 16 kHz mono int16 from the microphone (echo cancellation on); per connection a Session turns it into
  {"type": "speech"}                     you started talking (the page may interrupt her)
  {"type": "partial", "text": ...}       live transcript while you talk (re-decoded at most every ~0.35 s)
  {"type": "final", "text": ...}         your turn ended (0.45 s of silence) — the page sends it to /chat
Her reply (brain → Melo → DUIX) is unchanged. Models: GF_HOME/models/asr/{silero_vad.onnx, sv/*/model.int8.onnx}."""
import glob, os, threading, time
import numpy as np

SR = 16000


def model_paths(models_dir):
    sv = sorted(glob.glob(os.path.join(models_dir, "asr", "sv", "*", "model.int8.onnx")))
    vad = os.path.join(models_dir, "asr", "silero_vad.onnx")
    return (sv[-1] if sv else None), vad


def available(models_dir):
    sv, vad = model_paths(models_dir)
    return bool(sv) and os.path.exists(vad)


class ASR:
    """One SenseVoice recognizer for the engine (decodes are serialized; each is short)."""
    def __init__(self, models_dir, threads=4):
        import sherpa_onnx
        self.so = sherpa_onnx
        sv, self.vad_model = model_paths(models_dir)
        self.rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=sv, tokens=os.path.join(os.path.dirname(sv), "tokens.txt"), num_threads=threads, use_itn=True, language="auto")
        self.lock = threading.Lock()
        self.transcribe(np.zeros(SR // 2, np.float32))            # warm

    def transcribe(self, x):
        with self.lock:
            s = self.rec.create_stream(); s.accept_waveform(SR, x); self.rec.decode_stream(s)
            return s.result.text.strip()

    def vad(self, min_silence=0.45):
        c = self.so.VadModelConfig()
        c.silero_vad.model = self.vad_model; c.silero_vad.threshold = 0.5
        c.silero_vad.min_silence_duration = min_silence; c.silero_vad.min_speech_duration = 0.2
        c.silero_vad.window_size = 512; c.silero_vad.max_speech_duration = 20.0
        c.sample_rate = SR; c.num_threads = 1
        return self.so.VoiceActivityDetector(c, buffer_size_in_seconds=30)


class Session:
    """Per microphone stream. feed() takes int16 bytes, returns the events to send (partial decodes are requested via
    want_partial() and run by the caller in a thread)."""
    PRE = int(0.3 * SR)                      # audio kept before the VAD's speech start (it fires ~0.2 s in)

    def __init__(self, asr, min_silence=0.45):
        self.asr = asr; self.vad = asr.vad(min_silence)
        self.buf = np.zeros(0, np.float32); self.pos = 0     # samples of this stream seen so far (absolute)
        self.base = 0                                        # absolute index of buf[0]
        self.rest = np.zeros(0, np.float32)                  # < 512 samples waiting for a full VAD window
        self.speaking = False; self.start = 0; self.last_partial = 0.0; self.partial_busy = False; self.part_text = ""
        self.min_silence = min_silence; self.part_end = 0; self.text_end = 0; self.fut = None

    def feed(self, pcm):
        x = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
        self.buf = np.concatenate([self.buf, x]); self.pos += len(x)
        keep = 25 * SR                                        # bounded memory: last 25 s
        if len(self.buf) > keep:
            cut = len(self.buf) - keep; self.buf = self.buf[cut:]; self.base += cut
        ev = []
        y = np.concatenate([self.rest, x]); n = (len(y) // 512) * 512
        if n: self.vad.accept_waveform(y[:n])
        self.rest = y[n:]
        on = self.vad.is_speech_detected()
        if on and not self.speaking:
            self.speaking = True; self.start = max(self.base, self.pos - int(0.25 * SR) - self.PRE); self.part_text = ""; self.text_end = 0
            ev.append({"type": "speech"})
        while not self.vad.empty():                          # a finished utterance (0.45 s of silence after it)
            seg = np.asarray(self.vad.front.samples, np.float32); self.vad.pop()
            self.speaking = False
            ev.append({"type": "segment", "samples": seg, "speech_end": self.pos - int(self.min_silence * SR)})
        if not on and self.speaking and not ev: pass
        return ev

    def want_partial(self, every=0.35):
        if not self.speaking or self.partial_busy: return None
        now = time.time()
        if now - self.last_partial < every: return None
        a = max(0, self.start - self.base); x = self.buf[a:]
        if len(x) < int(0.4 * SR): return None
        self.last_partial = now; self.partial_busy = True; self.part_end = self.pos
        return x.copy()

    def reusable(self, speech_end):
        """The last live transcript already covers everything up to the end of the speech (it was taken during the
        0.45 s of silence that ended the turn) — use it as the final: no second decode."""
        return bool(self.part_text) and self.text_end >= speech_end - int(0.05 * SR)
