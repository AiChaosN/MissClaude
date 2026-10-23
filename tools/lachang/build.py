#!/usr/bin/env python3
"""Build the dachshund (lachang) pack's assets from art/lachang/gen.

    python3 tools/lachang/build.py            # everything that has its inputs
    python3 tools/lachang/build.py --check    # also write _rest.png composites to look at

Steps (all in the source's 1254 px space, then exported at EXPORT_SCALE):
  idle sprite   keyed from the chroma-green re-render of the reference drawing
  face patches  wherever a face edit differs from the base, cut with a soft edge
  stand rig     ears, tail and four legs from the flat-recolour edits (masks) and the
                removal edits (what is behind them); the head from a polygon; irises
                from the blank-eyed edit, clipped by the eye openings
  poses         drag / sit / sleep / beg / lie: whole keyed sprites
  manifest      sprites (head/foot anchors), faces, rigs, icons

Pipeline helpers come from the Claude tools (tools/matting.py, tools/build_rig.py).
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from matting import (bbox, change_mask, keyed_rgba, read_rgb, read_rgba, soft_region,  # noqa: E402
                     write_rgba)
from build_rig import dilate, fill_holes, largest, poly_mask, soften, telea, top_pivot  # noqa: E402
from export_assets import gray_on, match_head, premul_resize  # noqa: E402

ART = ROOT / "art/lachang"
SRC = ART / "source/dachshund_ref.png"
GEN = ART / "gen"
WORK = ART / "work"
OUT = ROOT / "app/characters/lachang/assets"
EXPORT_SCALE = 0.5
RIG_CELL = 12

# ---- geometry in source px (see the grid in the build notes) ----
# the head without the ears: skull, face and muzzle down to the chin
HEAD_POLY = [(335, 95), (380, 55), (470, 40), (560, 62), (605, 115), (612, 200), (618, 330), (575, 440),
             (510, 525), (440, 552), (355, 540), (305, 480), (288, 380), (298, 250)]
FACE_BOX = (270, 130, 660, 610)
EYES_BOX = (295, 150, 640, 370)
MOUTH_BOX = (260, 420, 530, 610)
HEAD_CENTER = (470, 300)
HEAD_TEMPLATE = (290, 150, 640, 470)  # eyes and nose: matched in the other poses
NECK = (455, 560)        # head pivot
CHEST = (560, 830)       # front torso pivot: the body bends here
HIPS = (900, 900)        # rear torso pivot
EAR_SPRING = {"k": 22, "c": 3.2, "gain": 0.9, "wind": 0.03, "windRate": 0.6, "max": 0.35, "kick": 0.6, "drag": 0.12,
              "ks": 40, "cs": 6, "gs": 0.15}
EAR_TIP_SPRING = {"k": 30, "c": 3.5, "gain": 0.6, "wind": 0.05, "windRate": 0.9, "max": 0.3, "kick": 0.5, "drag": 0.08}
TAIL_SPRING = {"k": 26, "c": 2.6, "gain": 1.0, "wind": 0.07, "windRate": 1.1, "max": 0.45, "kick": 0.8, "drag": 0.15,
               "seed": 2.3}
TAIL_TIP_SPRING = {"k": 34, "c": 3.0, "gain": 0.7, "wind": 0.1, "windRate": 1.4, "max": 0.4, "kick": 0.6, "drag": 0.1,
                   "seed": 4.1}

# face patches: edit name -> (patch names, group, box)
FACES = {
    "blink": (["blink"], "eyes", EYES_BOX),
    "eyes_half": (["half"], "eyes", EYES_BOX),
    "look_left": (["look_left"], "eyes", EYES_BOX),
    "look_right": (["look_right"], "eyes", EYES_BOX),
    "wink": (["wink"], "eyes", EYES_BOX),
    "happy": (["happy"], "face", FACE_BOX),
    "surprised": (["surprised"], "face", FACE_BOX),
    "sad": (["sad"], "face", FACE_BOX),
    "angry": (["angry"], "face", FACE_BOX),
    "smirk": (["smirk"], "face", FACE_BOX),
    "tongue": (["tongue", "mouth_tongue"], "mouth", MOUTH_BOX),  # an expression, and a mouth an action can hold
    # lip-sync: the engine asks for mouth_<vowel>; open for a/o, parted for the rest
    "mouth_open": (["mouth_a", "mouth_o"], "mouth", MOUTH_BOX),
    "mouth_half": (["mouth_e", "mouth_i", "mouth_u"], "mouth", MOUTH_BOX),
}
POSES = ["drag", "sit", "sleep", "beg", "lie"]
# where the head is in a pose when template matching is not trusted: fractions of the bbox
HEAD_FRAC = {"drag": (0.5, 0.17), "sit": (0.5, 0.2), "sleep": (0.55, 0.4), "beg": (0.5, 0.2), "lie": (0.4, 0.35)}


def flat_mask(seg, channel_hi, channels_lo, alpha):
    """Pixels recoloured to a flat primary/secondary colour: the named channel(s) high, the others low."""
    hi = np.minimum.reduce([seg[..., c] for c in channel_hi])
    lo = np.maximum.reduce([seg[..., c] for c in channels_lo])
    m = np.clip((hi - lo - 60) / 100, 0, 1) * (alpha > 0.3)
    m = (m > 0.5).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    return fill_holes(m)


def components(m, n_keep, min_area=400):
    """The n_keep largest blobs, left to right. Two parts that touch (the hind paws) are
    split at the narrowest column of the widest blob until there are enough."""
    n, lab, st, cen = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    ids = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= min_area]
    ids = sorted(ids, key=lambda i: -st[i, cv2.CC_STAT_AREA])[:n_keep]
    parts = [fill_holes((lab == i).astype(np.uint8)) for i in ids]
    while len(parts) < n_keep and parts:
        widest = parts.pop(max(range(len(parts)), key=lambda i: np.ptp(np.where(parts[i])[1])))
        cols = widest.sum(axis=0)
        xs = np.where(cols > 0)[0]
        inner = xs[int(len(xs) * 0.25):int(len(xs) * 0.75)]  # the gap is never at the edges
        cut = inner[np.argmin(cols[inner])]
        xx = np.arange(widest.shape[1])[None, :]
        parts += [widest * (xx < cut), widest * (xx >= cut)]
        print(f"  split a blob at x={cut}")
    return sorted(parts, key=lambda b: np.where(b)[1].mean())


def attach_pivot(m, side):
    """Where a part joins the body: the mean of its topmost rows ('top') or leftmost columns ('left')."""
    m = m.astype(np.uint8)
    if side == "top":
        return top_pivot(m, rows=8)
    ys, xs = np.where(m > 0)
    left = xs.min()
    return [float(left + 2), round(float(ys[xs < left + 8].mean()), 1)]


def mid_point(m, pivot, frac=0.5):
    """A point `frac` of the way from the pivot to the part's far end (for a second chain joint)."""
    ys, xs = np.where(m > 0)
    d = np.hypot(xs - pivot[0], ys - pivot[1])
    far = (xs[d.argmax()], ys[d.argmax()])
    return [round(pivot[0] + (far[0] - pivot[0]) * frac, 1), round(pivot[1] + (far[1] - pivot[1]) * frac, 1)]


# ---------------- idle sprite and faces ----------------

def build_idle():
    green = read_rgb(GEN / "base_green.png")
    idle = keyed_rgba(green)
    write_rgba(WORK / "idle.png", idle)
    print(f"idle: {(idle[..., 3] > 128).sum()} px, bbox {bbox(idle[..., 3])}")
    return idle, green


def build_faces(idle, green):
    out_dir = WORK / "face"
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {}
    for src, (names, group, box) in FACES.items():
        path = GEN / f"{src}.png"
        if not path.exists():
            print(f"  skip face {src}: missing")
            continue
        edit = read_rgb(path)
        # the painterly fur re-renders with ~25/255 of stroke noise: only clear changes count
        m = change_mask(edit, green, thr=45 if group in ("eyes", "mouth") else 38, box=box, min_area=150)
        if group == "face":  # one region over the brows, eyes, muzzle and mouth
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
            m = fill_holes(m)
        if group == "eyes":  # never let an eye patch touch the mouth
            x0, y0, x1, y1 = MOUTH_BOX
            m[y0:y1, x0:x1] = 0
        if not m.any():
            print(f"  face {src}: no change found")
            continue
        w = soft_region(m, grow=6, feather=7)
        x0, y0, x1, y1 = box
        clip = np.zeros_like(w)
        clip[y0:y1, x0:x1] = 1
        keyed = keyed_rgba(edit)
        # inside the edit's own silhouette (an open jaw may reach past the base's chin)
        w *= clip * np.maximum(keyed[..., 3], idle[..., 3]) / 255.0
        a = w * np.where(keyed[..., 3] > idle[..., 3], keyed[..., 3], np.maximum(keyed[..., 3], idle[..., 3] * (w > 0))) / 255.0
        bx0, by0, bx1, by1 = bbox(a * 255.0, 1.0)
        patch = np.dstack([keyed[..., :3], a * 255.0])[by0:by1, bx0:bx1]
        write_rgba(out_dir / f"{src}.png", patch)
        for name in names:
            meta[name] = {"file": src, "group": group, "x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0}
        print(f"  face {src} -> {', '.join(names)}: {group} at ({bx0},{by0}) {bx1 - bx0}x{by1 - by0}")
    (out_dir / "patches.json").write_text(json.dumps(meta, indent=2))
    return meta


# ---------------- the stand rig ----------------

def build_rig(idle, green, check=False):
    out_dir = WORK / "rig"
    out_dir.mkdir(parents=True, exist_ok=True)
    need = ["seg_ears", "rm_ears", "seg_tail", "rm_tail", "seg_legs", "rm_legs", "eyes_blank"]
    missing = [n for n in need if not (GEN / f"{n}.png").exists()]
    if missing:
        print(f"rig: waiting for {', '.join(missing)}")
        return None
    rgb, alpha = idle[..., :3], idle[..., 3] / 255.0
    H, W = alpha.shape
    ys_, xs_ = np.mgrid[0:H, 0:W]
    sil = alpha > 0.5
    seg = {n: read_rgb(GEN / f"seg_{n}.png") for n in ("ears", "tail", "legs")}
    rm = {n: keyed_rgba(read_rgb(GEN / f"rm_{n}.png")) for n in ("ears", "tail", "legs")}

    m_ears = flat_mask(seg["ears"], [0, 2], [1], alpha)     # magenta
    m_tail = flat_mask(seg["tail"], [1, 2], [0], alpha)     # cyan
    m_legs = flat_mask(seg["legs"], [2], [0, 1], alpha)     # blue
    ears = components(m_ears, 2, min_area=3000)
    legs = components(m_legs, 4, min_area=2000)
    tail = largest(m_tail)
    if len(ears) != 2 or len(legs) != 4:
        print(f"rig: found {len(ears)} ears and {len(legs)} legs (want 2 and 4)")
        return None
    # the flat recolours stop a few px inside the fur's real edge: grow every part mask
    # so the part layers carry their whole boundary (ears behind/over the head, legs and
    # tail under the body), and fill behind them a little further out
    ear_l, ear_r = (dilate(m, 5) > 0 for m in ears)
    legs = [dilate(m, 3) > 0 for m in legs]
    tail = dilate(tail, 4) > 0
    m_ears, m_legs, m_tail = ear_l | ear_r, np.logical_or.reduce(legs), tail
    leg_names = ["leg_fl", "leg_fr", "leg_bl", "leg_br"]

    bones = {
        "root": {"pivot": [645.0, 1205.0]},
        "body": {"parent": "root", "pivot": list(map(float, HIPS))},
        "chest": {"parent": "body", "pivot": list(map(float, CHEST))},
        "head": {"parent": "chest", "pivot": list(map(float, NECK))},
    }
    skins = {"head": {"type": "rigid", "bone": "head"},
             "body": {"type": "spine", "x0": 520.0, "x1": 880.0, "neckY": [530.0, 620.0], "neckX": 640.0}}
    layers = {}
    masks = {}

    # ears and tail: two-bone chains hanging from where they join, both springs
    def chain_part(name, m, bone, parent, side, spring, tip_spring, seed):
        pivot = attach_pivot(m, side)
        mid = mid_point(m, pivot, 0.5)
        bones[bone] = {"parent": parent, "pivot": pivot, "physics": {**spring, "seed": seed}}
        bones[bone + "1"] = {"parent": bone, "pivot": mid, "physics": {**tip_spring, "seed": seed + 1.3}}
        skins[name] = {"type": "chain", "blend": 40.0, "joints": [[bone, pivot], [bone + "1", mid]]}
        print(f"  {name}: pivot {pivot} mid {mid} ({int(m.sum())} px)")
        return pivot

    chain_part("ear_l", ears[0], "earL", "head", "top", EAR_SPRING, EAR_TIP_SPRING, 1.1)
    chain_part("ear_r", ears[1], "earR", "head", "top", EAR_SPRING, EAR_TIP_SPRING, 3.7)
    chain_part("tail", largest(m_tail), "tail", "body", "left", TAIL_SPRING, TAIL_TIP_SPRING, 2.3)
    head_hard = poly_mask((H, W), HEAD_POLY)

    # Parts hidden behind the head need pixels there too: when the head turns and the
    # ear lags behind it, the ear's hidden root comes into view. Inpaint fur into the
    # band under the head polygon (invisible at rest).
    def pad_under_head(lrgb, la, source, reach, below=0):
        zone = (dilate(source, reach) > 0) & (head_hard > 0) & sil & ~(la > 0.5) & (ys_ >= below)
        return telea(lrgb, la, zone), np.where(zone, 1.0, la)

    # the part layers keep the sprite's own pixels; soft edges
    layers["ear_l"] = (rgb, soften(ear_l) * alpha)
    layers["ear_r"] = pad_under_head(rgb, soften(ear_r) * alpha, ear_r, 110)
    layers["tail"] = (rgb, soften(tail) * alpha)

    # legs: rigid bones at the shoulders / hips, each layer continued upward under the
    # body so a lifted body never shows its cut top
    for name, m in zip(leg_names, legs):
        top = np.where(m.any(axis=1))[0].min()
        cx = float(np.where(m[top + 6])[0].mean())
        bone = "leg" + name[-2:].upper()
        parent = "chest" if name[-2] == "f" else "body"
        bones[bone] = {"parent": parent, "pivot": [cx, float(top - 30)]}
        skins[name] = {"type": "rigid", "bone": bone}
        up = np.zeros_like(m)
        for k in range(1, 61):
            up[:-k] |= m[k:]
        ext = (up > 0) & (m == 0) & (ys_ < top + 30) & sil
        leg_alpha = soften(m) * alpha
        layers[name] = (telea(rgb, leg_alpha, ext), np.where(ext, 1.0, leg_alpha))
        print(f"  {name}: pivot {bones[bone]['pivot']}")

    # body: the legless, tailless, earless redraws where those parts were, the sprite elsewhere
    b_rgb, b_alpha = rgb.copy(), alpha.copy()
    for part_mask, fill in ((m_legs, rm["legs"]), (m_tail, rm["tail"]), (m_ears, rm["ears"])):
        zone = dilate(part_mask, 8) > 0
        b_rgb = np.where(zone[..., None], fill[..., :3], b_rgb)
        b_alpha = np.where(zone, fill[..., 3] / 255.0, b_alpha)
    head_soft = soften(head_hard, 3.0)
    # ... and a neck continuing up under the chin, for when the head lifts
    layers["body"] = pad_under_head(b_rgb, b_alpha * (1 - head_soft), (b_alpha * (1 - head_soft)) > 0.5, 70, below=400)
    # head: the polygon, with the earless redraw under the ears
    h_rgb = np.where((dilate(m_ears, 8) > 0)[..., None], rm["ears"][..., :3], rgb)
    h_alpha = np.where(dilate(m_ears, 8) > 0, rm["ears"][..., 3] / 255.0, alpha)
    layers["head"] = (h_rgb, head_soft * h_alpha)

    # irises: what the blank-eyed edit took away, clipped by the eye openings it left
    e_eyes = keyed_rgba(read_rgb(GEN / "eyes_blank.png"))[..., :3]
    inside = sil & (head_hard > 0)
    white = (e_eyes.min(axis=2) > 215) & ((e_eyes.max(axis=2) - e_eyes.min(axis=2)) < 30) & inside
    changed = change_mask(e_eyes, rgb, thr=40, box=EYES_BOX, min_area=200, blur=1.2)
    wn, wlab, _, _ = cv2.connectedComponentsWithStats(white.astype(np.uint8), 8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(changed, 8)
    seeds = sorted(sorted(range(1, n), key=lambda i: -st[i, cv2.CC_STAT_AREA])[:2], key=lambda i: cen[i][0])
    eye_entries = []
    head_rgb = layers["head"][0].copy()
    for side, i in zip(("l", "r"), seeds):
        hits = np.bincount(wlab[dilate(lab == i, 3) > 0], minlength=wn)
        hits[0] = 0
        opening = fill_holes((wlab == np.argmax(hits)).astype(np.uint8))
        iris = fill_holes(largest(((lab == i) & (opening > 0)).astype(np.uint8)))
        head_rgb = np.where(((dilate(iris, 2) > 0) & (opening > 0))[..., None], e_eyes, head_rgb)
        iris_layer = ((dilate(iris, 4) > 0) & (opening > 0)).astype(np.uint8)
        layers[f"iris_{side}"] = (rgb, soften(iris_layer, 0.8) * (opening > 0))
        masks[f"eye_open_{side}"] = (np.full_like(rgb, 255.0), soften(opening, 0.5))
        oy, ox = np.where(opening > 0)
        iy, ix = np.where(iris > 0)
        bone = f"eye{side.upper()}"
        bones[bone] = {"parent": "head", "pivot": [round(float(ix.mean()), 1), round(float(iy.mean()), 1)]}
        skins[f"iris_{side}"] = {"type": "rigid", "bone": bone}
        rng = [round(0.16 * (ox.max() - ox.min()), 1), round(0.12 * (oy.max() - oy.min()), 1)]
        eye_entries.append({"name": f"iris_{side}", "skin": f"iris_{side}", "type": "iris", "clip": f"eye_open_{side}",
                            "range": rng})
        print(f"  eye {side}: opening x {ox.min()}-{ox.max()} y {oy.min()}-{oy.max()}, iris {int(iris.sum())} px, range {rng}")
    layers["head"] = (head_rgb, layers["head"][1])

    order = ([{"name": "tail", "skin": "tail"}]
             + [{"name": n, "skin": n} for n in ("leg_br", "leg_bl", "leg_fr", "leg_fl")]
             + [{"name": "body", "skin": "body"}, {"name": "ear_r", "skin": "ear_r"}, {"name": "head", "skin": "head"}]
             + eye_entries + [{"name": "ear_l", "skin": "ear_l"}])
    for mname, (mrgb, ma) in masks.items():
        write_rgba(out_dir / f"{mname}.png", np.dstack([mrgb, np.clip(ma, 0, 1) * 255.0]))
    for name, (lrgb, la) in layers.items():
        write_rgba(out_dir / f"{name}.png", np.dstack([lrgb, np.clip(la, 0, 1) * 255.0]))
    spec = {"kind": "stand", "bones": bones, "skins": skins, "layers": order, "faceAfter": "iris_r", "masks": list(masks)}
    (out_dir / "rig_src.json").write_text(json.dumps(spec, indent=1))
    # rest pose check
    comp = np.zeros((H, W, 3), np.float32)
    acc = np.zeros((H, W), np.float32)
    for layer in order:
        lrgb, la = layers[layer["name"]]
        comp = comp * (1 - la[..., None]) + lrgb * la[..., None]
        acc = acc * (1 - la) + la
    diff = np.abs(comp - rgb * alpha[..., None]).max(axis=2)
    print(f"rest pose vs sprite: mean |diff| {diff[sil].mean():.2f}, 99th pct {np.percentile(diff[sil], 99):.1f}, "
          f"coverage holes {(sil & (acc < 0.5)).sum()} px")
    if check:
        write_rgba(out_dir / "_rest.png", np.dstack([comp, acc * 255.0]))
    return spec


# ---------------- export ----------------

def export_rig(spec, xform, sprite_wh):
    src = WORK / "rig"
    f, x0, y0, x1, y1 = xform
    X = lambda x: round(x * f - x0, 2)  # noqa: E731
    Y = lambda y: round(y * f - y0, 2)  # noqa: E731
    D = lambda d: round(d * f, 2)  # noqa: E731
    out_dir = "rig_stand"
    (OUT / out_dir).mkdir(parents=True, exist_ok=True)

    def cut(name):
        img = premul_resize(read_rgba(src / f"{name}.png"), f)[y0:y1, x0:x1]
        ys, xs = np.where(img[..., 3] > 0.5)
        lx0, ly0 = max(xs.min() - 2, 0), max(ys.min() - 2, 0)
        lx1, ly1 = min(xs.max() + 3, img.shape[1]), min(ys.max() + 3, img.shape[0])
        write_rgba(OUT / out_dir / f"{name}.png", img[ly0:ly1, lx0:lx1])
        return {"file": f"{out_dir}/{name}.png", "x": int(lx0), "y": int(ly0), "w": int(lx1 - lx0), "h": int(ly1 - ly0)}

    layers = []
    for layer in spec["layers"]:
        entry = {**layer, **cut(layer["name"])}
        if "range" in layer:
            entry["range"] = [D(v) for v in layer["range"]]
        layers.append(entry)
    masks = {m: cut(m) for m in spec.get("masks", [])}
    bones = {n: {**b, "pivot": [X(b["pivot"][0]), Y(b["pivot"][1])]} for n, b in spec["bones"].items()}
    skins = {}
    for n, sk in spec["skins"].items():
        out = dict(sk)
        for key, val in sk.items():
            if key in ("neckY",):
                out[key] = [Y(v) for v in val]
            elif key in ("x0", "x1", "neckX"):
                out[key] = X(val)
            elif key == "blend":
                out[key] = D(val)
            elif key == "joints":
                out[key] = [[b, [X(p[0]), Y(p[1])]] for b, p in val]
        skins[n] = out
    rig = {"kind": spec["kind"], "w": sprite_wh[0], "h": sprite_wh[1], "cell": RIG_CELL,
           "bones": bones, "skins": skins, "layers": layers, "masks": masks, "faceAfter": spec["faceAfter"]}
    (OUT / "rig_stand.json").write_text(json.dumps(rig, indent=1))
    print(f"rig stand: {len(layers)} layers, {len(bones)} bones")
    return "rig_stand.json"


def export(idle, faces, spec):
    (OUT / "sprites").mkdir(parents=True, exist_ok=True)
    (OUT / "faces").mkdir(parents=True, exist_ok=True)
    f = EXPORT_SCALE
    manifest = {"exportScale": f, "sprites": {}, "faces": {}, "rigs": {}}
    template = gray_on(idle)[HEAD_TEMPLATE[1]:HEAD_TEMPLATE[3], HEAD_TEMPLATE[0]:HEAD_TEMPLATE[2]]
    sprites = {"idle": (idle, HEAD_CENTER)}
    for pose in POSES:
        path = WORK / f"{pose}.png"
        if not path.exists():
            continue
        rgba = read_rgba(path)
        score, s, head = match_head(template, rgba)
        bx0, by0, bx1, by1 = bbox(rgba[..., 3])
        if score < 0.45:
            fx, fy = HEAD_FRAC[pose]
            head = (bx0 + fx * (bx1 - bx0), by0 + fy * (by1 - by0))
        print(f"{pose}: head match {score:.2f} scale {s:.2f} -> head {tuple(round(v) for v in head)}")
        sprites[pose] = (rgba, head)

    xforms = {}
    for name, (rgba, head) in sprites.items():
        sc = premul_resize(rgba, f)
        ys, xs = np.where(sc[..., 3] > 0.5)
        pad = 6
        x0, y0 = max(xs.min() - pad, 0), max(ys.min() - pad, 0)
        x1, y1 = xs.max() + pad + 1, ys.max() + pad + 1
        xforms[name] = (f, x0, y0, x1, y1)
        ground = float(np.where((rgba[..., 3] > 128).any(axis=1))[0].max())
        head_e = [round(head[0] * f - x0, 1), round(head[1] * f - y0, 1)]
        foot_e = [round((x1 - x0) / 2, 1), round(ground * f - y0, 1)]
        write_rgba(OUT / "sprites" / f"{name}.png", sc[y0:y1, x0:x1])
        # no shader sway on a dog: the ears and tail are rig springs
        zero = np.zeros(((y1 - y0) // 2, (x1 - x0) // 2), np.uint8)
        cv2.imwrite(str(OUT / "sprites" / f"{name}_sway.png"), zero)
        entry = {"file": f"sprites/{name}.png", "w": int(x1 - x0), "h": int(y1 - y0), "head": head_e, "foot": foot_e,
                 "group": name, "sway": f"sprites/{name}_sway.png", "swayAmp": 0.0}
        manifest["sprites"][name] = entry
        print(f"{name:6s} size={x1 - x0}x{y1 - y0} head={head_e} foot={foot_e}")
    # walking uses the standing art (the stand rig trots)
    manifest["sprites"]["walk"] = {**manifest["sprites"]["idle"], "group": "walk"}

    f_, x0, y0, _, _ = xforms["idle"]
    out = {}
    canvas_hw = idle.shape[:2]
    for name, m in faces.items():
        patch = read_rgba(WORK / "face" / f"{m['file']}.png")
        full = np.zeros((*canvas_hw, 4), np.float32)
        full[m["y"]:m["y"] + m["h"], m["x"]:m["x"] + m["w"]] = patch
        sc = premul_resize(full, f_)
        ys, xs = np.where(sc[..., 3] > 0.5)
        px0, py0, px1, py1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        write_rgba(OUT / "faces" / f"idle_{m['file']}.png", sc[py0:py1, px0:px1])
        out[name] = {"file": f"faces/idle_{m['file']}.png", "group": m["group"], "x": int(px0 - x0), "y": int(py0 - y0)}
    manifest["faces"]["idle"] = out
    print(f"faces idle: {', '.join(out)}")

    if spec is not None:
        xf = xforms["idle"]
        manifest["rigs"]["stand"] = export_rig(spec, xf, (int(xf[3] - xf[1]), int(xf[4] - xf[2])))

    # icons: the face, square crop
    crop = premul_resize(idle[60:560, 220:720], 256 / 500)
    a = crop[..., 3:4] / 255.0
    icon = Image.fromarray(np.clip(np.dstack([crop[..., :3], a[..., 0] * 255]), 0, 255).astype(np.uint8), "RGBA")
    icon.save(OUT / "icon.png")
    icon.resize((32, 32), Image.LANCZOS).save(OUT / "tray.png")
    icon.resize((64, 64), Image.LANCZOS).save(OUT / "tray@2x.png")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {OUT / 'manifest.json'}")


def build_poses():
    for pose in POSES:
        path = GEN / f"{pose}.png"
        if not path.exists():
            print(f"  skip pose {pose}: missing")
            continue
        rgba = keyed_rgba(read_rgb(path))
        write_rgba(WORK / f"{pose}.png", rgba)
        print(f"  pose {pose}: {(rgba[..., 3] > 128).sum()} px, bbox {bbox(rgba[..., 3])}")


def main():
    check = "--check" in sys.argv
    WORK.mkdir(parents=True, exist_ok=True)
    idle, green = build_idle()
    faces = build_faces(idle, green)
    spec = build_rig(idle, green, check)
    build_poses()
    export(idle, faces, spec)


if __name__ == "__main__":
    main()
