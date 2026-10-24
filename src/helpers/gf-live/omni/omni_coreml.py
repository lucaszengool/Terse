"""OmniVoice fast mode on the Radeon: Core ML models A (full pass + KV) and B (target tokens vs cached prefix), fixed
shapes (enumerated shapes ran 3-5x slower on this GPU). Real lengths are padded; the validity channel / meta masks
the padding. Plugs into omni_fast as a backend."""
import os, struct, subprocess, threading
import numpy as np, torch

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.expanduser(os.environ.get('GF_OMNI_MODELS', '~/.terse/gf-live/models/omnivoice'))


class CoreMLProc:
    """terse-gf-coreml client (one model per process)."""
    def __init__(self, model):
        exe = os.environ.get('GF_COREML_BIN') or next((p for p in (os.path.join(HERE, 'terse-gf-coreml'), os.path.join(os.path.dirname(HERE), 'terse-gf-coreml')) if os.path.exists(p)), 'terse-gf-coreml')
        self.p = subprocess.Popen([exe, model], stdin=subprocess.PIPE, stdout=subprocess.PIPE); self.req = 0

    @staticmethod
    def _enc(name, a):
        a = np.ascontiguousarray(a, np.float32); nb = name.encode()
        return bytes([len(nb)]) + nb + bytes([a.ndim]) + b''.join(struct.pack('<I', d) for d in a.shape) + a.tobytes()

    def store(self, **arrays):
        self.p.stdin.write(b'K' + bytes([len(arrays)]) + b''.join(self._enc(k, v) for k, v in arrays.items())); self.p.stdin.flush()

    def run(self, **arrays):
        self.req += 1
        self.p.stdin.write(b'F' + struct.pack('<I', self.req) + bytes([len(arrays)]) + b''.join(self._enc(k, v) for k, v in arrays.items()))
        self.p.stdin.flush()
        r = self.p.stdout
        t = r.read(1)
        if t == b'E':
            n = struct.unpack('<I', r.read(4))[0]; raise RuntimeError(r.read(n).decode())
        if t != b'R': raise RuntimeError('coreml runner exited')
        _, n = struct.unpack('<IB', r.read(5)); out = {}
        for _ in range(n):
            nl = r.read(1)[0]; name = r.read(nl).decode(); rank = r.read(1)[0]
            dims = struct.unpack('<' + 'I' * rank, r.read(4 * rank))
            out[name] = np.frombuffer(r.read(int(np.prod(dims)) * 4), np.float32).reshape(dims)
        return out


class CoreMLBackend:
    def __init__(self, a_len=640, b_shape=(512, 256)):
        self.SA, (self.PB, self.TB) = a_len, b_shape
        self.A = CoreMLProc(os.path.join(MODELS, f'omni_A{a_len}.mlpackage'))
        self.B = CoreMLProc(os.path.join(MODELS, f'omni_B{b_shape[0]}x{b_shape[1]}.mlpackage'))

    def prefix(self, x):                                       # x [L, 1024] torch → hidden [L, 1024], kv [56, 8, L, 128]
        L = x.shape[0]
        if L > self.SA: raise ValueError(f'sequence {L} > {self.SA}')
        xv = np.zeros((1, self.SA, 1025), np.float32); xv[0, :L, :1024] = x.numpy(); xv[0, :L, 1024] = 1
        o = self.A.run(x=xv)
        return torch.from_numpy(o['h'][0, :L].copy()), torch.from_numpy(o['kv'][:, :, :L].copy())

    def target(self, xc, xu, kv, P):                           # → [2, T, 1024]
        T = xc.shape[0]
        if P > self.PB or T > self.TB: raise ValueError(f'prefix {P} / target {T} > {self.PB} / {self.TB}')
        key = (kv.data_ptr(), P)
        if getattr(self, '_kv_key', None) != key:              # new cache (refresh): ship it once, the runner keeps it
            kvp = np.zeros((56, 8, self.PB, 128), np.float32); kvp[:, :, :P] = kv.numpy()
            self.B.store(kv=kvp); self._kv_key = key
        xt = np.zeros((2, self.TB, 1025), np.float32)
        xt[0, :T, :1024] = xc.numpy(); xt[1, :T, :1024] = xu.numpy(); xt[:, :T, 1024] = 1
        meta = np.zeros((2, self.PB + 1), np.float32); meta[0, :P] = 1; meta[0, self.PB] = P
        return torch.from_numpy(self.B.run(x=xt, meta=meta)['h'][:, :T].copy())


class _FastRunner:
    """One terse-gf-omnifast process = one size bucket (A at S_A, B at P_B × T_B); model A's prefix keys / values stay
    in it (no 117 MB round trip per refresh) and only target embeds / hidden states cross the pipe."""
    def __init__(self, a_len=640, b_shape=(512, 256)):
        self.SA, (self.PB, self.TB) = a_len, b_shape
        exe = os.environ.get('GF_OMNIFAST_BIN') or next((p for p in (os.path.join(HERE, 'terse-gf-omnifast'), os.path.join(os.path.dirname(HERE), 'terse-gf-omnifast')) if os.path.exists(p)), 'terse-gf-omnifast')
        self.p = subprocess.Popen([exe, os.path.join(MODELS, f'omni_A{a_len}.mlpackage'), os.path.join(MODELS, f'omni_B{b_shape[0]}x{b_shape[1]}.mlpackage')],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.req, self.P = 0, None

    def _reply(self):
        r = self.p.stdout; t = r.read(1)
        if t == b'E':
            n = struct.unpack('<I', r.read(4))[0]; raise RuntimeError(r.read(n).decode())
        if t != b'R': raise RuntimeError('omnifast runner exited')
        _, n = struct.unpack('<II', r.read(8))
        return r.read(n)

    def prefix(self, x, P=None):                               # keeps kv[:, :, :P] runner-side; returns (None, P)
        L = x.shape[0]; P = L if P is None else P
        if L > self.SA or P > self.PB: raise ValueError(f'sequence {L} / prefix {P} > {self.SA} / {self.PB}')
        xv = np.zeros((1, self.SA, 1025), np.float32); xv[0, :L, :1024] = x.numpy(); xv[0, :L, 1024] = 1
        self.req += 1
        self.p.stdin.write(b'A' + struct.pack('<II', self.req, P) + xv.tobytes()); self.p.stdin.flush()
        self._reply(); self.P = P
        return None, P

    def target(self, xc, xu, kv, P):                           # kv: ignored (resident) → [2, T, 1024]
        T = xc.shape[0]
        if P != self.P or T > self.TB: raise ValueError(f'prefix {P} (cached {self.P}) / target {T} > {self.TB}')
        xt = np.zeros((2, self.TB, 1025), np.float32)
        xt[0, :T, :1024] = xc.numpy(); xt[1, :T, :1024] = xu.numpy(); xt[:, :T, 1024] = 1
        meta = np.zeros((2, self.PB + 1), np.float32); meta[0, :P] = 1; meta[0, self.PB] = P
        self.req += 1
        self.p.stdin.write(b'B' + struct.pack('<I', self.req) + xt.tobytes() + meta.tobytes()); self.p.stdin.flush()
        return torch.from_numpy(np.frombuffer(self._reply(), np.float32).reshape(2, self.TB, 1024)[:, :T].copy())


class FastRunnerBackend:
    """Fast-mode backend over size buckets: each utterance runs on the smallest (A, B) pair that fits its prefix /
    target lengths (padding is paid in full on the GPU — a short chat line padded to T 256 costs ~2× its T 128 run).
    Buckets = the model files present; runners start on first use and stay up."""
    resident_kv = True
    BUCKETS = [(512, 384, 128), (640, 512, 256)]                # (S_A, P_B, T_B), smallest first

    def __init__(self, buckets=None):
        have = lambda a, p, t: all(os.path.exists(os.path.join(MODELS, f)) for f in (f'omni_A{a}.mlpackage', f'omni_B{p}x{t}.mlpackage'))
        self.buckets = [b for b in (buckets or self.BUCKETS) if have(*b)]
        if not self.buckets: raise FileNotFoundError(f'no OmniVoice Core ML models in {MODELS}')
        self.runners, self.cur = {}, None

    def prefix(self, x, P):
        L = x.shape[0]; T = L - P
        b = next((b for b in self.buckets if L <= b[0] and P <= b[1] and T <= b[2]), None)
        if b is None: raise ValueError(f'utterance too long for the fast models (prefix {P}, target {T})')
        if b not in self.runners: self.runners[b] = _FastRunner(b[0], (b[1], b[2]))
        self.cur = self.runners[b]
        return self.cur.prefix(x, P)

    def target(self, xc, xu, kv, P):
        return self.cur.target(xc, xu, kv, P)
