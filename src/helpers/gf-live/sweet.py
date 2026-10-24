"""Make a fast TTS voice gentler and sweeter (user 10-20: MeloTTS "更温柔更甜妹一点"), in real time on a CPU.

WORLD vocoder (pyworld): analyse → raise the pitch (f0 × k) → move the spectral envelope up a little (formants × a: a
slightly smaller vocal tract reads as younger / sweeter, without the chipmunk sound of a plain pitch shift) → a touch
more aperiodicity above ~4 kHz (breathier, softer) → resynthesise. Then a gentle tilt: less low-mid boom, a little air."""
import numpy as np


def _yin(x, sr, fp=10.0, fmin=140.0, fmax=800.0, thr=0.15):
    """vectorized YIN (de Cheveigné & Kawahara 2002) on WORLD's frames (t = k·fp ms) → (F0 candidate, its CMNDF dip, level dB
    re the loudest frame) per frame. fmin 140 Hz: her voice never goes lower — Melo's creaky clause ends (~85 Hz fry) are not
    tracked as pitch"""
    x = np.asarray(x, np.float64); hop = sr * fp / 1000.0
    tmax = int(np.ceil(sr / fmin)) + 1; tmin = max(2, int(sr / fmax)); W = tmax
    n = int(len(x) / sr * 1000 / fp) + 1
    pad = np.pad(x, (W, W + 2 * tmax))
    F = pad[(np.arange(n) * hop).astype(int)[:, None] + (W - W // 2) + np.arange(W + tmax)[None, :]]
    L = 1 << int(np.ceil(np.log2(2 * W + tmax)))
    r = np.fft.irfft(np.conj(np.fft.rfft(F[:, :W], L)) * np.fft.rfft(F, L), L)[:, :tmax + 1]   # Σ_{j<W} x_j x_{j+τ}
    sq = np.concatenate([np.zeros((n, 1)), np.cumsum(F * F, 1)], 1)
    E0 = sq[:, W]; d = np.maximum(E0[:, None] + sq[:, W:W + tmax + 1] - sq[:, :tmax + 1] - 2 * r, 0)
    cm = np.ones_like(d)
    cm[:, 1:] = d[:, 1:] * np.arange(1, tmax + 1)[None, :] / np.maximum(np.cumsum(d[:, 1:], 1), 1e-12)
    cm[:, :tmin] = 2.0
    below = cm < thr; rows = np.arange(n)
    first = np.where(below.any(1), below.argmax(1), np.argmin(cm, 1))
    j = np.clip(first[:, None] + np.arange(tmin)[None, :], 0, tmax)          # down to the bottom of the first dip
    tau = np.clip(j[rows, np.argmin(cm[rows[:, None], j], 1)], tmin + 1, tmax - 1)
    a, b, c = cm[rows, tau - 1], cm[rows, tau], cm[rows, tau + 1]
    den = a - 2 * b + c; off = np.where(np.abs(den) > 1e-12, 0.5 * (a - c) / np.where(np.abs(den) > 1e-12, den, 1), 0)
    rms = np.sqrt(E0 / W)
    return sr / (tau + np.clip(off, -1, 1)), b, 20 * np.log10(rms / max(1e-12, rms.max()) + 1e-12)


def track_f0(x, sr, vthr=0.3, floor_db=-45.0, lvl=-30.0, gap=12, ext=25, tol=3.0):
    """her F0 for WORLD (10-21, replaces DIO: on Melo's soft clause ends DIO lost 21 % of the voiced frames — re-synthesised
    as a whisper — and tracked others an octave and more down, 81–105 Hz for 210–260 Hz — re-synthesised as a growl:
    呀's rising tail, 哦, 你). YIN, then:
      · frames YIN calls unvoiced that still carry her voice (breathy vowel ends, soft transitions: level > lvl dB, some
        periodicity) take their pitch from the confident frames around them — log-interpolated across a gap ≤ gap frames,
        carried on past the end / start of a run ≤ ext frames — or YIN's own where it agrees within tol semitones (D4C keeps
        them breathy; WORLD no longer whispers them)
      · octave slips against the running median of the confident frames; StoneMask; a light smoothing in log F0.
    Against Harvest (40 clauses): gross errors 6.6 → 4.1 %, voiced frames lost 21 → 11 %, at DIO's cost (~57 ms per s; Harvest
    ~700 ms per s under the CPU cap)."""
    import pyworld as pw
    raw, b, lv = _yin(x, sr)
    f = np.where((b < vthr) & (lv > floor_db), raw, 0.0); f0c = f.copy(); n = len(f)
    ok = (lv > lvl) & (b < 0.8)
    def take(k, ref): f[k] = raw[k] if abs(12 * np.log2(raw[k] / ref)) <= tol else ref
    v = np.flatnonzero(f0c > 0)
    for a, c in zip(v[:-1], v[1:]):                                   # gaps between voiced frames
        if 1 < c - a <= gap + 1 and ok[a + 1:c].all():
            for k in range(a + 1, c): take(k, 2 ** (np.log2(f0c[a]) + (np.log2(f0c[c]) - np.log2(f0c[a])) * (k - a) / (c - a)))
    vv = f > 0
    for k0 in np.flatnonzero(vv[:-1] & ~vv[1:]):                      # run ends: the vowel trails on
        for k in range(k0 + 1, min(n, k0 + 1 + ext)):
            if f[k] > 0 or not ok[k]: break
            take(k, f[k - 1])
    vv = f > 0
    for k0 in np.flatnonzero(~vv[:-1] & vv[1:]) + 1:                  # run starts
        for k in range(k0 - 1, max(-1, k0 - 1 - ext // 2), -1):
            if f[k] > 0 or not ok[k]: break
            take(k, f[k + 1])
    lf = np.where(f > 0, np.log2(np.maximum(f, 1)), np.nan); cf = np.where((f > 0) & (b < 0.2), lf, np.nan)
    for k in np.flatnonzero(f > 0):                                   # octave slips
        w = cf[max(0, k - 15):k + 16]; w = w[~np.isnan(w)]
        if len(w) < 3: continue
        dd = lf[k] - np.median(w)
        if dd < -0.75 and abs(dd + 1) < 0.25: f[k] *= 2
        elif dd > 0.75 and abs(dd - 1) < 0.25: f[k] /= 2
    t = np.arange(n) * 0.01
    f = pw.stonemask(np.ascontiguousarray(x, np.float64), f, t, sr)
    v = f > 0; lf = np.log(np.maximum(f, 1))                         # smoothing within each voiced run
    e = np.flatnonzero(np.diff(np.concatenate(([0], v.view(np.int8), [0]))))
    for a, c in zip(e[::2], e[1::2]):
        if c - a < 3: continue
        p = np.concatenate(([lf[a]], lf[a:c], [lf[c - 1]])); s = np.median(np.stack([p[:-2], p[1:-1], p[2:]]), 0)
        p = np.concatenate(([s[0]], s, [s[-1]])); f[a:c] = np.exp(0.25 * p[:-2] + 0.5 * p[1:-1] + 0.25 * p[2:])
    return f, t


def f0_stats(x, sr):
    """median and spread of her log-F0 over the whole line — the pieces of a parallel run widen her pitch range around
    the same centre"""
    f0 = np.where(*(lambda r: ((r[1] < 0.3) & (r[2] > -45), r[0], 0.0))(_yin(x, sr)))
    v = np.log(f0[f0 > 0]) if (f0 > 0).sum() > 5 else np.array([np.log(220.0)])
    return float(np.median(v)), float(np.std(v))


def world_shift(x, sr, pitch=1.14, formant=1.04, breath=0.25, mu=None, range_k=1.0, rise=None, soft=0.0):
    """The WORLD half of sweeten (analysis → f0 × pitch, envelope warp, breathier highs → resynthesis); no tilt / level.
    10-21 (user: "melo 的声音…不够自然、不够嗲、不够甜美"; research: attractive / cute female voices = higher pitch, wider
    formant dispersion (Xu et al. 2013); expressive speech = a wider, livelier pitch range; the kawaii / anime girl voice =
    high pitch, raised formants with narrower bandwidths, a ringing top, little breath (Teshigawara & Amir, ICPhS 2019)):
      mu, range_k   her log-F0 spread around the line's median × range_k (a livelier melody, not just a higher one)
      rise          (t0, t1, semitones): her last syllable curls up — over its voiced run from t0 (the vowel keeps sounding
                    through the blank / punctuation tokens after it, up to t1), from 30 % in, anchored to her own pitch there
      soft          −1..1: > 0 softer formant peaks (blurred log envelope), < 0 sharper ones (narrower bandwidths: ringing)"""
    import pyworld as pw
    x64 = np.ascontiguousarray(x, np.float64)
    f0, t = track_f0(x64, sr)                            # 10 ms frames (10-20 real time)
    sp = pw.cheaptrick(x64, f0, t, sr)
    ap = pw.d4c(x64, f0, t, sr)
    v = f0 > 0
    if mu is not None and abs(range_k - 1) > 1e-3 and v.any():
        f0[v] = np.exp(mu + (np.log(f0[v]) - mu) * range_k)
    f0 = f0 * pitch
    if rise is not None and v.any():
        a, b, st = rise; n = len(f0); i = max(0, int(round(a / 0.01)))
        while i < n and not v[i] and i * 0.01 < a + 0.06: i += 1          # the syllable's voiced run (1-frame gaps bridged)
        j = i
        while j < n and j * 0.01 <= b and (v[j] or (j + 1 < n and v[j + 1])): j += 1
        if j - i >= 5 and abs(st) > 1e-3:
            k0 = i + int(0.3 * (j - i)); nb = v[max(i, k0 - 2):k0 + 3]
            f0a = float(np.median(f0[max(i, k0 - 2):k0 + 3][nb])) if nb.any() else 0.0
            if f0a > 0:
                r = np.clip((np.arange(n) - k0) / max(1, j - 1 - k0), 0, 1); tgt = f0a * 2 ** (st * r * r * (3 - 2 * r) / 12)
                wb = np.clip(r / 0.25, 0, 1); wb = wb * wb * (3 - 2 * wb)                    # joins her contour smoothly
                m = v & (np.arange(n) >= k0) & (np.arange(n) < j)
                f0 = np.where(m, f0 * (1 - wb) + tgt * wb, f0)
    if abs(formant - 1) > 1e-3:                                   # envelope warp: sp'(f) = sp(f / formant)
        n = sp.shape[1]; src = np.arange(n) / formant
        lo = np.clip(np.floor(src).astype(int), 0, n - 1); hi = np.clip(lo + 1, 0, n - 1); w = src - np.floor(src)
        sp = sp[:, lo] * (1 - w) + sp[:, hi] * w
    if abs(soft) > 1e-3:                                          # formant peaks: softer (blur) / sharper (unsharp mask)
        import cv2
        ls = np.log(np.maximum(sp, 1e-12)); k = 1 + 2 * int(round(3 * max(abs(soft), 0.34)))
        ls = ls + soft * (cv2.GaussianBlur(ls, (k, 1), 0) - ls)
        sp = np.exp(ls)
    if breath > 0:                                                # breathier highs
        n = ap.shape[1]; f = np.arange(n) / (n - 1) * sr / 2
        m = np.clip((f - 3000) / 3000, 0, 1) * breath
        ap = ap + (1 - ap) * m
    c = np.ascontiguousarray
    return pw.synthesize(c(f0, np.float64), c(sp, np.float64), c(ap, np.float64), sr, frame_period=10.0).astype(np.float32)


def _finish(x, y, sr, bright=0.0, low=2.5, air=2.0, presence=0.0, harsh=0.0):
    # gentle tilt: −low dB around 250 Hz, +air dB above 7 kHz (FFT shelf, level-matched); bright: + dB from ~2.5 kHz up
    # (10-21: the anime / kawaii voice has a flatter spectral slope — more energy in the upper harmonics, ICPhS 2019;
    # low: a thinner, 细 voice — Breeze2's raw voice is +2 dB in 80–300 Hz against its mids, the sweet voices −3 … −11 dB)
    # 10-21 late (user: "更清晰一点并且不要太尖"): presence = ± dB bell at 1.8 kHz (consonants: clarity), harsh = − dB bell at
    # 3.5–6 kHz, where the ear is most sensitive and a voice turns shrill / sibilant
    nfft = 1 << int(np.ceil(np.log2(len(y) + 1)))
    Y = np.fft.rfft(y, nfft); fr = np.fft.rfftfreq(nfft, 1 / sr); lf = np.log2(np.maximum(fr, 1))
    g = 1 - (1 - 10 ** (-low / 20)) * np.exp(-((lf - np.log2(250)) ** 2) / 0.5) + (10 ** (air / 20) - 1) / (1 + (7000 / np.maximum(fr, 1)) ** 4)
    if bright: g = g * (1 + (10 ** (bright / 20) - 1) / (1 + (2500 / np.maximum(fr, 1)) ** 3))
    if presence: g = g * (1 + (10 ** (presence / 20) - 1) * np.exp(-((lf - np.log2(1800)) ** 2) / 0.6))
    if harsh: g = g * (1 + (10 ** (-harsh / 20) - 1) * np.exp(-((lf - np.log2(4600)) ** 2) / 0.35))
    z = np.fft.irfft(Y * g, nfft)[:len(y)].astype(np.float32)
    return z * (np.sqrt((x ** 2).mean()) / max(1e-9, np.sqrt((z ** 2).mean())))


def soften(x, sr, bright=0.0, low=0.0, air=0.0, presence=0.0, harsh=0.0):
    """only the tilt, no WORLD: her voice exactly as the TTS made it (clearest, ~0.02 s), just the EQ"""
    return _finish(x, np.asarray(x, np.float32), sr, bright, low, air, presence, harsh)


def sweeten(x, sr, pitch=1.14, formant=1.04, breath=0.25, bright=0.0, low=2.5, air=2.0, presence=0.0, harsh=0.0, **kw):
    return _finish(x, world_shift(x, sr, pitch, formant, breath, **kw), sr, bright, low, air, presence, harsh)


def _cuts(x, sr, k):
    """k−1 cut points at the quietest 10 ms near each 1/k of the clause (WORLD works frame by frame; cutting in a pause
    keeps every pitch pulse whole)"""
    h = sr // 100; n = len(x) // h
    e = np.sqrt(np.add.reduceat(np.asarray(x, np.float64) ** 2, np.arange(0, n * h, h))[:n] / h)
    cuts = []
    for i in range(1, k):
        c = int(n * i / k); lo, hi = max(1, c - n // (3 * k)), min(n - 1, c + n // (3 * k))
        cuts.append((lo + int(np.argmin(e[lo:hi]))) * h)
    return sorted(set(cuts))


def sweeten_parallel(x, sr, pitch=1.14, formant=1.04, breath=0.25, pool=None, k=3, range_k=1.0, rise=None, soft=0.0, bright=0.0, low=2.5,
                     air=2.0, presence=0.0, harsh=0.0):
    """sweeten with the WORLD half split over k worker processes (10-21: pyworld is single-threaded — under the battery's
    20 % CPU cap one core took 1.6–3.7 s for a 2.6 s line). Same output, cut in the pauses. The pitch range widens around
    the whole line's median; rise (seconds of the line) goes to the piece it falls in."""
    mu = f0_stats(x, sr)[0] if abs(range_k - 1) > 1e-3 else None
    kw = dict(mu=mu, range_k=range_k, soft=soft)
    if pool is None or len(x) < sr * 1.2:
        return sweeten(x, sr, pitch, formant, breath, bright, low, air, presence, harsh, rise=rise, **kw)
    k = max(2, min(k, int(len(x) / (sr * 0.6))))
    edges = [0] + _cuts(x, sr, k) + [len(x)]
    segs = [(a, b) for a, b in zip(edges, edges[1:]) if b > a]
    def local(span, a, b):                                # a time span of the line → this piece's seconds (or None)
        if span is None: return None
        t0, t1 = span[0] - a / sr, span[1] - a / sr
        return (max(0.0, t0), min((b - a) / sr, t1)) + tuple(span[2:]) if t1 > 0 and t0 < (b - a) / sr else None
    futs = [pool.submit(world_shift, x[a:b], sr, pitch, formant, breath, rise=local(rise, a, b), **kw) for a, b in segs]
    out = []
    for (a, b), f in zip(segs, futs):                     # WORLD rounds each piece up to its 10 ms frames: back to its length
        y = f.result()[:b - a]; out.append(np.pad(y, (0, b - a - len(y))))
    return _finish(x, np.concatenate(out), sr, bright, low, air, presence, harsh)
