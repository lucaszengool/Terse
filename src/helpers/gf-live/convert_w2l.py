"""One-time, per Mac: LiveTalking's wav2lip256 checkpoint -> two Core ML programs (fp16) for lipsync-runner.

  w2l256_enc_fp16.mlpackage   face encoder   (masked+reference face -> 8 skip features)   run once per idle frame
  w2l256_dec_fp16.mlpackage   audio encoder + decoder (mel, alpha, 8 features -> mouth)  run per spoken frame

Splitting lets the idle loop's encoder half be precomputed, and fp16 inputs/outputs halve the memory those
cached features take. Run by the one-click setup (setup.sh); torch + coremltools are uninstalled afterwards.

usage: python convert_w2l.py <wav2lip256.pth> <out_dir>
"""
import os, sys
import numpy as np
import torch
import torch.nn as nn
import coremltools as ct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from w2l_model import Wav2Lip


class Enc(nn.Module):
    def __init__(self, m):
        super().__init__(); self.b = m.face_encoder_blocks

    def forward(self, face):
        feats = []; x = face
        for f in self.b:
            x = f(x); feats.append(x)
        return tuple(feats)


class Dec(nn.Module):
    def __init__(self, m):
        super().__init__(); self.a = m.audio_encoder; self.d = m.face_decoder_blocks; self.o = m.output_block

    def forward(self, mel, alpha, *feats):
        x = self.a(mel) * alpha                       # alpha = LiveTalking's a_alpha ("放大音频强度")
        feats = list(feats)
        for f in self.d:
            x = f(x); x = torch.cat((x, feats[-1]), dim=1); feats.pop()
        return self.o(x)


def main():
    pth, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    m = Wav2Lip()
    sd = torch.load(pth, map_location="cpu", weights_only=True)
    sd = sd.get("state_dict", sd)
    m.load_state_dict({k.replace("module.", ""): v for k, v in sd.items()})
    m.eval()
    enc, dec = Enc(m).eval(), Dec(m).eval()
    face = torch.rand(1, 6, 256, 256); mel = torch.randn(1, 1, 80, 16); alpha = torch.ones(1, 1, 1, 1)
    with torch.no_grad():
        feats = enc(face)
        ref = m(mel, face).numpy()
        tre = torch.jit.trace(enc, (face,))
        trd = torch.jit.trace(dec, (mel, alpha, *feats))
    names = [f"f{i}" for i in range(len(feats))]
    f16 = np.float16
    mle = ct.convert(tre, inputs=[ct.TensorType(name="face", shape=face.shape)],
                     outputs=[ct.TensorType(name=n, dtype=f16) for n in names],
                     compute_precision=ct.precision.FLOAT16, minimum_deployment_target=ct.target.macOS13,
                     convert_to="mlprogram")
    mld = ct.convert(trd, inputs=[ct.TensorType(name="mel", shape=mel.shape), ct.TensorType(name="alpha", shape=alpha.shape)] +
                     [ct.TensorType(name=n, shape=f.shape, dtype=f16) for n, f in zip(names, feats)],
                     outputs=[ct.TensorType(name="pred", dtype=f16)],
                     compute_precision=ct.precision.FLOAT16, minimum_deployment_target=ct.target.macOS13,
                     convert_to="mlprogram")
    pe, pd = os.path.join(out, "w2l256_enc_fp16.mlpackage"), os.path.join(out, "w2l256_dec_fp16.mlpackage")
    mle.save(pe); mld.save(pd)
    # sanity: the split Core ML pair must match the PyTorch model
    fe = ct.models.MLModel(pe).predict({"face": face.numpy()})
    p = ct.models.MLModel(pd).predict({"mel": mel.numpy(), "alpha": alpha.numpy(), **{n: fe[n] for n in names}})["pred"]
    err = float(np.abs(np.asarray(p, np.float32) - ref).max())
    print(f"converted, max err vs torch {err:.4f}")
    if err > 0.05:
        sys.exit("conversion check failed")


if __name__ == "__main__":
    main()
