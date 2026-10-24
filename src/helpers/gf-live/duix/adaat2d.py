"""AdaAT without 5-D grid_sample (ONNX / Core ML have only 4-D): the 3-D sample's z axis is a FIXED blend of neighbouring
channels (z = linspace(-1,1,D) with align_corners=False lands between channel centres), and its xy part is a per-channel
2-D sample — so  z-blend (fixed D×D matrix) → grid_sample 4-D on [B*D,1,H,W]  is exactly the same trilinear result."""
import math, torch, torch.nn.functional as F


def zblend_matrix(D):
    z = torch.linspace(-1, 1, D)
    u = ((z + 1) * D - 1) / 2                      # unnormalised voxel coordinate (align_corners=False)
    k0 = torch.floor(u); w1 = u - k0; w0 = 1 - w1
    M = torch.zeros(D, D)
    for i in range(D):
        a, b = int(k0[i]), int(k0[i]) + 1
        if 0 <= a < D: M[i, a] += w0[i]
        if 0 <= b < D: M[i, b] += w1[i]              # zero padding outside
    return M


class AdaAT2D(torch.nn.Module):
    def __init__(self, ada):                           # ada = the original AdaAT (reuses its Linear layers)
        super().__init__()
        self.commn_linear, self.scale, self.rotation, self.translation = ada.commn_linear, ada.scale, ada.rotation, ada.translation
        self.register_buffer('M', torch.zeros(1))

    def forward(self, feature_map, para_code):
        b, d, h, w = feature_map.shape
        if self.M.numel() != d * d: self.M = zblend_matrix(d).to(feature_map)
        p = self.commn_linear(para_code)
        scale = self.scale(p).unsqueeze(-1) * 2                                  # [b,d,1]
        angle = self.rotation(p).unsqueeze(-1) * 3.14159                         # [b,d,1]
        trans = self.translation(p).view(b, d, 2)
        ys = torch.linspace(-1, 1, h, device=feature_map.device, dtype=feature_map.dtype)
        xs = torch.linspace(-1, 1, w, device=feature_map.device, dtype=feature_map.dtype)
        gy, gx = torch.meshgrid(ys, xs, indexing='ij')
        gx = gx.reshape(1, 1, h * w); gy = gy.reshape(1, 1, h * w)
        c, s = torch.cos(angle), torch.sin(angle)
        nx = (c * gx - s * gy) * scale + trans[..., :1]
        ny = (s * gx + c * gy) * scale + trans[..., 1:]
        grid = torch.stack([nx, ny], -1).view(b * d, h, w, 2)
        mixed = torch.einsum('ij,bjhw->bihw', self.M, feature_map).reshape(b * d, 1, h, w)
        out = F.grid_sample(mixed, grid, mode='bilinear', padding_mode='zeros', align_corners=False)
        return out.view(b, d, h, w)
