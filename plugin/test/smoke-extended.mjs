/**
 * smoke-extended.mjs — 扩展执行场景测试（keyless，走本地自建 exec-server）。
 *
 * 用法: node test/smoke-extended.mjs
 * 覆盖:
 *   subprocess: stderr 捕获 / 大输出截断 / 长进程终止 / 缺命令 / cwd / shell 管道
 *   fs:        mkdir/remove/copy / 嵌套目录 / 二进制读取 / 陈旧版本写 / 编辑未找到 / 目录 stat
 *   transport: token 拒绝 / allow-cwd 越界拒绝
 */
import { execFileSync } from 'node:child_process'
import { Context } from 'cordis'
import plugin from '../lib/index.js'
import { startExecServer } from '../lib/exec-server.js'
import { ExecTransport } from '../lib/index.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

async function main() {
  const ws = await startExecServer({ listen: 'ws://127.0.0.1:0', token: 'ext-token', allowCwd: '/tmp', graceMs: 1500 })
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { url: ws.url, token: 'ext-token', cwd: '/tmp' })
  await fiber
  const sub = ctx.subprocess
  const fs = ctx.fs

  console.log('== subprocess 场景 ==')

  // stderr 捕获
  {
    const h = sub.spawn({ argv: ['sh', '-c', 'echo out; echo err 1>&2; exit 3'], cwd: '/tmp', stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000 })
    const o = await h.done
    const out = h.collected.stdout?.readFrom(0).text ?? ''
    const err = h.collected.stderr?.readFrom(0).text ?? ''
    check('stderr 捕获', o.exitCode === 3 && err.trim() === 'err', JSON.stringify({ out, err }))
  }

  // 大输出截断（collect 保留尾部 + lossy 标志）
  {
    const h = sub.spawn({ argv: ['sh', '-c', 'seq 1 5000'], cwd: '/tmp', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 3000 })
    const o = await h.done
    const read = h.collected.stdout?.readFrom(0)
    check('大输出退出码', o.exitCode === 0)
    check('大输出截断 lossy', read?.lossy === true && (read?.text.length ?? 0) > 0, `len=${read?.text.length}`)
    check('大输出保留尾部', (read?.text.trim().split('\n').pop() ?? '') === '5000', read?.text.trim().split('\n').pop())
  }

  // 长进程 + terminate
  {
    const h = sub.spawn({ argv: ['sh', '-c', 'sleep 30'], cwd: '/tmp', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 1500 })
    await new Promise((r) => setTimeout(r, 300))
    const started = Date.now()
    h.terminate()
    const exited = await h.waitForExit()
    check('terminate 生效', exited === true && Date.now() - started < 10000, `${Date.now() - started}ms`)
  }

  // 缺命令 → spawn 级错误（done reject）
  {
    const h = sub.spawn({ argv: ['definitely-not-a-command-xyz', '--x'], cwd: '/tmp', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 3000 })
    let rejected = false
    try { await h.done } catch { rejected = true }
    check('缺命令 done reject', rejected)
  }

  // cwd 生效（macOS /tmp -> /private/tmp，接受 realpath 后的结果）
  {
    const expected = execFileSync('sh', ['-c', 'cd /tmp && pwd -P']).toString().trim()
    const h = sub.spawn({ argv: ['pwd'], cwd: '/tmp', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 3000 })
    const o = await h.done
    const out = h.collected.stdout?.readFrom(0).text.trim() ?? ''
    check('cwd 生效', o.exitCode === 0 && out === expected, `${out} vs ${expected}`)
  }

  // shell 管道
  {
    const h = sub.spawn({ argv: ['sh', '-c', 'echo "a\nb\nc" | wc -l'], cwd: '/tmp', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 3000 })
    const o = await h.done
    const out = h.collected.stdout?.readFrom(0).text.trim() ?? ''
    check('shell 管道', o.exitCode === 0 && out === '3', out)
  }

  console.log('== fs 场景 ==')

  const base = '/tmp/dshssh-ext'
  const file = `${base}/dir/nested/probe.txt`
  // mkdir + 嵌套写
  {
    await fs.resolve(file).then((t) => fs.writeText(t, 'nested content'))
    check('嵌套目录写', (await fs.readText(await fs.resolve(file))) === 'nested content')
  }
  // stat 目录
  {
    const t = await fs.resolve(base)
    const st = await fs.stat(t)
    check('目录 stat', st?.type === 'directory')
  }
  // listDir 嵌套
  {
    const entries = await fs.listDir(await fs.resolve(`${base}/dir`))
    check('listDir', entries.some((e) => e.name === 'nested'))
  }
  // 陈旧版本写 → FS_STALE_VERSION
  {
    const t = await fs.resolve(file)
    const before = await fs.stat(t)
    const stale = { version: '999:999' }
    let staleRejected = false
    try { await fs.writeText(t, 'overwrite', stale) } catch (e) { staleRejected = String(e).includes('FS_STALE_VERSION') || e?.code === 'FS_STALE_VERSION' }
    check('陈旧版本写拒绝', staleRejected)
    check('内容未被覆盖', (await fs.readText(t)) === 'nested content')
    void before
  }
  // 编辑未找到 → FS_EDIT_NOT_FOUND
  {
    const t = await fs.resolve(file)
    let notFound = false
    try { await fs.editText(t, { oldString: 'zzz-no-such', newString: 'x', replaceAll: false }) } catch (e) { notFound = String(e).includes('FS_EDIT_NOT_FOUND') || e?.code === 'FS_EDIT_NOT_FOUND' }
    check('编辑未找到拒绝', notFound)
  }
  // replaceAll 编辑
  {
    const t = await fs.resolve(file)
    const e = await fs.editText(t, { oldString: 'nested', newString: 'NESTED', replaceAll: true })
    check('replaceAll 编辑', e.after === 'NESTED content')
  }
  // 二进制读取（mock/server 按 utf8 返回 base64，检测含 \0 的二进制）
  {
    execFileSync('sh', ['-c', `printf '\\x00\\x01\\x02binary' > ${base}/bin.dat`])
    const t = await fs.resolve(`${base}/bin.dat`)
    const text = await fs.readText(t)
    check('二进制内容可读', text.includes('binary'), JSON.stringify(text))
  }
  // copy
  {
    const src = await fs.resolve(file)
    const dst = await fs.resolve(`${base}/copied.txt`)
    const transport = (ctx).sshTransport
    await transport.fsCopy(src.targetKey, dst.targetKey)
    check('fs/copy', (await fs.readText(dst)) === 'NESTED content')
  }
  // remove
  {
    const t = await fs.resolve(`${base}/copied.txt`)
    await transportRemove(ctx, t)
    const st = await fs.stat(t)
    check('fs/remove', st === undefined)
  }

  console.log('== transport 场景 ==')

  // 无 token 拒绝
  {
    const bad = new ExecTransport(ws.url, '/tmp')
    const outcome = await Promise.race([bad.connect().then(() => 'connected', () => 'rejected'), new Promise((r) => setTimeout(() => r('timeout'), 5000))])
    check('无 token 拒绝', outcome === 'rejected' || outcome === 'timeout', outcome)
    bad.close()
  }
  // allow-cwd 越界拒绝（/etc 写）
  {
    const t = await fs.resolve('/etc/dshssh-forbidden')
    let denied = false
    try { await fs.writeText(t, 'x') } catch (e) { denied = String(e).includes('outside allow-cwd') || String(e).includes('ENOENT') || String(e).includes('-32603') }
    check('allow-cwd 越界拒绝', denied)
  }

  await fiber.dispose()
  await ws.close()

  console.log(failures === 0 ? '\nEXTENDED SMOKE: ALL PASS' : `\nEXTENDED SMOKE: ${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

async function transportRemove(ctx, target) {
  const transport = ctx.sshTransport
  await transport.fsRemove(target.targetKey)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
