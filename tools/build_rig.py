#!/usr/bin/env python3
"""Cut the idle chibi into rig layers: art/work/rig/*.png + rig_src.json (source px).

Every input is an edit of art/source/chibi_ref.png that stays pixel-aligned with it,
so masks come from comparing images and hidden content comes from the edits:

  rm_arm_free / rm_arm_book  what lies behind each arm  -> body fill + arm masks
  rm_dangles                 behind ribbon tails/earring -> head/hair fill + dangle masks
  seg_hair                   all hair recoloured magenta -> hair mask
  armf_wave / armf_chin      free arm redrawn on rm_arm_free -> arm variant masks

Layer stack, back to front: hair_back, body, arm_down, head (+face), earring,
ribbon, arm_book, arm_wave, arm_chin. At rest the stack reproduces the original;
what a layer hides is filled in so that moving parts never open holes.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from matting import change_mask, keyed_rgba, read_rgb, read_rgba, write_rgba  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC, GEN, WORK = ROOT / "art/source", ROOT / "art/gen", ROOT / "art/work"

# ---- hand-placed geometry (source px), measured on the reference image ----

# head: crown, face, ears, bow and flower; bottom edge follows the jaw line
HEAD_POLY = [(300, 230), (330, 120), (420, 40), (560, 5), (720, 20), (880, 20), (1010, 120),
             (1015, 340), (870, 350), (860, 430), (840, 482), (800, 482), (760, 470), (720, 456),
             (697, 462), (680, 474), (650, 488), (620, 495), (590, 497), (560, 492), (523, 476),
             (490, 470), (450, 470), (400, 450), (330, 380)]
# the side lock that falls in front of her right shoulder (only its hair is taken)
LOCK_POLY = [(688, 440), (760, 440), (802, 470), (816, 560), (802, 705), (716, 708), (688, 600)]

BOXES = {
    "arm_down": (680, 490, 990, 860),
    "arm_book": (350, 440, 650, 760),
    "dangles": (760, 290, 1015, 545),
    "arm_wave": (740, 380, 940, 745),
    "arm_chin": (620, 420, 870, 745),
}
EARRING_MAX_X = 845  # dangles left of this are the earring, right of it the ribbon

# Extra arm variants. side "F": the free arm, drawn onto rm_arm_free; side "B": the book
# arm (with the book), drawn onto rm_arm_book. joints: shoulder/elbow -> wrist (source px);
# the first joint's bone is parented to the chest.
ARM_VARIANTS = {
    "up": {"side": "F", "box": (650, 40, 1000, 720),
           "joints": [[760, 640], [790, 420], [800, 245]]},
    "mouth": {"side": "F", "box": (580, 380, 900, 760),
              "joints": [[740, 620], [690, 560]]},
    "hip": {"side": "F", "box": (680, 420, 960, 800),
            "joints": [[770, 590], [855, 660], [735, 710]]},
    "point": {"side": "F", "box": (700, 380, 1120, 720),
              "joints": [[770, 560], [900, 530], [975, 495]]},
    "fist": {"side": "F", "box": (700, 430, 900, 760),
             "joints": [[790, 680], [800, 575]]},
    "scratch": {"side": "F", "box": (680, 300, 960, 760),
                "joints": [[800, 680], [790, 530], [760, 470]]},
    "bhip": {"side": "B", "box": (330, 430, 680, 900),
             "joints": [[520, 560], [420, 650], [480, 730]]},
    "bhug": {"side": "B", "box": (330, 430, 720, 820),
             "joints": [[500, 560], [520, 690], [640, 640]]},
    "bup": {"side": "B", "box": (330, 250, 760, 820),
            "joints": [[500, 580], [470, 700], [550, 610]]},
}
ARM_FILES = {"up": "armf_up", "mouth": "armf_mouth", "hip": "armf_hip", "point": "armf_point",
             "fist": "armf_fist", "scratch": "armf_scratch", "bhip": "book_hip", "bhug": "book_hug",
             "bup": "book_up"}

BONES = {
    "body": {"parent": None, "pivot": [650, 1110]},
    "chest": {"parent": "body", "pivot": [650, 715]},
    "head": {"parent": "chest", "pivot": [628, 500]},
    "armB": {"parent": "chest", "pivot": [585, 560]},
    "armF_down": {"parent": "chest", "pivot": [775, 565]},
    "foreF_down": {"parent": "armF_down", "pivot": [815, 690]},
    "handF_down": {"parent": "foreF_down", "pivot": [868, 765]},
    "armF_wave": {"parent": "chest", "pivot": [835, 705]},
    "foreF_wave": {"parent": "armF_wave", "pivot": [835, 705]},
    "handF_wave": {"parent": "foreF_wave", "pivot": [842, 562]},
    "armF_chin": {"parent": "chest", "pivot": [800, 700]},
    "foreF_chin": {"parent": "armF_chin", "pivot": [800, 700]},
    "handF_chin": {"parent": "foreF_chin", "pivot": [720, 570]},
    "hairL": {"parent": "chest", "pivot": [420, 470],
              "physics": {"k": 14, "c": 2.6, "gain": 0.6, "wind": 0.02, "windRate": 0.5, "max": 0.22, "seed": 1.3,
                          "ks": 40, "cs": 6, "gs": 0.25, "kick": 0.12}},
    "hairR": {"parent": "chest", "pivot": [845, 470],
              "physics": {"k": 15, "c": 2.6, "gain": 0.6, "wind": 0.02, "windRate": 0.55, "max": 0.22, "seed": 4.1,
                          "ks": 40, "cs": 6, "gs": 0.25, "kick": 0.12}},
    "skirt": {"parent": "body", "pivot": [650, 720],
              "physics": {"k": 26, "c": 4.5, "gain": 0.25, "wind": 0.008, "windRate": 0.4, "max": 0.07, "seed": 2.2, "kick": 0.2}},
    "ribbon": {"parent": "head", "pivot": [885, 335],
               "physics": {"k": 22, "c": 2.2, "gain": 1.2, "wind": 0.05, "windRate": 0.7, "max": 0.45, "seed": 0.7, "kick": 0.9,
                          "ks": 30, "cs": 5, "gs": 0.2}},
    "earring": {"parent": "head", "pivot": [811, 392],
                "physics": {"k": 45, "c": 2.5, "gain": 1.4, "wind": 0.06, "windRate": 0.9, "max": 0.6, "seed": 5.3, "kick": 1.0}},
    # bangs bounce a little off the crown
    "bangs": {"parent": "head", "pivot": [605, 175],
              "physics": {"k": 30, "c": 4.0, "gain": 0.8, "wind": 0.01, "windRate": 0.6, "max": 0.08, "seed": 6.1,
                          "kick": 0.45, "ks": 50, "cs": 7, "gs": 0.15}},
    # irises slide inside the eyes (translation only, set by gaze)
    "eyeL": {"parent": "head", "pivot": [531, 415]},
    "eyeR": {"parent": "head", "pivot": [709, 349]},
}
TASSEL_PHYSICS = {"k": 38, "c": 2.6, "gain": 1.3, "wind": 0.05, "windRate": 0.85, "max": 0.5, "kick": 1.0,
                  "ks": 40, "cs": 5, "gs": 0.2}
BANGS_BOX = (380, 120, 830, 480)
EYES_BOX = (440, 250, 792, 456)  # same as build_assets.py
TASSEL_BOX = (380, 670, 880, 980)

SKINS = {
    "hair_back": {"type": "hair", "headY": [380, 540], "swingY": [470, 950], "sideX": [60, 330], "cx": 630},
    "body": {"type": "body", "waistY": [680, 750], "hemY": [860, 1080]},
    "head": {"type": "head", "lockY": [500, 720], "lockLag": 0.65},
    "arm_down": {"type": "chain", "blend": 16, "joints": [["armF_down", [775, 565]], ["foreF_down", [815, 690]],
                                                          ["handF_down", [868, 765]]]},
    "arm_wave": {"type": "chain", "blend": 14, "joints": [["foreF_wave", [835, 705]], ["handF_wave", [842, 562]]]},
    "arm_chin": {"type": "chain", "blend": 14, "joints": [["foreF_chin", [800, 700]], ["handF_chin", [720, 570]]]},
    "arm_book": {"type": "rigid", "bone": "armB"},
    "ribbon": {"type": "rigid", "bone": "ribbon"},
    "earring": {"type": "rigid", "bone": "earring"},
    "bangs": {"type": "rigid", "bone": "bangs"},
    "iris_l": {"type": "rigid", "bone": "eyeL"},
    "iris_r": {"type": "rigid", "bone": "eyeR"},
}

# draw order; arm variants are shown one at a time
# (tassel layers are inserted after "body" at build time, one per tassel found)
LAYERS = [
    {"name": "hair_back", "skin": "hair_back"},
    {"name": "body", "skin": "body"},
    {"name": "arm_down", "skin": "arm_down", "variant": "down", "group": "armF"},
    {"name": "head", "skin": "head"},
    {"name": "iris_l", "skin": "iris_l", "type": "iris", "clip": "eye_open_l"},
    {"name": "iris_r", "skin": "iris_r", "type": "iris", "clip": "eye_open_r"},
    {"name": "bangs", "skin": "bangs"},
    {"name": "earring", "skin": "earring"},
    {"name": "ribbon", "skin": "ribbon"},
    {"name": "arm_book", "skin": "arm_book", "variant": "book", "group": "armB"},
    {"name": "arm_wave", "skin": "arm_wave", "variant": "wave", "group": "armF"},
    {"name": "arm_chin", "skin": "arm_chin", "variant": "chin", "group": "armF"},
]
FACE_AFTER = "iris_r"  # face patches go over the eyes but under the bangs


# ---------------- helpers ----------------

def poly_mask(shape, pts):
    m = np.zeros(shape, np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 1)
    return m


def fill_holes(m):
    """Fill regions of 0 that are not connected to the image border."""
    h, w = m.shape
    flood = m.copy().astype(np.uint8)
    ff = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(flood, ff, (0, 0), 1)
    return m | (1 - flood)


def region(a, b, box, keep_largest=True, close=9):
    """Where two aligned renders differ inside box: cleaned, closed, holes filled."""
    m = change_mask(a, b, thr=38, box=box, min_area=150, blur=1.2)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close, close))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
    if keep_largest:
        n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
        if n > 1:
            m = (lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    return fill_holes(m)


def largest(m):
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    if n <= 1:
        return m
    return (lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)


def top_pivot(m, rows=6):
    ys, xs = np.where(m > 0)
    top = ys.min()
    return [round(float(xs[ys < top + rows].mean()), 1), float(top + 2)]


def soften(m, sigma=0.8):
    return np.clip(cv2.GaussianBlur(m.astype(np.float32), (0, 0), sigma), 0, 1)


def background(img, tol=10):
    """White background of a white-backdrop render: flood fill from the borders."""
    h, w = img.shape[:2]
    work = np.clip(img, 0, 255).astype(np.uint8).copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        cv2.floodFill(work, ff, seed, 0, (tol,) * 3, (tol,) * 3, flags)
    return ff[1:-1, 1:-1] > 0


def telea(rgb, alpha, region_mask, radius=6):
    """Fill region_mask from the opaque surroundings (alpha > .5)."""
    known = alpha > 0.5
    todo = (region_mask & ~known).astype(np.uint8)
    if not todo.any():
        return rgb
    src = np.clip(rgb, 0, 255).astype(np.uint8)
    # unknown = everything not opaque, so transparent pixels never bleed in
    filled = cv2.inpaint(src, (~known).astype(np.uint8), radius, cv2.INPAINT_TELEA)
    out = rgb.copy()
    out[todo > 0] = filled[todo > 0]
    return out


def dilate(m, r):
    return cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))


# ---------------- build ----------------

def build_stand():
    out_dir = WORK / "rig"
    out_dir.mkdir(parents=True, exist_ok=True)
    O = read_rgba(WORK / "idle.png")
    o_rgb = read_rgb(SRC / "chibi_ref.png")
    e_free = read_rgb(GEN / "rm_arm_free.png")
    e_book = read_rgb(GEN / "rm_arm_book.png")
    e_dang = read_rgb(GEN / "rm_dangles.png")
    s_hair = read_rgb(GEN / "seg_hair.png")
    w_wave = read_rgb(GEN / "armf_wave.png")
    w_chin = read_rgb(GEN / "armf_chin.png")
    H, W = O.shape[:2]
    alpha = O[..., 3] / 255.0
    sil = alpha > 0.5

    # masks
    m_arm = region(e_free, o_rgb, BOXES["arm_down"])
    m_book = region(e_book, o_rgb, BOXES["arm_book"])
    m_dang = region(e_dang, o_rgb, BOXES["dangles"], keep_largest=False, close=5)
    xs = np.arange(W)[None, :]
    m_ear = largest(m_dang * (xs < EARRING_MAX_X))
    m_rib = m_dang * (xs >= EARRING_MAX_X)
    e_bangs = read_rgb(GEN / "rm_bangs.png")
    e_eyes = read_rgb(GEN / "eyes_blank.png")  # an edit of rm_bangs
    e_tas = read_rgb(GEN / "rm_tassels.png")
    m_wave = region(w_wave, e_free, BOXES["arm_wave"])
    extra_arms = {}
    for v, spec in ARM_VARIANTS.items():
        img = read_rgb(GEN / f"{ARM_FILES[v]}.png")
        ref = e_free if spec["side"] == "F" else e_book
        extra_arms[v] = (img, region(img, ref, spec["box"]))
    m_chin = region(w_chin, e_free, BOXES["arm_chin"])
    hair = np.clip(((s_hair[..., 0] + s_hair[..., 2]) / 2 - s_hair[..., 1] - 60) / 120, 0, 1) * alpha
    # the recolour leaves the hair's outer line art alone; dark pixels between hair and
    # the background are that outline and belong to the hair
    dark = o_rgb.max(axis=2) < 150
    outline = dark & (dilate(hair > 0.5, 3) > 0) & (dilate(alpha < 0.1, 4) > 0)
    hair = np.maximum(hair, outline * alpha)
    # thin line art between two strands is hair too: close small gaps inside the hair
    closed = cv2.morphologyEx((hair > 0.5).astype(np.uint8), cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    hair = np.maximum(hair, closed * dark * alpha)
    head_hard = poly_mask((H, W), HEAD_POLY) | (poly_mask((H, W), LOCK_POLY) & (hair > 0.5))
    # a soft edge where the cut runs through hair (identical hair lies underneath),
    # a crisp one along the jaw and the lock
    head = soften(head_hard, 0.8) * (1 - hair) + soften(head_hard, 5.0) * hair
    head = np.maximum(head, head_hard * (hair < 0.5))  # never soften inside the face
    head *= alpha

    # content with the dangles removed (for head and hair) and the arms removed (body)
    bg_dang = background(e_dang)
    nd_rgb = o_rgb.copy()
    nd_rgb[m_dang > 0] = e_dang[m_dang > 0]
    dang_alpha = np.where(m_dang > 0, 1.0 - bg_dang, alpha)

    body_rgb = o_rgb.copy()
    body_alpha = alpha.copy()
    for m, e in [(m_arm, e_free), (m_book, e_book)]:
        sel = m > 0
        body_rgb[sel] = e[sel]
        body_alpha[sel] = 1.0 - background(e)[sel]

    layers = {}
    # hair behind everything, extended under the body so swaying never shows a gap
    hb_alpha = np.maximum(hair * (1 - m_dang), (m_rib > 0) * (1.0 - bg_dang) * (1 - head_hard))
    # fill under the body's edges, but not under head ornaments that stick out past the hair
    ornaments = poly_mask((H, W), HEAD_POLY).astype(bool) & ~(dilate(hair > 0.5, 6) > 0)
    under = dilate(hb_alpha > 0.5, 40).astype(bool) & sil & (hb_alpha < 0.5) & ~ornaments
    hb_rgb = telea(nd_rgb, hb_alpha, under)
    hb_alpha = np.where(under, 1.0, hb_alpha)
    layers["hair_back"] = (hb_rgb, hb_alpha)

    # body: no hair, no head; fill the neck under the jaw and the shoulder under the lock
    b_alpha = body_alpha * (1 - hair) * (1 - head_hard) * (1 - m_dang)
    b_alpha[(m_arm > 0) | (m_book > 0)] = body_alpha[(m_arm > 0) | (m_book > 0)]
    lock = poly_mask((H, W), LOCK_POLY).astype(bool)
    ys_, xs_ = np.mgrid[0:H, 0:W]
    jaw_band = poly_mask((H, W), HEAD_POLY).astype(bool) & (ys_ > 440) & (xs_ > 500) & (xs_ < 720) & (hair < 0.5)
    fill = (lock | jaw_band) & sil
    b_rgb = telea(body_rgb, b_alpha, lock & sil)
    # under the jaw: a neck, i.e. the face's skin tone darkening into the collar's shadow
    skin = np.median(o_rgb[480:490, 570:620].reshape(-1, 3), axis=0)
    shade = np.clip((ys_ - 440) / 70.0, 0, 1)[..., None]
    neck = skin * (1 - 0.12 * shade)
    jaw = jaw_band & sil & (b_alpha < 0.5)
    b_rgb = np.where(jaw[..., None], neck, b_rgb)
    b_alpha = np.where(fill, 1.0, b_alpha)
    # drop specks and stray line art: keep only the large opaque parts of the body
    n, lab, st, _ = cv2.connectedComponentsWithStats((b_alpha > 0.3).astype(np.uint8), 8)
    keep = np.isin(lab, 1 + np.where(st[1:, cv2.CC_STAT_AREA] > 3000)[0])
    b_alpha *= dilate(keep, 2) > 0
    # the dangling tassels on the dress (recoloured cyan in seg_tassels); their place on
    # the body comes from rm_tassels
    seg_t = read_rgb(GEN / "seg_tassels.png")
    cyan = np.clip((np.minimum(seg_t[..., 1], seg_t[..., 2]) - seg_t[..., 0] - 80) / 100, 0, 1) > 0.5
    cyan = cv2.morphologyEx(cyan.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(cyan, 8)
    tassels = sorted([i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] > 300], key=lambda i: st[i, 0])
    under_t = dilate(cyan, 4) > 0
    b_rgb = np.where(under_t[..., None], e_tas, b_rgb)
    layers["body"] = (b_rgb, b_alpha)
    bones, skins, order = dict(BONES), dict(SKINS), list(LAYERS)
    for v, spec in ARM_VARIANTS.items():
        names = [f"arm{spec['side']}_{v}{k}" for k in range(len(spec["joints"]))]
        for k, (bn, pivot) in enumerate(zip(names, spec["joints"])):
            bones[bn] = {"parent": "chest" if k == 0 else names[k - 1], "pivot": pivot}
        skins[f"arm_{v}"] = {"type": "chain", "blend": 14, "joints": [[bn, pt] for bn, pt in zip(names, spec["joints"])]}
        # free-arm variants draw where the free arm draws; book-arm variants replace the book arm
        group = "armF" if spec["side"] == "F" else "armB"
        order.append({"name": f"arm_{v}", "skin": f"arm_{v}", "variant": v, "group": group})
    for k, i in enumerate(tassels):
        name = f"tassel_{k}"
        m = fill_holes((lab == i).astype(np.uint8))
        pivot = top_pivot(m)
        parent = "chest" if pivot[1] < 715 else "body"
        bones[name] = {"parent": parent, "pivot": pivot, "physics": {**TASSEL_PHYSICS, "seed": 1.7 + k}}
        skins[name] = {"type": "rigid", "bone": name}
        order.insert(order.index({"name": "body", "skin": "body"}) + 1 + k, {"name": name, "skin": name})
        layers[name] = (o_rgb, soften(dilate(m, 1)) * alpha)
        print(f"  {name}: pivot {pivot} parent {parent}")

    # bangs: the hair strands the bang-less redraw no longer has (minus stray flecks)
    diff_bangs = change_mask(e_bangs, o_rgb, thr=28, box=BANGS_BOX, min_area=40, blur=1.0)
    m_bangs = ((diff_bangs > 0) & (hair > 0.5)).astype(np.uint8)
    m_bangs = cv2.morphologyEx(m_bangs, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m_bangs, 8)
    m_bangs = np.isin(lab, 1 + np.where(st[1:, cv2.CC_STAT_AREA] >= 60)[0]).astype(np.uint8)
    head_rgb = np.where(soften(dilate(diff_bangs, 2), 1.0)[..., None] > 0.5, e_bangs, nd_rgb)

    # eyes: the opening is the white of eyes_blank (an edit of rm_bangs); the iris is the
    # non-white disk inside it, a little in from the lash line; the head keeps rm_bangs'
    # shaded corners and gets plain white only where the iris covers it
    white = (e_eyes.min(axis=2) > 225) & ((e_eyes[..., 0] - e_eyes[..., 2]) < 12)
    changed = change_mask(e_eyes, e_bangs, thr=40, box=EYES_BOX, min_area=200, blur=1.2)
    wn, wlab, _, _ = cv2.connectedComponentsWithStats(white.astype(np.uint8), 8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(changed, 8)
    seeds = sorted(sorted(range(1, n), key=lambda i: -st[i, cv2.CC_STAT_AREA])[:2], key=lambda i: cen[i][0])
    sclera = (e_bangs.min(axis=2) > 200) & ((e_bangs.max(axis=2) - e_bangs.min(axis=2)) < 45)
    masks = {}
    for side, i in zip(("l", "r"), seeds):
        hits = np.bincount(wlab[dilate(lab == i, 3) > 0], minlength=wn)
        hits[0] = 0
        opening = fill_holes((wlab == np.argmax(hits)).astype(np.uint8))
        inner = cv2.erode(opening, np.ones((5, 5), np.uint8)) > 0
        iris = fill_holes(largest((inner & ~sclera).astype(np.uint8)))
        iris = ((dilate(iris, 1) > 0) & (opening > 0)).astype(np.uint8)
        head_rgb = np.where(((dilate(iris, 2) > 0) & (opening > 0))[..., None], e_eyes, head_rgb)
        # the iris layer carries its dark rim and a sliver of sclera, so its soft edge
        # fades white-on-white instead of leaving a bright ring around the iris
        iris_layer = ((dilate(iris, 4) > 0) & (opening > 0)).astype(np.uint8)
        layers[f"iris_{side}"] = (e_bangs, soften(iris_layer, 0.8) * (opening > 0))
        masks[f"eye_open_{side}"] = (np.full_like(o_rgb, 255.0), soften(opening, 0.5))
        oy, ox = np.where(opening > 0)
        rng = [round(0.2 * (ox.max() - ox.min()), 1), round(0.13 * (oy.max() - oy.min()), 1)]
        for spec in order:
            if spec["name"] == f"iris_{side}":
                spec["range"] = rng
        print(f"  eye {side}: opening x {ox.min()}-{ox.max()} y {oy.min()}-{oy.max()}, iris {iris.sum()} px, range {rng}")
    layers["bangs"] = (o_rgb, soften(m_bangs, 0.6) * alpha)

    layers["head"] = (head_rgb, head * np.where(m_dang > 0, dang_alpha, 1.0))
    layers["arm_down"] = (o_rgb, soften(m_arm) * alpha)
    layers["arm_book"] = (o_rgb, soften(m_book) * alpha)
    layers["earring"] = (o_rgb, soften(m_ear) * alpha)
    layers["ribbon"] = (o_rgb, soften(m_rib) * alpha)
    layers["arm_wave"] = (w_wave, soften(m_wave) * (1.0 - background(w_wave)))
    layers["arm_chin"] = (w_chin, soften(m_chin) * (1.0 - background(w_chin)))
    for v, (img, m) in extra_arms.items():
        layers[f"arm_{v}"] = (img, soften(m) * (1.0 - background(img)))

    for name, (rgb, a) in masks.items():
        write_rgba(out_dir / f"{name}.png", np.dstack([rgb, np.clip(a, 0, 1) * 255.0]))
    finish(out_dir, layers, order, o_rgb, alpha, {
        "kind": "stand", "bones": bones, "skins": skins, "layers": order, "faceAfter": FACE_AFTER,
        "masks": list(masks),
    })


def finish(out_dir, layers, order, ref_rgb, alpha, spec, show=("down", "book")):
    """Write the layer PNGs and rig_src.json; check the rest pose against the source."""
    H, W = alpha.shape
    sil = alpha > 0.5
    for name, (rgb, a) in layers.items():
        write_rgba(out_dir / f"{name}.png", np.dstack([rgb, np.clip(a, 0, 1) * 255.0]))
        ys, xs_ = np.where(a > 0.01)
        print(f"  {name:11s} bbox x {xs_.min()}-{xs_.max()} y {ys.min()}-{ys.max()}  ({(a > 0.5).sum()} px)")
    comp = np.zeros((H, W, 3), np.float32)
    acc = np.zeros((H, W), np.float32)
    for layer in order:
        if ((layer.get("variant") and layer["variant"] not in show) or layer["name"] not in layers
                or layer.get("propOnly")):
            continue
        rgb, a = layers[layer["name"]]
        comp = comp * (1 - a[..., None]) + rgb * a[..., None]
        acc = acc * (1 - a) + a
    diff = np.abs(comp - ref_rgb * alpha[..., None]).max(axis=2)
    print(f"rest pose vs source: mean |diff| {diff[sil].mean():.2f}, 99th pct {np.percentile(diff[sil], 99):.1f}, "
          f"coverage holes {(sil & (acc < 0.5)).sum()} px")
    write_rgba(out_dir / "_rest.png", np.dstack([comp, acc * 255.0]))
    (out_dir / "rig_src.json").write_text(json.dumps(spec, indent=1))
    print(f"wrote {out_dir}")

# ---------------- other poses: walk, sit, drag ----------------
#
# Each is an edit set of its own green-backdrop render (gen/<ref>.png):
#   <prefix>_seg_hair     hair recoloured magenta          -> hair mask
#   <prefix>_rm_dangles   ribbon tails and earrings removed -> dangle masks + what is behind them
#   <prefix>_seg_legs     legs recoloured blue (optional)   -> leg masks
#   <prefix>_rm_legs      legs removed (optional)           -> complete petticoat for the body
#   <prefix>_rm_arm       free arm removed (optional)       -> arm mask + what is behind it
# Earrings are found automatically (dangle components left of ribbon_min_x) and each
# gets its own spring bone.

HAIR_SPRING = {"k": 13, "c": 2.5, "gain": 0.6, "wind": 0.02, "windRate": 0.5, "max": 0.22,
               "ks": 40, "cs": 6, "gs": 0.25, "kick": 0.12}
EARRING_SPRING = {"k": 45, "c": 2.5, "gain": 1.4, "wind": 0.06, "windRate": 0.9, "max": 0.6, "kick": 1.0, "drag": 0.1}
RIBBON_SPRING = {"k": 22, "c": 2.2, "gain": 1.2, "wind": 0.05, "windRate": 0.7, "max": 0.45, "seed": 0.7,
                 "kick": 0.9, "ks": 30, "cs": 5, "gs": 0.2, "drag": 0.15}
SKIRT_SPRING = {"k": 26, "c": 4.5, "gain": 0.3, "wind": 0.008, "windRate": 0.4, "max": 0.07, "seed": 2.2,
                "kick": 0.2, "drag": 0.03}


def spring(base, **over):
    return {**base, **over}


POSES = {
    # 3/4 view facing +x
    "walk": {
        "sprite": "walk", "ref": "walk", "prefix": "walk",
        "head_poly": [(470, 200), (520, 80), (640, 10), (800, 0), (960, 30), (1060, 120), (1070, 330),
                      (960, 360), (950, 420), (930, 470), (880, 472), (860, 488), (820, 495), (760, 497),
                      (700, 492), (650, 482), (612, 470), (560, 440), (500, 350)],
        "dangles_box": (560, 280, 1080, 560), "ribbon_min_x": 965,
        "arm_box": (840, 560, 1120, 800),
        "legs": {"names": ["leg_back", "leg_front"]},
        "neck": {"y": 450, "x": (650, 900), "skin": (470, 480, 760, 800)},
        "bones": {
            "root": {"parent": None, "pivot": [770, 1200]},  # feet stay on the ground
            "body": {"parent": "root", "pivot": [770, 1200]},  # bobs and sways
            "chest": {"parent": "body", "pivot": [780, 760]},
            "head": {"parent": "chest", "pivot": [770, 500]},
            "armF": {"parent": "chest", "pivot": [895, 615]},
            "handF": {"parent": "armF", "pivot": [1000, 735]},
            # The legs are drawn mid-stride (front leg 33 deg forward, toe up; back leg 27 deg
            # back, toe down). Rest angles stand both upright with flat soles, so the cycle can
            # swing each leg through the same arc, half a cycle apart, and they pass each other.
            "legB": {"parent": "root", "pivot": [705, 905], "rest": -27},
            "footB": {"parent": "legB", "pivot": [630, 1105], "rest": 12},
            "legF": {"parent": "root", "pivot": [802, 905], "rest": 33},
            "footF": {"parent": "legF", "pivot": [850, 1125], "rest": -23},
            "hairL": {"parent": "chest", "pivot": [520, 520], "physics": spring(HAIR_SPRING, k=12, seed=1.3, drag=0.1)},
            "hairR": {"parent": "chest", "pivot": [960, 520], "physics": spring(HAIR_SPRING, k=14, seed=4.1, drag=0.08)},
            "skirt": {"parent": "body", "pivot": [780, 760], "physics": SKIRT_SPRING},
            "ribbon": {"parent": "head", "pivot": [1000, 320], "physics": RIBBON_SPRING},
        },
        "skins": {
            "hair_back": {"type": "hair", "headY": [380, 560], "swingY": [470, 950], "sideX": [60, 330], "cx": 770},
            "leg_back": {"type": "chain", "blend": 14, "joints": [["legB", [705, 905]], ["footB", [630, 1105]]]},
            "leg_front": {"type": "chain", "blend": 14, "joints": [["legF", [802, 905]], ["footF", [850, 1125]]]},
            "body": {"type": "body", "waistY": [740, 790], "hemY": [900, 1100]},
            "arm": {"type": "chain", "blend": 14, "joints": [["armF", [895, 615]], ["handF", [1000, 735]]]},
            "head": {"type": "head", "lockY": [520, 640], "lockLag": 0.4},
            "ribbon": {"type": "rigid", "bone": "ribbon"},
        },
        # legs go behind the skirt: they only show below the hem, so they can cross freely
        "layers": ["hair_back", "leg_back", "leg_front", "body", "arm", "head", "ribbon"],
    },
    # sitting on the floor reading; the long hair pools on the floor
    "sit": {
        "sprite": "sit_read", "ref": "sit_read", "prefix": "sit",
        "head_poly": [(330, 300), (360, 160), (430, 60), (560, 10), (720, 20), (870, 60), (990, 160), (1000, 330),
                      (900, 340), (870, 420), (840, 500), (790, 530), (740, 532), (700, 545), (650, 552), (600, 553),
                      (550, 545), (510, 525), (470, 505), (400, 480), (340, 420)],
        "dangles_box": (760, 200, 1010, 600), "ribbon_min_x": 840,
        "bangs_box": (340, 140, 860, 500), "eyes_box": (415, 300, 780, 500),
        "neck": {"y": 505, "x": (520, 760), "skin": (500, 528, 560, 660)},
        "bones": {
            "root": {"parent": None, "pivot": [640, 1150]},
            "body": {"parent": "root", "pivot": [640, 1150]},
            "chest": {"parent": "body", "pivot": [640, 860]},
            "head": {"parent": "chest", "pivot": [630, 560]},
            "hairL": {"parent": "chest", "pivot": [420, 560], "physics": spring(HAIR_SPRING, max=0.035, gain=0.2, seed=1.1)},
            "hairR": {"parent": "chest", "pivot": [860, 560], "physics": spring(HAIR_SPRING, max=0.035, gain=0.2, seed=3.7)},
            "skirt": {"parent": "body", "pivot": [640, 860], "physics": spring(SKIRT_SPRING, max=0.015)},
            "ribbon": {"parent": "head", "pivot": [905, 245], "physics": RIBBON_SPRING},
        },
        "skins": {
            "hair_back": {"type": "hair", "headY": [430, 620], "swingY": [620, 1000], "sideX": [60, 330], "cx": 640},
            "body": {"type": "body", "waistY": [820, 880], "hemY": [1300, 1400]},
            "head": {"type": "head", "lockY": [540, 700], "lockLag": 0.4},
            "ribbon": {"type": "rigid", "bone": "ribbon"},
        },
        "layers": ["hair_back", "body", "head", "ribbon"],
    },
    # picked up by the collar: legs dangle, hair hangs
    "drag": {
        "sprite": "drag", "ref": "drag", "prefix": "drag",
        "head_poly": [(300, 250), (340, 120), (430, 40), (560, 5), (700, 15), (840, 60), (930, 140), (950, 330),
                      (900, 380), (830, 380), (790, 400), (750, 410), (700, 426), (650, 428), (600, 428),
                      (545, 428), (520, 420), (480, 400), (400, 380), (330, 330)],
        "dangles_box": (740, 150, 1000, 520), "ribbon_min_x": 830, "earring_max_x": 818,
        "legs": {"names": ["leg_l", "leg_r"], "auto": {"hip_up": 120, "ankle_up": 80}},
        "neck": {"y": 395, "x": (520, 720), "skin": (395, 415, 570, 610)},
        "bones": {
            "root": {"parent": None, "pivot": [620, 420]},
            "body": {"parent": "root", "pivot": [620, 420]},
            "chest": {"parent": "body", "pivot": [620, 640]},
            "head": {"parent": "chest", "pivot": [620, 440]},
            "hairL": {"parent": "chest", "pivot": [380, 460], "physics": spring(HAIR_SPRING, k=10, gain=0.8, max=0.28, seed=1.9)},
            "hairR": {"parent": "chest", "pivot": [860, 460], "physics": spring(HAIR_SPRING, k=11, gain=0.8, max=0.28, seed=4.4)},
            "skirt": {"parent": "body", "pivot": [620, 660], "physics": spring(SKIRT_SPRING, max=0.1, gain=0.45)},
            "ribbon": {"parent": "head", "pivot": [880, 200], "physics": RIBBON_SPRING},
        },
        "skins": {
            "hair_back": {"type": "hair", "headY": [330, 500], "swingY": [480, 950], "sideX": [60, 330], "cx": 620},
            "body": {"type": "body", "waistY": [640, 700], "hemY": [850, 1000]},
            "head": {"type": "head", "lockY": [430, 600], "lockLag": 0.4},
            "ribbon": {"type": "rigid", "bone": "ribbon"},
        },
        "layers": ["hair_back", "leg_l", "leg_r", "body", "head", "ribbon"],
    },
}


def hair_mask(seg, rgb, alpha):
    """Magenta-recoloured hair, plus the hair's own outline and the lines between strands."""
    hair = np.clip(((seg[..., 0] + seg[..., 2]) / 2 - seg[..., 1] - 60) / 120, 0, 1) * alpha
    dark = rgb.max(axis=2) < 150
    outline = dark & (dilate(hair > 0.5, 3) > 0) & (dilate(alpha < 0.1, 4) > 0)
    hair = np.maximum(hair, outline * alpha)
    closed = cv2.morphologyEx((hair > 0.5).astype(np.uint8), cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    return np.maximum(hair, closed * dark * alpha)


BANGS_SPRING = {"k": 30, "c": 4.0, "gain": 0.8, "wind": 0.01, "windRate": 0.6, "max": 0.08, "seed": 6.1,
                "kick": 0.45, "ks": 50, "cs": 7, "gs": 0.15}


def add_eyes(pre, rgb, alpha, hair, head_hard, head_rgb, bangs_box, eyes_box, bones, skins, layers, masks):
    """Irises as their own layers (sliding inside eye-opening masks) and the bangs as a
    spring layer over them, from the bangs-removed and blank-eyed renders of this pose.
    Returns the head's rgb with the bangless forehead and the eye whites painted in,
    plus the layer entries to insert right after the head."""
    e_bangs = keyed_rgba(read_rgb(GEN / f"{pre}_rm_bangs.png"))[..., :3]
    e_eyes = keyed_rgba(read_rgb(GEN / f"{pre}_eyes_blank.png"))[..., :3]
    inside = (alpha > 0.5) & (head_hard > 0)
    diff_bangs = change_mask(e_bangs, rgb, thr=28, box=bangs_box, min_area=40, blur=1.0)
    m_bangs = ((diff_bangs > 0) & (hair > 0.5)).astype(np.uint8)
    m_bangs = cv2.morphologyEx(m_bangs, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m_bangs, 8)
    m_bangs = np.isin(lab, 1 + np.where(st[1:, cv2.CC_STAT_AREA] >= 60)[0]).astype(np.uint8)
    head_rgb = np.where((soften(dilate(diff_bangs, 2), 1.0) > 0.5)[..., None], e_bangs, head_rgb)
    white = (e_eyes.min(axis=2) > 225) & ((e_eyes[..., 0] - e_eyes[..., 2]) < 12) & inside
    changed = change_mask(e_eyes, e_bangs, thr=40, box=eyes_box, min_area=200, blur=1.2)
    wn, wlab, _, _ = cv2.connectedComponentsWithStats(white.astype(np.uint8), 8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(changed, 8)
    seeds = sorted(sorted(range(1, n), key=lambda i: -st[i, cv2.CC_STAT_AREA])[:2], key=lambda i: cen[i][0])
    sclera = (e_bangs.min(axis=2) > 200) & ((e_bangs.max(axis=2) - e_bangs.min(axis=2)) < 45)
    entries = []
    for side, i in zip(("l", "r"), seeds):
        hits = np.bincount(wlab[dilate(lab == i, 3) > 0], minlength=wn)
        hits[0] = 0
        opening = fill_holes((wlab == np.argmax(hits)).astype(np.uint8))
        inner = cv2.erode(opening, np.ones((5, 5), np.uint8)) > 0
        iris = fill_holes(largest((inner & ~sclera).astype(np.uint8)))
        iris = ((dilate(iris, 1) > 0) & (opening > 0)).astype(np.uint8)
        head_rgb = np.where(((dilate(iris, 2) > 0) & (opening > 0))[..., None], e_eyes, head_rgb)
        iris_layer = ((dilate(iris, 4) > 0) & (opening > 0)).astype(np.uint8)
        layers[f"iris_{side}"] = (e_bangs, soften(iris_layer, 0.8) * (opening > 0))
        masks[f"eye_open_{side}"] = (np.full_like(rgb, 255.0), soften(opening, 0.5))
        oy, ox = np.where(opening > 0)
        iy, ix = np.where(iris > 0)
        bone = f"eye{side.upper()}"
        bones[bone] = {"parent": "head", "pivot": [round(float(ix.mean()), 1), round(float(iy.mean()), 1)]}
        skins[f"iris_{side}"] = {"type": "rigid", "bone": bone}
        rng = [round(0.2 * (ox.max() - ox.min()), 1), round(0.13 * (oy.max() - oy.min()), 1)]
        entries.append({"name": f"iris_{side}", "skin": f"iris_{side}", "type": "iris", "clip": f"eye_open_{side}",
                        "range": rng})
        print(f"  eye {side}: opening x {ox.min()}-{ox.max()} y {oy.min()}-{oy.max()}, iris {iris.sum()} px, range {rng}")
    by, bx = np.where(m_bangs > 0)
    bones["bangs"] = {"parent": "head", "pivot": [round(float(bx.mean()), 1), float(by.min() - 10)], "physics": BANGS_SPRING}
    skins["bangs"] = {"type": "rigid", "bone": "bangs"}
    layers["bangs"] = (rgb, soften(m_bangs, 0.6) * alpha)
    entries.append({"name": "bangs", "skin": "bangs"})
    return head_rgb, entries


def build_pose(name):
    cfg = POSES[name]
    out_dir = WORK / f"rig_{name}"
    out_dir.mkdir(parents=True, exist_ok=True)
    base = read_rgba(WORK / f"{cfg['sprite']}.png")  # keyed sprite
    ref = read_rgb(GEN / f"{cfg['ref']}.png")  # the green-backdrop render all edits are aligned with
    pre = cfg["prefix"]
    rgb, alpha = base[..., :3], base[..., 3] / 255.0
    H, W = alpha.shape
    sil = alpha > 0.5
    ys_, xs_ = np.mgrid[0:H, 0:W]
    bones, skins = dict(cfg["bones"]), dict(cfg["skins"])
    order = [{"name": n, "skin": n} for n in cfg["layers"]]
    layers = {}
    masks = {}
    face_after = "head"

    hair = hair_mask(read_rgb(GEN / f"{pre}_seg_hair.png"), rgb, alpha)
    head_hard = poly_mask((H, W), cfg["head_poly"])
    head = soften(head_hard, 0.8) * (1 - hair) + soften(head_hard, 5.0) * hair
    head = np.maximum(head, head_hard * (hair < 0.5)) * alpha

    # dangles: the ribbon tails (right of ribbon_min_x) and any number of earrings
    m_dang = region(read_rgb(GEN / f"{pre}_rm_dangles.png"), ref, cfg["dangles_box"], keep_largest=False, close=5)
    n, lab, st, cen = cv2.connectedComponentsWithStats(m_dang, 8)
    m_rib = np.zeros_like(m_dang)
    earrings = []
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA]
        if cen[i][0] >= cfg["ribbon_min_x"] and area >= 150:
            m_rib |= (lab == i).astype(np.uint8)
        elif area >= 1000:  # an earring; smaller pieces are redraw noise around the ornaments
            earrings.append((lab == i).astype(np.uint8))
        else:
            m_dang[lab == i] = 0
    if "earring_max_x" in cfg:  # an earring touching the ribbon tail: split it off by position
        part = m_rib * (xs_ < cfg["earring_max_x"])
        if part.sum() >= 1000:
            earrings.append(largest(part))
            m_rib = m_rib * (1 - earrings[-1])
    earrings.sort(key=lambda m: np.where(m)[1].mean())
    dang = keyed_rgba(read_rgb(GEN / f"{pre}_rm_dangles.png"))
    nd_rgb = np.where((m_dang > 0)[..., None], dang[..., :3], rgb)
    nd_alpha = np.where(m_dang > 0, dang[..., 3] / 255.0, alpha)
    head_at = cfg["layers"].index("head")
    for k, m in enumerate(earrings):
        e = f"earring_{k}"
        bones[e] = {"parent": "head", "pivot": top_pivot(m), "physics": spring(EARRING_SPRING, seed=3.1 + 1.7 * k)}
        skins[e] = {"type": "rigid", "bone": e}
        order.insert(head_at + 1 + k, {"name": e, "skin": e})
        layers[e] = (rgb, soften(m) * alpha)
        print(f"  {e}: pivot {bones[e]['pivot']}")
    layers["ribbon"] = (rgb, soften(m_rib) * alpha)

    legs = np.zeros((H, W), bool)
    if "legs" in cfg:
        seg = read_rgb(GEN / f"{pre}_seg_legs.png")
        legs = np.clip((seg[..., 2] - np.maximum(seg[..., 0], seg[..., 1]) - 60) / 100, 0, 1) > 0.5

    # the hair is padded under the body's edges so a swinging strand never opens a gap,
    # but not under head ornaments that stick out past it, nor where the legs are (they
    # move away and would uncover the padding)
    hb_alpha = np.maximum(hair * (1 - m_dang), (m_rib > 0) * nd_alpha * (1 - head_hard))
    ornaments = head_hard.astype(bool) & ~(dilate(hair > 0.5, 6) > 0)
    under = (dilate(hb_alpha > 0.5, 40).astype(bool) & sil & (hb_alpha < 0.5) & ~ornaments
             & ~(dilate(legs, 10) > 0))
    layers["hair_back"] = (telea(nd_rgb, hb_alpha, under), np.where(under, 1.0, hb_alpha))

    # legs: separate layers behind the body, continued upward under the skirt so a lifted
    # body never shows their cut top; the body then uses the legless redraw
    base_rgb, base_alpha = rgb, alpha
    if "legs" in cfg:
        n, lab, st, _ = cv2.connectedComponentsWithStats(legs.astype(np.uint8), 8)
        comps = sorted(sorted(range(1, n), key=lambda i: -st[i, cv2.CC_STAT_AREA])[:2], key=lambda i: st[i, 0])
        m_legs = np.zeros_like(legs, np.uint8)
        auto = cfg["legs"].get("auto")
        for leg_name, i in zip(cfg["legs"]["names"], comps):
            m = fill_holes((lab == i).astype(np.uint8))
            m_legs |= m
            top = np.where(m.any(axis=1))[0].min()
            bot = np.where(m.any(axis=1))[0].max()
            up = np.zeros_like(m)
            for k in range(1, 46):
                up[:-k] |= m[k:]
            ext = (up > 0) & (m == 0) & (ys_ < top + 20)
            leg_alpha = soften(m) * np.maximum(alpha, m)
            layers[leg_name] = (telea(rgb, leg_alpha, ext), np.where(ext, 1.0, leg_alpha))
            if auto:  # hip hidden under the skirt above the leg's top, ankle above the sole
                side = leg_name[-1].upper()
                cx_top = float(np.where(m[top + 4])[0].mean())
                cx_bot = float(np.where(m[bot - auto["ankle_up"]])[0].mean())
                hip = [cx_top, float(top - auto["hip_up"])]
                ankle = [cx_bot, float(bot - auto["ankle_up"])]
                bones[f"leg{side}"] = {"parent": "root", "pivot": hip}
                bones[f"foot{side}"] = {"parent": f"leg{side}", "pivot": ankle}
                skins[leg_name] = {"type": "chain", "blend": 14, "joints": [[f"leg{side}", hip], [f"foot{side}", ankle]]}
                print(f"  {leg_name}: hip {hip} ankle {ankle}")
        legless = keyed_rgba(read_rgb(GEN / f"{pre}_rm_legs.png"))
        lower = dilate(m_legs, 8) > 0
        base_rgb = np.where(lower[..., None], legless[..., :3], rgb)
        base_alpha = np.where(lower, legless[..., 3] / 255.0, alpha)

    # body: everything else
    b_rgb = base_rgb
    b_alpha = base_alpha * (1 - hair) * (1 - head_hard) * (1 - m_dang)
    if "arm_box" in cfg:
        armless = keyed_rgba(read_rgb(GEN / f"{pre}_rm_arm.png"))
        m_arm = region(read_rgb(GEN / f"{pre}_rm_arm.png"), ref, cfg["arm_box"])
        b_rgb = np.where((m_arm > 0)[..., None], armless[..., :3], b_rgb)
        b_alpha = np.where(m_arm > 0, armless[..., 3] / 255.0, b_alpha)
        layers["arm"] = (rgb, soften(m_arm) * alpha)
    # a neck under the jaw: the face's skin tone darkening into the collar's shadow
    neck = cfg["neck"]
    y0, y1, x0, x1 = neck["skin"]
    skin = np.median(rgb[y0:y1, x0:x1].reshape(-1, 3), axis=0)
    jaw = (head_hard.astype(bool) & (ys_ > neck["y"]) & (xs_ > neck["x"][0]) & (xs_ < neck["x"][1])
           & (hair < 0.5) & sil & (b_alpha < 0.5))
    shade = np.clip((ys_ - neck["y"]) / 60.0, 0, 1)[..., None]
    b_rgb = np.where(jaw[..., None], skin * (1 - 0.12 * shade), b_rgb)
    b_alpha = np.where(jaw, 1.0, b_alpha)
    n, lab, st, _ = cv2.connectedComponentsWithStats((b_alpha > 0.3).astype(np.uint8), 8)
    keep = np.isin(lab, 1 + np.where(st[1:, cv2.CC_STAT_AREA] > 3000)[0])
    b_alpha *= dilate(keep, 2) > 0
    layers["body"] = (b_rgb, b_alpha)
    head_rgb = nd_rgb
    if "eyes_box" in cfg:
        head_rgb, eyes = add_eyes(pre, rgb, alpha, hair, head_hard, nd_rgb, cfg["bangs_box"], cfg["eyes_box"],
                                  bones, skins, layers, masks)
        at = next(i for i, e in enumerate(order) if e["name"] == "head") + 1
        order[at:at] = eyes
        face_after = "iris_r"  # face patches go over the eyes but under the bangs
    layers["head"] = (head_rgb, head * np.where(m_dang > 0, nd_alpha, 1.0))

    for mname, (mrgb, ma) in masks.items():
        write_rgba(out_dir / f"{mname}.png", np.dstack([mrgb, np.clip(ma, 0, 1) * 255.0]))
    finish(out_dir, layers, order, rgb, alpha, {
        "kind": name, "bones": bones, "skins": skins, "layers": order, "faceAfter": face_after, "masks": list(masks),
    })


# ---------------- the work scene: desk, stool, writing ----------------
#
# Edits of gen/work.png: work_rm_char (only the furniture, complete), work_rm_arm
# (writing arm removed), work_arm_think (thinking arm drawn onto work_rm_arm),
# work_rm_legs, work_seg_legs, work_seg_hair, work_rm_dangles, work_seg_write_arm.
# The furniture are props: their own bones, so they can slide in and out.

WORK_CFG = {
    "head_poly": [(300, 300), (330, 150), (430, 50), (560, 10), (720, 15), (850, 40), (960, 120), (980, 330),
                  (880, 340), (860, 420), (790, 432), (740, 442), (690, 456), (630, 464), (570, 457), (520, 447),
                  (470, 432), (400, 420), (320, 380)],
    "dangles_box": (440, 280, 980, 560), "ribbon_min_x": 855,
    "stool_max_x": 556, "stool_min_y": 820,
    "neck": {"y": 440, "x": (560, 710), "skin": (440, 452, 600, 660)},
    "bangs_box": (420, 100, 930, 440), "eyes_box": (520, 330, 750, 420),
    "write_joints": [[510, 515], [495, 670], [655, 650]],
    "think_joints": [[530, 560], [585, 680], [625, 565]],
    "think_box": (440, 380, 800, 740),
    "legs": {"hip_up": 20, "ankle_up": 60},
}
WORK_BONES = {
    "root": {"parent": None, "pivot": [600, 1233]},
    "stool": {"parent": "root", "pivot": [415, 1210]},
    "desk": {"parent": "root", "pivot": [870, 1233]},
    "body": {"parent": "root", "pivot": [430, 990]},
    "chest": {"parent": "body", "pivot": [520, 760]},
    "head": {"parent": "chest", "pivot": [630, 470]},
    "armW": {"parent": "chest", "pivot": [495, 670]},
    "handW": {"parent": "armW", "pivot": [655, 650]},
    "foreT": {"parent": "chest", "pivot": [585, 680]},
    "handT": {"parent": "foreT", "pivot": [625, 565]},
    "hairL": {"parent": "chest", "pivot": [380, 480], "physics": spring(HAIR_SPRING, k=13, max=0.12, seed=1.5)},
    "hairR": {"parent": "chest", "pivot": [800, 480], "physics": spring(HAIR_SPRING, k=14, max=0.06, seed=4.2)},
    "skirt": {"parent": "body", "pivot": [520, 760], "physics": spring(SKIRT_SPRING, max=0.02)},
    "ribbon": {"parent": "head", "pivot": [905, 300], "physics": RIBBON_SPRING},
}
WORK_SKINS = {
    "stool": {"type": "rigid", "bone": "stool"},
    "desk": {"type": "rigid", "bone": "desk"},
    "desk_whole": {"type": "rigid", "bone": "desk"},
    "hair_back": {"type": "hair", "headY": [380, 560], "swingY": [500, 1000], "sideX": [60, 330], "cx": 630},
    "body": {"type": "body", "waistY": [720, 780], "hemY": [950, 1060]},
    "head": {"type": "head", "lockY": [470, 640], "lockLag": 0.4},
    "ribbon": {"type": "rigid", "bone": "ribbon"},
}
# desk_whole: the complete desk, shown only while the furniture moves on its own; desk:
# only the parts in front of her (top board, front leg), drawn over her lap
WORK_LAYERS = ["stool", "desk_whole", "hair_back", "leg_l", "leg_r", "body", "desk", "arm_write", "arm_think",
               "head", "ribbon"]


def build_work():
    cfg = WORK_CFG
    out_dir = WORK / "rig_work"
    out_dir.mkdir(parents=True, exist_ok=True)
    base = read_rgba(WORK / "work.png")
    ref = read_rgb(GEN / "work.png")
    rgb, alpha = base[..., :3], base[..., 3] / 255.0
    H, W = alpha.shape
    sil = alpha > 0.5
    ys_, xs_ = np.mgrid[0:H, 0:W]
    keyed = {n: keyed_rgba(read_rgb(GEN / f"work_{n}.png")) for n in ("rm_char", "rm_arm", "rm_legs", "rm_dangles")}
    bones, skins = dict(WORK_BONES), dict(WORK_SKINS)
    order = []
    layers = {}

    # ---- props: the complete furniture from rm_char, split into stool and desk ----
    pc = keyed["rm_char"]
    prop_a = pc[..., 3] / 255.0
    prop_full = prop_a > 0.5
    stool_full = prop_full & (xs_ < cfg["stool_max_x"]) & (ys_ > cfg["stool_min_y"])
    desk_full = prop_full & ~stool_full
    # where the original shows the furniture (it matches rm_char), the rest is her
    same = cv2.GaussianBlur(np.abs(ref - read_rgb(GEN / "work_rm_char.png")).max(axis=2), (0, 0), 1.2) < 30
    prop_vis = prop_full & same
    her = sil & ~prop_vis

    # ---- masks of her parts ----
    hair = hair_mask(read_rgb(GEN / "work_seg_hair.png"), rgb, alpha)
    head_hard = poly_mask((H, W), cfg["head_poly"])
    head = soften(head_hard, 0.8) * (1 - hair) + soften(head_hard, 5.0) * hair
    head = np.maximum(head, head_hard * (hair < 0.5)) * alpha
    seg = read_rgb(GEN / "work_seg_write_arm.png")
    m_write = fill_holes(largest((np.clip((seg[..., 2] - np.maximum(seg[..., 0], seg[..., 1]) - 60) / 100, 0, 1)
                                  > 0.5).astype(np.uint8)))
    think = read_rgb(GEN / "work_arm_think.png")
    m_think = region(think, read_rgb(GEN / "work_rm_arm.png"), cfg["think_box"], close=21)
    segl = read_rgb(GEN / "work_seg_legs.png")
    legs = (np.clip((segl[..., 2] - np.maximum(segl[..., 0], segl[..., 1]) - 60) / 100, 0, 1) > 0.5).astype(np.uint8)
    legs = fill_holes(largest(legs))
    legless_a = keyed["rm_legs"][..., 3] / 255.0
    missed = (dilate(legs, 8) > 0) & (legless_a < 0.5) & sil & ~prop_vis & (legs == 0)
    legs = legs | missed.astype(np.uint8)
    # the recolour stops a few px inside the boots' outline: grow into the original
    # below the hem, where nothing but the legs is
    leg_top = np.where(legs.any(axis=1))[0].min()
    grow = (dilate(legs, 7) > 0) & sil & ~prop_vis & (ys_ > leg_top + 30)
    legs = legs | grow.astype(np.uint8)
    # the two boots touch: split them at the narrowest column between them
    cols = legs.sum(axis=0).astype(float)
    xs_l = np.where(cols > 0)[0]
    mid = xs_l.min() + (xs_l.max() - xs_l.min()) // 2
    lo, hi = mid - 50, mid + 50
    split = lo + int(np.argmin(cols[lo:hi]))
    m_leg = {"leg_l": legs * (xs_ < split), "leg_r": legs * (xs_ >= split)}

    # ---- dangles (ribbon tails, earrings) ----
    m_dang = region(read_rgb(GEN / "work_rm_dangles.png"), ref, cfg["dangles_box"], keep_largest=False, close=5)
    n, lab, st, cen = cv2.connectedComponentsWithStats(m_dang, 8)
    m_rib = np.zeros_like(m_dang)
    earrings = []
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA]
        if cen[i][0] >= cfg["ribbon_min_x"] and area >= 150:
            m_rib |= (lab == i).astype(np.uint8)
        elif area >= 800:
            earrings.append((lab == i).astype(np.uint8))
        else:
            m_dang[lab == i] = 0
    part = m_rib * (xs_ < cfg["ribbon_min_x"] - 5)  # the right earring touches the ribbon tails
    if part.sum() >= 800:
        earrings.append(largest(part))
        m_rib = m_rib * (1 - earrings[-1])
    dang = keyed["rm_dangles"]
    nd_rgb = np.where((m_dang > 0)[..., None], dang[..., :3], rgb)
    nd_alpha = np.where(m_dang > 0, dang[..., 3] / 255.0, alpha)

    # ---- stool: visible parts from the original, hidden ones from rm_char ----
    stool_rgb = np.where((prop_vis & stool_full)[..., None], rgb, pc[..., :3])
    layers["stool"] = (stool_rgb, prop_a * stool_full)

    # ---- hair: padded under her edges, never over the furniture or the legs ----
    hb_alpha = np.maximum(hair * (1 - m_dang), (m_rib > 0) * nd_alpha * (1 - head_hard)) * her
    ornaments = head_hard.astype(bool) & ~(dilate(hair > 0.5, 6) > 0)
    under = (dilate(hb_alpha > 0.5, 40).astype(bool) & her & (hb_alpha < 0.5) & ~ornaments
             & ~(dilate(legs, 10) > 0) & ~prop_full)
    layers["hair_back"] = (telea(nd_rgb, hb_alpha, under), np.where(under, 1.0, hb_alpha))

    # ---- legs, extended up under the skirt; knee above, ankle above the sole ----
    for name, m in m_leg.items():
        top = np.where(m.any(axis=1))[0].min()
        bot = np.where(m.any(axis=1))[0].max()
        up = np.zeros_like(m)
        for k in range(1, 40):
            up[:-k] |= m[k:]
        ext = (up > 0) & (m == 0) & (ys_ < top + 20)
        leg_alpha = soften(m) * np.maximum(alpha, m)
        layers[name] = (telea(rgb, leg_alpha, ext), np.where(ext, 1.0, leg_alpha))
        side = name[-1].upper()
        knee = [float(np.where(m[top + 4])[0].mean()), float(top - cfg["legs"]["hip_up"])]
        ankle = [float(np.where(m[bot - cfg["legs"]["ankle_up"]])[0].mean()), float(bot - cfg["legs"]["ankle_up"])]
        bones[f"leg{side}"] = {"parent": "body", "pivot": knee}
        bones[f"foot{side}"] = {"parent": f"leg{side}", "pivot": ankle}
        skins[name] = {"type": "chain", "blend": 14, "joints": [[f"leg{side}", knee], [f"foot{side}", ankle]]}
        print(f"  {name}: knee {knee} ankle {ankle}")

    # ---- body: her, outside the desk; arm and legs from their removal edits ----
    armless, legless = keyed["rm_arm"], keyed["rm_legs"]
    b_rgb = rgb.copy()
    b_alpha = alpha * her
    # below the hem take the legless redraw, but only its skirt: it also painted
    # furniture where the legs were, which must not end up in front of them
    near_legs = np.zeros((H, W), bool)
    for m in m_leg.values():
        top = np.where(m.any(axis=1))[0].min()
        near_legs |= (dilate(m, 8) > 0) & (ys_ < top + 40)
    b_rgb = np.where(near_legs[..., None], legless[..., :3], b_rgb)
    b_alpha = np.where(near_legs, legless[..., 3] / 255.0, b_alpha)
    # lower down keep the original (the skirt hanging beside the boots), minus the legs,
    # which are their own layers; the redraw also painted furniture there
    below = (dilate(legs, 8) > 0) & ~near_legs
    b_rgb = np.where(below[..., None], rgb, b_rgb)
    b_alpha = np.where(below, alpha * her * (legs == 0), b_alpha)
    near_arm = dilate(m_write, 3) > 0
    b_rgb = np.where(near_arm[..., None], armless[..., :3], b_rgb)
    b_alpha = np.where(near_arm, armless[..., 3] / 255.0, b_alpha)
    b_alpha = b_alpha * (1 - hair) * (1 - head_hard) * (1 - m_dang)
    neck = cfg["neck"]
    y0, y1, x0, x1 = neck["skin"]
    skin = np.median(rgb[y0:y1, x0:x1].reshape(-1, 3), axis=0)
    jaw = (head_hard.astype(bool) & (ys_ > neck["y"]) & (xs_ > neck["x"][0]) & (xs_ < neck["x"][1])
           & (hair < 0.5) & sil & (b_alpha < 0.5))
    shade = np.clip((ys_ - neck["y"]) / 60.0, 0, 1)[..., None]
    b_rgb = np.where(jaw[..., None], skin * (1 - 0.12 * shade), b_rgb)
    b_alpha = np.where(jaw, 1.0, b_alpha)
    n, lab, st, _ = cv2.connectedComponentsWithStats((b_alpha > 0.3).astype(np.uint8), 8)
    keep = np.isin(lab, 1 + np.where(st[1:, cv2.CC_STAT_AREA] > 3000)[0])
    kept = dilate(keep, 2) > 0
    stray = (b_alpha > 0.3) & ~kept  # bits of furniture edge mistaken for her
    b_alpha *= kept
    layers["body"] = (b_rgb, b_alpha)

    # ---- desk: where it is in front of her, plus the paper under the writing arm ----
    under_arm = (dilate(m_write, 4) > 0) & desk_full
    seen = (prop_vis & desk_full) | under_arm | (stray & (dilate(desk_full, 3) > 0))
    d_rgb = np.where(under_arm[..., None], armless[..., :3], rgb)
    layers["desk"] = (d_rgb, prop_a * seen)
    layers["desk_whole"] = (pc[..., :3], prop_a * desk_full)

    # ---- arms: writing (from the original) and thinking (drawn onto rm_arm) ----
    layers["arm_write"] = (rgb, soften(m_write, 0.7) * alpha)
    layers["arm_think"] = (think, soften(m_think, 0.7) * (1.0 - keyed_alpha_of(think)))
    wj, tj = cfg["write_joints"], cfg["think_joints"]
    skins["arm_write"] = {"type": "chain", "blend": 14, "joints": [["chest", wj[0]], ["armW", wj[1]], ["handW", wj[2]]]}
    skins["arm_think"] = {"type": "chain", "blend": 14, "joints": [["chest", tj[0]], ["foreT", tj[1]], ["handT", tj[2]]]}

    masks = {}
    head_rgb, eyes = add_eyes("work", rgb, alpha, hair, head_hard, nd_rgb, cfg["bangs_box"], cfg["eyes_box"],
                              bones, skins, layers, masks)
    layers["head"] = (head_rgb, head * np.where(m_dang > 0, nd_alpha, 1.0))
    layers["ribbon"] = (rgb, soften(m_rib) * alpha)

    for name in WORK_LAYERS:
        entry = {"name": name, "skin": name}
        if name in ("stool", "desk"):
            entry["prop"] = True
        if name in ("stool", "desk_whole"):
            entry["propView"] = True  # drawn while the furniture moves without her
        if name == "desk_whole":
            entry["propOnly"] = True
        if name == "arm_write":
            entry.update(variant="write", group="armW")
        if name == "arm_think":
            entry.update(variant="think", group="armW")
        order.append(entry)
    head_at = WORK_LAYERS.index("head")
    order[head_at + 1:head_at + 1] = eyes  # irises and bangs right over the head; earrings after
    head_at += len(eyes)
    for k, m in enumerate(sorted(earrings, key=lambda m: np.where(m)[1].mean())):
        e = f"earring_{k}"
        bones[e] = {"parent": "head", "pivot": top_pivot(m), "physics": spring(EARRING_SPRING, seed=2.3 + 1.9 * k)}
        skins[e] = {"type": "rigid", "bone": e}
        order.insert(head_at + 1 + k, {"name": e, "skin": e})
        layers[e] = (rgb, soften(m) * alpha)
        print(f"  {e}: pivot {bones[e]['pivot']}")

    for mname, (mrgb, ma) in masks.items():
        write_rgba(out_dir / f"{mname}.png", np.dstack([mrgb, np.clip(ma, 0, 1) * 255.0]))
    finish(out_dir, layers, order, rgb, alpha, {
        "kind": "work", "bones": bones, "skins": skins, "layers": order, "faceAfter": "iris_r", "masks": list(masks),
    }, show=("write",))


def keyed_alpha_of(img):
    """Background (0..1) of a chroma-green render."""
    return 1.0 - keyed_rgba(img)[..., 3] / 255.0


def main():
    which = sys.argv[1:] or ["stand", *POSES, "work"]
    if "stand" in which:
        print("stand")
        build_stand()
    for name in POSES:
        if name in which:
            print(name)
            build_pose(name)
    if "work" in which:
        print("work")
        build_work()


if __name__ == "__main__":
    main()
