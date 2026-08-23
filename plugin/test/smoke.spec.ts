/**
 * smoke.spec.ts — keyless 集成测试（上游分层：unit/integration 层）。
 * 真实 exec-server + 真实插件装配，覆盖 subprocess/fs 核心执行场景。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootHarness, type Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.close(); harness = null })

async function boot(): Promise<Harness> {
  harness = await bootHarness()
  return harness
}

describe('ctx.subprocess（远端执行 seam）', () => {
  it('uname 输出并正常退出', async () => {
    const h = await boot()
    const handle = h.sub.spawn({
      argv: ['uname', '-a'], cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 3000,
    })
    const outcome = await handle.done
    const text = handle.collected.stdout?.readFrom(0).text ?? ''
    expect(outcome.exitCode).toBe(0)
    expect(text.length).toBeGreaterThan(0)
  })

  it('env 透传', async () => {
    const h = await boot()
    const handle = h.sub.spawn({
      argv: ['sh', '-c', 'echo "probe-$DSSH_PROBE"'], cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000,
      env: { DSSH_PROBE: 'ok' },
    })
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    expect(handle.collected.stdout?.readFrom(0).text).toContain('probe-ok')
  })

  it('stderr 独立捕获 + 退出码', async () => {
    const h = await boot()
    const handle = h.sub.spawn({
      argv: ['sh', '-c', 'echo out; echo err 1>&2; exit 3'], cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000,
    })
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(3)
    expect(handle.collected.stdout?.readFrom(0).text.trim()).toBe('out')
    expect(handle.collected.stderr?.readFrom(0).text.trim()).toBe('err')
  })

  it('大输出截断（lossy 保留尾部）', async () => {
    const h = await boot()
    const handle = h.sub.spawn({
      argv: ['sh', '-c', 'seq 1 5000'], cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 3000,
    })
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    const read = handle.collected.stdout?.readFrom(0)
    expect(read?.lossy).toBe(true)
    expect(read?.text.trim().split('\n').pop()).toBe('5000')
  })

  it('terminate 长进程', async () => {
    const h = await boot()
    const handle = h.sub.spawn({
      argv: ['sh', '-c', 'sleep 30'], cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 1500,
    })
    await new Promise((r) => setTimeout(r, 300))
    handle.terminate()
    expect(await handle.waitForExit()).toBe(true)
  })

  it('缺命令 → done reject（spawn 级失败）', async () => {
    const h = await boot()
    const handle = h.sub.spawn({
      argv: ['definitely-not-a-command-xyz'], cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 3000,
    })
    await expect(handle.done).rejects.toThrow(/spawn failed/)
  })
})

describe('ctx.fs（远端文件 seam）', () => {
  it('写/读/stat/edit/list 全流程', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dshssh-vitest-'))
    const h = await bootHarness({ allowCwd: base })
    const file = `${base}/dir/probe.txt`
    const target = await h.fs.resolve(file)
    const wrote = await h.fs.writeText(target, 'hello dshssh\n')
    expect(wrote.operation).toBe('create')
    expect(await h.fs.readText(target)).toBe('hello dshssh\n')
    const st = await h.fs.stat(target)
    expect(st?.type).toBe('file')
    const edited = await h.fs.editText(target, { oldString: 'hello', newString: 'HELLO', replaceAll: false })
    expect(edited.after).toBe('HELLO dshssh\n')
    const entries = await h.fs.listDir(await h.fs.resolve(`${base}/dir`))
    expect(entries.some((e) => e.name === 'probe.txt')).toBe(true)
  })

  it('陈旧版本写 → FS_STALE_VERSION 且内容不被覆盖', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dshssh-vitest-'))
    const h = await bootHarness({ allowCwd: base })
    const file = join(base, 'stale.txt')
    const target = await h.fs.resolve(file)
    await h.fs.writeText(target, 'original')
    await expect(h.fs.writeText(target, 'evil', { version: '999:999' })).rejects.toThrow(/STALE_VERSION/)
    expect(await h.fs.readText(target)).toBe('original')
  })

  it('编辑未找到 → FS_EDIT_NOT_FOUND', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dshssh-vitest-'))
    const h = await bootHarness({ allowCwd: base })
    const target = await h.fs.resolve(join(base, 'edit.txt'))
    await h.fs.writeText(target, 'abc')
    await expect(h.fs.editText(target, { oldString: 'zzz', newString: 'x', replaceAll: false })).rejects.toThrow(/NOT_FOUND/)
  })
})
