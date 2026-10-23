#!/usr/bin/env python3
"""Does any pose reach the edge of the pet window? The window is only a little larger
than the character, so a swinging ear, a hop or the dangling drag pose can get cut off.

    python3 tools/edgecheck.py [--character claude] [--sizes 150,220,260]

Runs a set of scenes at each size and reports the frames where opaque pixels touch the
window border (within 1 css px), with the side they touch.
"""
import argparse
import functools
import http.server
import io
import json
import threading
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent / "app"
SETTLE = ("pet.speech = null; pet.speechQueue = []; document.getElementById('bubble').hidden = true; pet.expr = null; "
          "pet.fx.parts = []; pet.setState('idle'); pet.nextDecision = 1e9; step(5);")
# scene -> (setup js, frames to run, frames between checks)
SCENES = {
    "idle": ("", 240, 12),
    "walk": ("pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x + 2000});", 120, 6),
    "walk_left": ("pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x - 2000});", 120, 6),
    "drag": ("pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag(); pet.omega = 3.0;", 150, 5),
    "fall": ("pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag(); pet.dragV = {x: 900, y: -900}; pet.release();", 120, 4),
    "click": ("pet.reactClick();", 60, 4),
}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def touches(png):
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))[..., 3]
    sides = []
    if (a[:2] > 40).any(): sides.append("top")
    if (a[-2:] > 40).any(): sides.append("bottom")
    if (a[:, :2] > 40).any(): sides.append("left")
    if (a[:, -2:] > 40).any(): sides.append("right")
    return sides


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", default="claude")
    ap.add_argument("--sizes", default="")
    args = ap.parse_args()
    info = json.loads((APP / "characters" / args.character / "character.json").read_text())
    sizes = [int(s) for s in args.sizes.split(",")] if args.sizes else list(info["sizes"].values())
    aspect = info.get("window", {}).get("aspect", [1.8, 1.75])
    library = info.get("library", [])
    scenes = dict(SCENES)
    for name in library:
        scenes[f"act:{name}"] = (f"petCommand({{type: 'act', action: '{name}'}});", 240, 6)
    for name in info.get("actions", []):
        if name not in ("idle", "walk", "wake", "chatter", "work_end"):
            scenes[f"base:{name}"] = (f"petCommand({{type: 'act', action: '{name}', duration: 3}});", 200, 8)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(APP)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"])
        for size in sizes:
            url = (f"http://127.0.0.1:{server.server_port}/index.html?preview&manual&wander=0&size={size}"
                   f"&character={args.character}")
            ctx = browser.new_context(viewport={"width": round(size * aspect[0]), "height": round(size * aspect[1])},
                                      bypass_csp=True)
            page = ctx.new_page()
            page.goto(url)
            page.wait_for_function("window.step !== undefined", timeout=20000)
            page.evaluate("step(150)")
            for name, (setup, frames, every) in scenes.items():
                page.evaluate(SETTLE)
                page.evaluate(setup)
                hit = {}
                for i in range(0, frames, every):
                    page.evaluate(f"step({every})")
                    for side in touches(page.screenshot(omit_background=True)):
                        hit.setdefault(side, i + every)
                if hit:
                    problems.append((size, name, hit))
                    print(f"size {size} {name}: touches {', '.join(f'{s} (frame {f})' for s, f in hit.items())}")
            ctx.close()
        browser.close()
    server.shutdown()
    print(f"{len(problems)} problem(s) over {len(scenes)} scenes x {len(sizes)} sizes")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
