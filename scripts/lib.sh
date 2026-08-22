# Shared helpers for dshssh scripts.
# Source from scripts/ with: . "$(dirname "$0")/lib.sh"

DSHSSH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Defaults (override per-invocation or via env).
DEFAULT_HOST="${DSSH_HOST:-homelinux2}"
EXEC_PORT_REMOTE="${DSSH_EXEC_PORT_REMOTE:-8765}"    # exec-server on the target
EXEC_PORT_LOCAL="${DSSH_EXEC_PORT_LOCAL:-8765}"      # local end of the forward tunnel
EXEC_PORT_REVERSE="${DSSH_EXEC_PORT_REVERSE:-18765}" # exec-server on the Mac (reverse)
REMOTE_BASE="${DSSH_REMOTE_BASE:-.local/share/dshssh}" # install base on target (~-relative)
MAC_HOST="${DSSH_MAC_HOST:-}"            # Mac address (reverse target) — required via env/arg
MAC_USER="${DSSH_MAC_USER:-}"            # Mac user (reverse target) — required via env/arg

# SSH options: never prompt, keep alive, fail fast on forward errors.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=30 -o ServerAliveCountMax=3)
[ -n "${DSSH_VERBOSE:-}" ] && SSH_OPTS+=(-v)

dshssh_log() { printf '[dshssh] %s\n' "$*" >&2; }

dshssh_fail() { dshssh_log "ERROR: $*"; exit 1; }

# remote_sh HOST 'command...' — run a command on the target.
remote_sh() {
  local host="$1"; shift
  ssh "${SSH_OPTS[@]}" "$host" "$@"
}

# resolve_codex_bin HOST — absolute path of `codex` on the target.
resolve_codex_bin() {
  local host="$1"
  remote_sh "$host" 'command -v codex 2>/dev/null || { test -x "$HOME/.local/bin/codex" && echo "$HOME/.local/bin/codex"; }' \
    | tail -1 || true
}

# resolve_node_bin HOST — absolute path of `node` on the target (for smoke runs).
resolve_node_bin() {
  local host="$1"
  remote_sh "$host" 'command -v node 2>/dev/null || { test -x "$HOME/.local/bin/node" && echo "$HOME/.local/bin/node"; }' \
    | tail -1 || true
}

# start_tunnel HOST LOCAL_PORT REMOTE_PORT [EXTRA_SSH_OPTS...] — autossh
# preferred, ssh fallback. Sets the global TUNNEL_PID; does not echo.
start_tunnel() {
  local host="$1" local_port="$2" remote_port="$3"; shift 3
  local base=(-N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L "${local_port}:127.0.0.1:${remote_port}")
  if command -v autossh >/dev/null 2>&1; then
    autossh -M 0 "${base[@]}" "$@" "$host" &
  else
    ssh "${base[@]}" "$@" "$host" &
  fi
  TUNNEL_PID=$!
}
