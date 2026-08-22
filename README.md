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

## 技术路线（定案 2026-08-22）

- **不 fork 桌面壳**：`anywhere-labs/deepseek-harness-desktop`（当前版本 v2.0.x，MIT）保持原样作为宿主；桌面本身是插件，用户插件经 profile bundles 组合。
- **零 codex 依赖，headless runtime 完全自建**：`plugin/lib/exec-server.js`（Node，ws 已打包的单文件）是自建的远端运行时——真实进程生命周期（SIGTERM→SIGKILL）、原子文件写入、token 认证、`allow-cwd` 白名单；目标机只需 Node。
- **远端 agent 与本地是同一个 DSH 运行时**：部署的是 dsh 本体（同一 node + dsh + profile + 插件），远端 agent 行为与本地完全一致；自建 exec-server 承担执行面 RPC（正向 seam / 反向执行）。
- **发行版 = 插件集 + profile 组合 + 可选打包 overlay**：
  1. 插件集（本仓库）：`plugin/`（自研 dshssh：seam provider + 自建 runtime）；
  2. `profile/`：bundles 清单 + `cordis.patch.yml` + 版本 pin；
  3. 可选打包 overlay：基于上游 release 源码构建 + overlay 默认 profile（不改壳源码），出 wt 版安装包。
- **跟随上游 = 版本 pin 表 + 每版重构建**：上游 2–3 天/版；维护「desktop 版本 ↔ 插件版本」对照表，升级只动 pin。
- **兼容性保证**：插件声明 engines/依赖范围（当前 `@deepseek-ai/dsh-* ^0.1.0-rc.6` ↔ desktop rc.7）；CI 发布前在 desktop profile 里跑正/反向冒烟（`plugin/test/smoke.mjs`）。

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

- ✅ 传输层（scripts/）+ 部署（runtime/）：自建 exec-server systemd 常驻 + 正向隧道 + 冒烟（homelinux2，M1 时基于 codex，现已切自建）。
- ✅ **自建 headless runtime（plugin/lib/exec-server.js）**：真实进程/fs RPC + token 认证 + allow-cwd 白名单；keyless 冒烟全绿（含未授权拒绝 401）。
- ✅ **自研 seam provider（plugin/）S1+S2**：`ctx.subprocess` + `ctx.fs` 远程实现，keyless 冒烟全绿（uname/env/退出码/write/read/stat/edit/list）。
- ⏳ 真实远端 seam 冒烟：cudo 可达，部署自建 runtime 验证中。
- ⏳ 反向执行（远端 DSH 挂反向 provider 操作本机）+ `/remote` 命令 + GUI 建议操作。
- ⏳ `profile/` 组装、版本 pin 表与 `compose.sh`；可选：上游源码构建 + overlay 打包。

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
