"""Her own lips, opened the way DINet opens its mouth (10-21, user: "DUIX 嘴的比例比 idle 小很多 … 嘴唇的形状、颜色、嘴唇周围的颜色
要和 idle 一模一样 … 嘴唇周围有一圈阴影").

DINet draws its own lips (thinner and flatter than hers, ~20 L* darker) and its own skin around them (a darker ring 4–12 px out,
measured −25…−30 L*). So from DINet only three things are taken per frame: how far the mouth is open (a smooth arc along the
mouth), a little width change, and the inside of the open mouth (teeth / dark). Everything else — her lip shapes, thickness,
colour, the skin around them — is her own video, warped column by column the way her mouth really moves. Measured on a
豆包 take of her talking (4K, 138 frames aligned on the upper face, 10-21), per pixel of opening ("gap"): the upper lip's inner
edge rises 0.39, its top 0.24 (it thins a little); the lower lip's inner edge drops 0.61, its bottom 0.445; her chin drops 0.49
(the jaw opens with the mouth — a fixed chin under moving lips looked pasted on). Above / below, the skin follows over R rows;
nothing outside the mouth and chin moves.

All geometry is in the 256² face crop (DuixHD's DINet space); maps() returns, for any output grid, where to sample her frame
(and where to sample the open mouth)."""
import numpy as np, cv2

Y0, Y1, X0, X1 = 118, 228, 52, 204          # working window in the 256² face crop
UP, UT, LB, CHIN = 0.39, 0.16, 0.40, 0.0     # × gap: upper inner edge up, upper-lip top up, lower-lip bottom down, chin down
CAP = float(__import__('os').environ.get('GF_LIP_CAP', '0.62'))   # opening ≤ CAP × her lips' height (h0 = half the gap)
# 10-21 history: her take moves the jaw (chin 0.49×, lip outlines 0.24 / 0.445×); a moving chin changed her face ("下巴形状变尖了",
# "脸型改变了…要确保不变") so the chin never moves; with the lip outline frozen too the mouth only opened a slit ("张开幅度太小 …
# 不自然"). Now: her chin and face stay exactly hers, her lips themselves move like lips — the lower lip drops (0.40×), the upper
# lifts a little (0.12×), the opening is deeper inside them (inner edges keep her measured split, 0.39 above / 0.61 below).


def lab(im):
    return cv2.cvtColor(np.ascontiguousarray(im), cv2.COLOR_BGR2LAB)


def threshold(base):
    """lips vs skin on redness (a*), Otsu on her own mouth — reused for DINet's frames (its lips have her a*, ±1.5)"""
    a = lab(base)[..., 1][Y0 + 12:Y1 - 10, X0 + 15:X1 - 15]
    t, _ = cv2.threshold(a, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return float(t)


def lip_mask(im, t):
    a = lab(im)[..., 1]; m = np.zeros(a.shape, np.uint8)
    m[Y0 + 12:Y1 - 10, X0 + 15:X1 - 15] = a[Y0 + 12:Y1 - 10, X0 + 15:X1 - 15] > t
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lb, st, _ = cv2.connectedComponentsWithStats(m)
    if n < 2: return None
    big = st[1:, 4].max(); keep = np.zeros_like(m)
    for j in range(1, n):
        if st[j, 4] > 0.12 * big: keep[lb == j] = 1
    return keep


def base_geometry(im, t):
    """her closed lips per column (smooth curves): top of the upper lip, the lip line, bottom of the lower lip; or None"""
    m = lip_mask(im, t)
    if m is None: return None
    cols = np.flatnonzero(m.sum(0) >= 3)
    if len(cols) < 24: return None
    xl, xr = int(cols.min()), int(cols.max())
    L = cv2.GaussianBlur(lab(im)[..., 0].astype(np.float32), (0, 0), 0.8); xs = np.arange(xl, xr + 1).astype(np.float64)
    ut, ml, lb = (np.full(len(xs), np.nan) for _ in range(3))
    for n, x in enumerate(xs.astype(int)):
        r = np.flatnonzero(m[:, x])
        if len(r) < 3: continue
        ut[n], lb[n] = r.min(), r.max(); a, b = int(ut[n] + 0.3 * (lb[n] - ut[n])), int(lb[n] - 0.25 * (lb[n] - ut[n]))
        if b > a: ml[n] = a + float(np.argmin(L[a:b + 1, x]))
    def fit(v, deg):
        ok = np.isfinite(v)
        return np.polyval(np.polyfit(xs[ok], v[ok], deg), xs) if ok.sum() > deg + 3 else None
    ut, ml, lb = fit(ut, 6), fit(ml, 4), fit(lb, 4)
    if ut is None or ml is None or lb is None: return None
    # her chin per column (the jaw drops with the mouth): the strongest bright → dark step below the lower lip (skin → the
    # shadow under her chin), over the chin's width, as one smooth curve
    g = cv2.GaussianBlur(cv2.cvtColor(np.ascontiguousarray(im), cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.2)
    cxs = np.arange(int(xl - 0.25 * (xr - xl)), int(xr + 0.25 * (xr - xl)) + 1).astype(np.float64); ch = []
    for x in cxs.astype(int):
        y0 = int(np.interp(x, xs, lb) + 10); y1 = min(Y1 - 4, y0 + 70)
        if y1 - y0 < 6: ch.append(np.nan); continue
        col = g[y0:y1, max(0, x - 1):x + 2].mean(1); d = col[1:] - col[:-1]; ch.append(y0 + float(np.argmin(d)))
    ch = np.asarray(ch); ok = np.isfinite(ch)
    chin = _robust(cxs[ok], ch[ok], 2) if ok.sum() > 8 else np.interp(cxs, xs, lb) + 26
    pc = np.polyfit(cxs[ok] if ok.sum() > 8 else cxs, chin, 2)
    ml = np.clip(ml, ut + 1, lb - 1)
    return dict(xl=float(xl), xr=float(xr), xs=xs, ut=ut, ml=ml, lb=lb, chin_p=pc, ml_s=np.polyval(np.polyfit(xs, ml, 2), xs))


def _robust(xs, ys, deg=2):
    """smooth curve through (xs, ys): polynomial fit, points > 2 px off dropped, refit"""
    p = np.polyfit(xs, ys, deg); r = np.abs(ys - np.polyval(p, xs)); ok = r < max(2.0, 2.0 * np.median(r))
    if ok.sum() > deg + 2: p = np.polyfit(xs[ok], ys[ok], deg)
    return np.polyval(p, xs)


def opening(gen, t, gb, dt=4.0):
    """DINet's (or her own) open mouth → its gap per column + a smooth arc (half-height h0, half-width hw). h0 = 0: closed.
    Per column from the outside in: down from the nose through the upper lip, up from the chin through the lower lip (lip =
    a* > t + dt, a contiguous run); the gap is what lies between — teeth (pale) and tongue (red, but darker / less red than
    lips: a* 145–150 vs 153–164 measured) alike."""
    m = lip_mask(gen, t)
    if m is None: return None
    cols = np.flatnonzero(m.sum(0) >= 3)
    if len(cols) < 16: return None
    xl, xr = float(cols.min()), float(cols.max())
    a = cv2.GaussianBlur(lab(gen)[..., 1].astype(np.float32), (0, 0), 0.7); lipc = a > t + dt
    res = dict(xl=xl, xr=xr, h0=0.0)
    X, top, bot = [], [], []
    for x in range(int(xl) + 3, int(xr) - 2):
        r = np.flatnonzero(m[:, x])
        if len(r) < 3: continue
        c = lipc[:, x]; y0, y1 = int(r.min()), int(r.max())
        y = y0
        while y <= y1 and not c[y]: y += 1                    # into the upper lip
        while y <= y1 and c[y]: y += 1                        # through it
        u = y
        y = y1
        while y >= y0 and not c[y]: y -= 1                    # into the lower lip (from the chin)
        while y >= y0 and c[y]: y -= 1                        # through it
        l = y
        if l - u >= 2: X.append(x); top.append(u - 0.5); bot.append(l + 0.5)
    if len(X) < 6: return res
    X = np.asarray(X, np.float64); top, bot = _robust(X, np.asarray(top, np.float64)), _robust(X, np.asarray(bot, np.float64))
    # the corners are thin and darker (the scan misses them): both edges are arcs through the mouth's corners (where the
    # lips meet), their bulge fitted to what the scan found — a lens, never curling up into a lip
    cl, cr = np.flatnonzero(m[:, int(xl)]).mean(), np.flatnonzero(m[:, int(xr)]).mean()
    def through_corners(ys):
        base = cl + (cr - cl) * (X - xl) / (xr - xl); q = (X - xl) * (X - xr)
        k = float(np.sum((ys - base) * q) / max(1e-6, np.sum(q * q)))
        xx = np.arange(int(xl) + 2, int(xr) - 1, dtype=np.float64)
        return xx, cl + (cr - cl) * (xx - xl) / (xr - xl) + k * (xx - xl) * (xx - xr)
    _, top = through_corners(top); X, bot = through_corners(bot)
    keep = bot - top >= 1.0
    if keep.sum() < 6: return res
    X, top, bot = X[keep], top[keep], bot[keep]; h = (bot - top) / 2
    hwb = (gb['xr'] - gb['xl']) / 2
    hw = float(np.clip((X.max() - X.min()) / 2 + 3, 0.45 * hwb, 1.0 * hwb))
    xc = float(np.average(X, weights=h))
    u = np.clip(1 - ((X - xc) / hw) ** 2, 0, 1); h0 = float(np.sum(h * u) / max(1e-6, np.sum(u * u)))
    res.update(h0=h0, hw=hw, xc=xc, X=X, top=top, bot=bot)
    return res


def lerp_op(a, b, f):
    """an opening between two of DINet's (in-between frames: the mouth moves every frame, DINet runs every few). A closed
    side has no arc of its own: it opens from / closes to the open side's arc."""
    if a is None or b is None: return a or b
    out = dict(b if f >= 0.5 else a)
    for k in ('h0', 'hw', 'xc', 'xl', 'xr'):
        va, vb = a.get(k, b.get(k)), b.get(k, a.get(k))
        if va is not None and vb is not None: out[k] = (1 - f) * va + f * vb
    return out


def _pwl(y, kt, kb):
    """per column piecewise-linear map of rows: y (H, W) through control points kt → kb (K, W), kt sorted along K"""
    out = np.empty_like(y)
    lo = kt[0]; out[:] = kb[0] + (y - lo)                    # (rows before the first point never occur: kt[0] = Y0)
    for i in range(kt.shape[0] - 1):
        a, b, ca, cb = kt[i], kt[i + 1], kb[i], kb[i + 1]
        m = (y >= a) & (y <= b)
        f = (y - a) / np.maximum(b - a, 1e-6)
        out = np.where(m, ca + f * (cb - ca), out)
    return out


def maps(gb, op, R=10, RD=22, RX=14, sx_lim=(1.0, 1.0), src=None, up_share=0.62, arc=0.6, widen=0.0):
    """Over the working window (256² coordinates): (mapx, mapy) = where to sample HER frame, (gx, gy) = where to sample the
    open mouth, gap = how much of each pixel is the open mouth (0..1). Vectorized over columns (10-21: 4K mouths every frame).
    The open mouth comes from DINet's gap (stretched to hers), or — src = {X, top, bot}: the gap of a wide-open frame of her
    own (her real teeth) — anchored, not stretched: the top up_share of the opening shows that frame's rows just under its
    upper lip (her upper teeth, natural size), the rest its rows just above its lower lip. A wider opening reveals more."""
    yy, xx = np.mgrid[Y0:Y1, X0:X1].astype(np.float32)
    x = np.arange(X0, X1, dtype=np.float64)
    cxb = (gb['xl'] + gb['xr']) / 2; hwb = (gb['xr'] - gb['xl']) / 2
    # width: op['sx'] (DINet's width over its own closed width — its lips are ~10 % narrower than hers) or its corners vs hers;
    # her mouth also stretches sideways as it opens (measured on her talking take; calm talk takes ~half of it)
    h0 = op['h0'] if op.get('h0', 0) > 0.4 else 0.0
    rnd = float(op.get('round', 0.0))                                           # visemes: o / u / ü round her lips
    if op.get('vis'): sx_lim, widen = (0.78, 1.16), 0.0                         # the visemes set her width themselves
    # all of the opening is inside her lips: never more than about half their height (thinner reads as stretched)
    cc = (gb["xl"] + gb["xr"]) / 2; h0 = min(h0, CAP * float(np.interp(cc, gb["xs"], gb["lb"]) - np.interp(cc, gb["xs"], gb["ut"])))
    sx = op['sx'] if 'sx' in op else ((op['xr'] - op['xl']) / max(1.0, gb['xr'] - gb['xl']) if 'xr' in op else 1.0)
    sx = float(np.clip(sx * (1 + widen * 2 * h0 / max(1.0, gb['xr'] - gb['xl'])), *sx_lim))
    fade = np.clip(1 - (np.abs(x - cxb) - hwb * sx) / RX, 0, 1)                 # width change: her mouth ± RX
    xb = x + ((cxb + (x - cxb) / sx) - x) * fade                               # her column for each target column
    mapx = np.broadcast_to(xb.astype(np.float32)[None], yy.shape).copy()
    hw = float(np.clip(op.get('hw', hwb), 0.6 * hwb, 0.86 * hwb)) * sx         # the opening spans most of her mouth, not
                                                                               # into her corners (dark wedges, 10-21)
    if rnd > 0: hw *= 1 - 0.45 * rnd; arc = arc + 0.7 * rnd                     # round: a smaller, rounder opening
    inside = (xb >= gb['xl']) & (xb <= gb['xr'])
    xi = np.clip(xb, gb['xl'], gb['xr'])
    ut_b, ml_b, lb_b = (np.interp(xi, gb['xs'], gb[k]) for k in ('ut', 'ml', 'lb'))
    ext = 0.25 * (gb['xr'] - gb['xl'])
    chin_b = np.polyval(gb['chin_p'], np.clip(xb, gb['xl'] - ext, gb['xr'] + ext))
    # the jaw drops as a whole under her chin (flat across it, fading only beyond): a drop that peaks in the middle pulled
    # her round chin into a V (user 10-21: "下巴形状变尖了")
    wc = np.clip((1.7 * hwb - np.abs(x - cxb)) / (0.8 * hwb), 0, 1); wc = wc * wc * (3 - 2 * wc)
    chin_t = chin_b + CHIN * 2 * h0 * wc
    g = np.where(inside, 2 * h0 * np.clip(1 - ((x - cxb) / hw) ** 2, 0, None) ** arc, 0.0) if h0 > 0 else np.zeros_like(x)
    # open, her lips' inner edges become smooth arcs (closed, her own lip line exactly) — the meeting line of closed lips is
    # wavy, and copied onto both inner edges it looked like torn paper; its dark shadow (≈2 rows) is skipped, not stretched
    beta = np.clip(g / 6.0, 0, 1); ml_e = ml_b * (1 - beta) + np.interp(xi, gb['xs'], gb['ml_s']) * beta
    dsk = 1.5 * np.clip(g / 3.0, 0, 1)
    ub_t, lt_t = ml_e - UP * g, ml_e + (1 - UP) * g
    ut_t, lb_t = ut_b - UT * g, np.minimum(lb_b + LB * g, chin_t - 3)
    if rnd > 0: ut_t, lb_t = ut_t - 1.0 * rnd, np.minimum(lb_t + 1.0 * rnd, chin_t - 3)   # pursed lips look a little fuller
    # beside her mouth only the jaw moves: the lip rows collapse onto the lip line at her corner
    ml_c = np.where(xb < gb['xl'], gb['ml'][0], gb['ml'][-1])
    for v in (ut_t, ub_t, lt_t, lb_t): v[~inside] = ml_c[~inside]
    ut_s, ub_s, lt_s, lb_s = (np.where(inside, a, ml_c) for a in (ut_b, ml_b - 0.01 - dsk, ml_b + 0.01 + dsk, lb_b))
    kt = np.stack([np.full_like(x, Y0), ut_t - R, ut_t, ub_t, lt_t, lb_t, chin_t, chin_t + RD, np.full_like(x, Y1)])
    kb = np.stack([np.full_like(x, Y0), ut_t - R, ut_s, ub_s, lt_s, lb_s, chin_b, chin_t + RD, np.full_like(x, Y1)])
    o = np.argsort(kt, axis=0, kind='stable'); kt = np.take_along_axis(kt, o, 0); kb = np.take_along_axis(kb, o, 0)
    mapy = _pwl(yy.astype(np.float64), kt[:, None, :], kb[:, None, :]).astype(np.float32)
    gap = np.zeros_like(yy); gx = xx.copy(); gy = yy.copy()
    op_cols = g > 1.0
    if op_cols.any() and (src is not None or 'X' in op):
        G = (yy > ub_t[None].astype(np.float32)) & (yy < lt_t[None].astype(np.float32)) & op_cols[None]
        gap = G.astype(np.float32)
        if src is not None:
            # her real teeth stay where they are in her face (the take is aligned to this clip): her lips just uncover them —
            # small openings show the dark between them, wider ones more teeth; never squeezed or bent to the lip line.
            # The lower part (tongue, lower teeth) rides on her lower lip / jaw.
            # the same column of her face (teeth never stretch) — unless her opening here is wider than the take's: then fitted
            # inside it (an edge column repeated read as a dark notch beside the teeth, user 10-21: "小重影")
            sxc, shw = (src['X'].min() + src['X'].max()) / 2, (src['X'].max() - src['X'].min()) / 2
            hg = float(np.abs(x[op_cols] - cxb).max()) if op_cols.any() else 1.0
            xs = sxc + (x - cxb) * min(1.0, (shw - 1.5) / max(1.0, hg))
            ts, bs = np.interp(xs, src['X'], src['top']), np.interp(xs, src['X'], src['bot'])
            cut = ub_t + up_share * (lt_t - ub_t)
            # upper: her teeth hang from her upper lip's inner edge at their natural size (the edge is a smooth arc now; pinned
            # to the face instead, a wide opening reached above the take's own opening and smeared a row into pillars);
            # lower: on the jaw, up from her lower lip. Blended over 3 rows: no seam.
            wl = np.clip((yy - cut[None] + 1.5) / 3.0, 0, 1); wl = wl * wl * (3 - 2 * wl)
            # (the take's lower teeth sit right on its lower lip — calm speech hardly shows them: their row is skipped)
            gyv = (1 - wl) * (ts[None] + (yy - ub_t[None])) + wl * (bs[None] - 2.5 - (lt_t[None] - yy))
            # 10-21 (user: "张开幅度…不够大"): opened wider than the take's own opening, the two anchored zones ran out of it and
            # its lower lip repeated in the middle as a second lip. Then: the upper half of the take's opening (her teeth) from
            # her upper lip and its lower third from her lower lip at natural size, the dark middle between stretched to fill
            sg = np.maximum(bs - 2.5 - ts, 2.0); tg = lt_t - ub_t; wide = tg > sg
            if wide.any():
                At, Bt = 0.5 * sg, 0.3 * sg; m0, m1 = ub_t + At, lt_t - Bt
                k_ = (sg - At - Bt) / np.maximum(m1 - m0, 1e-3)
                gw = np.where(yy <= m0[None], ts[None] + (yy - ub_t[None]),
                     np.where(yy >= m1[None], bs[None] - 2.5 - (lt_t[None] - yy), (ts + At)[None] + (yy - m0[None]) * k_[None]))
                gyv = np.where(wide[None], gw, gyv)
            gyv = np.clip(gyv, ts[None] + 1.0, bs[None] - 1.0)                           # only inside the take's opening: its own
                                                                                         # lip edges showed as a second lip
        else:
            xs = np.clip(op['xc'] + (x - cxb) / sx, op['X'].min(), op['X'].max())
            tg, bg = np.interp(xs, op['X'], op['top']), np.interp(xs, op['X'], op['bot'])
            gyv = tg[None] + (yy - ub_t[None]) / np.maximum(1e-3, (lt_t - ub_t)[None]) * (bg - tg)[None]
        gy = np.where(G, gyv, yy).astype(np.float32); gx = np.where(G, np.broadcast_to(xs[None], yy.shape), xx).astype(np.float32)
    # the opening's edges per column too: the caller draws its outline at its own (4K) resolution — a mask built on this
    # 256² grid steps every few columns (1 row = 4.6 px at 4K: a staircase along her upper lip, 10-21)
    tv = np.clip((g - 3.0) / 6.0, 0, 1); tv = tv * tv * (3 - 2 * tv) * (1 - 0.75 * rnd)   # teeth: hidden in a small or
    edges = dict(x=x, ub=ub_t, lt=lt_t, on=op_cols.astype(np.float64), tv=tv)             # rounded opening (dark cavity)
    return mapx, mapy, gx, gy, edges
