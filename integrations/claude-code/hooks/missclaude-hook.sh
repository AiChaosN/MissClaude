#!/bin/sh
# Claude Code hook -> MissClaude desktop pet.
#
# Forwards the hook JSON (stdin) to the pet, adding on Stop the text of Claude's
# last reply (`text`): the pet speaks it, so what you say to Claude Code gets
# answered on the desktop. Silent, 1 s timeout, always exits 0, so Claude Code is
# never slowed down or blocked when the pet is not running.
#
# On Stop the reply is first condensed by a small model into one line in the pet's
# voice (`claude -p`, a few seconds, async so Claude Code is not held up); if that
# fails the pet itself trims the raw reply to its first sentence.
#
# Environment: MISSCLAUDE_URL (default http://127.0.0.1:27826; several pets:
# comma-separated), MISSCLAUDE_TOKEN (a pet on another machine; one token for all),
# MISSCLAUDE_SUMMARY=0 to skip the model summary, MISSCLAUDE_SUMMARY_MODEL (haiku),
# MISSCLAUDE_MIRROR=0 to send nothing at all, MISSCLAUDE_PORT (older installs).
URLS="${MISSCLAUDE_URL:-http://127.0.0.1:${MISSCLAUDE_PORT:-27826}}"
AUTH=""
[ -n "${MISSCLAUDE_TOKEN:-}" ] && AUTH="Authorization: Bearer ${MISSCLAUDE_TOKEN}"
[ -n "${MISSCLAUDE_SUMMARIZING:-}" ] && exit 0  # a hook of our own summary run: ignore
[ "${MISSCLAUDE_MIRROR:-1}" = "0" ] && exit 0    # a session that speaks as her (companion/): no mirroring

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

# the pet's one-liner: what this turn did or found, in character, at most 20 characters
summarize() {
  event=$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("hook_event_name",""))' 2>/dev/null)
  [ "$event" = "Stop" ] || return 0
  [ "${MISSCLAUDE_SUMMARY:-1}" = "0" ] && return 0
  command -v claude >/dev/null 2>&1 || return 0
  reply=$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("text",""))' 2>/dev/null)
  [ "$(printf '%s' "$reply" | wc -m)" -gt 24 ] || return 0
  first=$(printf '%s' "$URLS" | cut -d, -f1)
  who=$(curl -s -m 2 ${AUTH:+-H "$AUTH"} "${first%/}/v1/capabilities" 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("character",""))' 2>/dev/null)
  if [ "$who" = "lachang" ]; then
    voice="你是一只会说话的长毛腊肠犬桌宠，活泼，句尾可以带一个'汪'。"
  else
    voice="你是桌宠 MissClaude，一个元气、亲切的少女助手。"
  fi
  summary=$(printf '%s\n\n%s\n\n%s' \
    "$voice 下面是 Claude Code 刚刚给主人的回复。请用你的口吻把它压成一句对主人说的话：说清这轮做了什么或结果如何，不超过 20 个字，中文，不加引号，不加任何别的内容，只输出这一句。" \
    "=== 回复开始 ===" "$(printf '%s' "$reply" | head -c 6000)" \
    | MISSCLAUDE_SUMMARIZING=1 timeout 40 env -u CLAUDECODE claude -p --model "${MISSCLAUDE_SUMMARY_MODEL:-haiku}" \
        --no-session-persistence --settings '{"disableAllHooks": true}' 2>/dev/null | tail -n 1 | tr -d '\r')
  n=$(printf '%s' "$summary" | wc -m)
  [ "$n" -ge 2 ] && [ "$n" -le 40 ] || return 0
  payload=$(printf '%s' "$payload" | S="$summary" python3 -c 'import json,os,sys
p = json.load(sys.stdin); p["text"] = os.environ["S"].strip(); print(json.dumps(p, ensure_ascii=False))' 2>/dev/null || printf '%s' "$payload")
}
summarize

for URL in $(printf '%s' "$URLS" | tr ',' ' '); do
  printf '%s' "$payload" | curl -s -m 2 -X POST -H 'Content-Type: application/json' ${AUTH:+-H "$AUTH"} \
    --data-binary @- "${URL%/}/v1/hooks/claude-code" >/dev/null 2>&1 &
done
wait
exit 0
