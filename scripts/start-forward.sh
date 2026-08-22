#!/usr/bin/env bash
# start-forward.sh — SSH local forward to a target's codex exec-server, then
# smoke the tunnel end-to-end from this machine.
#
# Usage: scripts/start-forward.sh [HOST] [LOCAL_PORT]
#   HOST       default homelinux2
#   LOCAL_PORT default 8765 (matches remote EXEC_PORT_REMOTE)
#
# Prints: tunnel PID and CODEX_EXEC_SERVER_URL. Tunnel keeps running in the
# foreground of this terminal's job; Ctrl-C / kill the printed PID to stop.
# Set SMOKE=0 to skip the end-to-end smoke.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST="${1:-$DEFAULT_HOST}"
LOCAL_PORT="${2:-$EXEC_PORT_LOCAL}"

dshssh_log "opening forward tunnel: ${LOCAL_PORT} -> ${HOST}:${EXEC_PORT_REMOTE}"
start_tunnel "$HOST" "$LOCAL_PORT" "$EXEC_PORT_REMOTE"
PID="$TUNNEL_PID"
echo "TUNNEL_PID=$PID"
echo "export CODEX_EXEC_SERVER_URL=ws://127.0.0.1:${LOCAL_PORT}"

# Give the tunnel a moment to establish, then smoke.
sleep 2
if [ "${SMOKE:-1}" = "1" ]; then
  dshssh_log "end-to-end smoke via tunnel:"
  node "$DSHSSH_ROOT/scripts/smoke-exec.mjs" \
    --url "ws://127.0.0.1:${LOCAL_PORT}" --cwd /tmp --timeout-ms 15000 \
    --fs-write "/tmp/dshssh-forward-probe-$$.txt" -- uname -a
  dshssh_log "forward tunnel smoke OK (pid $PID)"
else
  dshssh_log "tunnel pid $PID (smoke skipped)"
fi

# Keep the tunnel alive for the caller's session.
wait "$PID"
