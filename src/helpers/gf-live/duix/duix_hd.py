"""HD reply mode (user 10-19: "she waits and then speaks with the DUIX face"): DUIX (Duix.Avatar face2face, the engine
behind the Douyin reference) as the live engine's mouth-patch generator, native on this Mac.

Per base clip (prepared once, cached): SCRFD → PFLD → 68 landmarks → DUIX crop box → 266² face crop + blend weights.
Per utterance: 16 kHz drive audio → DUIX fbank → WeNet BNF (ONNX) → 20-frame windows (25 fps, resampled to the clip fps).
Per frame: crop → source (masked) + ref → DINetV1 on the Radeon (terse-gf-duix) → feathered lower-face blend
→ JPEG patch of the DUIX box, same wire format as the wav2lip patches (the page paints it with a soft rectangle)."""
import hashlib, os, threading, time
import numpy as np, cv2, onnxruntime as ort

from . import duix_audio as A
from . import lipwarp as LW
LW_RD = 22                                       # lipwarp.maps RD: rows below her chin the jaw drop fades over
from .duix_face import DuixFace, crop_box, face_mask
from .runner_client import DuixRunner, split_available, BAND
from .duix_guard import garbage, chroma_edges

MODELS = os.path.expanduser(os.environ.get('GF_DUIX_MODELS', '~/.terse/gf-live/models/duix'))
CACHE = os.path.expanduser(os.environ.get('GF_DUIX_CACHE', '~/.terse/gf-live/cache/duix'))


def available():
    need = ['wenet_bnf.onnx', 'scrfd_500m_bnkps_shape640x640.onnx', 'pfpld_robust_sim_bs1_8003.onnx',
            'dinet_v1_meta.npz', 'mel_16k_1024_80.npy']
    return all(os.path.exists(os.path.join(MODELS, n)) for n in need) and (
        split_available() or os.path.exists(os.path.join(MODELS, 'dinet_v1_fp16.mlpackage')))


SHARP = float(os.environ.get("GF_DUIX_SHARPEN", "0.45"))     # unsharp amount on the upscaled DUIX face (0 = off)


def voice_alpha(w16, fps, n, sr=16000, floor_db=-32.0, pre=0.10, post=0.10, ramp=0):
    """Per video frame: 1 while she speaks, 0 in silence (before / after the line, pauses ≥ 0.2 s), ramped over `ramp` frames
    (default none: a cross-fade between her lips and DINet's shows two mouths at once — "重影", user 10-21; a cut where the
    sound starts / stops reads as the mouth starting / stopping).
    10-21 (user: "口型还是很 distorted"): for silence DINet draws a relaxed open mouth with teeth (measured: exact zeros and
    −70…−40 dB noise alike), so every line opened before her first sound and snapped shut after the last. In silence the
    base clip's own closed lips are the right mouth."""
    hop = sr // 100; m = len(w16) // hop
    if m == 0 or n <= 0: return np.ones(max(0, n), np.float32)
    e = np.sqrt((np.asarray(w16[:m * hop], np.float32).reshape(m, hop) ** 2).mean(1) + 1e-12)
    act = e > np.percentile(e, 95) * 10 ** (floor_db / 20)
    t = np.arange(n) / float(fps); cs = np.concatenate([[0], np.cumsum(act)])
    lo = np.clip(np.floor((t - pre) * 100).astype(int), 0, m); hi = np.clip(np.floor((t + post) * 100).astype(int) + 1, 0, m)
    on = (cs[hi] - cs[lo]) > 0
    d = np.where(on, np.inf, 0.0)                                   # frames to the nearest silent frame
    for j in range(1, n): d[j] = min(d[j], d[j - 1] + 1)
    for j in range(n - 2, -1, -1): d[j] = min(d[j], d[j + 1] + 1)
    return np.clip(d / (ramp + 1), 0, 1).astype(np.float32)


def lip_top(img, rgb=True, S=256):
    """Top edge of her upper lip on the lips' centre columns (row in an S² face crop), or None — by colour. Only for lip_dy:
    it misses the darker top of a real upper lip, but DINet's the same way, so the difference (9.2 rows on her calm clip)
    matches what the eye sees (PFLD said 0–3.5: it regresses lips from the whole face)."""
    a = int(0.5 * S); c = img[a:int(0.92 * S), int(0.2 * S):int(0.8 * S)].astype(np.int16)
    r, g, b = (c[..., 0], c[..., 1], c[..., 2]) if rgb else (c[..., 2], c[..., 1], c[..., 0])
    m = ((r > 110) & (r - g > 50) & (r - b > 20)).astype(np.uint8)
    m[:int(0.06 * S)] = 0                                            # nose tip
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    nl, lab, st, _ = cv2.connectedComponentsWithStats(m)
    if nl < 2: return None
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    if st[i, cv2.CC_STAT_AREA] < 0.0023 * S * S: return None
    cx = st[i, 0] + st[i, 2] // 2; q = max(2, int(0.047 * S))
    rows = np.flatnonzero((lab[:, max(0, cx - q):cx + q] == i).mean(1) > 0.3)
    return float(rows.min() + a) if len(rows) else None


def syllable_mod(w16, fps, n, sr=16000, lead=0.04, win=0.15, floor=0.18):
    """Per video frame, 0..1: how open her mouth is within the syllable, from the voice itself (10-21, user: "开口的样子还是奇怪";
    measured: DINet keeps the mouth half open through whole phrases — h0 6–9 with shallow dips, closing ~1.6×/s at pauses
    only — while Chinese runs ~4–5 syllables/s; and DINet runs every 3–4 frames under the battery cap, too sparse to resolve
    syllables anyway). Loudness in 20 ms hops, led by `lead` (lips move before the sound), against the loudest point within
    ±win s: each syllable's vowel opens it, the dips between syllables close it."""
    hop = sr // 50; m = len(w16) // hop
    if m < 3 or n <= 0: return np.ones(max(0, n), np.float32)
    e = np.sqrt((np.asarray(w16[:m * hop], np.float32).reshape(m, hop) ** 2).mean(1) + 1e-12)
    e = np.convolve(e, np.array([0.25, 0.5, 0.25]), mode='same')
    w = max(1, int(round(win * 50))); pk = np.array([e[max(0, i - w):i + w + 1].max() for i in range(m)])
    r = e / np.maximum(pk, 1e-6)
    t = np.arange(n) / float(fps) + lead                                  # the frame shows where the voice is about to be
    v = np.interp(t * 50, np.arange(m), r)
    return (np.clip((v - floor) / (0.85 - floor), 0, 1) ** 0.8).astype(np.float32)


def feather_weights(mask, amount=0.1):
    """DUIX blendImages: weight = distance to the convex hull of the mask / (amount · face size), clipped to [0, 1]."""
    ys, xs = np.nonzero(mask > 127)
    w = np.zeros(mask.shape, np.float32)
    if len(xs) < 3: return w
    pts = np.stack([xs, ys], 1).astype(np.int32)
    size = (pts.max(0) - pts.min(0)).max()
    hm = np.zeros(mask.shape, np.uint8); cv2.fillConvexPoly(hm, cv2.convexHull(pts), 255)
    dist = cv2.distanceTransform((hm > 0).astype(np.uint8), cv2.DIST_L2, 5)
    w[ys, xs] = np.clip(dist[ys, xs] / max(1.0, amount * size), 0, 1)
    return w


def webp_rgba(bgra):
    """BGRA patch → WebP bytes, fast: libwebp method 0 with lossy alpha (quality 90) — 31 ms for a 534×334 mouth vs 144 ms for
    OpenCV's (lossless alpha, method 4), same colour (≈0.9 levels off); under the battery's CPU cap the encode was the bottleneck"""
    import io
    from PIL import Image
    bio = io.BytesIO()
    Image.fromarray(cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)).save(bio, 'WEBP', quality=95, method=0, alpha_quality=90)
    return bio.getvalue()


class Clip:
    """One base clip ready for DUIX: per frame the 266² crop (BGR), the box (y1, y2, x1, x2) and the blend weights."""
    def __init__(self, path, face):
        st = os.stat(path)
        key = hashlib.sha1(f'{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|v1'.encode()).hexdigest()[:16]
        f = os.path.join(CACHE, key + '.npz'); self.key = key
        cf, wf = os.path.join(CACHE, key + '.crops.npy'), os.path.join(CACHE, key + '.w16.npy')
        if os.path.exists(f) and os.path.exists(cf) and os.path.exists(wf):
            # 10-21 (she lives in the wallpaper for hours): crops + blend weights memory-mapped — in RAM only while rendered
            # (all clips loaded = ~530 MB resident before)
            self.boxes = np.load(f)['boxes']; self.crops = np.load(cf, mmap_mode='r'); self.weights = np.load(wf, mmap_mode='r')
        elif os.path.exists(f):
            d = np.load(f); crops, self.boxes = d['crops'], d['boxes']
            weights = d['weights'] if 'weights' in d.files else np.stack([feather_weights(m).astype(np.float16) for m in d['masks']])
            for path, arr in ((cf, crops), (wf, weights.astype(np.float16))):
                tmp = f'{path}.{os.getpid()}.tmp.npy'; np.save(tmp, np.ascontiguousarray(arr)); os.replace(tmp, path)
            self.crops = np.load(cf, mmap_mode='r'); self.weights = np.load(wf, mmap_mode='r')
        else:
            crops, boxes, masks, last = [], [], [], None
            cap = cv2.VideoCapture(path); i = 0
            while True:
                ok, img = cap.read()
                if not ok: break
                if last is None or i % 4 == 0:                  # SCRFD every 4th frame — the face barely moves; PFLD every frame
                    b = face.detect(img); last = last if b is None else b
                lm = face.landmarks(img, last); i += 1
                box = crop_box(lm); y1, y2, x1, x2 = [int(v) for v in box]
                y1c, x1c = max(0, y1), max(0, x1)
                crop = img[y1c:y2, x1c:x2]
                if crop.shape[0] != y2 - y1 or crop.shape[1] != x2 - x1:          # box past the frame edge: pad
                    crop = cv2.copyMakeBorder(crop, y1c - y1, (y2 - y1) - crop.shape[0] - (y1c - y1), x1c - x1,
                                              (x2 - x1) - crop.shape[1] - (x1c - x1), cv2.BORDER_REPLICATE)
                clm = (lm - np.array([x1, y1])) * 266.0 / (y2 - y1)
                crops.append(cv2.resize(crop, (266, 266), interpolation=cv2.INTER_AREA))
                boxes.append(box); masks.append(face_mask(clm))
            self.crops, self.boxes, masks = np.stack(crops), np.stack(boxes), np.stack(masks)
            self.weights = np.stack([feather_weights(m).astype(np.float16) for m in masks])
            os.makedirs(CACHE, exist_ok=True)
            np.savez_compressed(f, crops=self.crops, boxes=self.boxes, masks=masks)         # weights are rebuilt on load
        self.n = len(self.boxes)
        self.feats = None                                 # fast split: per-frame (tz, ip) cache, opened by DuixHD.feat
        self.path, self._track = path, None

    @property
    def track(self):
        """Per frame (dx, dy): where her face is relative to frame 0, sub-pixel (phase correlation over frame 0's face box).
        10-21 (user: "还是 distortion 和重影"): the landmark boxes jitter ±3 px frame to frame (sizes 386–393 on a still clip),
        and mouths drawn by the box slid against her real face. The track is the video's own motion."""
        if self._track is None:
            f = os.path.join(CACHE, self.key + '.track.npy')
            if os.path.exists(f):
                self._track = np.load(f)
            else:
                y1, y2, x1, x2 = [int(v) for v in self.boxes[0]]
                cap = cv2.VideoCapture(self.path); t, ref, win = [], None, None
                while True:
                    ok, img = cap.read()
                    if not ok: break
                    H, W = img.shape[:2]
                    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)[max(0, y1):min(H, y2), max(0, x1):min(W, x2)].astype(np.float32)
                    if ref is None: ref, win = g, cv2.createHanningWindow((g.shape[1], g.shape[0]), cv2.CV_32F); t.append((0.0, 0.0)); continue
                    (dx, dy), _ = cv2.phaseCorrelate(ref, g, win); t.append((dx, dy))
                self._track = np.asarray(t, np.float32).reshape(-1, 2)
                if len(self._track) != self.n or np.abs(self._track).max() > 40: self._track = np.zeros((self.n, 2), np.float32)
                os.makedirs(CACHE, exist_ok=True); np.save(f, self._track)
        return self._track


class DuixHD:
    def __init__(self):
        so = ort.SessionOptions(); so.intra_op_num_threads = 2   # 10-20: with Melo + DUIX + brain on a 20%-capped CPU, more threads only thrash
        self.wenet = ort.InferenceSession(os.path.join(MODELS, 'wenet_bnf.onnx'), so, providers=['CPUExecutionProvider'])
        self.input_mask = np.load(os.path.join(MODELS, 'dinet_v1_meta.npz'))['input_mask'].astype(np.float32)[None]   # [1,256,256]
        self.mask128 = cv2.resize(self.input_mask[0], (128, 128), interpolation=cv2.INTER_NEAREST)
        self.face = None
        self.split = split_available()                   # fast split (10-20): per-base-frame half cached, cropped decoder
        self.runner = DuixRunner(os.environ.get('DUIX_GPU', 'amd'), self.split)
        self.cpu_runner, self.bad = None, 0                  # CPU fallback, started on the first frame the GPU garbles twice
        self.clips, self.lock = {}, threading.Lock()
        self.ref_edges = {}                              # (clip, frame) → the reference's chroma-edge energy (guard)
        self.fps = 10.0 if self.split else 4.0           # recent DUIX frames/s (the page sizes its wait from it; ~14/s on the Radeon, 10-20)

    def reset_runner(self):
        """a long GPU garbage spell (the hot / power-capped Radeon returns noise frame after frame, 10-21: a 4.5 s render froze
        on one mouth for 250 s): a fresh runner process clears it; per-frame halves are on disk, nothing is lost"""
        old = self.runner
        t = time.time(); self.runner = DuixRunner(os.environ.get('DUIX_GPU', 'amd'), self.split)
        try: old.close()
        except Exception: pass
        self.bad_streak = 0
        print(f'[gf-live] DUIX: GPU garbage spell — runner restarted in {time.time() - t:.1f}s', flush=True)

    def clip(self, path):
        with self.lock:
            if path not in self.clips:
                if self.face is None: self.face = DuixFace()
                t = time.time(); self.clips[path] = Clip(path, self.face)
                print(f'[gf-live] DUIX clip {os.path.basename(path)}: {self.clips[path].n} frames ready in {time.time() - t:.1f}s', flush=True)
            return self.clips[path]

    def windows(self, wav16k):
        bnf = self.wenet.run(None, {'feats': A.fbank(wav16k)[None]})[0][0]
        return A.windows(bnf)                                                # [frames @25 fps, 20, 256]

    def patch(self, clip, k, win):
        """→ (box x1, y1, w, h), JPEG bytes. Synchronous (one frame); use submit/finish to pipeline."""
        return self.finish(self.submit(clip, k, win))

    TZN = 512 * 32 * 32                              # one row per base frame: tz (fp16) | ip (float32 as 512 fp16) | done flag

    def _open_feats(self, clip):
        """Per-clip disk cache of the fast split's per-base-frame half — computed once per frame of her clips, ever.
        One file, created atomically (setup's --prepare and a running engine may fill it at the same time); a row's flag is
        written after its data, so a reader never takes a half-written row."""
        if clip.feats is None:
            os.makedirs(CACHE, exist_ok=True)
            f, shape = os.path.join(CACHE, clip.key + '.fast1.npy'), (clip.n, self.TZN + 512 + 8)
            a = None
            if os.path.exists(f):
                try:
                    a = np.load(f, mmap_mode='r+')
                    if a.shape != shape or a.dtype != np.float16: a = None
                except Exception: a = None
            if a is None:
                tmp = f'{f}.{os.getpid()}.tmp'
                np.lib.format.open_memmap(tmp, 'w+', np.float16, shape).flush()
                os.replace(tmp, f); a = np.load(f, mmap_mode='r+')
            clip.feats = a
        return clip.feats

    @staticmethod
    def _sane(tz, ip):
        """A hot Radeon can garble P's output too (10-20: one cached row held inf — that frame's mouth was noise on every
        retry). Normal rows: finite, max |tz| ≈ 70. A garbled row is never cached."""
        return bool(np.isfinite(ip).all() and np.isfinite(tz).all() and np.abs(tz).max() < 160)

    def _put(self, a, k, tz, ip):
        if not self._sane(tz, ip): return False
        a[k, :self.TZN] = tz; a[k, self.TZN:self.TZN + 512] = np.ascontiguousarray(ip, np.float32).view(np.float16); a[k, -1] = 1
        return True

    def _get(self, a, k):
        return a[k, :self.TZN], np.ascontiguousarray(a[k, self.TZN:self.TZN + 512]).view(np.float32)

    def feat(self, clip, k, runner=None, fresh=False):
        """→ (tz, ip) for base frame k: from the cache, else computed (GPU twice, then the CPU) and cached."""
        a = self._open_feats(clip)
        if a[k, -1] == 1 and not fresh:
            tz, ip = self._get(a, k)
            if self._sane(tz, ip): return tz, ip
            a[k, -1] = 0                                                      # a bad row from before: recompute
        rt = os.environ.get("GF_DUIX_CPU_FALLBACK", "0") != "1"
        runners = [runner] if runner else ([self.runner, self.runner] if rt else [self.runner, self.runner, None])   # None = the CPU
        for r in runners:
            r = r or self._cpu()
            tz, ip = r.get(r.submit_p(*self._inputs(clip, k)))
            if self._put(a, k, tz, ip): return self._get(a, k)
        print(f'[gf-live] DUIX features k={k} stayed garbled', flush=True)
        return tz, ip

    def _cpu(self):
        with self.lock:
            if self.cpu_runner is None: self.cpu_runner = DuixRunner('cpu', self.split)
        return self.cpu_runner

    def warm(self, clip, ks=None):
        """Fill a clip's cache ahead of time (setup / after start) — 4 in flight. ks: which frames (default all)."""
        if not self.split: return 0
        a = self._open_feats(clip); pend = []
        todo = [k for k in (range(clip.n) if ks is None else ks) if 0 <= k < clip.n and a[k, -1] != 1]
        for k in todo + [None] * 4:
            if k is not None: pend.append((k, self.runner.submit_p(*self._inputs(clip, k))))
            if pend and (len(pend) > 4 or k is None):
                kk, rq = pend.pop(0); self._put(a, kk, *self.runner.get(rq))       # a garbled row stays unflagged: feat() redoes it
        if todo: a.flush()
        return len(todo)

    def _inputs(self, clip, k):
        c256 = cv2.resize(clip.crops[k], (256, 256), interpolation=cv2.INTER_AREA)[..., ::-1].astype(np.float32) / 255
        ref = c256.transpose(2, 0, 1)
        return ref * self.input_mask, ref

    def submit(self, clip, k, win):
        src, ref = self._inputs(clip, k)
        if self.split:
            tz, ip = self.feat(clip, k)
            inp = (src, ref, win.T, tz, ip)
            return (self.runner.submit_d(src, win.T, tz, ip), clip, k, inp)
        inp = (src, ref, win.T)
        return (self.runner.submit(*inp), clip, k, inp)

    def _out(self, runner, inp, rq=None):
        """→ RGB uint8 256² (split: the decoder's band pasted into the reference face — the blend only uses the band)."""
        if len(inp) == 5:
            src, ref, aud, tz, ip = inp
            band = runner.get(rq if rq is not None else runner.submit_d(src, aud, tz, ip))
            if band is None: return None
            full = (ref.transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8)
            y, x, h, w = BAND; full[y:y + h, x:x + w] = band
            return full
        return runner.get(rq if rq is not None else runner.submit(*inp))

    def drop(self, h):
        """The page gave up on this frame (it re-planned the line): take the runner's answer and throw it away."""
        try: self.runner.get(h[0], timeout=30)
        except Exception: pass

    def lip_dy(self, clip):
        """How far below her real lips DINet draws them, in 256-px face rows (10-21, calm clip: 9.2 — it puts the mouth where an
        average face has it; her philtrum is short). Unshifted, the mouth sat visibly low. Calibrated per clip from its first
        ~24 spoken mouths, kept on disk; until then the last calibration of any clip."""
        st = self.__dict__.get('_lipdy')
        if st is None:
            import json
            try: st = json.load(open(os.path.join(CACHE, 'lipdy.json')))
            except Exception: st = {}
            self._lipdy = st
        if clip.key in st: return st[clip.key]
        v = [x for x in st.values() if isinstance(x, (int, float))]
        return float(np.median(v)) if v else float(os.environ.get('GF_DUIX_LIP_DY', '0'))

    def _lip_sample(self, clip, k, out):
        self.lip_dy(clip); st = self._lipdy
        if clip.key in st: return
        g = lip_top(out, rgb=True)
        bt = self.__dict__.setdefault('_lip_base', {}).get((clip.key, k))
        if bt is None:
            bt = lip_top(np.asarray(clip.crops[k]), rgb=False, S=266)
            bt = self._lip_base[(clip.key, k)] = (bt * 256 / 266) if bt is not None else -1.0
        if g is None or bt < 0: return
        s = self.__dict__.setdefault('_lip_samples', {}).setdefault(clip.key, []); s.append(g - bt)
        if len(s) >= 24:
            import json
            st[clip.key] = float(np.clip(np.median(s), -6, 18)); self._lip_samples.pop(clip.key, None)
            try:
                tmp = os.path.join(CACHE, f'lipdy.json.{os.getpid()}.tmp'); json.dump(st, open(tmp, 'w')); os.replace(tmp, os.path.join(CACHE, 'lipdy.json'))
            except Exception: pass
            print(f'[gf-live] DUIX lips of {clip.key}: drawn {st[clip.key]:+.1f} rows from hers → shifted back', flush=True)

    LIPWARP = os.environ.get("GF_DUIX_LIPWARP", "1") == "1"

    def hires(self, clip):
        """Her mouth region at the video's own resolution, per frame: the patch rectangle sub() of each frame's box, resampled to
        one size (SW × SH). The warped lips come from these pixels — the 266² crops hold her face at ~0.68 of the video's size,
        warped lips from them looked softer than her lips at idle. Built once per clip (decodes the clip), memory-mapped."""
        if getattr(clip, '_hr', None) is not None: return clip._hr
        nx, ny, nw, nh = self.sub(clip)
        b = np.asarray(clip.boxes, np.float32); B = float(np.median(b[:, 1] - b[:, 0]))
        SW, SH = int(round(nw * B)), int(round(nh * B))
        tag = hashlib.sha1(np.round(np.array([nx, ny, nw, nh]), 4).tobytes()).hexdigest()[:8]
        f = os.path.join(CACHE, f'{clip.key}.mhr2_{SW}x{SH}.{tag}.npy')
        if not os.path.exists(f):
            # decoded exactly as the browser shows the clip (10-21: OpenCV's decode is BT.601 — her skin came out ~2.5 L*
            # darker than the video on screen, a shadow around the mouth; ffmpeg BT.709 + accurate rounding = Chrome's ±0.1)
            import subprocess
            W, H = int(cv2.VideoCapture(clip.path).get(cv2.CAP_PROP_FRAME_WIDTH)), int(cv2.VideoCapture(clip.path).get(cv2.CAP_PROP_FRAME_HEIGHT))
            dec = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-i', clip.path, '-an', '-vf',
                                    'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int+bitexact,format=bgr24',
                                    '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
            out = np.zeros((clip.n, SH, SW, 3), np.uint8)
            for k in range(clip.n):
                buf = dec.stdout.read(W * H * 3)
                if len(buf) < W * H * 3: break
                img = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
                y1, y2, x1, x2 = [float(v) for v in clip.boxes[k]]; bw, bh = x2 - x1, y2 - y1
                ax, ay = nw * bw / SW, nh * bh / SH                    # output pixel centre → frame pixel centre
                M = np.float32([[ax, 0, x1 + nx * bw + 0.5 * ax - 0.5], [0, ay, y1 + ny * bh + 0.5 * ay - 0.5]])
                out[k] = cv2.warpAffine(img, M, (SW, SH), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
            dec.stdout.close(); dec.wait()
            os.makedirs(CACHE, exist_ok=True); tmp = f'{f}.{os.getpid()}.tmp.npy'; np.save(tmp, out); os.replace(tmp, f)
        clip._hr = np.load(f, mmap_mode='r')
        return clip._hr

    def native(self, clip):
        """Her mouth region at the video's own pixels, never resampled (10-21, user: "张嘴说话的时候周围有阴影…看上去只有嘴唇动的
        丝滑"): one fixed rectangle of frame coordinates holding every frame's patch rectangle + a margin, per frame, decoded
        once as the browser shows the clip (ffmpeg BT.709, accurate rounding), memory-mapped. → (frames, RX0, RY0)"""
        if getattr(clip, '_nat', None) is not None: return clip._nat
        nx, ny, nw, nh = self.sub(clip); b = np.asarray(clip.boxes, np.float64)
        bw, bh = b[:, 3] - b[:, 2], b[:, 1] - b[:, 0]; M = 40
        cap = cv2.VideoCapture(clip.path); W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); cap.release()
        RX0 = max(0, int(np.floor((b[:, 2] + nx * bw).min())) - M); RY0 = max(0, int(np.floor((b[:, 0] + ny * bh).min())) - M)
        RX1 = min(W, int(np.ceil((b[:, 2] + (nx + nw) * bw).max())) + M); RY1 = min(H, int(np.ceil((b[:, 0] + (ny + nh) * bh).max())) + M)
        RW, RH = RX1 - RX0, RY1 - RY0
        f = os.path.join(CACHE, f'{clip.key}.nat_{RX0}_{RY0}_{RW}x{RH}.npy')
        if not os.path.exists(f):
            import subprocess
            dec = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-i', clip.path, '-an', '-vf',
                                    'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int+bitexact,'
                                    f'format=bgr24,crop={RW}:{RH}:{RX0}:{RY0}', '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
            out = np.zeros((clip.n, RH, RW, 3), np.uint8)
            for k in range(clip.n):
                buf = dec.stdout.read(RW * RH * 3)
                if len(buf) < RW * RH * 3: break
                out[k] = np.frombuffer(buf, np.uint8).reshape(RH, RW, 3)
            dec.stdout.close(); dec.wait()
            os.makedirs(CACHE, exist_ok=True); tmp = f'{f}.{os.getpid()}.tmp.npy'; np.save(tmp, out); os.replace(tmp, f)
        clip._nat = (np.load(f, mmap_mode='r'), RX0, RY0)
        return clip._nat

    def _teeth(self, clip):
        """Her real open mouth for the inside of the warped lips: <clip>.teeth.png (a wide-open frame of a talking take of her,
        aligned to the clip's frame 0 and cut to the patch rectangle at full resolution) + <clip>.teeth.json (its opening per
        column in 256² rows: X, top, bot). 10-21 (user: "牙齿太奇怪了"): DINet invents teeth from her closed-mouth reference —
        jagged, flickering. → (BGR image, {X, top, bot}) or None."""
        cache = self.__dict__.setdefault('_teethc', {})
        if clip.key not in cache:
            v = None
            try:
                import json
                png, js = clip.path + '.teeth.png', clip.path + '.teeth.json'
                if os.path.exists(png) and os.path.exists(js):
                    g = json.load(open(js)); img = cv2.imread(png, cv2.IMREAD_COLOR)
                    if img is not None: v = (img, {k: np.asarray(g[k], np.float64) for k in ('X', 'top', 'bot')})
            except Exception as e: print(f'[gf-live] teeth for {os.path.basename(clip.path)} unreadable: {e}', flush=True)
            cache[clip.key] = v
        return cache[clip.key]

    def _cavity(self, clip):
        """the colour of her mouth's dark inside (BGR float): the darker part of the talking take's opening, median"""
        cache = self.__dict__.setdefault('_cav', {})
        if clip.key not in cache:
            c = np.array([38.0, 30.0, 52.0], np.float32)
            t = self._teeth(clip)
            if t:
                img, g = t; TH, TW = img.shape[:2]; nx, ny, nw, nh = self.sub(clip)
                m = np.zeros((TH, TW), bool)
                for x, a, b in zip(g['X'], g['top'], g['bot']):
                    u = int(((x + 0.5) / 256 - nx) / nw * TW); v0 = int(((a + 0.5) / 256 - ny) / nh * TH); v1 = int(((b + 0.5) / 256 - ny) / nh * TH)
                    if 0 <= u < TW: m[max(0, v0):min(TH, v1), max(0, u - 2):u + 3] = True
                px = img[m].astype(np.float32)
                if len(px) > 50:
                    L = px.mean(1); dark = px[L <= np.percentile(L, 35)]
                    if len(dark): c = np.median(dark, 0).astype(np.float32)
            cache[clip.key] = c
        return cache[clip.key]

    def _lip_geo(self, clip, k):
        """her lips in base frame k (lipwarp geometry + the redness threshold), cached"""
        cache = self.__dict__.setdefault('_lipgeo', {})
        if (clip.key, k) not in cache:
            b = cv2.resize(np.asarray(clip.crops[k]), (256, 256), interpolation=cv2.INTER_AREA)
            t = self.__dict__.setdefault('_lipthr', {}).get(clip.key)
            if t is None: t = self._lipthr[clip.key] = LW.threshold(b)
            cache[(clip.key, k)] = (t, LW.base_geometry(b, t))
        return cache[(clip.key, k)]

    def lip_open(self, clip, k, out):
        """DINet's output (256² RGB) → its opening (lipwarp.opening, on her mouth's geometry in base frame k), or None"""
        t, gb = self._lip_geo(clip, k)
        if gb is None: return None
        gen = np.roll(np.ascontiguousarray(out[..., ::-1]), -int(round(self.lip_dy(clip))), 0)     # BGR, DINet's mouth on hers
        op = LW.opening(gen, t, gb)
        if op is None: return None
        if not self._teeth(clip): op['gen'] = gen                                       # no teeth of hers: DINet's inside
        # DINet's lips are ~10 % narrower than hers even closed: its width is taken against its own closed width (per clip,
        # from its first closed mouths), not against hers
        w = op['xr'] - op['xl']; ref = self.__dict__.setdefault('_dinet_w', {}); smp = self.__dict__.setdefault('_dinet_ws', {}).setdefault(clip.key, [])
        if op['h0'] < 1.0 and len(smp) < 64: smp.append(w)
        if len(smp) >= 6: ref[clip.key] = float(np.median(smp))
        op['sx'] = w / ref[clip.key] if clip.key in ref else 1.0
        return op

    def _lipwarp_patch(self, clip, k, out):
        op = self.lip_open(clip, k, out)
        return None if op is None else self.lip_render(clip, k, op)

    def _grid(self, clip, sw, sh):
        """patch pixel → 256² position (XX, YY), the same in the working window (wx, wy), and the window's own grid — cached"""
        cache = self.__dict__.setdefault('_grids', {}); key = (clip.key, sw, sh)
        if key not in cache:
            nx, ny, nw, nh = self.sub(clip)
            X = (nx + (np.arange(sw, dtype=np.float32) + 0.5) / sw * nw) * 256 - 0.5
            Y = (ny + (np.arange(sh, dtype=np.float32) + 0.5) / sh * nh) * 256 - 0.5
            XX, YY = np.meshgrid(X, Y); yy, xx = np.mgrid[LW.Y0:LW.Y1, LW.X0:LW.X1].astype(np.float32)
            cache[key] = (XX, YY, XX - LW.X0, YY - LW.Y0, yy, xx)
        return cache[key]

    def lip_render(self, clip, k, op):
        """→ (uint8 BGRA, px0, py0) or None: her frame-k mouth region warped open as op says (her lips, chin and the skin around
        them all her own pixels, her real teeth / dark inside), on frame k's own pixel grid — top-left at frame pixel (px0, py0).
        10-21 (user: "张嘴说话的时候周围有阴影…看上去只有嘴唇动的丝滑"): sampled ONCE from the video's own pixels (native()) —
        where the warp moves nothing a patch pixel is an exact copy of the video's. The old path resampled her 3× (4K → hires
        crop → warp → sub-pixel shift) and the page 2× more: her skin around the lips came out softer than the video (72–90 % of
        its fine detail), a smudged ring wherever the patch showed. Alpha: where the warp moves her ≥ ~0.1 px or her mouth is
        open, × the lip oval (the hd mask) — complete, the page draws it as is."""
        t, gb = self._lip_geo(clip, k)
        if gb is None: return None
        teeth = self._teeth(clip)                         # her real open mouth (a talking take of her), else DINet's
        mx, my, gx, gy, edges = LW.maps(gb, op, RD=LW_RD, src=teeth[1] if teeth else None)
        nx, ny, nw, nh = self.sub(clip)
        y1, y2, x1, x2 = (float(v) for v in clip.boxes[k]); bw, bh = x2 - x1, y2 - y1; s_x, s_y = bw / 256.0, bh / 256.0
        px0, py0 = int(round(x1 + nx * bw)), int(round(y1 + ny * bh)); sw, sh = max(8, int(round(nw * bw))), max(8, int(round(nh * bh)))
        X1 = (np.arange(sw, dtype=np.float32) + px0 + 0.5 - x1) / s_x - 0.5                # 256² position of each patch pixel
        Y1 = (np.arange(sh, dtype=np.float32) + py0 + 0.5 - y1) / s_y - 0.5
        XX, YY = np.meshgrid(X1, Y1); yy, xx = np.mgrid[LW.Y0:LW.Y1, LW.X0:LW.X1].astype(np.float32)
        D = cv2.remap(np.dstack([mx - xx, my - yy, gx - xx, gy - yy]).astype(np.float32), XX - LW.X0, YY - LW.Y0, cv2.INTER_LINEAR,
                      borderMode=cv2.BORDER_REPLICATE)
        nat, RX0, RY0 = self.native(clip)
        ux = (np.arange(sw, dtype=np.float32)[None] + (px0 - RX0)) + D[..., 0] * s_x            # D = 0 → this very pixel of hers
        uy = (np.arange(sh, dtype=np.float32)[:, None] + (py0 - RY0)) + D[..., 1] * s_y
        her = cv2.remap(np.asarray(nat[k]), ux.astype(np.float32), uy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        aw = np.clip((np.hypot(D[..., 0] * s_x, D[..., 1] * s_y) - 0.1) / 0.5, 0, 1)        # where the warp moves her (frame px)
        # the open mouth's outline at this patch's own resolution, anti-aliased (≥ 0.45 rows of 256² of soft edge)
        ub = np.interp(X1, edges['x'], edges['ub']); lt = np.interp(X1, edges['x'], edges['lt'])
        on = np.interp(X1, edges['x'], edges['on']) > 0.5; px = max(0.45, 1.0 / s_y)
        a = (np.clip((YY - ub[None]) / px + 0.5, 0, 1) * np.clip((lt[None] - YY) / px + 0.5, 0, 1) * on[None]).astype(np.float32)
        tv = np.interp(X1, edges['x'], edges.get('tv', np.ones_like(edges['x'])))[None].astype(np.float32)   # teeth showing
        rows = np.flatnonzero(a.max(1) > 0.01)
        if len(rows) and teeth:                           # only the band where her mouth is open
            r0, r1 = rows[0], rows[-1] + 1; cols = np.flatnonzero(a[r0:r1].max(0) > 0.01); c0, c1 = cols[0], cols[-1] + 1
            ti = teeth[0]; TH, TW = ti.shape[:2]; gxs, gys = XX[r0:r1, c0:c1] + D[r0:r1, c0:c1, 2], YY[r0:r1, c0:c1] + D[r0:r1, c0:c1, 3]
            ut = ((gxs + 0.5) / 256 - nx) / nw * TW - 0.5; vt = ((gys + 0.5) / 256 - ny) / nh * TH - 0.5
            ins = cv2.remap(ti, ut.astype(np.float32), vt.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
            # opened wider than the take, its dark middle is stretched (lipwarp.maps): there a vertically softened copy of it —
            # stretched rows of tooth glints / tongue texture read as vertical streaks
            st = np.gradient(gys, axis=0) / max(1e-6, float(np.median(np.gradient(YY[r0:r1, c0:c1], axis=0))))
            ws = np.clip((0.85 - st) / 0.35, 0, 1)[..., None]
            if ws.max() > 0.01:
                tb = self.__dict__.setdefault('_teeth_soft', {})
                if clip.key not in tb: tb[clip.key] = cv2.GaussianBlur(ti, (0, 0), sigmaX=2.0, sigmaY=9.0)
                insb = cv2.remap(tb[clip.key], ut.astype(np.float32), vt.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
                ins = ins * (1 - ws) + insb * ws
            # below her upper teeth the inside is in shadow (the tongue): the take's lower teeth / lip glints there read as
            # bright specks in a wide-open mouth — half-way to the dark of her mouth
            g_ = teeth[1]; tsx = np.interp(gxs, g_['X'], g_['top']); bsx = np.interp(gxs, g_['X'], g_['bot'])
            lw_ = np.clip((gys - (tsx + 0.55 * np.maximum(bsx - 2.5 - tsx, 2.0))) / 2.0, 0, 1)[..., None]
            ins = ins * (1 - 0.5 * lw_) + self._cavity(clip)[None, None] * (0.5 * lw_)
            # a small or rounded opening is a soft dark cavity (her teeth deep in shadow), the teeth come in as she opens; a soft
            # shadow under her upper lip. (10-21: squeezed into a slit the take's teeth + dark read as hard white / black lines)
            cav = self._cavity(clip); t_ = tv[:, c0:c1, None]
            ins = ins * t_ + cav[None, None] * (1 - t_)
            sh_ = np.clip((YY[r0:r1, c0:c1] - ub[None, c0:c1]) / 1.6, 0, 1)[..., None]; ins *= 0.78 + 0.22 * sh_ * sh_ * (3 - 2 * sh_)
            # her lower lip's inner edge sits in shadow too: the take's lower teeth tips there read as white specks along it
            lo_ = np.clip((YY[r0:r1, c0:c1] - (lt[None, c0:c1] - 2.5)) / 2.5, 0, 1)[..., None]; lo_ = 0.6 * lo_ * lo_ * (3 - 2 * lo_)
            ins = ins * (1 - lo_) + cav[None, None] * lo_
            ab = a[r0:r1, c0:c1, None]
            her[r0:r1, c0:c1] = (her[r0:r1, c0:c1].astype(np.float32) * (1 - ab) + ins * ab).clip(0, 255).astype(np.uint8)
        elif len(rows) and op.get('gen') is not None:
            ins = cv2.remap(op['gen'], XX + D[..., 2], YY + D[..., 3], cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            # DINet's teeth are jagged at 256², with dark gaps that read as holes in a narrow opening: smooth along the mouth
            ins = cv2.GaussianBlur(cv2.medianBlur(ins, 3), (0, 0), sigmaX=max(1.0, 0.011 * sw), sigmaY=0.5)
            her = (her.astype(np.float32) * (1 - a[..., None]) + ins.astype(np.float32) * a[..., None]).clip(0, 255).astype(np.uint8)
        al = cv2.GaussianBlur(np.maximum(aw * aw * (3 - 2 * aw), a), (0, 0), 1.2)
        oc = self.__dict__.setdefault('_ovals', {})
        if (clip.key, sw, sh) not in oc: oc[(clip.key, sw, sh)] = cv2.resize(self.mask(clip, 64).astype(np.float32) / 255, (sw, sh), interpolation=cv2.INTER_LINEAR)
        ov = oc[(clip.key, sw, sh)]
        return np.dstack([her, (al * ov * 255).clip(0, 255).astype(np.uint8)]), px0, py0          # BGRA

    LIP_COLOUR = float(os.environ.get("GF_DUIX_LIP_COLOUR", "0.7"))

    def _lip_colour(self, clip, o, c):
        """Her lips' own colour on DINet's lips (BGR float patches, same size). 10-21 (user: "distortion"): DINet draws them ~20
        L* darker than hers (measured over a whole line: ΔLab ≈ +21, −1.5, +1.5), so every switch between her own mouth (silence)
        and the generated one flashed. Mean Lab of the lip-coloured pixels, smoothed per clip, LIP_COLOUR of the difference."""
        if self.LIP_COLOUR <= 0: return o
        lip = lambda im: (im[..., 2] > 100) & (im[..., 2] - im[..., 1] > 40) & (im[..., 2] - im[..., 0] > 15)
        mo, mc = lip(o), lip(c)
        if mo.sum() < 0.01 * mo.size or mc.sum() < 0.01 * mc.size: d = None
        else:
            lo = cv2.cvtColor(o.clip(0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
            lc = cv2.cvtColor(c.clip(0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
            d = lc[mc].mean(0) - lo[mo].mean(0)
        st = self.__dict__.setdefault('_lipcol', {})
        e = st.get(clip.key)
        if d is not None: e = d if e is None else 0.85 * e + 0.15 * d; st[clip.key] = e
        if e is None: return o
        if d is None: lo = cv2.cvtColor(o.clip(0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
        soft = cv2.GaussianBlur(mo.astype(np.float32), (0, 0), 1.5)[..., None]
        return cv2.cvtColor((lo + soft * (self.LIP_COLOUR * e)).clip(0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR).astype(np.float32)

    def finish(self, h, alpha=1.0):
        """a submitted frame → its patch ((x, y, w, h), JPEG) or None (GPU noise: the page holds the last mouth)"""
        out = self.dinet_out(h)
        return None if out is None else self.patch(h[1], h[2], out=out, alpha=alpha)

    def fill_ok(self, clip):
        """can this clip's mouths be drawn every frame from openings alone (her lips + her teeth, no DINet pixels)?"""
        try: return bool(self.LIPWARP and self._teeth(clip) and self._lip_geo(clip, 0)[1] is not None)
        except Exception: return False

    def finish_open(self, h):
        """fill mode (her lips warped every frame, DINet on keyframes): a keyframe's opening (lipwarp) or None (garbled)"""
        out = self.dinet_out(h)
        if out is None: return None
        clip, k = h[1], h[2]
        self._lip_sample(clip, k, out)
        try: return self.lip_open(clip, k, out)
        except Exception as e:
            if not getattr(self, '_lw_err', False): self._lw_err = True; print(f'[gf-live] DUIX lip opening failed: {e}', flush=True)
            return None

    def dinet_out(self, h, persist=False):
        """DINet's mouth for a submitted frame (256² RGB); GPU noise retried once, then None. persist (the 流式数字人 videos,
        which wait for every frame anyway): up to 3 retries and no "bad spell" cut-off — a held / missing mouth there showed
        as a second mouth for a frame (user 10-21: "嘴动起来的时候还是有点重影")"""
        rq, clip, k, inp = h
        out = self._out(self.runner, inp, rq)
        tries = 0
        # the garbage check runs at half resolution (10-20: 4× less CPU per mouth; GPU noise is ~25× the threshold anyway)
        ek = (clip.key, k)
        if ek not in self.ref_edges:
            r128 = cv2.resize(inp[1].transpose(1, 2, 0), (128, 128), interpolation=cv2.INTER_AREA)
            self.ref_edges[ek] = (r128.transpose(2, 0, 1).copy(), chroma_edges(r128, self.mask128))
        r128, e128 = self.ref_edges[ek]
        bad = lambda o: garbage(cv2.resize(o, (128, 128), interpolation=cv2.INTER_AREA), r128, self.mask128, e128)
        # real time (10-21): never the CPU fallback here — at ~5 s/frame it stalled whole replies when the hot / power-capped
        # Radeon garbled a few frames in a row. One GPU retry with fresh features, then that one frame keeps the clip's mouth.
        realtime = os.environ.get("GF_DUIX_CPU_FALLBACK", "0") != "1"
        while out is not None and bad(out):                                  # never let GPU noise reach the screen
            self.bad += 1; tries += 1; self.bad_streak = getattr(self, "bad_streak", 0) + 1
            if persist:
                if tries > 3: out = None; break
                time.sleep(0.02 * tries); out = self._out(self.runner, inp); continue
            if self.bad_streak > 3: out = None; break                        # a bad GPU spell: no retries (they double the
            if tries == 1:                                                   #  work), hold the mouth until frames are clean
                out = self._out(self.runner, inp)                            #  half was checked when it was cached)
            elif tries == 2 and not realtime:                                # offline renders: the CPU (slow, never garbles)
                cpu = self._cpu()
                if self.split: inp = inp[:3] + self.feat(clip, k, runner=cpu, fresh=True)
                out = self._out(cpu, inp)
            else: out = None                                                 # give up: this frame keeps the clip's own mouth
        if out is not None and not tries: self.bad_streak = 0
        if tries: print(f'[gf-live] DUIX garbage frame k={k}: {"fixed after " + str(tries) + " retries" if out is not None else "held the last mouth"}', flush=True)
        return out

    def patch(self, clip, k, out=None, op=None, alpha=1.0):
        """base frame k's mouth patch: from DINet's output (out), or — op — her lips warped to that opening (fill mode's
        in-between frames, no DINet). → ((x, y, w, h) in frame 0's coordinates, JPEG bytes) or None"""
        y1, y2, x1, x2 = [int(v) for v in clip.boxes[k]]
        # 10-21 (user: "DUIX 有时模糊、扭曲"): her face is ~390 px in the video but DUIX draws 256² — one bicubic upscale straight
        # to the box (was 256 → 266 → box, two bilinear passes) plus a light unsharp mask, blended at box resolution. The page
        # only shows the lower face of the patch (hd_mask); everything above comes from the live video.
        bw, bh = x2 - x1, y2 - y1
        # 10-21: only the rectangle around her lips is resized / blended / encoded (the page shows nothing else of the patch):
        # ~8× fewer pixels than the whole face box — under the battery's CPU cap the per-mouth CPU work was what fell behind
        nx, ny, nw, nh = self.sub(clip)
        sx, sy = int(round(nx * bw)), int(round(ny * bh)); sw, sh = max(8, int(round(nw * bw))), max(8, int(round(nh * bh)))
        def region(img, S, oy=0):
            a0, b0 = int(np.floor(ny * S)), int(np.floor(nx * S)); a1, b1 = int(np.ceil((ny + nh) * S)), int(np.ceil((nx + nw) * S))
            a0, a1 = max(0, a0), min(S, a1); oy = max(-a0, min(S - a1, oy))
            return img[a0 + oy:a1 + oy, max(0, b0):min(S, b1)]
        patch = None
        if op is not None or self.LIPWARP:                # her own lips: fill mode's opening, or DINet's (lipwarp.py)
            if op is None and alpha >= 0.999: self._lip_sample(clip, k, out)
            try: r = self.lip_render(clip, k, op) if op is not None else self._lipwarp_patch(clip, k, out)
            except Exception as e:
                r = None
                if not getattr(self, '_lw_err', False): self._lw_err = True; print(f'[gf-live] DUIX lip warp failed: {e}', flush=True)
            if r is not None:
                # frame k's own pixel grid, placed in frame 0's coordinates (the page adds the track of the frame on screen) with a
                # sub-pixel position: nothing is shifted or rescaled to land it (GFP2)
                bgra, px0, py0 = r; tx, ty = (float(v) for v in clip.track[k]) if k < len(clip.track) else (0.0, 0.0)
                ys, xs = np.nonzero(bgra[..., 3] > 0)                 # only what shows (~⅔ of the rectangle)
                if not len(xs): return None
                c0, c1, r0, r1 = max(0, xs.min() - 2), min(bgra.shape[1], xs.max() + 3), max(0, ys.min() - 2), min(bgra.shape[0], ys.max() + 3)
                bgra = bgra[r0:r1, c0:c1]
                return (float(px0 + c0 - tx), float(py0 + r0 - ty), bgra.shape[1], bgra.shape[0]), webp_rgba(bgra)
            if op is not None: return None
        elif alpha >= 0.999: self._lip_sample(clip, k, out)
        if patch is None:                                 # DINet's own lips (colour-matched to hers)
            # her lips where hers are: DINet's mouth taken lip_dy rows lower (the whole generated face moves up with it)
            o = cv2.resize(region(out[..., ::-1], 256, int(round(self.lip_dy(clip)))), (sw, sh), interpolation=cv2.INTER_CUBIC).astype(np.float32)
            o = cv2.addWeighted(o, 1.0 + SHARP, cv2.GaussianBlur(o, (0, 0), 1.1), -SHARP, 0)
            c = cv2.resize(region(np.asarray(clip.crops[k]), 266), (sw, sh), interpolation=cv2.INTER_LINEAR).astype(np.float32)
            o = self._lip_colour(clip, o, c)
            w = cv2.resize(region(np.asarray(clip.weights[k], np.float32), 266), (sw, sh), interpolation=cv2.INTER_LINEAR)[..., None]
            if alpha < 1: w = w * float(alpha)                         # into / out of a silence: towards her own lips
            patch = (o * w + c * (1 - w)).clip(0, 255).astype(np.uint8)
        # position in frame 0's coordinates (the page adds the track of the frame on screen): sub-pixel exact, no box jitter
        tx, ty = (float(v) for v in clip.track[k]) if k < len(clip.track) else (0.0, 0.0)
        X, Y = x1 + sx - tx, y1 + sy - ty; ix, iy = int(np.floor(X)), int(np.floor(Y))
        if X - ix > 0.02 or Y - iy > 0.02:
            patch = cv2.warpAffine(patch, np.float32([[1, 0, X - ix], [0, 1, Y - iy]]), (sw, sh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        if patch.ndim == 3 and patch.shape[2] == 4:      # her lips with their own alpha (fill mode): WebP keeps it
            ok, buf = cv2.imencode('.webp', patch, [cv2.IMWRITE_WEBP_QUALITY, 95])
            return (ix, iy, sw, sh), buf.tobytes()
        ok, jpg = cv2.imencode('.jpg', patch, [cv2.IMWRITE_JPEG_QUALITY, 93])                     # BGR in, standard JPEG out
        return (ix, iy, sw, sh), jpg.tobytes()

    def _face(self):
        with self.lock:
            if self.face is None: self.face = DuixFace()
        return self.face

    def _crop_lm(self, img, key):
        """68 landmarks of a face crop (S² BGR, crop pixels). SCRFD finds no face in a crop this tight, so it is padded; the box
        (found on the clip's first crop of that size) is kept for the clip — her lips and DINet's are measured the same way."""
        S = img.shape[0]; p = S // 2
        P = cv2.copyMakeBorder(np.ascontiguousarray(img), p, p, p, p, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        boxes = self.__dict__.setdefault('_lmbox', {}); b = boxes.get((key, S))
        if b is None:
            b = self._face().detect(P)
            if b is None: return None
            boxes[(key, S)] = b
        return self._face().landmarks(P, b) - p

    def lips(self, clip):
        """Her face's 68 landmarks in box coordinates (0..1), median over the clip's crops — or None.
        10-21 (user: "嘴像裂痕"): the colour rule the mask used before missed the darker top half of her upper lip, so the mask's
        top edge ran through the lip — her own upper-lip edge showed next to DINet's, like a crack."""
        cache = self.__dict__.setdefault('_lips', {})
        if clip.key not in cache:
            L = [l / 266.0 for l in (self._crop_lm(np.asarray(clip.crops[k]), clip.key) for k in range(0, clip.n, max(1, clip.n // 8))) if l is not None]
            cache[clip.key] = np.median(np.stack(L), 0) if len(L) >= 3 else None
        return cache[clip.key]

    def oval(self, clip):
        """Her lips in box coordinates (cx, cy, rx, ry) + the highest the mouth may reach (just under her nose), cached per clip.
        From the landmarks (outer lip contour 48–59, nose 33), else by colour."""
        cache = self.__dict__.setdefault('_ovals', {})
        if clip.key in cache: return cache[clip.key]
        lm = None
        try: lm = self.lips(clip)
        except Exception as e: print(f'[gf-live] DUIX lip landmarks failed: {e}', flush=True)
        if lm is not None:
            o = lm[48:60]; x1, x2 = o[:, 0].min(), o[:, 0].max(); y1, y2 = o[:, 1].min(), o[:, 1].max(); h = y2 - y1
            # wide enough for DINet's corners (they sit a little wider / lower), tall enough for her jaw to drop
            ov = ((x1 + x2) / 2, (y1 + y2) / 2 + 0.2 * h, 0.5 * (x2 - x1) * 1.4, 0.5 * h * 2.6)
            self.__dict__.setdefault('_tops', {})[clip.key] = (float(lm[33, 1]), float(y1))      # nose bottom, lip top
            cache[clip.key] = tuple(float(v) for v in ov)
            return cache[clip.key]
        boxes = []
        for k in range(0, clip.n, max(1, clip.n // 24)):
            c = np.asarray(clip.crops[k]).astype(np.int16); b, g, r = c[..., 0], c[..., 1], c[..., 2]
            lips = ((r > 110) & (r - g > 45) & (r - b > 15)).astype(np.uint8)
            lips[:135] = 0; lips[:, :55] = 0; lips[:, 211:] = 0; lips[230:] = 0
            lips = cv2.morphologyEx(lips, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            nl, _, st, _ = cv2.connectedComponentsWithStats(lips)
            if nl < 2: continue
            i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA])); x, y, w, h, a = st[i]
            if a >= 150: boxes.append((x, y, x + w, y + h))
        if len(boxes) >= 4:
            x1, y1, x2, y2 = np.median(np.array(boxes, np.float32), 0) / 266.0
            ov = ((x1 + x2) / 2, (y1 + y2) / 2 + 0.25 * (y2 - y1), 0.5 * (x2 - x1) * 1.45, 0.5 * (y2 - y1) * 2.3)
        else:
            ov = (0.5, 0.67, 0.18, 0.12)
        cache[clip.key] = tuple(float(v) for v in ov)
        return cache[clip.key]

    def _chin(self, clip):
        """her mouth's centre column and her chin there (box coordinates) — the lip warp moves the jaw; None without it"""
        if not self.LIPWARP or LW.CHIN <= 0: return None   # her jaw stays put (user 10-21): the patch is her lips only
        try: _, gb = self._lip_geo(clip, 0)
        except Exception: gb = None
        if gb is None: return None
        cxb = (gb['xl'] + gb['xr']) / 2
        return cxb / 256, float(np.polyval(gb['chin_p'], cxb)) / 256, (gb['xr'] - gb['xl']) / 2 / 256, float(np.interp(cxb, gb['xs'], gb['lb'])) / 256

    def sub(self, clip):
        """The rectangle the patch covers (box coordinates nx, ny, nw, nh): the lip oval with its soft edge — down over her chin
        when the lip warp moves her jaw (the region it moves, + its fade below the chin)."""
        cache = self.__dict__.setdefault('_subs', {})
        if clip.key in cache: return cache[clip.key]
        cx, cy, rx, ry = self.oval(clip)
        x0, y0 = max(0.0, cx - 1.25 * rx), max(0.0, cy - 1.25 * ry); x1, y1 = min(1.0, cx + 1.25 * rx), min(1.0, cy + 1.25 * ry)
        ch = self._chin(clip)
        if ch is not None:                                # + the jaw's full width under her chin (lipwarp: flat to 0.9×, gone at 1.7×)
            y1 = min(1.0, max(y1, ch[1] + (LW_RD + 6) / 256)); x0 = max(0.0, min(x0, ch[0] - 1.8 * ch[2])); x1 = min(1.0, max(x1, ch[0] + 1.8 * ch[2]))
        cache[clip.key] = (x0, y0, x1 - x0, y1 - y0)
        return cache[clip.key]

    def mask(self, clip, size=64):
        """Alpha over the patch rectangle (sub()): a soft oval around her lips — only the mouth comes from DUIX."""
        cx, cy, rx, ry = self.oval(clip); nx, ny, nw, nh = self.sub(clip)
        yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
        xx = nx + (xx + 0.5) / size * nw; yy = ny + (yy + 0.5) / size * nh
        rxe = rx * (1 - 0.35 * np.clip((yy - cy) / ry, 0, 1))              # egg-shaped: narrower towards her chin
        d = np.sqrt(((xx - cx) / rxe) ** 2 + ((yy - cy) / ry) ** 2)         # 1 at the oval's edge
        m = np.clip((1.18 - d) / 0.36, 0, 1); m = m * m * (3 - 2 * m)      # soft edge from d 0.82 → 1.18
        # never up to her nose: DINet's nostrils sit elsewhere (and move with lip_dy) — zero just under the nose, full over her
        # whole upper lip (10-21: the old top edge crossed it and both lip edges showed: "裂痕")
        tops = self.__dict__.get('_tops', {}).get(clip.key)
        if tops is not None:
            nose, top = tops; a, b = nose + 0.012, max(nose + 0.024, top - 0.012)
            u = np.clip((yy - a) / (b - a), 0, 1); m = m * (u * u * (3 - 2 * u))
        # and well inside her jaw line: DINet redraws the jaw edge too (its own, moved with the lips by lip_dy) — a dark streak
        # along her right jaw ("裂痕"). The landmark face hull runs past her real jaw, so the margin comes from the pixels: her
        # skin vs the dark hair around it (Otsu on the lower face, convex), ≥ 6 px (266²) inside.
        ks = range(0, clip.n, max(1, clip.n // 8))
        g = np.mean([cv2.cvtColor(np.asarray(clip.crops[i]), cv2.COLOR_BGR2GRAY).astype(np.float32) for i in ks], 0)
        lower = g[120:250, 30:236].astype(np.uint8)
        t, _ = cv2.threshold(lower, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        skin = (g > t).astype(np.uint8)
        cs, _ = cv2.findContours(skin, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)    # her face's outline: convex (hair strands
        face = np.zeros_like(skin)                                                   # across a cheek / the dark lips don't cut it)
        if cs: cv2.fillConvexPoly(face, cv2.convexHull(max(cs, key=cv2.contourArea)), 1)
        dist = cv2.distanceTransform(face, cv2.DIST_L2, 5)
        ds = cv2.remap(dist, (xx * 266 - 0.5).astype(np.float32), (yy * 266 - 0.5).astype(np.float32), cv2.INTER_LINEAR)
        j = np.clip((ds - 6) / 10, 0, 1); m = m * (j * j * (3 - 2 * j))
        # the lip warp also moves her jaw (her own pixels, the displacement fading out below the chin): that region too —
        # over her chin line, which the face-outline margin above keeps the lip oval away from
        ch = self._chin(clip)
        if ch is not None:
            ccx, cchin, chw, clb = ch
            wv = np.clip((yy - clb) / 0.03, 0, 1) * np.clip((cchin + (LW_RD + 4) / 256 - yy) / (10 / 256), 0, 1)
            wl = np.clip((1.75 * chw - np.abs(xx - ccx)) / (0.5 * chw), 0, 1); mc = wv * wl; mc = mc * mc * (3 - 2 * mc)
            m = np.maximum(m, mc)
        return (m * 255).astype(np.uint8)
