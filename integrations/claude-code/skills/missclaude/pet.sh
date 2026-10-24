#!/bin/sh
# Talk to the MissClaude desktop pet from a shell. Reads MISSCLAUDE_URL (first of a
# comma-separated list; default http://127.0.0.1:27826) and MISSCLAUDE_TOKEN, so the
# caller never has to know where the pet is or carry the token.
#
#   pet.sh state                       who and where she is (character, state, speaking)
#   pet.sh caps                        actions and expressions this character has
#   pet.sh say TEXT [EXPR] [SECONDS]   speak (expression and bubble time optional)
#   pet.sh act NAME                    an action (wave, sit, dance, bark ...)
#   pet.sh expr NAME [SECONDS]         an expression (happy, pout, angry ...)
#   pet.sh perform JSON                {"steps":[{"at":0,"action":"wave"},{"at":0.5,"say":"hi"}]}
#   pet.sh signal NAME JSON            push data for the rules
#   pet.sh rules                       the rules as JSON
#   pet.sh remind HH:MM TEXT [DATE]    an alarm the pet keeps itself (clock rule; DATE=YYYY-MM-DD for once)
#   pet.sh forget ID                   remove a rule (reminders are remind-HHMM)
#   pet.sh events [TYPES]              follow the event stream (comma-separated types)
#
# MISSCLAUDE_ALL=1 sends say/act/expr to every address in MISSCLAUDE_URL.
set -u
URLS="${MISSCLAUDE_URL:-http://127.0.0.1:27826}"
FIRST=$(printf '%s' "$URLS" | cut -d, -f1)
AUTH=""
[ -n "${MISSCLAUDE_TOKEN:-}" ] && AUTH="Authorization: Bearer ${MISSCLAUDE_TOKEN}"

json() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2])), ensure_ascii=False))' "$@"; }
call() { # METHOD PATH [BODY] [URL]
  base="${4:-$FIRST}"
  if [ -n "${3:-}" ]; then
    printf '%s' "$3" | curl -s -m 5 -X "$1" -H 'Content-Type: application/json' ${AUTH:+-H "$AUTH"} --data-binary @- "${base%/}/v1$2"
  else
    curl -s -m 5 -X "$1" ${AUTH:+-H "$AUTH"} "${base%/}/v1$2"
  fi
  echo
}
each() { # METHOD PATH BODY -> every pet when MISSCLAUDE_ALL=1
  if [ "${MISSCLAUDE_ALL:-0}" = "1" ]; then
    for u in $(printf '%s' "$URLS" | tr ',' ' '); do call "$1" "$2" "$3" "$u"; done
  else
    call "$1" "$2" "$3"
  fi
}

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  state) call GET /state ;;
  caps) call GET /capabilities ;;
  say)
    [ -n "${1:-}" ] || { echo "usage: pet.sh say TEXT [EXPR] [SECONDS]" >&2; exit 2; }
    body=$(python3 -c 'import json,sys
t, e, d = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3] if len(sys.argv) > 3 else ""
b = {"text": t, "priority": "high"}
if e: b["expression"] = e
if d: b["duration"] = float(d)
print(json.dumps(b, ensure_ascii=False))' "$1" "${2:-}" "${3:-}")
    each POST /say "$body" ;;
  act) [ -n "${1:-}" ] || { echo "usage: pet.sh act NAME" >&2; exit 2; }; each POST /act "$(json action "$1")" ;;
  expr)
    [ -n "${1:-}" ] || { echo "usage: pet.sh expr NAME [SECONDS]" >&2; exit 2; }
    each POST /expression "$(python3 -c 'import json,sys; b={"name": sys.argv[1]}
if len(sys.argv) > 2 and sys.argv[2]: b["duration"] = float(sys.argv[2])
print(json.dumps(b))' "$1" "${2:-}")" ;;
  perform) [ -n "${1:-}" ] || { echo "usage: pet.sh perform JSON" >&2; exit 2; }; call POST /perform "$1" ;;
  signal) [ -n "${2:-}" ] || { echo "usage: pet.sh signal NAME JSON" >&2; exit 2; }; call POST /signal "{\"name\": \"$1\", \"value\": $2}" ;;
  rules) call GET /rules ;;
  remind)
    [ -n "${2:-}" ] || { echo "usage: pet.sh remind HH:MM TEXT [YYYY-MM-DD]" >&2; exit 2; }
    cur=$(call GET /rules)
    body=$(printf '%s' "$cur" | python3 -c 'import json,sys
at, text, date = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""
rid = "remind-" + at.replace(":", "")
rules = [r for r in json.load(sys.stdin)["rules"] if r["id"] != rid]
when = [{"path": "time", "op": "==", "value": at}]
if date: when.append({"path": "date", "op": "==", "value": date})
rules.append({"id": rid, "signal": "clock", "when": when, "say": text, "action": "raise_hand", "priority": "high", "cooldown": 3600})
print(json.dumps({"rules": rules}, ensure_ascii=False))' "$1" "$2" "${3:-}") || exit 1
    call PUT /rules "$body" ;;
  forget)
    [ -n "${1:-}" ] || { echo "usage: pet.sh forget RULE_ID" >&2; exit 2; }
    cur=$(call GET /rules)
    body=$(printf '%s' "$cur" | python3 -c 'import json,sys
rules = [r for r in json.load(sys.stdin)["rules"] if r["id"] != sys.argv[1]]
print(json.dumps({"rules": rules}, ensure_ascii=False))' "$1") || exit 1
    call PUT /rules "$body" ;;
  events) curl -s -N ${AUTH:+-H "$AUTH"} "${FIRST%/}/v1/events${1:+?types=$1}" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
