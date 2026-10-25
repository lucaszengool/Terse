"""DUIX DINetV1 runner for Windows — terse-gf-duix's wire protocol on ONNX Runtime instead of Core ML.

macOS runs the model in duix-runner.swift (Core ML, pinned to a GPU). Windows has no Core ML, so this speaks the same
protocol over stdin/stdout with ONNX Runtime: DirectML on any DirectX 12 GPU (NVIDIA, AMD, Intel), the CPU otherwise.
runner_client.py starts it in place of the Swift binary; nothing above it changes.

    python ort_runner.py <duix_p.onnx> <duix_d.onnx>      fast split (P per base frame, D per spoken frame)
    python ort_runner.py <dinet_v1.onnx>                   whole model ('F')

Requests:  tag (1 byte) + request id (u32) + float32 / float16 tensors, exactly as the Swift runner reads them.
Replies:   'R' + id + length + bytes, or 'E' + length + message.
The models are the ONNX graphs the Core ML ones were converted from (duix-split: P.onnx, Dc.onnx), so the pixels the
blend uses are the same."""
import os, queue, struct, sys, threading
import numpy as np
import onnxruntime as ort

PLANE = 256 * 256
TZ_N = 512 * 32 * 32


def log(msg):
    sys.stderr.write(f'duix-runner: {msg}\n'); sys.stderr.flush()


def session(path):
    """DirectML when there is a GPU for it (DUIX_GPU=cpu forces the CPU), CPU otherwise. DirectML needs sequential
    execution and no memory-pattern planning."""
    so = ort.SessionOptions(); so.log_severity_level = 3
    want_cpu = os.environ.get('DUIX_GPU', '') == 'cpu'
    if not want_cpu and 'DmlExecutionProvider' in ort.get_available_providers():
        so.enable_mem_pattern = False; so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            s = ort.InferenceSession(path, so, providers=[('DmlExecutionProvider', {'device_id': int(os.environ.get('DUIX_DML_DEVICE', '0'))}),
                                                          'CPUExecutionProvider'])
            return s, 'DirectML'
        except Exception as e:                         # a GPU DirectML cannot use: the CPU still works
            log(f'DirectML unavailable ({e}); using the CPU')
    so = ort.SessionOptions(); so.log_severity_level = 3
    so.intra_op_num_threads = int(os.environ.get('DUIX_THREADS', '0') or 0)
    return ort.InferenceSession(path, so, providers=['CPUExecutionProvider']), 'CPU'


def rgb(out):
    """[1, 3, H, W] float (0..1) → HWC RGB uint8, rounded as duix-runner.swift rounds"""
    a = np.clip(out[0].transpose(1, 2, 0) * 255.0 + 0.5, 0, 255)
    return np.ascontiguousarray(a.astype(np.uint8)).tobytes()


def main():
    args = sys.argv[1:]
    if len(args) not in (1, 2):
        log('usage: ort_runner.py <duix_p.onnx> <duix_d.onnx> | <dinet_v1.onnx>'); sys.exit(2)
    split = len(args) == 2
    if split:
        P, dev = session(args[0]); D, _ = session(args[1]); F = None
        p_in = [i.name for i in P.get_inputs()]; d_in = [i.name for i in D.get_inputs()]
    else:
        F, dev = session(args[0]); P = D = None
        f_in = [i.name for i in F.get_inputs()]
    log(f'{dev} ({"split" if split else "whole model"})')

    rd, wr = sys.stdin.buffer, sys.stdout.buffer
    out_lock = threading.Lock()

    def reply(req, data):
        with out_lock:
            wr.write(b'R' + struct.pack('<II', req, len(data)) + data); wr.flush()

    def error(msg):
        b = msg.encode()
        with out_lock:
            wr.write(b'E' + struct.pack('<I', len(b)) + b); wr.flush()

    def exact(n):
        b = rd.read(n)
        return b if b is not None and len(b) == n else None

    # Reading and computing overlap: the next request is read while the model runs (ONNX Runtime releases the GIL).
    # One compute thread — DirectML runs one inference at a time.
    work = queue.Queue(maxsize=8)

    def reader():
        sizes = {b'F': (2 * 3 * PLANE + 256 * 20) * 4, b'P': 2 * 3 * PLANE * 4,
                 b'D': (3 * PLANE + 256 * 20) * 4 + TZ_N * 2 + 256 * 4, b'M': 192 * 160 * 4}
        while True:
            tag = rd.read(1)
            if not tag: break
            head = exact(4)
            if head is None: break
            req = struct.unpack('<I', head)[0]
            n = sizes.get(tag)
            if n is None: error(f'unknown request {tag!r}'); break
            body = exact(n)
            if body is None: break
            work.put((tag, req, body))
        work.put(None)

    threading.Thread(target=reader, daemon=True).start()
    while True:
        item = work.get()
        if item is None: break
        tag, req, body = item
        try:
            f32 = np.frombuffer(body, np.float32, count=(3 * PLANE + 256 * 20) if tag == b'D' else -1)
            if tag == b'F' and F is not None:
                src = f32[:3 * PLANE].reshape(1, 3, 256, 256); ref = f32[3 * PLANE:6 * PLANE].reshape(1, 3, 256, 256)
                aud = f32[6 * PLANE:].reshape(1, 256, 20)
                reply(req, rgb(F.run(None, dict(zip(f_in, (src, ref, aud))))[0]))
            elif tag == b'P' and P is not None:
                src = f32[:3 * PLANE].reshape(1, 3, 256, 256); ref = f32[3 * PLANE:].reshape(1, 3, 256, 256)
                tz, ip = P.run(None, dict(zip(p_in, (src, ref))))
                reply(req, np.ascontiguousarray(tz, np.float16).tobytes() + np.ascontiguousarray(ip, np.float32).tobytes())
            elif tag == b'D' and D is not None:
                src = f32[:3 * PLANE].reshape(1, 3, 256, 256); aud = f32[3 * PLANE:].reshape(1, 256, 20)
                o = (3 * PLANE + 256 * 20) * 4
                tz = np.frombuffer(body, np.float16, count=TZ_N, offset=o).astype(np.float32).reshape(1, 512, 32, 32)
                ip = np.frombuffer(body, np.float32, count=256, offset=o + TZ_N * 2).reshape(1, 256)
                reply(req, rgb(D.run(None, dict(zip(d_in, (src, aud, tz, ip))))[0]))
            else:                                       # 'M' (MeloTTS decoder) lives in the Core ML runner only
                error(f'{tag.decode()}: not available in this runner')
        except Exception as e:
            error(f'{tag.decode()}: {e}')


if __name__ == '__main__':
    main()
