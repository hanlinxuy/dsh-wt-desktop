# DSH 远程执行 / 远程访问方案对比（2026-08-22 调研）

> 调研源：GitHub `dsh-plugin` topic、[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（412 插件）、
> [dsh-market](https://github.com/dsh-market/dsh-market)（npm 1550+ 插件）、各仓库 README/源码/统计（星标、更新时间、协议）。
> 结论：生态里已有三个成熟方向的现成实现，我们的 `dshssh` 不应从零造轮子，只需补齐生态缺失的三件事。

---

## 1. 三个方案原型

### A. `UynajGI/dsh-ssh`（npm `dsh-ssh`，MIT，7★，2026-08 活跃，有 CI/测试）
**exec-plane · seam 级远程化 —— 最贴 Codex 机制**
- 实现 Harness 的能力缝 `ctx.subprocess` + `ctx.fs` 为**远端 provider**（ssh2 + ProxyJump + PTY + SFTP）：
  所有基于这两条缝的内置工具（bash、文件工具、终端、LSP、subagent 进程）零改动切换到远端。
- 哲学与 `codex-exec-server` 一致：「本地脑、远端手」——远端不需要装 Harness。
- 连接配置走 cordis.yml（静态），客户端提供「添加工作区」目录流 + 连接侧栏（保存的连接 + `~/.ssh/config` + 本地）。
- **缺**：headless runtime 部署、反向执行编排、运维面板。

### B. `flymysql/dsh-remote`（npm `dsh-remote`，MIT，31★，昨天还在更新，有测试）
**exec-plane · 功能最全的远程工作区**
- 多机 SSH 注册表（host/port/user/key/密码，OS 钥匙串加密）、`~/.ssh/config` 导入、健康测试。
- 远程工作区 = **本地镜像 + SFTP 三路同步**（冲突报告、dry-run、ignore 规则），无缝接入 DSH 原生 workspace。
- 20 个模型工具：`rw_info/connect/pick_workspace/list_dir/stat/read_file/write_file/edit/append/mkdir/remove/move/exec/search/download/upload/forward/sync/push/disconnect`。
- **正反向端口转发**（`rw_forward`，reverse = 远端→本机）、审计日志、TOFU 主机密钥、异步任务队列。
- 设置页 + 侧栏远程编辑（better-sidebar）。
- **缺**：headless runtime 部署、远端 agent 反向执行编排（只有隧道传输层）。

### C. `liguobao/deepseek-harness-remote`（npm `ds-harness-remote`，MIT，44★，昨天还在更新）
**control-plane · 多端远程访问（ZCode Remote Control 的 DSH 版）**
- Harness 跑在工作电脑上（工作区/工具/配置不变），Remote 只是另一个窗口：浏览器 / Android APK / VS Code 扩展。
- 安全模型：**Host 只主动外连、不开放公网端口**；Noise 端到端加密；服务端只中继密文；设备授权/撤销。
- 能力边界：仅开放界面所需能力——**无 Shell、无远程桌面**；文件预览可选 `dsh-file-viewer`（只读、分块、加密）。
- 对应「反向：本客户端作为远端 headless runtime 的远程控制端」。
- **缺**：正向远程执行（它恰恰不做 exec）。

### D. 我们的 `dshssh`（本工作区，Phase 0/1 已跑通）
**传输层 + 部署编排（生态没有的部分）**
- `deploy-remote.sh`：SSH + rsync 部署 codex exec-server（复用现成 `codex exec-server` 子命令，systemd 常驻 127.0.0.1:8765）——已部署 homelinux2 并冒烟通过。
- `start-forward.sh` / `start-reverse-tunnel.sh`：正/反向隧道（autossh/ssh 回退）。
- `start-client-exec.sh`：本机 exec-server（反向执行面）。
- `smoke-exec.mjs`：exec-server 协议 WS 冒烟客户端（可作插件工具基础）。
- **缺**：GUI、运行时连接管理、工具/命令面（即 Phase 3/4 的原计划）。

---

## 2. 差距矩阵

| 能力 | A dsh-ssh | B dsh-remote | C ds-harness-remote | D 我们的 scripts |
|---|---|---|---|---|
| 正向远程执行（命令/PTY） | ✅ seam 级（全部内置工具） | ✅ rw_exec 等 | ❌ 明确不做 | ✅ exec-server |
| 正向远程文件 | ✅ ctx.fs（SFTP） | ✅ SFTP + 本地镜像同步 | ⚠️ 只读预览 | ✅ fs/* RPC |
| 多机管理 | ⚠️ 连接侧栏 | ✅ 注册表+切换 | ✅ 多设备目录 | ❌ 单 HOST 参数 |
| 正/反向隧道 | ❌ | ✅ rw_forward（含 reverse） | ✅ 自建加密信道 | ✅ ssh -L/-R |
| **headless runtime 部署** | ❌ | ❌ | ❌ | ✅（已跑通） |
| **反向执行（远端 agent 操作本机）** | ❌ | ⚠️ 仅隧道传输 | ❌ 控制面不是执行面 | ⚠️ 编排半成品 |
| **GUI 建议操作面板** | ⚠️ 连接侧栏 | ⚠️ 设置页/选择器 | ✅ Remote 入口 | ❌ |
| 安全模型 | ssh key/agent/跳板 | TOFU + OS 钥匙串 + 审计 | E2E 加密 + 设备授权 | SSH 隧道（无 WS 认证） |
| 成熟度 | 7★/CI/测试 | 31★/测试/活跃 | 44★/三端客户端/活跃 | 自研刚跑通 M1 |
| 许可证 | MIT | MIT | MIT | —（自研） |

---

## 3. 结论与推荐组合

三个方案是**互补**的，不是互斥的：

- **正向执行面**：A（seam 级，最贴 Codex「本地脑/远端手」，零改动复用全部内置工具）或 B（功能最全、有 UI 与多机管理）。
- **反向控制面**：C 解决「本机作为远端 headless runtime 的远程窗口」（扫码/授权/端到端加密/无 Shell 暴露）——与现有 homelinux2 DSH Web 隧道思路一致但更产品化。
- **生态缺失、需要自研的只有三件**（即我们的 `dshssh` 薄插件）：
  1. **headless runtime 部署编排**（调 `deploy-remote.sh` + systemd + 版本化缓存，ZCode 式连接日志/错误摘要）；
  2. **反向执行编排**（远端 DSH agent → ssh -R → 本地 exec-server → 操作本机，受目录白名单约束）；
  3. **GUI 建议操作面板**（会话 dock/侧栏：状态灯 + Connect/Deploy/Verify/Smoke/Reverse/Disconnect + 日志抽屉）。

**推荐路径**：先 `dsh plugin --profile web add dsh-ssh`（或 `dsh-remote`）进 dev profile 验证 homelinux2 正向执行手感；
同时保留我们已跑通的 scripts 作为部署/反向传输层；再写薄插件补①②③。
若用户目标更偏「手机/浏览器远程控制 headless runtime」（ZCode Remote Control 类比），则 C 已覆盖大部分，只需补部署编排 + 建议操作。

## 4. 参考链接

- A: https://github.com/UynajGI/dsh-ssh
- B: https://github.com/flymysql/dsh-remote
- C: https://github.com/liguobao/deepseek-harness-remote （README.zh.md、DESIGN.md）
- 生态：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin · https://github.com/dsh-market/dsh-market
- 官方：https://github.com/deepseek-ai/deepseek-harness
