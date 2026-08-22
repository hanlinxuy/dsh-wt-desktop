#!/usr/bin/env bash
# deploy-remote.sh — one-shot deployment of the dshssh headless runtime to a
# target over SSH (Codex exec-server model, `start-codex-exec.sh` spirit).
#
# Usage: scripts/deploy-remote.sh [HOST]        (default: homelinux2)
#
# Steps: preflight -> rsync runtime sources -> merge ~/.codex/config.toml
# (backup-first, marker-guarded) -> install systemd user unit
# dshssh-exec-server.service -> enable+start -> verify-remote.sh.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST="${1:-$DEFAULT_HOST}"
dshssh_log "deploying dshssh runtime to $HOST"

# --- preflight -------------------------------------------------------------
remote_sh "$HOST" 'true' || dshssh_fail "cannot reach $HOST"
CODEX_BIN="$(resolve_codex_bin "$HOST")"
[ -n "$CODEX_BIN" ] || dshssh_fail "codex not found on $HOST (need codex >= 0.147 with exec-server subcommand)"
dshssh_log "codex: $CODEX_BIN"
remote_sh "$HOST" "$CODEX_BIN --version" | tail -1

# --- sync sources -----------------------------------------------------------
remote_sh "$HOST" "mkdir -p \$HOME/$REMOTE_BASE/runtime \$HOME/$REMOTE_BASE/scripts"
rsync -az --delete "$DSHSSH_ROOT/runtime/" "$HOST:$REMOTE_BASE/runtime/"
rsync -az "$DSHSSH_ROOT/scripts/smoke-exec.mjs" "$HOST:$REMOTE_BASE/scripts/smoke-exec.mjs"
dshssh_log "synced runtime/ + smoke-exec.mjs -> ~/$REMOTE_BASE"

# --- merge codex config (backup first, never duplicate tables) --------------
# Only appends a `# === dshssh managed ===` [projects."..."] section, so it is
# safe against existing configs that already define sandbox tables.
remote_sh "$HOST" "CONF=\$HOME/.codex/config.toml; mkdir -p \$HOME/.codex; \
if [ -f \"\$CONF\" ] && grep -q 'dshssh managed' \"\$CONF\"; then \
  echo 'codex config already managed; skipping merge'; \
else \
  [ -f \"\$CONF\" ] && cp \"\$CONF\" \"\$CONF.dshssh-bak.\$(date +%s)\" && echo \"backed up existing config\"; \
  cat >> \"\$CONF\" <<'EOF'

# === dshssh managed ===
[projects.\"\$HOME/workspaces/dshssh\"]
trust_level = \"trusted\"
EOF
  echo 'appended dshssh managed section'; \
fi"

# --- install systemd user unit ---------------------------------------------
CODEX_DIR="$(dirname "$CODEX_BIN")"
sed -e "s|__CODEX_BIN__|$CODEX_BIN|g" -e "s|__CODEX_DIR__|$CODEX_DIR|g" \
    -e "s|__EXEC_PORT__|$EXEC_PORT_REMOTE|g" \
    "$DSHSSH_ROOT/runtime/systemd/dshssh-exec-server.service" \
  | remote_sh "$HOST" "mkdir -p \$HOME/.config/systemd/user && cat > \$HOME/.config/systemd/user/dshssh-exec-server.service"
dshssh_log "installed dshssh-exec-server.service (port $EXEC_PORT_REMOTE)"

remote_sh "$HOST" "systemctl --user daemon-reload && systemctl --user enable --now dshssh-exec-server.service"
dshssh_log "enabled + started dshssh-exec-server.service"

# --- verify ----------------------------------------------------------------
"$DSHSSH_ROOT/scripts/verify-remote.sh" "$HOST"
dshssh_log "deploy complete: $HOST"
