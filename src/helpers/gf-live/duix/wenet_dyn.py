import torch
class EncDyn(torch.nn.Module):
    """WeNet ConformerEncoder forward with masks built from the input's own shape (exportable with a dynamic length)."""
    def __init__(s, enc):
        super().__init__(); s.e = enc
    def forward(s, xs):
        mask = torch.ones_like(xs[:, :, :1]).transpose(1, 2).bool()          # [B,1,T], all frames valid
        x, pos_emb, mask = s.e.embed(xs, mask)
        mask_pad = mask
        for layer in s.e.encoders:
            x, mask, _ = layer(x, mask, pos_emb, mask_pad)
        return s.e.after_norm(x)
