"""OmniVoice voice server for HD reply mode (user 10-19: "要用 omnivoice，要确保和 repo 用的一模一样").

The official k2-fsa OmniVoice pipeline, called the way beiyege-01/dsh-voice-ai-girlfriend's voice_bridge.py does
(clone mode: ref_audio + ref_text, language Chinese, guidance 2.0, denoise, preprocess / postprocess on), with the
transformer on the Radeon through Core ML (omni_coreml.FastRunnerBackend + omni_fast's decode loop):
  · "exact": 32 steps, refresh 1 → the same tokens as the official loop (verified), only the hardware differs
  · "fast" : 16 steps, refresh 4 (approximate prefix cache) — the default for live replies
Runs in its own Python (PyTorch ≥ 2.4 for transformers 5; on Intel Macs that is conda-forge — GF_OMNI_PY in engine.py).

  GET  /health
  POST /v1/audio/speech {"input", "voice" | "ref" + "ref_text", "mode": fast|exact, "steps", "refresh", "seed", "speed"}
       → s16le 24 kHz mono PCM
"""
import argparse, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np, torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
HF = os.path.expanduser(os.environ.get('GF_OMNI_HF', '~/.terse/gf-live/models/omnivoice/hf'))
VOICE_DIRS = [os.path.expanduser('~/.terse/gf-live/voices'), os.path.join(os.path.dirname(HERE), 'voices')]
MODES = {'exact': (32, 1), 'fast': (16, 4)}


class Omni:
    def __init__(self):
        from omnivoice import OmniVoice
        import omni_fast
        from omni_coreml import FastRunnerBackend
        torch.set_num_threads(int(os.environ.get('GF_OMNI_THREADS', '8')))
        t = time.time()
        self.m = OmniVoice.from_pretrained(HF, device_map='cpu', dtype=torch.float32)
        self.fast, self.be = omni_fast, FastRunnerBackend()
        self.prompts, self.lock = {}, threading.Lock()
        print(f'[omni] model + Radeon runner up in {time.time() - t:.1f}s', flush=True)

    def prompt(self, ref, ref_text):
        key = (ref, os.path.getmtime(ref), ref_text)
        if key not in self.prompts:                       # the reference is encoded once per voice
            self.prompts[key] = self.m.create_voice_clone_prompt(ref_audio=ref, ref_text=ref_text)
        return self.prompts[key]

    def speak(self, text, ref, ref_text, mode='fast', steps=None, refresh=None, seed=None, speed=None):
        s0, r0 = MODES.get(mode, MODES['fast'])
        steps, refresh = int(steps or s0), int(refresh or r0)
        with self.lock:
            self.fast.install(self.m, self.be, refresh=refresh)
            if seed is not None: torch.manual_seed(int(seed))
            t = time.time()
            a = self.m.generate(text=text, language='Chinese', voice_clone_prompt=self.prompt(ref, ref_text), num_step=steps,
                                guidance_scale=2.0, denoise=True, postprocess_output=True,
                                speed=None if speed is None or abs(float(speed) - 1) < 0.02 else float(speed))[0]
            print(f'[omni] {len(a) / 24000:.2f}s audio in {time.time() - t:.1f}s ({mode}, {steps} steps, refresh {refresh})', flush=True)
        return np.asarray(a, np.float32)


def resolve(body):
    if body.get('ref'):
        ref = os.path.expanduser(body['ref'])
        txt = body.get('ref_text') or (open(os.path.splitext(ref)[0] + '.txt', encoding='utf-8').read() if os.path.exists(os.path.splitext(ref)[0] + '.txt') else '')
        return ref, txt.strip()
    name = body.get('voice') or 'tianmei'
    for d in VOICE_DIRS:
        w, t = os.path.join(d, name + '.wav'), os.path.join(d, name + '.txt')
        if os.path.exists(w) and os.path.exists(t): return w, open(t, encoding='utf-8').read().strip()
    raise FileNotFoundError(f'no reference audio for voice {name!r}')


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--port', type=int, default=8093); a = ap.parse_args()
    omni = Omni()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def _send(self, code, data, ctype):
            self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(data)))
            self.end_headers(); self.wfile.write(data)

        def do_GET(self):
            if self.path == '/health': self._send(200, b'{"ok":true}', 'application/json')
            else: self._send(404, b'{}', 'application/json')

        def do_POST(self):
            if self.path != '/v1/audio/speech': return self._send(404, b'{}', 'application/json')
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                ref, ref_text = resolve(body)
                wav = omni.speak(body['input'], ref, ref_text, body.get('mode', 'fast'), body.get('steps'), body.get('refresh'), body.get('seed'), body.get('speed'))
                self._send(200, (np.clip(wav, -1, 1) * 32767).astype('<i2').tobytes(), 'audio/pcm')
            except Exception as e:
                self._send(500, json.dumps({'error': str(e)}).encode(), 'application/json')

    print(f'[omni] listening on 127.0.0.1:{a.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', a.port), H).serve_forever()


if __name__ == '__main__':
    main()
