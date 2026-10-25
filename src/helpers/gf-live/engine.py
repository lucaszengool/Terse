"""Terse AI 女友 · live engine — the freedidi 小雅 tutorial's pipeline, native on macOS.

  tutorial (RTX 4090, WSL)            here (Intel Mac, Radeon 5500M)
  ─────────────────────────────────   ───────────────────────────────────────────────
  wav2lip256 via LiveTalking (CUDA)   the SAME wav2lip256.pth, converted to Core ML fp16, on the Radeon
  WebRTC full-frame stream            idle video plays natively in the wallpaper; only the 256² mouth
                                      patch per frame is streamed and feathered in (sharper, ~1/30 the data)
  Qwen3-TTS 1.7B-Base voice clone     Qwen3-TTS 0.6B-Base voice clone (tutorial's low-VRAM fallback); `say` if absent
  faster-whisper + VAD                Apple Speech (terse-listen) — done in Terse, not here
  llama.cpp Qwen3-14B                 llama.cpp Qwen3-4B / the user's own agent — done in Terse (gf_chat)

HTTP / WebSocket on 127.0.0.1:8770 (the wallpaper page talks to it directly):
  POST /avatar {"video": path}            prepare an idle clip: frames, face boxes, encoder features (in the runner)
  POST /chat   {"text", "history"?, "name"?, "brain"?}   one turn with her brain, streamed: the local llama-server Qwen3, or
                                          "brain": claude|codex|dsh — that coding agent's CLI (agents.py), same persona;
                                          each finished sentence -> TTS -> "utt" event (she talks after sentence 1)
  GET  /brains                            agents found on this Mac;  POST /brain {"id"}  一键连接 (Claude Code login included)
  POST /say    {"text"}                   speak given text (an agent's reply), sentence by sentence
  POST /stop                              drop whatever is queued (barge-in)
  POST /stt    16 kHz PCM16 / WAV body      one whole utterance → {"text"} (Paraformer-large; the page cuts it: gf-mic.js)
  WS   /vad                               barge-in: the mic while she talks → {"event": "speech_start"} (Silero VAD v4)
  POST /blow                              one "blow" (rounded lips + a breath) — she blows out an agent-log line
  POST /voice  {"engine": omnivoice|qwenclone|qwencpp|kokoro|qwen|clone|say, "omni_mode": fast|exact, "clone_voice", "temperature", "speaker", "qwen_speaker", "speed", "ref", "ref_text",
                "hd": true|false}               HD reply mode: DUIX face (render first, then speak)
  WS   /events                            {"type": thinking|utt|reply|stop|error, ...} — the wallpaper subscribes
  WS   /patches?id=&k0=&stride=           binary mouth patches for base frames (k0+j) % n
  GET  /idle.mp4, /audio/<id>.wav, /health

usage: <gf-live venv>/bin/python engine.py [--port 8770]     (Terse starts it; see girlfriend.rs gf_live_*)
⚠ wav2lip weights are NON-COMMERCIAL (LiveTalking / Wav2Lip). Local use on this Mac only; not bundled.
"""
import asyncio, hashlib, json, os, re, struct, subprocess, sys, tempfile, threading, time, uuid, wave
import numpy as np
from PIL import Image

if os.name == "nt":                                   # Windows: no console window for any helper (ffmpeg, the DUIX runner,
    class _NoWindow(subprocess.Popen):                # llama-server) — Terse runs the engine without one, and every console
        def __init__(self, *a, **k):                  # child would otherwise flash a black window on the user's screen
            k["creationflags"] = k.get("creationflags", 0) | 0x08000000      # CREATE_NO_WINDOW
            super().__init__(*a, **k)
    subprocess.Popen = _NoWindow                      # subprocess.run / check_output build on it

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gfmel as L                                     # mel features (Wav2Lip hparams, numpy only)

HOME = os.path.expanduser(os.environ.get("GF_HOME", "~/.terse/gf-live"))   # what the one-click setup fills in
MODELS = os.path.join(HOME, "models")
VIDEO_BIN = os.environ.get("GF_VIDEO_BIN", os.path.join(HERE, "terse-gf-video"))
S = 256
# Crop alignment found by grid search (10-17): a square box around the face, nudged UP by 0.10 face
# heights so her real lips sit where the model draws the mouth. Off by that much = "double lip".
SHIFT, GROW = -0.10, 0.08
ALPHA = float(os.environ.get("GF_ALPHA", "2.0"))      # a_alpha: audio strength (LiveTalking's own knob)
KOKORO_DIR = os.path.join(MODELS, "kokoro-multi-lang-v1_1")
KOKORO_SPEAKER = int(os.environ.get("GF_SPEAKER", "27"))  # a bright young Mandarin female voice (kokoro v1.1 zf_*)
LLAMA_PORT = int(os.environ.get("GF_LLAMA_PORT", "8090"))
RUNNER_BIN = os.environ.get("GF_RUNNER_BIN", os.path.join(HERE, "terse-gf-lipsync"))


class Runner:
    """Client for lipsync-runner.swift: Core ML wav2lip on both GPUs, JPEG patches back in completion order."""

    def __init__(self, on_exit=None):
        self.p = subprocess.Popen([RUNNER_BIN, os.path.join(MODELS, "w2l256_enc_fp16.mlpackage"),
                                   os.path.join(MODELS, "w2l256_dec_fp16.mlpackage")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.wlock = threading.Lock()
        self.cbs = {}
        self.avatar_done = threading.Event()   # set once this process holds the avatar's encoder features
        self.req = 0
        self.dead, self.on_exit = False, on_exit
        threading.Thread(target=self._read, daemon=True).start()

    def _readn(self, n):
        b = b""
        while len(b) < n:
            c = self.p.stdout.read(n - len(b))
            if not c: raise EOFError
            b += c
        return b

    def _read(self):
        try:
            while True:
                tag = self._readn(1)
                if tag == b"R":
                    req, n = struct.unpack("<II", self._readn(8)); data = self._readn(n)
                    cb = self.cbs.pop(req, None)
                    if cb: cb(data)
                elif tag == b"A":
                    self._readn(4); self.avatar_done.set()
                elif tag == b"E":
                    (n,) = struct.unpack("<I", self._readn(4)); print("[gf-live] runner:", self._readn(n).decode(errors="replace"), flush=True)
        except EOFError:
            print("[gf-live] runner exited", flush=True)
            # 10-20: Core ML once failed to allocate an output buffer under GPU memory pressure and the process died — the
            # normal lip-sync stayed dead until the engine restarted. Fail what was waiting, let the engine start a new one.
            self.dead = True; self.avatar_done.set()
            for cb in list(self.cbs.values()):
                try: cb(None)
                except Exception: pass
            self.cbs.clear()
            if self.on_exit: threading.Thread(target=self.on_exit, daemon=True).start()

    def load_avatar_stream(self, n, frames):
        """frames: uint8 [6, S, S] (masked + reference face, BGR 0..255) → runner 'U' (a quarter of the float payload)."""
        self.avatar_done.clear()
        with self.wlock:
            self.p.stdin.write(b"U" + struct.pack("<I", n))
            sent = 0
            for x in frames:
                if sent < n: self.p.stdin.write(np.ascontiguousarray(x, np.uint8).tobytes()); sent += 1
            self.p.stdin.flush()
        self.avatar_done.wait()

    def load_avatar(self, inputs):
        self.avatar_done.clear()
        with self.wlock:
            self.p.stdin.write(b"A" + struct.pack("<I", len(inputs)))
            for x in inputs: self.p.stdin.write(np.ascontiguousarray(x, np.float32).tobytes())
            self.p.stdin.flush()
        self.avatar_done.wait()

    def submit(self, base, alpha, w, h, mel, cb):
        if self.dead or not self.avatar_done.is_set():      # dead, or a fresh runner still loading the avatar: no patch
            cb(None); return
        with self.wlock:
            self.req += 1; r = self.req
            self.cbs[r] = cb
            self.p.stdin.write(b"P" + struct.pack("<IIfHH", r, base, alpha, w, h) + np.ascontiguousarray(mel, np.float32).tobytes())
            self.p.stdin.flush()


def mobile_available():
    try:
        from duix.duix_mobile import available
        return available()
    except Exception:
        return False


def big_duix_available():
    try:
        from duix.duix_hd import available
        return available()
    except Exception:
        return False


def hw():
    """this Mac, as setup.sh found it (hw.json: arch, macos, ram_gb, perf_cores, gpu, gpu_class apple | dgpu | igpu); an
    install from before 10-21 has no hw.json — then the same probe here"""
    if getattr(hw, "_v", None) is None:
        try:
            hw._v = json.load(open(os.path.join(HOME, "hw.json")))
        except Exception:
            try:
                if os.name == "nt":                   # Windows: setup.ps1 writes hw.json; this is the same probe if it did not
                    gpus = subprocess.run(["powershell", "-NoProfile", "-Command",
                                           "(Get-CimInstance Win32_VideoController).Name -join '|'"],
                                          capture_output=True, text=True, timeout=20).stdout
                    hw._v = {"arch": "x86_64", "gpu_class": "dgpu" if re.search(r"nvidia|geforce|rtx|radeon rx|radeon pro|arc a", gpus, re.I) else "igpu"}
                else:
                    arm = subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True).stdout.strip() == "1"
                    gpus = subprocess.run(["system_profiler", "SPDisplaysDataType"], capture_output=True, text=True).stdout if not arm else ""
                    hw._v = {"arch": "arm64" if arm else "x86_64",
                             "gpu_class": "apple" if arm else "dgpu" if re.search(r"radeon|amd|nvidia|geforce", gpus, re.I) else "igpu"}
            except Exception:
                hw._v = {"arch": "x86_64", "gpu_class": "igpu"}
    return hw._v


def duix_renderer():
    """Which DUIX draws her mouth: 'big' (DINetV1 fast split on the GPU — sharp, clearly moving lips) or 'mobile' (Mia's own
    small Duix-Mobile model on the CPU / GPU — real time, but v1 is still soft and its lips barely move, user 10-20
    "我没看到任何口型"). GF_DUIX_RENDERER picks; default big (Apple silicon, or an Intel Mac with a discrete GPU), but the
    small one on an Intel Mac with only Intel graphics — there full DUIX can't keep up with her voice."""
    want = os.environ.get("GF_DUIX_RENDERER") or ("mobile" if hw().get("gpu_class") == "igpu" else "big")
    if want == "mobile" and mobile_available(): return "mobile"
    if big_duix_available(): return "big"
    return "mobile" if mobile_available() else None


class LightAvatar:
    """Real-time DUIX (duix/duix_mobile.py): her clips' shared frame space without wav2lip — no encoder features in a GPU
    runner, no multi-minute start, a fraction of the RAM. Frame counts and boxes come from the DUIX mobile clips (DUIX face
    tracking, cached on disk); boxes are the lower-face box [x1, y1, x2, y2] (the page aims her breath at 0.70 of it)."""

    def __init__(self, paths, mobile):
        import cv2
        paths = [paths] if isinstance(paths, str) else list(paths)
        self.path, self.paths = paths[0], paths
        self.boxes, self.ranges = [], []
        t = time.time()
        for p in paths:
            c = mobile.clip(p)
            self.ranges.append([len(self.boxes), c.n])
            if getattr(mobile, "split", None) is False and hasattr(mobile, "box266"):          # DuixMobile: x, y, w, h
                self.boxes += [[int(x), int(y), int(x + w), int(y + h)] for x, y, w, h in c.boxes]
            else:                                                                             # DuixHD: y1, y2, x1, x2
                self.boxes += [[int(x1), int(y1), int(x2), int(y2)] for y1, y2, x1, x2 in c.boxes]
        cap = cv2.VideoCapture(self.path)
        self.w, self.h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0); cap.release()
        self.n = len(self.boxes); self.frames = None
        print(f"[gf-live] avatar (real-time DUIX) {', '.join(os.path.basename(p) for p in paths)}: {self.n} frames "
              f"{self.w}x{self.h}@{self.fps:g} in {time.time() - t:.1f}s", flush=True)

    def range_of(self, k):
        for lo, n in self.ranges:
            if lo <= k < lo + n: return lo, n
        return 0, self.n


class Avatar:
    """The clips she can talk on, ready for live lip-sync: frames → aligned crop boxes → encoder features (in the runner).
    `paths` = one idle clip, or a list (idle first, then expression bases: 撒娇 / 傲娇 / 害羞 …). Several clips share one
    frame space: clip i is frames [ranges[i][0], ranges[i][0] + ranges[i][1]); a patch request names its range so the
    mouth always follows the clip that is actually on screen."""

    def __init__(self, paths, runner):
        paths = [paths] if isinstance(paths, str) else list(paths)
        self.path, self.paths = paths[0], paths
        self.boxes, self.ranges = [], []
        t = time.time(); crops = []
        for p in paths:                            # 1) face crops for every clip — cached per clip (user 10-19: 8.5 min per start)
            c, boxes = self._clip_crops(p)
            self.ranges.append([len(self.boxes), len(c)]); self.boxes += boxes
            crops.append(c)
        def gen():                                 # 2) streamed to the runner one frame at a time (uint8)
            for c in crops:
                for k in range(len(c)):
                    crop = c[k]
                    masked = crop.copy(); masked[S // 2:] = 0
                    yield np.concatenate([masked, crop], 2).transpose(2, 0, 1)
        self.n = len(self.boxes)
        runner.load_avatar_stream(self.n, gen())   # encoder features live in the runner, next to the GPUs
        self.frames = None
        print(f"[gf-live] avatar {', '.join(os.path.basename(p) for p in paths)}: {self.n} frames {self.w}x{self.h}@{self.fps:g} "
              f"encoded in {time.time() - t:.1f}s", flush=True)

    def range_of(self, k):
        for lo, n in self.ranges:
            if lo <= k < lo + n: return lo, n
        return 0, self.n

    def _boxes(self, faces):
        last = next((f for f in faces if f), None)
        if last is None:
            raise RuntimeError("no face found in the idle video")
        raw = []
        for f in faces:
            last = f or last
            x, y, fw, fh = last
            cx, cy = (x + fw / 2) * self.w, (y + fh / 2 + SHIFT * fh) * self.h
            half = max(fw * self.w, fh * self.h) / 2 * (1 + GROW)
            raw.append([cx - half, cy - half, cx + half, cy + half])
        b = np.array(raw)
        sm = np.array([b[max(0, i - 2):i + 3].mean(0) for i in range(len(b))])      # 5-frame smoothing, like LiveTalking
        out = []
        for x1, y1, x2, y2 in np.round(sm).astype(int):
            x1, y1 = max(0, x1), max(0, y1); x2, y2 = min(self.w, x2), min(self.h, y2)
            out.append((int(x1), int(y1), int(x2), int(y2)))
        return out

    def _crop_box(self, frame, box):
        x1, y1, x2, y2 = box
        return np.asarray(Image.fromarray(frame[y1:y2, x1:x2]).resize((S, S), Image.BICUBIC)).astype(np.float32) / 255.0

    def _clip_crops(self, path):
        """→ (uint8 [N, S, S, 3] face crops, boxes). Decoding + Vision face boxes + cropping is the slow part of an avatar
        load, and the clips never change: kept in GF_HOME/cache/w2l/<sha>.npz (keyed by the clip's content)."""
        # keyed by content (size + first / last MB), not path or mtime: reinstalling Terse must not throw the cache away
        h = hashlib.sha1(b"w2l-crops-v1"); size = os.path.getsize(path)
        with open(path, "rb") as fh:
            h.update(fh.read(1 << 20)); fh.seek(max(0, size - (1 << 20))); h.update(fh.read(1 << 20))
        h.update(str(size).encode()); key = h.hexdigest()[:16]
        cdir = os.path.join(HOME, "cache", "w2l"); f = os.path.join(cdir, key + ".npz")
        if os.path.exists(f):
            try:
                z = np.load(f)
                self.w, self.h, self.fps = int(z["w"]), int(z["h"]), float(z["fps"])
                return z["crops"], [tuple(int(v) for v in b) for b in z["boxes"]]
            except Exception as e:
                print(f"[gf-live] crop cache unreadable, rebuilding: {e}", flush=True)
        raw = tempfile.mktemp(prefix="gf-frames-", suffix=".bgr")
        try:
            info = json.loads(subprocess.run([VIDEO_BIN, path, raw], capture_output=True, text=True, check=True).stdout)
            self.w, self.h, self.fps = info["w"], info["h"], float(info["fps"])
            per = self.w * self.h * 3
            fr = np.memmap(raw, dtype=np.uint8, mode="r", shape=(os.path.getsize(raw) // per, self.h, self.w, 3))
            boxes = self._boxes(info["faces"][:len(fr)])
            crops = np.empty((len(fr), S, S, 3), np.uint8)
            for k in range(len(fr)):
                x1, y1, x2, y2 = boxes[k]
                crops[k] = np.asarray(Image.fromarray(fr[k][y1:y2, x1:x2]).resize((S, S), Image.BICUBIC))
            del fr
        finally:
            try: os.unlink(raw)
            except OSError: pass
        try:
            os.makedirs(cdir, exist_ok=True)
            tmp = f + ".tmp.npz"
            np.savez(tmp, crops=crops, boxes=np.asarray(boxes, np.int32), w=self.w, h=self.h, fps=self.fps)
            os.replace(tmp, f)
        except Exception as e:
            print(f"[gf-live] crop cache not saved: {e}", flush=True)
        return crops, boxes


_rng = np.random.default_rng()


def breath_noise(sr, level):
    """A soft inhale (A2): band-limited noise around 1.8 kHz, ~220 ms, rising then falling."""
    n = int(0.22 * sr); w = _rng.standard_normal(n).astype(np.float32)
    W = np.fft.rfft(w); f = np.fft.rfftfreq(n, 1 / sr); W *= ((f > 500) & (f < 5000)) * np.exp(-((f - 1800) / 1800) ** 2)
    w = np.fft.irfft(W, n).astype(np.float32)
    return w / (np.abs(w).max() + 1e-9) * np.sin(np.linspace(0, np.pi, n)) ** 1.5 * level


def small_room(x, sr, wet=0.07):
    """A2's touch of room: 5 ms pre-delay, RT60 ~0.22 s decaying-noise impulse, 7 % wet (no dry 'studio TTS' feel)."""
    n = int(0.25 * sr); t = np.arange(n) / sr
    ir = np.random.default_rng(3).standard_normal(n).astype(np.float32) * np.exp(-6.9 * t / 0.22)
    ir[: int(0.005 * sr)] = 0; ir /= np.sqrt((ir ** 2).sum())
    m = 1 << int(np.ceil(np.log2(len(x) + n)))
    y = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[: len(x)].astype(np.float32)
    return x * (1 - wet) + y * wet * 1.6


def warm_voice(x, sr, g_lo=2.5, f_lo=220.0, g_hi=-8.0, f_hi=3800.0):
    """Warmth EQ (user 10-18: the built-in voices sound thinner / brighter than the 小雅 reference — measured 3-8 kHz vs
    0.1-1 kHz energy 0.52 vs 0.31): low shelf +2.5 dB @220 Hz (body), high shelf -8 dB @3.8 kHz (less edge; = the -6 dB biquad that matched 0.31). Zero-phase,
    done on the spectrum (numpy only, ~ms per sentence), loudness kept."""
    if len(x) < 64:
        return x
    n = 1 << int(np.ceil(np.log2(len(x) + 2048)))
    X = np.fft.rfft(np.pad(x, (1024, n - len(x) - 1024)))
    f = np.fft.rfftfreq(n, 1 / sr)
    lo = 1 + (10 ** (g_lo / 20) - 1) / (1 + (f / f_lo) ** 2)              # smooth shelves
    hi = 1 + (10 ** (g_hi / 20) - 1) * (f / f_hi) ** 2 / (1 + (f / f_hi) ** 2)
    y = np.fft.irfft(X * lo * hi, n)[1024:1024 + len(x)].astype(np.float32)
    return y * (np.sqrt((x ** 2).mean()) / max(1e-9, np.sqrt((y ** 2).mean())))


# her real-time voice (user 10-20: MeloTTS "this is good … 更温柔更甜妹一点", picked strength 3): sherpa-onnx MeloTTS
# (~2x faster than real time on this CPU) + sweet.py (WORLD: pitch up, formants up a little, breathier). Levels:
SWEET = {1: (0.94, 1.08, 1.02, 0.12), 2: (0.92, 1.14, 1.04, 0.16), 3: (0.90, 1.20, 1.06, 0.20)}   # speed, pitch, formant, breath
MELO_DIR = os.path.join(HOME, "models", "vits-melo-tts-zh_en")
# 10-20 Matcha (sherpa-onnx matcha-icefall-zh-baker + vocos-22khz): ~5× faster than MeloTTS on this CPU, same sweetening
MATCHA_DIR = os.path.join(os.path.dirname(MELO_DIR), "matcha")
# 10-21 (user's pick from 7 candidates: "use the one 3 — Breeze2 台湾腔"): MediaTek Research's Breeze2-VITS — Taiwanese Mandarin,
# distilled from BreezyVoice to run on phones (sherpa-onnx VITS, 22.05 kHz, Zhuyin lexicon with simplified + traditional
# characters, the Taiwanese particles 欸 耶 喔 included); ~0.37× real time on this CPU. Ships in MediaTek's BreezeApp (Apache-2.0).
BREEZE2_DIR = os.path.join(os.path.dirname(MELO_DIR), "breeze2-vits")
# user 10-21: "在这个基础上再把声音微调的更细更温柔更甜一点" — on top of Breeze2's own voice (median F0 234 Hz, +2 dB of low end
# against its mids, a dull top): pitch / formants a little up (细、甜), the low end thinned, a little air and breath (温柔),
# a touch slower; its own intonation kept (range barely widened). 0 = Breeze2 exactly as released.
BREEZE_SWEET = {1: dict(speed=0.98, pitch=1.10, formant=1.03, breath=0.10, low=4.0, bright=1.0, range_k=1.05),
                2: dict(speed=0.97, pitch=1.15, formant=1.05, breath=0.12, low=5.5, bright=1.5, range_k=1.08),
                3: dict(speed=0.96, pitch=1.20, formant=1.07, breath=0.15, low=7.0, bright=2.0, range_k=1.10)}
# 10-21 late (user: "更清晰一点并且不要太尖，温柔但是更自然一点，给我几种不同的声音选择") — voice styles, no WORLD. Measured on the
# same lines (Paraformer reading her back, 3 takes each): WORLD was what blurred her (CER 0.17 → 0.05–0.12 without it) and its
# formant / brightness lift what made her shrill (+6.7 dB at 3.5–6 kHz over the raw voice, F0 275 Hz). Sweetness now comes from
# the rate: she says the line slower and her 22.05 kHz samples are read at `rate` — pitch and formants × rate / 22050 with no
# vocoder at all (rates FFT-friendly; 24000 = no resample). eq = sweet.soften, dB: low − at 250 Hz, presence + at 1.8 kHz
# (consonants), harsh − at 3.5–6 kHz (shrill / sibilant), air at 7 kHz+. Samples: mia_voice_candidates/C1–C6.
VOICE_STYLES = {
    "clear":      dict(speed=0.97, rate=22050, eq=dict(low=1.5, presence=2.5, harsh=1.5, air=0.0)),     # 自然清晰
    "gentle":     dict(speed=0.92, rate=22050, eq=dict(low=0.0, presence=1.5, harsh=2.5, air=-1.5)),    # 温柔轻声
    "soft_sweet": dict(speed=0.96, rate=23040, eq=dict(low=1.5, presence=2.0, harsh=3.0, air=-1.0)),    # 温柔微甜
    "sweet":      dict(speed=0.96, rate=24000, eq=dict(low=2.0, presence=2.0, harsh=2.0, air=0.0)),     # 甜而不尖 (default; 10-21
                  # night "个别字糊掉": a little more consonant — 3.5–6 kHz still −25.6 dB, the old 尖 voice was −21.5)
    "mature":     dict(speed=0.95, rate=21504, eq=dict(low=0.5, presence=2.0, harsh=1.5, air=0.0)),     # 温柔成熟
    "mandarin":   dict(speed=1.05, rate=22050, eq=dict(low=1.0, presence=1.0, harsh=5.0, air=-9.0)),    # 标准普通话 (Matcha baker)
}
# 10-21 (user: "完成所有预热后才显示AI女友在壁纸上，用户就可以直接用"): what has been warmed. /health reports it; the wallpaper
# shows her only when every part is True or "n/a" (not installed / not used on this Mac) — her first answer is then as fast
# as any later one. avatar / dh / gestures follow the clip the page registered (/avatar resets them for a new one).
WARM = {"voice": False, "brain": False, "stt": False, "avatar": False, "dh": False, "gestures": False}
VOICE_STYLE = "sweet"                                                       # the user's pick (C4), 10-21
HD_K0 = 3                                                                   # HD replies start on frame 3 of their base clip
# instant reactions (user 10-19: "延迟只允许 1 秒内"): on this Intel Mac the brain needs ~2–4 s for its first clause and the
# voice ~3x real time, so she answers a message at once with a short interjection — her own voice, DUIX mouth, all
# pre-rendered when she loads — while the real reply is thought and spoken behind it.
# (MeloTTS drops "～" and barely voices a lone 嗯 / 欸 — phrased so every one is audible)
FILLERS = ["嗯嗯，", "好呀，", "哈哈，", "哎呀，", "嗯，我在呢。", "嗯…我想想哦。"]
QTTS_URL = os.environ.get("GF_QTTS_URL", "http://127.0.0.1:8091")          # CustomVoice (named speaker + mood instruction)
QCLONE_URL = os.environ.get("GF_QCLONE_URL", "http://127.0.0.1:8092")      # Base (her own designed voice, ICL clone)
# qwentts.cpp: setup.sh installs it as $GF_HOME/qwentts/{build/tts-server, models/*.gguf}; a dev checkout otherwise
QTTS_DIR = os.path.expanduser(os.environ.get("GF_QTTS_DIR") or next(
    (d for d in (os.path.join(HOME, "qwentts"), "~/.cache/terse-gf-work/qwentts.cpp") if os.path.exists(os.path.join(os.path.expanduser(d), "build/tts-server"))),
    os.path.join(HOME, "qwentts")))
# designed voices (user 10-19 "更温柔甜美细腻、不要 AI 味"): made once with Qwen3-TTS 1.7B VoiceDesign from a written
# description, shipped as tiny clone latents (<name>.spk speaker embedding + <name>.rvq/.txt an 8 s reference) —
# the 0.6B Base model speaks in that voice live. Optional per-mood references: <name>@撒娇.rvq/.txt (same .spk).
VOICE_DIRS = [os.path.join(HOME, "voices"), os.path.join(HERE, "voices")]
_qtts = {}


def ensure_qtts(url=QTTS_URL, model=None):
    """Start qwentts.cpp's tts-server once per URL if nothing answers there (C++/GGML Qwen3-TTS, OpenAI-compatible).
    Thread split from the 10-18 sweep on this i9: talker 6 threads, codec 8 threads on its own pool (async decode)."""
    import urllib.request
    try:
        urllib.request.urlopen(url + "/health", timeout=1).read(); return False
    except Exception:
        pass
    pr = _qtts.get(url)
    if not (pr and pr.poll() is None):
        model = model or os.environ.get("GF_QTTS_MODEL", "models/qwen-talker-0.6b-customvoice-Q4_K_M.gguf")
        env = dict(os.environ, QT_THREADS=os.environ.get("QT_THREADS", "6"), QT_CODEC_THREADS=os.environ.get("QT_CODEC_THREADS", "8"))
        _qtts[url] = subprocess.Popen([os.path.join(QTTS_DIR, "build/tts-server"),
                                       "--model", os.path.join(QTTS_DIR, model),
                                       "--codec", os.path.join(QTTS_DIR, os.environ.get("GF_QTTS_CODEC", "models/qwen-tokenizer-12hz-Q8_0.gguf")),
                                       "--device", "CPU", "--lang", "Chinese", "--port", url.rsplit(":", 1)[-1]],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    for _ in range(480):                    # up to 4 min: a first start on a hot Intel Mac took > 60 s (10-19, voice fell back)
        try:
            urllib.request.urlopen(url + "/health", timeout=1).read(); return True
        except Exception:
            if _qtts.get(url) is not None and _qtts[url].poll() is not None: break      # it died: don't wait for nothing
            time.sleep(0.5)
    raise RuntimeError("qwentts.cpp tts-server did not come up")


def tempo(x, sr, rate):
    """Pitch-preserving speed change (WSOLA: 30 ms Hann frames, ±10 ms similarity search) for the voices that have no
    speed control of their own (the qwentts.cpp servers). rate > 1 = faster."""
    if abs(rate - 1) < 0.02 or len(x) < sr // 10: return x
    N = int(sr * 0.03) // 2 * 2; Hs = N // 2; tol = int(sr * 0.01)
    w = np.hanning(N).astype(np.float32)
    n_out = int(len(x) / rate)
    xp = np.pad(x.astype(np.float32), (tol + N, tol + 2 * N + int(N * rate)))
    y = np.zeros(n_out + 2 * N, np.float32); ws = np.zeros_like(y)
    prev, pos = None, 0
    while pos < n_out:
        a = int(pos * rate) + tol + N
        d = 0 if prev is None else int(np.argmax(np.correlate(xp[a - tol: a + tol + N], prev, "valid"))) - tol
        y[pos: pos + N] += xp[a + d: a + d + N] * w; ws[pos: pos + N] += w
        prev = xp[a + d + Hs: a + d + Hs + N]
        pos += Hs
    return (y / np.maximum(ws, 1e-3))[:n_out]


def _voice_file(name, ext):
    for d in VOICE_DIRS:
        f = os.path.join(d, name + ext)
        if os.path.exists(f): return f
    return None


OMNI_URL = os.environ.get("GF_OMNI_URL", "http://127.0.0.1:8093")         # OmniVoice (HD reply mode voice, omni/omni_server.py)
_omni = {}


def ensure_omni():
    """Start omni/omni_server.py once (its own Python: transformers 5 needs PyTorch ≥ 2.4 — conda-forge on Intel Macs)."""
    import urllib.request
    try:
        urllib.request.urlopen(OMNI_URL + "/health", timeout=1).read(); return False
    except Exception:
        pass
    pr = _omni.get("p")
    if not (pr and pr.poll() is None):
        py = os.path.expanduser(os.environ.get("GF_OMNI_PY", os.path.join(HOME, "omni-env/bin/python")))
        _omni["p"] = subprocess.Popen([py, "-u", os.path.join(HERE, "omni", "omni_server.py"), "--port", OMNI_URL.rsplit(":", 1)[-1]],
                                      stdout=open(os.path.join(HOME, "omni.log"), "a"), stderr=subprocess.STDOUT)
    for _ in range(600):                                                   # model load + Core ML compile on first run
        try:
            urllib.request.urlopen(OMNI_URL + "/health", timeout=1).read(); return True
        except Exception:
            if _omni["p"].poll() is not None: raise RuntimeError("OmniVoice server exited (see omni.log)")
            time.sleep(0.5)
    raise RuntimeError("OmniVoice server did not come up")


_cloned = {}          # url -> {registered voice names}


def clone_voice(name, emo=None):
    """Register <name> (and <name>@<emo> when that mood reference exists) on the Base tts-server; -> the voice id to use.
    The first request after registering builds the reference context (~7-10 s here), so a registration is warmed at once."""
    import base64, urllib.request
    reg = _cloned.setdefault(QCLONE_URL, set())
    spk = _voice_file(name, ".spk")
    if not spk: raise RuntimeError(f"no designed voice '{name}'")
    vid = name
    if emo and _voice_file(f"{name}@{emo}", ".rvq") and _voice_file(f"{name}@{emo}", ".txt"): vid = f"{name}@{emo}"
    if vid not in reg:
        body = {"name": vid, "spk_b64": base64.b64encode(open(spk, "rb").read()).decode(),
                "rvq_b64": base64.b64encode(open(_voice_file(vid, ".rvq"), "rb").read()).decode(),
                "ref_text": open(_voice_file(vid, ".txt"), encoding="utf-8").read().strip()}
        urllib.request.urlopen(urllib.request.Request(QCLONE_URL + "/v1/audio/voices", data=json.dumps(body).encode(),
                                                      headers={"Content-Type": "application/json"}), timeout=60).read()
        reg.add(vid)
        _qtts_pcm(QCLONE_URL, {"input": "嗯。", "voice": vid, "language": "Chinese"})        # warm the reference context
    return vid


def _qtts_pcm(url, body, timeout=180):
    """tts-server "pcm" = the streaming decode path, where the codec worker overlaps generation (RTF ~1.3 vs ~1.8 for
    the buffered "wav" path); s16le 24 kHz mono, lead-in / tail silence trimmed."""
    import urllib.request
    body = dict(body, response_format="pcm")
    req = urllib.request.Request(url + "/v1/audio/speech", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    a = np.frombuffer(data[: len(data) // 2 * 2], np.int16).astype(np.float32) / 32768
    nz = np.nonzero(np.abs(a) > 0.015)[0]
    return a[max(0, nz[0] - 600): nz[-1] + 1800] if len(nz) else a


class Engine:
    def __init__(self):
        t = time.time()
        # real-time DUIX (duix_mobile) replaces both wav2lip and the big DUIX model: no GPU runner at all (low RAM, no lag)
        self.renderer = duix_renderer()
        self.mobile_mode = self.renderer is not None    # DUIX-only: every mouth is DUIX, no wav2lip runner, light start
        self.runner = None if self.mobile_mode else Runner(on_exit=self._runner_died)
        self._runner_restarts = []
        print(f"[gf-live] {('DUIX-only, renderer ' + self.renderer) if self.mobile_mode else 'lipsync runner up'} in {time.time() - t:.1f}s", flush=True)
        self.avatar = None
        self.utts = {}
        self.tts = None
        # default voice: her real-time 甜妹 voice (MeloTTS + sweeten) → designed voice (Base 0.6B clone, slower here) →
        # CustomVoice (dev) → Kokoro
        have = lambda m: os.path.exists(os.path.join(QTTS_DIR, "build/tts-server")) and os.path.exists(os.path.join(QTTS_DIR, "models", m))
        self.voice = {"engine": os.environ.get("GF_VOICE") or ("breeze2" if os.path.exists(os.path.join(BREEZE2_DIR, "breeze2-vits.onnx")) else
                                                               "melo" if os.path.exists(os.path.join(MELO_DIR, "model.onnx")) else
                                                               "qwenclone" if have("qwen-talker-0.6b-base-Q4_K_M.gguf") else
                                                               "qwencpp" if have("qwen-talker-0.6b-customvoice-Q4_K_M.gguf") else "kokoro"),
                      "speaker": KOKORO_SPEAKER, "speed": 1.0,
                      "ref": os.environ.get("GF_REF_WAV"), "ref_text": os.environ.get("GF_REF_TEXT", "")}
        self.audio_dir = tempfile.mkdtemp(prefix="gf-live-")
        self.gen_fps = 16.0          # recent patch throughput (frames/s); the page sizes its buffer from it
        self.hd = None               # DuixHD, created when HD reply mode is first switched on
        self.hd_lock = threading.Lock()   # DUIX renders one job at a time, in order (replies, warm-up chunks)
        self.gpu_prio = threading.Event()  # set while Melo's decoder needs the Radeon: DUIX holds new frames
        self.hd_mk = threading.Lock()     # creating DuixHD (one runner process on the GPU, not one per thread)
        # HD (DUIX mouth on every sentence) is the default whenever the DUIX models are installed (user 10-20: "每次说话都有
        # match 的口型和面部表情"); the settings page can turn it off; GF_HD=0/1 forces it
        try:
            from duix.duix_hd import available as _duix_ok
            self.voice["hd"] = os.environ.get("GF_HD", "1" if _duix_ok() else "0") == "1"
        except Exception:
            self.voice["hd"] = os.environ.get("GF_HD") == "1"
        # 流式数字人 (the repo's DUIX flow: every reply segment rendered as one face2face video of her avatar, voice muxed in):
        # the default whenever her avatar video is there; GF_DH=0 / the settings page turn it off (then the HD path above)
        self.voice["dh"] = os.environ.get("GF_DH", "1") == "1"
        self.dh_dir = os.path.join(HOME, "dh"); os.makedirs(self.dh_dir, exist_ok=True)

    # ── voice ──
    # Live voice = Kokoro (sherpa-onnx, CPU, ~5-10x faster than real time). The tutorial's Qwen3-TTS clone
    # measured 11-14x SLOWER than real time on this CPU (10-17), so it is an opt-in "clone" mode, not live.
    def _kokoro(self):
        if getattr(self, "_kk", None) is None:
            import sherpa_onnx
            d = KOKORO_DIR
            lex = ",".join(os.path.join(d, f) for f in ("lexicon-us-en.txt", "lexicon-zh.txt") if os.path.exists(os.path.join(d, f)))
            fsts = ",".join(os.path.join(d, f) for f in ("phone-zh.fst", "date-zh.fst", "number-zh.fst") if os.path.exists(os.path.join(d, f)))
            cfg = sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                        model=os.path.join(d, "model.onnx"), voices=os.path.join(d, "voices.bin"),
                        tokens=os.path.join(d, "tokens.txt"), data_dir=os.path.join(d, "espeak-ng-data"),
                        dict_dir=os.path.join(d, "dict"), lexicon=lex),
                    num_threads=6, provider="cpu"),
                rule_fsts=fsts, max_num_sentences=1)
            self._kk = sherpa_onnx.OfflineTts(cfg)
        return self._kk

    def _breeze2(self):
        if getattr(self, "_bz", None) is None:
            import sherpa_onnx
            d = BREEZE2_DIR; m = MELO_DIR
            fst = ",".join(os.path.join(m, f) for f in ("date.fst", "number.fst") if os.path.exists(os.path.join(m, f)))
            # 10-21 (user: "C4 有个别字吐字不清晰，或者糊掉了"), measured on 30 of her lines × 3 takes, Paraformer reading her back:
            # · her pronunciations (breeze_lex): 一 / 不 tone sandhi, neutral 得 / 地, the clause particles voiced — CER 9.0 → 7.5 %
            # · VITS sampling noise 0.667 / 0.8 → 0.45 / 0.6: the random slurs (a syllable mumbled in one take, fine in the next)
            #   70 → 38 spots — clearer and steadier, the melody a little calmer (GF_BZ_NOISE="ns,nsw" to change)
            lex, jdict = os.path.join(d, "lexicon.txt"), os.path.join(m, "dict")                 # jieba: Melo's dictionary
            try:
                import breeze_lex
                got = breeze_lex.build(MODELS)
                if got: lex, jdict = got
            except Exception as e:
                print(f"[gf-live] Breeze2 pronunciations unavailable ({e}), the model's own", flush=True)
            ns, nsw = (float(v) for v in os.environ.get("GF_BZ_NOISE", "0.45,0.6").split(","))
            self._bz = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=os.path.join(d, "breeze2-vits.onnx"), lexicon=lex, tokens=os.path.join(d, "tokens.txt"),
                    dict_dir=jdict, noise_scale=ns, noise_scale_w=nsw),
                    num_threads=4), rule_fsts=fst, max_num_sentences=1))
        return self._bz

    def _melo(self):
        if getattr(self, "_mt", None) is None:
            import sherpa_onnx
            from melo_gpu import lexicon                # the clause particles in tone 1, as on the GPU path
            d = MELO_DIR; fst = ",".join(os.path.join(d, f) for f in ("date.fst", "number.fst") if os.path.exists(os.path.join(d, f)))
            self._mt = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=os.path.join(d, "model.onnx"), lexicon=lexicon(d),
                    tokens=os.path.join(d, "tokens.txt"), dict_dir=os.path.join(d, "dict")), num_threads=4),   # 8 threads oversubscribed the capped CPU with WeNet + DUIX + brain (a clause took 23 s)
                rule_fsts=fst, max_num_sentences=1))
        return self._mt

    def _world_pool(self):
        """3 threads for the WORLD pass (pyworld uses one core and releases the GIL; the voice is cut in its pauses and done in parallel)."""
        if getattr(self, "_wpool", None) is None:
            self._wpool = False
            try:
                from concurrent.futures import ThreadPoolExecutor    # pyworld releases the GIL: threads run on 3 cores,
                self._wpool = ThreadPoolExecutor(int(os.environ.get("GF_WORLD_THREADS", "2")), thread_name_prefix="world")   # no extra RAM
            except Exception as e:
                print(f"[gf-live] WORLD workers unavailable ({e}): one core", flush=True)
        return self._wpool or None

    def _melo_gpu(self):
        """MeloTTS with its decoder on the Radeon (melo_gpu.py) — None when not installed or after it failed once."""
        if getattr(self, "_mg", None) is None:
            self._mg = False
            try:
                import melo_gpu
                if melo_gpu.available(MELO_DIR):
                    def duix_runner():                     # the decoder runs inside the DUIX runner (one Core ML process)
                        hd = self.duix() if self.renderer != "mobile" else None
                        return getattr(hd, "runner", None)
                    self._mg = melo_gpu.MeloGPU(MELO_DIR, num_threads=int(os.environ.get("GF_MELO_THREADS", "4")), prio=self.gpu_prio,
                                                runner=duix_runner)
                    print("[gf-live] MeloTTS: decoder on the GPU", flush=True)
            except Exception as e:
                print(f"[gf-live] MeloTTS GPU decoder unavailable ({e}), CPU MeloTTS", flush=True)
        return self._mg or None

    def _matcha(self):
        if getattr(self, "_mtc", None) is None:
            import sherpa_onnx
            d = os.path.join(MATCHA_DIR, "matcha-icefall-zh-baker")
            fst = ",".join(os.path.join(d, f) for f in ("phone.fst", "date.fst", "number.fst") if os.path.exists(os.path.join(d, f)))
            self._mtc = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(matcha=sherpa_onnx.OfflineTtsMatchaModelConfig(
                    acoustic_model=os.path.join(d, "model-steps-3.onnx"), vocoder=os.path.join(MATCHA_DIR, "vocos-22khz-univ.onnx"),
                    lexicon=os.path.join(d, "lexicon.txt"), tokens=os.path.join(d, "tokens.txt"), dict_dir=os.path.join(d, "dict")),
                    num_threads=4),
                rule_fsts=fst, max_num_sentences=1))
        return self._mtc

    def synth(self, text, pace=1.0, emo=None):
        """-> (float32 audio, sample_rate). Kokoro by default; Qwen3-TTS CustomVoice (GF_VOICE=qwen: fixed timbre +
        mood instruction per sentence) or Qwen3-TTS clone (GF_VOICE=clone); macOS say last."""
        mode = self.voice.get("engine", "kokoro")
        style = os.environ.get("GF_VOICE_STYLE") or self.voice.get("style") or ("mandarin" if mode == "matcha" else VOICE_STYLE)
        if style in VOICE_STYLES and (mode == "breeze2" and os.path.exists(os.path.join(BREEZE2_DIR, "breeze2-vits.onnx"))
                                      or mode == "matcha" and os.path.exists(os.path.join(MATCHA_DIR, "vocos-22khz-univ.onnx"))):
            try:
                st = VOICE_STYLES[style]; k = st["rate"] / 22050.0
                t2 = text.replace("～", "，").replace("~", "，")
                if mode == "matcha": t2 = t2.replace("欸", "哎").replace("诶", "哎")
                tts = self._breeze2() if mode == "breeze2" else self._matcha()
                a = tts.generate(t2, sid=0, speed=st["speed"] * float(self.voice.get("speed", 1.0)) * pace / k)   # said slower,
                x = np.asarray(a.samples, dtype=np.float32)                                                     # read faster
                if not len(x): raise RuntimeError("no audio")
                x, sr = bl_resample(x, int(round(a.sample_rate * k)), 24000), 24000
                self._phones = None; self._plain = (x.copy(), sr)                       # the mouth: the same timing, no EQ
                from sweet import soften
                x = soften(x, sr, **st["eq"])
                pk = float(np.abs(x).max())
                if pk > 1e-4: x = x * min(8.0, 0.7 / pk)
                return x, sr
            except Exception as e:
                print(f"[gf-live] voice style {style} failed ({e}), the old path", flush=True)
        if mode == "breeze2" and os.path.exists(os.path.join(BREEZE2_DIR, "breeze2-vits.onnx")):
            try:
                # as the user heard it (candidate 3): her own voice, no sweetening; ～ is a pause, digits / dates through
                # Melo's text normalisers (Breeze2 has none of its own)
                t2 = text.replace("～", "，").replace("~", "，")
                P = BREEZE_SWEET.get(int(os.environ.get("GF_BREEZE_SWEET", self.voice.get("bsweet", 3))))   # 强 (user 10-21)
                a = self._breeze2().generate(t2, sid=0, speed=(P["speed"] if P else 1.0) * float(self.voice.get("speed", 1.0)) * pace)
                x, sr = np.asarray(a.samples, dtype=np.float32), a.sample_rate          # 22.05 kHz
                if not len(x): raise RuntimeError("no audio")
                if sr != 24000: x, sr = bl_resample(x, sr, 24000), 24000
                self._phones = None; self._plain = (x.copy(), sr)                       # the mouth: her unshifted voice
                if P:                                                                    # 更细、更温柔、更甜 (BREEZE_SWEET)
                    try:
                        from sweet import sweeten_parallel
                        x = sweeten_parallel(x, sr, P["pitch"], P["formant"], P["breath"], pool=self._world_pool(),
                                             range_k=P["range_k"], bright=P["bright"], low=P["low"])
                    except Exception as e:
                        print(f"[gf-live] sweeten unavailable ({e}), plain Breeze2", flush=True)
                pk = float(np.abs(x).max())
                if pk > 1e-4: x = x * min(8.0, 0.7 / pk)
                return x, sr
            except Exception as e:
                print(f"[gf-live] Breeze2 failed, using MeloTTS: {e}", flush=True)
                mode = "melo"
        if mode == "matcha" and os.path.exists(os.path.join(MATCHA_DIR, "vocos-22khz-univ.onnx")):
            try:
                speed, pitch, formant, breath = SWEET.get(int(self.voice.get("sweet", 3)), SWEET[3])
                pitch, formant, breath = (float(os.environ.get(f"GF_SWEET_{k}", v)) for k, v in
                                          (("PITCH", pitch), ("FORMANT", formant), ("BREATH", breath)))
                t2 = text.replace("欸", "哎").replace("诶", "哎").replace("～", "，")
                a = self._matcha().generate(t2, sid=0, speed=speed * float(self.voice.get("speed", 1.0)) * pace)
                x, sr = np.asarray(a.samples, dtype=np.float32), a.sample_rate          # 22.05 kHz
                try:
                    from sweet import sweeten
                    x = sweeten(x, sr, pitch, formant, breath)
                except Exception as e:
                    print(f"[gf-live] sweeten unavailable ({e}), plain Matcha", flush=True)
                pk = float(np.abs(x).max()) if len(x) else 0.0
                if pk > 1e-4: x = x * min(8.0, 0.7 / pk)
                return x, sr
            except Exception as e:
                print(f"[gf-live] Matcha failed, using MeloTTS: {e}", flush=True)
                mode = "melo"
        if mode == "melo":
            try:
                speed, pitch, formant, breath = SWEET.get(int(self.voice.get("sweet", 3)), SWEET[3])
                pitch, formant, breath = (float(os.environ.get(f"GF_SWEET_{k}", v)) for k, v in
                                          (("PITCH", pitch), ("FORMANT", formant), ("BREATH", breath)))
                # MeloTTS can't voice 欸 / 诶 (silent) and drops ～ — her replies often open with them
                t2 = text.replace("欸", "哎").replace("诶", "哎").replace("～", "，")
                sp = speed * float(self.voice.get("speed", 1.0)) * pace; x = None
                mg = self._melo_gpu(); self._phones = None
                if mg is not None:
                    try: x, sr = mg.generate(t2, speed=sp); self._phones = getattr(mg, "last_phones", None)
                    except Exception as e:
                        print(f"[gf-live] MeloTTS GPU decoder failed ({e}), CPU MeloTTS from now on", flush=True); self._mg = False
                if x is None:
                    a = self._melo().generate(t2, sid=0, speed=sp)
                    x, sr = np.asarray(a.samples, dtype=np.float32), a.sample_rate
                # 10-20 real time: MeloTTS speaks at 44.1 kHz; the WORLD pass below costs ~2.2× less at 24 kHz
                # (1.5 s → 0.7 s for a 3 s line on this Mac) and her voice has nothing above 12 kHz anyway
                if sr > 24000: x, sr = bl_resample(x, sr, 24000), 24000
                self._plain = (x.copy(), sr)        # her voice before the sweetening: what DUIX's mouth is driven by (below)
                try:
                    from sweet import sweeten_parallel
                    pros = sweet_prosody(t2, getattr(self, "_phones", None), self.voice)
                    x = sweeten_parallel(x, sr, pitch, formant, breath, pool=self._world_pool(), **pros["world"])
                except Exception as e:
                    print(f"[gf-live] sweeten unavailable ({e}), plain MeloTTS", flush=True)
                pk = float(np.abs(x).max()) if len(x) else 0.0       # MeloTTS is quiet (peak ~0.1): bring it to ~0.7
                if pk > 1e-4: x = x * min(8.0, 0.7 / pk)
                return x, sr
            except Exception as e:
                print(f"[gf-live] MeloTTS failed, using the designed voice: {e}", flush=True)
                mode = "qwenclone"
        if mode == "omnivoice":
            # the Douyin repo's voice engine (OmniVoice clone of a reference clip), fast mode by default; slow on Intel
            # Macs, so meant for HD reply mode (she waits, then speaks with the DUIX face)
            try:
                ensure_omni()
                body = {"input": text, "mode": self.voice.get("omni_mode", "fast"), "speed": float(self.voice.get("speed", 1.0)) * pace}
                if self.voice.get("ref"): body.update(ref=self.voice["ref"], ref_text=self.voice.get("ref_text", ""))
                else: body["voice"] = self.voice.get("clone_voice") or os.environ.get("GF_CLONE_VOICE", "tianmei")
                return _qtts_pcm(OMNI_URL, body, timeout=1800), 24000
            except Exception as e:
                print(f"[gf-live] OmniVoice failed, using the designed voice: {e}", flush=True)
                mode = "qwenclone"
        if mode == "qwenclone":
            # her designed voice (Qwen3-TTS Base 0.6B, ICL clone of a VoiceDesign reference): no instruction (Base takes
            # none) — the mood comes from a per-mood reference when one exists; lower temperature = steadier, less "AI" wobble
            # user 10-19: only her own voice — never Kokoro or the macOS voice. One retry (the server may still be
            # starting / may have died), then silence: the reply text still shows in the chat window.
            for attempt in (1, 2):
                try:
                    ensure_qtts(QCLONE_URL, os.environ.get("GF_QCLONE_MODEL", "models/qwen-talker-0.6b-base-Q4_K_M.gguf"))
                    vid = clone_voice(self.voice.get("clone_voice") or os.environ.get("GF_CLONE_VOICE", "wenrou"), emo)
                    a = _qtts_pcm(QCLONE_URL, {"input": text, "voice": vid, "language": "Chinese",
                                               "temperature": float(self.voice.get("temperature", 0.7)), "top_p": 0.9})
                    return tempo(a, 24000, float(self.voice.get("speed", 1.0))), 24000
                except Exception as e:
                    print(f"[gf-live] designed voice failed (try {attempt}): {e}", flush=True)
                    if attempt == 1:
                        _cloned.pop(QCLONE_URL, None)
                        pr = _qtts.pop(QCLONE_URL, None)
                        if pr is not None and pr.poll() is not None: pass                      # dead: ensure_qtts starts a new one
                        elif pr is not None: _qtts[QCLONE_URL] = pr                           # alive but slow: keep waiting on it
            return np.zeros(int(24000 * 0.3), np.float32), 24000
        if mode == "qwencpp":
            # qwentts.cpp tts-server (C++/GGML port of Qwen3-TTS CustomVoice, OpenAI-compatible): same mood → tone
            # instruction as the PyTorch path, ~4x faster; real time on Apple Silicon (Metal), not on a hot Intel Mac.
            try:
                from tts_qwen import MOOD_INSTRUCT
                ensure_qtts()
                a = _qtts_pcm(QTTS_URL, {"input": text, "voice": self.voice.get("qwen_speaker") or os.environ.get("GF_TTS_SPEAKER", "serena").lower(),
                                         "language": "Chinese", "instructions": MOOD_INSTRUCT.get(emo or "温柔", MOOD_INSTRUCT["温柔"])})
                a = tempo(a, 24000, float(self.voice.get("speed", 1.0)))
                return (warm_voice(a, 24000, g_hi=-4.0) if os.environ.get("GF_WARM", "1") != "0" else a), 24000
            except Exception as e:
                print(f"[gf-live] qwentts.cpp failed, using Kokoro: {e}", flush=True)
                mode = "kokoro"
        if mode == "qwen":
            try:
                if getattr(self, "_qcv", None) is None:
                    from tts_qwen import QwenCustomVoice
                    self._qcv = QwenCustomVoice(self.voice.get("qwen_speaker"))
                return self._qcv.say(text, emo)
            except Exception as e:
                print(f"[gf-live] Qwen3-TTS CustomVoice failed, using Kokoro: {e}", flush=True)
                mode = "kokoro"
        if mode == "clone" and self.voice.get("ref"):
            try:
                if self.tts is None:
                    from tts_qwen import QwenVoice
                    self.tts = QwenVoice(self.voice["ref"], self.voice.get("ref_text", ""))
                return self.tts.say(text), 16000
            except Exception as e:
                print(f"[gf-live] Qwen3-TTS failed, using Kokoro: {e}", flush=True)
        if mode in ("kokoro", "clone") and os.path.exists(os.path.join(KOKORO_DIR, "model.onnx")):
            try:
                a = self._kokoro().generate(text, sid=int(self.voice.get("speaker", KOKORO_SPEAKER)),
                                            speed=float(self.voice.get("speed", 1.0)) * pace)
                return np.asarray(a.samples, dtype=np.float32), a.sample_rate
            except Exception as e:
                print(f"[gf-live] Kokoro failed, using say: {e}", flush=True)
        w, _ = L.say_wav(text, os.environ.get("GF_SAY_VOICE", "Tingting"))
        return w, 16000

    def speak(self, text, emo=None):
        t = time.time(); self._plain = None; self._phones = None
        wav, sr = self.synth(text, EMOS.get(emo, 1.0), emo)
        t_tts = time.time() - t
        # a little air before/after so the mouth opens and closes with the sound, not on the frame edge
        pad = np.zeros(int(sr * 0.06), np.float32)
        # 10-21 (user: "嘴形很扭曲、很奇怪"): the mouth is driven by her voice BEFORE the sweetening (pitch ×1.2, formants ×1.06):
        # DUIX's WeNet features were trained on ordinary speech and read the shifted voice less clearly. Same timing (WORLD keeps
        # the duration), so lips and sound still line up to the sample.
        pl = getattr(self, "_plain", None)
        base_drive = wav
        if pl is not None and pl[1] == sr and abs(len(pl[0]) - len(wav)) <= sr // 50:
            base_drive = np.pad(pl[0], (0, max(0, len(wav) - len(pl[0]))))[:len(wav)]
            base_drive = base_drive * (float(np.abs(wav).max()) / max(1e-6, float(np.abs(base_drive).max())))
        wav = np.concatenate([pad, wav, pad * 2])
        drive = np.concatenate([pad, base_drive.astype(np.float32), pad * 2])
        lead_s = len(pad) / sr                             # her phoneme timeline (MeloTTS) moves with what goes before her voice
        if self.voice.get("engine") in ("qwencpp", "qwen", "qwenclone", "melo") and os.environ.get("GF_A2", "1") != "0" and np.abs(wav).max() > 0.01:
            # A2 (user 10-18 "更像真人"): a soft breath before about half the sentences + a touch of room.
            # The breath is only in what she SAYS (play); the mouth is driven by the speech alone (drive), lips stay still on the inhale.
            if _rng.random() < 0.55:
                b = breath_noise(sr, 0.035 * float(np.sqrt((wav ** 2).mean())) / 0.05)
                lead = np.concatenate([b, np.zeros(int(sr * 0.06), np.float32)])
                wav = np.concatenate([lead, wav]); drive = np.concatenate([np.zeros_like(lead), drive]); lead_s += len(lead) / sr
            wav = small_room(wav, sr)
        meta = self._register(wav, sr, drive, sr)
        ph = getattr(self, "_phones", None)
        if ph and meta.get("id") in self.utts:
            self.utts[meta["id"]]["phones"] = [(a + lead_s, b + lead_s, sy, tn) for a, b, sy, tn in ph]
        meta.update({"tts_s": round(t_tts, 2), "text": text, "emo": emo})
        return meta

    def _register(self, play, play_sr, drive, drive_sr, alpha=None):
        """One utterance: `play` is what the page hears, `drive` is what shapes the mouth (usually the same audio)."""
        uid = uuid.uuid4().hex[:10]
        path = os.path.join(self.audio_dir, uid + ".wav")
        pcm = (np.clip(play, -1, 1) * 32767).astype(np.int16)
        with wave.open(path, "wb") as f:                  # playback keeps the TTS's own rate (24 kHz for Kokoro)
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(play_sr); f.writeframes(pcm.tobytes())
        w16 = drive if drive_sr == L.SR else resample(drive, drive_sr, L.SR)
        fps = self.avatar.fps if self.avatar else 25.0
        mel = L.melspectrogram(w16)
        n = int(len(w16) / L.SR * fps) + 1
        step = 80.0 / fps
        chunks = []
        for i in range(n):
            s0 = int(i * step)
            chunks.append(mel[:, -16:] if s0 + 16 > mel.shape[1] else mel[:, s0:s0 + 16])
        self.utts[uid] = {"path": path, "chunks": chunks, "t": time.time(), "alpha": alpha, "w16": w16}
        if self.mobile_mode and self.hd is not None:     # real-time DUIX: her audio features start now, not when the page asks
            u = self.utts[uid]
            def _win(u=u, hd=self.hd):
                try: u["duix_win"] = hd.windows(u["w16"])
                except Exception as e: print(f"[gf-live] DUIX audio features failed: {e}", flush=True)
                finally: u["win_ready"].set()
            u["win_ready"] = threading.Event(); threading.Thread(target=_win, daemon=True).start()
        for k in [k for k, u in self.utts.items() if time.time() - u["t"] > 600]:
            self.utts.pop(k, None)
        meta = {"id": uid, "frames": n, "fps": fps, "duration": len(w16) / L.SR, "text": "", "gen_fps": round(self.gen_fps, 1)}
        if self.hd_on():                                  # HD reply mode: the page waits for every DUIX patch, then speaks
            meta.update({"hd": True, "hd_k0": HD_K0, "gen_fps": round(self.hd.fps, 1)})
        return meta

    def _runner_died(self):
        """The lip-sync runner exited: start a new one and give it the avatar again (≤ 3 times in 10 min)."""
        if self.mobile_mode: return
        now = time.time(); self._runner_restarts = [t for t in self._runner_restarts if now - t < 600] + [now]
        if len(self._runner_restarts) > 3:
            print("[gf-live] lip-sync runner keeps exiting — not restarting it again", flush=True); return
        time.sleep(2)
        print("[gf-live] restarting the lip-sync runner", flush=True)
        self.runner = Runner(on_exit=self._runner_died)
        av = self.avatar
        if av:
            try: self.avatar = Avatar(av.paths, self.runner)
            except Exception as e: print(f"[gf-live] avatar reload failed: {e}", flush=True)

    # ── instant reactions ──
    def duix(self):
        """DuixHD whether or not HD replies are on (the instant reactions always use DUIX mouths)."""
        if self.hd is None:
            try:
                with self.hd_mk:                     # /avatar and the reactions thread both get here at start: one runner
                    if self.hd is None: self.hd = self._make_duix()
                if self.hd is None: return None
            except Exception as e:
                print(f"[gf-live] DUIX unavailable: {e}", flush=True); return None
        return self.hd

    # ── 流式数字人 (beiyege-01/dsh-voice-ai-girlfriend §八, user 10-21: "严格按照一样的步骤") ──
    def dh_avatar(self):
        """her avatar video for face2face (my_avatar.mp4 next to her idle clips: a talking video of her, 1080p 15 fps)"""
        if not self.avatar: return None
        p = os.path.join(os.path.dirname(self.avatar.paths[0]), "my_avatar.mp4")
        return p if os.path.exists(p) else None

    def dh(self):
        """the face2face renderer for her avatar (DHVideo), or None"""
        av = self.dh_avatar()
        if av is None: return None
        if getattr(self, "_dhv", None) is None or self._dhv.path != av:
            hd = self.duix()
            if hd is None: return None
            from duix.dh_video import DHVideo
            t = time.time(); self._dhv = DHVideo(hd, av, prio=self.gpu_prio)
            print(f"[gf-live] 数字人: avatar {os.path.basename(av)} ready ({self._dhv.n} frames {self._dhv.w}x{self._dhv.h}"
                  f" @ {self._dhv.fps:g} fps) in {time.time() - t:.1f}s", flush=True)
            try: self._dhv.warm()
            except Exception as e: print(f"[gf-live] 数字人 warm-up failed: {e}", flush=True)
        return self._dhv

    def dh_gestures(self):
        """her gestures that can open a reply (10-21, user: "所有那些动作…如果需要回复也能一样的出现口型匹配"): manifest clips
        with a "dh" file — the gesture at the avatar's size / fps, sealed from her idle onto the avatar's frame 0. Loaded and
        warmed in the background, a few frames at a time and only while no reply is rendering (they share the Radeon).
        → {name: DHVideo} of the warm ones"""
        g = getattr(self, "_dhg", None)
        if g is None:
            g = self._dhg = {"ready": {}, "started": False}
        if not g["started"] and self.avatar:
            g["started"] = True
            threading.Thread(target=self._warm_gestures, daemon=True).start()
        return g["ready"]

    def _warm_gestures(self):
        try:
            d = os.path.dirname(self.avatar.paths[0])
            man = json.load(open(os.path.join(d, "manifest.json")))
            dv = self.dh()
            if dv is None: return
            from duix.dh_video import DHVideo, DHStream
            for fname, m in (man.get("clips") or {}).items():
                if not (isinstance(m, dict) and m.get("dh")): continue
                p = os.path.join(d, m["dh"])
                if not os.path.exists(p): continue
                t = time.time(); gv = DHVideo(self.duix(), p, prio=self.gpu_prio)
                if (gv.w, gv.h) != (dv.w, dv.h) or abs(gv.fps - dv.fps) > 0.01:
                    print(f"[gf-live] 数字人 gesture {fname}: {gv.w}x{gv.h}@{gv.fps:g} ≠ the avatar's — skipped", flush=True); continue
                gv.plain = {k for a, b in (m.get("dhPlain") or []) for k in range(int(a), int(b) + 1)}
                gv.meta = {"name": os.path.splitext(fname)[0], "impact": float(m.get("impact") or 0)}
                gv.warm(chunk=6, busy=lambda: DHStream.rendering > 0)
                self._dhg["ready"][gv.meta["name"]] = gv
                print(f"[gf-live] 数字人 gesture {fname} ready ({gv.n} frames, {len(gv.plain)} plain) in {time.time() - t:.1f}s", flush=True)
        except Exception as e:
            print(f"[gf-live] 数字人 gestures: {type(e).__name__}: {e}", flush=True)
        finally:
            WARM["gestures"] = True                         # warmed, or as warm as they get (a broken clip is skipped)

    def prepare_fillers(self):
        """Render the instant reactions for the current avatar + voice: each interjection in her voice, with DUIX mouths
        on the 开心 clip from frame HD_K0, every other frame (the page holds each for two). Background, once per voice."""
        av, hd = self.avatar, self.duix()
        if not av or hd is None or getattr(self, "_fill_busy", False): return
        voice = self.voice.get("clone_voice"), self.voice.get("engine"), float(self.voice.get("speed", 1.0)), self.voice.get("sweet")
        if getattr(self, "fillers", None) and getattr(self, "_fill_key", None) == (voice, tuple(av.paths)):
            return                                                  # already rendered for this voice + these clips
        self._fill_busy = True
        try:
            # every mood clip gets its own mouths (she reacts on whichever clip she is on — switching clips first cost
            # up to a whole clip's length, 10-20 demo turn 3); 开心 first so reactions work as soon as possible
            talks = [i for i, p in enumerate(av.paths) if os.path.basename(p).startswith("talk_")] or [0]
            talks.sort(key=lambda i: 0 if "kaixin" in os.path.basename(av.paths[i]) else 1)
            out = []; t = time.time()
            for text in FILLERS:                                   # 1) her voice for each reaction
                try:
                    wav, sr = self.synth(text, 1.0, "开心")
                    if np.abs(wav).max() < 0.01: continue
                    pad = np.zeros(int(sr * 0.06), np.float32); wav = np.concatenate([pad, wav, pad * 2])
                    w16 = wav if sr == L.SR else resample(wav, sr, L.SR)
                    out.append({"text": text, "wav": wav, "sr": sr, "w16": w16, "frames": int(len(w16) / L.SR * av.fps) + 1,
                                "win": hd.windows(w16), "patches": {}})
                except Exception as e:
                    print(f"[gf-live] reaction {text!r} failed: {e}", flush=True)
            self.fillers, self._fill_voice, self._fill_key = out, voice, (voice, tuple(av.paths))
            for bi, ci in enumerate(talks):                        # 2) DUIX mouths, clip by clip
                lo, span = av.ranges[ci]; clip = hd.clip(av.paths[ci])
                for f in out:
                    pats = []
                    for j in range(0, f["frames"], 2):
                        a = min(len(f["win"]) - 1, int(round(j * 25.0 / av.fps)))
                        (x, y, w, h), jpg = hd.finish(hd.submit(clip, (HD_K0 + j) % min(span, clip.n), f["win"][a]))
                        pats.append((j, x, y, w, h, jpg))
                    f["patches"][lo] = pats
                if bi == 0: print(f"[gf-live] {len(out)} instant reactions ready in {time.time() - t:.0f}s", flush=True)
            print(f"[gf-live] instant reactions on all {len(talks)} mood clips in {time.time() - t:.0f}s", flush=True)
        finally:
            self._fill_busy = False
        self.hd_warm(talks)

    def hd_warm(self, talks):
        """Fast DUIX (10-20): the per-base-frame half of every mood clip, computed once and kept on disk, so each spoken frame
        only runs the small decoder. 8 frames at a time under hd_lock — a reply that comes in waits at most one chunk."""
        hd, av = self.hd, self.avatar
        if not (hd and av and hd.split) or getattr(self, "_warm_busy", False): return
        self._warm_busy = True; t = time.time(); n = 0
        try:
            for ci in talks:
                clip = hd.clip(av.paths[ci])
                for k in range(0, clip.n, 8):
                    with self.hd_lock: n += hd.warm(clip, range(k, k + 8))
            if n: print(f"[gf-live] fast DUIX ready on {len(talks)} mood clips ({n} frames) in {time.time() - t:.0f}s", flush=True)
        except Exception as e:
            print(f"[gf-live] fast DUIX warm-up failed: {e}", flush=True)
        finally:
            self._warm_busy = False

    def filler_utt(self, prefer=None):
        """→ utt meta for one pre-rendered reaction (never the same twice in a row), or None if not ready / voice changed.
        prefer: a substring to pick by (the second, "thinking" reaction)."""
        F = getattr(self, "fillers", None)
        voice = self.voice.get("clone_voice"), self.voice.get("engine"), float(self.voice.get("speed", 1.0)), self.voice.get("sweet")
        if not F or getattr(self, "_fill_voice", None) != voice or not self.avatar:
            if self.avatar: threading.Thread(target=self.prepare_fillers, daemon=True).start()
            return None
        F = [f for f in F if f["patches"]]                                  # mouths rendered for at least one clip
        if not F: return None
        pick = ([f for f in F if prefer in f["text"]] if prefer else []) or \
               [f for f in F if f["text"] != getattr(self, "_last_fill", None) and "想" not in f["text"]] or F
        f = pick[int(_rng.integers(len(pick)))]; self._last_fill = f["text"]
        uid = uuid.uuid4().hex[:10]; path = os.path.join(self.audio_dir, uid + ".wav")
        with wave.open(path, "wb") as fh:
            fh.setnchannels(1); fh.setsampwidth(2); fh.setframerate(f["sr"])
            fh.writeframes((np.clip(f["wav"], -1, 1) * 32767).astype(np.int16).tobytes())
        self.utts[uid] = {"path": path, "chunks": [], "t": time.time(), "w16": f["w16"], "filler": f}
        return {"id": uid, "frames": f["frames"], "fps": self.avatar.fps, "duration": len(f["w16"]) / L.SR, "text": f["text"],
                "hd": True, "hd_k0": HD_K0, "emo": "开心", "filler": True, "filler_los": sorted(f["patches"]),
                "gen_fps": round(self.hd.fps, 1) if self.hd else 0}

    # ── HD reply mode (DUIX) ──
    def _make_duix(self):
        """Real-time DUIX (duix_mobile, CPU) when installed, else the big DUIX model (DINetV1 on the GPU), else None."""
        if self.renderer == "mobile":
            from duix.duix_mobile import DuixMobile
            return DuixMobile()
        from duix.duix_hd import DuixHD, available
        return DuixHD() if available() else None

    def hd_on(self):
        if self.mobile_mode: self.voice["hd"] = True        # real-time DUIX: every sentence, always (nothing to turn off)
        if not self.voice.get("hd"):
            return False
        if self.hd is None:
            try:
                with self.hd_mk:
                    if self.hd is None: self.hd = self._make_duix()
                if self.hd is None:
                    print("[gf-live] HD mode: DUIX models not installed", flush=True); self.voice["hd"] = False; return False
            except Exception as e:
                print(f"[gf-live] HD mode unavailable: {e}", flush=True); self.voice["hd"] = False; return False
        return True

    def hd_prepare(self):
        """Face-track every clip of the current avatar for DUIX (once per clip, cached on disk) — in the background."""
        if not (self.avatar and self.hd_on()): return
        for p in self.avatar.paths:
            try: self.hd.clip(p)
            except Exception as e: print(f"[gf-live] DUIX prepare {os.path.basename(p)} failed: {e}", flush=True)

    # ── blow ──
    # 用户 10-18:不要手势了,只保留静止 + 口型;每条 agent 日志由她「吹一口气」吐出来。
    # 嘴型由一个圆唇的「呼」驱动(wav2lip 只看声音:u 元音 = 嘴唇收圆往前嘟),但页面听到的不是一个字,
    # 是一口轻轻的气声(带通噪声 + 呼气包络)。第一次算好就缓存,之后每次吹气零延迟。
    def blow(self):
        if getattr(self, "_blow", None) is None or self._blow[3] != (self.avatar and self.avatar.fps):
            u, sr = self.synth("呼～")
            a = np.abs(u); thr = a.max() * 0.05
            nz = np.nonzero(a > thr)[0]
            u = u[max(0, nz[0] - int(sr * 0.02)): nz[-1] + int(sr * 0.04)] if len(nz) else u
            n = len(u)
            rng = np.random.default_rng(3)
            spec = np.fft.rfft(rng.standard_normal(n + sr // 2).astype(np.float32))
            f = np.fft.rfftfreq(n + sr // 2, 1 / sr)
            spec *= np.exp(-((np.log(np.maximum(f, 1)) - np.log(900)) ** 2) / (2 * 0.75 ** 2))   # soft breath band ~300–2.7 kHz
            noise = np.fft.irfft(spec)[:n].astype(np.float32)
            t = np.arange(n) / sr; dur = n / sr
            env = np.minimum(1, t / 0.07) * np.clip((dur - t) / 0.30, 0, 1) ** 1.5      # quick in, long soft out
            breath = noise / (np.abs(noise).max() + 1e-6) * env * 0.16
            pad = np.zeros(int(sr * 0.06), np.float32)
            drive = np.concatenate([pad, u, pad * 2]); play = np.concatenate([pad, breath, pad * 2])
            # the frame where the lips are roundest = loudest stretch of the "u"
            w = int(sr / (self.avatar.fps if self.avatar else 25.0))
            e = np.array([np.abs(drive[i:i + w]).mean() for i in range(0, len(drive) - w, w)])
            peak = int(np.argmax(np.convolve(e, np.ones(3) / 3, mode="same"))) if len(e) else 0
            self._blow = (play, drive, sr, self.avatar and self.avatar.fps, peak)
        play, drive, sr, _, peak = self._blow
        meta = self._register(play, sr, drive, sr, alpha=max(ALPHA, 2.4))
        meta.update({"blow": True, "peak": peak})
        if self.mobile_mode: meta["hd"] = False      # a breath stays on the clip she is on (the patches are DUIX either way)
        return meta

    # ── mouth ──
    def header(self, uid, j, base):
        x1, y1, x2, y2 = self.avatar.boxes[base]
        return struct.pack("<4sIIhhhh", b"GFP1", int(uid, 16) & 0xFFFFFFFF, j, x1, y1, x2 - x1, y2 - y1)


PARTICLES = set("呀啦嘛哦呢吧啊哟嘞呗嘛哇喔噢嗯哈吗")


def sweet_prosody(text, phones, voice):
    """The voice's melody and colour for one line (10-21, user: "melo 的声音…不够自然、不够嗲、不够甜美"): a livelier pitch range
    around her own median, sharper (ringing) formants, a brighter top, and — from MeloTTS's phoneme timeline — her last syllable
    curling up a little (more on a sentence-final particle: 呀 啦 嘛 哦 呢 吧 …, the 撒娇 ending; none on a falling tone 4,
    which would turn into a question). The drawn-out ending itself is the model's (model_zp's phrase-final lengthening, the
    particles in tone 1: melo_gpu.lexicon). GF_SWEET_RANGE / _RISE / _SOFT / _BRIGHT tune it."""
    lvl = int(voice.get("sweet", 3)); env = os.environ.get
    rk = float(env("GF_SWEET_RANGE", {1: "1.15", 2: "1.25", 3: "1.35"}.get(lvl, "1.35")))
    out = {"world": {"range_k": rk, "soft": float(env("GF_SWEET_SOFT", "-0.3" if lvl >= 3 else "0")),
                     "bright": float(env("GF_SWEET_BRIGHT", "2.0" if lvl >= 3 else "1.0"))}}
    pause = ("_", ",", ".", "?", "!", "…", "SP", "'", "-")
    k = max((i for i, p in enumerate(phones or []) if p[2] not in pause), default=-1)
    if k < 1: return out
    last_chr = next((c for c in reversed(text) if "\u4e00" <= c <= "\u9fff"), "")
    part = last_chr in PARTICLES; tone = phones[k][3]
    up = float(env("GF_SWEET_RISE", "3.0" if part else ("0" if tone == 4 else "1.5")))
    if up > 0:                                            # the last final, through the blank / punctuation after it
        out["world"]["rise"] = (phones[k][0], min(phones[-1][1], phones[k][1] + 0.4), up)
    return out


def pack_patch(uid, j, box, img):
    """one mouth patch on the wire. GFP1: integer box (JPEG / WebP). GFP2 (10-21): her own lips on their frame's own pixel grid
    — sub-pixel position (float x, y, frame 0's coordinates), alpha complete: the page draws it once, as is"""
    x, y, w, h = box
    if isinstance(x, float):
        return struct.pack("<4sIIffhh", b"GFP2", int(uid, 16) & 0xFFFFFFFF, j, x, y, int(w), int(h)) + img
    return struct.pack("<4sIIhhhh", b"GFP1", int(uid, 16) & 0xFFFFFFFF, j, x, y, w, h) + img


def bl_resample(x, sr_in, sr_out):
    """Band-limited (FFT) resample, for audio she plays: no aliasing, no scipy. The input is zero-padded to a length whose
    FFT is fast (10-21: an arbitrary clause length can have a large prime factor — 0.4 s under the CPU cap for 2.6 s)"""
    if sr_in == sr_out or not len(x): return x
    from math import gcd
    g = gcd(int(sr_in), int(sr_out)); a, b = int(sr_in) // g, int(sr_out) // g          # 44100 → 24000: 147 → 80
    m = 1
    while a * m < len(x): m *= 2                                                         # padded length = a·2^j (2, 3, 7 only)
    n_in, n_out = a * m, b * m
    X = np.fft.rfft(np.asarray(x, np.float32), n_in); k = n_out // 2 + 1
    Y = np.zeros(k, np.complex64); mm = min(k, len(X)); Y[:mm] = X[:mm]
    y = np.fft.irfft(Y, n_out) * (n_out / n_in)
    return y[:max(1, int(round(len(x) * sr_out / sr_in)))].astype(np.float32)


def resample(x, sr_in, sr_out):
    """Linear resample — only feeds the mel features (playback keeps the TTS's own rate), so no need for torch."""
    n = int(round(len(x) * sr_out / sr_in))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


# ── sentences: the unit of streaming (LLM -> TTS -> lip-sync), like the tutorial's speech-to-speech pipeline ──
_ENDS = set("。！？!?；;\n…")
_ACTION = ("[nod]", "[wave]", "[think]", "[point]", "[none]")


def clean_text(t):
    import re
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.S)
    t = re.sub(r"</?answer>", "", t)                                  # Hunyuan wraps its reply in <answer>…</answer>
    t = re.sub(r"（[^）]{0,40}）|\([^)]{0,40}\)", "", t)              # （歪着头，耳尖微红） stage directions are not spoken
    t = re.sub(r"\[(nod|wave|think|point|none)\]", "", t, flags=re.I)
    t = re.sub(r"\[[^\]]{1,24}\]|［[^］]{1,24}］", "", t)                     # [扑进你怀里蹭蹭] actions are not spoken (10-21)
    t = re.sub(r"[【\[]\s*[\u4e00-\u9fff]{1,4}\s*[】\]]", "", t)       # 【撒娇】 emotion tags (spoken without them)
    t = re.sub(r"[*#`_~>]", "", t)
    t = re.sub(r"[\U0001F300-\U0001FAFF☀-➿]", "", t)          # emoji would be read out loud
    return t.strip()


class Splitter:
    """Feed streamed tokens, get complete sentences (merges fragments shorter than 6 chars into the next).
    The very first piece of a turn may end at a comma (≥ 4 chars): she starts talking one clause earlier."""

    def __init__(self, clauses=False):
        self.buf = ""
        self.first = True
        self.clauses = clauses        # qwencpp voice: every comma ends a piece (she speaks clause 1 while clause 2 renders)

    def feed(self, tok):
        self.buf += tok
        out = []
        if "<think>" in self.buf and "</think>" not in self.buf:
            return out
        i = 0
        while i < len(self.buf):
            head = self.buf[:i]
            if head.count("（") > head.count("）") or head.count("(") > head.count(")"):    # inside a stage direction
                i += 1; continue
            # first piece: any comma after ≥ 4 chars (user 10-19 "real time": the first clause is what she waits on —
            # brain + voice are CPU-bound here, a 4-char clause is ~1 s of speech instead of ~3)
            # ～ / … count as soft commas (Hunyuan writes 「啦～人家…」: a 10-20 first piece ran to 19 chars without one)
            if (self.first or self.clauses) and self.buf[i] in "，,、～~…" and len(clean_text(self.buf[:i + 1])) >= (4 if self.first else 6):
                out.append(self.buf[:i + 1]); self.buf = self.buf[i + 1:]; self.first = False; i = 0; continue
            if self.buf[i] in _ENDS:
                j = i + 1
                while j < len(self.buf) and self.buf[j] in _ENDS | set("”’\"' "):
                    j += 1
                piece = self.buf[:j]
                if len(clean_text(piece)) >= 6:
                    out.append(piece); self.buf = self.buf[j:]; self.first = False; i = 0; continue
            i += 1
        # 10-21: no piece longer than ~22 spoken characters — a reply without punctuation (garbled brain) once became ONE
        # 353-char utterance: 125 s of voice + 219 DUIX mouths of work. Cut after a particle when there is one.
        while len(clean_text(self.buf)) > 26 and self.buf.count("（") <= self.buf.count("）"):
            cut = 0
            for k in range(min(len(self.buf), 26), 10, -1):
                if self.buf[k - 1] in "了的呢吧啊呀嘛哦啦呗么": cut = k; break
            cut = cut or 22
            out.append(self.buf[:cut]); self.buf = self.buf[cut:]; self.first = False
        return out

    def flush(self):
        piece = self.buf; self.buf = ""
        return [piece] if clean_text(piece) else []


# 情绪 → (说话速度倍数):撒娇 / 害羞 / 委屈 拖一点慢一点,开心 / 傲娇 快一点。页面按情绪换她的表情底片(talk_*.mp4)。
EMOS = {"温柔": 0.97, "撒娇": 0.9, "傲娇": 1.05, "害羞": 0.92, "开心": 1.07, "委屈": 0.9, "调皮": 1.03}
_EMO_RE = None


def split_emo(raw, last=None):
    """'【撒娇】你都不理我嘛。' -> ('撒娇', '你都不理我嘛。'). No tag: keep the previous sentence's mood."""
    import re
    global _EMO_RE
    if _EMO_RE is None:
        _EMO_RE = re.compile(r"[【\[]\s*(" + "|".join(EMOS) + r")\s*[】\]]")
    m = _EMO_RE.search(raw or "")
    return (m.group(1) if m else last), clean_text(raw)


# settings page (Pro): personality + speaking tone presets; the page sends keys, free text goes in "custom"
PERSONALITIES = {
    "gentle": "你的性格温柔体贴，说话轻声细语，很会照顾人、安慰人。",
    "tsundere": "你的性格傲娇，嘴上不饶人、爱逞强，其实很在乎他，被说中心事就会害羞。",
    "playful": "你的性格活泼调皮，爱开玩笑、爱逗他，元气满满。",
    "clingy": "你的性格黏人爱撒娇，总想要他陪，一会儿不理你就会委屈。",
    "mature": "你的性格知性成熟，温柔但有主见，会认真听他说话，也会给他靠谱的建议。",
}
TONES = {
    "sweet": "说话甜甜的、软软的。",
    "taiwan": "说话是台湾女生的习惯：常用「欸」「齁」「啦」「耶」「蛤」「超～的」「真的假的」，语气软萌（用简体字写）。",
    "energetic": "说话很有精神、很热情，语气上扬。",
    "lazy": "说话慵懒、慢悠悠的，带一点鼻音和气声。",
}


def persona(name, personality=None, tone=None, custom=None):
    # freedidi tutorial step 12: example dialogue beats rules; 2-3 sentences; no markdown/emoji; /no_think
    extra = "".join(x for x in (PERSONALITIES.get(personality or ""), TONES.get(tone or ""), (custom or "").strip()[:400]) if x)
    return (f"你叫{name}，是他的女朋友。你不是AI、不是助手、不是程序。你住在他 Mac 的桌面壁纸里。{extra}\n\n"
            "参考这个语气：\n他：你想我了吗\n你：【撒娇】想啊，怎么不想。【委屈】你倒是一整天没消息，我还以为你把我忘了呢。\n"
            "他：你喜欢我吗\n你：【傲娇】这还用问？【撒娇】你要是不知道，那我可要生气了。\n\n"
            "说话方式：口语、两三句、带语气词（嗯、诶、呀、嘛、哼）、有情绪，情绪要跟着话变：会撒娇、会傲娇、会害羞、会委屈、会调皮。"
            "他用什么语言你就用什么语言回。\n"
            "每句话最前面用【】写这句的情绪，只能是：温柔、撒娇、傲娇、害羞、开心、委屈、调皮。比如：\n"
            "【撒娇】你都一整天不理我了嘛。【委屈】人家等你等得好辛苦。\n"
            "【傲娇】哼，谁想你了，我才没有呢。【害羞】好啦好啦……有一点点想。\n"
            "【开心】你回来啦！今天有没有想我呀？【调皮】你猜我刚才在干嘛～\n"
            "不用 Markdown、列表、编号、表情符号。\n\n/no_think")


def llama_stream(messages, port=LLAMA_PORT, max_tokens=160):
    """Yield content tokens from llama-server's OpenAI-compatible SSE stream."""
    import urllib.request
    body = json.dumps({"messages": messages, "temperature": 1.0, "top_p": 0.95, "max_tokens": min(max_tokens, 90), "stream": True}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        for line in r:
            line = line.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                d = json.loads(data)["choices"][0].get("delta", {})
            except Exception:
                continue
            if d.get("content"):
                yield d["content"]


def prepare(paths):
    """`engine.py --prepare clip.mp4 …`: build the face-crop caches now (setup.sh's last step), so the first live start
    after installing takes ~1 min instead of ~8 (decode + Vision face boxes + crops is the slow part; user 10-19)."""
    t = time.time(); n = 0
    for p in paths:
        av = Avatar.__new__(Avatar)
        c, _ = av._clip_crops(p); n += len(c)
        print(f"[gf-live] prepared {os.path.basename(p)}: {len(c)} frames", flush=True)
    print(f"[gf-live] prepared {len(paths)} clips, {n} frames in {time.time() - t:.0f}s", flush=True)
    if duix_renderer() == "mobile":            # real-time DUIX: her clips in model space (DUIX face tracking, cached on disk)
        try:
            from duix.duix_mobile import DuixMobile
            dm = DuixMobile()
            for p in paths: dm.clip(p)
            return
        except Exception as e:
            print(f"[gf-live] real-time DUIX prepare failed: {e}", flush=True)
    try:                                       # DUIX: face tracking for every clip, fast-DUIX features for the mood clips
        from duix.duix_hd import DuixHD, available
        if available():
            hd = DuixHD()
            for p in paths:
                clip = hd.clip(p)
                if os.path.basename(p).startswith("talk_"):
                    k = hd.warm(clip); print(f"[gf-live] fast DUIX {os.path.basename(p)}: {k} frames", flush=True)
    except Exception as e:
        print(f"[gf-live] DUIX prepare skipped: {e}", flush=True)


def main():
    if "--prepare" in sys.argv:
        prepare([a for a in sys.argv[sys.argv.index("--prepare") + 1:] if not a.startswith("--")]); return
    import uvicorn
    from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, JSONResponse

    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8770
    eng = Engine()
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    subs = set()                         # /events websockets (the wallpaper)
    turn_t0 = {}                         # turn → when its message arrived (timing log)
    spoke = set()                        # turns whose first real sentence has gone out (no more "thinking" reactions)
    gen = {"n": 0}                       # bumps on every new turn / stop: stale sentences are dropped
    tts_q = asyncio.Queue()
    loop_ref = {}

    async def broadcast(ev):
        dead = []
        for ws in list(subs):
            try: await ws.send_text(json.dumps(ev))
            except Exception: dead.append(ws)
        for ws in dead: subs.discard(ws)

    dh_q = asyncio.Queue(); dh_seg = {}               # 流式数字人: rendered segments in order / each turn's segmenter
    DH_SEG = int(os.environ.get("GF_DH_SEGMENT", "48"))
    # 10-21 (user: "as fast as possible … 丝滑 … 不会卡顿"): one reply = one continuous fragmented-MP4 stream (DHStream), the page
    # plays it while the rest renders, from "go" on (never stalls). GF_DH_STREAM=0: the repo's one-file-per-segment flow.
    DH_STREAM = os.environ.get("GF_DH_STREAM", "1") == "1"
    dh_streams = {}                                    # turn → {"s": DHStream, "chunks": [...], "subs": set(), "done": bool}
    gesture_hint = {}                                  # "h": {"id", "name", "t"} — the page's waiting text gesture (POST /gesture)

    def dh_stream_for(g):
        """the reply's stream, created with its first sentence (the page is told where to fetch it)"""
        if g in dh_streams: return dh_streams[g], False
        from duix.dh_video import DHStream
        dv = eng.dh()
        if dv is None: return None, False
        for og, ost in list(dh_streams.items()):           # an older reply still rendering: it ends now
            if og != g and not ost["done"]: ost["s"].abort()
        loop = loop_ref["loop"]; st = {"chunks": [], "subs": set(), "done": False}
        def on_chunk(b):
            def put():
                if b is None: st["done"] = True
                else: st["chunks"].append(b)
                for qq in list(st["subs"]): qq.put_nowait(b)
            loop.call_soon_threadsafe(put)
        def on_go():
            loop.call_soon_threadsafe(lambda: asyncio.ensure_future(broadcast({"type": "dh_go", "turn": g})))
        path = os.path.join(eng.dh_dir, f"turn{g}-{int(time.time())}.mp4")
        # the page asked for a gesture (an agent line waiting for her hand) and it is warm: the reply opens on it
        hint, gv = gesture_hint.pop("h", None), None
        if hint and time.time() - hint["t"] < 25: gv = eng.dh_gestures().get(hint["name"])
        st["gesture"] = {"id": hint["id"], "name": hint["name"], "impact": gv.meta["impact"], "frames": gv.n, "fps": gv.fps} if gv else None
        st["s"] = DHStream(dv, 24000, on_chunk, on_go, stop=threading.Event(), path=path, prefix=gv); st["path"] = path
        dh_streams[g] = st
        for og in sorted(dh_streams)[:-3]: dh_streams.pop(og, None)          # the last few replies stay replayable
        return st, True

    def dh_on():
        # the 数字人 stream is DINet face2face — the full DUIX model; with the small real-time one (an Intel Mac with only Intel
        # graphics, or the user's pick) her replies are its live mouths on her idle instead
        return bool(eng.voice.get("dh")) and eng.renderer == "big" and eng.dh_avatar() is not None

    async def dh_worker():
        """the repo's _dh_run: one segment at a time through DUIX face2face (the next segment's voice is made meanwhile by
        tts_worker); each finished video goes to the page, which plays them back to back"""
        while True:
            g, i, text, meta = await dh_q.get()
            if g != gen["n"]: continue
            u = eng.utts.get(meta["id"]); dv = await asyncio.to_thread(eng.dh)
            if u is None or dv is None:                                     # no avatar renderer: her voice alone
                if g == gen["n"]: await broadcast({"type": "utt", "turn": g, **meta})
                continue
            out = os.path.join(eng.dh_dir, f"{meta['id']}.mp4"); stop = threading.Event(); dh_seg.setdefault("stops", {})[g] = stop
            st = dh_seg.setdefault(g, {"i": 0}); t = time.time()
            # her avatar keeps moving across a reply's segments (each picks up where the last one ended): no jump between them;
            # every reply starts at frame 0, the pose her idle shares
            try:
                r = await asyncio.to_thread(dv.render, u["w16"], u["path"], out, 4, stop, st.get("k0", 0))
            except Exception as e:                                          # never lose the worker: her voice alone this time
                print(f"[gf-live] 数字人 render failed ({type(e).__name__}: {e}) — voice only for this segment", flush=True)
                if g == gen["n"]: await broadcast({"type": "utt", "turn": g, **meta})
                continue
            if r is None or g != gen["n"]: continue
            st["k0"] = st.get("k0", 0) + getattr(dv, "last_frames", 0)
            print(f"[gf-live] 数字人 segment {i + 1} ({len(text)} chars, {meta.get('duration', 0):.1f}s) rendered in {time.time() - t:.1f}s"
                  f" ({time.time() - turn_t0.get(g, t):.1f}s after the message)", flush=True)
            spoke.add(g)
            await broadcast({"type": "dh", "turn": g, "i": i, "id": meta["id"], "url": f"/dh/{meta['id']}.mp4", "text": text,
                             "duration": meta.get("duration", 0), "emo": meta.get("emo")})
            files = sorted((f for f in os.listdir(eng.dh_dir) if f.endswith(".mp4")), key=lambda f: os.path.getmtime(os.path.join(eng.dh_dir, f)))
            for f in files[:-200]:                                           # the repo keeps the last 200
                try: os.remove(os.path.join(eng.dh_dir, f))
                except OSError: pass

    async def dh_voice(g, seg, emo):
        st = dh_seg.setdefault(g, {"i": 0})
        try: meta = await asyncio.to_thread(eng.speak, seg, emo)
        except Exception as e:
            print(f"[gf-live] 数字人 voice failed for {seg[:12]!r}: {type(e).__name__}: {e}", flush=True); return
        if g == gen["n"]:
            await dh_q.put((g, st["i"], seg, meta)); st["i"] += 1

    async def tts_worker():
        while True:
            item = await tts_q.get()
            g, text, emo = item if len(item) == 3 else (*item, None)
            if g != gen["n"] or not eng.avatar:
                continue
            if dh_on() and DH_STREAM:
                if text is None and g not in dh_streams: continue                 # an empty reply: nothing to show
                st, new_st = await asyncio.to_thread(dh_stream_for, g) if g not in dh_streams else (dh_streams[g], False)
                if st is None: pass                                          # no avatar renderer: the normal path below
                else:
                    if new_st and g == gen["n"]:
                        from duix.dh_video import MIME
                        await broadcast({"type": "dh_stream", "turn": g, "url": f"/dhs/{g}", "mime": MIME, "file": f"/dh/{os.path.basename(st['path'])}",
                                         "gesture": st.get("gesture")})
                    if text is None: st["s"].finish(); continue
                    try: meta = await asyncio.to_thread(eng.speak, text, emo)
                    except Exception as e:
                        print(f"[gf-live] voice failed for {text[:12]!r}: {type(e).__name__}: {e}", flush=True); continue
                    u = eng.utts.get(meta["id"])
                    if u is None or g != gen["n"]: continue
                    import wave as _wave
                    with _wave.open(u["path"]) as wf:
                        sr_ = wf.getframerate(); pcm = np.frombuffer(wf.readframes(wf.getnframes()), np.int16).astype(np.float32) / 32767
                    if sr_ != 24000: pcm = bl_resample(pcm, sr_, 24000)
                    st["s"].add(u["w16"], pcm); spoke.add(g)
                    print(f"[gf-live] 数字人 stream turn {g}: + {meta.get('duration', 0):.1f}s of voice ({len(text)} chars)", flush=True)
                    continue
            if dh_on():
                from duix.dh_video import Segmenter
                for old_g in [k for k in dh_seg if isinstance(k, int) and k < g - 2]: dh_seg.pop(old_g, None)   # finished turns
                st = dh_seg.setdefault(g, {"i": 0})
                sg = st.setdefault("seg", Segmenter(DH_SEG, int(os.environ.get("GF_DH_FIRST", "24")))); st["emo"] = emo or st.get("emo")
                for seg in (sg.flush() if text is None else sg.add(text)):  # None = the reply is complete
                    await dh_voice(g, seg, st.get("emo"))
                continue
            if text is None: continue
            t = time.time()
            try: meta = await asyncio.to_thread(eng.speak, text, emo)
            except Exception as e:                                      # one sentence failing never stops her voice
                print(f"[gf-live] voice failed for {text[:12]!r}: {type(e).__name__}: {e}", flush=True); continue
            print(f"[gf-live] voice: {len(clean_text(text))} chars → {meta.get('duration', 0):.1f}s of speech in {time.time() - t:.1f}s"
                  f" (turn {g}, {time.time() - turn_t0.get(g, t):.1f}s after the message)", flush=True)
            if g == gen["n"]:
                spoke.add(g)
                await broadcast({"type": "utt", "turn": g, **meta})

    def probe_speed():
        """How fast can this Mac make mouth frames right now? (12 real decodes on silence, both GPUs.)"""
        av = eng.avatar
        mel = L.melspectrogram(np.zeros(L.SR // 2, np.float32))[:, :16]
        done = threading.Semaphore(0); t = time.time()
        for k in range(12):
            x1, y1, x2, y2 = av.boxes[k % av.n]
            eng.runner.submit(k % av.n, ALPHA, x2 - x1, y2 - y1, mel, lambda _d: done.release())
        got = 0; deadline = t + 15                    # never hold up /avatar for long: measure what finished
        while got < 12 and time.time() < deadline:
            if done.acquire(timeout=max(0.05, deadline - time.time())): got += 1
        eng.gen_fps = max(2.0, got / max(1e-3, time.time() - t))
        print(f"[gf-live] mouth frames: {eng.gen_fps:.1f}/s ({got}/12)", flush=True)

    def warm():
        t = time.time()
        try:
            eng.synth("嗯，你好呀。")                            # loads the voice (MeloTTS: text model + the GPU decoder)
            WARM["voice"] = True
        except Exception as e:
            print("[gf-live] voice warm-up failed:", e, flush=True)
        try:                                                    # puts the persona into llama-server's prompt cache
            # 10-20 the GPU brain (Vulkan) compiles its pipelines per prompt shape on first use (~1–3 s each): run a few
            # turns of different lengths now, so her first real answer is already warm (0.2 s to the first token)
            sysmsg = {"role": "system", "content": persona("Mia")}
            hist = [{"role": "user", "content": "今天好累啊"}, {"role": "assistant", "content": "怎么啦？抱抱你。"}]
            for msgs in ([sysmsg, {"role": "user", "content": "在吗"}], [sysmsg] + hist + [{"role": "user", "content": "被老板骂了"}],
                         [sysmsg] + hist * 3 + [{"role": "user", "content": "你最喜欢吃什么呀"}]):
                n = 0
                for _ in llama_stream(msgs):
                    n += 1
                    if n >= 12: break
                if n: WARM["brain"] = True
        except Exception:
            pass                                                # brain not running yet — Terse starts it on demand
        try:
            WARM["stt"] = True if getattr(app.state, "get_stt", lambda: None)() is not None else "n/a"   # voice input (/stt)
        except Exception as e:
            WARM["stt"] = "n/a"; print(f"[gf-live] paraformer unavailable: {e}", flush=True)
        print(f"[gf-live] warm in {time.time() - t:.1f}s", flush=True)

    @app.on_event("startup")
    async def _start():
        loop_ref["loop"] = asyncio.get_running_loop()
        asyncio.create_task(tts_worker())
        asyncio.create_task(dh_worker())
        threading.Thread(target=warm, daemon=True).start()

    @app.post("/warm")
    async def warm_ep():
        await asyncio.to_thread(warm)
        return {"ok": True}

    @app.get("/health")
    def health():
        av = eng.avatar
        return {"ok": True, "renderer": eng.renderer, "mode": getattr(eng, "renderer_mode", eng.renderer), "avatar": av and {"path": av.path, "n": av.n, "fps": av.fps, "w": av.w, "h": av.h},
                "alpha": ALPHA, "voice": eng.voice, "kokoro": os.path.exists(os.path.join(KOKORO_DIR, "model.onnx")),
                "warm": WARM, "ready": all(v is True or v == "n/a" for v in WARM.values())}

    @app.post("/avatar")
    async def avatar(body: dict):
        v = body["video"]                          # one idle clip, or [idle, expression bases…]
        paths = [os.path.expanduser(v)] if isinstance(v, str) else [os.path.expanduser(x) for x in v]
        if not (eng.avatar and eng.avatar.paths == paths):
            WARM.update(avatar=False, dh=False, gestures=False); eng._dhg = None    # a new character: her own gestures
            if eng.mobile_mode:                                             # real-time DUIX: no wav2lip features to encode
                eng.avatar = await asyncio.to_thread(LightAvatar, paths, eng.duix())
            else:
                eng.avatar = await asyncio.to_thread(Avatar, paths, eng.runner)
                await asyncio.to_thread(probe_speed)
        av = eng.avatar
        WARM["avatar"] = True
        def dh_warm():                                                      # 流式数字人: her avatar (+ the gestures a reply can
            try:                                                            # open on) ready before the first reply
                if eng.dh() is None: WARM.update(dh="n/a", gestures="n/a"); return
            except Exception as e:
                print(f"[gf-live] 数字人 unavailable: {e}", flush=True); WARM.update(dh="n/a", gestures="n/a"); return
            WARM["dh"] = True; eng.dh_gestures()
        if dh_on(): threading.Thread(target=dh_warm, daemon=True).start()
        else: WARM.update(dh="n/a", gestures="n/a")
        if eng.voice.get("hd"): threading.Thread(target=eng.hd_prepare, daemon=True).start()
        if eng.renderer != "mobile":                                        # big DUIX model: warm its per-frame cache
            talks = [i for i, p in enumerate(av.paths) if os.path.basename(p).startswith("talk_")]
            threading.Thread(target=lambda: eng.duix() and eng.hd_warm(talks), daemon=True).start()
        hf = eng.hd.fps if eng.hd else (25.0 if eng.renderer == "mobile" else 10.0)
        masks, subs, tracks = [], [], []
        try:                                       # per clip: where DUIX redraws (her lips), 64² — the page draws patches through it
            import base64
            if eng.hd is not None and hasattr(eng.hd, "mask"):
                masks = [base64.b64encode(eng.hd.mask(eng.hd.clip(p)).tobytes()).decode() for p in av.paths]
                subs = [list(eng.hd.sub(eng.hd.clip(p))) for p in av.paths] if hasattr(eng.hd, "sub") else []
                # per clip, per frame: her face's motion from frame 0 (patch boxes come in frame 0's coordinates)
                tracks = await asyncio.to_thread(lambda: [[round(float(v), 2) for v in eng.hd.clip(p).track.reshape(-1)] for p in av.paths])
        except Exception as e:
            print(f"[gf-live] hd masks unavailable: {e}", flush=True)
        return {"n": av.n, "fps": av.fps, "w": av.w, "h": av.h, "boxes": av.boxes, "ranges": av.ranges, "paths": av.paths,
                "hd_fps": round(hf, 2), "hd_mask": masks, "hd_mask_size": 64, "hd_sub": subs, "hd_track": tracks, "dh": dh_on()}

    def apply_voice(v):
        if not isinstance(v, dict): return
        was_hd = eng.voice.get("hd")
        eng.voice.update({k: v[k] for k in ("engine", "clone_voice", "speed", "temperature", "hd", "omni_mode", "sweet", "bsweet", "style") if v.get(k) is not None})
        if eng.voice.get("hd") and not was_hd: threading.Thread(target=eng.hd_prepare, daemon=True).start()

    @app.post("/renderer")
    async def set_renderer(body: dict):
        """Switch who draws her mouth, live (test page, user 10-20): 'big' = full DUIX (DINetV1 fast split, GPU),
        'mobile' = small real-time DUIX (duix.com-mia-mouth, ncnn). The other model's GPU process is let go."""
        name = body.get("name")
        if name == "default": name = duix_renderer()                       # settings 口型引擎「自动」: this Mac's pick (hw.json)
        ok = {"big": big_duix_available(), "mobile": mobile_available()}
        if name not in ok or not ok[name]:
            return JSONResponse({"error": f"renderer {name!r} not installed", "renderer": eng.renderer}, 400)
        eng.renderer_mode = body.get("mode") or ("auto" if body.get("auto") else name)
        if name != eng.renderer or eng.hd is None:
            await asyncio.to_thread(swap_renderer, name)
        av = eng.avatar
        return {"renderer": eng.renderer, "mode": eng.renderer_mode, "boxes": av.boxes if av else None,
                "hd_fps": round(eng.hd.fps, 2) if eng.hd else (25.0 if eng.renderer == "mobile" else 10.0)}

    # 10-21 (user: "everything 丝滑 0 卡顿"): the worn battery's power cap (pmset CPU_Speed_Limit 20) slows the Radeon 3–4× too —
    # full DUIX then manages ~3 mouths/s and every reply stalls, while the small DUIX still does 12–15/s. Auto mode: full DUIX
    # while the Mac runs uncapped, the small one while it is capped (both stay loaded: switching is instant, between turns only).
    hd_keep = {}

    def swap_renderer(name):
        old, oldname = eng.hd, eng.renderer
        if old is not None: hd_keep[oldname] = old
        eng.renderer, eng.hd = name, hd_keep.pop(name, None)
        hd = eng.duix()
        if eng.avatar: eng.avatar = LightAvatar(eng.avatar.paths, hd)
        print(f"[gf-live] renderer → {name}", flush=True)

    def speed_limit():
        try:
            out = subprocess.run(["pmset", "-g", "therm"], capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"CPU_Speed_Limit\s*=\s*(\d+)", out)
            return int(m.group(1)) if m else 100
        except Exception:
            return 100

    def auto_renderer_loop():
        low_since = high_since = None
        while True:
            time.sleep(4)
            if getattr(eng, "renderer_mode", "big") != "auto" or not (big_duix_available() and mobile_available()): continue
            lim, now = speed_limit(), time.time()
            low_since = (low_since or now) if lim <= 45 else None
            high_since = (high_since or now) if lim >= 80 else None
            want = "mobile" if low_since and now - low_since >= 6 else "big" if high_since and now - high_since >= 20 else eng.renderer
            busy = brain_busy["n"] or not tts_q.empty() or eng.hd_lock.locked()          # mid-turn: wait for the gap
            if want != eng.renderer and not busy:
                swap_renderer(want)
                av = eng.avatar
                asyncio.run_coroutine_threadsafe(broadcast({"type": "renderer", "renderer": want, "mode": "auto", "limit": lim,
                                                            "boxes": av.boxes if av else None,
                                                            "hd_fps": round(eng.hd.fps, 2) if eng.hd else 10.0}), main_loop["loop"])
    main_loop = {"loop": None}

    @app.on_event("startup")
    async def _auto_start():
        main_loop["loop"] = asyncio.get_running_loop()
        eng.renderer_mode = os.environ.get("GF_DUIX_MODE", eng.renderer)       # user 10-21: always full DUIX (no auto switch)
        threading.Thread(target=auto_renderer_loop, daemon=True).start()

    @app.post("/voice")
    def voice(body: dict):
        if body.get("engine") != eng.voice.get("engine") or body.get("ref") != eng.voice.get("ref"):
            eng.tts = None
        eng.voice.update({k: v for k, v in body.items() if v is not None})
        if body.get("hd"): threading.Thread(target=eng.hd_prepare, daemon=True).start()
        return eng.voice

    @app.get("/idle.mp4")
    def idle():
        return FileResponse(eng.avatar.path, media_type="video/mp4")

    @app.websocket("/events")
    async def events(ws: WebSocket):
        await ws.accept(); subs.add(ws)
        try:
            while True:
                await ws.receive_text()          # keepalive / ignored
        except Exception:
            subs.discard(ws)

    # ── hands-free voice input (10-21): the page streams its microphone here; asr.py = Silero VAD + SenseVoice-Small ──
    asr_box = {"asr": None, "lock": threading.Lock()}

    def get_asr():
        with asr_box["lock"]:
            if asr_box["asr"] is None:
                import asr as asrmod
                if not asrmod.available(os.path.join(HOME, "models")): raise RuntimeError("voice input models not installed")
                t = time.time(); asr_box["asr"] = asrmod.ASR(os.path.join(HOME, "models"), threads=4)
                print(f"[gf-live] voice input ready in {time.time() - t:.1f}s (Silero VAD + SenseVoice)", flush=True)
            return asr_box["asr"]

    asr_box["conns"] = 0; asr_box["last"] = time.time()

    def asr_idle_loop():                    # voice input off for 2 min → let SenseVoice go (~250 MB)
        while True:
            time.sleep(20)
            with asr_box["lock"]:
                if asr_box["asr"] is not None and asr_box["conns"] == 0 and time.time() - asr_box["last"] > 120:
                    asr_box["asr"] = None; import gc; gc.collect()
                    print("[gf-live] voice input idle: SenseVoice unloaded", flush=True)
    threading.Thread(target=asr_idle_loop, daemon=True).start()

    @app.websocket("/asr")
    async def asr_ws(ws: WebSocket):
        """16 kHz mono int16 in (binary frames) → {"type": speech | partial | final, "text"} out."""
        await ws.accept(); asr_box["conns"] += 1; asr_box["last"] = time.time()
        try:
            A = await asyncio.to_thread(get_asr)
        except Exception as e:
            asr_box["conns"] -= 1
            await ws.send_text(json.dumps({"type": "error", "error": str(e)})); await ws.close(); return
        import asr as asrmod
        sess = asrmod.Session(A)
        await ws.send_text(json.dumps({"type": "ready"}))

        async def partial(x, end):
            try:
                t = await asyncio.to_thread(A.transcribe, x)
                if t:
                    sess.part_text = t; sess.text_end = end
                    if sess.speaking: await ws.send_text(json.dumps({"type": "partial", "text": t}))
            except Exception:
                pass
            finally:
                sess.partial_busy = False
        try:
            while True:
                m = await ws.receive()
                if m.get("type") == "websocket.disconnect": break
                b = m.get("bytes")
                if not b: continue
                for e in sess.feed(b):
                    if e["type"] == "segment":
                        seg = e["samples"]; rms = float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0
                        if len(seg) < int(0.3 * 16000) or rms < 10 ** (-35 / 20):     # a click / a fan / far noise (−35 dB gate)
                            sess.part_text = ""; sess.text_end = 0; continue
                        t0 = time.time()
                        if sess.fut is not None and not sess.fut.done(): await sess.fut     # a live transcript in flight
                        if sess.reusable(e["speech_end"]): text = sess.part_text
                        else: text = await asyncio.to_thread(A.transcribe, e["samples"])
                        sess.part_text = ""; sess.text_end = 0
                        ms = int((time.time() - t0) * 1000); dur = round(len(e["samples"]) / 16000, 2)
                        if not text.strip(" 。，,.!?！？"): continue
                        print(f"[gf-live] heard ({dur}s speech, {ms} ms): {text}", flush=True)
                        await ws.send_text(json.dumps({"type": "final", "text": text, "ms": ms, "dur": dur}))
                    else:
                        await ws.send_text(json.dumps(e))
                x = sess.want_partial()
                if x is not None: sess.fut = asyncio.ensure_future(partial(x, sess.part_end))
        except Exception:
            pass
        finally:
            asr_box["conns"] -= 1; asr_box["last"] = time.time()

    async def queue_sentences(texts, g):
        for t in texts:
            await tts_q.put((g, t))

    @app.post("/utt_wav")
    async def utt_wav(body: dict):
        """Dev / demo: register a prepared mono wav as an utterance (same mouth pipeline as speech). -> meta"""
        with wave.open(os.path.expanduser(body["path"])) as wf:
            sr = wf.getframerate(); a = np.frombuffer(wf.readframes(wf.getnframes()), np.int16).astype(np.float32) / 32768
        meta = await asyncio.to_thread(eng._register, a, sr, a, sr)
        meta.update({"text": body.get("text", ""), "emo": body.get("emo")})
        return meta

    @app.post("/say")
    async def say(body: dict):
        """Speak given text (e.g. an agent's reply from Terse): sentence by sentence."""
        g = gen["n"] = gen["n"] + 1 if body.get("interrupt", True) else gen["n"]
        sp = Splitter(clauses=eng.voice.get("engine") in ("qwencpp", "qwenclone", "melo", "matcha")); emo = body.get("emo"); said = []
        for raw in sp.feed(body["text"]) + sp.flush():          # 【撒娇】… tags work here too
            emo, txt = split_emo(raw, emo)
            if txt: said.append(txt); await tts_q.put((g, txt, emo))
        await tts_q.put((g, None, emo))                            # the end of this reply (流式数字人: its last segment)
        return {"turn": g, "sentences": said}

    # 10-21 (user: "everything 丝滑 0 卡顿"): the brain (Vulkan on the Radeon) reads new prompt tokens at only ~30–40 ms each
    # (small batches), so (1) history must match its KV cache exactly — the page sends her replies cleaned of 【tags】 /
    # <answer>, so the raw text goes back in (else it re-read her whole last reply, ~1.3 s, every turn), and (2) while you
    # are still talking / typing, /prefill makes it read your words ahead: at send time only the last few tokens are new.
    raw_replies = {}; brain_busy = {"n": 0}; prefill_box = {"busy": False, "last": ""}; garbled = {}
    cap_box = {"t": 0.0, "v": False}
    # her brain: the local llama-server, or a coding agent on this Mac (agents.py; set by /brain, or per turn by /chat "brain")
    import agents
    brain_box = {"id": "local", "model": None}

    @app.get("/brains")
    async def brains_ep():
        """which agents this Mac has (her brain picker): path + version, no network"""
        found = await asyncio.gather(*(asyncio.to_thread(agents.find, n) for n in agents.LABEL))
        return {"current": brain_box["id"], "agents": [{"id": n, "label": agents.LABEL[n], "installed": bool(b), "bin": b, "version": v}
                                                       for n, (b, v) in zip(agents.LABEL, found)]}

    @app.post("/brain")
    async def brain_ep(body: dict):
        """一键连接 (user 10-22): {"id": local|claude|codex|dsh, "model"?} — one tiny real reply from the agent, then it is her
        brain. Claude Code not logged in → the browser opens on its 授权 page ({"login": true}); call again until "ok"."""
        bid = body.get("id") or "local"
        if bid == "local":
            brain_box.update(id="local", model=None); return {"ok": True, "id": "local", "label": "本地大脑"}
        if bid not in agents.LABEL: return JSONResponse({"ok": False, "error": f"unknown brain: {bid}"}, 400)
        r = await asyncio.to_thread(agents.check, bid, body.get("model"))
        if r.get("ok"): brain_box.update(id=bid, model=body.get("model"))
        print(f"[gf-live] brain → {bid}: {'connected in %.1fs' % (r.get('ms', 0) / 1000) if r.get('ok') else r.get('error')}", flush=True)
        return r

    def cpu_capped():
        """pmset CPU_Speed_Limit ≤ 40 (the worn battery's power cap), re-read at most every 10 s"""
        if time.time() - cap_box["t"] > 10:
            cap_box["t"] = time.time()
            try:
                out = subprocess.run(["pmset", "-g", "therm"], capture_output=True, text=True, timeout=3).stdout
                m = re.search(r"CPU_Speed_Limit\s*=\s*(\d+)", out); cap_box["v"] = bool(m and int(m.group(1)) <= 40)
            except Exception: pass
        return cap_box["v"]

    def restart_brain():
        """Kill and restart llama-server with the same command line (it holds the garbled GPU state); wait until it answers."""
        import shlex, urllib.request
        try:
            pids = subprocess.run(["pgrep", "-f", f"llama-server.*--port {LLAMA_PORT}"], capture_output=True, text=True).stdout.split()
            if not pids: return
            pid = pids[0]; cmd = subprocess.run(["ps", "-o", "command=", "-p", pid], capture_output=True, text=True).stdout.strip()
            if not cmd: return
            subprocess.run(["kill", pid]); time.sleep(0.8); subprocess.run(["kill", "-9", pid], capture_output=True)
            subprocess.Popen(shlex.split(cmd), stdout=open(os.path.join(HOME, "llama.log"), "a"), stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{LLAMA_PORT}/health", timeout=1); break
                except Exception: time.sleep(0.25)
            for n in (6, 18, 40):                 # its GPU pipelines are compiled per prompt shape: warm them before her next answer
                try:
                    for _ in llama_stream([{"role": "user", "content": "嗯" * n}], max_tokens=2): pass
                except Exception: pass
            print("[gf-live] brain restarted", flush=True)
        except Exception as e:
            print(f"[gf-live] brain restart failed: {e}", flush=True)

    def chat_msgs(body, text):
        msgs = [{"role": "system", "content": body.get("persona") or persona(body.get("name") or "Mia", body.get("personality"),
                                                                             body.get("tone"), body.get("custom"))}]
        hist = body.get("history") or []
        # the brain's prompt cache only reuses an unchanged PREFIX: a sliding "last 8" window changed the start every turn and
        # it re-read the whole history (134 tokens, 41 s under the CPU cap). Drop old turns in chunks instead.
        keep = len(hist) if len(hist) <= 16 else 8 + (len(hist) - 8) % 8
        for h in hist[-keep:]:
            if h.get("role") == "user": msgs.append({"role": "user", "content": h.get("text", "")})
            else: msgs.append({"role": "assistant", "content": raw_replies.get(h.get("text", ""), h.get("text", ""))})
        msgs.append({"role": "user", "content": text})
        return msgs

    @app.post("/prefill")
    async def prefill(body: dict):
        text = (body.get("text") or "").strip()
        if (body.get("brain") or brain_box["id"]) != "local": return {"ok": False}    # an agent has no prompt cache to fill
        if not text or brain_busy["n"] or prefill_box["busy"] or text == prefill_box["last"]: return {"ok": False}
        prefill_box["busy"] = True; prefill_box["last"] = text
        msgs = chat_msgs(body, text)

        def run():
            try:
                # read the 1-token answer to its end — cutting the stream cancels the task mid-step, and a /chat with the same
                # prompt right behind it then reused a half-written KV cache: "@@@@" (10-21, llama.log "need to evaluate at least
                # 1 token for each active slot" right before every garbled turn)
                for _ in llama_stream(msgs, max_tokens=1): pass
            except Exception: pass
            finally: prefill_box["busy"] = False
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True}

    @app.post("/chat")
    async def chat(body: dict):
        """One conversation turn with her brain (llama-server Qwen3, or a coding agent's CLI), streamed into speech."""
        gen["n"] += 1; g = gen["n"]; turn_t0[g] = time.time()
        apply_voice(body.get("voice"))                                     # settings page, sent with every turn
        await broadcast({"type": "thinking", "turn": g})
        # 10-20 用户:"我不希望有任何 pre answer,所有都必须是真实的,不是 fallback" —— 不再先放预录的「嗯嗯 / 我想想哦」,
        # 她说的每一句都是这次真正的回答(brain → 声音 → DUIX 嘴),声音和嘴互相等齐了才出来
        msgs = chat_msgs(body, body["text"])
        # who writes her words: the local brain, or a coding agent (10-22) — everything after the words is the same pipeline
        provider = body.get("brain") or brain_box["id"]
        if provider not in agents.LABEL: provider = "local"
        model = body.get("brain_model") or (brain_box["model"] if provider == brain_box["id"] else None)
        q = asyncio.Queue(); loop = asyncio.get_running_loop(); enough = threading.Event()
        brain_busy["n"] += 1
        for _ in range(60):                           # a read-ahead still running: let it finish first (never two at once)
            if not prefill_box["busy"]: break
            await asyncio.sleep(0.02)

        def pump():
            try:
                src = llama_stream(msgs) if provider == "local" else agents.stream(provider, msgs, model, stop=enough)
                for tok in src:
                    loop.call_soon_threadsafe(q.put_nowait, tok)
                    if enough.is_set(): break              # closing the stream stops llama-server / kills the agent
            except Exception as e:
                loop.call_soon_threadsafe(q.put_nowait, e)
            loop.call_soon_threadsafe(q.put_nowait, None)
        threading.Thread(target=pump, daemon=True).start()
        sp = Splitter(clauses=eng.voice.get("engine") in ("qwencpp", "qwenclone", "melo", "matcha")); full = ""; t0 = time.time(); first = None; emo = None; ftok = None; mood = None; ntok = 0
        while True:
            tok = await q.get()
            if tok is None: break
            if isinstance(tok, Exception):
                why = getattr(tok, "hint", None) or str(tok)                   # an agent says what the user can do about it
                await broadcast({"type": "error", "turn": g, "error": why, "brain": provider}); brain_busy["n"] -= 1
                return JSONResponse({"error": why, "brain": provider}, 502)
            full += tok
            if ftok is None: ftok = time.time() - t0
            # a hot / power-capped Radeon sometimes makes the brain emit garbage (NaN logits: "@@@@…", 340 chars with no
            # sentence end, ~1.5 tok/s): stop, restart the brain, answer again — never speak or wait on it (10-21)
            ntok += 1
            if provider == "local" and not garbled.get(g):
                body_t = re.sub(r"【[^】]*】|<[^>]*>", "", full)
                run = len(re.split(r"[。！？!?～~…，,、；;：:\n]", body_t)[-1])           # characters since the last punctuation
                bad = (len(body_t) >= 6 and not re.search(r"[\u4e00-\u9fff]", body_t)) or run > 34 or re.search(r"(.)\1{7,}", body_t) \
                      or (ntok >= 24 and ntok / max(1e-3, time.time() - t0 - (ftok or 0)) < 0.8)
                if bad:
                    garbled[g] = True; enough.set()
                    print(f"[gf-live] brain turn {g}: garbled / stalled output ({body_t[:24]!r}, {ntok} tokens) — dropped", flush=True)
                    break
            if mood is None:                                                   # her first 【情绪】 tag: the page moves to that clip now
                mm = re.search(r"【([^】]{1,6})】", full)
                if mm:
                    mood = mm.group(1)
                    if g == gen["n"]: await broadcast({"type": "mood", "turn": g, "emo": mood})
            # a newer message or a stop (barge-in): let the brain go NOW — it has one slot, and an old answer it kept writing
            # made the next message wait behind it (10-21: first token after 16.7 s, then 24.8 s, while the user talked)
            if g != gen["n"]: enough.set(); break
            for sent in sp.feed(tok):
                if first is None: first = time.time() - t0
                emo, txt = split_emo(sent, emo)
                if txt: await tts_q.put((g, txt, emo))
            # 10-20 (user: "要稳定 5 s 以内"): the persona asks for 两三句 but the small brain often writes 5–6; every extra
            # sentence is GPU time the brain shares with DUIX (each token waits behind a ~70 ms DUIX frame — a 55-char reply
            # took 8 s). Stop at the end of the 3rd sentence, or the 2nd once she has said ~45 characters.
            if not enough.is_set():
                said = len(re.sub(r"【[^】]*】", "", full)); ends = len(re.findall(r"[。！？!?]+", full))
                # under the battery's CPU cap (CPU_Speed_Limit ≤ 40) everything is ~5× slower: two sentences, so her voice and
                # mouths are done before your next message arrives (10-21: a third sentence's work starved the next turn)
                capped = cpu_capped()
                if ends >= 3 or (ends >= 2 and (said >= 45 or capped)) or (capped and said >= 40 and ends >= 1): enough.set()
            if enough.is_set() and full.rstrip()[-1:] in "。！？!?～~…": break
        for sent in sp.flush():
            emo, txt = split_emo(sent, emo)
            if txt: await tts_q.put((g, txt, emo))
        await tts_q.put((g, None, emo))                                          # the end of this reply
        if garbled.get(g):
            brain_busy["n"] -= 1                                                 # never restart the brain (user 10-21): ask once more
            if g == gen["n"] and first is None and not body.get("_retry"):        # nothing said yet: answer again
                return await chat(dict(body, _retry=True))
            if first is None: return JSONResponse({"error": "brain garbled"}, 502)
            for sent in sp.flush(): pass                                         # what she already said stands; drop the rest
            reply = clean_text(re.sub(r"[^。！？!?～~…]*$", "", full)) or clean_text(full)[:20]
            await broadcast({"type": "reply", "turn": g, "text": reply})
            return {"turn": g, "text": reply, "first_sentence_s": round(first, 2), "llm_s": round(time.time() - t0, 2)}
        reply = clean_text(full); brain_busy["n"] -= 1
        raw_replies[reply] = full                     # history comes back cleaned; the brain's cache holds the raw reply
        while len(raw_replies) > 64: raw_replies.pop(next(iter(raw_replies)))
        print(f"[gf-live] brain turn {g} ({provider}): first token {ftok or 0:.1f}s, first piece {first or 0:.1f}s, done {time.time() - t0:.1f}s ({len(reply)} chars)", flush=True)
        await broadcast({"type": "reply", "turn": g, "text": reply, "brain": provider})
        return {"turn": g, "text": reply, "brain": provider, "first_sentence_s": first and round(first, 2), "llm_s": round(time.time() - t0, 2)}

    @app.post("/gesture")
    async def gesture_ep(body: dict):
        """the page has an agent line waiting for one of her gestures ({"name": clip stem, "id"}): if a reply starts before
        she performs it, the reply's 数字人 stream opens on that gesture (lip-synced) and the page releases the line at its
        impact. {"clear": id}: performed or dropped meanwhile."""
        if body.get("clear") is not None:
            h = gesture_hint.get("h")
            if h and h["id"] == body["clear"]: gesture_hint.pop("h", None)
            return {"ok": True}
        name = str(body.get("name") or "")
        gesture_hint["h"] = {"id": body.get("id"), "name": name, "t": time.time()}
        return {"ok": True, "warm": name in eng.dh_gestures()}

    @app.post("/blow")
    async def blow_ep():
        """She blows out one agent-log line: a short rounded-lips breath through the normal mouth pipeline."""
        if not eng.avatar:
            return JSONResponse({"error": "no avatar"}, 409)
        meta = await asyncio.to_thread(eng.blow)
        await broadcast({"type": "utt", "turn": gen["n"], **meta})
        return meta

    @app.post("/stop")
    async def stop():
        for ev in list(dh_seg.get("stops", {}).values()): ev.set()
        for st in list(dh_streams.values()):
            if not st["done"]: st["s"].abort()
        gen["n"] += 1
        await broadcast({"type": "stop", "turn": gen["n"]})
        return {"turn": gen["n"]}

    @app.get("/audio/{uid}.wav")
    def audio(uid: str):
        u = eng.utts.get(uid)
        return FileResponse(u["path"], media_type="audio/wav") if u else JSONResponse({"error": "gone"}, 404)

    stt_box = {"stt": None, "err": None, "lock": asyncio.Lock(), "load": threading.Lock()}

    def get_stt():
        """Paraformer, loaded once (5.4 s at a 28 % CPU cap on first use, 10-21 — so the engine's warm-up loads it: the first
        thing she hears must not wait for it)"""
        with stt_box["load"]:
            if stt_box["stt"] is None:
                import stt as sttmod, bargein
                path = sttmod.model_path(MODELS)
                if path is None: return None
                t = time.time(); stt_box["stt"] = sttmod.STT(path, 4, bargein.model_path(MODELS))
                print(f"[gf-live] paraformer ready in {time.time() - t:.1f}s", flush=True)
            return stt_box["stt"]
    app.state.get_stt = get_stt

    @app.post("/stt")
    async def stt_ep(request: Request):
        """speech to text, as the repo's /api/stt (FunASR Paraformer-large): the page cuts the utterance itself and POSTs it
        WHOLE (16 kHz PCM16, raw or WAV) -> {"text", "language"}; 400 empty body, 422 longer than X-Max-Audio-Sec (30)."""
        import stt as sttmod
        body = await request.body()
        if not body:
            return JSONResponse({"detail": "Empty body"}, 400)
        x = await asyncio.to_thread(sttmod.decode, body, request.headers.get("content-type", ""))
        dur = len(x) / sttmod.SR; max_sec = float(request.headers.get("X-Max-Audio-Sec", "30") or "30")
        if dur > max_sec:
            return JSONResponse({"detail": f"Audio too long: {dur:.1f}s exceeds X-Max-Audio-Sec {max_sec}s"}, 422)
        async with stt_box["lock"]:                          # one utterance at a time, as the repo's infer_lock
            S = await asyncio.to_thread(get_stt)
            if S is None:
                return JSONResponse({"detail": "paraformer not installed"}, 503)
            t0 = time.time()
            voiced = await asyncio.to_thread(S.speech_seconds, x)
            text = "" if voiced is not None and voiced < 0.1 else await asyncio.to_thread(S.transcribe, x)
        ms = int((time.time() - t0) * 1000)
        if voiced is not None and voiced < 0.1: print(f"[gf-live] stt: no voice in {dur:.2f}s (silero); treating as empty", flush=True)
        elif not text: print(f"[gf-live] stt: paraformer returned empty result ({dur:.2f}s); treating as empty", flush=True)
        else: print(f"[gf-live] heard ({dur:.2f}s, {voiced}s voice, {ms} ms): {text}", flush=True)
        return {"text": text, "language": "zh", "ms": ms, "dur": round(dur, 2)}

    @app.websocket("/vad")
    async def vad_ws(ws: WebSocket):
        """barge-in (打断), as the repo's /api/vad: while she speaks the page streams its microphone here (16 kHz mono PCM16,
        any chunk size); Silero VAD v4 answers {"event": "speech_start"} once a real voice has lasted 384 ms — the page then
        stops her — and {"event": "speech_end"}. Chunks are never stored."""
        await ws.accept()
        import bargein
        path = bargein.model_path(MODELS)
        if path is None:
            await ws.send_text(json.dumps({"error": "silero-vad v4 not installed"})); await ws.close(); return
        b = bargein.BargeIn(path)
        try:
            while True:
                data = await ws.receive_bytes()
                if not data: continue
                for e in b.feed(data): await ws.send_text(json.dumps({"event": e}))
        except Exception:
            pass

    @app.get("/dha/{turn}")
    async def dh_audio(turn: int):
        """the reply's voice alone — raw PCM s16le 24 kHz mono, from its start, live as it is made (10-22, user: the app's voice
        input "复刻" the repo, talk-over included): in the app the mic helper plays her voice through the same voice-processing
        engine that records the mic, so macOS's echo canceller knows what she says and the barge-in VAD can't hear her own voice
        from the speakers; the page plays the video muted and follows the helper's clock"""
        from fastapi.responses import StreamingResponse
        st = dh_streams.get(turn)
        if not st or "s" not in st: return JSONResponse({"error": "no such turn"}, 404)
        s = st["s"]
        async def gen():
            i = 0
            while True:
                n = len(s.pcm)
                if n > i: yield bytes(s.pcm[i:n]); i = n
                elif s.pcm_done: break
                else: await asyncio.sleep(0.03)
        return StreamingResponse(gen(), media_type="application/octet-stream")

    @app.websocket("/dhs/{turn}")
    async def dh_stream_ws(ws: WebSocket, turn: int):
        """a reply's fragmented-MP4 stream: what is rendered so far, then each new fragment, closed at the end"""
        await ws.accept()
        st = dh_streams.get(turn)
        if st is None: await ws.close(); return
        q = asyncio.Queue(); st["subs"].add(q)
        try:
            for b in list(st["chunks"]): await ws.send_bytes(b)
            done = st["done"] and q.empty()
            while not done:
                b = await q.get()
                if b is None: break
                await ws.send_bytes(b)
        except Exception:
            pass
        finally:
            st["subs"].discard(q)
            try: await ws.close()
            except Exception: pass

    @app.get("/dh/{name}")
    def dh_video(name: str):
        f = os.path.join(eng.dh_dir, os.path.basename(name))
        return FileResponse(f, media_type="video/mp4") if os.path.exists(f) else JSONResponse({"error": "gone"}, 404)

    @app.get("/phones/{uid}")
    def phones(uid: str):
        """dev: the phoneme timeline a line's lips follow ([t0, t1, symbol, tone], seconds of its audio)"""
        u = eng.utts.get(uid)
        return {"phones": u.get("phones"), "frames": len(u.get("chunks") or [])} if u else JSONResponse({"error": "gone"}, 404)

    @app.websocket("/patches")
    async def patches(ws: WebSocket):
        """Mouth patches for one utterance, frames j = 0, s, 2s… (s = stride: 2 on a hot, throttled Mac halves the
        GPU work; the page holds each patch for s frames). ≤ 8 in flight across both GPUs."""
        await ws.accept()
        uid, k0 = ws.query_params["id"], int(ws.query_params.get("k0", "0"))
        stride = max(1, int(ws.query_params.get("stride", "1")))
        qa = ws.query_params.get("alpha")                # optional per-request audio strength (tuning / per-character)
        u = eng.utts.get(uid); av = eng.avatar
        # which clip she is talking on: frames [lo, lo + span) of the shared frame space (default: the clip holding k0)
        if av and ws.query_params.get("lo") is not None:
            lo, span = int(ws.query_params["lo"]), int(ws.query_params.get("n", "0")) or av.n
        elif av:
            lo, span = av.range_of(k0)
        else:
            lo, span = 0, 1
        if not u or not av:
            await ws.close(); return
        loop = asyncio.get_running_loop()
        q = asyncio.Queue()
        if u.get("filler"):                                                # pre-rendered reaction: every patch at once
            try:
                pats = u["filler"]["patches"].get(lo) or next(iter(u["filler"]["patches"].values()), [])
                for (j, x, y, w, h, jpg) in pats:
                    await ws.send_bytes(pack_patch(uid, j, (x, y, w, h), jpg))
                await ws.send_text(json.dumps({"done": True, "fps": round(eng.hd.fps, 2) if eng.hd else 0, "hd": True}))
            except WebSocketDisconnect:
                pass
            return
        if (ws.query_params.get("hd") == "1" or eng.runner is None) and eng.hd_on():
            bq = ws.query_params.get("bounce")
            bounce = tuple(int(v) for v in bq.split(",")[:2]) if bq else None
            await hd_patches(ws, uid, u, av, k0, lo, span, loop, q, stride, bounce, fill=ws.query_params.get("fill") == "1")
            return
        if eng.runner is None:
            await ws.close(); return
        js = list(range(0, len(u["chunks"]), stride)); t = time.time()
        nxt = 0; inflight = 0; sent = 0

        def submit(j):
            base = lo + (k0 - lo + j) % span
            x1, y1, x2, y2 = av.boxes[base]
            hdr = eng.header(uid, j, base)
            eng.runner.submit(base, float(qa) if qa else (u.get("alpha") or ALPHA), x2 - x1, y2 - y1, u["chunks"][j],
                              lambda data, hdr=hdr: loop.call_soon_threadsafe(q.put_nowait, hdr + data if data else None))
        try:
            while sent < len(js):
                while inflight < 8 and nxt < len(js):
                    submit(js[nxt]); nxt += 1; inflight += 1
                msg = await q.get(); inflight -= 1; sent += 1
                if msg is not None:                      # None = runner rejected a garbage patch
                    await ws.send_bytes(msg)
            el = time.time() - t
            raw = len(js) / max(el, 1e-3)
            eng.gen_fps = 0.6 * eng.gen_fps + 0.4 * raw if len(js) >= 8 else eng.gen_fps
            await ws.send_text(json.dumps({"done": True, "fps": round(len(js) * stride / el, 1), "raw_fps": round(raw, 1)}))
        except WebSocketDisconnect:
            pass

    hd_order = eng.hd_lock               # HD replies render one at a time, in order: clause 2 renders while clause 1 plays

    async def hd_patches(ws, uid, u, av, k0, lo, span, loop, q, stride=1, bounce=None, fill=False):
        """DUIX patches for one utterance on clip [lo, lo+span): frame j shows base (k0-lo+j) % span with the audio
        window at the same instant (DUIX windows are 25 fps; the clip runs at av.fps). Rendered on the Radeon by
        terse-gf-duix, 4 in flight; same wire format as the wav2lip patches. stride 2 = every other frame (the page
        holds each patch for two frames) — the Douyin repo renders its avatar at 15 fps for the same reason."""
        ci = next((i for i, r in enumerate(av.ranges) if r[0] == lo), 0)
        hd = eng.hd
        gone = threading.Event()                  # the page closed this socket (it re-planned the line): stop rendering for it

        def base_of(j, clip):
            if bounce:                                    # talking on the calm idle: follow its back-and-forth within [A, B]
                A, B = bounce; Lb = max(1, B - A); t2 = (k0 - lo - A + j) % (2 * Lb); return A + (t2 if t2 <= Lb else 2 * Lb - t2)
            return (k0 - lo + j) % min(span, clip.n)

        def send(j, r):
            if r == "bare":
                loop.call_soon_threadsafe(q.put_nowait, json.dumps({"bare": j}))
            elif r is not None:
                (x, y, w, hh), jpg = r
                loop.call_soon_threadsafe(q.put_nowait, pack_patch(uid, j, (x, y, w, hh), jpg))
            else:
                loop.call_soon_threadsafe(q.put_nowait, json.dumps({"skip": j}))

        def work_fill(clip, win, va, n):
            """10-21 (user: "继续优化 … 超级自然、天衣无缝"): her mouth is her own lips warped to an opening, so every frame can be
            drawn — DINet runs on keyframes only (every `stride` frames: what the power-capped Radeon manages, ~3–6/s) and the
            frames between get the opening interpolated (a mouth moving at 24 fps, not jumping every 4 frames). Silent keyframes
            skip DINet (closed). Renders run on the CPU pool, results go out in frame order."""
            from concurrent.futures import Future
            from duix.lipwarp import lerp_op
            import collections, queue
            loop.call_soon_threadsafe(q.put_nowait, json.dumps({"fill": 1}))
            s = max(1, stride); keys = list(range(0, n, s))
            if keys[-1] != n - 1: keys.append(n - 1)
            CLOSED = {"h0": 0.0}; depth = int(os.environ.get("GF_DUIX_DEPTH", "3"))
            # DINet gives the size / shape of her mouth on keyframes; the voice gives the syllables between them (her real
            # talking take opens ~0.8 of DINet's size on average: GF_DUIX_OPEN)
            from duix.duix_hd import syllable_mod
            smod = syllable_mod(u["w16"], av.fps, n); gain = float(os.environ.get("GF_DUIX_OPEN", "0.7"))

            floor = float(os.environ.get("GF_DUIX_SYL_FLOOR", "0.3"))

            # 10-21 (user: "嘴唇动作太机械 … 不像是反映真实 Chinese 的发音"): with Melo's phoneme timeline the shape of her lips per
            # frame comes from the pinyin she is saying (visemes.py: open / wide / round, coarticulated); DINet's openings
            # (keyframes, a slow envelope of them) set how big she speaks. Without a timeline: DINet × syllable rhythm.
            from duix.visemes import track as vis_track
            vis = vis_track(u.get("phones"), av.fps, n, audio=u.get("w16"), sr=L.SR)
            lip_a = float(os.environ.get("GF_LIP_A", "11.5"))
            kh = {}                                                                # keyframe → DINet's raw opening

            def envelope(f):
                near = [v for j, v in kh.items() if abs(j - f) <= max(6, 2 * s)]
                return max(near) if near else 0.0

            def shaped(op, f):
                if vis is not None:
                    fo, fw, fr, fl = (float(v) for v in vis[min(f, len(vis) - 1)])
                    if fo <= 0.02: return dict(CLOSED)
                    # how big she speaks now (10-21, user: "幅度…不够大"): her "a" at lip_a (h0 = half the gap, 256²) — her
                    # talking take's openings (visible gap p50 / p90 9.8 / 13.5) — × how loud this vowel is against the line
                    # (visemes.py, JALI), × a little of DINet's own opening; o / e / i scale down from it (EMA apertures).
                    # Her corners spread a little more the wider she opens (her take: +0.7 px of width per px of gap)
                    env = envelope(f); dn = float(np.clip(0.88 + 0.12 * env / 8.0, 0.88, 1.12)) if env > 0 else 1.0
                    return {"h0": lip_a * fl * dn * fo, "sx": fw * (1 + 0.06 * fo * (1 - fr)), "round": fr, "vis": True}
                # the syllable rhythm swings her mouth between floor and full DINet size (a product of the two alone left it
                # nearly shut most of the time, 10-21); closing for real is DINet's call and the silences'
                if not op or op.get("h0", 0) <= 0: return op
                o = dict(op); o["h0"] = op["h0"] * gain * (floor + (1 - floor) * float(smod[min(f, len(smod) - 1)])); return o
            outq = queue.Queue(); t = time.time(); dn = [0]

            def emitter():
                while True:
                    it = outq.get()
                    if it is None: break
                    j, fu = it
                    try: r = fu.result()
                    except Exception as e: print(f"[gf-live] DUIX fill frame {j} failed: {e}", flush=True); r = None
                    send(j, r)
            et = threading.Thread(target=emitter, daemon=True); et.start()
            pend = collections.deque(); prev = None; ki = 0; dbg = []
            try:
                while ki < len(keys) or pend:
                    while ki < len(keys) and len(pend) < depth:   # keyframes on the GPU, a few ahead
                        j = keys[ki]; ki += 1
                        if va[min(j, len(va) - 1)] <= 0: pend.append((j, None)); continue
                        while eng.gpu_prio.is_set() and not gone.is_set(): time.sleep(0.004)   # her next sentence's voice first
                        if gone.is_set(): break
                        a = min(len(win) - 1, int(round(j * 25.0 / av.fps)))
                        pend.append((j, hd.submit(clip, base_of(j, clip), win[a])))
                    if gone.is_set():
                        for _, h in pend:
                            if h is not None: hd.drop(h)
                        print(f"[gf-live] DUIX request dropped by the page after {dn[0]} keyframes", flush=True)
                        return
                    j, h = pend.popleft()
                    op = CLOSED if h is None else hd.finish_open(h)
                    if h is not None: dn[0] += 1
                    if op is None: op = prev[1] if prev else CLOSED                   # garbled: keep the last mouth
                    if h is not None: kh[j] = float(op.get("h0", 0.0))
                    # DINet "closed" while her voice is loud is a misread (no gap found): keep the last opening
                    if h is not None and op.get("h0", 0) <= 0.4 and prev and prev[1].get("h0", 0) > 0.4 and float(smod[min(j, len(smod) - 1)]) > 0.5:
                        op = prev[1]
                    if os.environ.get("GF_DUIX_DEBUG"): dbg.append(f"{j}:{op.get('h0', 0):.1f}/{float(smod[min(j, len(smod) - 1)]):.2f}")
                    for f in ([j] if prev is None else range(prev[0] + 1, j + 1)):
                        if va[min(f, len(va) - 1)] <= 0 or (vis is not None and float(vis[min(f, len(vis) - 1)][0]) <= 0.02 and va[min(f, len(va) - 1)] < 1):
                            fu = Future(); fu.set_result("bare")
                        else:
                            opf = op if prev is None else lerp_op(prev[1], op, (f - prev[0]) / max(1, j - prev[0]))
                            fu = eng.fin_pool.submit(hd.patch, clip, base_of(f, clip), None, shaped(opf, f))
                        outq.put((f, fu))
                    prev = (j, op)
            finally:
                outq.put(None); et.join()
            dt = max(1e-3, time.time() - t)
            if dn[0] >= 4: hd.fps = 0.6 * hd.fps + 0.4 * (dn[0] / dt)           # DINet keyframes / s (picks the stride)
            print(f"[gf-live] DUIX {n} mouths every frame from {dn[0]} DINet keyframes (stride {s}) in {dt:.1f}s = {dn[0] / dt:.1f}/s", flush=True)
            if dbg: print("[gf-live] DUIX keyframes h0/syllable: " + " ".join(dbg), flush=True)
            loop.call_soon_threadsafe(q.put_nowait, json.dumps({"done": True, "fps": round(hd.fps, 2), "hd": True}))

        def work():
            try:
              with hd_order:
                clip = hd.clip(av.paths[ci])
                if u.get("win_ready") is not None: u["win_ready"].wait(30)       # started at synth time (real-time DUIX)
                if "duix_win" not in u: u["duix_win"] = hd.windows(u["w16"])
                win = u["duix_win"]; n = len(u["chunks"]); t = time.time(); pend = []
                js = list(range(0, n, max(1, stride)))
                if "va" not in u:                 # silence → her own closed lips (DINet opens the mouth for silence)
                    from duix.duix_hd import voice_alpha
                    u["va"] = voice_alpha(u["w16"], av.fps, n)
                va = u["va"]
                from concurrent.futures import Future
                if getattr(eng, "fin_pool", None) is None:
                    from concurrent.futures import ThreadPoolExecutor
                    eng.fin_pool = ThreadPoolExecutor(2, thread_name_prefix="duixfin")
                if fill and hd.fill_ok(clip):
                    return work_fill(clip, win, va, n)
                # each mouth's CPU half (check, blend, JPEG) runs on 3 threads (10-20: under the battery's 20 % CPU cap one
                # thread managed ~3.5 mouths/s while the GPU could do ~10); results still go out in order
                if getattr(eng, "fin_pool", None) is None:
                    from concurrent.futures import ThreadPoolExecutor
                    eng.fin_pool = ThreadPoolExecutor(2, thread_name_prefix="duixfin")
                done_n = 0
                depth = int(os.environ.get("GF_DUIX_DEPTH", "3"))  # frames queued at the runner (10-21: 8 → 3; Melo's decoder
                for i in range(len(js) + depth):                  #   waited behind the whole queue on the shared Radeon)
                    while eng.gpu_prio.is_set() and not gone.is_set(): time.sleep(0.004)   # her next sentence's voice goes first
                    if gone.is_set():
                        for _, h, f in pend:
                            if h is not None and f.cancel(): hd.drop(h)
                        print(f"[gf-live] DUIX request dropped by the page after {done_n} of {len(js)} mouths", flush=True)
                        return
                    if i < len(js):
                        j = js[i]
                        a = min(len(win) - 1, int(round(j * 25.0 / av.fps)))
                        if bounce:                        # talking on the calm idle: follow its back-and-forth within [A, B]
                            A, B = bounce; Lb = max(1, B - A); t2 = (k0 - lo - A + j) % (2 * Lb); base = A + (t2 if t2 <= Lb else 2 * Lb - t2)
                        else:
                            base = (k0 - lo + j) % min(span, clip.n)
                        al = float(va[min(j, len(va) - 1)]) if len(va) else 1.0
                        if al <= 0:                       # silent frame: no DUIX at all, the page shows her own mouth
                            f = Future(); f.set_result("bare"); pend.append((j, None, f))
                        else:
                            h = hd.submit(clip, base, win[a])
                            pend.append((j, h, eng.fin_pool.submit(hd.finish, h, al)))
                    if pend and (len(pend) > depth or i >= len(js)):
                        jj, _, f = pend.pop(0); r = f.result(); done_n += 1
                        if r == "bare":
                            loop.call_soon_threadsafe(q.put_nowait, json.dumps({"bare": jj}))
                        elif r is not None:                       # None = a garbled frame: the page holds the last mouth
                            (x, y, w, hh), jpg = r
                            loop.call_soon_threadsafe(q.put_nowait, pack_patch(uid, jj, (x, y, w, hh), jpg))
                        else:
                            loop.call_soon_threadsafe(q.put_nowait, json.dumps({"skip": jj}))
                while pend:
                    jj, _, f = pend.pop(0); r = f.result()
                    if r == "bare":
                        loop.call_soon_threadsafe(q.put_nowait, json.dumps({"bare": jj}))
                    elif r is not None:
                        (x, y, w, hh), jpg = r
                        loop.call_soon_threadsafe(q.put_nowait, pack_patch(uid, jj, (x, y, w, hh), jpg))
                    else:
                        loop.call_soon_threadsafe(q.put_nowait, json.dumps({"skip": jj}))
                dt = max(1e-3, time.time() - t); nr = sum(1 for j in js if not len(va) or va[min(j, len(va) - 1)] > 0)
                if nr >= 4: hd.fps = 0.6 * hd.fps + 0.4 * (nr / dt)      # rendered mouths only (silent frames cost nothing)
                print(f"[gf-live] DUIX {nr} mouths + {len(js) - nr} silent (stride {stride}) in {dt:.1f}s = {nr / dt:.1f}/s", flush=True)
                loop.call_soon_threadsafe(q.put_nowait, json.dumps({"done": True, "fps": round(hd.fps, 2), "hd": True}))
            except Exception as e:
                print(f"[gf-live] DUIX patches failed: {e}", flush=True)
                loop.call_soon_threadsafe(q.put_nowait, json.dumps({"done": True, "error": str(e)}))

        threading.Thread(target=work, daemon=True).start()

        async def watch():                        # a closed socket is only noticed on receive: listen for it
            try:
                while True: await ws.receive_text()
            except Exception: gone.set()
        wt = asyncio.ensure_future(watch())
        try:
            while True:
                m = await q.get()
                if isinstance(m, str):
                    await ws.send_text(m)
                    if '"done"' in m: break
                    continue
                await ws.send_bytes(m)
        except Exception:
            gone.set()
        finally:
            wt.cancel()

    # she lives in the wallpaper for hours (user 10-21: "不能引起卡顿 … 导致电脑卡"): her engine and every helper it starts
    # (DUIX / voice runners inherit it) run at a lower CPU priority — whatever you are doing on the Mac always goes first
    try: os.nice(int(os.environ.get("GF_NICE", "8")))
    except Exception: pass
    print(f"[gf-live] listening on 127.0.0.1:{port}", flush=True)
    # exit within 1 s on SIGTERM even with pages still connected (10-20: restarts left old engines + their GPU runners alive)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", timeout_graceful_shutdown=1)


if __name__ == "__main__":
    main()
