#!/usr/bin/env python3
"""Pixel-level regression check for the renderer.

Renders a fixed list of scenarios with Math.random seeded (so blinks, idle choices and
particles are reproducible), hashes the frames and either records them as a baseline
or compares against one:

    python3 tools/regress.py record  baseline.json [character] [webgl|2d]
    python3 tools/regress.py compare baseline.json [character] [webgl|2d]

Two runs of the same code must agree frame for frame; a refactor that changes any
pixel shows up as a named scenario/frame.
"""
import functools
import hashlib
import http.server
import io
import json
import sys
import threading
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent / "app"
SIZE = 220
# mulberry32, seeded, and a clock pinned to a fixed afternoon (the greeting depends on
# the time of day, and its length changes how much randomness the lip-sync consumes);
# installed before any script runs
SEED_JS = """
(() => { let s = 0x9E3779B9; Math.random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const RealDate = Date; const fixed = new RealDate(2026, 0, 1, 15, 0, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  }; })();
"""
# name -> (setup js, [frames to step before each capture])
SCENARIOS = {
    "idle": ("pet.setState('idle'); pet.nextDecision = 1e9;", [10, 60, 120]),
    "idle_decide": ("pet.setState('idle'); pet.nextDecision = pet.t + 0.5;", [60, 120, 240]),
    "look": ("pet.setState('idle'); pet.nextDecision = 1e9; const h = pet.headScreen(); pet.cursor = {x: h.x + 200, y: h.y - 80}; pet.updateLook();", [20]),
    "talk": ("pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'say', text: 'Hello 你好呀，今天也加油～', source: 'api'});", [15, 40, 90]),
    "expr": ("pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'expression', name: 'angry', duration: 9});", [20]),
    "wave": ("petCommand({type: 'act', action: 'wave', duration: 9});", [20, 50]),
    "think": ("petCommand({type: 'act', action: 'think', duration: 9});", [40]),
    "sit": ("petCommand({type: 'act', action: 'sit', duration: 99});", [30, 200]),
    "sleep": ("petCommand({type: 'act', action: 'sleep', duration: 99});", [60, 180]),
    "cheer": ("petCommand({type: 'act', action: 'cheer'});", [10, 30, 60]),
    "walk": ("pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x + 2000});", [20, 50]),
    "walk_left": ("pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x - 2000});", [35]),
    "drag": ("pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag(); pet.omega = 2.5;", [10, 40]),
    "fall": ("pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag(); pet.dragV = {x: 300, y: -200}; pet.release();", [10, 30, 70]),
    "work": ("petCommand({type: 'act', action: 'work', duration: 2.5});", [40, 100, 170, 300, 400, 520]),
    "act_angry": ("petCommand({type: 'act', action: 'angry'});", [20, 60, 130]),
    "act_dance": ("petCommand({type: 'act', action: 'dance'});", [30, 90]),
    "act_sneeze": ("petCommand({type: 'act', action: 'sneeze'});", [40, 75, 120]),
    "act_shy": ("petCommand({type: 'act', action: 'shy'});", [30, 110]),
    "click": ("pet.setState('idle'); pet.nextDecision = 1e9; pet.onClick(); pet.clickTimer = null; pet.reactClick();", [12, 40]),
    "poke": ("pet.setState('idle'); pet.nextDecision = 1e9; for (let i = 0; i < 5; i++) pet.onClick();", [30]),
    "hook": ("petCommand({type: 'claude_code', event: 'UserPromptSubmit', text: ''});", [30]),
}
RESET = ("pet.speech = null; pet.speechQueue = []; document.getElementById('bubble').hidden = true; pet.expr = null; "
         "pet.fx.parts = []; pet.working = false; pet.workUntil = 0; pet.cursor = null; pet.glance = null; pet.look = 0; "
         "pet.setState('idle'); pet.nextDecision = 1e9; step(5);")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def run(character=None, renderer="webgl"):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(APP)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/index.html?preview&manual&wander=0&size={SIZE}"
    if character:
        url += f"&character={character}"
    url += f"&renderer={renderer}"
    hashes = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"])
        ctx = browser.new_context(viewport={"width": round(SIZE * 1.8), "height": round(SIZE * 1.75)}, bypass_csp=True)
        ctx.add_init_script(SEED_JS)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(url)
        page.wait_for_function("window.step !== undefined", timeout=20000)
        # CSS animations run on the wall clock: freeze them so the bubble looks the same each run
        page.add_style_tag(content="* { animation: none !important; transition: none !important; }")
        page.evaluate("step(150)")
        for name, (setup, frames) in SCENARIOS.items():
            page.evaluate(RESET)
            page.evaluate(setup)
            for i, n in enumerate(frames):
                page.evaluate(f"step({n})")
                png = page.screenshot(omit_background=True)
                im = Image.open(io.BytesIO(png)).convert("RGBA")
                hashes[f"{name}/{i}"] = hashlib.sha1(im.tobytes()).hexdigest()[:16]
        browser.close()
    server.shutdown()
    if errors:
        print("renderer errors:", *errors[:5], sep="\n  ")
    return hashes


def main():
    mode, path = sys.argv[1], Path(sys.argv[2])
    character = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
    renderer = sys.argv[4] if len(sys.argv) > 4 else "webgl"
    hashes = run(character, renderer)
    if mode == "record":
        path.write_text(json.dumps(hashes, indent=1))
        print(f"recorded {len(hashes)} frames to {path}")
        return 0
    base = json.loads(path.read_text())
    bad = [k for k in base if hashes.get(k) != base[k]]
    missing = [k for k in base if k not in hashes]
    print(f"{len(base) - len(bad)}/{len(base)} frames identical")
    if bad:
        print("DIFFERENT:", ", ".join(bad))
    if missing:
        print("MISSING:", ", ".join(missing))
    return 1 if bad or missing else 0


if __name__ == "__main__":
    sys.exit(main())
