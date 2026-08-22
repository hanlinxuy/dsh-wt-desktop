/**
 * smoke.mjs — 正向 seam 冒烟：在裸 cordis context 里挂载 @dsh-external/dshssh，
 * 通过 ctx.subprocess / ctx.fs 调用远端 exec-server（自建 headless runtime）。
 *
 * 用法:
 *   node test/smoke.mjs --local          # keyless：本机起真实自建 exec-server 再冒烟
 *   node test/smoke.mjs --token          # 同上 + token 认证与白名单探针
 *   node test/smoke.mjs                  # 远端冒烟（host homelinux2, 端口 8765/8876）
 *   DSSH_SMOKE_URL=ws://... node test/smoke.mjs   # 直连指定 exec-server
 */
import { Context } from 'cordis'
import plugin from '../lib/index.js'
import { startExecServer } from '../lib/exec-server.js'

const host = process.env.DSSH_SMOKE_HOST ?? 'homelinux2'
const remoteExecPort = Number(process.env.DSSH_SMOKE_REMOTE_PORT ?? 8765)
const localTunnelPort = Number(process.env.DSSH_SMOKE_LOCAL_PORT ?? 8876)
const remoteToken = process.env.DSSH_SMOKE_TOKEN
const smokeCwd = process.env.DSSH_SMOKE_CWD ?? '/tmp'

const useLocal = process.argv.includes('--local')
const useToken = process.argv.includes('--token')
let server
let token

if (useLocal) {
  token = useToken ? 'dshssh-test-token' : undefined
  server = await startExecServer({
    listen: 'ws://127.0.0.1:0',
    token,
    allowCwd: '/tmp',
    graceMs: 2000,
  })
  console.log(`self-built exec-server at ${server.url}${token !== undefined ? ' (token-auth)' : ''}`)
}

const effectiveToken = token ?? remoteToken
const config = process.env.DSSH_SMOKE_URL ?? server?.url
  ? { url: process.env.DSSH_SMOKE_URL ?? server.url, cwd: smokeCwd, ...(effectiveToken !== undefined ? { token: effectiveToken } : {}) }
  : { host, remoteExecPort, localTunnelPort, cwd: smokeCwd, ...(effectiveToken !== undefined ? { token: effectiveToken } : {}) }

const ctx = new Context()
const fiber = ctx.plugin(plugin, config)
await fiber
try {
  const sub = ctx.subprocess

  // 1) uname -a 走远端
  const handle = sub.spawn({
    argv: ['uname', '-a'],
    cwd: smokeCwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
    graceMs: 5000,
  })
  const outcome = await handle.done
  const text = handle.collected.stdout?.readFrom(0).text ?? ''
  console.log('exitCode =', outcome.exitCode)
  console.log('stdout   =', text.trim())
  if (outcome.exitCode !== 0 || text.trim().length === 0) throw new Error('uname probe failed')

  // 2) env 透传 + shell 执行
  const handle2 = sub.spawn({
    argv: ['sh', '-c', 'echo "probe-$DSSH_PROBE"'],
    cwd: smokeCwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 5000,
    env: { DSSH_PROBE: 'ok' },
  })
  const o2 = await handle2.done
  const t2 = handle2.collected.stdout?.readFrom(0).text ?? ''
  console.log('env probe =', t2.trim())
  if (o2.exitCode !== 0 || !t2.includes('probe-ok')) throw new Error('env probe failed')

  // 3) 退出码非零探针（远端返回 7）
  const handle3 = sub.spawn({
    argv: ['sh', '-c', 'exit 7'],
    cwd: smokeCwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 5000,
  })
  const o3 = await handle3.done
  console.log('exit-code probe =', o3.exitCode)
  if (o3.exitCode !== 7) throw new Error('exit-code probe failed')

  // TODO(v2): stdin {data} 批输入 —— exec-server 无 stdin-EOF 语义，需补充协议或 mock 端处理。

  // 4) fs 缝：写/读/stat/edit/list 全走远端（mock 下即本机临时文件）
  const fs = ctx.fs
  const fsProbe = smokeCwd + '/dshssh-fs-probe.txt'
  const target = await fs.resolve(fsProbe)
  const wrote = await fs.writeText(target, 'hello dshssh\n')
  const readBack = await fs.readText(target)
  const st = await fs.stat(target)
  const edited = await fs.editText(target, { oldString: 'hello', newString: 'HELLO', replaceAll: false })
  const readEdited = await fs.readText(target)
  const listing = await fs.listDir(await fs.resolve(smokeCwd))
  console.log('fs write op  =', wrote.operation, 'version =', wrote.version)
  console.log('fs readBack  =', JSON.stringify(readBack))
  console.log('fs stat      =', st?.type, st?.size)
  console.log('fs edit      =', JSON.stringify(edited.after))
  console.log('fs list has probe =', listing.some((entry) => entry.name === 'dshssh-fs-probe.txt'))
  if (readBack !== 'hello dshssh\n') throw new Error('fs write/read failed')
  if (st?.type !== 'file') throw new Error('fs stat failed')
  if (readEdited !== 'HELLO dshssh\n') throw new Error('fs edit failed')
  if (!listing.some((entry) => entry.name === 'dshssh-fs-probe.txt')) throw new Error('fs list failed')
  const { rmSync } = await import('node:fs')
  rmSync(fsProbe, { force: true })

  console.log('SMOKE OK — ctx.subprocess + ctx.fs run on the remote headless runtime')

  // 5) token 认证（--token 模式）：无 token 连接必须失败（竞速探测，兼容 undici 关闭语义）
  if (useToken) {
    const { ExecTransport } = await import('../lib/index.js')
    const bad = new ExecTransport(server.url, '/tmp')
    const outcome = await Promise.race([
      bad.connect().then(() => 'connected', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
    ])
    console.log(`token probe: unauthorized -> ${outcome}`)
    if (outcome === 'connected') throw new Error('token probe failed: unauthorized connect succeeded')
    bad.close()
  }
} finally {
  await fiber.dispose()
  await server?.close()
}
