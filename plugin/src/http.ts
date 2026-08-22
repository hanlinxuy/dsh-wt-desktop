/**
 * /api/dshssh — JSON state + action endpoints consumed by the GUI dock.
 * GET  /api/dshssh/state   -> { hosts: [{name,state,lastError,logs:[...]}] }
 * POST /api/dshssh/action  -> { host, action: connect|disconnect|smoke|deploy|verify }
 * @module @dsh-external/dshssh/http
 */
import type { Context } from 'cordis'
import type { RemoteRuntimeManager } from './manager.ts'

export function registerHttp(ctx: Context, manager: RemoteRuntimeManager): void {
  interface HttpHandler {
    register(opts: { kind: 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }): unknown
  }
  interface HttpReq { url?: string; method?: string; on?(event: 'data' | 'end', cb: (chunk?: Buffer) => void): void }
  interface HttpRes { writeHead(code: number, headers?: Record<string, string>): void; end(body: string): void }
  const httpServer = (ctx as unknown as { get?(name: string, loose?: boolean): unknown }).get?.('httpServer', false) as HttpHandler | undefined
  if (httpServer === undefined) return

  const send = (response: HttpRes, code: number, body: unknown): void => {
    response.writeHead(code, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  ctx.effect(() => httpServer.register({
    kind: 'prefix',
    path: '/api/dshssh',
    handler: (request: unknown, response: unknown) => {
        const req = request as HttpReq
        const res = response as HttpRes
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET' && url.pathname === '/api/dshssh/state') {
          send(res, 200, {
            hosts: manager.list().map((h) => ({
              name: h.name,
              state: h.state,
              lastError: h.lastError,
              logs: h.logs.slice(-50),
            })),
          })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/dshssh/action') {
          let body = ''
          req.on?.('data', (chunk?: Buffer) => { if (chunk !== undefined) body += chunk.toString('utf8') })
          req.on?.('end', () => {
            let parsed: { host?: string; action?: string }
            try { parsed = JSON.parse(body) } catch { send(res, 400, { error: 'invalid json' }); return }
            const host = parsed.host ?? 'homelinux2'
            const action = parsed.action
            if (action === 'connect' || action === 'smoke') {
              void manager.connect(host).then(() => {
                if (action === 'smoke') {
                  return manager.smoke(host).then((text) => send(res, 200, { ok: true, text }))
                }
                const record = manager.get(host)
                send(res, 200, { ok: true, state: record?.state, lastError: record?.lastError })
              }).catch((error: unknown) => send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }))
              return
            }
            if (action === 'disconnect') {
              manager.disconnect(host)
              send(res, 200, { ok: true })
              return
            }
            if (action === 'deploy' || action === 'verify') {
              void manager.runScript(action, host).then((code) => send(res, 200, { ok: code === 0, exit: code }))
              return
            }
            send(res, 400, { ok: false, error: `unknown action ${String(action)}` })
          })
          return
        }
        send(res, 404, { error: 'not found' })
      },
    }) as unknown as () => void, 'dshssh: http routes')
}