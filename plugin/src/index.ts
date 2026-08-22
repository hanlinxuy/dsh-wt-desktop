/**
 * @dsh-external/dshssh — dsh-wt 自研 seam 级远程执行插件。
 *
 * 挂载后把本 profile 的 `ctx.subprocess`（和后续 `ctx.fs`）实现替换为
 * 「经 SSH 隧道 → 远端 codex exec-server（headless runtime）」的远程实现，
 * 因此内置工具（bash / read / write / …）自动操作远端，工具名与参数不变。
 *
 * 部署编排（scripts/deploy-remote.sh）、反向执行、GUI 建议操作为后续版本。
 * @module @dsh-external/dshssh
 */
import { Context } from 'cordis'
import z from 'schemastery'
import { ExecTransport } from './transport.ts'
import { RemoteSubprocessRuntime } from './subprocess.ts'
import { RemoteFileSystem } from './fs.ts'

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
}

export const Config = z.object({
  host: z.string().description('SSH 别名/主机，用于建立到远端 exec-server 的本地转发'),
  remoteExecPort: z.number().default(8765).description('远端 exec-server 监听端口（loopback）'),
  localTunnelPort: z.number().default(8876).description('本机 `ssh -L` 转发本地端口'),
  url: z.string().description('直连 exec-server 的 ws:// URL（设置时跳过隧道，用于测试/已建隧道场景）'),
  token: z.string().description('exec-server 认证 token（自建 runtime 的 `?token=` 校验）'),
  cwd: z.string().default('/tmp').description('远端默认工作目录'),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const transport = config.url !== undefined
    ? await (async () => {
        const t = new ExecTransport(config.url!, config.cwd, config.token)
        await t.connect()
        return t
      })()
    : await ExecTransport.viaTunnel(config.host!, config.remoteExecPort ?? 8765, config.localTunnelPort ?? 8876, 20000, config.cwd, config.token)
  ctx.provide('sshTransport', transport)
  ctx.effect(() => () => transport.close(), 'dshssh transport teardown')
  // 挂载 subprocess 缝的远程实现（同一 context 只允许一个实现）。
  ctx.plugin(RemoteSubprocessRuntime)
  // 挂载 fs 缝的远程实现。
  ctx.plugin(RemoteFileSystem)
}

export { ExecTransport } from './transport.ts'
export { RemoteSubprocessRuntime } from './subprocess.ts'
export { RemoteFileSystem } from './fs.ts'
export default apply
