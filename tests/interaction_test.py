#!/usr/bin/env python3
"""Drive the pet with a simulated mouse in headless Chromium (preview mode) and check
that the interactions come out as the right output events and states.

    python3 tests/interaction_test.py
"""
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent / "app"
SIZE = 200


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> int:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(APP)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/index.html?preview&wander=0&size={SIZE}"
    failures = []

    def check(name, cond, detail=""):
        print(("ok   " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"])
        ctx = browser.new_context(viewport={"width": round(SIZE * 1.8), "height": round(SIZE * 1.75)},
                                  bypass_csp=True)
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_function("window.pet !== undefined")
        page.wait_for_timeout(2300)
        page.evaluate("pet.nextDecision = 1e9; pet.setState('idle'); pet.nextDecision = 1e9; pet.host.events.length = 0")

        def events():
            return page.evaluate("pet.host.events.map(e => e.type)")

        def clear():
            page.evaluate("pet.host.events.length = 0")

        # a point on her body (the dress) and on her head, in window coords
        body = page.evaluate("[pet.winFoot.x, pet.winFoot.y - 0.25 * pet.layout.petHeight]")
        head = page.evaluate("[pet.winHead.x, pet.winHead.y]")
        empty = [5, 5]
        check("hit test: body is solid", page.evaluate(f"pet.hitAt({body[0]}, {body[1]})"))
        check("hit test: corner is empty", not page.evaluate(f"pet.hitAt({empty[0]}, {empty[1]})"))

        page.mouse.click(*body)
        page.wait_for_timeout(450)
        ev = events()
        check("single click -> click event", "click" in ev, ev)
        page.wait_for_timeout(1700)
        page.evaluate("pet.setState('idle'); pet.nextDecision = 1e9")
        clear()

        page.mouse.dblclick(*body)
        page.wait_for_timeout(300)
        ev = events()
        greeted = page.evaluate("pet.state === 'wave' || (pet.state === 'act' && pet.choreo.name === 'raise_hand')")
        check("double click -> double_click + wave or raised hand", "double_click" in ev and greeted, ev)
        page.wait_for_timeout(2200)
        page.evaluate("pet.setState('idle'); pet.nextDecision = 1e9")
        clear()

        page.evaluate("pet.clicks = []")
        for _ in range(6):
            page.mouse.click(*body)
            page.wait_for_timeout(90)
        page.wait_for_timeout(300)
        ev = events()
        angry = page.evaluate("pet.state === 'act' && pet.choreo.name === 'angry'")
        check("six quick clicks -> poke, then she gets angry", "poke" in ev and angry, ev)
        page.wait_for_timeout(4300)
        page.evaluate("pet.setState('idle'); pet.nextDecision = 1e9; pet.clicks = []")
        clear()

        # drag up and to the side, then let go: she should fall back and land
        page.mouse.move(*body)
        page.mouse.down()
        for i in range(1, 11):
            page.mouse.move(body[0] + 6 * i, body[1] - 8 * i)
            page.wait_for_timeout(16)
        check("dragging -> drag state", page.evaluate("pet.state") == "drag", page.evaluate("pet.state"))
        page.mouse.up()
        page.wait_for_timeout(1200)
        ev = events()
        check("release -> drop, fall, land", all(t in ev for t in ("drag_start", "drop", "land")), ev)
        check("back on the ground", page.evaluate("Math.abs(pet.foot.y - pet.groundY()) < 1"),
              page.evaluate("[pet.foot.y, pet.groundY()]"))
        page.wait_for_timeout(600)
        page.evaluate("pet.setState('idle'); pet.nextDecision = 1e9")
        clear()

        # the work routine: in, writing at the desk, out again (API action 'work')
        page.evaluate("pet.setState('idle'); pet.nextDecision = 1e9; petCommand({type: 'act', action: 'work', duration: 3})")
        page.wait_for_timeout(5200)
        check("work: seated at the desk", page.evaluate("pet.state") == "work" and page.evaluate("pet.view.sprite") == "work",
              page.evaluate("[pet.state, pet.view.sprite]"))
        page.wait_for_timeout(6800)  # in 4.4 s + 3 s at the desk + out 3.9 s
        check("work: packed up and back to idle", page.evaluate("pet.state") == "idle" and not page.evaluate("!!pet.propsView"),
              page.evaluate("pet.state"))
        clear()
        page.evaluate("pet.setState('idle'); pet.nextDecision = 1e9")

        # stroke the head left and right
        page.mouse.move(*head)
        for i in range(14):
            page.mouse.move(head[0] + (30 if i % 2 else -30), head[1], steps=4)
        page.wait_for_timeout(200)
        ev = events()
        check("stroking the head -> pet event", "pet" in ev, ev)

        browser.close()
    server.shutdown()
    print(f"\n{'all passed' if not failures else f'{len(failures)} failed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
