"""The repo's 流式数字人, step for step (beiyege-01/dsh-voice-ai-girlfriend README §八 + bridge/voice_bridge.py; user 10-21:
"你看它怎么对口型用DUIX的，严格按照一样的步骤"):
  · a reply is cut into segments — sentence first, ≤ 48 characters (split_segments = its _split_segments, verbatim)
  · each segment's voice → one DUIX face2face video of her avatar (my_avatar.mp4: a talking video of her, 1080p 15 fps — the
    repo's 提速技巧; chaofen 0), the audio muxed in, so lips and voice play as one file
  · while a segment renders, the next segment's voice is synthesised (the caller's pipeline)
DUIX's face2face steps (duix_render.py, recovered 10-19 from its service): every output frame is an avatar frame — the avatar
loops forward then back from frame 0 — with DINet's lower face for the audio at that instant, the reference being that very
frame (her real open mouth / teeth in the avatar: what makes DUIX look seamless), DUIX's face mask feathered by distance to its
hull. Here the blend is done at the box's own resolution (DUIX resamples the whole box through 266² — the face outside the
mask came out softer); DINet runs split on the Radeon (per-frame half cached once)."""
import os, re, subprocess, threading, time
import numpy as np, cv2


def split_segments(text, max_len=48):
    """把文本按标点切成语义完整的段 (voice_bridge._split_segments): sentences (。！？!?；;) accumulated up to max_len; a single
    sentence longer than that is cut inside, after the nearest secondary mark (，、：；:,. ) or hard at max_len"""
    parts = re.split(r"(?<=[。！？!?；;])", text)
    sentences = [p.strip() for p in parts if p.strip()]
    out, cur = [], [""]

    def flush():
        if cur[0].strip(): out.append(cur[0].strip())
        cur[0] = ""
    for sent in sentences:
        while len(sent) > max_len:
            head = sent[:max_len]
            pos = max((head.rfind(c) for c in "，、：；:,. "), default=-1)
            cut = pos + 1 if pos > 0 else max_len
            piece = head[:cut].strip()
            if piece:
                if cur[0]: flush()
                out.append(piece)
            sent = sent[cut:].strip()
            if not sent: break
        if cur[0] and len(cur[0]) + len(sent) > max_len: flush()
        cur[0] += sent
    flush()
    return out


class Segmenter:
    """split_segments over a reply that arrives sentence by sentence (her LLM streams): the same segments as splitting the
    whole reply, each released as soon as the next sentence shows it is complete. first_max (10-21, user: "as fast as
    possible"): the first segment closes at that length — she starts on a short first video while the rest renders"""
    def __init__(self, max_len=48, first_max=None):
        self.max_len, self.first_max, self.cur, self.n = max_len, first_max or max_len, "", 0

    def _lim(self):
        return self.first_max if self.n == 0 else self.max_len

    def add(self, sentence):
        out = []
        for s in split_segments(sentence, 10 ** 6): out += self._add(s)              # its sentences
        return out

    def _add(self, s):
        out, lim = [], self._lim()
        if len(s) > lim:                                  # a sentence too long for one segment: the repo's in-sentence cut,
            out += self.flush()                           # the rest goes on accumulating like any sentence
            head = split_segments(s, lim)[0]; i = s.find(head); rest = s[(i if i >= 0 else 0) + len(head):].strip()
            self.n += 1; out.append(head)
            return out + (self._add(rest) if rest else [])
        if self.cur and len(self.cur) + len(s) > lim: out += self.flush()
        self.cur += s
        if self.n == 0 and len(self.cur) >= self.first_max: out += self.flush()
        return out

    def flush(self):
        s, self.cur = self.cur.strip(), ""
        if s: self.n += 1
        return [s] if s else []


class DHVideo:
    """her avatar, ready for face2face: the DUIX face data (Clip: boxes, masks, feather weights), every frame kept as JPEG
    (~40 MB for 151 frames at 1080p, decoded per use — not 0.9 GB of raw frames in RAM)"""
    def __init__(self, hd, avatar, prio=None):
        self.hd, self.path, self.prio = hd, avatar, prio             # prio: "her voice needs the GPU now" (DUIX waits)
        self.clip = hd.clip(avatar)
        cap = cv2.VideoCapture(avatar); self.fps = cap.get(cv2.CAP_PROP_FPS) or 15.0
        # every frame as raw I420 (YUV 4:2:0, exactly as decoded — no colour conversion), memory-mapped from the DUIX cache: the
        # frame needs no decode per use and goes to the encoder as is (10-21: JPEG decode + the BGR→YUV conversion cost ~100 ms
        # a frame on the power-capped CPU); only the face box is converted, blended and converted back
        from duix.duix_hd import CACHE
        cap.release()
        p = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', avatar],
                           capture_output=True, text=True).stdout.strip().split(',')
        self.w, self.h = int(p[0]), int(p[1])
        st = os.stat(avatar); f = os.path.join(CACHE, f'{self.clip.key}.i420_{self.w}x{self.h}_{st.st_size}.npy')
        if not os.path.exists(f):
            raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', avatar, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], capture_output=True, check=True).stdout
            arr = np.frombuffer(raw, np.uint8).reshape(-1, self.h * 3 // 2, self.w)
            tmp = f'{f}.{os.getpid()}.tmp.npy'; np.save(tmp, arr); os.replace(tmp, f)
        self.yuv = np.load(f, mmap_mode='r')
        self.n = min(len(self.yuv), self.clip.n)
        self.lock = threading.Lock()

    def warm(self, chunk=None, busy=None):
        """everything a reply would otherwise compute on first use, done when her avatar loads: DINet's per-frame half for
        every avatar frame (cached on disk by DuixHD) and her closed mouth on every avatar frame — silent stretches reuse it,
        no GPU (saved next to the clip's other DUIX caches, so it survives restarts). chunk / busy (a gesture clip warmed in
        the background): `chunk` frames at a time, waiting while busy() — a reply rendering has the GPU first"""
        from duix.duix_hd import CACHE
        hd, clip = self.hd, self.clip; t = time.time()
        def wait():
            while busy is not None and busy(): time.sleep(0.2)
        step = chunk or self.n; n = 0
        for c in range(0, self.n, step):
            wait(); n += hd.warm(clip, range(c, min(self.n, c + step))) or 0
        f = os.path.join(CACHE, f'{clip.key}.silent.npy'); sc = self.__dict__.setdefault('_silent', {})
        if os.path.exists(f):
            arr = np.load(f)
            for k in range(min(len(arr), self.n)): sc[k] = arr[k]
        else:
            win = hd.windows(np.zeros(16000, np.float32)); w0 = win[len(win) // 2]
            with self.lock:
                pend = []; bad = 0
                for i, k in enumerate(list(range(self.n)) + [None] * 4):
                    if k is not None and chunk and i % chunk == 0 and not pend: wait()
                    if k is not None: pend.append((k, hd.submit(clip, k, w0)))
                    if pend and (len(pend) > 4 or k is None):
                        kk, h = pend.pop(0); out = hd.dinet_out(h, persist=True)
                        if out is not None: sc[kk] = out; bad = 0
                        else:
                            bad += 1
                            if bad >= 4:                      # a GPU garbage spell (as in _run): a fresh runner, the frames in flight again
                                hd.reset_runner(); bad = 0
                                pend = [(q[0], hd.submit(clip, q[0], w0)) for q in pend]
                                out = hd.dinet_out(hd.submit(clip, kk, w0), persist=True)
                                if out is not None: sc[kk] = out
            missing = [k for k in range(self.n) if k not in sc]
            if missing and len(missing) <= self.n // 3:       # a few still garbled: once more, one at a time
                for k in missing:
                    wait(); out = hd.dinet_out(hd.submit(clip, k, w0), persist=True)
                    if out is not None: sc[k] = out
            if len(sc) == self.n:
                tmp = f'{f}.{os.getpid()}.tmp.npy'; np.save(tmp, np.stack([sc[k] for k in range(self.n)])); os.replace(tmp, f)
        print(f'[gf-live] 数字人 warm: {n} frame halves, {len(sc)} closed mouths in {time.time() - t:.1f}s', flush=True)

    def frame(self, k):
        """avatar frame k as a writable I420 array (h·3/2 × w)"""
        return np.array(self.yuv[k])

    def cycle(self):
        n = self.n
        return list(range(n)) + list(range(n - 1, -1, -1))                       # DUIX loops forward then back

    SHARP = float(os.environ.get('GF_DH_SHARP', '0.6'))       # unsharp amount on DINet's redrawn mouth (256² → the box)

    def _roi(self, k):
        """frame k: the face box (y1, y2, x1, x2) and, inside it, the even-aligned rectangle the feathered mask reaches"""
        rc = self.__dict__.setdefault('_rois', {})
        if k not in rc:
            y1, y2, x1, x2 = [int(v) for v in self.clip.boxes[k]]
            wk = np.asarray(self.clip.weights[k], np.float32); ys, xs = np.nonzero(wk > 0.004)
            if not len(xs): rc[k] = None
            else:
                sx, sy = (x2 - x1) / wk.shape[1], (y2 - y1) / wk.shape[0]
                X1, X2 = x1 + int(np.floor(xs.min() * sx)) - 2, x1 + int(np.ceil((xs.max() + 1) * sx)) + 2
                Y1, Y2 = y1 + int(np.floor(ys.min() * sy)) - 2, y1 + int(np.ceil((ys.max() + 1) * sy)) + 2
                X1, Y1 = max(0, X1) & ~1, max(0, Y1) & ~1; X2, Y2 = min(self.w, (X2 + 1) & ~1), min(self.h, (Y2 + 1) & ~1)
                rc[k] = ((y1, y2, x1, x2), (Y1, Y2, X1, X2))
        return rc[k]

    def _blend(self, k, out, yuv):
        """DINet's 256² face into avatar frame k (I420, in place): bicubic to the box + a light unsharp mask (DINet draws the
        mouth soft — its own paper: mouth texture is hard to learn from audio; stretched ×2.4 linearly it read blurry /
        doubled, user 10-21), blended through DUIX's feathered face mask at the box's own resolution — only inside the
        rectangle the mask reaches, converted to BGR with OpenCV's own matrix (the one DINet's input crops were decoded with)"""
        r = self._roi(k)
        if r is None: return yuv
        (y1, y2, x1, x2), (Y1, Y2, X1, X2) = r
        bw, bh = x2 - x1, y2 - y1; H, W = self.h, self.w
        o = cv2.resize(out[..., ::-1], (bw, bh), interpolation=cv2.INTER_CUBIC)
        if self.SHARP > 0: o = cv2.addWeighted(o, 1 + self.SHARP, cv2.GaussianBlur(o, (0, 0), 1.2), -self.SHARP, 0)
        w = cv2.resize(np.asarray(self.clip.weights[k], np.float32), (bw, bh), interpolation=cv2.INTER_LINEAR)
        rw, rh = X2 - X1, Y2 - Y1
        Yp, Up, Vp = yuv[:H], yuv[H:H + H // 4].reshape(H // 2, W // 2), yuv[H + H // 4:].reshape(H // 2, W // 2)
        packed = np.concatenate([Yp[Y1:Y2, X1:X2].ravel(), Up[Y1 // 2:Y2 // 2, X1 // 2:X2 // 2].ravel(),
                                 Vp[Y1 // 2:Y2 // 2, X1 // 2:X2 // 2].ravel()]).reshape(rh * 3 // 2, rw)
        bgr = cv2.cvtColor(packed, cv2.COLOR_YUV2BGR_I420)
        # the box ∩ the rectangle, in each one's coordinates
        a0, a1, b0, b1 = max(Y1, y1), min(Y2, y2), max(X1, x1), min(X2, x2)
        ro, so = bgr[a0 - Y1:a1 - Y1, b0 - X1:b1 - X1], (slice(a0 - y1, a1 - y1), slice(b0 - x1, b1 - x1))
        ww = np.ascontiguousarray(w[so]); bgr[a0 - Y1:a1 - Y1, b0 - X1:b1 - X1] = cv2.blendLinear(np.ascontiguousarray(o[so]), np.ascontiguousarray(ro), ww, 1 - ww)
        back = cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV_I420).ravel(); ny, nc = rh * rw, (rh // 2) * (rw // 2)   # planes by size:
        Yp[Y1:Y2, X1:X2] = back[:ny].reshape(rh, rw)                                                            # U / V rows
        Up[Y1 // 2:Y2 // 2, X1 // 2:X2 // 2] = back[ny:ny + nc].reshape(rh // 2, rw // 2)                       # need not end
        Vp[Y1 // 2:Y2 // 2, X1 // 2:X2 // 2] = back[ny + nc:ny + 2 * nc].reshape(rh // 2, rw // 2)              # on a row
        return yuv

    def _run(self, w16, total, k0, write, stop=None, tick=None, depth=6, j0=0, linear=False, seq=None):
        """total frames of her avatar from cycle position k0, lip-synced to w16 (16 kHz float), each composited frame →
        write(bytes). The Radeon (DINet, ~110 ms a frame) is the only limit: JPEG decode, the blend and the encoder (its own
        process) run beside it in a compositor thread; silent stretches reuse her closed mouth for that avatar frame; a frame
        the GPU garbles is retried, never replaced by another frame's mouth. tick(i): frame i is written. → silent reused
        j0: these frames start j0 frames into w16 (a sentence split across two clips); linear: frames k0, k0+1, … of a gesture
        clip (no forward-back cycle); frames in self.plain (her hand over her mouth) go out as they are — no mouth drawn;
        seq: the avatar frame for each output frame, given (DHStream plans her path home)"""
        import queue
        hd, clip = self.hd, self.clip
        w16 = np.asarray(w16, np.float32)
        win = hd.windows(w16) if len(w16) >= 1600 else hd.windows(np.pad(w16, (0, 1600 - len(w16))))
        cyc = list(range(self.n)) if linear else self.cycle()
        plain = getattr(self, 'plain', None) or ()
        hop = 160; m = len(w16) // hop * hop
        e = np.sqrt(np.add.reduceat(w16[:m] ** 2, np.arange(0, m, hop)) / hop) if m else np.zeros(1)
        thr = max(1e-4, 10 ** (-42 / 20) * float(e.max() if len(e) else 1))
        def silent(j):
            c = int((j0 + j) / self.fps * 100); return bool(e[max(0, c - 12):c + 13].max(initial=0) < thr)
        cq = queue.Queue(maxsize=8); err = []
        T = self.__dict__.setdefault('stats', {'gpu': 0.0, 'cq': 0.0, 'dec': 0.0, 'blend': 0.0, 'write': 0.0, 'n': 0})
        def compositor():
            last = None; i = 0
            try:
                while True:
                    it = cq.get()
                    if it is None: break
                    k, out = it
                    if out is None and last is not None: t = time.time(); write(last); T['write'] += time.time() - t   # garbled: repeat
                    else:
                        t = time.time(); img = self.frame(k); T['dec'] += time.time() - t
                        t = time.time()
                        if out is not None and out is not False: img = self._blend(k, out, img)       # False: the frame as is
                        T['blend'] += time.time() - t
                        t = time.time(); last = img.tobytes(); write(last); T['write'] += time.time() - t
                    T['n'] += 1
                    if tick is not None: tick(i)
                    i += 1
            except Exception as ex: err.append(ex)
        ct = threading.Thread(target=compositor, daemon=True); ct.start()
        sc = self.__dict__.setdefault('_silent', {}); pend = []; n_sil = 0; bad = [0]
        def take():
            j, k, h, key, a = pend.pop(0)
            t = time.time(); out = hd.dinet_out(h, persist=True); T['gpu'] += time.time() - t
            if out is None:                                   # garbled even after retries
                bad[0] += 1
                if bad[0] >= 4:                               # a GPU garbage spell: a fresh runner, the frames in flight again
                    hd.reset_runner(); bad[0] = 0             # (the old runner's answers are dropped with it)
                    for i, q in enumerate(pend): pend[i] = (q[0], q[1], hd.submit(clip, q[1], win[q[4]]), q[3], q[4])
                    out = hd.dinet_out(hd.submit(clip, k, win[a]), persist=True)
            else: bad[0] = 0
            if key is not None and out is not None: sc[key] = out
            t = time.time(); cq.put((k, out)); T['cq'] += time.time() - t
        try:
            for j in range(total):
                if stop is not None and stop.is_set(): raise InterruptedError
                if err: raise err[0]
                k = seq[j] if seq is not None else min(self.n - 1, k0 + j) if linear else cyc[(k0 + j) % len(cyc)]
                if k in plain:                                        # a hand in front of her mouth: nothing to redraw
                    while pend: take()
                    cq.put((k, False)); continue
                if silent(j) and k in sc:                             # her closed mouth on this frame (warm cache)
                    while pend: take()                                # keep frames in order
                    cq.put((k, sc[k])); n_sil += 1; continue
                a = min(len(win) - 1, int(round((j0 + j) * 25.0 / self.fps)))
                while self.prio is not None and self.prio.is_set(): time.sleep(0.004)
                pend.append((j, k, hd.submit(clip, k, win[a]), k if silent(j) else None, a))
                if len(pend) >= depth: take()
            while pend: take()
        except BaseException:
            for q in pend:
                try: hd.drop(q[2])
                except Exception: pass
            cq.put(None); ct.join(timeout=10)
            raise
        cq.put(None); ct.join()
        if err: raise err[0]
        return n_sil

    def render(self, w16, audio_path, out_path, depth=4, stop=None, k0=0):
        """→ out_path (mp4: her avatar lip-synced to w16 — 16 kHz float — with audio_path muxed in) or None if stopped"""
        with self.lock:                                   # one DUIX task at a time (the repo's DUIX is single-task too)
            t0 = time.time(); dur = len(w16) / 16000.0; total = max(1, int(np.ceil(dur * self.fps)))
            enc = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
                                    '-s', f'{self.w}x{self.h}', '-r', f'{self.fps:g}', '-i', '-', '-i', audio_path,
                                    *venc(), '-pix_fmt', 'yuv420p',
                                    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
                                    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out_path],
                                   stdin=subprocess.PIPE)
            try:
                n_sil = self._run(w16, total, k0, enc.stdin.write, stop, depth=depth)
                enc.stdin.close(); enc.wait()
            except InterruptedError:
                try: enc.stdin.close()
                except Exception: pass
                enc.kill()
                try: os.remove(out_path)
                except OSError: pass
                return None
            print(f'[gf-live] DUIX face2face: {total} frames ({dur:.1f}s at {self.fps:g} fps, {n_sil} silent reused) in {time.time() - t0:.1f}s', flush=True)
            self.last_frames = total
            return out_path


def _has_vt():
    try: return 'h264_videotoolbox' in subprocess.run(['ffmpeg', '-hide_banner', '-encoders'], capture_output=True, text=True, timeout=10).stdout
    except Exception: return False
_VT = None


_WIN_ENC = None


def _win_encoder():
    """Windows: the first H.264 hardware encoder that actually encodes on this machine (NVIDIA, Intel, AMD, then Media
    Foundation's own pick) — ffmpeg builds list all of them whatever the hardware, so each is tried on two tiny frames."""
    global _WIN_ENC
    if _WIN_ENC is None:
        _WIN_ENC = ''
        if os.environ.get('GF_DH_HW', '1') == '1':
            for name, extra in (('h264_nvenc', ['-preset', 'p4', '-tune', 'll']), ('h264_qsv', ['-preset', 'veryfast']),
                                ('h264_amf', ['-usage', 'lowlatency']), ('h264_mf', ['-hw_encoding', '1'])):
                try:
                    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=256x256:r=15:d=0.2',
                                        '-c:v', name, *extra, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
                                       capture_output=True, timeout=20)
                    if r.returncode == 0: _WIN_ENC = name; break
                except Exception:
                    pass
        print(f'[gf-live] DH encoder: {_WIN_ENC or "libx264"}', flush=True)
    if _WIN_ENC == 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-profile:v', 'high', '-level', '4.0', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '14M']
    if _WIN_ENC == 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.0', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '14M']
    if _WIN_ENC == 'h264_amf': return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-profile:v', 'high', '-level', '4.0', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '14M']
    if _WIN_ENC == 'h264_mf': return ['-c:v', 'h264_mf', '-hw_encoding', '1', '-profile:v', 'high', '-b:v', '10M']
    return ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '16', '-profile:v', 'high', '-level', '4.0']


def venc():
    """H.264 encoder arguments: the Mac's hardware encoder (VideoToolbox) when ffmpeg has it — 10-21: x264 superfast took ~100 ms
    of CPU a frame on the power-capped CPU (the compositor, not the GPU, became the limit: 4.2× real time), the hardware encoder
    ~5 ms at the same quality (10 Mbit/s: SSIM 0.9965 vs x264 crf 16 0.9968, same size). GF_DH_VT=0 → x264."""
    global _VT
    if os.name == 'nt': return _win_encoder()
    if _VT is None: _VT = os.environ.get('GF_DH_VT', '1') == '1' and _has_vt()
    if _VT:
        return ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-level', '4.0', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '14M',
                '-realtime', '1', '-allow_sw', '1']
    return ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '16', '-profile:v', 'high', '-level', '4.0']


MIME = 'video/mp4; codecs="avc1.640028, mp4a.40.2"'          # what DHStream writes: H.264 High@4.0 + AAC-LC, fragmented


class DHStream:
    """ONE reply = one continuous fragmented-MP4 stream of her avatar (10-21, user: "as fast as possible … 丝滑 … 不会卡顿"):
    its sentences render back to back into the same video — her avatar never jumps, no pause or audio click between
    segments — with the voice muxed in (lips and voice in step by construction), and the page plays it while the rest is
    still rendering. "go" (on_go) only once the rest is sure to render before playback needs it: rendered ≥ (R−1)/R of the
    reply + a margin, R = measured render seconds per video second (on this Radeon ~1.5–3.5, heat-dependent) — it never
    stalls mid-sentence. add() takes each sentence as soon as its voice exists (any thread); finish() = the reply is complete."""
    def __init__(self, dv, sr, on_chunk, on_go, stop=None, path=None, prefix=None):
        """prefix: a gesture clip's DHVideo (same size / fps as dv, first frame = her idle's, last = dv's frame 0): the reply
        opens on that gesture — she points / presents while she starts talking, lip-synced on its frames — and goes straight
        on into her talking avatar where the gesture comes home. A reply shorter than the gesture gets silence to its end
        (the page never fades out of her mid-gesture)."""
        import queue, tempfile
        self.dv, self.sr, self.on_chunk, self.on_go, self.stop, self.path = dv, sr, on_chunk, on_go, stop, path
        self.prefix = prefix; self.G = prefix.n if prefix is not None else 0
        if os.name == 'nt':                               # Windows has no FIFOs: a named pipe ffmpeg opens like a file
            import _winapi
            self.fifo = r'\\.\pipe\gf-dh-%d-%d' % (os.getpid(), id(self))
            self._pipe = _winapi.CreateNamedPipe(self.fifo, _winapi.PIPE_ACCESS_OUTBOUND,
                                                 _winapi.PIPE_TYPE_BYTE | _winapi.PIPE_WAIT, 1, 1 << 20, 1 << 20, 0, _winapi.NULL)
        else:
            self.fifo = os.path.join(tempfile.mkdtemp(prefix='gf-dh-'), 'voice.pcm'); os.mkfifo(self.fifo)
        fps = int(round(dv.fps))
        self.enc = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', f'{dv.w}x{dv.h}',
                                     '-r', f'{dv.fps:g}', '-i', 'pipe:0', '-f', 's16le', '-ar', str(sr), '-ac', '1', '-i', self.fifo,
                                     *venc(),
                                     '-g', str(fps), '-keyint_min', str(fps), '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
                                     '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
                                     '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                                     'pipe:1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.aq, self.items = queue.Queue(), queue.Queue()
        self.total_s = 0.0; self.samples = 0; self.frames = 0; self.complete = False; self.went = False
        self.fcur, self.fdir = None, 1                    # her avatar: the frame last written and which way the cycle runs
        self.pcm = bytearray(); self.pcm_done = False     # her voice alone, as muxed (engine /dha: the app's mic helper plays it)
        self.t0 = None; self.done = threading.Event(); self.error = None
        self._file = open(path, 'wb') if path else None
        for f in (self._audio, self._reader, self._render): threading.Thread(target=f, daemon=True).start()

    def add(self, w16, play):
        """one sentence: its voice into the stream now, its frames rendered in order behind the ones before"""
        play = np.asarray(play, np.float32)
        b = (np.clip(play, -1, 1) * 32767).astype(np.int16).tobytes()
        self.aq.put(b); self.pcm += b
        self.total_s += len(play) / self.sr
        self.items.put((np.asarray(w16, np.float32), len(play)))

    def finish(self):
        short = self.G - int(round(self.total_s * self.dv.fps))
        if short > 0:                                     # the gesture outlasts the reply: silence until she is home
            n = int(np.ceil((short + 1) / self.dv.fps * self.sr))
            self.add(np.zeros(int(n * 16000 / self.sr), np.float32), np.zeros(n, np.float32))
        self.complete = True; self.items.put(None); self._check()

    def abort(self):
        """a newer reply / stop: the render ends at the next frame (the lock is free for the next stream)"""
        if self.stop is not None: self.stop.set()
        self.complete = True; self.went = True; self.items.put(None)

    def _audio(self):
        if os.name == 'nt': return self._audio_nt()
        with open(self.fifo, 'wb') as f:                  # blocks until ffmpeg opens its second input
            while True:
                b = self.aq.get()
                if b is None: break
                f.write(b)
        try: os.remove(self.fifo); os.rmdir(os.path.dirname(self.fifo))
        except OSError: pass

    def _audio_nt(self):
        import _winapi
        try:
            try: _winapi.ConnectNamedPipe(self._pipe, False)  # blocks until ffmpeg opens its second input, as the FIFO does
            except OSError as e:
                if getattr(e, 'winerror', None) != 535: raise  # ERROR_PIPE_CONNECTED: ffmpeg was already there
            while True:
                b = self.aq.get()
                if b is None: break
                _winapi.WriteFile(self._pipe, b)
        except OSError:
            pass                                          # ffmpeg went away (abort): nothing left to feed
        finally:
            try: _winapi.CloseHandle(self._pipe)
            except OSError: pass

    def _reader(self):
        r = self.enc.stdout
        while True:
            b = r.read1(1 << 16)
            if not b: break
            if self._file: self._file.write(b)
            self.on_chunk(b)
        if self._file: self._file.close()
        self.on_chunk(None)

    def _check(self, extra=0):
        """go once the rest will render before playback reaches it — judged on the slower of the whole stream's rate and the
        last ~2 s (this Mac slows as it heats: an early, fast rate started playback too soon and it stalled, 10-21) × 1.2,
        + 1.5 s (the fragment still being written is 1 s)"""
        if self.t0 is None: return
        now = time.time(); rendered = (self.frames + extra) / self.dv.fps
        hist = self.__dict__.setdefault('_hist', []); hist.append((now, rendered))
        while len(hist) > 2 and now - hist[0][0] > 2.0: hist.pop(0)
        if self.went or not self.complete: return
        R = max(1.0, (now - self.t0) / max(1e-3, rendered))
        if len(hist) >= 2 and hist[-1][1] > hist[0][1]: R = max(R, (hist[-1][0] - hist[0][0]) / (hist[-1][1] - hist[0][1]))
        R *= 1.2
        need = self.total_s * (R - 1) / R + 1.5
        if rendered >= min(need, self.total_s):
            self.went = True; self.on_go()

    rendering = 0                                         # streams rendering now (gesture warm-ups wait for 0)

    def _path(self, R, home):
        """her next R avatar frames: DUIX's forward-back walk through the clip from where she is (bouncing at its ends);
        home: the walk turns back in time to end on frame 0 — her idle's own frame, so the page hands back to the idle on
        the same picture (10-21, user: "DUIX重影还是很严重": the reply used to end wherever the talking clip was, up to ~8 px
        from the idle's pose at 1080p, and the 0.8 s fade back showed two of her). Deterministic in (frame, direction,
        frames left), so planning again for each sentence continues the same walk."""
        n = self.dv.n; f, d = self.fcur, self.fdir; out = []
        for i in range(R):
            left = R - i - 1
            if f is None: nf, nd = 0, 1
            else:
                nd = -d if not (0 <= f + d <= n - 1) else d
                nf = f + nd
                if home and nf > left:                    # no longer time for this way: head for frame 0
                    nd, nf = -1, max(0, f - 1)
            out.append(nf); f, d = nf, nd
        return out

    def _walked(self, seq):
        if not seq: return
        if len(seq) >= 2 and seq[-1] != seq[-2]: self.fdir = 1 if seq[-1] > seq[-2] else -1
        elif self.fcur is not None and seq[-1] != self.fcur: self.fdir = 1 if seq[-1] > self.fcur else -1
        self.fcur = seq[-1]

    def _render(self):
        dv = self.dv
        DHStream.rendering += 1
        try:
            with dv.lock:
                self.t0 = time.time()
                while True:
                    it = self.items.get()
                    if it is None: break
                    w16, ns = it
                    target = int(round((self.samples + ns) / self.sr * dv.fps)); n = target - self.frames; self.samples += ns
                    j = 0
                    while j < n:                              # the gesture's frames first (if any are left), then her avatar
                        f0 = self.frames
                        tk = lambda i, f0=f0: (setattr(self, 'frames', f0 + i + 1), self._check())
                        if f0 < self.G:
                            m = min(n - j, self.G - f0)
                            self.prefix._run(w16, m, f0, self.enc.stdin.write, self.stop, tick=tk, j0=j, linear=True)
                        else:
                            m = n - j
                            if self.complete:                     # the whole reply is known: her walk ends on frame 0
                                left = int(round(self.total_s * dv.fps)) - f0
                                seq = self._path(max(m, left), home=True)[:m]
                            else:
                                seq = self._path(m, home=False)
                            dv._run(w16, m, 0, self.enc.stdin.write, self.stop, tick=tk, j0=j, seq=seq)
                            self._walked(seq)
                        self.frames = f0 + m; j += m
            self._check()
            if not self.went: self.went = True; self.on_go()
            # the voice ended before she was home (a short last sentence): she keeps walking the clip back to frame 0, mouth
            # closed, voice silent — real frames of her, no blend, ~0.1 s each; the page hands over to the idle on frame 0
            if self.fcur and not (self.stop is not None and self.stop.is_set()):
                seq = list(range(self.fcur - 1, -1, -1))
                pad = bytes(int(round(len(seq) / dv.fps * self.sr)) * 2)
                self.aq.put(pad); self.pcm += pad
                dv._run(np.zeros(int(round(len(seq) / dv.fps * 16000)) + 1600, np.float32), len(seq), 0,
                        self.enc.stdin.write, self.stop, j0=0, seq=seq)
                self._walked(seq); self.frames += len(seq)
        except InterruptedError:
            self.error = 'stopped'
        except Exception as e:
            self.error = f'{type(e).__name__}: {e}'
            print(f'[gf-live] 数字人 stream failed: {self.error}', flush=True)
        finally:
            DHStream.rendering -= 1
            self.aq.put(None); self.pcm_done = True
            try: self.enc.stdin.close()
            except Exception: pass
            try: self.enc.wait(timeout=60)
            except Exception: self.enc.kill()
            if self.t0:
                T = dv.__dict__.pop('stats', {})
                for key, v in (self.prefix.__dict__.pop('stats', {}) if self.prefix is not None else {}).items(): T[key] = T.get(key, 0) + v
                n = max(1, T.get('n', 1))
                print(f'[gf-live] 数字人 stream: {self.frames} frames ({self.total_s:.1f}s of voice) in {time.time() - self.t0:.1f}s'
                      f' — {(time.time() - self.t0) / max(1e-3, self.frames / dv.fps):.2f}× real time; per frame: GPU wait'
                      f' {T.get("gpu", 0) / n * 1000:.0f} ms, queue {T.get("cq", 0) / n * 1000:.0f}, decode {T.get("dec", 0) / n * 1000:.0f},'
                      f' blend {T.get("blend", 0) / n * 1000:.0f}, encoder pipe {T.get("write", 0) / n * 1000:.0f}', flush=True)
            self.done.set()
