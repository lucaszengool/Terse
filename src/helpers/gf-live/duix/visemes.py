"""Mandarin visemes from MeloTTS's own phoneme timeline (10-21, user: "嘴唇动作太机械了，不像是反映真实 Chinese 的 voice 的发音").

Melo (model_zp.onnx) hands over every pinyin initial / final it says with its exact duration; this turns them into her lip
shape per video frame:
  · viseme classes: CUHK's 20 Mandarin visemes (initials b p m · f · d t n · l · g k h · j q x · zh ch sh r · z c s; finals
    a ang · ai an · ao · o · ou · e eng · ei en · er · i · u · ü), finals with a medial glide split the four-hu way (齐齿 i-,
    合口 u-, 撮口 ü-) into 2–3 visemes in a row (e.g. uo = u → o, iao = i → a → ao), as in Realistic Lip Motion Generation
    Based on 3D Dynamic Viseme and Coarticulation Modeling (arXiv 2604.01756)
  · each viseme: how open (0..1 of her speaking opening), how wide (her mouth's width ×), how round (0..1)
  · coarticulation: Cohen–Massaro dominance blending — every segment pulls the shape towards its target with a bell over
    its time, neighbours overlap (anticipatory rounding etc.); bilabial closures (b p m) and f are always reached (the
    known failure of plain dominance blending at speaking rate)
  · the lips lead the sound by LEAD (they move before it is heard)."""
import numpy as np

LEAD = 0.03
# 10-21 (user: "嘴唇动的幅度和宽度…不够大 … 幅度和频率还是没 match voice 的发音和节奏"): openings rescaled to her 豆包 talking
# take (visible gap during speech p10 / 50 / 90 = 4 / 9.8 / 13.5 px of 256², fully shut only 6 % of the time; ours were 3.4 /
# 4.2 / 6.9): open = fraction of her "a" opening, consonants are the dips between syllables (JALI, Edwards et al. 2016: sibilants
# narrow the jaw greatly, b p m / f close; each viseme rises and falls sharply). Width = her mouth corners × (spread i / e / a
# wider, rounded o / u / ü narrower).
#          open   width  round  dominance
V = {
    'SIL': (0.00, 1.00, 0.0, 0.5),
    'BPM': (0.00, 0.98, 0.0, 3.0),       # lips pressed together
    'F':   (0.06, 1.00, 0.0, 2.2),       # lower lip to the upper teeth
    'DTNL': (0.22, 1.02, 0.0, 1.4),      # tongue-tip: the jaw rises
    'GKH': (0.30, 1.00, 0.0, 1.2),
    'JQX': (0.18, 1.07, 0.0, 1.8),       # sibilants: teeth close, lips spread
    'ZHR': (0.22, 0.94, 0.4, 1.8),       # a little rounded / pushed
    'ZCS': (0.16, 1.07, 0.0, 1.8),
    'Y':   (0.30, 1.08, 0.0, 1.0),
    'W':   (0.28, 0.84, 0.9, 1.3),
    'A':   (1.00, 1.07, 0.0, 1.2),       # wide open
    'AI':  (0.88, 1.08, 0.0, 1.1),
    'AO':  (0.85, 0.95, 0.4, 1.1),
    'O':   (0.75, 0.86, 0.8, 1.2),       # rounded (EMA: o opens about as much as a / i, lips pushed)
    'OU':  (0.68, 0.86, 0.85, 1.2),
    'E':   (0.74, 1.06, 0.0, 1.0),
    'EI':  (0.66, 1.07, 0.0, 1.0),
    'ER':  (0.60, 0.94, 0.3, 1.0),
    'I':   (0.52, 1.10, 0.0, 1.1),       # spread (EMA: i has the larger aperture of i / u / ü)
    'II':  (0.42, 1.06, 0.0, 1.0),       # the buzzing i of zi ci si / zhi chi shi ri
    'U':   (0.45, 0.80, 1.0, 1.3),       # tight round, pushed (EMA: small aperture, strong protrusion)
    'V':   (0.42, 0.83, 1.0, 1.3),       # ü: round, a little wider than u (lip-corner distance tells ü from u)
}
VOWEL = {'A', 'AI', 'AO', 'O', 'OU', 'E', 'EI', 'ER', 'I', 'II', 'U', 'V'}
INIT = {'b': 'BPM', 'p': 'BPM', 'm': 'BPM', 'f': 'F', 'd': 'DTNL', 't': 'DTNL', 'n': 'DTNL', 'l': 'DTNL', 'g': 'GKH',
        'k': 'GKH', 'h': 'GKH', 'j': 'JQX', 'q': 'JQX', 'x': 'JQX', 'zh': 'ZHR', 'ch': 'ZHR', 'sh': 'ZHR', 'r': 'ZHR',
        'z': 'ZCS', 'c': 'ZCS', 's': 'ZCS', 'y': 'Y', 'w': 'W',
        # Melo's zero-initial markers (啊 哦 鹅 恩 …) and English consonants
        'AA': 'A', 'E': 'E', 'EE': 'E', 'En': 'E', 'N': 'DTNL', 'OO': 'O', 'V': 'V',
        'v': 'F', 'th': 'DTNL', 'dh': 'DTNL', 'hh': 'GKH', 'jh': 'ZHR', 'ng': 'GKH'}
FIN = {'a': ['A'], 'ang': ['A'], 'ai': ['AI'], 'an': ['AI'], 'ao': ['A', 'AO'], 'o': ['O'], 'ou': ['O', 'OU'], 'ong': ['U'],
       'e': ['E'], 'eng': ['E'], 'ei': ['EI'], 'en': ['EI'], 'er': ['ER'], 'i': ['I'], 'i0': ['II'], 'ir': ['II'],
       'ia': ['I', 'A'], 'ian': ['I', 'AI'], 'iang': ['I', 'A'], 'iao': ['I', 'A', 'AO'], 'ie': ['I', 'E'], 'in': ['I'],
       'ing': ['I'], 'iong': ['I', 'U'], 'iu': ['I', 'OU'], 'u': ['U'], 'ua': ['U', 'A'], 'uai': ['U', 'AI'],
       'uan': ['U', 'AI'], 'uang': ['U', 'A'], 'ui': ['U', 'EI'], 'un': ['U', 'EI'], 'uo': ['U', 'O'], 'v': ['V'],
       'van': ['V', 'AI'], 've': ['V', 'E'], 'vn': ['V', 'EI'],
       # English vowels (Melo's zh_en)
       'aa': ['A'], 'ae': ['AI'], 'ah': ['E'], 'aw': ['A', 'AO'], 'ay': ['A', 'I'], 'eh': ['E'], 'ey': ['EI'], 'ih': ['I'],
       'iy': ['I'], 'ow': ['O'], 'oy': ['O', 'I'], 'uh': ['OU'], 'uw': ['U']}
SPLIT = {2: [0.35, 0.65], 3: [0.25, 0.40, 0.35]}      # a final's time over its visemes (the glide is short)
PAUSE = {',', '.', '?', '!', '…', 'SP', "'", '-'}


def segments(phones):
    """[(t0, t1, symbol, tone)] → [(centre, duration, viseme)]; blanks share their time between their neighbours"""
    ev = [p for p in phones if p[2] != '_']
    if not ev: return []
    # each sound's span reaches halfway into the blanks around it
    sp = []
    for k, (t0, t1, s, _) in enumerate(ev):
        a = (ev[k - 1][1] + t0) / 2 if k else t0
        b = (t1 + ev[k + 1][0]) / 2 if k + 1 < len(ev) else t1
        sp.append((min(a, t0), max(b, t1), s))
    out = []
    for a, b, s in sp:
        if s in PAUSE: out.append(((a + b) / 2, b - a, 'SIL')); continue
        vs = FIN.get(s) or ([INIT[s]] if s in INIT else None) or FIN.get(s.rstrip(':0')) or ['DTNL']
        fr = SPLIT.get(len(vs), [1.0]); t = a
        for v, f in zip(vs, fr):
            d = (b - a) * f; out.append((t + d / 2, d, v)); t += d
    return out


def track(phones, fps, n, t_shift=0.0, audio=None, sr=16000):
    """per video frame (n frames from t_shift): (open 0..1, width ×, round 0..1, loudness ×) — or None without a timeline.
    audio (her voice, sr Hz, same time base as the phones): each vowel's loudness against the line's mean sets how big she
    says it (JALI: quiet vowels open less, loud ones more; here ±20 %)."""
    seg = segments(phones or [])
    if not seg or n <= 0: return None
    t = np.arange(n) / float(fps) + LEAD + t_shift
    c = np.array([s[0] for s in seg]); d = np.array([max(s[1], 0.02) for s in seg])
    tg = np.array([V[s[2]][:3] for s in seg]); al = np.array([V[s[2]][3] for s in seg])
    # dominance: a bell over each segment, about as wide as the segment, strength by class — compact (exponent 2), so each
    # syllable rises and falls on its own instead of melting into its neighbours
    D = al[None, :] * np.exp(-np.abs((t[:, None] - c[None, :]) / (0.5 * d[None, :] + 0.025)) ** 2.0)
    out = (D[:, :, None] * tg[None]).sum(1) / np.maximum(D.sum(1, keepdims=True), 1e-9)
    # every consonant between vowels is seen: the frame nearest its centre takes the blend at that centre (a 50 ms dip falls
    # between two 24 fps frames otherwise), b p m close and f bites for real
    for (cc, dd, v) in seg:
        if v in VOWEL or v == 'SIL': continue
        tc = cc - LEAD - t_shift; k = int(round(tc * fps))
        if not 0 <= k < n: continue
        Dc = al * np.exp(-np.abs((cc - c) / (0.5 * d + 0.025)) ** 2.0)
        oc = float((Dc * tg[:, 0]).sum() / max(Dc.sum(), 1e-9))
        if v in ('BPM', 'F'): oc = V[v][0]
        out[k, 0] = min(out[k, 0], oc)
        if v in ('BPM', 'F'):
            m = np.abs(t - cc) <= max(0.3 * dd, 0.02)
            out[m, 0] = np.minimum(out[m, 0], V[v][0])
    # lips have mass (user 10-21: "重点是真实自然"): a light [1 2 1] smoothing of the opening, ~40 ms — no one-frame snaps —
    # b p m / f closures kept exact
    if n >= 3:
        shut = np.zeros(n, bool)
        for (cc, dd, v) in seg:
            if v in ('BPM', 'F'): shut |= np.abs(t - cc) <= max(0.3 * dd, 0.02)
        o = np.pad(out[:, 0], 1, mode='edge'); sm = 0.25 * o[:-2] + 0.5 * o[1:-1] + 0.25 * o[2:]
        out[:, 0] = np.where(shut, out[:, 0], sm)
    # silence before / after the words: closed
    first, last = seg[0][0] - seg[0][1] / 2, seg[-1][0] + seg[-1][1] / 2
    out[(t < first - 0.05) | (t > last + 0.08), 0] = 0.0
    loud = np.ones(n, np.float32)
    if audio is not None and len(audio):
        x = np.asarray(audio, np.float32); vi = [(cc, dd) for cc, dd, v in seg if v in VOWEL]
        db = []
        for cc, dd in vi:
            a0, a1 = int(max(0, cc - dd / 2) * sr), int(max(0, cc + dd / 2) * sr)
            db.append(10 * np.log10(float(np.mean(x[a0:a1] ** 2)) + 1e-10) if a1 > a0 + 16 else np.nan)
        db = np.array(db, np.float64)
        if len(db) and np.isfinite(db).sum() >= 2:
            m = np.nanmean(db); j = np.clip(1 + 0.025 * (np.nan_to_num(db, nan=m) - m), 0.8, 1.2)
            vc = np.array([cc for cc, _ in vi])                       # per frame: the nearest vowel's loudness, smoothed
            idx = np.abs(t[:, None] - vc[None, :]).argmin(1); loud = j[idx].astype(np.float32)
            loud = np.convolve(np.pad(loud, 2, mode='edge'), np.ones(5) / 5, mode='valid').astype(np.float32)
    return np.concatenate([out, loud[:, None]], 1).astype(np.float32)
