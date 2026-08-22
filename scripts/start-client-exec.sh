#!/usr/bin/env bash
# start-client-exec.sh — run the LOCAL (Mac) self-built exec-server that the
# remote headless runtime reaches over the reverse SSH tunnel.
#
# Usage: scripts/start-client-exec.sh [PORT] [ALLOW_CWD]
#   PORT      default 18765 (EXEC_PORT_REVERSE)
#   ALLOW_CWD default $HOME/dshssh-reverse-workspace (created if absent)
#
# Topology (Mac is behind NAT — the Mac initiates the connection):
#   remote DSH/agent -> ws://127.0.0.1:18765   (on the REMOTE host)
#   -> ssh -R 18765:127.0.0.1:18765 (started FROM the Mac toward the remote)
#   -> THIS Mac exec-server -> Mac shell/filesystem
#
# Security: loopback-only + token auth + allow-cwd restricts what the remote
# agent may touch on the Mac. The token is written to
# ~/.config/dshssh/reverse-token (0600) and printed for transfer to the host.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PORT="${1:-$EXEC_PORT_REVERSE}"
ALLOW_CWD="${2:-$HOME/dshssh-reverse-workspace}"
EXEC_SERVER="$(cd "$(dirname "$0")/.." && pwd)/plugin/lib/exec-server.js"

mkdir -p "$ALLOW_CWD" "$HOME/.config/dshssh"
TOKEN_FILE="$HOME/.config/dshssh/reverse-token"
if [ ! -s "$TOKEN_FILE" ]; then
  TOKEN="$(openssl rand -hex 32)"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

dshssh_log "local exec-server: $EXEC_SERVER (port $PORT, allow-cwd $ALLOW_CWD, token-auth)"
dshssh_log "reverse token: $TOKEN  (copy to the host: ~/.config/dshssh/reverse-token, 0600)"
exec node "$EXEC_SERVER" --listen "ws://127.0.0.1:${PORT}" --token-file "$TOKEN_FILE" --allow-cwd "$ALLOW_CWD"
