"""Shared DINet output check (HD reply mode + offline renderer)."""
import numpy as np, cv2


def garbage(out, ref, input_mask, ref_edges=None):
    """Hot-GPU garbage guard. The Radeon (and the Intel iGPU) sometimes return blocky multicolour noise, at times only in
    the lower face, with clean eye rows (user 10-19 screenshot). DINet redraws the masked lower face, so judge that
    region too: normal frames stay within mean |out − ref| ≤ 0.06 and chroma-edge energy ≤ 1.5× the reference's
    (measured on talk_haixiu / talk_kaixin); noise is ~0.5 and ~25×. Also the eye / forehead rows must match.
    out RGB uint8 [256,256,3]; ref float [3,256,256] in [0,1]; ref_edges = chroma_edges(ref) if the caller cached it."""
    o = out.astype(np.float32) / 255; r = ref.transpose(1, 2, 0); S = o.shape[0]      # 256², or 128² (fast check)
    if np.abs(o[:S * 80 // 256] - r[:S * 80 // 256]).mean() > 0.06: return True
    hole = input_mask.reshape(S, S) < 0.5
    if np.abs(o - r)[hole].mean() > 0.15: return True
    if ref_edges is None: ref_edges = chroma_edges(r, input_mask)
    return chroma_edges(o, input_mask) > 3.0 * ref_edges + 0.5


def chroma_edges(im, input_mask):
    """Chroma (Cr, Cb) Laplacian energy inside the redrawn lower face; im float RGB [256,256,3] in [0,1]."""
    hole = input_mask.reshape(im.shape[:2]) < 0.5
    y = cv2.cvtColor((im * 255).astype(np.uint8), cv2.COLOR_RGB2YCrCb).astype(np.float32)
    return sum(np.abs(cv2.Laplacian(y[..., c], cv2.CV_32F))[hole].mean() for c in (1, 2))
