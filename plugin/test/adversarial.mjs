/**
 * adversarial.mjs — 对抗性测试：攻击 exec-server 协议 / 路径边界 / token /
 * 资源消耗 / HTTP API 输入。keyless（本地自建 runtime）。
 *
 * 用法: node test/adversarial.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { Context } from 'cordis'
import plugin from '../lib/index.js'
import { startExecServer } from '../lib/exec-server.js'
import { ExecTransport } from '../lib/index.js'
import { WebSocket } from 'ws'

let failures = 0
let findings = [] // real security/robustness findings
function check(name, condition, detail = '') {
  if (condition) { console.log(`  ok   ${name}`) } else { failures++; console.log(`  FAIL ${name} ${detail}`) }
}
function finding(name, detail) { findings.push({ name, detail }); console.log(`  ⚠  FINDING ${name}: ${detail}`) }

async function main() {
  const ws = await startExecServer({ listen: 'ws://127.0.0.1:0', token: 'adv-token', allowCwd: '/tmp/dshssh-adv', graceMs: 1000 })

  console.log('== 协议对抗 ==')

  // 1) 畸形 JSON
  {
    const outcome = await rawWs(ws.url, 'this is not json{{{')
    check('畸形 JSON 不崩溃', outcome !== 'crash', outcome)
  }
  // 2) 未知方法
  {
    const outcome = await rawRpc(ws.url, 'bogus/method', {}, 'adv-token')
    check('未知方法返回错误', outcome?.error !== undefined, JSON.stringify(outcome))
  }
  // 3) 无认证方法调用
  {
    const outcome = await rawRpc(ws.url, 'process/start', { processId: 'x', argv: ['echo', 'hi'] }, undefined)
    check('无 token 被拒', outcome === 'rejected' || outcome === null, String(outcome))
  }
  // 4) token 查询参数变体绕过（必须全部带错误值；仅精确正确值放行）
  {
    const variants = [
      `${ws.url}?token=adv-token`,            // 正确（应放行）
      `${ws.url}?token=ADV-TOKEN`,            // 大小写
      `${ws.url}?token=adv-tokenx`,           // 后缀
      `${ws.url}?token=adv-token%20`,         // 尾部空格
      `${ws.url}?token=evil&token=adv-token`, // 错误在前
      `${ws.url}`,                            // 无 token
      `${ws.url}?token=%61dv-token%20x`,      // 编码后仍错
    ]
    const allowed = []
    for (const v of variants) {
      const r = await rawRpc(v, 'initialize', {}, undefined).catch(() => 'rejected')
      if (r !== 'rejected' && r !== null && r.error === undefined) allowed.push(v.replace(ws.url, 'ws://'))
    }
    check('token 变体无法绕过（仅精确值放行）', allowed.length === 1 && allowed[0] === 'ws://?token=adv-token', JSON.stringify(allowed))
  }
  // 5) 重复 processId
  {
    const t = await ExecTransport.connectUrl(ws.url, 'adv-token')
    await t.rpc('process/start', { processId: 'dup', argv: ['true'], cwd: fileUrl('/tmp/dshssh-adv') })
    const second = await t.rpc('process/start', { processId: 'dup', argv: ['true'], cwd: fileUrl('/tmp/dshssh-adv') }).catch((e) => String(e))
    check('重复 processId 被拒', typeof second === 'string', String(second))
    t.close()
  }
  // 6) 缺少必填参数
  {
    const t = await ExecTransport.connectUrl(ws.url, 'adv-token')
    const r = await t.rpc('process/start', { processId: 'empty-argv', argv: [] }).catch((e) => String(e))
    check('空 argv 被拒', typeof r === 'string', String(r))
    t.close()
  }

  console.log('== 路径对抗（allow-cwd = /tmp/dshssh-adv） ==')
  const base = '/tmp/dshssh-adv'
  mkdirSync(base, { recursive: true })

  // 7) 路径穿越（检查文件实际落点）
  {
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, { url: ws.url, token: 'adv-token', cwd: base })
    await fiber
    const fs = ctx.fs
    rmSync('/tmp/dshssh-evil.txt', { force: true })
    rmSync(`${base}/..%2Fdshssh-evil.txt`, { force: true })
    const attempts = [`${base}/../dshssh-evil.txt`, `${base}/../../etc/dshssh-evil-etc`]
    for (const p of attempts) {
      try { await fs.writeText(await fs.resolve(p), 'evil') } catch { /* rejected */ }
    }
    const outside = execFileSync('sh', ['-c', 'ls /tmp/dshssh-evil.txt /etc/dshssh-evil-etc 2>/dev/null | wc -l']).toString().trim()
    check('路径穿越被拒（无越界落盘）', outside === '0', `outside files=${outside}`)
    await fiber.dispose()
  }

  // 8) 符号链接逃逸（工作区内 symlink 指向外部）
  {
    writeFileSync('/tmp/dshssh-secret.txt', 'TOP-SECRET')
    symlinkSync('/tmp/dshssh-secret.txt', `${base}/evil-link`)
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, { url: ws.url, token: 'adv-token', cwd: base })
    await fiber
    const fs = ctx.fs
    let leaked = false
    try {
      const text = await fs.readText(await fs.resolve(`${base}/evil-link`))
      leaked = text.includes('TOP-SECRET')
    } catch { /* rejected */ }
    if (leaked) finding('allow-cwd 符号链接逃逸', 'workspace 内 symlink 指向外部文件可被读取（v1: toAbsPath 只查字面路径）')
    check('符号链接逃逸被拒', !leaked)
    rmSync(`${base}/evil-link`, { force: true })
    rmSync('/tmp/dshssh-secret.txt', { force: true })
    await fiber.dispose()
  }

  console.log('== 资源对抗 ==')

  // 9) 输出洪泛（200MB 输出，collect 上限内）
  {
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, { url: ws.url, token: 'adv-token', cwd: base })
    await fiber
    const sub = ctx.subprocess
    const h = sub.spawn({ argv: ['sh', '-c', 'yes x | head -c 200000000'], cwd: base, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 3000 })
    const o = await h.done
    const read = h.collected.stdout?.readFrom(0)
    check('200MB 洪泛：退出码 0', o.exitCode === 0)
    check('200MB 洪泛：内存受限截断', (read?.text.length ?? 0) <= 200000, `len=${read?.text.length}`)
    await fiber.dispose()
  }

  // 10) 进程洪泛 + 断连清理（40 个进程后断 WS，服务端应清理）
  {
    const t = await ExecTransport.connectUrl(ws.url, 'adv-token')
    for (let i = 0; i < 40; i++) {
      await t.rpc('process/start', { processId: `flood-${i}`, argv: ['sleep', '60'], cwd: fileUrl(base) }).catch(() => {})
    }
    t.close() // 断连
    await new Promise((r) => setTimeout(r, 2000))
    const zombies = execFileSync('sh', ['-c', `ps aux | grep -c '[s]leep 60' || true`]).toString().trim()
    check('断连后服务端清理托管进程', Number(zombies) <= 2, `sleep60 进程数=${zombies}`)
  }

  console.log('== HTTP/命令面注入（本地 dev web 的 /api/dshssh/action） ==')
  // 11) runScript 的 host 参数是否可注入（spawn 用 argv 数组，不应走 shell）
  {
    const B = 'http://127.0.0.1:3080/api/dshssh'
    const probes = [
      { host: 'cudo-h100-node1-gateway; touch /tmp/dshssh-pwned', action: 'verify' },
      { host: '$(touch /tmp/dshssh-pwned2)', action: 'verify' },
    ]
    const r1 = await fetch(`${B}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probes[0]) }).catch(() => 'ERR')
    const r2 = await fetch(`${B}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probes[1]) }).catch(() => 'ERR')
    const pwned = execFileSync('sh', ['-c', 'ls /tmp/dshssh-pwned* 2>/dev/null | wc -l']).toString().trim()
    check('host 参数命令注入被拒', pwned === '0', `pwned files=${pwned}`)
    void r1; void r2
  }
  // 12) 坏 JSON / 未知 action
  {
    const B = 'http://127.0.0.1:3080/api/dshssh'
    const badJson = await fetch(`${B}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }).then((r) => r.status)
    const unknown = await fetch(`${B}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'x', action: 'rm -rf' }) }).then((r) => r.status)
    check('坏 JSON → 400', badJson === 400, String(badJson))
    check('未知 action → 400', unknown === 400, String(unknown))
  }

  await ws.close()
  console.log(`\n${findings.length} FINDINGS; ${failures} FAILURES`)
  if (findings.length > 0) {
    console.log('\nFINDINGS 明细:')
    for (const f of findings) console.log(`  - [${f.name}] ${f.detail}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

// --- helpers ---
function fileUrl(p) { return 'file://' + p }

async function rawWs(url, payload) {
  return new Promise((resolve) => {
    let w
    try {
      w = new WebSocket(url)
      w.on('open', () => { w.send(payload) })
      w.on('message', () => { resolve('responded'); w.close() })
      w.on('error', () => resolve('rejected'))
      setTimeout(() => { try { w.close() } catch {} resolve('no-response') }, 3000)
    } catch (e) { resolve('crash:' + e.message) }
  })
}

async function rawRpc(url, method, params, token) {
  return new Promise((resolve) => {
    let w
    try {
      const u = token !== undefined ? `${url}?token=${token}` : url
      w = new WebSocket(u)
      w.on('open', () => { w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })) })
      w.on('message', (d) => { resolve(JSON.parse(String(d))); w.close() })
      w.on('error', () => resolve('rejected'))
      w.on('close', () => setTimeout(() => resolve('no-response'), 500))
      setTimeout(() => { try { w.close() } catch {} resolve('no-response') }, 3000)
    } catch (e) { resolve('crash:' + e.message) }
  })
}

// Static helper so the test can open raw transports without the plugin.
ExecTransport.connectUrl = async function connectUrl(url, token) {
  const t = new ExecTransport(url, '/tmp', token)
  await t.connect()
  return t
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
