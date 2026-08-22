#!/usr/bin/env bash
# start-reverse-tunnel.sh — establish the reverse SSH tunnel FROM the target
# (headless runtime) BACK to the Mac's exec-server.
#
# Intended to be RUN ON THE TARGET (or via `ssh TARGET 'bash -s'`). The tunnel
# binds ONLY the target's loopback, so the Mac exec-server is never exposed to
# the target's network peers.
#
# Usage (on target): scripts/start-reverse-tunnel.sh [MAC_HOST] [MAC_USER]
#   MAC_HOST required (env DSSH_MAC_HOST or arg 1)
#   MAC_USER required (env DSSH_MAC_USER or arg 2)
#
# Prerequisites:
#   - Mac has Remote Login (sshd) enabled and reachable from the target;
#   - the target's SSH key is in the Mac's ~/.ssh/authorized_keys;
#   - Mac is running start-client-exec.sh (or launchd) on EXEC_PORT_REVERSE.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

MAC="${1:-$MAC_HOST}"
USER="${2:-$MAC_USER}"
PORT="${EXEC_PORT_REVERSE:-18765}"

dshssh_log "preflight: ssh ${USER}@${MAC}"
ssh -o BatchMode=yes -o ConnectTimeout=8 "${USER}@${MAC}" 'true' \
  || dshssh_fail "cannot reach Mac ${USER}@${MAC} (is Remote Login enabled? is our key authorized?)"

dshssh_log "opening reverse tunnel: ${MAC}:${PORT} -> 127.0.0.1:${PORT}"
if command -v autossh >/dev/null 2>&1; then
  exec autossh -M 0 -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "${PORT}:127.0.0.1:${PORT}" "${USER}@${MAC}"
else
  exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "${PORT}:127.0.0.1:${PORT}" "${USER}@${MAC}"
fi
