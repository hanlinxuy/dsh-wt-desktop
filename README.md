# dsh-wt-desktop

> 基于 DeepSeek Harness「一切皆插件」机制组装的个人发行版：**seam 级 SSH 远程执行 + headless runtime 部署 + 反向客户端执行 + GUI 建议操作**。
> 类比 Codex `exec-server` 与 ZCode Remote Development / Remote Control 的机制，全部以 DSH 插件组合实现。

## 设计原则

- **只收 seam 级插件**：执行面只接受实现 Harness 能力缝（`ctx.subprocess` / `ctx.fs` / `ctx.subagents` …）的方案——工具名不变、agent 透明、零改动复用全部内置工具。非 seam（如独立 `rw_*` 工具面）不在执行面选型内。
- **第三方全部集中在 `third-party/`**：社区插件 vendored 并锁定精确版本/commit，审计后再纳入，版权与协议随附。
- **自研只做生态没有的三件事**：
  1. headless runtime 部署编排（`deploy-remote.sh` + systemd + codex exec-server，含 ZCode 式连接日志/错误摘要）；
  2. 反向执行编排（远端 DSH agent → 反向隧道 → 本机，受目录白名单约束）；
  3. GUI 建议操作面板（会话 dock / 侧栏：状态灯 + Connect/Deploy/Verify/Smoke/Reverse/Disconnect + 日志抽屉）。

## 仓库结构

```text
dsh-wt-desktop/
├─ PLAN.md                # 调研与实施计划（Codex/ZCode/DSH 机制、差距分析、里程碑）
├─ COMPARISON.md          # 生态方案对比（dsh-ssh / dsh-remote / ds-harness-remote）
├─ third-party/           # 社区插件（vendored + 版本锁定 + 审计记录）
├─ plugin/                # 自研 dshssh 插件（host + client，seam 级）
├─ profile/               # 发行版组装：bundles 清单 + cordis.patch.yml + 版本 pin
├─ scripts/               # 传输层与部署编排（SSH 隧道、exec-server 生命周期、冒烟）
├─ runtime/               # 部署源（codex 配置模板、systemd units、DSH profile）
└─ compose.sh             # 一键组装 + 安装到 dsh web/desktop profile
```

## 状态

- ✅ 传输层（scripts/）+ 部署（runtime/）已在 homelinux2 跑通：`codex exec-server` systemd 常驻 + 正向隧道 + `uname`/fs 探针冒烟全绿。
- ⏳ `third-party/` 选型与 vendoring（候选：`dsh-ssh`，seam 级正向执行基底）
- ⏳ `plugin/`（自研：部署编排 + 反向执行 + GUI 建议操作）
- ⏳ `profile/` 组装与 `compose.sh`

## 快速使用（传输层）

```sh
# 部署 headless runtime（exec-server）到目标机
./scripts/deploy-remote.sh <host>

# 建立正向隧道并冒烟（打印 CODEX_EXEC_SERVER_URL）
./scripts/start-forward.sh <host> 8765

# 反向：本机起 exec-server，远端建反向隧道（需 DSSH_MAC_HOST/DSSH_MAC_USER）
./scripts/start-client-exec.sh 18765
ssh <host> 'DSSH_MAC_HOST=<mac> DSSH_MAC_USER=<user> ./scripts/start-reverse-tunnel.sh'
ssh <host> './scripts/verify-reverse.sh'
```

## 安全

- exec-server 是裸 process/fs RPC，**自身不做沙箱**：低权限用户运行、workspace 收敛、隧道只绑 loopback。
- `approval_policy = "never"` 只用于可信、隔离、可回滚的 runtime。
- 仓库不含任何密钥/内网地址；真实配置留在目标机 `0600`。

## 协议

MIT（本仓库）；vendored 第三方插件各自协议（MIT/Apache-2.0），详见 `third-party/` 审计记录。
