"""OmniVoice's transformer (Qwen3-0.6B layout, bidirectional) as a plain PyTorch module that traces cleanly for Core ML.
Same math as transformers' Qwen3Model with an explicit additive attention bias: RMSNorm (eps 1e-6), q/k per-head RMSNorm,
RoPE θ = 1e6 (rotate-half), GQA 16 q / 8 kv heads × 128, SwiGLU 3072, final norm. Input = inputs_embeds (the caller
does the text / audio-codebook embedding lookup), output = last hidden state (the caller applies audio_heads)."""
import math
import torch
import torch.nn as nn
import torch.nn.functional as F

H, NH, NKV, HD, FF, NL, EPS, THETA = 1024, 16, 8, 128, 3072, 28, 1e-6, 1_000_000.0


class RMSNorm(nn.Module):
    def __init__(self, d):
        super().__init__(); self.weight = nn.Parameter(torch.ones(d))

    def forward(self, x):
        x32 = x.float()
        return (x32 * torch.rsqrt(x32.pow(2).mean(-1, keepdim=True) + EPS)).to(x.dtype) * self.weight


def rotate_half(x):
    a, b = x.chunk(2, dim=-1)
    return torch.cat([-b, a], dim=-1)


class Layer(nn.Module):
    def __init__(self):
        super().__init__()
        self.input_layernorm, self.post_attention_layernorm = RMSNorm(H), RMSNorm(H)
        self.q_proj = nn.Linear(H, NH * HD, bias=False); self.k_proj = nn.Linear(H, NKV * HD, bias=False)
        self.v_proj = nn.Linear(H, NKV * HD, bias=False); self.o_proj = nn.Linear(NH * HD, H, bias=False)
        self.q_norm, self.k_norm = RMSNorm(HD), RMSNorm(HD)
        self.gate_proj = nn.Linear(H, FF, bias=False); self.up_proj = nn.Linear(H, FF, bias=False); self.down_proj = nn.Linear(FF, H, bias=False)

    def forward(self, x, cos, sin, bias):
        return self.forward_kv(x, cos, sin, bias)[0]

    def forward_kv(self, x, cos, sin, bias, kp=None, vp=None):
        """→ (x_out, k, v) with this block's own rotated keys / values [B, NKV, S, HD]. kp / vp: cached keys / values
        of earlier positions (prefix) prepended to the attention — bias then covers [S, P + S]."""
        h = self.input_layernorm(x)                       # no shape-derived sizes: Core ML trips on them at batch 1
        q = self.q_norm(self.q_proj(h).unflatten(-1, (NH, HD))).transpose(1, 2)
        k = self.k_norm(self.k_proj(h).unflatten(-1, (NKV, HD))).transpose(1, 2)
        v = self.v_proj(h).unflatten(-1, (NKV, HD)).transpose(1, 2)
        q = q * cos + rotate_half(q) * sin
        k = k * cos + rotate_half(k) * sin
        ka, va = (k, v) if kp is None else (torch.cat([kp, k], 2), torch.cat([vp, v], 2))
        ka = ka.repeat_interleave(NH // NKV, dim=1); va = va.repeat_interleave(NH // NKV, dim=1)
        att = torch.softmax((q @ ka.transpose(-1, -2)) * (1.0 / math.sqrt(HD)) + bias, dim=-1)
        o = (att @ va).transpose(1, 2).flatten(-2)
        x = x + self.o_proj(o)
        h = self.post_attention_layernorm(x)
        return x + self.down_proj(F.silu(self.gate_proj(h)) * self.up_proj(h)), k, v


class OmniBackbone(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = nn.ModuleList([Layer() for _ in range(NL)]); self.norm = RMSNorm(H)
        inv = 1.0 / (THETA ** (torch.arange(0, HD, 2, dtype=torch.float32) / HD))
        self.register_buffer('inv_freq', inv, persistent=False)

    def forward(self, inputs_embeds, attn_bias):
        """inputs_embeds [B, S, 1024]; attn_bias [B, 1, S, S] additive (0 = attend, -1e4 = blocked) → hidden [B, S, 1024]."""
        S = inputs_embeds.shape[1]
        pos = torch.arange(S, dtype=torch.float32, device=inputs_embeds.device)
        fr = pos[:, None] * self.inv_freq[None, :]
        emb = torch.cat([fr, fr], dim=-1)
        cos, sin = emb.cos()[None, None].to(inputs_embeds.dtype), emb.sin()[None, None].to(inputs_embeds.dtype)
        x = inputs_embeds
        for l in self.layers: x = l(x, cos, sin, attn_bias)
        return self.norm(x)

    @classmethod
    def from_safetensors(cls, path):
        from safetensors import safe_open
        m = cls(); sd = {}
        with safe_open(path, 'pt') as f:
            for k in f.keys():
                if not k.startswith('llm.') or k == 'llm.embed_tokens.weight': continue
                n = k[4:].replace('self_attn.', '').replace('mlp.', '')
                sd[n] = f.get_tensor(k)
        missing, unexpected = m.load_state_dict(sd, strict=False)
        assert not unexpected and all(x == 'inv_freq' for x in missing), (missing, unexpected)
        return m


class OmniBackboneLens(nn.Module):
    """Core ML entry point. Core ML allows ONE input with enumerated shapes and no mix with range shapes, so the
    attention mask rides in the input: xv[..., :1024] = inputs_embeds, xv[..., 1024] = 1 for real tokens / 0 for padding.
    Real tokens attend among themselves, padded positions only to themselves (OmniVoice's cond / uncond masks)."""
    def __init__(self, core):
        super().__init__(); self.core = core

    def forward(self, xv):
        x, valid = xv[..., :H], xv[..., H]                                      # [B, S, 1024], [B, S]
        S = x.shape[1]
        pos = torch.arange(S, dtype=torch.float32, device=x.device)
        eye = (pos[:, None] == pos[None, :]).float()[None]                      # [1, S, S]
        allowed = torch.clamp(valid[:, :, None] * valid[:, None, :] + eye, 0, 1)
        return self.core(x, ((allowed - 1.0) * 1e4)[:, None])


def rope(inv_freq, pos, dtype):
    """pos [B, S] → cos, sin [B, 1, S, HD]."""
    fr = pos[..., None] * inv_freq
    emb = torch.cat([fr, fr], dim=-1)
    return emb.cos()[:, None].to(dtype), emb.sin()[:, None].to(dtype)


class OmniPrefix(nn.Module):
    """Fast mode, model A (full pass, batch 1): xv [1, S, 1025] (embeds + validity) → hidden [1, S, 1024] and every
    layer's rotated keys / values KV [2·28, 8, S, 128] (k0, v0, k1, v1, …) — the cache model B reuses."""
    def __init__(self, core):
        super().__init__(); self.core = core

    def forward(self, xv):
        x, valid = xv[..., :H], xv[..., H]
        S = x.shape[1]
        pos = torch.arange(S, dtype=torch.float32, device=x.device)
        cos, sin = rope(self.core.inv_freq, pos[None], x.dtype)
        eye = (pos[:, None] == pos[None, :]).float()[None]
        bias = ((torch.clamp(valid[:, :, None] * valid[:, None, :] + eye, 0, 1) - 1.0) * 1e4)[:, None]
        kv = []
        for l in self.core.layers:
            x, k, v = l.forward_kv(x, cos, sin, bias)
            kv += [k, v]                                   # [1, NKV, S, HD] each (batch 1)
        return self.core.norm(x), torch.cat(kv, 0)


class OmniTarget(nn.Module):
    """Fast mode, model B (per step, batch 2 = [cond, uncond]): only the target tokens are recomputed.
    xt [2, T, 1025] target embeds + validity; kv [2·28, 8, P, 128] cached prefix (from model A);
    meta [2, P + 1]: meta[b, :P] = which cached prefix keys row b may see (cond: the real prefix, uncond: none),
    meta[b, P] = position of the row's first target token (cond: prefix length, uncond: 0)."""
    def __init__(self, core, P=None, T=None, B=2):
        super().__init__(); self.core = core; self.P, self.T, self.B = P, T, B   # fixed sizes for Core ML (no shape ops)

    def forward(self, xt, kv, meta):
        x, tvalid = xt[..., :H], xt[..., H]
        B = self.B
        T = self.T if self.T is not None else x.shape[1]
        P = self.P if self.P is not None else kv.shape[2]
        pvalid, off = meta[:, :P], meta[:, P:P + 1]
        pos = off + torch.arange(T, dtype=torch.float32, device=x.device)[None]
        cos, sin = rope(self.core.inv_freq, pos, x.dtype)
        tpos = torch.arange(T, dtype=torch.float32, device=x.device)
        eye = (tpos[:, None] == tpos[None, :]).float()[None]
        b_pre = tvalid[:, :, None] * pvalid[:, None, :]                                   # [B, T, P]
        b_tgt = torch.clamp(tvalid[:, :, None] * tvalid[:, None, :] + eye, 0, 1)          # [B, T, T]
        bias = ((torch.cat([b_pre, b_tgt], 2) - 1.0) * 1e4)[:, None]
        for i, l in enumerate(self.core.layers):
            kp = kv[2 * i:2 * i + 1].expand(B, -1, -1, -1); vp = kv[2 * i + 1:2 * i + 2].expand(B, -1, -1, -1)
            x = l.forward_kv(x, cos, sin, bias, kp, vp)[0]
        return self.core.norm(x)
