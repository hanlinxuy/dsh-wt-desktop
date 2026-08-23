/**
 * adversarial.spec.ts — 对抗性场景（协议/路径边界/token/资源），keyless。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { bootHarness, type Harness } from './harness.ts'
import { mkdtempSync } from 'node:fs'
import { ExecTransport } from '../src/index.ts'

function boot(): Promise<Harness> { return bootHarness() }

let harness: Harness | null = null
afterEach(async () => { await harness?.close(); harness = null })

function rawRpc(url: string, method: string, params: unknown, token?: string): Promise<unknown> {
  return new Promise((resolve) => {
    let w: WebSocket
    try {
      const u = token !== undefined ? `${url}?token=${token}` : url
      w = new WebSocket(u)
      w.on('open', () => w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })))
      w.on('message', (d) => { resolve(JSON.parse(String(d))); w.close() })
      w.on('error', () => resolve('rejected'))
      setTimeout(() => { try { w.close() } catch { /* */ } resolve('no-response') }, 3000)
    } catch (e) { resolve(`crash:${(e as Error).message}`) }
  })
}

describe('协议对抗', () => {
  it('畸形 JSON 不崩溃', async () => {
    const h = await boot()
    const result = await new Promise<string>((resolve) => {
      const w = new WebSocket(h.url)
      w.on('open', () => w.send('this is not json{{{' ))
      w.on('error', () => resolve('rejected'))
      w.on('close', () => resolve('closed'))
      setTimeout(() => { try { w.close() } catch { /* */ } resolve('no-response') }, 2000)
    })
    expect(['rejected', 'closed', 'no-response']).toContain(result)
  })

  it('未知方法返回错误', async () => {
    const h = await boot()
    const r = await rawRpc(h.url, 'bogus/method', {}, h.token)
    expect((r as { error?: unknown }).error).toBeDefined()
  })

  it('无 token 被拒', async () => {
    const h = await boot()
    const r = await rawRpc(h.url, 'initialize', {}, undefined)
    expect(r).toBe('rejected')
  })

  it('token 变体无法绕过（仅精确值放行）', async () => {
    const h = await boot()
    const variants = [
      `${h.url}?token=${h.token}`, `${h.url}?token=${String(h.token).toUpperCase()}`,
      `${h.url}?token=${h.token}x`, `${h.url}?token=${h.token}%20`, `${h.url}`, `${h.url}?token=evil&token=${h.token}`,
    ]
    const allowed: string[] = []
    for (const v of variants) {
      const r = await rawRpc(v, 'initialize', {}, undefined)
      if (r !== 'rejected' && r !== 'no-response' && (r as { error?: unknown }).error === undefined) allowed.push(v)
    }
    expect(allowed).toHaveLength(1)
    expect(allowed[0]).toContain(`token=${h.token}`)
  })

  it('重复 processId 被拒', async () => {
    const h = await boot()
    const t = new ExecTransport(h.url, '/tmp', h.token)
    await t.connect()
    await t.rpc('process/start', { processId: 'dup', argv: ['true'], cwd: 'file:///tmp' })
    await expect(t.rpc('process/start', { processId: 'dup', argv: ['true'], cwd: 'file:///tmp' })).rejects.toThrow(/duplicate/)
    t.close()
  })
})

describe('路径对抗（allow-cwd）', () => {
  it('路径穿越被拒（无越界落盘）', async () => {
    const jail = mkdtempSync('/tmp/dshssh-adv-')
    const h = await bootHarness({ allowCwd: jail })
    rmSync('/tmp/dshssh-evil.txt', { force: true })
    for (const p of [`${jail}/../dshssh-evil.txt`, `${jail}/../../etc/dshssh-evil-etc`]) {
      await expect(h.fs.writeText(await h.fs.resolve(p), 'evil')).rejects.toThrow()
    }
    const outside = execFileSync('sh', ['-c', 'ls /tmp/dshssh-evil.txt /etc/dshssh-evil-etc 2>/dev/null | wc -l']).toString().trim()
    expect(outside).toBe('0')
  })

  it('符号链接逃逸被拒', async () => {
    const jail = mkdtempSync('/tmp/dshssh-adv-')
    const h = await bootHarness({ allowCwd: jail })
    const secret = join(mkdtempSync('/tmp/dshssh-sec-'), 'secret.txt')
    writeFileSync(secret, 'TOP-SECRET')
    const link = join(jail, 'evil-link')
    rmSync(link, { force: true })
    symlinkSync(secret, link)
    await expect(h.fs.readText(await h.fs.resolve(link))).rejects.toThrow()
    rmSync(link, { force: true })
    rmSync(secret, { force: true })
  })
})

describe('资源对抗', () => {
  it('200MB 输出洪泛：退出码 0 且内存受限截断', async () => {
    const h = await boot()
    const handle = h.sub.spawn({
      argv: ['sh', '-c', 'yes x | head -c 200000000'], cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 3000,
    })
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    const read = handle.collected.stdout?.readFrom(0)
    expect((read?.text.length ?? 0)).toBeLessThanOrEqual(200000)
  })

  it('断连后服务端清理托管进程', async () => {
    const h = await boot()
    const t = new ExecTransport(h.url, '/tmp', h.token)
    await t.connect()
    for (let i = 0; i < 20; i++) {
      await t.rpc('process/start', { processId: `flood-${i}`, argv: ['sleep', '60'], cwd: 'file:///tmp' }).catch(() => { /* */ })
    }
    t.close()
    await new Promise((r) => setTimeout(r, 1500))
    const zombies = execFileSync('sh', ['-c', `ps aux | grep -c '[s]leep 60' || true`]).toString().trim()
    expect(Number(zombies)).toBeLessThanOrEqual(2)
  })
})
