/**
 * /api/dshssh — JSON state/action + 远端文件浏览/预览/下载端点。
 * GET  /api/dshssh/state    -> { hosts: [{name,state,lastError,logs:[...]}] }
 * POST /api/dshssh/action   -> { host, action: connect|disconnect|smoke|deploy|verify }
 * GET  /api/dshssh/fs/list  ?host=&path=  -> { path, entries: [{name,type,size}] }
 * GET  /api/dshssh/fs/read  ?host=&path=  -> { path, content, truncated }
 * GET  /api/dshssh/fs/download ?host=&path= -> raw bytes (attachment)
 *
 * 安全：路径边界由远端自建 exec-server 的 allow-cwd 强制（本端只是代理）。
 * Registers on whichever HTTP carrier exists: `webServer` (dsh-my-rsi/upstream)
 * or `httpServer` (desktop). Uses a scoped `ctx.inject` so the route appears
 * once the carrier loads, regardless of loader entry order; in bare test
 * contexts (no carrier) the scope simply never activates.
 * @module @dsh-external/dshssh/http
 */
import type { Context } from 'cordis'
import { basename } from 'node:path'
import type { RemoteRuntimeManager } from './manager.ts'

interface HttpHandler {
  register(opts: { kind: 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }): unknown
}
interface HttpReq { url?: string; method?: string; on?(event: 'data' | 'end', cb: (chunk?: Buffer) => void): void }
interface HttpRes { writeHead(code: number, headers?: Record<string, string>): void; end(body: string | Buffer): void }

const READ_CAP = 512 * 1024 // fs/read 预览上限

export function registerHttp(ctx: Context, manager: RemoteRuntimeManager): void {
  const registerOn = (server: HttpHandler): void => {
    ctx.effect(() => server.register({
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
        // ---- 远端文件浏览 / 预览 / 下载 ----
        if (req.method === 'GET' && url.pathname.startsWith('/api/dshssh/fs/')) {
          const host = url.searchParams.get('host')
          const path = url.searchParams.get('path') ?? '/'
          const transport = manager.transportFor(host)
          if (transport === null) {
            send(res, 409, { error: 'no ready runtime transport — 先连接一个 host' })
            return
          }
          const route = url.pathname.slice('/api/dshssh/fs/'.length)
          if (route === 'list') {
            void transport.fsListDir(path).then((entries) => {
              send(res, 200, { path, entries: entries.map((e) => ({ name: e.name, type: e.isDirectory ? 'directory' : 'file' })) })
            }).catch((error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) }))
            return
          }
          if (route === 'read') {
            void transport.fsReadBytes(path).then((bytes) => {
              const truncated = bytes.length > READ_CAP
              send(res, 200, { path, truncated, content: bytes.subarray(0, READ_CAP).toString('utf8') })
            }).catch((error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) }))
            return
          }
          if (route === 'download') {
            void transport.fsReadBytes(path).then((bytes) => {
              res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-disposition': `attachment; filename="${basename(path).replaceAll('"', '')}"`,
                'content-length': String(bytes.length),
              })
              res.end(bytes)
            }).catch((error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) }))
            return
          }
          send(res, 404, { error: `unknown fs route ${route}` })
          return
        }
        send(res, 404, { error: 'not found' })
      },
    }) as unknown as () => void, 'dshssh: http routes')
  }

  // Eager attempt (carrier may already be present at apply time).
  for (const name of ['webServer', 'httpServer'] as const) {
    try {
      const server = (ctx as unknown as Record<string, unknown>)[name]
      if (server !== undefined) {
        registerOn(server as HttpHandler)
        return
      }
    } catch { /* not injected yet — fall through to scoped inject */ }
  }
  // Scoped inject: activate when the carrier loads (entry-order independent).
  ctx.inject(['webServer'] as never, (scope: Context) => {
    registerOn((scope as unknown as { webServer: HttpHandler }).webServer)
  })
}

function send(response: HttpRes, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
