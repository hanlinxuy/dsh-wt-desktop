/**
 * manager.spec.ts — RemoteRuntimeManager keyless 单测（register/ensureOffline/
 * transportFor/disconnect/dispose + 真实本地 exec-server 传输）。
 */
import { describe, expect, it } from 'vitest'
import { RemoteRuntimeManager, ExecTransport } from '../src/index.ts'
import { startExecServer } from '../src/exec-server.ts'

describe('RemoteRuntimeManager', () => {
  it('register + transportFor + defaultTransport', async () => {
    const server = await startExecServer({ listen: 'ws://127.0.0.1:0', token: 'm', allowCwd: '/tmp' })
    const t = new ExecTransport(server.url, '/tmp', 'm')
    await t.connect()
    const mgr = new RemoteRuntimeManager(null as never, process.cwd())
    mgr.register('host-a', t, { cwd: '/tmp' })
    expect(mgr.transportFor('host-a')).toBe(t)
    expect(mgr.transportFor('missing')).toBe(t) // fallback 到第一个 ready
    expect(mgr.defaultTransport()).toBe(t)
    const list = mgr.list()
    expect(list[0]?.name).toBe('host-a')
    expect(list[0]?.state).toBe('ready')
    mgr.disconnect('host-a')
    expect(mgr.get('host-a')?.state).toBe('offline')
    expect(mgr.transportFor('host-a')).toBeNull()
    mgr.dispose()
    await server.close()
  })

  it('ensureOffline 幂等 + 配置保留', () => {
    const mgr = new RemoteRuntimeManager(null as never, process.cwd())
    const a = mgr.ensureOffline('host-b', { cwd: '/work', token: 'tk', remoteExecPort: 8765, localTunnelPort: 8876 })
    expect(a.state).toBe('offline')
    expect(a.cwd).toBe('/work')
    expect(a.token).toBe('tk')
    const again = mgr.ensureOffline('host-b', { cwd: '/other' })
    expect(again).toBe(a) // 幂等：不覆盖已有记录
  })

  it('smoke 走真实本地 exec-server（keyless）', async () => {
    const server = await startExecServer({ listen: 'ws://127.0.0.1:0', token: 'm2', allowCwd: '/tmp' })
    const t = new ExecTransport(server.url, '/tmp', 'm2')
    await t.connect()
    const mgr = new RemoteRuntimeManager(null as never, process.cwd())
    mgr.register('local', t, { cwd: '/tmp' })
    const text = await mgr.smoke('local')
    expect(text.length).toBeGreaterThan(0)
    mgr.dispose()
    await server.close()
  })

  it('runScript 对不存在脚本报错/非零（deploy/verify 需真实 SSH，这里验证错误路径）', async () => {
    const mgr = new RemoteRuntimeManager(null as never, '/nonexistent-root')
    const code = await mgr.runScript('verify', 'localhost')
    expect(code).not.toBe(0)
  })
})
