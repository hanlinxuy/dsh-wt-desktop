/**
 * test-fsbrowse.mjs — keyless 验证文件浏览/下载的传输+manager 管线。
 */
import { RemoteRuntimeManager, ExecTransport } from '../lib/index.js'
import { startExecServer } from '../lib/exec-server.js'

async function main() {
  const ws = await startExecServer({ listen: 'ws://127.0.0.1:0', token: 'fb', allowCwd: '/tmp/dshssh-fsbrowse' })
  const t = new ExecTransport(ws.url, '/tmp/dshssh-fsbrowse', 'fb')
  await t.connect()
  const mgr = new RemoteRuntimeManager(null, process.cwd())
  mgr.register('local', t, { cwd: '/tmp/dshssh-fsbrowse' })

  const tr = mgr.transportFor(null)
  console.log('defaultTransport:', tr !== null)
  const entries = await tr.fsListDir('/tmp/dshssh-fsbrowse')
  console.log('list:', JSON.stringify(entries))
  const bytes = await tr.fsReadBytes('/tmp/dshssh-fsbrowse/a.txt')
  console.log('read bytes:', JSON.stringify(bytes.toString('utf8').trim()), 'len:', bytes.length)
  const text = await tr.fsReadText('/tmp/dshssh-fsbrowse/a.txt')
  console.log('read text ok:', text.includes('file browser'))
  try {
    await tr.fsReadBytes('/etc/hosts')
    console.log('escape: BAD')
  } catch (e) {
    console.log('escape rejected:', String(e.message).slice(0, 50))
  }
  await ws.close()
  console.log('FS-BROWSE OK')
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
