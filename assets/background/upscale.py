"""Real-ESRGAN x4 inference — self-contained RRDBNet, no basicsr dependency.

Tiled so a 1671x941 source fits in RAM at x4 (6684x3764).
"""
import sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


class ResidualDenseBlock(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
        self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
        self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
        self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
        self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, nf, gc=32):
        super().__init__()
        self.rdb1, self.rdb2, self.rdb3 = (ResidualDenseBlock(nf, gc) for _ in range(3))

    def forward(self, x):
        out = self.rdb3(self.rdb2(self.rdb1(x)))
        return out * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self, nf=64, nb=23, gc=32):
        super().__init__()
        self.conv_first = nn.Conv2d(3, nf, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_last = nn.Conv2d(nf, 3, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


def upscale(img, model, tile=224, overlap=24, scale=4):
    """Tiled inference with cosine-feathered blending — no visible seams."""
    a = np.asarray(img.convert("RGB"), np.float32) / 255.0
    H, W, _ = a.shape
    out = np.zeros((H * scale, W * scale, 3), np.float32)
    acc = np.zeros((H * scale, W * scale, 1), np.float32)
    step = tile - overlap
    ys = list(range(0, max(H - overlap, 1), step))
    xs = list(range(0, max(W - overlap, 1), step))
    total, done, t0 = len(ys) * len(xs), 0, time.time()

    for y in ys:
        for x in xs:
            y1, x1 = min(y + tile, H), min(x + tile, W)
            y0, x0 = max(0, y1 - tile), max(0, x1 - tile)
            patch = a[y0:y1, x0:x1]
            t = torch.from_numpy(patch).permute(2, 0, 1).unsqueeze(0)
            with torch.inference_mode():
                sr = model(t)[0].permute(1, 2, 0).numpy()
            ph, pw = sr.shape[:2]

            # feather edges so overlapping tiles cross-fade
            wy = np.ones(ph, np.float32)
            wx = np.ones(pw, np.float32)
            f = overlap * scale
            ramp = (1 - np.cos(np.linspace(0, np.pi, f))) / 2
            if y0 > 0:
                wy[:f] = ramp
            if y1 < H:
                wy[-f:] = ramp[::-1]
            if x0 > 0:
                wx[:f] = ramp
            if x1 < W:
                wx[-f:] = ramp[::-1]
            wgt = (wy[:, None] * wx[None, :])[:, :, None]

            oy, ox = y0 * scale, x0 * scale
            out[oy:oy + ph, ox:ox + pw] += sr * wgt
            acc[oy:oy + ph, ox:ox + pw] += wgt

            done += 1
            if done % 5 == 0 or done == total:
                el = time.time() - t0
                print(f"  tile {done}/{total}  {el:.0f}s  eta {el/done*(total-done):.0f}s",
                      flush=True)

    return Image.fromarray((np.clip(out / np.maximum(acc, 1e-6), 0, 1) * 255).astype(np.uint8))


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    target_w = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    model = RRDBNet()
    sd = torch.load("RealESRGAN_x4plus.pth", map_location="cpu")
    model.load_state_dict(sd.get("params_ema", sd.get("params", sd)), strict=True)
    model.eval()
    torch.set_num_threads(4)

    im = Image.open(src)
    print(f"來源 {im.size} -> x4", flush=True)
    big = upscale(im, model)
    print(f"超解析完成 {big.size}", flush=True)

    if target_w and big.size[0] != target_w:
        h = round(big.size[1] * target_w / big.size[0])
        big = big.resize((target_w, h), Image.LANCZOS)
        print(f"縮至 {big.size}", flush=True)

    big.save(dst)
    print(f"已存 {dst}", flush=True)
