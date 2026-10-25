"""Client for terse-gf-duix (DUIX DINetV1 on a pinned GPU).

Two layouts (10-20):
  · whole model  — dinet_v1_fp16.mlpackage, one 'F' call per frame (432 GFLOP)
  · fast split   — duix_p_fp16 (per base frame, cached: reference encoder + alignment) and duix_d_fp16 (per spoken frame:
                   audio, AdaAT, a decoder cropped to the lower-face band) — the same pixels where the blend uses them,
                   about 2× faster on the Radeon. See split_available()."""
import struct, subprocess, sys, threading, os, numpy as np
RUNNER = os.environ.get('GF_DUIX_BIN') or next((p for p in (os.path.join(os.path.dirname(os.path.abspath(__file__)), 'terse-gf-duix'), os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'terse-gf-duix')) if os.path.exists(p)), 'terse-gf-duix')
MODELS = os.path.expanduser(os.environ.get('GF_DUIX_MODELS', '~/.terse/gf-live/models/duix'))
MODEL = os.path.join(MODELS, 'dinet_v1_fp16.mlpackage')
MODEL_P, MODEL_D = os.path.join(MODELS, 'duix_p_fp16.mlpackage'), os.path.join(MODELS, 'duix_d_fp16.mlpackage')
# Windows (no Core ML): the same protocol from ort_runner.py on ONNX Runtime (DirectML / CPU), with the ONNX graphs the
# Core ML models were converted from. GF_DUIX_ORT=1 picks it anywhere (to test the Windows path on a Mac).
ORT = os.name == 'nt' or os.environ.get('GF_DUIX_ORT') == '1'
if ORT:
    MODEL, MODEL_P, MODEL_D = (os.path.join(MODELS, f) for f in ('dinet_v1.onnx', 'duix_p.onnx', 'duix_d.onnx'))
BAND = (74, 18, 182, 212)                     # D's output: rows 74.., cols 18.. of the 256² face, 182 × 212

# 10-21: two processes computing on this Radeon at the same moment corrupt each other's results (measured: DUIX D while
# Melo's decoder ran → 4 of 40 frames garbage, pixel diff up to 244; each alone: 0 of 40). Every GPU client goes through
# here: GPU_GATE closed = no new DUIX work is sent; gpu_exclusive() waits until all DUIX work in flight has come back.
GPU_GATE = threading.Event(); GPU_GATE.set()
RUNNERS = []


class gpu_exclusive:
    """with gpu_exclusive(): — the Radeon is ours alone for the block (DUIX holds its next frame until we are done)."""
    def __init__(self, timeout=6.0): self.timeout = timeout
    def __enter__(self):
        GPU_GATE.clear()
        for r in list(RUNNERS): r.wait_idle(self.timeout)
        return self
    def __exit__(self, *a): GPU_GATE.set()


def split_available():
    return os.environ.get('GF_DUIX_SPLIT', '1') == '1' and os.path.exists(MODEL_P) and os.path.exists(MODEL_D)


MELO_DEC = os.environ.get('GF_DUIX_MELO') or os.path.expanduser('~/.terse/gf-live/models/vits-melo-tts-zh_en/melo_dec160_fp16.mlpackage')


class DuixRunner:
    def __init__(self, gpu='amd', split=None):
        self.split = split_available() if split is None else split
        cmd = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ort_runner.py')] if ORT else [RUNNER]
        args = cmd + ([MODEL_P, MODEL_D] if self.split else [MODEL])
        # MeloTTS's decoder lives in this same process on the Radeon (10-21: a second Core ML process corrupted DUIX frames)
        self.melo = bool(not ORT and self.split and gpu == 'amd' and os.path.exists(MELO_DEC) and os.environ.get('GF_DUIX_MELO_IN', '1') == '1')
        if self.melo: args.append(MELO_DEC)
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=dict(os.environ, DUIX_GPU=gpu))
        try: os.setpriority(os.PRIO_PROCESS, self.p.pid, max(os.getpriority(os.PRIO_PROCESS, 0), int(os.environ.get('GF_DUIX_NICE', '5'))))   # a little below the voice + brain (12 starved its GPU feeding when the CPU is capped)
        except Exception: pass
        self.res, self.kind, self.cv, self.wlock = {}, {}, threading.Condition(), threading.Lock()
        self.inflight = 0; self.idle = threading.Condition(); RUNNERS.append(self)
        threading.Thread(target=self._reader, daemon=True).start(); self.req = 0

    def close(self):
        """end this runner process (a fresh one replaces it after a long GPU garbage spell)"""
        try: RUNNERS.remove(self)
        except ValueError: pass
        try: self.p.stdin.close()
        except Exception: pass
        try: self.p.terminate(); self.p.wait(timeout=5)
        except Exception:
            try: self.p.kill()
            except Exception: pass
        with self.cv: self.cv.notify_all()

    def wait_idle(self, timeout=6.0):
        with self.idle:
            return self.idle.wait_for(lambda: self.inflight <= 0 or self.p.poll() is not None, timeout)

    def _reader(self):
        r = self.p.stdout
        while True:
            t = r.read(1)
            if not t: break
            if t == b'R':
                req, n = struct.unpack('<II', r.read(8)); b = r.read(n)
                with self.idle:
                    self.inflight = max(0, self.inflight - 1)
                    if self.inflight == 0: self.idle.notify_all()
                with self.cv:
                    k = self.kind.pop(req, 'F')
                    if k == 'F': v = np.frombuffer(b, np.uint8).reshape(256, 256, 3)
                    elif k == 'D': v = np.frombuffer(b, np.uint8).reshape(BAND[2], BAND[3], 3)
                    elif k == 'M': v = np.frombuffer(b, np.float32).copy()
                    else: v = (np.frombuffer(b[:512 * 32 * 32 * 2], np.float16).copy(), np.frombuffer(b[512 * 32 * 32 * 2:], np.float32).copy())
                    self.res[req] = v; self.cv.notify_all()
            elif t == b'E':
                n = struct.unpack('<I', r.read(4))[0]; print('runner error:', r.read(n).decode(), flush=True)
                with self.idle:                                   # that request will never answer
                    self.inflight = max(0, self.inflight - 1)
                    if self.inflight == 0: self.idle.notify_all()
        with self.idle: self.inflight = 0; self.idle.notify_all()

    def _send(self, kind, parts):
        if kind != 'M': GPU_GATE.wait(10.0)                       # (a GPU client outside this process has the Radeon)
        with self.idle: self.inflight += 1
        with self.wlock:
            self.req += 1; rq = self.req
            with self.cv: self.kind[rq] = kind
            self.p.stdin.write(kind.encode() + struct.pack('<I', rq) + b''.join(parts)); self.p.stdin.flush()
        return rq

    @staticmethod
    def _f32(a): return np.ascontiguousarray(a, np.float32).tobytes()

    def submit(self, src, ref, aud):
        """Whole model: masked crop, crop, audio window → 256² RGB."""
        return self._send('F', [self._f32(src), self._f32(ref), self._f32(aud)])

    def submit_p(self, src, ref):
        """Split, per base frame → (tz fp16 [512·32·32], ip float32 [256])."""
        return self._send('P', [self._f32(src), self._f32(ref)])

    def submit_m(self, z):
        """MeloTTS decoder: z float32 [192, 160] → float32 audio [81920] (44.1 kHz). Runs before queued DUIX frames."""
        return self._send('M', [self._f32(z)])

    def submit_d(self, src, aud, tz, ip):
        """Split, per spoken frame → RGB uint8 band (BAND)."""
        return self._send('D', [self._f32(src), self._f32(aud), np.ascontiguousarray(tz, np.float16).tobytes(), self._f32(ip)])

    def get(self, rq, timeout=120):
        with self.cv:
            self.cv.wait_for(lambda: rq in self.res, timeout)
            return self.res.pop(rq)
