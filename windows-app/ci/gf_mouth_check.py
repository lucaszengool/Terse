"""CI client for AI 女友's mouth on Windows — what the wallpaper page does with the engine, minus the drawing.

The small real-time DUIX model (what a PC without a discrete GPU gets) produces no video file: each sentence is
announced on /events ({"type": "utt", "id", "frames", ...}) and the page asks /patches for its mouth — binary
messages tagged GFP1 / GFP2 carrying a JPEG or WebP patch, then {"done": true}. This makes her say a line, takes every
announced sentence, collects its patches, and checks they are real images and that her mouth moves between them.

    venv\\Scripts\\python.exe gf_mouth_check.py "<line>"      → prints a JSON summary; exit 0 = mouth OK
"""
import asyncio, io, json, os, struct, sys, time, urllib.request

import websockets
from PIL import Image

PORT = os.environ.get("GF_PORT", "8770")
HTTP, WS = f"http://127.0.0.1:{PORT}", f"ws://127.0.0.1:{PORT}"


def post(path, body, timeout=60):
    req = urllib.request.Request(HTTP + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def image_of(msg):
    """a GFP1 / GFP2 patch → (frame index, PIL image) or None"""
    tag = msg[:4]
    if tag == b"GFP1": head = 20
    elif tag == b"GFP2": head = 24
    else: return None
    j = struct.unpack_from("<I", msg, 8)[0]
    try: return j, Image.open(io.BytesIO(msg[head:])).convert("L").resize((64, 64))
    except Exception: return None


async def mouths(uid, n):
    """every patch of one sentence, as the page asks for them (hd=1: the DUIX path; lo/n: the clip she is on)"""
    got, done, bad, err = [], False, 0, None
    async with websockets.connect(f"{WS}/patches?id={uid}&k0=0&hd=1&lo=0&n={n}", max_size=None) as ws:
        try:
            while True:
                m = await asyncio.wait_for(ws.recv(), 120)
                if isinstance(m, (bytes, bytearray)):
                    p = image_of(bytes(m))
                    if p: got.append(p)
                    else: bad += 1
                else:
                    t = json.loads(m)
                    if t.get("done"):
                        done = True; err = t.get("error"); break
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass
    return got, done, bad, err


async def main(line):
    av = json.loads(urllib.request.urlopen(HTTP + "/health", timeout=10).read()).get("avatar") or {}
    n = int(av.get("n") or 0)
    out = {"sentences": []}
    async with websockets.connect(f"{WS}/events", max_size=None) as ev:
        said = post("/say", {"text": line})
        want = len(said.get("sentences") or []) or 1
        t0, utts = time.time(), []
        while len(utts) < want and time.time() - t0 < 240:
            try: m = json.loads(await asyncio.wait_for(ev.recv(), 240 - (time.time() - t0)))
            except asyncio.TimeoutError: break
            if m.get("type") == "utt" and m.get("id"): utts.append(m)
        for u in utts:
            t = time.time()
            got, done, bad, err = await mouths(u["id"], n)
            got.sort(key=lambda p: p[0])
            moves = 0
            for (_, a), (_, b) in zip(got, got[1:]):
                pa, pb = a.tobytes(), b.tobytes()
                d = sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)
                # the small model's lips move little (measured on its patches: mean change 1.05, max 3.97 over 64²) —
                # a frozen mouth is ~0; this asks for real change between frames, not for big openings
                if d > 1.5: moves += 1
            out["sentences"].append({"id": u["id"], "frames": u.get("frames"), "duration": u.get("duration"),
                                     "patches": len(got), "bad": bad, "done": done, "error": err, "moves": moves,
                                     "secs": round(time.time() - t, 1)})
    ok = bool(out["sentences"]) and all(s["patches"] >= 5 and s["bad"] == 0 and s["done"] and not s.get("error") and s["moves"] >= 2
                                        for s in out["sentences"])
    out["ok"] = ok
    print(json.dumps(out, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "你好呀，我是 Mia。")))
