#!/usr/bin/env bash
# verify-reverse.sh — verify the REVERSE path: a remote headless runtime can
# execute commands on the Mac through the reverse tunnel + Mac exec-server.
#
# Run ON THE TARGET (or `ssh TARGET 'bash -s'`), after:
#   1. start-client-exec.sh on the Mac (port 18765, token in reverse-token);
#   2. start-reverse-tunnel.sh on the Mac (ssh -R to this target);
#   3. the Mac's reverse token copied to ~/.config/dshssh/reverse-token here.
#
# Usage (on target): scripts/verify-reverse.sh
#   DSSH_REVERSE_TOKEN=xxx scripts/verify-reverse.sh   # token override
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PORT="${EXEC_PORT_REVERSE:-18765}"
NODE_BIN="$(command -v node || echo "$HOME/.local/bin/node")"
TOKEN="${DSSH_REVERSE_TOKEN:-$(cat "$HOME/.config/dshssh/reverse-token" 2>/dev/null || true)}"

dshssh_log "reverse smoke: target -> ws://127.0.0.1:${PORT} -> Mac exec-server (token: $([ -n "$TOKEN" ] && echo yes || echo NO))"
"$NODE_BIN" "$HOME/$REMOTE_BASE/scripts/smoke-exec.mjs" \
  --url "ws://127.0.0.1:${PORT}" ${TOKEN:+--token "$TOKEN"} --cwd /tmp --timeout-ms 15000 -- sw_vers \
  || dshssh_fail "reverse smoke FAILED (Mac exec-server unreachable through tunnel?)"
dshssh_log "reverse smoke: OK — the remote runtime can execute on the Mac."
