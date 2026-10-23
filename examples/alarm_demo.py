#!/usr/bin/env python3
"""An alarm clock as a rule: nothing but data pushed into the pet.

The pet emits a "clock" signal once a minute, so a time-of-day trigger is a rule on
it. This installs one for the next full minute (keeping the existing rules), then
listens for her reactions and for you clicking her to "snooze".

    python3 examples/alarm_demo.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "clients" / "python"))
from missclaude import MissClaude  # noqa: E402


def main() -> None:
    pet = MissClaude()
    if not pet.is_running():
        sys.exit("MissClaude is not running (expected at http://127.0.0.1:27826)")
    when = (dt.datetime.now() + dt.timedelta(minutes=1)).strftime("%H:%M")
    alarm = {
        "id": "demo-alarm",
        "signal": "clock",
        "when": [{"path": "time", "op": "==", "value": when}],
        # a small performance: she raises her hand, calls out, then cheers you on
        "steps": [
            {"at": 0, "action": "raise_hand", "say": "{time} 啦！起床起床～", "priority": "high"},
            {"at": 3.2, "action": "cheer_on"},
            {"at": 3.4, "say": "新的一天，冲！"},
        ],
        "cooldown": 120,
    }
    rules = [r for r in pet.rules() if r["id"] != "demo-alarm"] + [alarm]
    pet.set_rules(rules)
    print(f"alarm set for {when}; waiting (click her to snooze) ...")
    for ev in pet.events(types=["rule_fired", "click", "perform"]):
        print(ev["type"], ev["data"])
        if ev["type"] == "click":
            pet.say("好好好，再睡五分钟…", expression="pout")
        if ev["type"] == "perform" and ev["data"].get("phase") == "end":
            break
    pet.set_rules([r for r in pet.rules() if r["id"] != "demo-alarm"])
    print("alarm rule removed")


if __name__ == "__main__":
    main()
