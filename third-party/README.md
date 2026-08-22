# third-party — vendored community plugins

本目录集中存放本发行版选用的社区插件，全部**锁定精确版本**（npm 精确版本或 git commit），
并附审计记录（协议、用途、为何入选、验证状态）。原则：**只收 seam 级插件**。

## 选型记录（2026-08-22 调研，见 ../COMPARISON.md）

| 插件 | 版本（待锁定） | 协议 | 层次 | 用途 | 状态 |
|---|---|---|---|---|---|
| [UynajGI/dsh-ssh](https://github.com/UynajGI/dsh-ssh) (`dsh-ssh`) | 0.3.0-pre | MIT | **seam**（ctx.subprocess/ctx.fs 远程 provider，ssh2 + ProxyJump + PTY + SFTP） | 正向远程执行基底 | 待 vendoring + 验证 |
| （候选）[liguobao/deepseek-harness-remote](https://github.com/liguobao/deepseek-harness-remote) (`ds-harness-remote`) | 0.3.x | MIT | control-plane（多端远程访问，E2E 加密，Host 只外连） | 可选：手机/浏览器远程控制 headless runtime | 待定（控制面，非执行面） |

## 明确排除

- `flymysql/dsh-remote`：功能最全但走独立 `rw_*` 工具面（**非 seam**），按本项目原则排除出执行面。

## 流程

1. pin 版本（npm exact / git commit）→ 2. 代码审计（MIT、无凭据泄漏、权限边界）→
3. vendoring（或 pnpm 链接 + lockfile）→ 4. 组合冒烟（复用 scripts/verify-*.sh）→ 5. 记录到上方表格。
