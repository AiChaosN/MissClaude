#!/usr/bin/env python3
"""Demo of the input side: feed a fake Claude usage curve into the pet and watch the
default rules (app/core/default-rules.json) make her react at 50%, 80%, 95% and
after the reset. A real feeder only needs the same signal() call with real numbers.

    python3 examples/usage_demo.py [--step 2.0]
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "clients" / "python"))
from missclaude import MissClaude  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=float, default=2.0, help="seconds between samples")
    args = ap.parse_args()
    pet = MissClaude()
    if not pet.is_running():
        sys.exit("MissClaude is not running (expected at http://127.0.0.1:27826)")
    pet.reset_rules()  # cooldowns from an earlier run would hide the reactions
    curve = [20, 35, 48, 56, 70, 83, 90, 96, 99, 4]  # last sample: the window reset
    for minute, percent in enumerate(curve):
        fired = pet.signal("claude.usage", {"percent": percent, "remaining_minutes": 300 - 30 * minute})
        print(f"usage {percent:3d}%  ->  fired: {', '.join(fired) or '-'}")
        time.sleep(args.step)


if __name__ == "__main__":
    main()
