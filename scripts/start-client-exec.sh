#!/usr/bin/env bash
# start-client-exec.sh — run the LOCAL (Mac) codex exec-server that the remote
# headless runtime reaches over the reverse SSH tunnel.
#
# Usage: scripts/start-client-exec.sh [PORT]   (default 18765)
#
# The reverse direction is: remote DSH/Codex -> CODEX_EXEC_SERVER_URL
# =ws://127.0.0.1:18765 -> ssh -R 18765:127.0.0.1:18765 -> THIS Mac exec-server
# -> Mac shell/filesystem.
#
# Security: run as a normal user; the server is loopback-only. The dshssh
# plugin (Phase 3/4) will gate tools behind workspace allowlists — do not rely
# on that before it exists.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PORT="${1:-$EXEC_PORT_REVERSE}"
CODEX_BIN="$(command -v codex || true)"
if [ -z "$CODEX_BIN" ]; then
  dshssh_fail "codex not found on this machine. Install it first, e.g.:
  npm install -g @openai/codex
or: brew install codex"
fi

dshssh_log "starting local exec-server: $CODEX_BIN exec-server --listen ws://127.0.0.1:${PORT}"
"$CODEX_BIN" exec-server --listen "ws://127.0.0.1:${PORT}" --concurrent-requests 4

# Optional launchd agent (macOS) — run: launchctl load ~/Library/LaunchAgents/dshssh-exec-server.plist
# with plist ProgramArguments: ["$CODEX_BIN","exec-server","--listen","ws://127.0.0.1:${PORT}","--concurrent-requests","4"]
