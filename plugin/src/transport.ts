/**
 * ExecTransport — WebSocket JSON-RPC client for `codex exec-server`
 * (deployed headless runtime on the target, loopback-only, reached through an
 * SSH local forward). Ported from the verified scripts/smoke-exec.mjs protocol
 * (process/* and fs/* methods), plus tunnel lifecycle management.
 *
 * The remote `codex exec-server` is the "headless runtime" this project
 * deploys (scripts/deploy-remote.sh + systemd unit); this module is the local
 * brain's transport to it. Node >= 22 (global WebSocket).
 * @module @dsh-external/dshssh/transport
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Minimal global WebSocket surface (Node 22 global; avoids DOM lib). */
declare const WebSocket: {
  new (url: string): WebSocketClient
} | undefined

interface WebSocketClient {
  readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
}

export interface ExecOutputChunk {
  stream: 'stdout' | 'stderr' | 'pty'
  text: string
}

export interface ExecProcessResult {
  exitCode: number | null
  output: ExecOutputChunk[]
}

export class ExecTransportError extends Error {}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function b64decode(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8')
}

/** Wait until a local TCP port accepts connections (tunnel readiness). */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    if (Date.now() > deadline) throw new ExecTransportError(`tunnel port ${port} not listening within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * One exec-server connection. Owns the WebSocket, the JSON-RPC id/pending
 * table, per-process output/exit event dispatch, and the optional SSH tunnel
 * it was opened through.
 */
export class ExecTransport {
  readonly url: string
  /** Default remote working directory for relative-path resolution. */
  readonly cwd: string
  private ws: WebSocketClient | null = null
  private id = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private processSeq = 0
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  private tunnel: ChildProcess | null = null

  constructor(url: string, cwd = '/tmp', token?: string) {
    this.url = token === undefined || token.length === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    this.cwd = cwd
  }

  /** Open an SSH local forward and return a transport targeting it. */
  static async viaTunnel(
    host: string,
    remotePort: number,
    localPort: number,
    timeoutMs = 20000,
    cwd = '/tmp',
    token?: string,
  ): Promise<ExecTransport> {
    const child = spawn('ssh', [
      '-N', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-L', `${localPort}:127.0.0.1:${remotePort}`, host,
    ], { stdio: 'ignore' })
    const transport = new ExecTransport(`ws://127.0.0.1:${localPort}`, cwd, token)
    transport.tunnel = child
    // Never orphan the tunnel: kill it when this process exits.
    const killTunnel = () => { try { child.kill() } catch { /* ignore */ } }
    process.once('exit', killTunnel)
    process.once('SIGINT', killTunnel)
    process.once('SIGTERM', killTunnel)
    child.once('exit', (code) => { if (transport.ws === null) transport.emit('tunnel-exit', { code }) })
    try {
      await waitForPort(localPort, timeoutMs)
    } catch (error) {
      child.kill()
      throw error
    }
    try {
      await transport.connect(timeoutMs)
    } catch (error) {
      transport.close()
      throw error
    }
    return transport
  }

  /** Establish the WebSocket + JSON-RPC handshake (initialize / initialized). */
  async connect(timeoutMs = 15000): Promise<void> {
    const WS = globalThis.WebSocket as unknown as typeof WebSocket | undefined
    if (WS === undefined) throw new ExecTransportError('global WebSocket unavailable (need Node >= 22)')
    const ws = new WS(this.url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ExecTransportError(`connect timeout: ${this.url}`)), timeoutMs)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new ExecTransportError(`websocket error: ${this.url}`)) }
    })
    ws.onmessage = (ev) => this.dispatch(JSON.parse(String(ev.data)))
    await this.rpc('initialize', { clientName: '@dsh-external/dshssh' })
    this.notify('initialized', {})
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg['id']
    if (typeof id === 'number' && this.pending.has(id)) {
      const { resolve, reject } = this.pending.get(id)!
      this.pending.delete(id)
      if (msg['error'] !== undefined) {
        const err = msg['error'] as { code?: unknown; message?: unknown }
        reject(new ExecTransportError(`rpc ${String(err.code)}: ${String(err.message)}`))
      } else {
        resolve(msg['result'])
      }
      return
    }
    if (typeof msg['method'] === 'string') {
      this.emit(msg['method'], (msg['params'] ?? {}) as Record<string, unknown>)
    }
  }

  rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(event)
    if (set === undefined) { set = new Set(); this.listeners.set(event, set) }
    set.add(handler)
    return () => set?.delete(handler)
  }

  private emit(event: string, params: Record<string, unknown>): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try { handler(params) } catch { /* listener errors are isolated */ }
    }
  }

  newProcessId(): string {
    return `dshssh-${++this.processSeq}`
  }

  /** process/start — spawn one managed process on the remote. */
  async startProcess(
    processId: string,
    argv: readonly string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<void> {
    await this.rpc('process/start', {
      processId,
      argv: [...argv],
      cwd: pathToFileURL(cwd).href,
      env,
      tty: false,
      pipeStdin: true,
      arg0: null,
    })
  }

  /** process/read — drain buffered output since afterSeq. */
  async readProcess(processId: string, afterSeq: number | null, maxBytes = 1 << 20, waitMs = 500): Promise<{
    chunks: Array<{ seq?: number; stream?: string; chunk?: string }>
    nextSeq?: number
    exited?: boolean
    exitCode?: number | null
  }> {
    return (await this.rpc('process/read', {
      processId, afterSeq, maxBytes, waitMs,
    })) as {
      chunks: Array<{ seq?: number; stream?: string; chunk?: string }>
      nextSeq?: number
      exited?: boolean
      exitCode?: number | null
    }
  }

  /** process/write — write base64 bytes to a pipeStdin process. */
  async writeStdin(processId: string, chunkBase64: string): Promise<void> {
    await this.rpc('process/write', { processId, chunk: chunkBase64 })
  }

  /** process/terminate — stop one managed process. */
  async terminateProcess(processId: string): Promise<{ running: boolean }> {
    return (await this.rpc('process/terminate', { processId })) as { running: boolean }
  }

  /** fs/readFile → utf8 text. */
  async fsReadText(absPath: string): Promise<string> {
    const result = await this.rpc('fs/readFile', { path: pathToFileURL(absPath).href })
    const raw = (result as { dataBase64?: string; data?: string }).dataBase64 ?? (result as { data?: string }).data
    return b64decode(raw ?? '')
  }

  /** fs/writeFile (atomic-ish; exec-server writes through its fs layer). */
  async fsWriteText(absPath: string, content: string): Promise<void> {
    await this.rpc('fs/writeFile', { path: pathToFileURL(absPath).href, dataBase64: b64encode(content) })
  }

  /** fs/readDirectory → entries with name + type. */
  async fsListDir(absPath: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const result = await this.rpc('fs/readDirectory', { path: pathToFileURL(absPath).href })
    const entries = (result as { entries?: Array<{ name?: string; isDirectory?: boolean; fileType?: string }> }).entries ?? []
    return entries
      .map((entry) => ({
        name: entry.name ?? '',
        isDirectory: entry.isDirectory ?? entry.fileType === 'directory',
      }))
      .filter((entry) => entry.name.length > 0)
  }

  /** fs/getMetadata → { isFile, isDirectory, size, mtimeMs? }. */
  async fsStat(absPath: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMs?: number }> {
    const result = await this.rpc('fs/getMetadata', { path: pathToFileURL(absPath).href })
    const meta = result as {
      isFile?: boolean
      isDirectory?: boolean
      size?: number
      fileType?: string
      modifiedAt?: string | number
      mtimeMs?: number
      mtime?: number
    }
    let mtimeMs: number | undefined
    if (typeof meta.mtimeMs === 'number') mtimeMs = meta.mtimeMs
    else if (typeof meta.mtime === 'number') mtimeMs = meta.mtime
    else if (typeof meta.modifiedAt === 'number') mtimeMs = meta.modifiedAt
    else if (typeof meta.modifiedAt === 'string') mtimeMs = Date.parse(meta.modifiedAt) || undefined
    return {
      isFile: meta.isFile ?? meta.fileType === 'file',
      isDirectory: meta.isDirectory ?? meta.fileType === 'directory',
      size: meta.size ?? 0,
      mtimeMs,
    }
  }

  /** fs/canonicalize → canonical absolute path (or throws). */
  async fsCanonicalize(absPath: string): Promise<string> {
    const result = await this.rpc('fs/canonicalize', { path: pathToFileURL(absPath).href })
    const raw = (result as { path?: string }).path ?? ''
    if (raw.startsWith('file:')) return fileURLToPath(raw)
    return raw
  }

  /** fs/remove — delete a file or directory (recursive flag when supported). */
  async fsRemove(absPath: string, recursive = false): Promise<void> {
    await this.rpc('fs/remove', { path: pathToFileURL(absPath).href, recursive })
  }

  /** fs/createDirectory. */
  async fsMkdir(absPath: string): Promise<void> {
    await this.rpc('fs/createDirectory', { path: pathToFileURL(absPath).href })
  }

  /** Run a short command to completion, collecting all output (probe helper). */
  async runCollect(argv: readonly string[], cwd: string, env: Record<string, string>, timeoutMs = 15000): Promise<{
    exitCode: number | null
    out: ExecOutputChunk[]
  }> {
    const processId = this.newProcessId()
    const chunks: ExecOutputChunk[] = []
    let lastSeq = 0
    const offOutput = this.on('process/output', (params) => {
      if (params['processId'] === processId && typeof params['chunk'] === 'string') {
        lastSeq = Math.max(lastSeq, typeof params['seq'] === 'number' ? params['seq'] : 0)
        chunks.push({ stream: (params['stream'] as ExecOutputChunk['stream']) ?? 'stdout', text: b64decode(params['chunk']) })
      }
    })
    const offExit = this.on('process/exited', (params) => { if (params['processId'] === processId) exited = params })
    let exited: Record<string, unknown> | null = null
    await this.startProcess(processId, argv, cwd, env)
    const deadline = Date.now() + timeoutMs
    while (exited === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    offOutput(); offExit()
    let exitCode: number | null = null
    if (exited !== null) exitCode = (exited['exitCode'] as number | undefined) ?? null
    if (exited === null) { await this.terminateProcess(processId).catch(() => {}) }
    try {
      const drain = await this.readProcess(processId, lastSeq, 1 << 20, 300)
      for (const chunk of drain.chunks ?? []) {
        if (chunk.chunk !== undefined) chunks.push({ stream: (chunk.stream as ExecOutputChunk['stream']) ?? 'stdout', text: b64decode(chunk.chunk) })
      }
    } catch { /* best effort */ }
    return { exitCode, out: chunks }
  }

  /** Close the WebSocket and kill the tunnel (if owned). */
  close(): void {
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    if (this.tunnel !== null) {
      try { this.tunnel.kill() } catch { /* ignore */ }
      this.tunnel = null
    }
  }
}
