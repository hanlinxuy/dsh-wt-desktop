#!/usr/bin/env bash
# verify-reverse.sh — verify the REVERSE path: a remote headless runtime can
# execute commands on the Mac through the reverse tunnel + Mac exec-server.
#
# Run ON THE TARGET (or `ssh TARGET 'bash -s'`), after:
#   1. start-client-exec.sh on the Mac (port 18765);
#   2. start-reverse-tunnel.sh on the target (ssh -R 18765:127.0.0.1:18765).
#
# Usage (on target): scripts/verify-reverse.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PORT="${EXEC_PORT_REVERSE:-18765}"
NODE_BIN="$(resolve_node_bin "$(hostname -s 2>/dev/null || echo localhost)" 2>/dev/null || command -v node || echo "$HOME/.local/bin/node")"

dshssh_log "reverse smoke: remote -> ws://127.0.0.1:${PORT} -> Mac exec-server"
"$NODE_BIN" "$HOME/$REMOTE_BASE/scripts/smoke-exec.mjs" \
  --url "ws://127.0.0.1:${PORT}" --cwd /tmp --timeout-ms 15000 -- sw_vers \
  || dshssh_fail "reverse smoke FAILED (Mac exec-server unreachable through tunnel?)"
dshssh_log "reverse smoke: OK — the remote runtime can execute on the Mac."
