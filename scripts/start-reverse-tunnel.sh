#!/usr/bin/env bash
# start-reverse-tunnel.sh — reverse SSH tunnel FROM the Mac TO the remote
# headless runtime. The Mac is behind NAT, so the Mac initiates the
# connection (`ssh -R`): the remote's 127.0.0.1:PORT becomes a forward back
# to the Mac's exec-server, bound ONLY to the remote's loopback.
#
# Usage (ON THE MAC): scripts/start-reverse-tunnel.sh [HOST] [PORT]
#   HOST  default homelinux2 (env DSSH_HOST)
#   PORT  default 18765 (EXEC_PORT_REVERSE)
#
# Prerequisites:
#   - start-client-exec.sh is running on the Mac (local exec-server on PORT);
#   - the remote can be reached from the Mac over SSH (key auth).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST="${1:-$DEFAULT_HOST}"
PORT="${2:-$EXEC_PORT_REVERSE}"

dshssh_log "opening reverse tunnel: ${HOST}:${PORT} -> 127.0.0.1:${PORT} (initiated from Mac)"
if command -v autossh >/dev/null 2>&1; then
  exec autossh -M 0 -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "${PORT}:127.0.0.1:${PORT}" "$HOST"
else
  exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "${PORT}:127.0.0.1:${PORT}" "$HOST"
fi
