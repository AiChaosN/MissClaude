#!/usr/bin/env python3
"""Downscale art/work sprites into app/assets with a manifest the renderer reads.

Every pose is normalised so the head is the same size as in idle (found by
multi-scale template matching of the idle face), then trimmed. Anchors:
  head  head centre; used to place the sprite while dragged
  foot  ground contact point, directly under the head centre
Pixel-aligned groups share one trim box so face patches line up on all of them.
Each sprite also gets a "sway" map: how far each pixel may move when the hair
sways (0 on body and face, rising toward the hair tips).
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from matting import read_rgba, write_rgba  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "art/work"
OUT = ROOT / "app/assets"
EXPORT_SCALE = 0.5

# idle face used as the template for scale/position matching (source px)
HEAD_BOX = (420, 170, 800, 500)

# groups of pixel-aligned sprites: the first one is the reference for matching
GROUPS = {
    "idle": ["idle", "wave_a", "wave_b", "think"],
    "walk": ["walk"],
    "cheer": ["cheer"],
    "drag": ["drag"],
    "sit": ["sit_read"],
    "work": ["work"],
}
# face patch sets: which sprites they apply to and where the patches come from
FACE_SETS = {
    "idle": {"group": "idle", "patches": WORK / "face"},
    "sit": {"group": "sit", "patches": WORK / "face_sit"},
    "walk": {"group": "walk", "patches": WORK / "face_walk"},
    "desk": {"group": "work", "patches": WORK / "face_desk"},
}
# Template matching reads a three-quarter view as a narrower, i.e. smaller, head;
# walk was drawn at the idle scale (eye sizes match), so pin it.
SCALE_OVERRIDE = {"walk": 1.0}
SWAY = {  # amplitude multiplier per group (sitting hair lies on the floor)
    "idle": 1.0, "walk": 1.0, "cheer": 1.0, "drag": 1.2, "sit": 0.45, "work": 0.5,
}


def gray_on(rgba, v=128.0):
    a = rgba[..., 3:4] / 255.0
    c = rgba[..., :3] * a + v * (1 - a)
    return cv2.cvtColor(np.clip(c, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)


def match_head(template, rgba):
    img = gray_on(rgba)
    best = (-1.0, 1.0, (0, 0), (0, 0))
    for s in np.arange(0.70, 1.36, 0.01):
        t = cv2.resize(template, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        r = cv2.matchTemplate(img, t, cv2.TM_CCOEFF_NORMED)
        _, mv, _, loc = cv2.minMaxLoc(r)
        if mv > best[0]:
            best = (mv, float(s), loc, t.shape)
    score, s, (x, y), (h, w) = best
    return score, s, (x + w / 2.0, y + h / 2.0)


def premul_resize(rgba, f):
    a = rgba[..., 3:4] / 255.0
    pm = np.dstack([rgba[..., :3] * a, rgba[..., 3:4]])
    h, w = rgba.shape[:2]
    size = (max(1, round(w * f)), max(1, round(h * f)))
    pm = cv2.resize(pm, size, interpolation=cv2.INTER_AREA)
    a = pm[..., 3:4] / 255.0
    rgb = pm[..., :3] / np.maximum(a, 1e-4)
    return np.dstack([np.clip(rgb, 0, 255), pm[..., 3:4]])


def sway_map(rgba, head, ground_y):
    """0..1 weight of how much each pixel follows the hair sway."""
    rgb8 = np.clip(rgba[..., :3], 0, 255).astype(np.uint8)
    hsv = cv2.cvtColor(rgb8, cv2.COLOR_RGB2HSV)
    hue, sat, val = hsv[..., 0] * 2.0, hsv[..., 1] / 255.0, hsv[..., 2] / 255.0
    alpha = rgba[..., 3] / 255.0
    orange = (hue >= 4) & (hue <= 38) & (sat > 0.40) & (val > 0.45) & (alpha > 0.5)
    m = cv2.morphologyEx(orange.astype(np.uint8), cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    # hair = the big orange masses that reach the outer left/right edge of the figure
    ys, xs = np.where(alpha > 0.5)
    left, right = xs.min(), xs.max()
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    hair = np.zeros_like(m)
    for i in range(1, n):
        x, _, w, _, area = stats[i]
        if area > 2500 and (x - left < 70 or right - (x + w) < 70):
            hair[lab == i] = 1
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    hx, hy = head
    y0, y1 = hy + 120, max(hy + 300, ground_y - 120)
    ramp = np.clip((yy - y0) / (y1 - y0), 0, 1) ** 1.3
    side = np.clip((np.abs(xx - hx) - 110) / 320, 0, 1)
    wgt = hair * ramp * (0.3 + 0.7 * side)
    # let the weight spill past the silhouette so the hair can move into empty space,
    # but keep it off the body and face
    wgt = cv2.dilate(wgt, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))
    wgt = cv2.GaussianBlur(wgt, (0, 0), 9)
    body = ((alpha > 0.5) & (hair == 0)).astype(np.float32)
    body = cv2.erode(body, np.ones((5, 5), np.uint8))
    body = cv2.GaussianBlur(body, (0, 0), 3)
    return np.clip(wgt * (1 - body), 0, 1)


RIG_CELL = 12  # mesh grid spacing in exported px


# rig name -> (art/work source dir, sprite group it is drawn in, layers the long hair must not slide off)
RIGS = {
    "stand": ("rig", "idle", ("body", "arm_down", "arm_book")),
    "walk": ("rig_walk", "walk", ("body", "arm", "leg_back", "leg_front")),
    "sit": ("rig_sit", "sit", ("body",)),
    "drag": ("rig_drag", "drag", ("body", "leg_l", "leg_r")),
    "work": ("rig_work", "work", ("body", "leg_l", "leg_r", "arm_write", "stool", "desk")),
}


def export_rig(name, xform, sprite_wh):
    """A rig's layers into its sprite group's exported pixel space + rig_<name>.json."""
    src_dir, _group, solid_layers = RIGS[name]
    src = WORK / src_dir
    if not (src / "rig_src.json").exists():
        return None
    f, x0, y0, x1, y1 = xform
    X = lambda x: round(x * f - x0, 2)  # noqa: E731
    Y = lambda y: round(y * f - y0, 2)  # noqa: E731
    D = lambda d: round(d * f, 2)  # noqa: E731
    spec = json.loads((src / "rig_src.json").read_text())
    out_dir = f"rig_{name}"
    (OUT / out_dir).mkdir(parents=True, exist_ok=True)
    layers = []
    def cut(name):
        img = premul_resize(read_rgba(src / f"{name}.png"), f)[y0:y1, x0:x1]
        ys, xs = np.where(img[..., 3] > 0.5)
        lx0, ly0 = max(xs.min() - 2, 0), max(ys.min() - 2, 0)
        lx1, ly1 = min(xs.max() + 3, img.shape[1]), min(ys.max() + 3, img.shape[0])
        write_rgba(OUT / out_dir / f"{name}.png", img[ly0:ly1, lx0:lx1])
        return {"file": f"{out_dir}/{name}.png", "x": int(lx0), "y": int(ly0), "w": int(lx1 - lx0), "h": int(ly1 - ly0)}

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
            if key in ("headY", "swingY", "waistY", "hemY", "lockY"):
                out[key] = [Y(v) for v in val]
            elif key == "cx":
                out[key] = X(val)
            elif key in ("sideX",):
                out[key] = [D(v) for v in val]
            elif key == "blend":
                out[key] = D(val)
            elif key == "joints":
                out[key] = [[b, [X(p[0]), Y(p[1])]] for b, p in val]
        skins[n] = out
    # The long hair may only swing away from the body: weight grows with the distance
    # to the body/arm silhouette, so the hair along the dress never slides and never
    # uncovers the filler painted underneath it.
    hb = next(l for l in layers if l["name"] == "hair_back")
    solid = np.zeros(read_rgba(src / "body.png").shape[:2], np.uint8)
    for part in solid_layers:
        solid |= (read_rgba(src / f"{part}.png")[..., 3] > 128).astype(np.uint8)
    dist = cv2.distanceTransform(1 - solid, cv2.DIST_L2, 5)
    sy0, sy1 = spec["skins"]["hair_back"]["swingY"]
    cols = int(np.ceil(hb["w"] / RIG_CELL)) + 1
    rows = int(np.ceil(hb["h"] / RIG_CELL)) + 1
    grid = []
    for j in range(rows):
        for i in range(cols):
            ex = hb["x"] + i / (cols - 1) * hb["w"]
            ey = hb["y"] + j / (rows - 1) * hb["h"]
            sx_, sy_ = (ex + x0) / f, (ey + y0) / f
            d = dist[int(np.clip(sy_, 0, dist.shape[0] - 1)), int(np.clip(sx_, 0, dist.shape[1] - 1))]
            ramp = np.clip((sy_ - sy0) / (sy1 - sy0), 0, 1)
            t = np.clip(d / 140.0, 0, 1)
            grid.append(round(float((t * t * (3 - 2 * t)) * ramp * ramp * (3 - 2 * ramp)), 3))
    skins["hair_back"]["swingGrid"] = {"cols": cols, "rows": rows, "data": grid}
    rig = {"kind": spec.get("kind", name), "w": sprite_wh[0], "h": sprite_wh[1], "cell": RIG_CELL,
           "bones": bones, "skins": skins, "layers": layers, "masks": masks, "faceAfter": spec["faceAfter"]}
    (OUT / f"rig_{name}.json").write_text(json.dumps(rig, indent=1))
    print(f"rig {name}: {len(layers)} layers, {len(bones)} bones")
    return f"rig_{name}.json"


def ground_of(alpha):
    rows = np.where((alpha > 128).any(axis=1))[0]
    return float(rows.max())


def main():
    (OUT / "sprites").mkdir(parents=True, exist_ok=True)
    (OUT / "faces").mkdir(parents=True, exist_ok=True)
    idle = read_rgba(WORK / "idle.png")
    template = gray_on(idle)[HEAD_BOX[1]:HEAD_BOX[3], HEAD_BOX[0]:HEAD_BOX[2]]

    manifest = {"exportScale": EXPORT_SCALE, "sprites": {}, "faces": {}}
    group_xform = {}
    for gname, names in GROUPS.items():
        srcs = {n: read_rgba(WORK / f"{n}.png") for n in names if (WORK / f"{n}.png").exists()}
        if not srcs:
            continue
        ref = srcs[names[0]]
        score, s, head = match_head(template, ref)
        s = SCALE_OVERRIDE.get(gname, s)
        f = EXPORT_SCALE / s
        ground = max(ground_of(r[..., 3]) for r in srcs.values())
        scaled = {n: premul_resize(r, f) for n, r in srcs.items()}
        union = np.maximum.reduce([sc[..., 3] for sc in scaled.values()])
        ys, xs = np.where(union > 0.5)
        pad = 4
        x0, y0 = max(xs.min() - pad, 0), max(ys.min() - pad, 0)
        x1, y1 = xs.max() + pad + 1, ys.max() + pad + 1
        group_xform[gname] = (f, x0, y0, x1, y1)
        head_e = [round(head[0] * f - x0, 1), round(head[1] * f - y0, 1)]
        foot_e = [head_e[0], round(ground * f - y0, 1)]
        sway_src = sway_map(ref, head, ground)
        sway = cv2.resize(sway_src, (round(ref.shape[1] * f), round(ref.shape[0] * f)),
                          interpolation=cv2.INTER_AREA)[y0:y1, x0:x1]
        sway_small = cv2.resize(sway, ((x1 - x0) // 2, (y1 - y0) // 2), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(OUT / "sprites" / f"{gname}_sway.png"),
                    np.clip(sway_small * 255, 0, 255).astype(np.uint8))
        for n, sc in scaled.items():
            write_rgba(OUT / "sprites" / f"{n}.png", sc[y0:y1, x0:x1])
            manifest["sprites"][n] = {
                "file": f"sprites/{n}.png", "w": int(x1 - x0), "h": int(y1 - y0),
                "head": head_e, "foot": foot_e, "group": gname,
                "sway": f"sprites/{gname}_sway.png", "swayAmp": SWAY[gname],
            }
        print(f"{gname:6s} match={score:.2f} headScale={s:.2f} size={x1 - x0}x{y1 - y0} "
              f"head={head_e} foot={foot_e}")

    for fname, spec in FACE_SETS.items():
        meta_path = spec["patches"] / "patches.json"
        if spec["group"] not in group_xform or not meta_path.exists():
            continue
        f, x0, y0, _, _ = group_xform[spec["group"]]
        canvas_hw = idle.shape[:2]
        out = {}
        for name, m in json.loads(meta_path.read_text()).items():
            patch = read_rgba(spec["patches"] / f"{name}.png")
            full = np.zeros((*canvas_hw, 4), np.float32)
            full[m["y"]:m["y"] + m["h"], m["x"]:m["x"] + m["w"]] = patch
            sc = premul_resize(full, f)
            ys, xs = np.where(sc[..., 3] > 0.5)
            px0, py0, px1, py1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
            write_rgba(OUT / "faces" / f"{fname}_{name}.png", sc[py0:py1, px0:px1])
            out[name] = {"file": f"faces/{fname}_{name}.png", "group": m["group"],
                         "x": int(px0 - x0), "y": int(py0 - y0)}
        manifest["faces"][fname] = out
        print(f"faces {fname}: {', '.join(out)}")

    manifest["rigs"] = {}
    for rig_name, (_src, group, _solid) in RIGS.items():
        if group in group_xform:
            f, x0, y0, x1, y1 = group_xform[group]
            path = export_rig(rig_name, group_xform[group], (int(x1 - x0), int(y1 - y0)))
            if path:
                manifest["rigs"][rig_name] = path

    # icons: the idle head, square crop
    head_crop = premul_resize(idle[40:600, 330:890], 256 / 560)
    a = head_crop[..., 3:4] / 255.0
    icon = Image.fromarray(np.clip(np.dstack([head_crop[..., :3], a[..., 0] * 255]), 0, 255)
                           .astype(np.uint8), "RGBA")
    icon.save(OUT / "icon.png")
    icon.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64),
                                       (128, 128), (256, 256)])
    icon.resize((32, 32), Image.LANCZOS).save(OUT / "tray.png")
    icon.resize((64, 64), Image.LANCZOS).save(OUT / "tray@2x.png")

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {OUT / 'manifest.json'}")


if __name__ == "__main__":
    main()
