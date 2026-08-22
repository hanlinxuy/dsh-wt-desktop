/**
 * @dsh-external/dshssh — dsh-wt 自研 seam 级远程执行插件。
 *
 * 挂载后把本 profile 的 `ctx.subprocess` / `ctx.fs` 实现替换为
 * 「经 SSH 隧道 → 远端自建 exec-server（headless runtime）」的远程实现，
 * 因此内置工具（bash / read / write / …）自动操作远端，工具名与参数不变。
 * 同时提供 /remote 命令、/api/dshssh 状态接口与 GUI dock（client 半区）。
 * @module @dsh-external/dshssh
 */
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import z from 'schemastery'
import { ExecTransport } from './transport.ts'
import { RemoteSubprocessRuntime } from './subprocess.ts'
import { RemoteFileSystem } from './fs.ts'
import { RemoteRuntimeManager } from './manager.ts'
import { registerCommands } from './commands.ts'
import { registerHttp } from './http.ts'

export const name = '@dsh-external/dshssh'

export interface Config {
  /** SSH host alias opening the local forward to the remote exec-server. */
  host?: string
  /** exec-server port on the target (loopback). */
  remoteExecPort?: number
  /** Local end of the `ssh -L` forward. */
  localTunnelPort?: number
  /** Direct exec-server URL (skips the SSH tunnel; testing / already-tunneled). */
  url?: string
  /** Optional auth token passed as `?token=` (matches the self-built exec-server). */
  token?: string
  /** Default remote working directory. */
  cwd: string
  /** Mount the subprocess/fs seam providers (default true). Set false for GUI/commands-only mode. */
  seam?: boolean
}

export const Config = z.object({
  host: z.string().description('SSH 别名/主机，用于建立到远端 exec-server 的本地转发'),
  remoteExecPort: z.number().default(8765).description('远端 exec-server 监听端口（loopback）'),
  localTunnelPort: z.number().default(8876).description('本机 `ssh -L` 转发本地端口'),
  url: z.string().description('直连 exec-server 的 ws:// URL（设置时跳过隧道，用于测试/已建隧道场景）'),
  token: z.string().description('exec-server 认证 token（自建 runtime 的 `?token=` 校验）'),
  cwd: z.string().default('/tmp').description('远端默认工作目录'),
  seam: z.boolean().default(true).description('是否替换 ctx.subprocess/ctx.fs（false = 仅 GUI/命令模式）'),
})

/** Repo root (scripts/ live next to it) — resolves from the built lib/ file. */
const SCRIPTS_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 1) runtime 管理器（GUI/命令/HTTP 共用）
  const manager = new RemoteRuntimeManager(ctx, SCRIPTS_ROOT)
  ctx.provide('remoteManager', manager)
  ctx.effect(() => () => manager.dispose(), 'dshssh manager teardown')

  // 2) 配置驱动的 seam 自动连接（seam !== false 且配置了 host/url 时替换本地 subprocess/fs）
  if (config.host !== undefined || config.url !== undefined) {
    if (config.seam === false) {
      // GUI-only 模式：预注册配置的 host（offline），dock 可见、点击即连。
      manager.ensureOffline(config.host ?? 'direct', {
        remoteExecPort: config.remoteExecPort ?? 8765,
        localTunnelPort: config.localTunnelPort ?? 8876,
        token: config.token,
        cwd: config.cwd,
      })
    } else {
      const transport = config.url !== undefined
        ? await (async () => {
            const t = new ExecTransport(config.url!, config.cwd, config.token)
            await t.connect()
            return t
          })()
        : await ExecTransport.viaTunnel(config.host!, config.remoteExecPort ?? 8765, config.localTunnelPort ?? 8876, 20000, config.cwd, config.token)
      ctx.provide('sshTransport', transport)
      ctx.effect(() => () => transport.close(), 'dshssh transport teardown')
      ctx.plugin(RemoteSubprocessRuntime)
      ctx.plugin(RemoteFileSystem)
      manager.register(config.host ?? 'direct', transport, { cwd: config.cwd })
    }
  }

  // 3) /remote 命令 + /api/dshssh HTTP 接口（GUI dock 数据源）
  registerCommands(ctx, manager)
  registerHttp(ctx, manager)
}

export { ExecTransport } from './transport.ts'
export { RemoteSubprocessRuntime } from './subprocess.ts'
export { RemoteFileSystem } from './fs.ts'
export { RemoteRuntimeManager } from './manager.ts'
export default apply
