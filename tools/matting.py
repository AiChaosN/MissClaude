"""Chroma-key matting and patch helpers shared by the asset pipeline.

All images are float32 RGB(A) arrays in 0..255, shape (H, W, C).
"""
from pathlib import Path

import cv2
import numpy as np


def read_rgb(path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(path)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32)


def read_rgba(path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(path)
    return cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA).astype(np.float32)


def write_rgba(path, rgba: np.ndarray) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    out = np.clip(np.rint(rgba), 0, 255).astype(np.uint8)
    cv2.imwrite(str(path), cv2.cvtColor(out, cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 9])


def estimate_key(img: np.ndarray, border: int = 6) -> np.ndarray:
    edge = np.concatenate([
        img[:border].reshape(-1, 3), img[-border:].reshape(-1, 3),
        img[:, :border].reshape(-1, 3), img[:, -border:].reshape(-1, 3),
    ])
    return np.median(edge, axis=0)


def key_alpha(img: np.ndarray, key: np.ndarray, lo: float = 0.10, hi: float = 0.80) -> np.ndarray:
    """Alpha from green dominance: G - max(R, B), normalised by the key's own dominance.

    The character palette has no green, so any green dominance is background
    showing through. lo/hi set the soft-matte ramp on the normalised dominance.
    """
    dom = img[..., 1] - np.maximum(img[..., 0], img[..., 2])
    key_dom = key[1] - max(key[0], key[2])
    t = np.clip(dom / key_dom, 0.0, 1.0)
    a = 1.0 - np.clip((t - lo) / (hi - lo), 0.0, 1.0)
    # drop isolated specks of near-zero alpha noise
    a[a < 0.02] = 0.0
    return a


def unmix(img: np.ndarray, alpha: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Recover foreground colour from I = a*F + (1-a)*bg."""
    a = alpha[..., None]
    fg = (img - (1.0 - a) * bg) / np.maximum(a, 1e-3)
    return np.clip(fg, 0, 255)


def despill(rgb: np.ndarray) -> np.ndarray:
    """Clamp green to the larger of red/blue so no green cast survives at edges."""
    out = rgb.copy()
    out[..., 1] = np.minimum(out[..., 1], np.maximum(out[..., 0], out[..., 2]))
    return out


def local_fg(rgb: np.ndarray, core: np.ndarray, sigmas=(1.5, 3.0, 6.0, 12.0)) -> np.ndarray:
    """Estimate the foreground colour near edges from nearby fully-opaque pixels.

    Normalised convolution at increasing radii; each pixel takes the smallest
    radius that has enough opaque support.
    """
    core = core.astype(np.float32)
    out = np.zeros_like(rgb)
    done = np.zeros(core.shape, bool)
    for s in sigmas:
        w = cv2.GaussianBlur(core, (0, 0), s)
        c = cv2.GaussianBlur(rgb * core[..., None], (0, 0), s)
        ok = (w > 0.05) & ~done
        out[ok] = c[ok] / w[ok, None]
        done |= ok
    out[~done] = rgb[~done]
    return out


def _hue_sat(img: np.ndarray):
    hsv = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_RGB2HSV)
    return hsv[..., 0].astype(np.float32) * 2.0, hsv[..., 1].astype(np.float32) / 255.0


def green_cast(img: np.ndarray) -> np.ndarray:
    """Pixels whose hue is yellow-green..cyan: absent from the character palette
    (orange, cream, brown, gold, black), so they can only be key colour mixed into an edge."""
    hue, sat = _hue_sat(img)
    return (hue >= 50) & (hue <= 170) & (sat > 0.25)


def strong_key(img: np.ndarray) -> np.ndarray:
    """Clearly green pixels at any brightness. The renders shade the key colour inside
    tight gaps between hair strands, where green dominance alone reads as foreground."""
    hue, sat = _hue_sat(img)
    return (hue >= 65) & (hue <= 165) & (sat > 0.45) & (img[..., 1] > img[..., 0] + 8)


def refine_alpha(img: np.ndarray, alpha: np.ndarray):
    """Re-solve edge alpha by projecting each pixel onto the line local bg -> local fg.

    A plain green-dominance key overestimates alpha where the foreground is itself
    strongly non-green (orange hair), which leaves an olive fringe after despill.
    Returns (alpha, local background colour) so the caller can unmix against it.
    """
    alpha = np.where(strong_key(img), 0.0, alpha)
    bgm = alpha <= 0.0
    near_bg = cv2.dilate((alpha < 0.5).astype(np.uint8),
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    band = ((alpha > 0.0) & (alpha < 0.97)) | (green_cast(img) & near_bg & (alpha > 0.0))
    core = (alpha >= 0.97) & ~band
    fg = local_fg(img, core)
    bg = local_fg(img, bgm)
    d = fg - bg
    a = ((img - bg) * d).sum(axis=2) / np.maximum((d * d).sum(axis=2), 1.0)
    a = np.clip(a, 0.0, 1.0)
    out = alpha.copy()
    out[band] = a[band]
    out[out < 0.03] = 0.0
    return out, bg


def keyed_rgba(img: np.ndarray, key=None) -> np.ndarray:
    """Cut a character out of a chroma-green render."""
    key = estimate_key(img) if key is None else key
    a = keep_main_components(key_alpha(img, key))
    a, bg = refine_alpha(img, a)
    fg = despill(unmix(img, a, bg))
    return np.dstack([fg, a * 255.0])


def tri_alpha(on_white: np.ndarray, on_key: np.ndarray, key: np.ndarray,
              key_a: np.ndarray) -> np.ndarray:
    """Triangulation matting from the same foreground over white and over the key colour.

    I_w - I_k = (1 - a) (W - K), independent of the foreground colour. key_a (plain
    key alpha of on_key) decides pure background and solid interior, where the
    small re-render noise between the two images would otherwise leak in.
    """
    wk = np.array([255.0, 255.0, 255.0]) - key
    one_minus = ((on_white - on_key) * wk).sum(axis=2) / float((wk * wk).sum())
    a = np.clip(1.0 - one_minus, 0.0, 1.0)
    a[key_a <= 0.0] = 0.0
    interior = cv2.erode((key_a > 0.97).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    a[interior] = 1.0
    a[a < 0.03] = 0.0
    return a


def keep_main_components(alpha: np.ndarray, min_frac: float = 0.002) -> np.ndarray:
    """Zero out small disconnected blobs (stray key noise, leftover decorations)."""
    solid = (alpha > 0.05).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    if n <= 1:
        return alpha
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep_ids = 1 + np.where(areas >= max(areas.max() * min_frac, 30))[0]
    keep = np.isin(lab, keep_ids)
    # let soft edge pixels next to kept blobs survive
    keep = cv2.dilate(keep.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    return np.where(keep, alpha, 0.0)


def soft_region(mask: np.ndarray, grow: int, feather: float) -> np.ndarray:
    """Binary mask -> grown mask with a smooth linear falloff of `feather` px outside it."""
    m = mask.astype(np.uint8)
    if grow > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1))
        m = cv2.dilate(m, k)
    dist = cv2.distanceTransform(1 - m, cv2.DIST_L2, 5)
    w = np.clip(1.0 - dist / max(feather, 1e-3), 0.0, 1.0)
    return w * w * (3 - 2 * w)  # smoothstep


def change_mask(a: np.ndarray, b: np.ndarray, thr: float, box=None, min_area: int = 60,
                blur: float = 1.5) -> np.ndarray:
    """Binary mask of where two aligned renders differ noticeably."""
    d = np.abs(a[..., :3] - b[..., :3]).max(axis=2)
    d = cv2.GaussianBlur(d, (0, 0), blur)
    m = (d > thr).astype(np.uint8)
    if box is not None:
        x0, y0, x1, y1 = box
        clip = np.zeros_like(m)
        clip[y0:y1, x0:x1] = 1
        m &= clip
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = np.zeros_like(m)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            keep[lab == i] = 1
    return keep


def premul_lerp(base: np.ndarray, over: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Replace `base` by `over` with weight w (both straight RGBA), blending premultiplied."""
    w = w[..., None]
    ab, ao = base[..., 3:4] / 255.0, over[..., 3:4] / 255.0
    a = ab * (1 - w) + ao * w
    rgb = (base[..., :3] * ab * (1 - w) + over[..., :3] * ao * w) / np.maximum(a, 1e-4)
    return np.dstack([np.clip(rgb, 0, 255), a[..., 0] * 255.0])


def bbox(alpha: np.ndarray, thr: float = 1.0):
    ys, xs = np.where(alpha > thr)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
