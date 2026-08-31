#!/usr/bin/env python3
"""
Generate the Home Screen icon set for the Terse phone web app.

    python3 scripts/make-pwa-icons.py

iOS ignores the manifest's icon list for the Home Screen and uses
<link rel="apple-touch-icon"> instead, so the 180px file has to exist as well as
the 192/512 pair the manifest declares. All of them are drawn here so they can
never drift apart.

The 180px file is icon-180.png, NOT landing/apple-touch-icon.png: that one is the
marketing site's own icon, referenced from every page on it, and the phone app
having its own mark must not silently restyle every browser tab on terseai.org.

Two shapes are produced from the same mark:
  · "any"      — the mark on its own rounded tile, for platforms that mask
                 nothing (iOS already rounds it, hence a modest corner radius)
  · "maskable" — the same mark inset to the 80% safe zone on a full bleed square,
                 so Android can crop it to a circle without clipping the glyph
"""
from PIL import Image, ImageDraw

INK = (10, 10, 16, 255)        # #0a0a10 — the same ground the auth pages use
ACCENT = (110, 231, 183, 255)  # #6ee7b7 — Terse emerald


def draw_mark(size, inset_ratio, radius_ratio, bleed):
    """The T, centred, on its tile. inset_ratio is the fraction of the canvas the
    mark occupies; bleed fills the whole square instead of a rounded tile."""
    ss = 4  # supersample, then downscale — PIL has no antialiased rounded_rectangle
    S = size * ss
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if bleed:
        d.rectangle([0, 0, S, S], fill=INK)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius_ratio), fill=INK)

    # The glyph: a crossbar and a stem, in the proportions of a heavy grotesque T.
    m = S * inset_ratio                     # mark width
    x0 = (S - m) / 2
    y0 = (S - m) / 2
    bar_h = m * 0.20
    stem_w = m * 0.22
    r = bar_h * 0.28

    d.rounded_rectangle([x0, y0 + m * 0.14, x0 + m, y0 + m * 0.14 + bar_h],
                        radius=r, fill=ACCENT)
    d.rounded_rectangle([(S - stem_w) / 2, y0 + m * 0.14,
                         (S + stem_w) / 2, y0 + m * 0.86],
                        radius=r, fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


TARGETS = [
    # (path, size, mark inset, corner radius, full bleed)
    ('landing/icon-192.png', 192, 0.56, 0.22, False),
    ('landing/icon-512.png', 512, 0.56, 0.22, False),
    ('landing/icon-maskable-512.png', 512, 0.44, 0.0, True),
    ('landing/icon-180.png', 180, 0.56, 0.22, False),
]

if __name__ == '__main__':
    for path, size, inset, radius, bleed in TARGETS:
        draw_mark(size, inset, radius, bleed).save(path)
        print(f'wrote {path} ({size}×{size})')
