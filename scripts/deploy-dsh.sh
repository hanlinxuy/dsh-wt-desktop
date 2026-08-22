#!/usr/bin/env bash
# deploy-dsh.sh — 在目标机上部署「与本地同款的 DSH 运行时」（②：控制面）。
#
# 远端跑同一版本官方 DSH（npm 固定版本 @deepseek-ai/dsh-base + dsh-web-app）
# + 我们的 @dsh-external/dshssh 插件（seam 模式，url 指向反向隧道 → 操作本机），
# 本地浏览器经 ssh -L 连远端 dsh web —— 即「本地对话框 → 文字给远端 agent」。
#
# Usage: scripts/deploy-dsh.sh [HOST] [--port 3081] [--dsh-version 0.1.0-rc.7]
#   DSSH_REVERSE_TOKEN=xxx scripts/deploy-dsh.sh HOST   # 反向通道 token（Mac exec-server）
#
# 前置：deploy-remote.sh 已跑过（远端有 node + 自建 exec-server）。
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST="${1:-$DEFAULT_HOST}"
DSH_VERSION="${DSH_VERSION:-0.1.0-rc.7}"
WEB_PORT="${DSH_PORT:-3081}"
NODE_BIN="$(resolve_node_bin "$HOST")"
[ -n "$NODE_BIN" ] || dshssh_fail "node not found on $HOST (run deploy-remote.sh first)"
REMOTE_HOME="$(remote_sh "$HOST" 'printf %s "$HOME"')"

dshssh_log "deploying DSH $DSH_VERSION web runtime to $HOST (port $WEB_PORT)"

# --- 1) 远端 DSH profile（独立 home，与本地版本一致） ------------------------
DSH_HOME_REMOTE="$REMOTE_HOME/.dsh-wt/home"
PROF_REMOTE="$DSH_HOME_REMOTE/profiles/web"
remote_sh "$HOST" "mkdir -p $PROF_REMOTE"

# 插件已由 deploy-remote.sh 同步到 ~/$REMOTE_BASE/plugin/lib —— 在远端 profile 里
# 用 node_modules 链接的方式引用（避免再拷一遍）。
cat > /tmp/dshssh-remote-profile.json <<JSON
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-base": "$DSH_VERSION",
    "@deepseek-ai/dsh-web-app": "$DSH_VERSION",
    "@dsh-external/dshssh": "file:$REMOTE_HOME/$REMOTE_BASE/plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-external/dshssh"]
    }
  }
}
JSON
scp "${SSH_OPTS[@]}" /tmp/dshssh-remote-profile.json "$HOST:$PROF_REMOTE/package.json"
rm -f /tmp/dshssh-remote-profile.json

# 反向通道配置：远端 agent 的 bash/fs 经 ws://127.0.0.1:18765（ssh -R）操作本机
REVERSE_TOKEN="${DSSH_REVERSE_TOKEN:-$(cat "$HOME/.config/dshssh/reverse-token" 2>/dev/null || true)}"
[ -n "$REVERSE_TOKEN" ] || dshssh_fail "DSSH_REVERSE_TOKEN required (Mac reverse token)"
cat > /tmp/dshssh-remote-patch.yml <<YAML
# dsh-wt: dshssh seam mode — remote agent operates the Mac via the reverse tunnel.
- insert:
    - id: dshssh
      name: '@dsh-external/dshssh'
      config:
        seam: true
        url: ws://127.0.0.1:18765
        token: '$REVERSE_TOKEN'
        cwd: /Users/USER/dshssh-reverse-workspace
YAML
scp "${SSH_OPTS[@]}" /tmp/dshssh-remote-patch.yml "$HOST:$PROF_REMOTE/cordis.patch.yml"
rm -f /tmp/dshssh-remote-patch.yml

# --- 2) 远端安装（pnpm/npm） ------------------------------------------------
remote_sh "$HOST" "cd $PROF_REMOTE && (command -v pnpm >/dev/null || $NODE_BIN \$(dirname $NODE_BIN)/corepack enable 2>/dev/null || npm i -g pnpm >/dev/null 2>&1 || true); pnpm install --config.confirmModulesPurge=false 2>&1 | tail -3"

# --- 3) systemd 用户服务：dsh-wt-web.service --------------------------------
cat > /tmp/dshssh-remote-web.service <<UNIT
[Unit]
Description=dsh-wt DSH web runtime (same DSH version as local)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
Environment=DSH_HOME=$DSH_HOME_REMOTE
Environment=DSH_TELEMETRY_DISABLED=1
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_BIN $PROF_REMOTE/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --host 127.0.0.1 --port $WEB_PORT
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
UNIT
scp "${SSH_OPTS[@]}" /tmp/dshssh-remote-web.service "$HOST:~/.config/systemd/user/dsh-wt-web.service"
rm -f /tmp/dshssh-remote-web.service
remote_sh "$HOST" "systemctl --user daemon-reload && systemctl --user enable --now dsh-wt-web.service && systemctl --user restart dsh-wt-web.service"
dshssh_log "remote DSH web: http://127.0.0.1:$WEB_PORT on $HOST (expose locally with: ssh -L ${WEB_PORT}:127.0.0.1:${WEB_PORT} $HOST)"
dshssh_log "deploy-dsh complete: $HOST (agent there = same DSH runtime; its bash/fs operate the Mac via reverse channel)"
