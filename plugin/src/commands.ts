/**
 * /remote slash commands — operational control over dshssh remote runtimes.
 * @module @dsh-external/dshssh/commands
 */
import type { Context } from 'cordis'
import type { RemoteRuntimeManager } from './manager.ts'

function ok(text: string): { kind: 'success'; text: string } {
  return { kind: 'success', text }
}

function fail(error: unknown): { kind: 'error'; text: string } {
  return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
}

export function registerCommands(ctx: Context, manager: RemoteRuntimeManager): void {
  const commands = (ctx as unknown as { get?(name: string, loose?: boolean): unknown }).get?.('commands', false) as
    | { register(def: unknown): unknown }
    | undefined
  if (commands === undefined) return

  ctx.effect(() => commands.register({
    name: 'remote',
    description: 'dshssh runtime 状态一览（/remote status）',
    input: { hint: '<status|connect|disconnect|smoke|deploy|verify> [host]' },
    handler: async ({ rawInput }: { rawInput: string }) => {
      const [verb, ...rest] = rawInput.trim().split(/\s+/)
      const host = rest[0] ?? 'homelinux2'
      switch (verb) {
        case 'status': {
          const hosts = manager.list()
          if (hosts.length === 0) return ok('no runtimes configured — 用 /remote connect <host> 添加')
          return ok(hosts.map((h) => `- ${h.name}: ${h.state}${h.lastError !== undefined ? ` (${h.lastError})` : ''}`).join('\n'))
        }
        case 'connect': {
          try {
            const record = await manager.connect(host)
            return ok(`${host}: ${record.state}${record.lastError !== undefined ? ` — ${record.lastError}` : ''}`)
          } catch (error) { return fail(error) }
        }
        case 'disconnect':
          manager.disconnect(host)
          return ok(`${host}: disconnected`)
        case 'smoke': {
          try {
            const text = await manager.smoke(host)
            return ok(`${host} smoke: ${text}`)
          } catch (error) { return fail(error) }
        }
        case 'deploy':
        case 'verify': {
          const code = await manager.runScript(verb, host)
          return code === 0 ? ok(`${host}: ${verb} OK（详见面板日志）`) : fail(`${host}: ${verb} 失败 (exit ${code})`)
        }
        default:
          return fail(`unknown verb: ${verb ?? ''} — status|connect|disconnect|smoke|deploy|verify`)
      }
    },
  }) as unknown as () => void, 'dshssh: /remote commands')
}
