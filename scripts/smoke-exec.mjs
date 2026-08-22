#!/usr/bin/env node
/**
 * smoke-exec.mjs — minimal `codex exec-server` WebSocket JSON-RPC client.
 *
 * Exercises the documented exec-server protocol (initialize/initialized,
 * process/start|read|terminate, fs/writeFile|readFile) against any
 * codex exec-server endpoint. Doubles as the reference client that the
 * dshssh DSH plugin's remote_exec / remote_fs tools will build on.
 *
 * Requires Node >= 22 (global WebSocket). Transport is one JSON-RPC message
 * per WebSocket message (local-ws framing).
 *
 * Usage:
 *   node smoke-exec.mjs [--url ws://host:port] [--cwd /abs/dir]
 *                       [--fs-write /abs/probe-file] [--timeout-ms N] -- <cmd...>
 *
 * Env fallback: CODEX_EXEC_SERVER_URL
 * Exit code: 0 on success, 1 on RPC/process failure, 2 on usage error.
 */
import { pathToFileURL } from 'node:url'

const DEFAULT_URL = process.env.CODEX_EXEC_SERVER_URL || 'ws://127.0.0.1:8765'

function usage() {
  console.error(`usage: node smoke-exec.mjs [--url ws://host:port] [--cwd /abs/dir] [--fs-write /abs/path] [--timeout-ms N] -- <argv...>`)
}

function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, cwd: null, fsWrite: null, timeoutMs: 30000 }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') { opts.argv = argv.slice(i + 1); return opts }
    if (a === '--url') { opts.url = argv[++i]; i++; continue }
    if (a === '--cwd') { opts.cwd = argv[++i]; i++; continue }
    if (a === '--fs-write') { opts.fsWrite = argv[++i]; i++; continue }
    if (a === '--timeout-ms') { opts.timeoutMs = Number(argv[++i]); i++; continue }
    console.error(`smoke-exec: unknown option ${a}`); usage(); process.exit(2)
  }
  opts.argv = []
  return opts
}

function b64encode(text) { return Buffer.from(text, 'utf8').toString('base64') }
function b64decode(b64) { return Buffer.from(b64, 'base64').toString('utf8') }

class ExecServerClient {
  constructor(url, timeoutMs = 30000) {
    this.url = url
    this.timeoutMs = timeoutMs
    this.id = 0
    this.pending = new Map()
    this.out = [] // { stream, text }
    this.exited = null // { seq, exitCode, sandboxDenied }
    this.closed = false
    this.lastSeq = 0
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connect timeout: ${this.url}`)), this.timeoutMs)
      this.ws.onopen = () => { clearTimeout(timer); resolve() }
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error(`websocket error: ${this.url}`)) }
    })
    this.ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)))
  }

  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`rpc ${msg.error.code}: ${msg.error.message}`))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'process/output') {
      this.lastSeq = Math.max(this.lastSeq, msg.params.seq || 0)
      if (msg.params.chunk) this.out.push({ stream: msg.params.stream, text: b64decode(msg.params.chunk) })
    } else if (msg.method === 'process/exited') {
      this.exited = msg.params
    } else if (msg.method === 'process/closed') {
      this.closed = true
    }
  }

  rpc(method, params) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)) }, this.timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
    })
  }

  notify(method, params) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }))
  }

  async handshake(clientName) {
    await this.rpc('initialize', { clientName })
    this.notify('initialized')
  }

  async runProcess(processId, argv, cwdUrl, env) {
    const result = await this.rpc('process/start', {
      processId, argv, cwd: cwdUrl, env, tty: false, pipeStdin: false, arg0: null,
    })
    // Wait for exit notification; then drain buffered output with process/read.
    const deadline = Date.now() + this.timeoutMs
    while (this.exited === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    if (this.exited === null) throw new Error(`process ${processId} did not exit within timeout`)
    const drain = await this.rpc('process/read', { processId, afterSeq: this.lastSeq, maxBytes: 1 << 20, waitMs: 500 })
    for (const chunk of drain.chunks ?? []) {
      if (chunk.chunk) this.out.push({ stream: chunk.stream, text: b64decode(chunk.chunk) })
    }
    return { ...result, exitCode: this.exited.exitCode, out: this.out }
  }

  async writeFile(absPath, content) {
    const uri = pathToFileURL(absPath).href
    await this.rpc('fs/writeFile', { path: uri, dataBase64: b64encode(content) })
    const read = await this.rpc('fs/readFile', { path: uri })
    const raw = read.dataBase64 ?? read.data
    return { uri, written: content, read: b64decode(raw) }
  }

  close() { try { this.ws.close() } catch {} }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const argv = opts.argv.length > 0 ? opts.argv : ['uname', '-a']
  const cwdUrl = opts.cwd ? pathToFileURL(opts.cwd).href : pathToFileURL(process.env.HOME || '/tmp').href
  const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: opts.cwd || process.env.HOME || '/tmp' }

  const client = new ExecServerClient(opts.url, opts.timeoutMs)
  let exitCode = 0
  try {
    await client.connect()
    await client.handshake('dshssh-smoke')

    const run = await client.runProcess('smoke-1', argv, cwdUrl, env)
    for (const { stream, text } of run.out) {
      if (stream === 'stderr') process.stderr.write(text)
      else process.stdout.write(text)
    }
    console.error(`smoke-exec: exited=${run.exitCode}`)
    if (run.exitCode !== 0) exitCode = 1

    if (opts.fsWrite) {
      const probe = `dshssh probe ${new Date().toISOString()}\n`
      const fs = await client.writeFile(opts.fsWrite, probe)
      console.error(`smoke-exec: fs roundtrip ok -> ${fs.uri}`)
      if (fs.read !== probe) { console.error('smoke-exec: fs roundtrip mismatch'); exitCode = 1 }
    }
  } catch (err) {
    console.error(`smoke-exec: FAILED: ${err.message}`)
    exitCode = 1
  } finally {
    client.close()
  }
  process.exit(exitCode)
}

main()
