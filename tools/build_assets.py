#!/usr/bin/env python3
"""Build the desktop-pet sprite set from art/source + art/gen into art/work/.

idle        original chibi pixels; alpha from the chroma-green render of the same image
face*/      face patches (idle, sitting), cut from aligned GPT edits by where they differ
wave_*/think  arm variants: the changed region of an aligned edit, composited onto idle
other poses keyed straight from their chroma-green renders

Run tools/export_assets.py afterwards to downscale into the app.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from matting import (bbox, change_mask, estimate_key, key_alpha, keep_main_components,  # noqa: E402
                     keyed_rgba, premul_lerp, read_rgb, read_rgba, soft_region, tri_alpha,
                     unmix, write_rgba)

ROOT = Path(__file__).resolve().parent.parent
SRC, GEN, WORK = ROOT / "art/source", ROOT / "art/gen", ROOT / "art/work"
WHITE = np.array([255.0, 255.0, 255.0])

# Face layouts in source pixels (x0, y0, x1, y1).
EYES_BOX = (440, 250, 792, 456)
MOUTH_BOX = (596, 408, 684, 484)
FACE_BOX = (440, 250, 792, 484)
LIPS_BOX = (580, 398, 705, 498)  # room for the wide-open vowel shapes
WALK_EYES_BOX = (540, 270, 940, 440)  # the far eye (3/4 view) sits at x 814-923, behind the bangs
WALK_MOUTH_BOX = (690, 400, 790, 475)
DESK_EYES_BOX = (520, 330, 750, 420)
DESK_MOUTH_BOX = (600, 415, 680, 455)
DESK_FACE_BOX = (520, 330, 750, 460)
SIT_BOOK_BOX = (330, 540, 830, 880)
CHEEKS = [((500, 458), (62, 34)), ((768, 402), (55, 36))]  # (centre, axes) of the blush on each cheek
SIT_EYES_BOX = (415, 300, 780, 500)
SIT_MOUTH_BOX = (585, 470, 640, 522)
SIT_FACE_BOX = (415, 300, 780, 522)

# face set -> (unedited source, out dir, mouth box, {name: (edit, group, region box)})
FACE_SETS = {
    "face": ("source/chibi_ref", MOUTH_BOX, {
        "blink": ("blink", "eyes", EYES_BOX),
        "half": ("eyes_half", "eyes", EYES_BOX),
        "look_left": ("look_left", "eyes", EYES_BOX),
        "look_right": ("look_right", "eyes", EYES_BOX),
        "talk": ("talk", "mouth", MOUTH_BOX),
        "happy": ("happy", "face", FACE_BOX),
        "surprised": ("surprised", "face", FACE_BOX),
        "pout": ("pout", "face", FACE_BOX),
        "look_up": ("think", "eyes", EYES_BOX),
        "wink": ("wink", "eyes", EYES_BOX),
        "blush": ("blush", "cheeks", FACE_BOX),
        "angry": ("angry", "face", FACE_BOX),
        "smirk": ("smirk", "face", FACE_BOX),
        "awkward": ("awkward", "face", FACE_BOX),
        "teary": ("teary", "face", FACE_BOX),
        **{f"mouth_{v}": (f"mouth_{v}", "mouth", LIPS_BOX) for v in "aiueo"},
    }),
    "face_walk": ("gen/walk", WALK_MOUTH_BOX, {
        "blink": ("walk_blink", "eyes", WALK_EYES_BOX),
    }),
    "face_sit": ("gen/sit_read", SIT_MOUTH_BOX, {
        "blink": ("sit_blink", "eyes", SIT_EYES_BOX),
        "sleep": ("sleep", "face", SIT_FACE_BOX),
        "page1": ("sit_page1", "book", SIT_BOOK_BOX),
        "page2": ("sit_page2", "book", SIT_BOOK_BOX),
    }),
    "face_desk": ("gen/work", DESK_MOUTH_BOX, {
        "blink": ("work_blink", "eyes", DESK_EYES_BOX),
        "think": ("work_think", "face", DESK_FACE_BOX),
        "happy": ("work_happy", "face", DESK_FACE_BOX),
    }),
}

# Arm variants: source edit, what it is compared against, where the change may be.
ARM_FRAMES = {
    "wave_a": ("wave_a", "base_green", (630, 320, 1120, 1040)),
    "think": ("think", "base_green", (440, 250, 1120, 1040)),  # eyes change too
}

POSES = ["walk", "cheer", "drag", "sit_read", "work"]


def build_idle():
    orig = read_rgb(SRC / "chibi_ref.png")
    green = read_rgb(GEN / "base_green.png")
    key = estimate_key(green)
    a = tri_alpha(orig, green, key, keep_main_components(key_alpha(green, key)))
    fg = unmix(orig, a, WHITE)
    idle = np.dstack([fg, a * 255.0])
    write_rgba(WORK / "idle.png", idle)
    return orig, green, idle


def build_face_set(out_name, base_rgba):
    """Cut patches from aligned edits wherever they differ from the unedited image."""
    ref_name, mouth_box, patches = FACE_SETS[out_name]
    ref = read_rgb(ROOT / "art" / f"{ref_name}.png")
    out_dir = WORK / out_name
    meta = {}
    for name, (src, group, box) in patches.items():
        path = GEN / f"{src}.png"
        if not path.exists():
            print(f"  skip {out_name}/{name}: {path.name} missing")
            continue
        edit = read_rgb(path)
        m = change_mask(edit, ref, thr=22, box=box, min_area=60)
        if group == "eyes":  # never let an eye patch touch the mouth
            x0, y0, x1, y1 = mouth_box
            m[y0:y1, x0:x1] = 0
        if group == "cheeks":  # only the cheeks themselves, never the eyes or mouth
            cheeks = np.zeros_like(m)
            for (cx, cy), (ax, ay) in CHEEKS:
                cv2.ellipse(cheeks, (cx, cy), (ax, ay), 0, 0, 360, 1, -1)
            m = (cheeks > 0).astype(m.dtype)
        w = soft_region(m, grow=6, feather=7)
        # stay inside the box and inside the character
        x0, y0, x1, y1 = box
        clip = np.zeros_like(w)
        clip[y0:y1, x0:x1] = 1
        w *= clip * (base_rgba[..., 3] / 255.0)
        bx0, by0, bx1, by1 = bbox(w, 0.004)
        patch = np.dstack([edit, w * 255.0])[by0:by1, bx0:bx1]
        write_rgba(out_dir / f"{name}.png", patch)
        meta[name] = {"group": group, "x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0}
        print(f"  {out_name}/{name}: {group} at ({bx0},{by0}) {bx1 - bx0}x{by1 - by0}")
    (out_dir / "patches.json").write_text(json.dumps(meta, indent=2))


def arm_frame(base_rgba, edit_img, ref_img, box):
    m = change_mask(edit_img, ref_img, thr=34, box=box, min_area=400, blur=2.0)
    w = soft_region(m, grow=8, feather=8)
    x0, y0, x1, y1 = box
    clip = np.zeros_like(w)
    clip[y0:y1, x0:x1] = 1
    return premul_lerp(base_rgba, keyed_rgba(edit_img), w * clip)


def build_arms(idle):
    frames = {}
    for name, (src, ref, box) in ARM_FRAMES.items():
        if not (GEN / f"{src}.png").exists():
            print(f"  skip {name}: missing")
            continue
        frame = arm_frame(idle, read_rgb(GEN / f"{src}.png"), read_rgb(GEN / f"{ref}.png"), box)
        write_rgba(WORK / f"{name}.png", frame)
        frames[name] = frame
        print(f"  {name}: composited")
    # wave_b differs from wave_a only at the hand: patch that onto the wave_a frame so the
    # two waving frames are identical everywhere else
    if "wave_a" in frames and (GEN / "wave_b.png").exists():
        frame = arm_frame(frames["wave_a"], read_rgb(GEN / "wave_b.png"),
                          read_rgb(GEN / "wave_a.png"), ARM_FRAMES["wave_a"][2])
        write_rgba(WORK / "wave_b.png", frame)
        print("  wave_b: composited onto wave_a")


def build_poses():
    for name in POSES:
        path = GEN / f"{name}.png"
        if not path.exists():
            print(f"  skip {name}: missing")
            continue
        write_rgba(WORK / f"{name}.png", keyed_rgba(read_rgb(path)))
        print(f"  {name}: keyed")


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    print("idle")
    _orig, _green, idle = build_idle()
    print("arm frames")
    build_arms(idle)
    print("poses")
    build_poses()
    print("face patches")
    build_face_set("face", idle)
    build_face_set("face_sit", read_rgba(WORK / "sit_read.png"))
    build_face_set("face_walk", read_rgba(WORK / "walk.png"))
    build_face_set("face_desk", read_rgba(WORK / "work.png"))


if __name__ == "__main__":
    main()
