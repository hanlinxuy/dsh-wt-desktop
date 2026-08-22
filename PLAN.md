# 基于 SSH 的 Headless Runtime 部署 + 反向客户端执行 + GUI 建议操作

> 类比 Codex 的 `codex-exec-server` 机制与 ZCode 的 Remote Development 机制，
> 实现：SSH 登录目标机 → 部署 headless runtime → 本客户端（DSH Web GUI）驱动远端操作；
> 反向：远端 headless runtime 通过反向通道在本机（Mac）上执行操作；
> 并且全部操作以「图形界面建议操作 / 可点击动作 / 斜杠命令」的形式暴露在 DSH GUI 中。

## 0. 实施状态（2026-08-20）

- ✅ **Phase 0**：homelinux2 可达；远端 `codex-cli 0.147.0` 自带 `exec-server` 子命令（无需 cargo build）；端口固定（正向 8765 / 反向 18765）。
- ✅ **Phase 1**：`runtime/` 部署源 + `scripts/` 全部就绪；已部署到 homelinux2（systemd user unit `dshssh-exec-server.service`，127.0.0.1:8765）；远端直连冒烟 + Mac→隧道→远端端到端冒烟（`uname -a` + fs 探针往返）全绿。
- ⏳ **Phase 2**：反向脚本已写好，未冒烟 —— 需要 ① Mac 开启 Remote Login（sshd）且 homelinux2 的 key 已授权；② Mac 安装 codex（`npm i -g @openai/codex`）跑本地 exec-server。
- ⏳ **Phase 3/4**：`dshssh` DSH 插件（host + client + GUI 建议操作）未开始。

```text
dshssh/
├─ PLAN.md
├─ runtime/            # 部署源（codex-config 模板 / systemd units / dsh-profile）
└─ scripts/            # deploy-remote.sh / verify-remote.sh / start-forward.sh
                       # start-client-exec.sh / start-reverse-tunnel.sh / verify-reverse.sh
                       # smoke-exec.mjs（exec-server 协议冒烟客户端，插件 remote_exec 的基础）
```

---

## 1. 调研结论

### 1.1 Codex（OpenAI Codex CLI）的远程执行机制

**核心结论：不是把 CLI 搬到远端，而是把 exec/fs 路由到远端。** Agent 大脑（model loop、session、
sandbox policy）留在本地，远端只运行一个轻量 `codex-exec-server`，通过 WebSocket JSON-RPC 暴露进程与文件操作：

```text
本地 Codex
  -> CODEX_EXEC_SERVER_URL=ws://127.0.0.1:PORT   （SSH local forward）
  -> codex-exec-server
  -> 远端进程 / 远端文件系统
```

已验证的关键事实（[exec-server README](https://raw.githubusercontent.com/openai/codex/main/codex-rs/exec-server/README.md)、
[DeepWiki exec-server](https://deepwiki.com/openai/codex/4.7-exec-server)、
[codex-exec-server 机制文章](https://codex.danielvaughan.com/2026/04/10/codex-exec-server-headless-daemon/)）：

- **协议**：WebSocket + JSON-RPC。方法：
  - 生命周期：`initialize` / `initialized`
  - 进程：`process/start`、`process/read`、`process/write`、`process/terminate`
  - 文件：`fs/readFile`、`fs/writeFile`、`fs/createDirectory`、`fs/getMetadata`、`fs/readDirectory`、`fs/remove`、`fs/copy`
- **默认监听** `ws://127.0.0.1:0`（随机端口），启动后把实际 `ws://IP:PORT` 打印到 stdout —— 部署脚本解析该行即可。
- **连接生命周期**：`initialize` → 等响应 → `initialized` → 调 process/fs RPC；默认串行，`--concurrent-requests N` 可并发；
  WebSocket 断开时 server 终止该连接托管的进程。
- **部署参考** `scripts/start-codex-exec.sh`（现成蓝本）：`ssh mkdir -p ~/code/codex-sync` → `rsync` 同步仓库 →
  远端 `cargo build -p codex-exec-server` → `nohup ... --listen ws://127.0.0.1:0 &` → 解析 stdout 第一行拿端口 →
  本机 `ssh -N -L <local_port>:127.0.0.1:<remote_port>` → `CODEX_EXEC_SERVER_URL=... codex -C <repo>` 执行。
- **更新模式**（README 中）：
  - `--remote URL --environment-id ID`：注册到环境 registry，经 rendezvous + Noise relay 加密回连；
  - `forward --connect ws://HOST:PORT`：每路认证 stream 独立连接目标 exec-server，纯转发不解析 RPC。
  - 本计划最小闭环**不依赖** registry/relay，直接用 SSH 隧道（认证、加密、NAT 全交给 SSH）。
- **`codex app-server`（stdio JSON-RPC，v2 词汇）**：`initialize`/`initialized` → `thread/start`（cwd/model/sandbox/
  approvalPolicy/ephemeral）→ `turn/start` 返回 `inProgress` → 终态通知 `turn/completed`；审批类请求
  （`item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 等）用 accept/decline 应答；
  `account/login/start{type:'apiKey',apiKey}` 是认证入口；`CODEX_HOME` 重定向可做配置隔离；
  `ephemeral: true` 线程不留会话文件。**DSH 官方 `dsh-subagent-codex` 提案（见 1.3）就是按这个协议实现的。**
- **Ambient suggestions**：`~/.codex/ambient-suggestions/` 目录存在（本机已见），是 Codex 在交互式界面里
  给出「建议操作」的状态存储 —— 即 Codex 的 GUI/终端建议动作机制。

### 1.2 ZCode（智谱 Z.ai）的 Remote Development 机制

[ZCode Remote Development 官方文档](https://zcode.z.ai/en/docs/remote-development)（已抓取全文）要点：

- **形态**：桌面客户端连接远端（SSH / WSL / Docker 容器），连接成功后「文件读取、终端命令、Git 操作、
  ZCode Agent 执行」都发生在目标环境；桌面端只保留账号、模型配置、任务入口与界面。
- **首次连接**：wizard 进入 Connecting 页，显示实时连接日志（环境检查 → 远端资源准备 → runtime 初始化 → 失败原因），
  失败时底部给出错误摘要 + Back/Feedback。首次较慢，后续**复用已准备好的资源**（`~/.zcode/server`），除非版本变化。
- **两种安装模式**：
  1. `Download locally then upload`（默认）：桌面下载全部组件 → SFTP 上传 → 安装到 `~/.zcode/server`，
     远端**不需要互联网**（适配内网/离线）；
  2. `Download on remote server`：远端直连 ZCode CDN，需要 curl/wget + tar + sha256sum/shasum/openssl。
- **配置同步（Sync Skill / Sync MCP / Sync Plugin）**：手动挑选单项触发，绝不自动同步；远端已存在的跳过不覆盖；
  只同步 user-level 内容；MCP 配置中的密钥按原样写入远端（警告文案）；敏感/路径型设置不同步；市场插件在远端重装
  （远端需可达市场源）。SSH/WSL 支持同步，Docker 不支持。
- **Remote Control / Bot Channel**：手机扫码控制桌面窗口；微信/飞书 bot 驱动 workspace 任务 —— 都是「远端驱动」的补充形态。
- **对本案的启示**：部署要产品化 —— 连接日志、错误摘要、组件版本化缓存、离线上传模式、配置同步策略。

### 1.3 DSH（DeepSeek Harness）插件与 GUI 机制（已读源码验证）

DSH 桌面端是 Cordis 插件组成的 Electron shell（`dsh-plugin-desktop`，Web 端由 `dsh web` 注入 `window.__DSH_BOOT__`）。

- **Host 插件**（Node/Cordis）：注册服务、斜杠命令、工具、subagent provider。
  - 斜杠命令：`ctx.commands.register({ name, description, input?: {hint}, recordInput?, handler })`
    （`dsh-commands`，命令名 `^[a-z][a-z0-9_-]*$`；UI 侧 `/` 触发 + 候选建议，`dsh-client-ui-commands`）。
  - 工具：`ctx.tools.register(name, definition)`（`dsh-tools`）。
  - subagent provider：`ctx.subagents` 命名 provider 缝（`dsh-subagent`）。
- **Client 插件**（Web/React）：包 `package.json` 声明 `"dsh": {"client": {"platform": "web"}}`，
  host 端 `dsh-client-modules` 扫描并服务 `/plugins/<id>/client.js`；客户端通过
  `ctx.slots.inject(slotName, () => ctx.slots.register({name, key|id, order, locale, inject?}, Component))` 注入 UI。
- **可注入 slot（已核实清单）**：
  `conversation.chat.node`、`conversation.chat.commandview`、`conversation.details.tool`、
  `conversation.input.plan`、`conversation.input.dock`（GoalDock 用，带 `inject(sessionId)=>verbs`）、
  `conversation.session`、`conversation.session.header`、`conversation.session.header.actions`、
  `conversation.session.header.utilities`、`conversation.view`、`sidebar`。
- **官方 subagent-codex 提案**（`~/.dsh/source/staging-*/ .agents/notes/proposed/feature/2026-07-07-claude-code-and-codex-subagent-backends.md`）：
  DSH 已规划 `@deepseek-ai/dsh-subagent-codex` —— spawn `codex app-server`（stdio JSON-RPC），
  `CODEX_HOME` 隔离（mkdtemp 每次全新，可 pin 持久目录）、环境变量凭据清洗、`account/login/start{apiKey}` 认证、
  `sandboxMode`（默认 read-only）+ `approvalPolicy`（默认 never）+ `permission` 兜底、工具名 `subagent_codex`。
  这确认了「远端 headless runtime 用 DSH 官方缝接入 codex」是正路。
- **既有环境**（本机已核实）：
  - `~/.ssh/config` 有 `homelinux2`（内网主机，专用 key，非默认端口）与多个其他主机；
  - `~/.codex/`：config.toml（本地 Codex，`sandbox_mode=workspace-write`）+ `ambient-suggestions/`；
  - `~/.dsh`（正式）/ `~/.dsh-dev`（开发实例）：`~/.dsh-dev/plugins/dsh-my-rsi` 是用户现有插件 monorepo
    （commit-gate、github-tools、superagent 等，host 插件模式可照抄）；
  - homelinux2 上已有部署：DSH Web（loopback 3081）+ `subagent_codex` + 专用 Mihomo（49182），
    systemd user services `dsh-rsi.service` / `mihomo-dsh.service`，`codex-config.toml` `approval_policy="never"`。
  - ⚠️ 本次探测时 `homelinux2` **不可达**（No route to host）—— Phase 0 需先解决网络可达性。

### 1.4 差距分析（旧 PLAN 已有 vs 本次新增）

| 维度 | 旧 PLAN.md | 本次新增需求 |
|---|---|---|
| 正向 exec-server 隧道 | ✅ 有（deploy-remote.sh 等） | — |
| 反向隧道 + 本地 exec-server | ✅ 有 | — |
| 部署产品化（日志/错误摘要/缓存/离线安装） | ❌ 无 | ZCode 式连接日志与错误摘要 |
| **GUI 建议操作**（面板/按钮/斜杠命令/状态） | ❌ 无 | **本次核心新增** |
| 与 DSH 官方缝对齐（commands/tools/slots/subagents） | ⚠️ 只提到 provider 注入 env | 用 dsh-commands/tools/slots/subagent 缝实现 |
| `codex app-server`（而非仅 exec-server）作为 runtime | ⚠️ 未区分 | exec-server 管「远端执行」，app-server 管「远端 agent 会话」 |

---

## 2. 目标架构

### 2.1 正向：本机 orchestrator（DSH Web on Mac）操作远端

```text
Mac DSH Web（orchestrator）
  ├─ dshssh 插件（host）：RuntimeManager 服务
  │    ├─ spawn: ssh -N -L 8765:127.0.0.1:8765 homelinux2   （autossh 保活）
  │    └─ spawn: codex exec-server（远端）  ← 首次由 deploy 脚本部署
  ├─ 本地 agent 工具：remote_exec / remote_fs → ws://127.0.0.1:8765
  └─ 本地 codex CLI（可选）：CODEX_EXEC_SERVER_URL=ws://127.0.0.1:8765 codex -C <远端目录>
```

### 2.2 反向：远端 headless runtime 操作本机（Mac）

```text
homelinux2 DSH Web / Codex（headless runtime，approval_policy=never）
  ├─ subagent_codex child（或 DSH agent）
  │    └─ CODEX_EXEC_SERVER_URL=ws://127.0.0.1:18765
  │         └─ ssh -R 18765:127.0.0.1:18765 mac   （反向隧道，绑定远端 loopback）
  └─ Mac 上的 codex-exec-server（普通用户、受限目录）→ Mac 进程/文件系统
```

### 2.3 两种 runtime 形态（对应 Codex 的两套协议）

- **exec-server 形态**（远端=哑执行端）：远端只跑 `codex-exec-server`，大脑在本地。
  用于「本机 GUI 直接驱动远端 shell/fs」—— 即正向工具。
- **app-server 形态**（远端=完整 agent）：远端跑 DSH Web（或 codex app-server daemon）作为 headless runtime，
  自持模型循环与审批策略；本机 GUI 只是查看/控制面（类比 ZCode remote development：界面在桌面、执行在远端），
  反向隧道让这个远端 agent 还能操作本机。现有 homelinux2 部署即此形态，改造点只是加反向通道与 GUI 控制面。

### 2.4 GUI 建议操作层（本次新增核心）

在 DSH Web（本机或任一 runtime 的 Web UI）里，把一切运维与执行动作变成可点击建议：

1. **斜杠命令**（host 注册，`/` 触发候选）：
   `/remote connect <host>`、`/remote deploy <host>`、`/remote verify <host>`、
   `/remote reverse start|stop`、`/remote status`、`/remote disconnect <host>`、`/remote smoke <host>`。
2. **侧栏面板**（`sidebar` slot，keyed）：每个 runtime 一张卡片：状态灯（offline/connecting/ready/reverse-up）、
   版本、端口、按钮 [Connect] [Deploy] [Verify] [Reverse] [Smoke] [Disconnect]、最近错误摘要。
3. **会话头动作**（`conversation.session.header.actions` slot）：当前 runtime 快捷按钮。
4. **连接日志抽屉**（ZCode 式）：wizard/命令执行时逐行滚动（环境检查 → 资源准备 → runtime 初始化 → 失败原因），
   底部错误摘要 + [重试]。
5. **agent 工具展示**：`remote_exec`/`remote_fs`/`local_exec` 工具调用在聊天里以可折叠卡片呈现
   （`conversation.details.tool` / `dsh-agent-tool-presentation`）。
6. **审批集成**（可选，远期）：远端 runtime 的审批请求经反向通道回传到本机 GUI 弹确认（替代 approval_policy=never 的裸奔）。

---

## 3. 组件设计：`dshssh` 插件（本工作区产出）

```text
dshssh/
├─ PLAN.md
├─ scripts/                       # 传输层：SSH + exec-server 生命周期（shell，可独立使用）
│  ├─ deploy-remote.sh            #   一键部署远端 runtime（exec-server / DSH Web）
│  ├─ start-forward.sh            #   ssh -L 正向隧道 + 打印 CODEX_EXEC_SERVER_URL
│  ├─ start-client-exec.sh        #   Mac 上启动本地 exec-server（launchd 可选）
│  ├─ start-reverse-tunnel.sh     #   远端建立 ssh -R 反向隧道（autossh）
│  ├─ verify-remote.sh            #   远端 health + smoke（systemd status / uname / 探针文件）
│  └─ verify-reverse.sh           #   反向 smoke：远端 codex 在 Mac 上 sw_vers + 写探针
├─ runtime/                       # 部署源（非敏感，真实凭据只放目标机 0600）
│  ├─ codex-config.toml.example   #   approval_policy=never + sandbox 限定的远端 codex 配置
│  ├─ systemd/                    #   dsh-rsi.service / mihomo-dsh.service / exec-server.service
│  └─ dsh-profile/                #   远端 DSH profile（web loopback、provider 路由）
└─ plugin/                        # DSH host + client 插件（对照 dsh-my-rsi 的写法）
   ├─ package.json                #   "dsh": {"client": {"platform": "web"}}
   ├─ src/index.ts                #   host：RuntimeManager 服务 + commands + tools + provider
   ├─ src/runtime-manager.ts      #   exec-server/tunnel 进程生命周期、状态机、日志缓冲
   ├─ src/commands.ts             #   /remote * 斜杠命令
   ├─ src/tools.ts                #   remote_exec / remote_fs / local_exec / remote_status 工具
   ├─ src/provider.ts             #   reverse-capable subagent provider（注入 CODEX_EXEC_SERVER_URL）
   └─ src/client.tsx              #   client：sidebar 面板 + 会话头动作 + 日志抽屉（slots 注入）
```

关键接口约定：

- **RuntimeManager 服务**：`ctx.remoteRuntimes` —— `connect(host)` / `deploy(host)` / `verify(host)` /
  `reverse({start,stop})` / `status()` / `logs(host)` / `smoke(host)`；状态机
  `offline → connecting → ready → reverse-up → error`；每 host 一个 `{tunnelPid, execServerPid, port, logs[]}`。
- **命令**：全部走 `ctx.commands.register`，handler 调用 RuntimeManager，输出结构化 markdown + 进度。
- **工具**（给本机 DSH agent 用）：`remote_exec`（经隧道在远端跑命令）、`remote_fs`（读/写远端文件）、
  `local_exec`（只读/受限目录，走反向 exec-server —— 默认拒绝，需显式开启）。
- **provider**：`subagent_codex-local`（反向专用变体）：启动 codex app-server child 时注入
  `CODEX_EXEC_SERVER_URL=ws://127.0.0.1:18765` + `sandboxMode=workspace-write` + 工作目录限定 Mac 允许路径。
- **client**：`ctx.slots.inject("sidebar", …)` 注册「Remote Runtimes」面板；`ctx.slots.inject("conversation.session.header.actions", …)`
  快捷按钮；locale zh/en；远程 RPC 走 typert（host 侧 `ctx.remote.dshssh.*`）。

---

## 4. 实施步骤

### Phase 0：网络与前置（半天）
1. 恢复 `homelinux2` 可达性（LAN / cudo 隧道 / 其他跳板），确认 `ssh homelinux2` 免密 OK。
2. 确认两端 codex 二进制与版本：远端 `codex --version`（app-server 协议按 0.142.5+ 的 v2 词汇）；
   exec-server 二进制来源：
   - 方式 A：codex 仓库 `cargo build -p codex-exec-server`（linux x86_64 在远端编译或交叉编译后拷出）；
   - 方式 B：远端仓库内直接 cargo build（start-codex-exec.sh 原样）。
3. 固定端口：正向 8765、反向 18765、DSH Web 3081（按实例区分）。
4. 确认远端 `~/.codex/config.toml` 隔离策略（独立 `CODEX_HOME`，不继承本机配置）。

### Phase 1：正向传输层脚本（1–2 天）
1. `deploy-remote.sh`：ssh mkdir → rsync `runtime/` → 远端装/构建 exec-server、写 codex-config、起 systemd user services → `verify-remote.sh`。
2. `start-forward.sh`：autossh -L 8765:127.0.0.1:8765，打印 `CODEX_EXEC_SERVER_URL=ws://127.0.0.1:8765`。
3. 冒烟：`CODEX_EXEC_SERVER_URL=ws://127.0.0.1:8765 codex exec -C <远端目录> "uname -a && touch /tmp/probe"`。
   （本机暂未装 codex CLI，可先用 `npx codex` 或直接装固定版本；或先不依赖 CLI，用 DSH 工具层验证。）

### Phase 2：反向传输层脚本（1 天）
1. `start-client-exec.sh`：Mac 普通用户起 `codex-exec-server --listen ws://127.0.0.1:18765`（可选 launchd）。
2. `start-reverse-tunnel.sh`：远端 `autossh -R 18765:127.0.0.1:18765 mac`（仅绑定远端 loopback）。
3. `verify-reverse.sh`：远端 `CODEX_EXEC_SERVER_URL=ws://127.0.0.1:18765 codex exec -C <本工作区路径> "sw_vers && touch /tmp/reverse-probe"`。

### Phase 3：`dshssh` host 插件（2–3 天）
1. 骨架（对照 dsh-my-rsi/superagent）：package.json、`src/index.ts` 注册 `ctx.remoteRuntimes` 服务。
2. RuntimeManager：spawn/kill 隧道与 exec-server、状态机、日志环形缓冲、`ssh` 输出解析。
3. `/remote *` 命令集 + `remote_exec`/`remote_fs`/`remote_status` 工具（先本地回环验证，再走隧道）。
4. `subagent_codex-local` provider（复用官方 dsh-subagent-codex 的协议姿势：app-server stdio、
   CODEX_HOME 隔离、env 清洗、审批自动应答）。
5. 单测（keyless）：状态机、命令 handler、工具 schema、provider 隔离断言（照官方提案的测试分层）。

### Phase 4：`dshssh` client 插件 + GUI 建议操作（2–3 天）
1. `package.json` 声明 `dsh.client.platform=web`，`src/client.tsx` 走 slots 注入。
2. 侧栏「Remote Runtimes」面板：状态灯 + 卡片 + 按钮 + 错误摘要（Connect/Deploy/Verify/Reverse/Smoke/Disconnect）。
3. 会话头快捷动作 + 连接日志抽屉（滚动日志、错误摘要、重试）。
4. 斜杠命令在 `/` 候选里出现并可点击执行（client 侧无需额外开发，host 注册即生效）。
5. 验证 HMR / 构建链路：client 变更需 dev:web 重建（见本会话系统提示），本地 DSH dev 实例加载插件后刷新验证。

### Phase 5：安全加固、多目标与文档（1–2 天）
1. 安全（见 §5）；2. `HOST` 参数化支持多目标机；3. README + 回滚步骤 + 审计清单。

---

## 5. 安全与治理（沿用旧 PLAN 并强化）

1. **SSH 层**：专用 key + agent，禁密码；`ExitOnForwardFailure=yes`、`ServerAliveInterval=30`、
   `ServerAliveCountMax=3`；反向隧道只绑远端 loopback，不暴露公网。
2. **exec-server 层**：exec-server 是裸 process/fs RPC，**自身不做 sandbox** —— 必须独立低权限用户运行，
   工作目录/workspace 权限收敛；Mac 本地反向 server 同样低权限 + 白名单目录。
3. **Codex/DSH 层**：远端 child `sandbox_mode=workspace-write`、`network_access=false`（除非明确需要）；
   `approval_policy=never` 只用于可信、隔离、可回滚的 runtime；反向 child 工作目录限定 Mac 允许路径。
4. **凭据**：不把 API key / codex token / Mihomo subscription / SSH 私钥写入仓库；部署源只存 `.example`；
   真实文件目标机 `0600`；MCP 类同步遵循 ZCode 警告（密钥按原样上传需信任主机）。
5. **审计**：DSH session history + codex rollout/state + exec-server 启动日志 + SSH 隧道进程 + systemd journal。

---

## 6. 决策点（实施前确认）

1. **反向执行的形态**：仅作为远端 codex child 的 remote backend（推荐，改动小、与 Codex 原生机制一致），
   还是独立跑一个 Mac 端 DSH？→ 推荐前者。
2. **exec-server 二进制来源**：远端 cargo build（需 Rust 工具链）vs 本地交叉编译拷出。
3. **本机是否安装 codex CLI**：Phase 1/2 冒烟需要；可 `brew install codex` 固定版本或远端已有。
4. **认证升级**：当前 WebSocket 无认证，靠 SSH 隧道兜底；未来跨网络直连必须加 token/认证。
5. **GUI 范围**：先做「侧栏面板 + 斜杠命令 + 日志抽屉」（推荐）；会话头快捷按钮与审批回传为增量。
6. **浏览器/桌面自动化**（远端操作 Mac GUI 应用）：exec-server 只覆盖 shell/fs；需要时另加 MCP/专用工具，不在最小闭环内。

---

## 7. 里程碑

- **M1**：Phase 0+1 —— homelinux2 正向部署脚本跑通，远端 exec-server 冒烟全绿。
- **M2**：Phase 2 —— 反向隧道 + Mac exec-server 跑通 `sw_vers` / 探针写入。
- **M3**：Phase 3 —— `dshssh` host 插件：/remote 命令 + remote_exec/remote_fs + 反向 provider 端到端。
- **M4**：Phase 4 —— GUI 建议操作：侧栏面板 + 日志抽屉 + 斜杠命令可点击，DSH Web 内一键 Deploy/Verify/Reverse。
- **M5**：Phase 5 —— 安全加固、多目标参数化、文档与回滚，可重复部署新目标机。

## 8. 参考来源

- Codex exec-server：[README](https://raw.githubusercontent.com/openai/codex/main/codex-rs/exec-server/README.md) ·
  [DeepWiki](https://deepwiki.com/openai/codex/4.7-exec-server) · [机制解读](https://codex.danielvaughan.com/2026/04/10/codex-exec-server-headless-daemon/) ·
  [app-server stdio 解读](https://codex.danielvaughan.com/2026/06/03/codex-app-server-stdio-subprocess-embedding-custom-clients-json-rpc-protocol/) ·
  [remote dev 解读](https://codex.danielvaughan.com/2026/04/12/codex-cli-remote-development-app-server-websocket/) ·
  [Rust 结构](https://mintlify.wiki/openai/codex/architecture/rust-crates)
- ZCode：[Remote Development](https://zcode.z.ai/en/docs/remote-development) · [中文版](https://zcode.z.ai/cn/docs/remote-development)
- DSH：`@deepseek-ai/dsh-commands`、`dsh-client-ui-commands`、`dsh-client-ui-slots`、`dsh-subagent`、
  `dsh-tools`（已读 lib 源码）；官方提案 note `2026-07-07-claude-code-and-codex-subagent-backends`
