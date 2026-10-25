"""OmniVoice fast mode (user 10-19 "build fast mode"): the official k2-fsa OmniVoice pipeline (text, duration estimate,
reference preprocessing, MaskGIT schedule, CFG scoring, codec, post-processing — unchanged) with its decode loop
replaced by a cached-prefix version (Fast-dLLM-style approximate KV cache):

  · every `refresh` steps model A runs the full conditional sequence and caches every layer's prefix keys / values
    (style + text + reference audio — about 2/3 of the tokens);
  · every step model B recomputes only the target tokens, for [cond, uncond] in one batch: the cond row attends to the
    cached prefix + itself, the uncond row (target only, exactly as upstream) masks the prefix out.
refresh = 1 reproduces the upstream loop exactly (same RNG order); larger values trade a little fidelity for speed.
Backends: TorchBackend (fp32 reference) and the Core ML runner (Radeon) in omni_coreml.py."""
import math, types
import torch
import torch.nn.functional as F

from omnivoice.models.omnivoice import _get_time_steps, _gumbel_sample


class TorchBackend:
    def __init__(self, core):
        from omni_backbone import OmniPrefix, OmniTarget
        self.A, self.B = OmniPrefix(core).eval(), OmniTarget(core).eval()

    @torch.no_grad()
    def prefix(self, x):                                   # x [L, 1024] → hidden [L, 1024], kv [56, 8, L, 128]
        xv = torch.cat([x, torch.ones(x.shape[0], 1)], -1)[None]
        h, kv = self.A(xv)
        return h[0], kv

    @torch.no_grad()
    def target(self, xc, xu, kv, P):                       # xc / xu [T, 1024], kv [56, 8, P, 128] → [2, T, 1024]
        T = xc.shape[0]
        xt = torch.cat([torch.stack([xc, xu]), torch.ones(2, T, 1)], -1)
        meta = torch.zeros(2, P + 1); meta[0, :P] = 1; meta[0, P] = P
        return self.B(xt, kv, meta)


class CppCodecDecoder:
    """Token → waveform with omnivoice.cpp's C++ codec (same HiggsAudio-v2 / DAC weights, corr 0.9999 vs PyTorch).
    Off by default: it reloads the 734 MB GGUF per call, so 4 s of audio takes ~12 s vs ~3 s in PyTorch here.
    Encoding (reference prompts) stays on the official tokenizer."""
    RVQ_BITS = 11

    def __init__(self, tokenizer, exe=None, model=None):
        import os
        self.tok, self.device = tokenizer, tokenizer.device
        root = os.path.expanduser(os.environ.get('GF_OMNICPP_DIR', '~/.cache/terse-gf-ext/omnivoice.cpp'))
        self.exe = exe or os.environ.get('GF_OMNI_CODEC_BIN') or os.path.join(root, 'build/omnivoice-codec')
        self.model = model or os.environ.get('GF_OMNI_CODEC_MODEL') or os.path.join(root, 'models/omnivoice-tokenizer-F32.gguf')

    def __getattr__(self, k):
        return getattr(self.tok, k)

    def decode(self, codes):                                 # codes [1, K, T] → .audio_values [1, 1, N]
        import os, subprocess, tempfile, numpy as np, soundfile as sf
        c = codes[0].cpu().numpy().astype(np.int64)          # [K, T] row-major, LSB-first 11-bit pack (rvq-file.h)
        flat = c.reshape(-1); bits = np.zeros(flat.size * self.RVQ_BITS, np.uint8)
        for b in range(self.RVQ_BITS): bits[b::self.RVQ_BITS] = (flat >> b) & 1
        packed = np.packbits(bits, bitorder='little')
        d = tempfile.mkdtemp(prefix='omni-dec-'); path = os.path.join(d, 'codes.rvq')
        packed.tofile(path)
        subprocess.run([self.exe, '--model', self.model, '-i', path, '--format', 'wav32', '--device', 'CPU'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wav, _ = sf.read(os.path.join(d, 'codes.wav'), dtype='float32')
        for f in os.listdir(d): os.remove(os.path.join(d, f))
        os.rmdir(d)
        return types.SimpleNamespace(audio_values=torch.from_numpy(wav)[None, None])


def install(model, backend, refresh=4, cpp_codec=False):
    """Swap the model's `_generate_iterative` for the cached-prefix loop (batch size 1)."""
    if cpp_codec and not isinstance(model.audio_tokenizer, CppCodecDecoder):
        model.audio_tokenizer = CppCodecDecoder(model.audio_tokenizer)
    def _generate_iterative(self, task, gen_config):
        outs = []
        for i in range(task.batch_size):
            outs.append(_one(self, backend, refresh, task, i, gen_config))
        return outs
    model._generate_iterative = types.MethodType(_generate_iterative, model)
    model._fast_backend = backend
    return model


@torch.no_grad()
def _one(m, backend, refresh, task, i, cfg):
    inp = m._prepare_inference_inputs(task.texts[i], task.target_lens[i], task.ref_texts[i], task.ref_audio_tokens[i],
                                      task.langs[i], task.instructs[i], cfg.denoise)
    ids, amask = inp["input_ids"].clone(), inp["audio_mask"]                       # [1, C, c_len], [1, c_len]
    c_len, t_len = ids.shape[2], task.target_lens[i]; P = c_len - t_len
    C, MASK = m.config.num_audio_codebook, m.config.audio_mask_id
    V = m.config.audio_vocab_size
    tokens = torch.full((1, C, t_len), MASK, dtype=torch.long)
    tmask = torch.ones(1, t_len, dtype=torch.bool)

    timesteps = _get_time_steps(t_start=0.0, t_end=1.0, num_step=cfg.num_step, t_shift=cfg.t_shift).tolist()
    total, rem, sched = t_len * C, t_len * C, []
    for step in range(cfg.num_step):
        n = rem if step == cfg.num_step - 1 else min(math.ceil(total * (timesteps[step + 1] - timesteps[step])), rem)
        sched.append(int(n)); rem -= int(n)
    layer_ids = torch.arange(C).view(1, -1, 1)
    W = m.audio_heads.weight                                                         # [C·V, 1024]
    kv = None
    for step in range(cfg.num_step):
        k = sched[step]
        if k <= 0: continue
        ids[..., P:] = tokens
        if kv is None or step % refresh == 0:
            xc_full = m._prepare_embed_inputs(ids, amask)[0]                         # [c_len, 1024]
            if getattr(backend, 'resident_kv', False):
                _, kv = backend.prefix(xc_full, P)                                   # cache stays in the runner
            else:
                _, kv_full = backend.prefix(xc_full)
                kv = kv_full[:, :, :P]
            xc = xc_full[P:]
        else:
            xc = m._prepare_embed_inputs(ids[..., P:], amask[:, P:])[0]
        xu = m._prepare_embed_inputs(tokens, tmask)[0]
        h = backend.target(xc, xu, kv, P)                                            # [2, T, 1024]
        logits = (h.float() @ W.T).view(2, t_len, C, V).permute(0, 2, 1, 3)          # [2, C, T, V]
        pred, scores = m._predict_tokens_with_scoring(logits[0:1], logits[1:2], cfg)
        scores = scores - (layer_ids * cfg.layer_penalty_factor)
        if cfg.position_temperature > 0.0:
            scores = _gumbel_sample(scores, cfg.position_temperature)
        scores.masked_fill_(tokens != MASK, -float("inf"))
        _, idx = torch.topk(scores.flatten(), k)
        flat = tokens.flatten(); flat[idx] = pred.flatten()[idx]
        tokens = flat.view_as(tokens)
    return tokens[0]
