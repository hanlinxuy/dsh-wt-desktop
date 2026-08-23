/**
 * built-bin.spec.ts — 「测真实入口路径」（上游 dsh 铁律）：用 plain node 启动
 * 构建后的 lib/exec-server.js 子进程，走 CLI + 真实协议探测，暴露 tsx/构建
 * 掩盖的问题（模块解析、main 检测、CLI 参数）。
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const EXEC_SERVER = fileURLToPath(new URL('../lib/exec-server.js', import.meta.url))

interface ServerProc { port: number; kill: () => void }

async function startCliServer(token: string, allowCwd: string): Promise<ServerProc> {
  return await new Promise((resolve, reject) => {
    const port = 18000 + Math.floor(Math.random() * 2000)
    const child = spawn(process.execPath, [EXEC_SERVER, '--listen', `ws://127.0.0.1:${port}`, '--token', token, '--allow-cwd', allowCwd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += String(d) })
    child.stderr.on('data', () => { /* keep quiet */ })
    child.on('error', reject)
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10000)
    const probe = setInterval(() => {
      if (out.includes('ready')) {
        clearTimeout(timer); clearInterval(probe)
        resolve({ port, kill: () => child.kill('SIGKILL') })
      }
    }, 100)
  })
}

function rpc(port: number, token: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`)
    w.on('open', () => w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })))
    w.on('message', (d) => { resolve(JSON.parse(String(d))); w.close() })
    w.on('error', () => resolve('rejected'))
    setTimeout(() => { try { w.close() } catch { /* */ } resolve('no-response') }, 5000)
  })
}

describe('built lib/exec-server.js（真实入口路径）', () => {
  it('CLI 启动 + 进程/fs RPC 往返', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshssh-bin-'))
    writeFileSync(join(dir, 'hello.txt'), 'bin-test')
    const server = await startCliServer('bin-token', dir)
    try {
      const init = await rpc(server.port, 'bin-token', 'initialize', { clientName: 'built-bin-spec' })
      expect((init as { result?: unknown }).result).toBeDefined()
      const run = await rpc(server.port, 'bin-token', 'process/start', { processId: 'p1', argv: ['sh', '-c', 'echo bin-ok'], cwd: 'file://' + dir })
      expect((run as { result?: { processId?: string } }).result?.processId).toBe('p1')
      const read = await rpc(server.port, 'bin-token', 'fs/readFile', { path: 'file://' + join(dir, 'hello.txt') })
      const raw = (read as { result?: { dataBase64?: string } }).result?.dataBase64 ?? ''
      expect(Buffer.from(raw, 'base64').toString('utf8')).toBe('bin-test')
    } finally {
      server.kill()
    }
  })

  it('无 token 拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshssh-bin-'))
    const server = await startCliServer('bin-token', dir)
    try {
      const r = await new Promise<string>((resolve) => {
        const w = new WebSocket(`ws://127.0.0.1:${server.port}`)
        w.on('open', () => resolve('connected'))
        w.on('error', () => resolve('rejected'))
        setTimeout(() => { try { w.close() } catch { /* */ } resolve('no-response') }, 3000)
      })
      expect(r).toBe('rejected')
    } finally {
      server.kill()
    }
  })
})
