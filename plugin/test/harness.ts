/**
 * harness.ts — 共享测试装配（上游 dsh 的 tests/harness.ts 模式）。
 * 启动「真实的」自建 exec-server + 在裸 cordis context 里挂载真实插件，
 * 返回 subprocess/fs 服务。keyless；全部测试复用，避免重复装配。
 */
import { Context } from 'cordis'
import plugin from '../src/index.ts'
import { startExecServer, type ExecServerOptions } from '../src/exec-server.ts'

export interface Harness {
  ctx: Context
  fiber: unknown
  server: Awaited<ReturnType<typeof startExecServer>>
  url: string
  token?: string
  sub: Context['subprocess']
  fs: Context['fs']
  close: () => Promise<void>
}

export async function bootHarness(options: { token?: string; allowCwd?: string } = {}): Promise<Harness> {
  const token = options.token ?? 'test-token'
  const allowCwd = options.allowCwd ?? '/tmp'
  const server = await startExecServer({ listen: 'ws://127.0.0.1:0', token, allowCwd, graceMs: 1500 })
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { url: server.url, token, cwd: allowCwd })
  await fiber
  return {
    ctx,
    fiber,
    server,
    url: server.url,
    token,
    sub: ctx.subprocess,
    fs: ctx.fs,
    close: async () => {
      await (fiber as { dispose: () => Promise<void> }).dispose()
      await server.close()
    },
  }
}
