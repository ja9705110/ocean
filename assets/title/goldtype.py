"""Render CJK glyphs with the poster's gold-bevel material.

The material model is measured from the original 向 in the poster:
  - depth ramp: thin dark outline -> bright bevel rim -> stable gold face
  - directional light from upper-left, modulating the bevel band only
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage as ndi

FONT = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc"
FONT_INDEX = 1  # TC

# measured from the original glyph: (normalised depth, RGB)
RAMP = [
    (0.00, (201, 163, 106)),
    (0.07, (234, 195, 130)),
    (0.20, (229, 182, 112)),
    (0.31, (227, 177, 106)),
    (0.49, (226, 174, 103)),
    (0.71, (225, 173, 102)),
    (1.00, (217, 164,  94)),
]
LIGHT_DEG = -112.5   # upper-left
LIGHT_AMP = 0.105    # +-10.5% around the mean


def glyph_mask(ch, size, canvas, offset=(0, 0), ss=2):
    """Anti-aliased glyph coverage in [0,1], rendered supersampled."""
    W, H = canvas
    f = ImageFont.truetype(FONT, size * ss, index=FONT_INDEX)
    im = Image.new("L", (W * ss, H * ss), 0)
    ImageDraw.Draw(im).text(((W // 2 + offset[0]) * ss, (H // 2 + offset[1]) * ss),
                            ch, font=f, fill=255, anchor="mm")
    return np.asarray(im.resize((W, H), Image.LANCZOS)).astype(np.float32) / 255.0


def glyph_fitted(ch, bbox, canvas, ss=2, pad=0.0):
    """Render `ch` so its inked bounding box lands exactly on `bbox`.

    bbox is (x0, y0, x1, y1) in canvas coordinates. Solving for the point size
    directly is unreliable across glyphs, so render once and rescale to fit.
    """
    W, H = canvas
    x0, y0, x1, y1 = bbox
    tw, th = (x1 - x0) * (1 + pad), (y1 - y0) * (1 + pad)

    probe = 400
    f = ImageFont.truetype(FONT, probe * ss, index=FONT_INDEX)
    im = Image.new("L", (probe * 3 * ss, probe * 3 * ss), 0)
    ImageDraw.Draw(im).text((probe * ss * 1.5, probe * ss * 1.5), ch,
                            font=f, fill=255, anchor="mm")
    a = np.asarray(im)
    ys, xs = np.nonzero(a > 100)
    gw, gh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1

    scale = min(tw / gw, th / gh)
    nw, nh = max(int(gw * scale), 1), max(int(gh * scale), 1)
    cut = Image.fromarray(a[ys.min():ys.max() + 1, xs.min():xs.max() + 1])
    cut = cut.resize((nw, nh), Image.LANCZOS)

    out = Image.new("L", (W, H), 0)
    out.paste(cut, (int(x0 + (tw - nw) / 2), int(y0 + (th - nh) / 2)))
    return np.asarray(out).astype(np.float32) / 255.0


def ramp_lookup(t):
    ts = np.array([p[0] for p in RAMP])
    cs = np.array([p[1] for p in RAMP], np.float32)
    out = np.empty(t.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, ts, cs[:, c])
    return out


def veins(shape, seed, scale=90.0, strength=0.10):
    """Faint crack/vein filaments, as in the original artwork."""
    rng = np.random.default_rng(seed)
    n = rng.normal(0, 1, shape).astype(np.float32)
    n = ndi.gaussian_filter(n, scale / 24.0)
    n = np.abs(n)
    n = 1.0 - n / (n.max() + 1e-6)
    n = ndi.gaussian_filter(n ** 6, 0.8)
    return 1.0 - strength * (n / (n.max() + 1e-6))


# the material reads as a chiselled roof: each stroke rises from both contours
# to a ridge along its medial axis, so one flank catches the light and the
# opposite flank falls into shadow. Measured targets: luminance P1..P99 ~130..235.
GOLD_MID = np.array([234.0, 184.0, 111.0], np.float32)
GOLD_LIT = np.array([255.0, 226.0, 165.0], np.float32)
GOLD_DIM = np.array([171.0, 123.0,  63.0], np.float32)

BEVEL_FRAC = 0.34   # bevel occupies this share of a stroke's half-width


def gold(mask, seed=3, vein_strength=0.055, relief=1.0, spec=0.42):
    """Turn a coverage mask into the gold-bevel material (RGB float, plus alpha)."""
    solid = mask > 0.5
    if solid.sum() == 0:
        return np.zeros(mask.shape + (3,), np.float32), mask

    d = ndi.distance_transform_edt(solid).astype(np.float32)
    dmax = max(float(d.max()), 1.0)

    # flat-topped chisel: the face is level, only the rim within BEVEL_FRAC slopes.
    # the bevel follows each stroke's own half-width, so hairlines do not turn
    # into one continuous slope the way a single global width would make them.
    ridge = ndi.grey_dilation(d, size=int(max(dmax * 0.5, 3)) | 1)
    local = ndi.gaussian_filter(np.maximum(ridge, 1.0), max(dmax * 0.25, 1.5))
    bev = np.maximum(local * BEVEL_FRAC, 2.0)
    u = np.clip(d / bev, 0, 1)
    h = ndi.gaussian_filter(u * u * (3.0 - 2.0 * u), max(float(bev.mean()) * 0.16, 0.8))
    hy, hx = np.gradient(h * bev * 1.15 * relief)

    nz = 1.0
    nrm = np.sqrt(hx * hx + hy * hy + nz * nz)
    lx, ly = np.cos(np.radians(LIGHT_DEG)), np.sin(np.radians(LIGHT_DEG))
    lz = 0.78
    ln = np.sqrt(lx * lx + ly * ly + lz * lz)
    ndl = (-hx * lx + -hy * ly + nz * lz) / (nrm * ln)

    # split the lambert term about its mid point so both flanks move
    s = np.clip((ndl - 0.615) / 0.235, -1.0, 1.0)
    rgb = np.where(s[..., None] >= 0,
                   GOLD_MID + (GOLD_LIT - GOLD_MID) * s[..., None],
                   GOLD_MID + (GOLD_MID - GOLD_DIM) * s[..., None])

    # narrow specular glint along the ridge flank facing the light
    if spec > 0:
        g = np.clip((ndl - 0.80) / 0.16, 0, 1) ** 2
        rgb = rgb + spec * 120.0 * g[..., None] * np.array([1.0, 0.95, 0.82], np.float32)

    # gentle global falloff: the artwork darkens toward the foot of the glyph
    yy = np.linspace(0, 1, mask.shape[0], dtype=np.float32)[:, None, None]
    rgb *= (1.04 - 0.14 * yy)

    rgb *= veins(mask.shape, seed, strength=vein_strength)[..., None]

    # crisp dark lip right at the contour
    lip = np.clip(1.0 - d / 2.4, 0, 1)[..., None]
    rgb = rgb * (1.0 - 0.42 * lip)

    return np.clip(rgb, 0, 255), mask


def composite(bg, layers, glow=0.55):
    """Alpha-composite gold layers over bg, with a warm outer glow."""
    out = bg.astype(np.float32).copy()
    total_a = np.zeros(bg.shape[:2], np.float32)
    total_c = np.zeros(bg.shape[:2] + (3,), np.float32)
    for rgb, a in layers:
        total_c += rgb * a[..., None]
        total_a = np.maximum(total_a, a)

    if glow > 0:
        src = Image.fromarray(np.clip(total_c, 0, 255).astype(np.uint8))
        acc = np.zeros_like(out)
        for r, w in ((6, 0.42), (18, 0.32), (52, 0.26)):
            acc += np.asarray(src.filter(ImageFilter.GaussianBlur(r))).astype(np.float32) * w
        out += acc * glow * 0.30

    a = total_a[..., None]
    out = out * (1 - a) + total_c * a
    return np.clip(out, 0, 255).astype(np.uint8)
