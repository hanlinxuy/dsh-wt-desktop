/**
 * dshssh exec-server — 自建 headless runtime（Node，零第三方 agent 依赖）。
 *
 * 在目标机上监听 WebSocket，暴露 process/* 与 fs/* JSON-RPC（协议形状与
 * `codex exec-server` 一致，因为 transport/测试都基于它；实现完全自建）：
 * 真实子进程生命周期（SIGTERM → grace → SIGKILL 阶梯）、带 seq 的输出缓冲、
 * stdin 写入、原子文件写入、目录/元数据/规范化/删除/复制，以及可选的
 * token 认证与工作目录白名单。
 *
 * 部署：`node exec-server.js --listen ws://127.0.0.1:8765 [--token xxx] [--allow-cwd /home/...]`
 * 单文件产物（ws 已打包），目标机只需要 Node。
 * @module @dsh-external/dshssh/exec-server
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'

function b64(text: Buffer | string): string {
  return Buffer.isBuffer(text) ? text.toString('base64') : Buffer.from(text, 'utf8').toString('base64')
}

function toAbsPath(value: unknown, allowCwd?: string): string {
  if (typeof value !== 'string') throw new Error('path must be a string')
  const p = value.startsWith('file:') ? fileURLToPath(value) : value
  const abs = resolve(p)
  if (allowCwd !== undefined) {
    const base = resolve(allowCwd)
    const rel = relative(base, abs)
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`path outside allow-cwd: ${abs}`)
    }
  }
  return abs
}

interface ManagedProcess {
  child: ChildProcess
  chunks: Array<{ seq: number; stream: string; chunk: string }>
  nextSeq: number
  exited: boolean
  exitCode: number | null
  stdinClosed: boolean
  graceMs: number
  killTimer: NodeJS.Timeout | null
}

export interface ExecServerOptions {
  /** ws://IP:PORT to listen on. */
  listen: string
  /** Optional bearer token; the client must pass it as `?token=` in the URL. */
  token?: string
  /** Optional workspace root; process cwd and fs paths must stay inside. */
  allowCwd?: string
  /** Grace period before SIGKILL when terminating (ms). */
  graceMs?: number
}

/**
 * Start the exec-server. Returns the actual URL (listening port resolved when
 * `0` was requested) and a close() handle.
 */
export async function startExecServer(options: ExecServerOptions): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const url = new URL(options.listen)
  const port = url.port === '' ? 0 : Number(url.port)
  const processes = new Map<string, ManagedProcess>()

  const wss = new WebSocketServer({
    port,
    host: url.hostname,
    ...(options.token !== undefined
      ? {
          verifyClient: (info: { req: { url?: string } }, done: (ok: boolean, code?: number, message?: string) => void) => {
            const query = new URL(info.req.url ?? '/', 'http://localhost').searchParams
            done(query.get('token') === options.token, 401, 'unauthorized')
          },
        }
      : {}),
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    wss.once('listening', resolveListen)
    wss.once('error', rejectListen)
  })
  const actualUrl = `ws://${url.hostname}:${(wss.address() as { port: number }).port}`

  wss.on('connection', (ws: WsSocket) => {

    const notify = (method: string, params: Record<string, unknown>) =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))

    const reply = (id: number, result: unknown) =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
    const fail = (id: number, code: number, message: string) =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))

    ws.on('message', (raw: unknown) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(String(raw)) } catch { return }

      switch (msg['method']) {
        case 'initialize': return reply(msg['id'] as number, {})
        case 'initialized': return // notification
        case 'process/start': {
          const params = msg['params'] as {
            processId?: string
            argv?: string[]
            cwd?: string
            env?: Record<string, string>
            pipeStdin?: boolean
            graceMs?: number
          }
          const processId = String(params.processId ?? randomUUID())
          const argv = Array.isArray(params.argv) ? params.argv.map(String) : []
          if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0) {
            return fail(msg['id'] as number, -32602, 'argv must be non-empty')
          }
          let cwd: string
          try { cwd = toAbsPath(params.cwd ?? process.cwd(), options.allowCwd) } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
          let child: ChildProcess
          try {
            child = spawn(argv[0]!, argv.slice(1), {
              cwd,
              env: { ...process.env, ...(params.env ?? {}) },
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          } catch (error) {
            return fail(msg['id'] as number, -32603, `spawn failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          const record: ManagedProcess = {
            child,
            chunks: [],
            nextSeq: 0,
            exited: false,
            exitCode: null,
            stdinClosed: false,
            graceMs: options.graceMs ?? 5000,
            killTimer: null,
          }
          processes.set(processId, record)

          const push = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
            const seq = ++record.nextSeq
            record.chunks.push({ seq, stream, chunk: b64(chunk) })
            notify('process/output', { processId, seq, stream, chunk: b64(chunk) })
          }
          if (child.stdout !== null) child.stdout.on('data', (d: Buffer) => push('stdout', d))
          if (child.stderr !== null) child.stderr.on('data', (d: Buffer) => push('stderr', d))
          child.on('close', (code) => {
            record.exited = true
            record.exitCode = code
            if (record.killTimer !== null) clearTimeout(record.killTimer)
            notify('process/exited', { processId, seq: ++record.nextSeq, exitCode: code, sandboxDenied: false })
            notify('process/closed', { processId, seq: ++record.nextSeq })
          })
          return reply(msg['id'] as number, { processId })
        }
        case 'process/read': {
          const params = msg['params'] as { processId?: string; afterSeq?: number | null; maxBytes?: number; waitMs?: number }
          const record = processes.get(String(params.processId))
          if (!record) return fail(msg['id'] as number, -32602, `unknown processId ${String(params.processId)}`)
          const from = typeof params.afterSeq === 'number' ? params.afterSeq : 0
          const chunks = record.chunks.filter((c) => c.seq > from).map((c) => ({ seq: c.seq, stream: c.stream, chunk: c.chunk }))
          return reply(msg['id'] as number, {
            chunks,
            nextSeq: record.nextSeq,
            exited: record.exited,
            exitCode: record.exited ? record.exitCode : null,
            closed: record.exited,
            failure: null,
          })
        }
        case 'process/write': {
          const params = msg['params'] as { processId?: string; chunk?: string }
          const record = processes.get(String(params.processId))
          if (!record) return fail(msg['id'] as number, -32602, `unknown processId ${String(params.processId)}`)
          if (typeof params.chunk !== 'string' || params.chunk.length === 0) {
            // Empty chunk = close stdin (our extension of the protocol).
            if (!record.stdinClosed && record.child.stdin !== null) {
              record.stdinClosed = true
              record.child.stdin.end()
            }
            return reply(msg['id'] as number, { status: 'accepted' })
          }
          if (record.child.stdin !== null) record.child.stdin.write(Buffer.from(params.chunk, 'base64'))
          return reply(msg['id'] as number, { status: 'accepted' })
        }
        case 'process/terminate': {
          const params = msg['params'] as { processId?: string }
          const record = processes.get(String(params.processId))
          if (!record || record.exited) return reply(msg['id'] as number, { running: false })
          const terminate = () => {
            if (record.exited) return
            record.child.kill('SIGTERM')
            record.killTimer = setTimeout(() => {
              if (!record.exited) record.child.kill('SIGKILL')
            }, record.graceMs)
          }
          terminate()
          return reply(msg['id'] as number, { running: true })
        }
        case 'fs/readFile': {
          try {
            const p = toAbsPath((msg['params'] as { path?: unknown }).path, options.allowCwd)
            const st = statSync(p)
            if (!st.isFile()) throw new Error(`not a regular file: ${p}`)
            return reply(msg['id'] as number, { path: pathToFileURL(p).href, dataBase64: b64(readFileSync(p)) })
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        case 'fs/writeFile': {
          try {
            const params = msg['params'] as { path?: unknown; dataBase64?: unknown }
            const p = toAbsPath(params.path, options.allowCwd)
            const content = Buffer.from(typeof params.dataBase64 === 'string' ? params.dataBase64 : '', 'base64')
            mkdirSync(dirnameOf(p), { recursive: true })
            const tmp = join(dirnameOf(p), `.dshssh-tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
            writeFileSync(tmp, content)
            renameSync(tmp, p)
            return reply(msg['id'] as number, { path: pathToFileURL(p).href })
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        case 'fs/readDirectory': {
          try {
            const p = toAbsPath((msg['params'] as { path?: unknown }).path, options.allowCwd)
            const entries = readdirSync(p, { withFileTypes: true }).map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory(),
              fileType: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
            }))
            return reply(msg['id'] as number, { entries })
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        case 'fs/getMetadata': {
          try {
            const p = toAbsPath((msg['params'] as { path?: unknown }).path, options.allowCwd)
            if (!existsSync(p)) return fail(msg['id'] as number, -32603, `ENOENT: ${p}`)
            const st = statSync(p)
            return reply(msg['id'] as number, {
              path: pathToFileURL(p).href,
              isFile: st.isFile(),
              isDirectory: st.isDirectory(),
              fileType: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other',
              size: st.size,
              mtimeMs: st.mtimeMs,
            })
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        case 'fs/remove': {
          try {
            const params = msg['params'] as { path?: unknown; recursive?: unknown }
            const p = toAbsPath(params.path, options.allowCwd)
            rmSync(p, { recursive: params.recursive === true, force: true })
            return reply(msg['id'] as number, {})
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        case 'fs/createDirectory': {
          try {
            const p = toAbsPath((msg['params'] as { path?: unknown }).path, options.allowCwd)
            mkdirSync(p, { recursive: true })
            return reply(msg['id'] as number, {})
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        case 'fs/canonicalize': {
          try {
            const p = toAbsPath((msg['params'] as { path?: unknown }).path, options.allowCwd)
            if (!existsSync(p)) throw new Error(`ENOENT: ${p}`)
            return reply(msg['id'] as number, { path: p })
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        case 'fs/copy': {
          try {
            const params = msg['params'] as { from?: unknown; to?: unknown }
            const from = toAbsPath(params.from, options.allowCwd)
            const to = toAbsPath(params.to, options.allowCwd)
            copyFileSync(from, to)
            return reply(msg['id'] as number, {})
          } catch (error) {
            return fail(msg['id'] as number, -32603, error instanceof Error ? error.message : String(error))
          }
        }
        default:
          return fail(msg['id'] as number, -32601, `unknown method ${String(msg['method'])}`)
      }
    })

    ws.on('close', () => {
      // Terminate processes owned by this connection (protocol contract).
      for (const [processId, record] of processes) {
        if (!record.exited) {
          record.child.kill('SIGTERM')
          setTimeout(() => { if (!record.exited) record.child.kill('SIGKILL') }, record.graceMs)
        }
        processes.delete(processId)
      }
    })
  })

  return {
    url: actualUrl,
    close: () => new Promise<void>((resolveClose) => {
      for (const record of processes.values()) {
        if (!record.exited) { record.child.kill('SIGKILL') }
      }
      processes.clear()
      wss.close(() => resolveClose())
    }),
  }
}

function dirnameOf(p: string): string {
  return dirname(p)
}

/** CLI entry: `node exec-server.js --listen ws://127.0.0.1:8765 [--token x|--token-file /path] [--allow-cwd /path]` */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i]!.replace(/^--/, ''), argv[i + 1] ?? '')
  const listen = args.get('listen') ?? 'ws://127.0.0.1:0'
  let token = args.get('token')
  const tokenFile = args.get('token-file')
  if (tokenFile !== undefined) {
    token = readFileSync(tokenFile, 'utf8').trim()
  }
  const allowCwd = args.get('allow-cwd')
  const graceMs = Number(args.get('grace-ms') ?? '5000')
  const { url } = await startExecServer({ listen, token, allowCwd, graceMs })
  // Machine-readable first line for deploy scripts (codex exec-server convention).
  process.stdout.write(`${url}\n`)
  process.stdout.write(`dshssh exec-server ready (allow-cwd: ${allowCwd ?? 'unrestricted'}, auth: ${token !== undefined ? 'token' : 'none'})\n`)
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]!.split('/').pop()!))) {
  void main().catch((error) => {
    console.error(`dshssh exec-server: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
