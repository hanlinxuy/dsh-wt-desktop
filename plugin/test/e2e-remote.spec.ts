/**
 * e2e-remote.spec.ts — 真实远端 e2e（上游分层：Real-API e2e，自跳过）。
 * 无 DSSH_E2E_HOST 时整组跳过；提供时对真实远端自建 runtime 跑完整 seam 冒烟。
 * 用法: DSSH_E2E_HOST=cudo-h100-node1-gateway DSSH_E2E_TOKEN=... pnpm test
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { Context } from 'cordis'
import plugin from '../src/index.ts'
import { startExecServer, type ExecServerOptions } from '../src/exec-server.ts'

const HOST = process.env.DSSH_E2E_HOST
const TOKEN = process.env.DSSH_E2E_TOKEN
const CWD = process.env.DSSH_E2E_CWD ?? '/home/hanlin/workspaces/dshssh'

const describeRemote = HOST !== undefined ? describe : describe.skip

describeRemote('真实远端 seam e2e（DSSH_E2E_HOST）', () => {
  it('经 ssh -L 隧道跑通 ctx.subprocess + ctx.fs', async () => {
    expect(TOKEN, 'DSSH_E2E_TOKEN required').toBeTruthy()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, { host: HOST, remoteExecPort: 8765, localTunnelPort: 8899, token: TOKEN, cwd: CWD })
    await fiber
    try {
      const sub = ctx.subprocess
      const handle = sub.spawn({
        argv: ['uname', '-a'], cwd: CWD,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 5000,
      })
      const outcome = await handle.done
      const text = handle.collected.stdout?.readFrom(0).text ?? ''
      expect(outcome.exitCode).toBe(0)
      // 验证「世界而非自述」：外部再跑一次 uname 对比（上游铁律）
      const external = execFileSync('ssh', ['-o', 'BatchMode=yes', HOST!, 'uname -a']).toString().trim()
      expect(text.trim()).toBe(external.trim())
      // fs 往返
      const fs = ctx.fs
      const probe = `${CWD}/dshssh-e2e-probe.txt`
      await fs.writeText(await fs.resolve(probe), 'e2e-remote')
      expect(await fs.readText(await fs.resolve(probe))).toBe('e2e-remote')
    } finally {
      await (fiber as { dispose: () => Promise<void> }).dispose()
    }
  })
})
