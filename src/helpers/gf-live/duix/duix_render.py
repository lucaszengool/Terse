"""DUIX (Duix.Avatar face2face) rendering natively on this Mac — no Docker, no CUDA.
Same steps as DUIX's own pipeline (recovered 10-19 from its service + dumps):
  audio 16 kHz → DUIX fbank (duix_audio.fbank) → WeNet conformer (wenet_bnf.onnx) → per-frame windows [20×256]
  base frame → box crop (DUIX face data) → 266² → 256² → source = crop·input_mask, ref = crop
  DINetV1 (Core ML fp16, pinned to the Radeon by terse-gf-duix) → 256² face → 266² → landmark lower-face mask (DUIX get_face_mask, precomputed)
  feathered by distance to the mask hull (blendImages, feather 0.1·face size) → resized back into the box.
usage: python duix_render.py <base25fps.mp4> <facedata.npz> <audio.wav> <out.mp4> [--frames N]"""
import os, sys, time, subprocess, argparse
import numpy as np, cv2, librosa, onnxruntime as ort
from runner_client import DuixRunner
from duix_guard import garbage

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import duix_audio as A

M = os.path.expanduser(os.environ.get('GF_DUIX_MODELS', '~/.terse/gf-live/models/duix'))


def feather_weights(mask, amount=0.1):
    """blendImages: weight = distance to the convex hull of the mask, / (amount · max face size), clipped to [0,1]."""
    ys, xs = np.nonzero(mask > 127)
    w = np.zeros(mask.shape, np.float32)
    if len(xs) < 3: return w
    pts = np.stack([xs, ys], 1).astype(np.int32)
    size = (pts.max(0) - pts.min(0)).max()
    hull = cv2.convexHull(pts)
    hm = np.zeros(mask.shape, np.uint8); cv2.fillConvexPoly(hm, hull, 255)
    dist = cv2.distanceTransform((hm > 0).astype(np.uint8), cv2.DIST_L2, 5)        # distance to the hull edge (inside)
    w[ys, xs] = np.clip(dist[ys, xs] / max(1.0, amount * size), 0, 1)
    return w


class DuixRenderer:
    def __init__(self, facedata):
        d = np.load(facedata, allow_pickle=True)
        self.boxes = d['boxes']            # [N, 4] y1, y2, x1, x2
        self.masks = d['masks']            # [N, 266, 266] uint8 (DUIX get_face_mask)
        self.weights = [None] * len(self.boxes)
        self.bad, self.last_good = 0, None
        meta = np.load(os.path.join(M, 'dinet_v1_meta.npz'))
        self.input_mask = meta['input_mask'].astype(np.float32)[None]          # [1,256,256]
        so = ort.SessionOptions(); so.intra_op_num_threads = 6
        self.wenet = ort.InferenceSession(os.path.join(M, 'wenet_bnf.onnx'), so, providers=['CPUExecutionProvider'])
        self.dinet = DuixRunner(os.environ.get('DUIX_GPU', 'amd'), split=False)        # whole-frame renderer: the full model

    def audio_windows(self, wav_path):
        wav, _ = librosa.load(wav_path, sr=16000)
        bnf = self.wenet.run(None, {'feats': A.fbank(wav)[None]})[0][0]
        return A.windows(bnf), len(wav) / 16000

    def submit(self, img, k, win):
        """crop + model request (async); returns a handle for finish()."""
        y1, y2, x1, x2 = [int(v) for v in self.boxes[k]]
        c266 = cv2.resize(img[y1:y2, x1:x2], (266, 266), interpolation=cv2.INTER_AREA)
        c256 = cv2.resize(c266, (256, 256), interpolation=cv2.INTER_AREA)[..., ::-1].astype(np.float32) / 255
        ref = c256.transpose(2, 0, 1)
        return (self.dinet.submit(ref * self.input_mask, ref, win.T), img, k, c266, (ref * self.input_mask, ref, win.T))

    def _sane(self, out, ref):
        """GPU-garbage guard (duix_hd.garbage: eye rows + the redrawn lower face)."""
        return not garbage(out, ref, self.input_mask), None

    def finish(self, h):
        rq, img, k, c266, inp = h
        out = self.dinet.get(rq)                                                     # RGB uint8 256²
        ok, err = self._sane(out, inp[1])
        for _ in range(2):
            if ok: break
            self.bad += 1; out = self.dinet.get(self.dinet.submit(*inp)); ok, err = self._sane(out, inp[1])
        if not ok and self.last_good is not None: out = self.last_good               # still noise: hold the previous mouth
        elif ok: self.last_good = out
        o266 = cv2.resize(out[..., ::-1].astype(np.float32), (266, 266), interpolation=cv2.INTER_LINEAR)
        if self.weights[k] is None: self.weights[k] = feather_weights(self.masks[k])[..., None]
        w = self.weights[k]
        b266 = o266 * w + c266.astype(np.float32) * (1 - w)
        y1, y2, x1, x2 = [int(v) for v in self.boxes[k]]
        res = img.copy()
        res[y1:y2, x1:x2] = cv2.resize(b266, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LINEAR).clip(0, 255).astype(np.uint8)
        return res


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('base'); ap.add_argument('facedata'); ap.add_argument('audio'); ap.add_argument('out')
    ap.add_argument('--frames', type=int, default=0); a = ap.parse_args()
    r = DuixRenderer(a.facedata)
    t0 = time.time(); wins, dur = r.audio_windows(a.audio); print(f'audio {dur:.2f}s → {len(wins)} frames, features {time.time()-t0:.2f}s', flush=True)
    cap = cv2.VideoCapture(a.base); frames = []
    while True:
        ok, f = cap.read()
        if not ok: break
        frames.append(f)
    n = min(len(frames), len(r.boxes)); cyc = list(range(n)) + list(range(n - 1, -1, -1))     # DUIX loops forward then back
    total = len(wins) if not a.frames else min(a.frames, len(wins))
    h, w = frames[0].shape[:2]
    enc = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', '25', '-i', '-',
                            '-i', a.audio, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest',
                            '-movflags', '+faststart', a.out], stdin=subprocess.PIPE)
    t1 = time.time()
    pend = []
    for j in range(total + 4):
        if j < total:
            k = cyc[j % len(cyc)]; pend.append(r.submit(frames[k], k, wins[j]))
        if len(pend) > 4 or (j >= total and pend):
            enc.stdin.write(r.finish(pend.pop(0)).tobytes())
        if j % 25 == 0: print(f'  frame {j}/{total}  {(time.time()-t1)/(j+1)*1000:.0f} ms/frame', flush=True)
    while pend: enc.stdin.write(r.finish(pend.pop(0)).tobytes())
    enc.stdin.close(); enc.wait()
    print(f'GPU garbage frames retried: {r.bad}')
    print(f'wrote {a.out}: {total} frames in {time.time()-t1:.1f}s ({(time.time()-t1)/max(1,total)*1000:.0f} ms/frame)')


if __name__ == '__main__':
    main()
