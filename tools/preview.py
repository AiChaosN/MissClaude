#!/usr/bin/env python3
"""Render the pet headless (browser preview mode) and save one PNG per scenario.

    python3 tools/preview.py OUT_DIR [--size 200] [--scenarios idle,wave,...]

Serves app/ over HTTP, opens index.html?preview in Playwright's Chromium, drives
the pet through window.pet / window.petCommand and screenshots the transparent
window, composited on a light and a dark backdrop side by side.
"""
import argparse
import functools
import http.server
import threading
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent / "app"

# name -> (javascript to run, seconds to wait before the screenshot)
SCENARIOS = {
    "idle": ("pet.setState('idle'); pet.nextDecision = 1e9;", 0.6),
    "blink": ("pet.setState('idle'); pet.nextDecision = 1e9; pet.blink.phase = 0.08; pet.blink.next = 1e9;", 0.0),
    "look_left": ("pet.setState('idle'); pet.nextDecision = 1e9; pet.glance = {dir: -1, until: 1e9};", 0.3),
    "talk": ("pet.setState('idle'); pet.nextDecision = 1e9; "
             "petCommand({type: 'say', text: '今天的 query plan 跑得怎么样？', source: 'api'});", 0.45),
    "happy": ("pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'expression', name: 'happy', duration: 9});", 0.3),
    "pout": ("pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'expression', name: 'pout', duration: 9});", 0.3),
    "wave": ("petCommand({type: 'act', action: 'wave', duration: 9});", 0.5),
    "think": ("petCommand({type: 'act', action: 'think', duration: 9});", 0.4),
    "sit": ("petCommand({type: 'act', action: 'sit', duration: 99});", 0.8),
    "sleep": ("petCommand({type: 'act', action: 'sleep', duration: 99});", 2.2),
    "cheer": ("petCommand({type: 'act', action: 'cheer'});", 0.4),
    "walk": ("pet.settings.wander = false; pet.setState('walk', {target: pet.foot.x - 300});", 0.5),
    "drag": ("pet.cursor = {x: pet.foot.x, y: pet.foot.y - 150}; pet.startDrag(); "
             "pet.omega = 2.5;", 0.25),
    "rule_say": ("pet.setState('idle'); pet.nextDecision = 1e9; "
                 "petCommand({type: 'say', text: '本周额度已经用了 83% 啦，悠着点哦～', source: 'rule', "
                 "expression: 'surprised', duration: 9});", 1.8),
}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def composite(png: Path) -> None:
    im = np.asarray(Image.open(png).convert("RGBA")).astype(np.float32) / 255.0
    a = im[..., 3:4]
    # screenshots carry straight (not premultiplied) alpha
    tiles = [im[..., :3] * a + (1 - a) * np.array(bg, np.float32) / 255.0
             for bg in [(246, 241, 232), (38, 42, 50)]]
    out = np.clip(np.hstack(tiles) * 255 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(out).save(png.with_name(png.stem + "_bg.png"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=200)
    ap.add_argument("--renderer", choices=["webgl", "2d"], default="webgl")
    ap.add_argument("--scenarios", default=",".join(SCENARIOS))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(APP)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = (f"http://127.0.0.1:{server.server_port}/index.html?preview&wander=0&size={args.size}"
           f"&renderer={args.renderer}")
    width, height = round(args.size * 1.8), round(args.size * 1.75)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader",
                                          "--ignore-gpu-blocklist"])
        # the page's CSP forbids eval, which Playwright's string predicates rely on
        ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1.5,
                                  bypass_csp=True)
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        for name in args.scenarios.split(","):
            js, wait = SCENARIOS[name]
            page.goto(url)
            page.wait_for_function("window.pet !== undefined", timeout=20000)
            page.wait_for_timeout(2300)  # let the greeting wave finish
            page.evaluate("pet.speech = null; pet.speechQueue = []; "
                          "document.getElementById('bubble').hidden = true; pet.expr = null;")
            page.evaluate(js)
            page.wait_for_timeout(int(wait * 1000))
            shot = out / f"{name}.png"
            page.screenshot(path=str(shot), omit_background=True)
            composite(shot)
            print(f"{name}: state={page.evaluate('pet.state')}")
        events = page.evaluate("window.petHost ? [] : (pet.host.events || []).map(e => e.type)")
        print("events seen in last page:", events)
        if errors:
            print("ERRORS:", *errors, sep="\n  ")
        browser.close()
    server.shutdown()


if __name__ == "__main__":
    main()
