#!/usr/bin/env python3
"""
Reference QR encoder for src/renderer/qrcode.test.mjs.

Reads {"cases": [...], "masks": [...], "levels": [...]} on stdin and writes the module matrix the
`qrcode` package produces for each (payload, mask) pair.

    pip3 install qrcode

Byte mode and the mask are both forced rather than chosen. python-qrcode scores its mask candidates
with the format modules blanked, while the standard scores the complete symbol,
so the two implementations legitimately tie-break to different masks on some
inputs. Forcing the mask removes that disagreement and leaves the comparison
testing what it is meant to test: the encoding itself.
"""
import json
import sys

import qrcode
import qrcode.util
from qrcode.constants import ERROR_CORRECT_M

LEVELS = {
    "L": qrcode.constants.ERROR_CORRECT_L,
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
    "H": qrcode.constants.ERROR_CORRECT_H,
}

req = json.load(sys.stdin)
out = {}
for text in req["cases"]:
    out[text] = {}
    for level in req.get("levels", ["M"]):
        per_mask = {}
        version = None
        for mask in req["masks"]:
            q = qrcode.QRCode(error_correction=LEVELS[level], box_size=1, border=0,
                              mask_pattern=mask)
            # Byte mode is forced. python-qrcode picks the most COMPACT mode
            # for the data, so an all-uppercase payload like a bare pair code
            # comes out in alphanumeric mode — a different, equally valid
            # encoding that a byte-mode encoder will never match. Forcing it
            # keeps the comparison about correctness, not mode selection.
            q.add_data(qrcode.util.QRData(text.encode("utf-8"),
                                          mode=qrcode.util.MODE_8BIT_BYTE))
            q.make(fit=True)
            version = q.version
            per_mask[str(mask)] = [[bool(v) for v in row] for row in q.modules]
        out[text][level] = {"version": version, "masks": per_mask}
json.dump(out, sys.stdout)
