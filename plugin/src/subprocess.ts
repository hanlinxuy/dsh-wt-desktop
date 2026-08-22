/**
 * RemoteSubprocessRuntime — `ctx.subprocess` seam provider routing spawns to
 * the remote `codex exec-server` (the deployed headless runtime) through an
 * ExecTransport. Self-built; dsh-ssh's ssh2 adapter was read as an MIT
 * reference for the seam shape only.
 *
 * v1 semantics (documented deviations from the local backend):
 * - collect-mode stdout/stderr: offset-based readers fed by process/output
 *   notifications + a final process/read drain (bounded in-memory, lossy
 *   reads, no spill files yet);
 * - stdin: 'ignore' | { data } | 'pipe' (Writable → process/write);
 * - termination: single process/terminate verb (no SIGTERM→grace→SIGKILL
 *   ladder — the exec-server terminates the managed process);
 * - pid: synthetic local id (the remote pid is not exposed by the server);
 * - spawnTerminal: not implemented yet (throws).
 * @module @dsh-external/dshssh/subprocess
 */
import { PassThrough, Writable } from 'node:stream'
import * as SubprocessModule from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { Context } from 'cordis'
import type { ExecTransport } from './transport.ts'

/**
 * Version-agnostic base class: the seam's abstract service is named
 * `SubprocessRuntime` in dsh 0.1.0-rc.7 and `SubprocessService` in the
 * upstream 0.0.1 snapshot — same spec/handle types, different class name.
 */
const SubprocessBase: new (ctx: Context) => SubprocessModuleSubprocessRuntime =
  (SubprocessModule as unknown as {
    SubprocessRuntime?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
    SubprocessService?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
    default?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
  }).SubprocessRuntime
  ?? (SubprocessModule as unknown as {
    SubprocessRuntime?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
    SubprocessService?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
    default?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
  }).SubprocessService
  ?? (SubprocessModule as unknown as {
    SubprocessRuntime?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
    SubprocessService?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
    default?: new (ctx: Context) => SubprocessModuleSubprocessRuntime
  }).default!

/** The abstract seam surface we extend (both versions). */
interface SubprocessModuleSubprocessRuntime {
  readonly ctx: Context
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<never>
}

const BASE_ENV: Record<string, string> = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Per-stream bounded tail buffer with whole-stream byte offsets. */
class StreamBuffer {
  private chunks: Array<{ start: number; text: string }> = []
  private retainedStart = 0
  private end = 0
  private total = 0

  get byteLength(): number {
    return this.end - this.retainedStart
  }

  append(text: string, maxBytes: number): void {
    this.chunks.push({ start: this.end, text })
    this.end += Buffer.byteLength(text)
    this.total += Buffer.byteLength(text)
    // Drop from the head while over cap (keep the TAIL).
    while (this.end - this.retainedStart > maxBytes && this.chunks.length > 1) {
      const head = this.chunks[0]
      this.chunks.shift()
      this.retainedStart = head.start + Buffer.byteLength(head.text)
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const lossy = fromByte < this.retainedStart
    const start = lossy ? this.retainedStart : fromByte
    let text = ''
    for (const chunk of this.chunks) {
      const chunkStart = chunk.start
      const chunkEnd = chunk.start + Buffer.byteLength(chunk.text)
      if (chunkEnd <= start) continue
      const sliceStart = Math.max(chunkStart, start)
      const slice = chunk.text.slice(sliceStart - chunkStart, chunkEnd - chunkStart)
      text += slice
    }
    return { text, nextOffset: this.end, lossy }
  }
}

class OffsetReader implements SubprocessOutputReader {
  constructor(private readonly buffer: StreamBuffer) {}
  readFrom(fromByte: number): SubprocessOutputRead {
    return this.buffer.readFrom(fromByte)
  }
}

/** One managed remote process handle. */
class RemoteHandle implements SubprocessHandle {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: import('node:stream').Readable | undefined
  readonly stderr: import('node:stream').Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  private readonly processId: string
  private readonly transport: ExecTransport
  private readonly spec: SubprocessSpawnSpec
  private terminated = false
  private stderrPass: PassThrough | undefined
  private stdoutPass: PassThrough | undefined

  constructor(transport: ExecTransport, spec: SubprocessSpawnSpec, syntheticPid: number) {
    this.transport = transport
    this.spec = spec
    this.pid = syntheticPid
    this.processId = transport.newProcessId()

    const stdoutBuffer = new StreamBuffer()
    const stderrBuffer = new StreamBuffer()
    this.collected = {
      stdout: isCollect(spec.stdio.stdout) ? new OffsetReader(stdoutBuffer) : undefined,
      stderr: isCollect(spec.stdio.stderr) ? new OffsetReader(stderrBuffer) : undefined,
    }

    if (spec.stdio.stdin === 'pipe') {
      this.stdin = new Writable({
        write: (chunk, _enc, callback) => {
          this.transport.writeStdin(this.processId, chunk.toString('base64'))
            .then(() => callback(), (error) => callback(error instanceof Error ? error : new Error(String(error))))
        },
      })
    }

    if (spec.stdio.stdout === 'pipe') {
      this.stdoutPass = new PassThrough()
      this.stdout = this.stdoutPass
    }
    if (spec.stdio.stderr === 'pipe') {
      this.stderrPass = new PassThrough()
      this.stderr = this.stderrPass
    }

    let lastSeq = 0
    const offOutput = transport.on('process/output', (params) => {
      if (params['processId'] !== this.processId) return
      const stream = params['stream'] as 'stdout' | 'stderr' | 'pty' | undefined
      const chunk = typeof params['chunk'] === 'string' ? Buffer.from(params['chunk'], 'base64').toString('utf8') : ''
      if (chunk.length === 0) return
      lastSeq = Math.max(lastSeq, typeof params['seq'] === 'number' ? params['seq'] : 0)
      if (stream === 'stderr') {
        stderrBuffer.append(chunk, collectCap(spec.stdio.stderr))
        this.stderrPass?.write(chunk)
      } else {
        stdoutBuffer.append(chunk, collectCap(spec.stdio.stdout))
        this.stdoutPass?.write(chunk)
      }
    })

    const offExit = transport.on('process/exited', (params) => {
      if (params['processId'] !== this.processId) return
      const exitCode = typeof params['exitCode'] === 'number' ? params['exitCode'] : null
      // Final drain of server-buffered output NOT already delivered as notifications.
      transport.readProcess(this.processId, lastSeq, 1 << 20, 200).then((drain) => {
        for (const chunk of drain.chunks ?? []) {
          if (typeof chunk.chunk !== 'string' || chunk.chunk.length === 0) continue
          const text = Buffer.from(chunk.chunk, 'base64').toString('utf8')
          if (chunk.stream === 'stderr') {
            stderrBuffer.append(text, collectCap(spec.stdio.stderr))
            this.stderrPass?.write(text)
          } else {
            stdoutBuffer.append(text, collectCap(spec.stdio.stdout))
            this.stdoutPass?.write(text)
          }
        }
        offOutput(); offExit()
        this.stdoutPass?.end()
        this.stderrPass?.end()
        resolveOutcome({ exitCode, signal: null })
      }).catch((error: unknown) => {
        offOutput(); offExit()
        this.stdoutPass?.end()
        this.stderrPass?.end()
        resolveOutcome({ exitCode, signal: null })
      })
    })

    let resolveOutcome!: (outcome: SubprocessOutcome) => void
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      resolveOutcome = resolve
      transport.startProcess(this.processId, spec.argv, spec.cwd, {
        ...BASE_ENV,
        ...(spec.env as Record<string, string> | undefined),
      }).catch((error: unknown) => {
        offOutput(); offExit()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
    this.done.finally(() => {
      offOutput(); offExit()
      this.stdoutPass?.end()
      this.stderrPass?.end()
    })

    spec.signal?.addEventListener('abort', () => this.terminate(), { once: true })
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    void this.transport.terminateProcess(this.processId).catch(() => {})
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) {
      await this.done
      return true
    }
    if (signal.aborted) return false
    return await new Promise<boolean>((resolve) => {
      const onAbort = () => { cleanup(); resolve(false) }
      const onDone = () => { cleanup(); resolve(true) }
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        void this.done.then(onDone, onDone)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.done.then(onDone, onDone)
    })
  }
}

function isCollect(mode: unknown): boolean {
  return typeof mode === 'object' && mode !== null && 'maxBytes' in mode
}

function collectCap(mode: unknown): number {
  return isCollect(mode) ? (mode as { maxBytes: number }).maxBytes : 1 << 20
}

/**
 * `ctx.subprocess` provider: every spawn goes to the remote exec-server.
 * Mount as a plugin (`ctx.plugin(RemoteSubprocessRuntime)`) — it registers as
 * the `subprocess` service for the whole context (one implementation per
 * context, per the seam contract).
 */
export class RemoteSubprocessRuntime extends SubprocessBase {
  static inject = ['sshTransport']
  private live = new Set<RemoteHandle>()
  private pidSeq = 0

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => () => {
      for (const handle of this.live) handle.terminate()
    }, 'dshssh subprocess teardown')
  }

  /** @inheritdoc */
  async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    if (command.length === 0) throw new Error('dshssh: executable name must be non-empty')
    signal?.throwIfAborted()
    const transport = (this.ctx as { sshTransport: ExecTransport }).sshTransport
    const result = await transport.runCollect(
      ['sh', '-c', `command -v -- ${quoteShellArg(command)} || exit 127`],
      '/tmp',
      { ...BASE_ENV, ...(env as Record<string, string> | undefined) },
    )
    const executable = result.out.map((chunk) => chunk.text).join('').trim()
    if (result.exitCode !== 0 || executable.length === 0) {
      throw new Error(`dshssh: executable ${JSON.stringify(command)} not found on remote`)
    }
    return executable.split('\n')[0]!.trim()
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const transport = (this.ctx as { sshTransport: ExecTransport }).sshTransport
    const handle = new RemoteHandle(transport, spec, ++this.pidSeq)
    this.live.add(handle)
    void handle.done.finally(() => this.live.delete(handle))
    return handle
  }

  /** @inheritdoc */
  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<never> {
    return Promise.reject(new Error('dshssh: spawnTerminal not implemented yet (v1)'))
  }
}

export default RemoteSubprocessRuntime
