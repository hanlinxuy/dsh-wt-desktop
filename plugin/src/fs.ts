/**
 * RemoteFileSystem — `ctx.fs` seam provider routing file operations to the
 * remote `codex exec-server` (deployed headless runtime) through ExecTransport.
 * Version-agnostic base class (dsh rc.7 `FileSystem` / upstream 0.0.1
 * `FileSystem` — same name in both, kept symmetric with subprocess.ts).
 *
 * v1 semantics (documented deviations from the local backend):
 * - version = `${size}:${mtimeMs}` of the target (remote freshness token);
 * - resolve() canonicalizes through fs/canonicalize when possible;
 * - writeText/editText are guarded by fs/writeFile (exec-server's fs layer);
 *   stale-version and edit-not-found raise the typed FsError codes;
 * - streamText yields the whole file as one chunk (no chunked streaming yet);
 * - lstat does not distinguish symlinks (exec-server metadata follows links).
 * @module @dsh-external/dshssh/fs
 */
import * as FsModule from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsError,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Context } from 'cordis'
import { join } from 'node:path'
import type { ExecTransport } from './transport.ts'

/** The abstract seam surface we extend (both versions export `FileSystem`). */
interface FileSystemSurface {
  readonly ctx: Context
}

const FileSystemBase: new (ctx: Context) => FileSystemSurface =
  (FsModule as unknown as {
    FileSystem?: new (ctx: Context) => FileSystemSurface
    default?: new (ctx: Context) => FileSystemSurface
  }).FileSystem ?? (FsModule as unknown as { default?: new (ctx: Context) => FileSystemSurface }).default!

const FsErrorCtor = (FsModule as unknown as {
  FsError?: new (message: string, code: string, options?: { cause?: unknown }) => FsError
}).FsError

function fsError(message: string, code: string): Error {
  if (FsErrorCtor !== undefined) return new FsErrorCtor(message, code)
  return new Error(`${code}: ${message}`)
}

function versionOf(size: number, mtimeMs: number | undefined): string {
  return `${size}:${mtimeMs ?? 0}`
}

/**
 * `ctx.fs` provider: every file operation goes to the remote exec-server.
 * Mount as a plugin (`ctx.plugin(RemoteFileSystem)`).
 */
export class RemoteFileSystem extends FileSystemBase {
  static inject = ['sshTransport']

  constructor(ctx: Context) {
    super(ctx)
  }

  private transport(): ExecTransport {
    return (this.ctx as unknown as { sshTransport: ExecTransport }).sshTransport
  }

  private baseCwd(): string {
    return ((this.ctx as unknown as { sshTransport: ExecTransport }).sshTransport as unknown as { cwd?: string }).cwd ?? '/tmp'
  }

  /** @inheritdoc */
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const absolute = path.startsWith('/') ? path : join(opts?.cwd ?? this.baseCwd(), path)
    let canonical = absolute
    try {
      canonical = await this.transport().fsCanonicalize(absolute)
    } catch { /* path may not exist yet — keep the normalized absolute path */ }
    return {
      targetKey: canonical as FsTarget['targetKey'],
      displayPath: canonical,
    }
  }

  /** @inheritdoc */
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    const meta = await this.transport().fsStat(target.targetKey as string).catch(() => undefined)
    if (meta === undefined) return undefined
    return {
      version: versionOf(meta.size, meta.mtimeMs) as FsInfo['version'],
      type: meta.isDirectory ? 'directory' : meta.isFile ? 'file' : 'other',
      size: meta.size,
    }
  }

  /** @inheritdoc */
  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted()
    const absolute = path.startsWith('/') ? path : join(opts?.cwd ?? this.baseCwd(), path)
    const meta = await this.transport().fsStat(absolute).catch(() => undefined)
    if (meta === undefined) return undefined
    return {
      path: absolute,
      type: meta.isDirectory ? 'directory' : meta.isFile ? 'file' : 'other',
      size: meta.size,
      version: versionOf(meta.size, meta.mtimeMs) as FsPathInfo['version'],
    } as FsPathInfo
  }

  /** @inheritdoc */
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return await this.transport().fsReadText(target.targetKey as string)
  }

  /** @inheritdoc */
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  /** @inheritdoc */
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted()
    const entries = await this.transport().fsListDir(target.targetKey as string)
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory ? 'directory' : 'file',
      target: {
        targetKey: join(target.targetKey as string, entry.name) as FsTarget['targetKey'],
        displayPath: join(target.displayPath, entry.name),
      },
    }))
  }

  /** @inheritdoc */
  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: unknown,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted()
    const transport = this.transport()
    const current = await transport.fsStat(target.targetKey as string).catch(() => undefined)
    const before = current?.isFile === true ? await transport.fsReadText(target.targetKey as string).catch(() => null) : null
    if (expected !== undefined && 'version' in expected && expected.version !== undefined) {
      const currentVersion = versionOf(current?.size ?? 0, current?.mtimeMs)
      if (currentVersion !== String(expected.version)) {
        throw fsError('remote write: stale version', 'FS_STALE_VERSION')
      }
    }
    await transport.fsWriteText(target.targetKey as string, content)
    const afterMeta = await transport.fsStat(target.targetKey as string).catch(() => undefined)
    return {
      operation: before === null ? 'create' : 'update',
      version: versionOf(afterMeta?.size ?? 0, afterMeta?.mtimeMs) as FsWriteOutcome['version'],
      before,
      after: content,
    }
  }

  /** @inheritdoc */
  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: string },
    signal?: AbortSignal,
    _sandboxPolicy?: unknown,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    const transport = this.transport()
    const current = await transport.fsReadText(target.targetKey as string)
    if (expected?.version !== undefined) {
      const meta = await transport.fsStat(target.targetKey as string).catch(() => undefined)
      if (versionOf(meta?.size ?? 0, meta?.mtimeMs) !== String(expected.version)) {
        throw fsError('remote edit: stale version', 'FS_STALE_VERSION')
      }
    }
    const { oldString, newString, replaceAll } = edit
    if (oldString.length === 0) throw fsError('remote edit: empty search text', 'FS_EDIT_NOT_FOUND')
    const matches = [...current.matchAll(new RegExp(escapeRegExp(oldString), 'g'))]
    if (matches.length === 0) throw fsError('remote edit: search text not found', 'FS_EDIT_NOT_FOUND')
    if (matches.length > 1 && !replaceAll) throw fsError('remote edit: ambiguous match', 'FS_AMBIGUOUS_EDIT')
    const after = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString)
    await transport.fsWriteText(target.targetKey as string, after)
    const meta = await transport.fsStat(target.targetKey as string).catch(() => undefined)
    return {
      version: versionOf(meta?.size ?? 0, meta?.mtimeMs) as FsEditOutcome['version'],
      before: current,
      after,
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default RemoteFileSystem
