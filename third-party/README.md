# third-party — vendored community plugins

本目录集中存放本发行版选用的社区插件，全部**锁定精确版本**（npm 精确版本或 git commit），
并附审计记录（协议、用途、为何入选、验证状态）。原则：**只收 seam 级插件**。

## 选型记录（2026-08-22 调研，见 ../COMPARISON.md）

| 插件 | 版本 | 协议 | 层次 | 用途 | 状态 |
|---|---|---|---|---|---|
| ~~[UynajGI/dsh-ssh](https://github.com/UynajGI/dsh-ssh)~~ | 0.3.0-pre | MIT | seam | ~~正向远程执行基底~~ | ❌ **不集成**：用户决定自研 seam provider；本仓库 `plugin/` 已实现（`ctx.subprocess` 经 exec-server 传输，keyless 冒烟全绿）；dsh-ssh 源码仅作 MIT 参考模板 |
| （候选）[liguobao/deepseek-harness-remote](https://github.com/liguobao/deepseek-harness-remote) (`ds-harness-remote`) | 0.3.x | MIT | control-plane（多端远程访问，E2E 加密，Host 只外连） | 可选：手机/浏览器远程控制 headless runtime | 待定（控制面，非执行面） |

## 明确排除

- `flymysql/dsh-remote`：功能最全但走独立 `rw_*` 工具面（**非 seam**），按本项目原则排除出执行面。
- `UynajGI/dsh-ssh`：seam 级但版本为 pre-release 且用户决定自研（见上表）。

## 自研插件（plugin/）替代第三方执行插件

- `plugin/src/transport.ts` — exec-server WS JSON-RPC 传输（复用 scripts/smoke-exec.mjs 协议）+ ssh -L 隧道管理。
- `plugin/src/subprocess.ts` — `ctx.subprocess` 缝的远程实现（版本无关基类，兼容 dsh rc.7 `SubprocessRuntime` 与上游 0.0.1 `SubprocessService`）。
- `plugin/test/mock-exec-server.mjs` + `plugin/test/smoke.mjs --mock` — keyless 全链路冒烟（uname / env / 退出码）。

## 流程

1. pin 版本（npm exact / git commit）→ 2. 代码审计（MIT、无凭据泄漏、权限边界）→
3. vendoring（或 pnpm 链接 + lockfile）→ 4. 组合冒烟（复用 scripts/verify-*.sh）→ 5. 记录到上方表格。
