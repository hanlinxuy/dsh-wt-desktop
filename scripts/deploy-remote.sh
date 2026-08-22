#!/usr/bin/env bash
# deploy-remote.sh — one-shot deployment of the SELF-BUILT dshssh headless
# runtime to a target over SSH. No codex, no third-party agent: the runtime is
# plugin/lib/exec-server.js (Node, ws bundled) + an auth token + systemd unit.
#
# Usage: scripts/deploy-remote.sh [HOST]        (default: homelinux2)
#
# Steps: node preflight (bootstrap pinned node tarball when missing) ->
# rsync runtime/ + built exec-server -> generate auth token (remote 0600,
# local copy in .runtime-tokens/ — never commit) -> install systemd user unit
# dshssh-exec-server.service -> enable+restart -> verify-remote.sh.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST="${1:-$DEFAULT_HOST}"
dshssh_log "deploying self-built dshssh runtime to $HOST"

# --- 1) node preflight / bootstrap -----------------------------------------
remote_sh "$HOST" 'true' || dshssh_fail "cannot reach $HOST"
NODE_BIN="$(resolve_node_bin "$HOST")"
if [ -z "$NODE_BIN" ]; then
  dshssh_log "node missing on $HOST — bootstrapping pinned node v22.19.0"
  ARCH="$(remote_sh "$HOST" 'uname -m')"
  ARCH="${ARCH/x86_64/x64}"
  [ "$ARCH" = "aarch64" ] && ARCH="arm64"
  NODE_TARBALL="node-v22.19.0-linux-${ARCH}.tar.xz"
  if remote_sh "$HOST" 'command -v wget >/dev/null || command -v curl >/dev/null'; then
    remote_sh "$HOST" "mkdir -p \$HOME/.local && cd /tmp && \
      (command -v wget >/dev/null && wget -q https://nodejs.org/dist/v22.19.0/$NODE_TARBALL || curl -fsSLO https://nodejs.org/dist/v22.19.0/$NODE_TARBALL) && \
      tar -xJf $NODE_TARBALL -C \$HOME/.local --strip-components=1 && rm -f $NODE_TARBALL"
  else
    dshssh_log "target lacks wget/curl — downloading locally and scp'ing"
    TMP_TGZ="$(mktemp -d)/$NODE_TARBALL"
    curl -fsSLO "https://nodejs.org/dist/v22.19.0/$NODE_TARBALL" --output-dir "$(dirname "$TMP_TGZ")" 2>/dev/null \
      || curl -fsSL "https://nodejs.org/dist/v22.19.0/$NODE_TARBALL" -o "$TMP_TGZ"
    scp "${SSH_OPTS[@]}" "$TMP_TGZ" "$HOST:/tmp/$NODE_TARBALL"
    rm -rf "$(dirname "$TMP_TGZ")"
    remote_sh "$HOST" "mkdir -p \$HOME/.local && tar -xJf /tmp/$NODE_TARBALL -C \$HOME/.local --strip-components=1 && rm -f /tmp/$NODE_TARBALL"
  fi
  NODE_BIN="\$HOME/.local/bin/node"
fi
# systemd does not expand $HOME — substitute the real remote home.
REMOTE_HOME="$(remote_sh "$HOST" 'printf %s "$HOME"')"
NODE_BIN="${NODE_BIN//\$HOME/$REMOTE_HOME}"
NODE_DIR="$(dirname "$NODE_BIN")"
dshssh_log "node: $NODE_BIN"

# --- 2) sync sources ---------------------------------------------------------
remote_sh "$HOST" "mkdir -p \$HOME/$REMOTE_BASE/runtime \$HOME/$REMOTE_BASE/scripts \$HOME/workspaces/dshssh \$HOME/.config/dshssh"
rsync -az --delete "$DSHSSH_ROOT/runtime/" "$HOST:$REMOTE_BASE/runtime/"
rsync -az "$DSHSSH_ROOT/scripts/smoke-exec.mjs" "$HOST:$REMOTE_BASE/scripts/smoke-exec.mjs"
rsync -az "$DSHSSH_ROOT/plugin/lib/exec-server.js" "$HOST:$REMOTE_BASE/runtime/exec-server.js"
dshssh_log "synced runtime/ + exec-server.js -> ~/$REMOTE_BASE"

# --- 3) auth token -----------------------------------------------------------
TOKEN_DIR="$DSHSSH_ROOT/.runtime-tokens"
TOKEN_FILE_LOCAL="$TOKEN_DIR/$HOST.token"
mkdir -p "$TOKEN_DIR"
chmod 700 "$TOKEN_DIR"
if [ ! -s "$TOKEN_FILE_LOCAL" ]; then
  TOKEN="$(openssl rand -hex 32)"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE_LOCAL"
  chmod 600 "$TOKEN_FILE_LOCAL"
else
  TOKEN="$(cat "$TOKEN_FILE_LOCAL")"
fi
remote_sh "$HOST" "printf '%s\n' '$TOKEN' > \$HOME/.config/dshssh/token && chmod 600 \$HOME/.config/dshssh/token"
dshssh_log "auth token: remote ~/.config/dshssh/token + local $TOKEN_FILE_LOCAL (0600, gitignored)"

# --- 4) systemd user unit ------------------------------------------------------
REMOTE_BASE_HOME="%h/$REMOTE_BASE"
sed -e "s|__NODE_BIN__|$NODE_BIN|g" -e "s|__NODE_DIR__|$NODE_DIR|g" \
    -e "s|__REMOTE_BASE__|$REMOTE_BASE_HOME|g" -e "s|__EXEC_PORT__|$EXEC_PORT_REMOTE|g" \
    "$DSHSSH_ROOT/runtime/systemd/dshssh-exec-server.service" \
  | remote_sh "$HOST" "mkdir -p \$HOME/.config/systemd/user && cat > \$HOME/.config/systemd/user/dshssh-exec-server.service"
dshssh_log "installed dshssh-exec-server.service (port $EXEC_PORT_REMOTE, self-built runtime)"

remote_sh "$HOST" "systemctl --user daemon-reload && systemctl --user enable --now dshssh-exec-server.service && systemctl --user restart dshssh-exec-server.service"
dshssh_log "enabled + restarted dshssh-exec-server.service"

# --- 5) verify ----------------------------------------------------------------
"$DSHSSH_ROOT/scripts/verify-remote.sh" "$HOST"
dshssh_log "deploy complete: $HOST"
