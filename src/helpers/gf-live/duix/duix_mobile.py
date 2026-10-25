"""Real-time DUIX (10-20, user: "DUIX 必须要有,对口型实时,不消耗太多 RAM,电脑不卡,女友可以一直挂在后台").

Duix-Mobile's per-frame pipeline (Mobunet::domodel + BlendGramAlpha, duixcom/Duix-Mobile duix-sdk/src/main/cpp/dhunet),
ported line for line, running Mia's own mouth model `duix.com-mia-mouth` on the CPU through ncnn:
  box (lower face) → 168² (INTER_AREA) → inner 160²
  face  = [crop RGB | crop with rect (5,5)–(155,150) black] normalised (x − 127.5) / 127.5
  audio = DUIX WeNet BNF window [20 × 256] (duix_audio + wenet_bnf.onnx, same as DINetV1)
  out   = model → ×127.5 + 127.5 → BlendGramAlpha with the model's 160² alpha → back into the box.
The model (≈ 5 MB, fp16) is Duix-Mobile's interface trained per avatar by distillation from DUIX DINetV1 (the big
face2face model renders Mia's frames for thousands of audio windows) — the way Duix-Mobile ships per-person models.
On the GPU through Vulkan when there is one (Radeon: ~30 ms a frame even while busy, a few % of it otherwise), else two
CPU threads (15–30 ms on a cool Intel Mac); either way faster than she speaks, a few hundred MB of RAM.

Same interface as DuixHD (clip / windows / submit / finish / fps), so the engine's reactions and replies use it unchanged.
Powered by Duix.com (DUIX.COM Community License — duix/LICENSE-DUIX.COM.txt)."""
import hashlib, json, os, threading, time
import numpy as np, cv2

from . import duix_audio as A

MODELS = os.path.expanduser(os.environ.get('GF_DUIX_MODELS', '~/.terse/gf-live/models/duix'))
MOBILE = os.path.expanduser(os.environ.get('GF_DUIXM_MODEL', os.path.join(MODELS, 'mobile')))
CACHE = os.path.expanduser(os.environ.get('GF_DUIX_CACHE', '~/.terse/gf-live/cache/duix'))
NAME = 'duix.com-mia-mouth'
MEAN, NORM = 127.5, 1 / 127.5


def available():
    try:
        import ncnn  # noqa: F401
    except Exception:
        return False
    need = [os.path.join(MOBILE, f'{NAME}.ncnn.param'), os.path.join(MOBILE, f'{NAME}.ncnn.bin'), os.path.join(MOBILE, f'{NAME}.json'),
            os.path.join(MODELS, 'wenet_bnf.onnx'), os.path.join(MODELS, 'scrfd_500m_bnkps_shape640x640.onnx'),
            os.path.join(MODELS, 'pfpld_robust_sim_bs1_8003.onnx'), os.path.join(MODELS, 'mel_16k_1024_80.npy')]
    return os.environ.get('GF_DUIXM', '1') == '1' and all(os.path.exists(p) for p in need)


class MobileClip:
    """One base clip in model space: per frame the lower-face box (x, y, w, h in the frame) and the 168² BGR crop.
    Built once from DUIX's face tracking (SCRFD + PFLD → DUIX crop box), kept on disk and memory-mapped."""

    def __init__(self, path, box266, face_factory):
        st = os.stat(path)
        key = hashlib.sha1(f'{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|m1|{box266}'.encode()).hexdigest()[:16]
        self.key = key
        fc, fb = os.path.join(CACHE, key + '.m168.npy'), os.path.join(CACHE, key + '.mbox.npy')
        if not (os.path.exists(fc) and os.path.exists(fb)):
            if not self._from_duix_cache(path, st, box266, fc, fb):          # DUIX's own face-tracking cache, if present
                self._build(path, box266, face_factory, fc, fb)
        self.crops = np.load(fc, mmap_mode='r')                # [n, 168, 168, 3] uint8 BGR — paged in as needed
        self.boxes = np.load(fb)                               # [n, 4] x, y, w, h in the frame
        self.n = len(self.boxes)

    @staticmethod
    def _save(fc, fb, crops, boxes):
        os.makedirs(CACHE, exist_ok=True)
        for f, a in ((fc, np.stack(crops)), (fb, np.asarray(boxes, np.int32))):
            tmp = f'{f}.{os.getpid()}.tmp.npy'; np.save(tmp, a); os.replace(tmp, f)

    @classmethod
    def _from_duix_cache(cls, path, st, box266, fc, fb):
        """duix_hd.Clip already tracked this clip (same SCRFD + PFLD → DUIX box → 266² crops): derive from it, no tracking."""
        key = hashlib.sha1(f'{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|v1'.encode()).hexdigest()[:16]
        f = os.path.join(CACHE, key + '.npz')
        if not os.path.exists(f): return False
        try:
            d = np.load(f); crops266, boxes266 = d['crops'], d['boxes']
        except Exception:
            return False
        r0, r1, c0, c1 = box266; crops, boxes = [], []
        for c266, (y1, y2, x1, x2) in zip(crops266, boxes266):
            crops.append(cv2.resize(c266[r0:r1, c0:c1], (168, 168), interpolation=cv2.INTER_AREA))
            sy, sx = (y2 - y1) / 266.0, (x2 - x1) / 266.0
            boxes.append((int(round(x1 + c0 * sx)), int(round(y1 + r0 * sy)), max(8, int(round((c1 - c0) * sx))), max(8, int(round((r1 - r0) * sy)))))
        cls._save(fc, fb, crops, boxes)
        return True

    @staticmethod
    def _build(path, box266, face_factory, fc, fb):
        """Exactly the crops the model was trained on: DUIX's face box → 266² (as duix_hd.Clip) → the lower-face box → 168²."""
        from .duix_face import crop_box
        r0, r1, c0, c1 = box266
        face = face_factory()
        cap = cv2.VideoCapture(path); crops, boxes, last, i = [], [], None, 0
        while True:
            ok, img = cap.read()
            if not ok: break
            if last is None or i % 4 == 0:                     # SCRFD every 4th frame (the face barely moves); PFLD every frame
                b = face.detect(img); last = last if b is None else b
            lm = face.landmarks(img, last); i += 1
            y1, y2, x1, x2 = [int(v) for v in crop_box(lm)]
            y1c, x1c = max(0, y1), max(0, x1)
            crop = img[y1c:y2, x1c:x2]
            if crop.shape[0] != y2 - y1 or crop.shape[1] != x2 - x1:                     # box past the frame edge: pad
                crop = cv2.copyMakeBorder(crop, y1c - y1, (y2 - y1) - crop.shape[0] - (y1c - y1), x1c - x1,
                                          (x2 - x1) - crop.shape[1] - (x1c - x1), cv2.BORDER_REPLICATE)
            c266 = cv2.resize(crop, (266, 266), interpolation=cv2.INTER_AREA)
            crops.append(cv2.resize(c266[r0:r1, c0:c1], (168, 168), interpolation=cv2.INTER_AREA))
            sy, sx = (y2 - y1) / 266.0, (x2 - x1) / 266.0
            boxes.append((int(round(x1 + c0 * sx)), int(round(y1 + r0 * sy)), max(8, int(round((c1 - c0) * sx))), max(8, int(round((r1 - r0) * sy)))))
        MobileClip._save(fc, fb, crops, boxes)


class DuixMobile:
    split = False                                              # (DuixHD's fast-split flag — not used here)

    def __init__(self, threads=None):
        import ncnn, onnxruntime as ort
        meta = json.load(open(os.path.join(MOBILE, f'{NAME}.json')))
        self.box266 = tuple(meta['box_in_266'])                 # lower-face box inside DUIX's 266² face crop
        self.rect = tuple(meta.get('mask_rect', (5, 5, 150, 145)))
        self.alpha = np.load(os.path.join(MOBILE, f'{NAME}.alpha.npy')).astype(np.float32)[..., None]   # [160,160,1]
        self.ncnn, self.threads = ncnn, int(threads or os.environ.get('GF_DUIXM_THREADS', '2'))
        # GPU through Vulkan (ncnn's bundled MoltenVK) when there is one: this Mac's CPU is power-capped to 20 % by its
        # worn battery and the model then needs ~95 ms a frame there, ~30 ms on the Radeon even while it is busy.
        # GF_DUIXM_GPU = auto (default: ncnn's pick, the discrete GPU) | <index> | cpu
        self.gpu, self.net = None, None
        want = os.environ.get('GF_DUIXM_GPU', 'auto')
        if want != 'cpu':
            try:
                if ncnn.get_gpu_count() > 0:
                    idx = ncnn.get_default_gpu_index() if want == 'auto' else int(want)
                    self.net = self._load(idx); self.gpu = idx
            except Exception as e:
                print(f'[gf-live] DUIX mobile: no GPU ({e}), using the CPU', flush=True); self.net = None
        self.cpu_net = None
        if self.net is None: self.net = self.cpu_net = self._load(None)
        self.vk_lock = threading.Lock()                        # one GPU submission at a time (replies + reactions)
        self.pool = None
        print(f"[gf-live] DUIX mobile: {NAME} on {'GPU ' + str(self.gpu) if self.gpu is not None else 'CPU'}", flush=True)
        so = ort.SessionOptions(); so.intra_op_num_threads = 4          # a short burst per sentence: ~0.3 s for 3 s of audio
        self.wenet = ort.InferenceSession(os.path.join(MODELS, 'wenet_bnf.onnx'), so, providers=['CPUExecutionProvider'])
        self.face, self.clips, self.lock = None, {}, threading.Lock()
        self.fps = 25.0                                        # recent frames/s (the page sizes its wait from it)
        self.bad = 0
        m = np.ones((160, 160, 1), np.float32); x, y, w, h = self.rect; m[y:y + h, x:x + w] = 0
        self.keep = m                                          # 1 outside the black rectangle

    def _load(self, gpu):
        ncnn = self.ncnn
        net = ncnn.Net(); net.opt.num_threads = self.threads
        if gpu is None:
            net.opt.use_vulkan_compute = False
        else:
            net.opt.use_vulkan_compute = True; net.set_vulkan_device(gpu)
            net.opt.use_fp16_packed = net.opt.use_fp16_storage = net.opt.use_fp16_arithmetic = True
        net.load_param(os.path.join(MOBILE, f'{NAME}.ncnn.param'))
        net.load_model(os.path.join(MOBILE, f'{NAME}.ncnn.bin'))
        return net

    def _infer(self, net, face, aud):
        ex = net.create_extractor()
        ex.input('in0', self.ncnn.Mat(face)); ex.input('in1', self.ncnn.Mat(aud))
        _, out = ex.extract('out0')
        return np.array(out)

    # ── same interface as DuixHD ──
    def _face(self):
        if self.face is None:
            from .duix_face import DuixFace
            self.face = DuixFace()
        return self.face

    def clip(self, path):
        with self.lock:
            if path not in self.clips:
                t = time.time(); self.clips[path] = MobileClip(path, self.box266, self._face)
                print(f'[gf-live] DUIX mobile clip {os.path.basename(path)}: {self.clips[path].n} frames ready in {time.time() - t:.1f}s', flush=True)
            return self.clips[path]

    def windows(self, wav16k):
        bnf = self.wenet.run(None, {'feats': A.fbank(wav16k)[None]})[0][0]
        return A.windows(bnf)                                  # [frames @ 25 fps, 20, 256]

    def render(self, clip, k, win):
        """→ (x, y, w, h), JPEG of the box with her new mouth (Mobunet::domodel + BlendGramAlpha)."""
        c168 = np.array(clip.crops[k])                         # BGR
        pic = c168[4:164, 4:164]
        real = (pic[..., ::-1].astype(np.float32) - MEAN) * NORM                           # PIXEL_BGR2RGB, normalised
        masked = real * self.keep + (-1.0) * (1 - self.keep)                              # black rectangle → −1
        face = np.ascontiguousarray(np.concatenate([real, masked], 2).transpose(2, 0, 1))  # [6,160,160]
        aud = np.ascontiguousarray(np.asarray(win, np.float32).reshape(1, 20, 256))
        if self.gpu is not None:
            with self.vk_lock: o = self._infer(self.net, face, aud)
            if not (np.isfinite(o).all() and np.abs(o).max() <= 1.05):                    # tanh output: anything else is GPU noise
                self.bad += 1
                if self.cpu_net is None: self.cpu_net = self._load(None)
                o = self._infer(self.cpu_net, face, aud)
        else:
            o = self._infer(self.net, face, aud)
        o = o.transpose(1, 2, 0) * 127.5 + 127.5                                           # RGB 0..255
        o = o[..., ::-1]                                                                   # → BGR (to_pixels RGB2BGR)
        blended = o * self.alpha + pic.astype(np.float32) * (1 - self.alpha)               # BlendGramAlpha
        c168[4:164, 4:164] = blended.clip(0, 255).astype(np.uint8)
        x, y, w, h = [int(v) for v in clip.boxes[k]]
        patch = cv2.resize(c168, (w, h), interpolation=cv2.INTER_LINEAR if w > 168 else cv2.INTER_AREA)
        ok, jpg = cv2.imencode('.jpg', patch, [cv2.IMWRITE_JPEG_QUALITY, 92])
        return (x, y, w, h), jpg.tobytes()

    def submit(self, clip, k, win):
        """Two frames at once: one is prepared / blended / JPEG-encoded on the CPU while the other runs on the GPU."""
        if self.pool is None:
            from concurrent.futures import ThreadPoolExecutor
            self.pool = ThreadPoolExecutor(2, thread_name_prefix='duixm')
        return self.pool.submit(self.render, clip, k, win)

    def finish(self, h, alpha=1.0):
        # alpha: the engine's per-frame voice weight (engine.hd_patches calls finish(h, al), like DuixHD.finish). It is 1 on
        # every frame that reaches here — silent frames go out as "bare" without rendering — so the patch is the same.
        # Without the parameter every mouth of the small model failed ("finish() takes 2 positional arguments but 3 were
        # given"): she talked with her mouth still, on every PC / Intel-graphics Mac that gets this model by default.
        return h.result()

    def drop(self, h):
        """The page gave up on this frame (it re-planned the line): don't render it if it hasn't started."""
        h.cancel()

    def patch(self, clip, k, win):
        return self.render(clip, k, win)

    def warm(self, clip, ks=None):
        return 0
