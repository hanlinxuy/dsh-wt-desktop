/**
 * RemoteRuntimeManager — runtime connection registry + script orchestration
 * for the dshssh GUI/commands surface. Manages one exec-server transport per
 * host (auto-connected via ssh -L), and shells out to the deploy/verify
 * scripts for provisioning.
 * @module @dsh-external/dshssh/manager
 */
import { spawn } from 'node:child_process'
import { ExecTransport } from './transport.ts'
import type { Context } from 'cordis'

export interface ManagedHost {
  name: string
  state: 'connecting' | 'ready' | 'error' | 'offline'
  remoteExecPort: number
  localTunnelPort: number
  token?: string
  cwd: string
  transport: ExecTransport | null
  logs: Array<{ at: string; level: 'info' | 'ok' | 'warn' | 'error'; text: string }>
  lastError?: string
}

const MAX_LOGS = 200

export class RemoteRuntimeManager {
  private hosts = new Map<string, ManagedHost>()

  constructor(private readonly ctx: Context, private readonly scriptsRoot: string) {}

  list(): ManagedHost[] {
    return [...this.hosts.values()]
  }

  get(name: string): ManagedHost | undefined {
    return this.hosts.get(name)
  }

  private log(host: ManagedHost, level: ManagedHost['logs'][number]['level'], text: string): void {
    host.logs.push({ at: new Date().toISOString(), level, text })
    if (host.logs.length > MAX_LOGS) host.logs.splice(0, host.logs.length - MAX_LOGS)
  }

  /** Adopt an existing transport (e.g. the config-driven seam connection) into the registry. */
  register(name: string, transport: ExecTransport, options: { cwd?: string; remoteExecPort?: number; localTunnelPort?: number; token?: string } = {}): ManagedHost {
    const record: ManagedHost = {
      name,
      state: 'ready',
      remoteExecPort: options.remoteExecPort ?? 8765,
      localTunnelPort: options.localTunnelPort ?? 8876,
      token: options.token,
      cwd: options.cwd ?? '/tmp',
      transport,
      logs: [],
    }
    this.hosts.set(name, record)
    return record
  }

  /** Connect one host: spawn ssh -L + handshake with the remote exec-server. */
  async connect(host: string, options: { remoteExecPort?: number; localTunnelPort?: number; token?: string; cwd?: string } = {}): Promise<ManagedHost> {
    const existing = this.hosts.get(host)
    if (existing?.state === 'ready' && existing.transport !== null) return existing
    const record: ManagedHost = {
      name: host,
      state: 'connecting',
      remoteExecPort: options.remoteExecPort ?? 8765,
      localTunnelPort: options.localTunnelPort ?? 8876,
      token: options.token,
      cwd: options.cwd ?? '/tmp',
      transport: null,
      logs: existing?.logs ?? [],
    }
    this.hosts.set(host, record)
    this.log(record, 'info', `connecting: ssh -L ${record.localTunnelPort} -> ${host}:${record.remoteExecPort}`)
    try {
      const transport = await ExecTransport.viaTunnel(host, record.remoteExecPort, record.localTunnelPort, 20000, record.cwd, record.token)
      record.transport = transport
      record.state = 'ready'
      this.log(record, 'ok', `connected: ${transport.url}`)
    } catch (error) {
      record.state = 'error'
      record.lastError = error instanceof Error ? error.message : String(error)
      this.log(record, 'error', `connect failed: ${record.lastError}`)
    }
    return record
  }

  /** Disconnect one host (close tunnel + transport). */
  disconnect(host: string): void {
    const record = this.hosts.get(host)
    if (record === undefined) return
    record.transport?.close()
    record.transport = null
    record.state = 'offline'
    this.log(record, 'info', 'disconnected')
  }

  /** Smoke one host through its transport (uname on the remote). */
  async smoke(host: string): Promise<string> {
    const record = await this.connect(host)
    if (record.transport === null) throw new Error(`no transport for ${host}`)
    const result = await record.transport.runCollect(['uname', '-a'], record.cwd, {})
    const text = result.out.map((c) => c.text).join('').trim()
    this.log(record, result.exitCode === 0 ? 'ok' : 'error', `smoke: ${text || `<exit ${String(result.exitCode)}>`}`)
    return text
  }

  /** Run one dshssh provisioning script against a host, streaming output to logs. */
  runScript(kind: 'deploy' | 'verify', host: string): Promise<number> {
    const script = kind === 'deploy' ? 'deploy-remote.sh' : 'verify-remote.sh'
    const record = this.hosts.get(host) ?? { name: host, state: 'connecting' as const, remoteExecPort: 8765, localTunnelPort: 8876, cwd: '/tmp', transport: null, logs: [] }
    if (!this.hosts.has(host)) this.hosts.set(host, record)
    this.log(record, 'info', `running scripts/${script} ${host}`)
    return new Promise<number>((resolve) => {
      const child = spawn('bash', [this.scriptsRoot + `/scripts/${script}`, host], { stdio: ['ignore', 'pipe', 'pipe'] })
      const push = (level: 'info' | 'ok' | 'error', chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          const trimmed = line.trim()
          if (trimmed.length > 0) this.log(record, level, trimmed)
        }
      }
      child.stdout.on('data', (d: Buffer) => push('info', d))
      child.stderr.on('data', (d: Buffer) => push('error', d))
      child.on('close', (code) => {
        this.log(record, code === 0 ? 'ok' : 'error', `${kind} finished (exit ${String(code)})`)
        if (record.state === 'connecting') record.state = code === 0 ? 'ready' : 'error'
        resolve(code ?? 1)
      })
    })
  }

  dispose(): void {
    for (const record of this.hosts.values()) {
      record.transport?.close()
    }
    this.hosts.clear()
  }
}
