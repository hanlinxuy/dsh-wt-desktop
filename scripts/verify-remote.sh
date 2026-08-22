#!/usr/bin/env bash
# verify-remote.sh — health + smoke for the dshssh exec-server on a target.
# Usage: scripts/verify-remote.sh [HOST]
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST="${1:-$DEFAULT_HOST}"
NODE_BIN="$(resolve_node_bin "$HOST")"
[ -n "$NODE_BIN" ] || dshssh_fail "node not found on $HOST"

dshssh_log "== service status ($HOST) =="
remote_sh "$HOST" "systemctl --user status dshssh-exec-server.service --no-pager | head -8" || true

dshssh_log "== listening port =="
remote_sh "$HOST" "ss -tlnp 2>/dev/null | grep ':$EXEC_PORT_REMOTE ' || netstat -tlnp 2>/dev/null | grep ':$EXEC_PORT_REMOTE ' || echo 'port $EXEC_PORT_REMOTE not found listening'" || true

dshssh_log "== remote-side protocol smoke (direct loopback) =="
remote_sh "$HOST" "cd \$HOME/$REMOTE_BASE && $NODE_BIN scripts/smoke-exec.mjs \
  --url ws://127.0.0.1:$EXEC_PORT_REMOTE --cwd /tmp --timeout-ms 15000 -- uname -a \
  && $NODE_BIN scripts/smoke-exec.mjs \
  --url ws://127.0.0.1:$EXEC_PORT_REMOTE --cwd /tmp --fs-write /tmp/dshssh-remote-probe.txt --timeout-ms 15000 -- true" \
  || dshssh_fail "remote smoke FAILED"
dshssh_log "verify-remote: OK"
