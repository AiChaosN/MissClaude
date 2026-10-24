#!/usr/bin/env python3
"""Python client for the MissClaude desktop pet API (standard library only).

    from missclaude import MissClaude
    pet = MissClaude()
    pet.say("你好～", expression="happy")
    pet.signal("claude.usage", {"percent": 83})      # rules decide what she says
    for ev in pet.events(types=["click", "pet"]):     # blocking stream of interactions
        print(ev["type"], ev["data"])

Also a small CLI:

    python missclaude.py say "hello" [--expression happy] [--priority high]
    python missclaude.py act wave
    python missclaude.py signal claude.usage '{"percent": 83}'
    python missclaude.py events [--types click,pet]
    python missclaude.py state | capabilities | rules
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Iterator

DEFAULT_URL = os.environ.get("MISSCLAUDE_URL", "http://127.0.0.1:27826")
# needed when the pet is on another machine (its settings.json: apiHost + apiToken)
DEFAULT_TOKEN = os.environ.get("MISSCLAUDE_TOKEN", "")


class MissClaudeError(RuntimeError):
    pass


class MissClaude:
    def __init__(self, base_url: str = DEFAULT_URL, timeout: float = 3.0, token: str = DEFAULT_TOKEN):
        self.base = base_url.rstrip("/") + "/v1"
        self.timeout = timeout
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    # ---- plumbing ----

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **self.headers})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except ValueError:
                pass
            raise MissClaudeError(f"{method} {path}: HTTP {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            raise MissClaudeError(f"pet not reachable at {self.base}: {e.reason}") from None

    @staticmethod
    def _clean(**kw) -> dict:
        return {k: v for k, v in kw.items() if v is not None}

    # ---- queries ----

    def health(self) -> dict:
        return self._call("GET", "/health")

    def is_running(self) -> bool:
        try:
            return bool(self.health().get("ok"))
        except MissClaudeError:
            return False

    def capabilities(self) -> dict:
        return self._call("GET", "/capabilities")

    def state(self) -> dict:
        return self._call("GET", "/state")

    # ---- inputs ----

    def say(self, text: str, *, expression: str | None = None, duration: float | None = None,
            priority: str = "normal") -> dict:
        """Show a speech bubble. priority="high" interrupts whatever she is saying."""
        return self._call("POST", "/say", self._clean(text=text, expression=expression,
                                                      duration=duration, priority=priority))

    def act(self, action: str, *, duration: float | None = None, x: float | None = None,
            dx: float | None = None) -> dict:
        """wave, cheer, think, sit, sleep, wake, walk (x= screen x or dx= offset), idle, chatter."""
        return self._call("POST", "/act", self._clean(action=action, duration=duration, x=x, dx=dx))

    def expression(self, name: str, *, duration: float | None = None) -> dict:
        """happy, surprised, pout, neutral."""
        return self._call("POST", "/expression", self._clean(name=name, duration=duration))

    def perform(self, steps: list[dict], name: str = "perform") -> dict:
        """A timed performance composed of existing building blocks:
        steps = [{"at": 0, "action": "wave"}, {"at": 1.5, "say": "...", "expression": "happy"}]"""
        return self._call("POST", "/perform", {"name": name, "steps": steps})

    def signal(self, name: str, value: Any) -> list[str]:
        """Push a data point; returns the ids of the rules it fired."""
        return self._call("POST", "/signal", {"name": name, "value": value})["fired"]

    def signals(self, values: dict[str, Any]) -> list[str]:
        """Push several signals at once: {"claude.usage": {...}, "build.status": "red"}."""
        return self._call("POST", "/signal", {"signals": values})["fired"]

    def rules(self) -> list[dict]:
        return self._call("GET", "/rules")["rules"]

    def set_rules(self, rules: list[dict]) -> dict:
        """Replace all rules (validated; also written to rules.json)."""
        return self._call("PUT", "/rules", rules)

    def reset_rules(self) -> dict:
        """Forget previous signal values and rule cooldowns."""
        return self._call("POST", "/rules/reset", {})

    # ---- outputs ----

    def recent_events(self, since: int = 0, types: list[str] | None = None) -> list[dict]:
        q = f"?since={since}" + (f"&types={','.join(types)}" if types else "")
        return self._call("GET", "/events/recent" + q)["events"]

    def events(self, types: list[str] | None = None, reconnect: bool = True) -> Iterator[dict]:
        """Yield output events as they happen (Server-Sent Events). Blocks; reconnects
        and resumes from the last seen id if the pet restarts."""
        last_id = None
        while True:
            url = self.base + "/events" + (f"?types={','.join(types)}" if types else "")
            headers = {"Accept": "text/event-stream", **self.headers}
            if last_id is not None:
                headers["Last-Event-ID"] = str(last_id)
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as resp:
                    data = []
                    for raw in resp:
                        line = raw.decode("utf-8").rstrip("\r\n")
                        if line.startswith("data: "):
                            data.append(line[6:])
                        elif not line and data:
                            ev = json.loads("\n".join(data))
                            data = []
                            last_id = ev["id"]
                            yield ev
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                if not reconnect:
                    raise
                time.sleep(2)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Talk to the MissClaude desktop pet.")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--token", default=DEFAULT_TOKEN, help="for a pet on another machine (or MISSCLAUDE_TOKEN)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("say")
    p.add_argument("text")
    p.add_argument("--expression")
    p.add_argument("--duration", type=float)
    p.add_argument("--priority", default="normal", choices=["normal", "high"])
    p = sub.add_parser("act")
    p.add_argument("action")
    p.add_argument("--duration", type=float)
    p.add_argument("--x", type=float)
    p.add_argument("--dx", type=float)
    p = sub.add_parser("expression")
    p.add_argument("name")
    p.add_argument("--duration", type=float)
    p = sub.add_parser("signal")
    p.add_argument("name")
    p.add_argument("value", help="JSON value, e.g. '{\"percent\": 83}'")
    p = sub.add_parser("perform")
    p.add_argument("steps", help='JSON list, e.g. \'[{"at":0,"action":"wave"},{"at":1.5,"say":"hi"}]\'')
    p.add_argument("--name", default="perform")
    p = sub.add_parser("events")
    p.add_argument("--types", help="comma separated, e.g. click,pet,drop")
    for name in ("state", "capabilities", "rules", "health"):
        sub.add_parser(name)
    args = ap.parse_args(argv)

    pet = MissClaude(args.url, token=args.token)
    try:
        if args.cmd == "say":
            out = pet.say(args.text, expression=args.expression, duration=args.duration, priority=args.priority)
        elif args.cmd == "act":
            out = pet.act(args.action, duration=args.duration, x=args.x, dx=args.dx)
        elif args.cmd == "expression":
            out = pet.expression(args.name, duration=args.duration)
        elif args.cmd == "signal":
            out = {"fired": pet.signal(args.name, json.loads(args.value))}
        elif args.cmd == "perform":
            out = pet.perform(json.loads(args.steps), name=args.name)
        elif args.cmd == "events":
            for ev in pet.events(types=args.types.split(",") if args.types else None):
                print(json.dumps(ev, ensure_ascii=False), flush=True)
            return 0
        else:
            out = getattr(pet, args.cmd)()
    except MissClaudeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
