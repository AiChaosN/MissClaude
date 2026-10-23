#!/usr/bin/env python3
"""Record the pet frame by frame (deterministic clock) into an animated WebP and a
contact strip, for checking motion and for showing it to people.

    python3 tools/record.py OUT_DIR SCENARIO [--seconds 3] [--fps 30] [--size 200]

Scenarios are JavaScript snippets run once before recording (see SCENES).
"""
import argparse
import functools
import http.server
import json
import threading
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent / "app"
SETTLE = "pet.speech = null; pet.speechQueue = []; document.getElementById('bubble').hidden = true; pet.expr = null;"
SCENES = {
    "idle": "pet.setState('idle'); pet.nextDecision = 1e9;",
    "wave": "petCommand({type: 'act', action: 'wave', duration: 30});",
    "think": "petCommand({type: 'act', action: 'think', duration: 30});",
    "hum": "pet.setState('idle'); pet.nextDecision = 1e9; pet.idleAct = {kind: 'hum', until: 1e9, dir: 1};",
    "peek": "pet.setState('idle'); pet.nextDecision = 1e9; pet.idleAct = {kind: 'peek', until: 1e9, dir: 1};",
    "tilt": "pet.setState('idle'); pet.nextDecision = 1e9; pet.idleAct = {kind: 'tilt', until: 1e9, dir: 1};",
    "click": "pet.setState('idle'); pet.nextDecision = 1e9; pet.reactClick = pet.reactClick; "
             "pet.setExpression('happy', 2); pet.hopAt = pet.t; pet.rig && pet.rig.kick(1.6);",
    "walk": "pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x + 2000});",
    "walk_left": "pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x - 2000});",
    "talk": "pet.setState('idle'); pet.nextDecision = 1e9; "
            "petCommand({type: 'say', text: '今天的 query plan 跑得怎么样呀？要不要我帮你看看～', source: 'api'});",
    # {"setup": js, "frame": js run before every frame with `i` = frame index}
    "eyes": {"setup": "pet.setState('idle'); pet.nextDecision = 1e9;",
             "frame": "const h = pet.headScreen(); pet.cursor = {x: h.x + 520 * Math.cos(i / 9), "
                      "y: h.y + 260 * Math.sin(i / 6)}; pet.updateLook();"},
    "lips": "pet.setState('idle'); pet.nextDecision = 1e9; "
            "petCommand({type: 'say', text: 'Hello! 我是 Claude，今天也一起加油吧～', source: 'api', duration: 9});",
    "sit": "petCommand({type: 'act', action: 'sit', duration: 99});",
    "sleep": "petCommand({type: 'act', action: 'sleep', duration: 99});",
    "drag": {"setup": "pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag();",
             "frame": "pet.cursor = {x: pet.foot.x - pet.grab.x + 7 * Math.sin(i / 3), y: pet.foot.y - pet.grab.y};"},
    "drag_still": {"setup": "pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag();",
                   "frame": "pet.cursor = {x: pet.foot.x - pet.grab.x, y: pet.foot.y - pet.grab.y}; "
                            "pet.theta = 0; pet.omega = 0;"},
    # everything new in one take: gaze, lip sync, walking legs, reading, dangling legs
    "showcase2": {
        "setup": [
            (0.0, "pet.setState('idle'); pet.nextDecision = 1e9;"),
            (2.6, "pet.cursor = null; petCommand({type: 'say', text: '眼睛会跟着你转，说话也有口型啦～', "
                  "source: 'api', duration: 1.2});"),
            (5.6, "pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x + 2000});"),
            (8.4, "pet.setState('sit', {dur: 99});"),
            (10.6, "pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag();"),
        ],
        "frame": "if (i < 62) { const h = pet.headScreen(); pet.cursor = {x: h.x + 520 * Math.cos(i / 8), "
                 "y: h.y + 240 * Math.sin(i / 5)}; pet.updateLook(); } "
                 "else if (pet.state === 'drag') { pet.cursor = {x: pet.foot.x - pet.grab.x + 9 * Math.sin(i / 3), "
                 "y: pet.foot.y - pet.grab.y}; }",
    },
    # the whole work routine: rift, furniture, hop on the stool, write/think, pack up
    "work": "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'work', duration: 2.5});",
    # the moods asked for (angry, awkward, smirk) and the work routine with a pause to think
    "showcase3": [
        (0.0, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'angry'});"),
        (4.4, "petCommand({type: 'act', action: 'awkward'});"),
        (8.2, "petCommand({type: 'act', action: 'smirk'});"),
        (11.8, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'work', duration: 4.5});"),
        (17.6, "pet.workPhase = {kind: 'think', until: pet.t + 2.4};"),
    ],
    # the polish pass: contact shadow under hops and sitting, dissolves between poses, the
    # bubble following her, the desk opening out of the light line
    "showcase4": [
        (0.0, "pet.setState('idle'); pet.nextDecision = 1e9;"),
        (1.0, "pet.hopAt = pet.t; pet.setExpression('happy', 1.2); pet.rig.kick(1.6);"),
        (2.2, "pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x + 120});"),
        (5.0, "petCommand({type: 'act', action: 'sit', duration: 99}); "
              "petCommand({type: 'say', text: '这本书好有意思…', source: 'api', duration: 1.6});"),
        (8.6, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'work', duration: 2.5});"),
    ],
    # eyes while sitting and working: reading scan, following a cursor that circles her, a
    # glance from the desk; the curved bubble tail
    "showcase5": {
        "setup": [
            (0.0, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'sit', duration: 99});"),
            (1.2, "petCommand({type: 'say', text: '这本书好有意思…', source: 'api', duration: 1.5});"),
            (6.0, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'work', duration: 5});"),
            (12.0, "pet.workPhase = {kind: 'think', until: pet.t + 2.2};"),
        ],
        "frame": "const t = i / 20; if (t > 3 && t < 6) { const h = pet.headScreen(); "
                 "pet.cursor = {x: h.x + 420 * Math.cos((t - 3) * 2.1), y: h.y - 60 + 180 * Math.sin((t - 3) * 2.1)}; } "
                 "else if (t > 10 && t < 11.8) { const h = pet.headScreen(); pet.cursor = {x: h.x - 260 + (t - 10) * 40, y: h.y - 160}; } "
                 "else pet.cursor = null;",
    },
    # a timeline: [(seconds, js), ...]
    # the dachshund pack (--character lachang): greet, trot, curious, bark, sit, play bow, pick-up
    "lachang": {
        "setup": [
            (0.0, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'wag'});"),
            (2.8, "pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x + 260});"),
            (6.2, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'tilt'});"),
            (9.2, "petCommand({type: 'act', action: 'bark'});"),
            (11.0, "petCommand({type: 'act', action: 'sit', duration: 3}); petCommand({type: 'say', text: '坐好了！', source: 'api', duration: 1.6});"),
            (14.6, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'bow'});"),
            (17.8, "pet.setState('idle'); petCommand({type: 'act', action: 'howl'});"),
            (21.0, "pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag(); pet.omega = 2.0;"),
            (23.4, "pet.dragV = {x: 200, y: -300}; pet.release();"),
        ],
        "frame": "if (pet.state === 'drag') { pet.cursor = {x: pet.foot.x - pet.grab.x + 9 * Math.sin(i / 3), "
                 "y: pet.foot.y - pet.grab.y + 4 * Math.cos(i / 5)}; }",
    },
    "showcase": [
        (0.0, "pet.setState('idle'); pet.nextDecision = 1e9;"),
        (1.6, "petCommand({type: 'act', action: 'wave', duration: 2.2}); "
              "petCommand({type: 'say', text: '你好呀～', source: 'api', duration: 1.2});"),
        (4.2, "pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'think', duration: 2.2});"),
        (6.6, "pet.setState('idle'); pet.nextDecision = 1e9; pet.idleAct = {kind: 'hum', until: pet.t + 2.6, dir: 1};"),
        (9.2, "pet.idleAct = {kind: 'peek', until: pet.t + 2, dir: 1};"),
    ],
}


def window_size(character, size):
    """The pet window's css size for a pack, as app/main.js computes it."""
    info = json.loads((APP / "characters" / character / "character.json").read_text())
    aspect = info.get("window", {}).get("aspect", [1.8, 1.75])
    return round(size * aspect[0]), round(size * aspect[1])


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("scene", help=f"one of {', '.join(SCENES)}, or act:<action name>")
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", type=int, default=200)
    ap.add_argument("--character", default="claude", help="character pack (app/characters/<name>)")
    ap.add_argument("--dpr", type=float, default=1.5)
    ap.add_argument("--crop", default="", help="x0,y0,x1,y1 in css px to crop each frame")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(APP)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = (f"http://127.0.0.1:{server.server_port}/index.html?preview&manual&wander=0&size={args.size}"
           f"&character={args.character}")
    w, h = window_size(args.character, args.size)
    frames = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"])
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=args.dpr, bypass_csp=True)
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_function("window.step !== undefined", timeout=20000)
        page.evaluate("step(150)")  # let the greeting finish
        page.evaluate(SETTLE)
        if args.scene.startswith("act:"):
            scene = (f"pet.setState('idle'); pet.nextDecision = 1e9; "
                     f"petCommand({{type: 'act', action: '{args.scene[4:]}', duration: 8}});")
        else:
            scene = SCENES[args.scene]
        frame_js = scene.get("frame") if isinstance(scene, dict) else None
        if isinstance(scene, dict):
            scene = scene["setup"]
        timeline = scene if isinstance(scene, list) else [(0.0, scene)]
        per = max(1, round(60 / args.fps))
        for i in range(int(args.seconds * args.fps)):
            now = i / args.fps
            while timeline and timeline[0][0] <= now:
                page.evaluate(timeline.pop(0)[1])
            if frame_js:
                page.evaluate(f"(() => {{ const i = {i}; {frame_js} }})()")
            page.evaluate(f"step({per})")
            png = out / f"_f{i:03d}.png"
            page.screenshot(path=str(png), omit_background=True)
            frames.append(png)
        browser.close()
    server.shutdown()

    imgs = []
    for f in frames:
        im = Image.open(f).convert("RGBA")
        if args.crop:
            x0, y0, x1, y1 = (int(float(v) * args.dpr) for v in args.crop.split(","))
            im = im.crop((x0, y0, x1, y1))
        bg = Image.new("RGBA", im.size, (250, 246, 239, 255))
        bg.alpha_composite(im)
        imgs.append(bg.convert("RGB"))
        f.unlink()
    name = args.scene.replace(":", "_")
    anim = out / f"{name}.webp"
    imgs[0].save(anim, save_all=True, append_images=imgs[1:], duration=round(1000 / args.fps), loop=0, quality=88)
    # contact strip: 8 evenly spaced frames
    picks = [imgs[int(i * (len(imgs) - 1) / 7)] for i in range(8)]
    tw, th = picks[0].size
    strip = Image.new("RGB", (tw * 8, th), (255, 255, 255))
    for i, im in enumerate(picks):
        strip.paste(im, (i * tw, 0))
    strip.save(out / f"{name}_strip.png")
    print(f"{anim} ({len(imgs)} frames)  strip: {out / (name + '_strip.png')}")


if __name__ == "__main__":
    main()
