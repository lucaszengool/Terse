"""Client for terse-gf-omni (OmniVoice transformer, Core ML on a pinned GPU)."""
import os, struct, subprocess, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (128, 192, 256, 320, 384, 448, 512, 640)          # the model's enumerated sequence lengths


def bucket(n):
    for s in SIZES:
        if n <= s: return s
    raise ValueError(f'sequence {n} longer than {SIZES[-1]}')


class OmniRunner:
    def __init__(self, model, gpu='amd'):
        exe = os.environ.get('GF_OMNI_BIN') or next((p for p in (os.path.join(HERE, 'terse-gf-omni'), os.path.join(os.path.dirname(HERE), 'terse-gf-omni')) if os.path.exists(p)), 'terse-gf-omni')
        self.p = subprocess.Popen([exe, model], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=dict(os.environ, OMNI_GPU=gpu))
        self.req = 0

    def forward(self, x, lens):
        """x [B, S, 1024] float32 (S padded to a bucket), lens [B] real tokens per row → hidden [B, S, 1024] float32."""
        B, S = x.shape[:2]; self.req += 1
        xv = np.zeros((B, S, 1025), np.float32); xv[..., :1024] = x
        for b, n in enumerate(lens): xv[b, :int(n), 1024] = 1.0
        self.p.stdin.write(b'F' + struct.pack('<III', self.req, B, S) + xv.tobytes())
        self.p.stdin.flush()
        r = self.p.stdout
        while True:
            t = r.read(1)
            if not t: raise RuntimeError('omni runner exited')
            if t == b'R':
                req, n = struct.unpack('<II', r.read(8)); return np.frombuffer(r.read(n), np.float32).reshape(B, S, 1024)
            if t == b'E':
                n = struct.unpack('<I', r.read(4))[0]; raise RuntimeError(r.read(n).decode())

    def run(self, x, n):
        """one sequence of n real tokens (x [n, 1024]) → hidden [n, 1024], padded to the nearest bucket."""
        S = bucket(n); xp = np.zeros((1, S, 1024), np.float32); xp[0, :n] = x[:n]
        return self.forward(xp, [n])[0, :n]
