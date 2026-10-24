"""MeloTTS with its HiFi-GAN decoder on the Radeon (10-20, user: "不行还是得 melo，请你大幅度优化 melo").

The decoder is ~90 % of MeloTTS's work (measured: text → z 0.13 s, decoder 1.4 s for a 2 s line on this CPU) and the
battery's CPU cap (CPU_Speed_Limit 20) makes it ~3× slower still. On the Radeon (Core ML fp16, pinned by
terse-gf-coreml) it takes 0.1 s per 1.9 s of audio, 46.7 dB from the CPU decoder.

  model_z.onnx                  everything before the decoder (text encoder, durations, flow) — still driven by sherpa-onnx,
                                so its front end (jieba + lexicon + number FSTs) and its per-clause batching are unchanged;
                                each batch's output is [T, z (192 × T) flattened]
  melo_dec160_fp16.mlpackage    z (1, 192, 160) → audio (1, 1, 160·512), speaker 1 baked in (sherpa-onnx feeds this model
                                its metadata speaker_id, not the sid it is given)
Longer clauses are decoded in 160-frame windows with 16 frames of context on each side (the decoder reaches ~13 frames;
90.9 dB from one long pass). sherpa-onnx's own pause shortening (GenerationConfig.silence_scale 0.2) is redone on the audio.
Build: ~/.cache/terse-gf-models/melo-split/{split.py,to_ml.py}."""
import os, queue, struct, subprocess, threading
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TC, HALO, HOP, SR = 160, 16, 512, 44100
DEC = f"melo_dec{TC}_fp16.mlpackage"


def _runner():
    return os.environ.get("GF_COREML_BIN") or next((p for p in (os.path.join(HERE, "terse-gf-coreml"),
                                                                 os.path.join(os.path.dirname(HERE), "terse-gf-coreml")) if os.path.exists(p)), None)


def front_model(melo_dir):
    """model_zp.onnx (its output also carries the phoneme timeline, 10-21) when installed, else model_z.onnx"""
    zp = os.path.join(melo_dir, "model_zp.onnx")
    return zp if os.path.exists(zp) and os.environ.get("GF_MELO_PHONES", "1") == "1" else os.path.join(melo_dir, "model_z.onnx")


PARTICLES_T1 = "呢嘛呀啦吧吗"


def lexicon(melo_dir):
    """lexicon.txt with the clause particles 呢 嘛 呀 啦 吧 吗 in tone 1 (10-21, user: "melo 的声音…不够嗲不够甜美"). Melo says
    their neutral tone short and falling, and at the end of a clause often whispered (等你呢: 0 ms voiced); in tone 1 it voices
    them in full, ~1.5–2× as long, level-to-rising: the 撒娇 ending ("等你呢~", "快来陪我嘛~"), from the model itself. Words
    ending in one with a neutral tone (好吧, 走吧, 干嘛 …) get that syllable in tone 1 too. Written once next to the original;
    GF_MELO_PARTICLES=0 → the original."""
    src = os.path.join(melo_dir, "lexicon.txt")
    if os.environ.get("GF_MELO_PARTICLES", "1") != "1": return src
    dst = os.path.join(melo_dir, "lexicon_t1.txt")
    try:
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src): return dst
        out = []
        for line in open(src, encoding="utf-8"):
            pt = line.split()
            if len(pt) >= 5 and pt[0][-1] in PARTICLES_T1 and len(pt) % 2 == 1 and pt[-1] == "5" and pt[-2] == "5":
                line = " ".join(pt[:-2] + ["1", "1"]) + "\n"           # a pinyin syllable = initial + final, one tone each
            out.append(line)
        with open(dst + ".tmp", "w", encoding="utf-8") as f: f.writelines(out)
        os.replace(dst + ".tmp", dst)
        return dst
    except OSError:
        return src


def available(melo_dir):
    return (os.environ.get("GF_MELO_GPU", "1") == "1" and _runner() is not None
            and os.path.exists(front_model(melo_dir)) and os.path.exists(os.path.join(melo_dir, DEC)))


def scale_silence(x, sr, scale=0.2, keep_mask=False):
    """sherpa-onnx GeneratedAudio::ScaleSilence: every run of |x| <= 0.01 lasting ≥ 0.2 s keeps only its first `scale` part.
    keep_mask: also return which samples were kept (the phoneme timeline moves with the shortened pauses)."""
    if scale == 1 or not len(x): return (x, np.ones(len(x), bool)) if keep_mask else x
    thr = int(sr * 0.2); q = np.abs(x) <= 0.01; N = len(x)
    d = np.diff(np.concatenate(([0], q.view(np.int8), [0])))
    keep = np.ones(N, bool)
    for s, e in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
        if (e < N and e - s >= thr) or (e == N and N - s > thr): keep[s + int((e - s) * scale):e] = False
    return (x[keep], keep) if keep_mask else x[keep]


def batches(v, phones=False):
    """one sherpa-onnx batch output = [T, z flattened] — model_zp: + [L, durations (L, z frames), token ids (L), tones (L)] —
    possibly several back to back → z (192, T) each, or (z, (ids, tones, durations) | None) with phones=True"""
    i = 0
    while i < len(v):
        T = int(round(float(v[i])))
        if T <= 0 or i + 1 + 192 * T > len(v): break
        z = v[i + 1:i + 1 + 192 * T].reshape(192, T); i += 1 + 192 * T; ph = None
        if phones and i < len(v):
            L = int(round(float(v[i])))
            if L > 0 and i + 1 + 3 * L <= len(v) and abs(float(v[i + 1:i + 1 + L].sum()) - T) < 0.5:   # durations add up to T
                d = v[i + 1:i + 1 + L]; ids = v[i + 1 + L:i + 1 + 2 * L]; tn = v[i + 1 + 2 * L:i + 1 + 3 * L]
                ph = (np.rint(ids).astype(int), np.rint(tn).astype(int), np.rint(d).astype(int)); i += 1 + 3 * L
        yield (z, ph) if phones else z


class MeloGPU:
    def __init__(self, melo_dir, num_threads=4, prio=None, runner=None):
        self.prio = prio                                   # threading.Event: "the voice needs the GPU now" (DUIX waits)
        self.runner = runner                               # callable → DuixRunner with the decoder loaded ('M'), or None
        import sherpa_onnx
        self.so = sherpa_onnx
        d = melo_dir; fst = ",".join(os.path.join(d, f) for f in ("date.fst", "number.fst") if os.path.exists(os.path.join(d, f)))
        self.front = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=front_model(d), lexicon=lexicon(d),
                tokens=os.path.join(d, "tokens.txt"), dict_dir=os.path.join(d, "dict")), num_threads=num_threads),
            rule_fsts=fst, max_num_sentences=1))
        self.lock = threading.Lock(); self.req = 0; self.p = None
        self.phones_on = front_model(d).endswith("model_zp.onnx"); self.sym = {}; self.last_phones = None
        for line in open(os.path.join(d, "tokens.txt"), encoding="utf-8"):
            pt = line.rstrip("\n").rsplit(" ", 1)
            if len(pt) == 2 and pt[1].lstrip("-").isdigit(): self.sym[int(pt[1])] = pt[0]
        r = self.runner() if self.runner else None
        if not (r is not None and getattr(r, 'melo', False)):           # no DUIX runner with the decoder: its own runner
            self.runner = None
            self.p = subprocess.Popen([_runner(), os.path.join(d, DEC)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      env=dict(os.environ, COREML_GPU=os.environ.get("GF_MELO_GPU_DEV", "amd")))
        self._dec(np.zeros((192, TC), np.float32))                  # load / compile now (first time ~15 s, then ~2 s)

    def _dec(self, zc):
        """(192, TC) → (TC·512,) on the GPU"""
        if self.runner is not None:                                    # in the DUIX process (one Core ML user of the Radeon)
            r = self.runner()
            return r.get(r.submit_m(np.ascontiguousarray(zc, np.float32)))
        with self.lock:
            self.req += 1
            a = np.ascontiguousarray(zc[None], np.float32)
            self.p.stdin.write(b"F" + struct.pack("<I", self.req) + bytes([1]) + bytes([1]) + b"z" + bytes([3])
                               + struct.pack("<III", *a.shape) + a.tobytes())
            self.p.stdin.flush()
            r = self.p.stdout; t = r.read(1)
            if t == b"E":
                n = struct.unpack("<I", r.read(4))[0]; raise RuntimeError(r.read(n).decode())
            if t != b"R": raise RuntimeError("melo decoder runner exited")
            _, n = struct.unpack("<IB", r.read(5)); out = None
            for _ in range(n):
                nl = r.read(1)[0]; r.read(nl); rank = r.read(1)[0]
                dims = struct.unpack("<" + "I" * rank, r.read(4 * rank))
                out = np.frombuffer(r.read(int(np.prod(dims)) * 4), np.float32)
            return out

    def decode(self, z):
        """z (192, T) → audio (T·512,): 160-frame windows, 16 frames of context on each side (none before the start).
        The Radeon is taken exclusively: DUIX frames in flight finish first, none start until the voice is decoded
        (10-21: concurrent GPU work from two processes corrupted DUIX frames on this Mac)."""
        if self.prio is not None: self.prio.set()
        try:
            if self.runner is not None: return self._decode(z)      # same process as DUIX: its queue runs us first
            try:
                from duix.runner_client import gpu_exclusive
            except Exception:
                gpu_exclusive = None
            if gpu_exclusive is None: return self._decode(z)
            with gpu_exclusive(): return self._decode(z)
        finally:
            if self.prio is not None: self.prio.clear()

    def _decode(self, z):
        T = z.shape[1]; out = []; s = 0
        while s < T:
            a = max(0, s - HALO)
            e = T if a + TC >= T else a + TC - HALO
            w = np.zeros((192, TC), np.float32); seg = z[:, a:a + TC]; w[:, :seg.shape[1]] = seg
            out.append(self._dec(w)[(s - a) * HOP:(e - a) * HOP]); s = e
        return np.concatenate(out) if out else np.zeros(0, np.float32)

    def generate(self, text, speed=1.0):
        """→ (float32 audio, 44100). Each clause batch is decoded on the GPU while sherpa-onnx works on the next one.
        self.last_phones: [(t0, t1, symbol, tone)] in seconds of the returned audio (model_zp), else None."""
        q, outs, err = queue.Queue(), [], []

        def work():
            while True:
                it = q.get()
                if it is None: return
                z, ph = it
                try:
                    a, keep = scale_silence(self.decode(z), SR, 0.2, keep_mask=True)
                    outs.append((a, ph, keep))
                except Exception as e: err.append(e)
        th = threading.Thread(target=work, daemon=True); th.start()

        def cb(samples, progress):
            for z, ph in batches(np.asarray(samples, np.float32), phones=self.phones_on): q.put((z.copy(), ph))
            return 1
        gc = self.so.GenerationConfig(); gc.silence_scale = 1.0; gc.speed = speed; gc.sid = 0      # z must not be "pause-shortened"
        try:
            self.front.generate(text, gc, cb)
        finally:
            q.put(None); th.join()
        if err: raise err[0]
        self.last_phones = self._timeline(outs) if self.phones_on else None
        return (np.concatenate([a for a, _, _ in outs]) if outs else np.zeros(0, np.float32)), SR

    def _timeline(self, outs):
        """per batch: token boundaries (z frames × 512 samples) → through the samples scale_silence kept → seconds, batches
        back to back. Blanks / punctuation are kept too (the viseme model treats them as transitions / pauses)."""
        ev, off = [], 0
        for a, ph, keep in outs:
            if ph is not None:
                ids, tn, d = ph; kept = np.concatenate([[0], np.cumsum(keep)])                # sample → index after the cut
                b = np.minimum(np.concatenate([[0], np.cumsum(d)]) * HOP, len(keep))
                for k in range(len(ids)):
                    t0, t1 = (off + kept[int(b[k])]) / SR, (off + kept[int(b[k + 1])]) / SR
                    if t1 > t0: ev.append((t0, t1, self.sym.get(int(ids[k]), "?"), int(tn[k])))
            off += len(a)
        return ev
