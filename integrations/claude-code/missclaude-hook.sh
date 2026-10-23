#!/bin/sh
# Claude Code hook -> MissClaude desktop pet.
# Forwards the hook JSON (stdin) to the pet. Silent, 1 s timeout, always exits 0,
# so Claude Code is never slowed down or blocked when the pet is not running.
curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:${MISSCLAUDE_PORT:-27826}/v1/hooks/claude-code" >/dev/null 2>&1
exit 0
