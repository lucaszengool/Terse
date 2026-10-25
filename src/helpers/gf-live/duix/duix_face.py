"""DUIX face preprocessing, native (onnxruntime CPU + OpenCV) — replaces DUIX's Linux-only preprocess (10-19 recovered):
  SCRFD-500m (BGR, mean 127.5, /128, 640 letterbox, best score) → PFLD crop = box widened 10 % each side, +10 % below
  → PFLD 98 points (BGR, /255, 112², linear) → WFLW 98→68 (eye midpoints averaged) → frame landmarks
  → square crop box (fit to DUIX's boxes, ±0.8 px) → crop landmarks (266²) → lower-face mask
     (jaw polygon 2-5,11-14 ∪ circle on 5↔11 ×1.04, dilate 5; IoU 0.983 vs DUIX get_face_mask).
usage: python duix_face.py <base25fps.mp4> <out_facedata.npz>"""
import os, sys
import numpy as np, cv2, onnxruntime as ort

R = os.path.expanduser(os.environ.get('GF_DUIX_MODELS', '~/.terse/gf-live/models/duix'))
MAP98 = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 33, 34, 35, 36, 37, 42, 43, 44, 45, 46, 51, 52, 53, 54, 55, 56,
         57, 58, 59, 60, (60, 62), (62, 64), 64, (64, 66), (60, 66), 68, (68, 70), (70, 72), 72, (72, 74), (68, 74), 76, 77, 78, 79,
         80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95]


class DuixFace:
    def __init__(self):
        so = ort.SessionOptions(); so.intra_op_num_threads = 4
        self.det = ort.InferenceSession(os.path.join(R, 'scrfd_500m_bnkps_shape640x640.onnx'), so, providers=['CPUExecutionProvider'])
        self.lmk = ort.InferenceSession(os.path.join(R, 'pfpld_robust_sim_bs1_8003.onnx'), so, providers=['CPUExecutionProvider'])
        self.names = [o.name for o in self.det.get_outputs()]

    def detect(self, img, thresh=0.5):
        h, w = img.shape[:2]; r = min(640 / w, 640 / h); nw, nh = int(round(w * r)), int(round(h * r))
        pad = np.zeros((640, 640, 3), np.uint8); pad[:nh, :nw] = cv2.resize(img, (nw, nh))
        blob = cv2.dnn.blobFromImage(pad, 1 / 128, (640, 640), (127.5, 127.5, 127.5), swapRB=False)
        o = dict(zip(self.names, self.det.run(None, {self.det.get_inputs()[0].name: blob})))
        best = None
        for st in (8, 16, 32):
            sc = o[f'score_{st}'][0][:, 0]; bb = o[f'bbox_{st}'][0] * st
            f = 640 // st
            ctr = np.repeat(np.stack(np.mgrid[:f, :f][::-1], -1).reshape(-1, 2).astype(np.float32) * st, 2, 0)
            i = int(np.argmax(sc))
            if sc[i] >= thresh and (best is None or sc[i] > best[0]):
                best = (sc[i], np.concatenate([ctr[i] - bb[i, :2], ctr[i] + bb[i, 2:]]) / r)
        return None if best is None else best[1]

    def landmarks(self, img, box):
        bx1, by1, bx2, by2 = box; w, h = bx2 - bx1, by2 - by1
        x1, x2 = max(0, int(round(bx1 - 0.1 * w))), min(img.shape[1], int(round(bx2 + 0.1 * w)) + 1)
        y1, y2 = max(0, int(by1)), min(img.shape[0], int(by2 + 0.1 * h))
        crop = img[y1:y2, x1:x2]
        x = (cv2.resize(crop, (112, 112), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255).transpose(2, 0, 1)[None]
        p98 = self.lmk.run(None, {'input': x})[1][0].reshape(98, 2)
        p68 = np.array([p98[m] if isinstance(m, int) else (p98[m[0]] + p98[m[1]]) / 2 for m in MAP98])
        return p68 * np.array([crop.shape[1], crop.shape[0]]) + np.array([x1, y1])


def crop_box(lm):
    """square crop box (y1, y2, x1, x2) — least-squares fit to DUIX's own boxes for Mia (sd 0.2–0.8 px)."""
    lw = lm[:, 0].max() - lm[:, 0].min(); lh = lm[:, 1].max() - lm[:, 1].min()
    size = int(round(1.4689 * lw - 0.0202 * lh - 22.89))
    cx = (lm[:, 0].max() + lm[:, 0].min()) / 2 * 1.0043 - 0.0104 * lw - 1.3618
    y1 = int(round(lm[:, 1].min() * 1.0053 - 0.1019 * lw - 12.3574)); x1 = int(round(cx - size / 2))
    return np.array([y1, y1 + size, x1, x1 + size])


def face_mask(clm):
    m = np.zeros((266, 266), np.uint8)
    cv2.fillPoly(m, [clm[[2, 3, 4, 5, 11, 12, 13, 14]].astype(np.int32)], 255)
    c = (clm[5] + clm[11]) / 2; r = np.linalg.norm(clm[5] - clm[11]) / 2
    cv2.circle(m, (int(c[0]), int(c[1])), int(r * 1.04), 255, -1)
    return cv2.dilate(m, np.ones((5, 5), np.uint8))


def prepare(video, out, smooth=0):
    fd = DuixFace(); cap = cv2.VideoCapture(video); L = []; last = None
    while True:
        ok, img = cap.read()
        if not ok: break
        box = fd.detect(img); box = last if box is None else box; last = box
        L.append(fd.landmarks(img, box))
    L = np.array(L)
    if smooth:                                                 # light temporal smoothing (fixed clip → centred window)
        k = 2 * smooth + 1; Lp = np.pad(L, ((smooth, smooth), (0, 0), (0, 0)), mode='edge')
        L = np.stack([Lp[i:i + k].mean(0) for i in range(len(L))])
    boxes = np.array([crop_box(l) for l in L])
    clm = np.array([(l - b[[2, 0]]) * 266.0 / (b[1] - b[0]) for l, b in zip(L, boxes)])
    masks = np.array([face_mask(c) for c in clm])
    np.savez_compressed(out, boxes=boxes, crop_lm=clm, masks=masks, landmarks=L)
    return boxes, clm, masks, L


if __name__ == '__main__':
    b, c, m, L = prepare(sys.argv[1], sys.argv[2], int(os.environ.get('DUIX_SMOOTH', '0')))
    print('frames', len(b), '→', sys.argv[2])
