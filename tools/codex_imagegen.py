#!/usr/bin/env python3
"""Generate or edit one image through the Codex CLI built-in image_gen tool.

Codex saves tool output under ~/.codex/generated_images/<thread_id>/; this
wrapper runs one non-interactive Codex turn, then copies the newest image
from that thread into OUT and writes OUT.json with the prompt and refs.

    codex_imagegen.py OUT.png PROMPT.txt [-i REF.png ...]

Reference images are passed as absolute paths: Codex rejects relative paths
inside the image tool call ("AbsolutePathBuf deserialized without a base
path"), and the turn then ends without an image. Such turns are retried.
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

GEN_ROOT = Path.home() / ".codex" / "generated_images"

AGENT_SUFFIX = (
    "\n\nInstructions for you (the agent): the input image(s) are already attached to this "
    "message (absolute paths: {paths}). Call the image generation tool exactly once with the "
    "spec above, using the attached image(s) in the roles described; if the tool needs a file "
    "path, use the absolute path(s) above, never a relative one. Do not run shell commands and "
    "do not write files. When the image has been generated, reply with the single word DONE."
)


def run_once(cmd, prompt, timeout):
    proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout)
    thread_id, messages = None, []
    for line in proc.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "thread.started":
            thread_id = ev.get("thread_id")
        item = ev.get("item") or {}
        if item.get("type") == "agent_message":
            messages.append(item.get("text", ""))
    images = []
    if thread_id and (GEN_ROOT / thread_id).is_dir():
        images = sorted((GEN_ROOT / thread_id).glob("*.png"), key=lambda p: p.stat().st_mtime)
    return thread_id, messages, images, proc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("prompt_file")
    ap.add_argument("-i", "--image", action="append", default=[])
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--retries", type=int, default=2)
    args = ap.parse_args()
    refs = [str(Path(im).resolve()) for im in args.image]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    spec = Path(args.prompt_file).read_text().strip()
    prompt = spec + AGENT_SUFFIX.format(paths=", ".join(refs) or "none")

    cmd = ["codex", "exec"]
    for im in refs:
        cmd.append(f"--image={im}")
    cmd += ["--skip-git-repo-check", "--ephemeral", "-s", "read-only",
            "-c", 'model_reasoning_effort="low"', "--json"]

    t0 = time.time()
    for attempt in range(args.retries + 1):
        thread_id, messages, images, proc = run_once(cmd, prompt, args.timeout)
        if images:
            break
        print(f"attempt {attempt + 1} produced no image for {out} (thread={thread_id}): "
              f"{' | '.join(messages)[-300:]} {proc.stderr[-400:]}", file=sys.stderr)
    else:
        print(f"FAIL {out}", file=sys.stderr)
        return 1

    shutil.copy2(images[-1], out)
    meta = {
        "prompt": spec,
        "refs": refs,
        "thread_id": thread_id,
        "source": str(images[-1]),
        "seconds": round(time.time() - t0, 1),
    }
    out.with_suffix(".json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print(f"OK {out} ({meta['seconds']}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
