#!/bin/sh
# Claude Code hook -> MissClaude desktop pet.
#
# Forwards the hook JSON (stdin) to the pet, adding on Stop the text of Claude's
# last reply (`text`): the pet speaks it, so what you say to Claude Code gets
# answered on the desktop. Silent, 1 s timeout, always exits 0, so Claude Code is
# never slowed down or blocked when the pet is not running.
#
# Environment: MISSCLAUDE_URL (default http://127.0.0.1:27826; several pets:
# comma-separated), MISSCLAUDE_TOKEN (a pet on another machine; one token for all),
# MISSCLAUDE_PORT (older installs).
URLS="${MISSCLAUDE_URL:-http://127.0.0.1:${MISSCLAUDE_PORT:-27826}}"
AUTH=""
[ -n "${MISSCLAUDE_TOKEN:-}" ] && AUTH="Authorization: Bearer ${MISSCLAUDE_TOKEN}"

payload=$(cat)
if command -v python3 >/dev/null 2>&1; then
  # Stop / SubagentStop: the reply is `last_assistant_message` when Claude Code
  # provides it, else the last assistant turn of the transcript (JSONL)
  payload=$(printf '%s' "$payload" | python3 -c '
import json, sys
p = json.load(sys.stdin)
if p.get("hook_event_name") in ("Stop", "SubagentStop") and not p.get("text"):
    text = p.get("last_assistant_message") or ""
    path = p.get("transcript_path")
    if not text and path:
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if row.get("type") != "assistant":
                        continue
                    parts = (row.get("message") or {}).get("content") or []
                    got = "\n".join(c.get("text", "") for c in parts if isinstance(c, dict) and c.get("type") == "text").strip()
                    if got:
                        text = got
        except OSError:
            pass
    if text:
        p["text"] = text[:2000]
print(json.dumps(p, ensure_ascii=False))
' 2>/dev/null || printf '%s' "$payload")
fi

for URL in $(printf '%s' "$URLS" | tr ',' ' '); do
  printf '%s' "$payload" | curl -s -m 2 -X POST -H 'Content-Type: application/json' ${AUTH:+-H "$AUTH"} \
    --data-binary @- "${URL%/}/v1/hooks/claude-code" >/dev/null 2>&1 &
done
wait
exit 0
