/**
 * mock-exec-server.mjs — keyless test double for `codex exec-server`.
 *
 * Speaks the documented exec-server WebSocket JSON-RPC protocol (initialize /
 * initialized, process/start|read|write|terminate, fs/* error stubs) and
 * spawns REAL local child processes, so the plugin's transport + subprocess
 * adapter are validated end-to-end without any network or remote host.
 *
 * Protocol framing: one JSON-RPC message per WebSocket message (local-ws
 * framing, matching the real server).
 */
import { spawn } from 'node:child_process'
import {
  realpathSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

function b64(text) { return Buffer.from(text, 'utf8').toString('base64') }
function toPath(p) { return typeof p === 'string' && p.startsWith('file:') ? fileURLToPath(p) : p }

/**
 * Start the mock server.
 * @param {number} port — 0 for an ephemeral port.
 * @returns {Promise<{ url: string; close: () => Promise<void> }>}
 */
export function startMockExecServer(port = 0) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port }, () => {
      const url = `ws://127.0.0.1:${wss.address().port}`
      resolve({
        url,
        close: () => new Promise((res) => wss.close(() => res())),
      })
    })
    wss.on('error', reject)

    wss.on('connection', (ws) => {
      /** processId -> { child, chunks: [{seq, stream, chunk}], nextSeq, exited, exitCode } */
      const processes = new Map()

      const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))

      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(String(raw)) } catch { return }
        const reply = (id, result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
        const error = (id, code, message) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))

        switch (msg.method) {
          case 'initialize': return reply(msg.id, {})
          case 'initialized': return // notification
          case 'process/start': {
            const { processId, argv, cwd, env } = msg.params
            const cwdPath = typeof cwd === 'string' && cwd.startsWith('file:') ? fileURLToPath(cwd) : '/tmp'
            let child
            try {
              child = spawn(argv[0], argv.slice(1), { cwd: cwdPath, env })
            } catch (err) {
              return error(msg.id, -32603, `spawn failed: ${String(err)}`)
            }
            const record = { child, chunks: [], nextSeq: 0, exited: false, exitCode: null }
            processes.set(processId, record)
            const push = (stream, chunk) => {
              const seq = ++record.nextSeq
              record.chunks.push({ seq, stream, chunk: b64(chunk) })
              notify('process/output', { processId, seq, stream, chunk: b64(chunk) })
            }
            child.stdout.on('data', (d) => push('stdout', String(d)))
            child.stderr.on('data', (d) => push('stderr', String(d)))
            child.on('close', (code) => {
              record.exited = true
              record.exitCode = code
              notify('process/exited', { processId, seq: ++record.nextSeq, exitCode: code, sandboxDenied: false })
              notify('process/closed', { processId, seq: ++record.nextSeq })
            })
            return reply(msg.id, { processId })
          }
          case 'process/read': {
            const { processId, afterSeq = null } = msg.params
            const record = processes.get(processId)
            if (!record) return error(msg.id, -32602, `unknown processId ${processId}`)
            const from = typeof afterSeq === 'number' ? afterSeq : 0
            const chunks = record.chunks.filter((c) => c.seq > from)
            return reply(msg.id, {
              chunks,
              nextSeq: record.nextSeq,
              exited: record.exited,
              exitCode: record.exited ? record.exitCode : null,
              closed: record.exited,
              failure: null,
            })
          }
          case 'process/write': {
            const { processId, chunk } = msg.params
            const record = processes.get(processId)
            if (!record) return error(msg.id, -32602, `unknown processId ${processId}`)
            record.child.stdin.write(Buffer.from(chunk, 'base64'))
            return reply(msg.id, { status: 'accepted' })
          }
          case 'process/terminate': {
            const { processId } = msg.params
            const record = processes.get(processId)
            if (!record || record.exited) return reply(msg.id, { running: false })
            record.child.kill('SIGKILL')
            return reply(msg.id, { running: true })
          }
          case 'fs/readFile': {
            const p = toPath(msg.params.path)
            if (!existsSync(p)) return error(msg.id, -32603, `ENOENT: ${p}`)
            const st = statSync(p)
            if (!st.isFile()) return error(msg.id, -32603, `EISDIR: ${p}`)
            return reply(msg.id, { path: msg.params.path, dataBase64: b64(readFileSync(p, 'utf8')) })
          }
          case 'fs/writeFile': {
            const p = toPath(msg.params.path)
            writeFileSync(p, Buffer.from(msg.params.dataBase64 ?? '', 'base64'))
            return reply(msg.id, { path: msg.params.path })
          }
          case 'fs/readDirectory': {
            const p = toPath(msg.params.path)
            if (!existsSync(p)) return error(msg.id, -32603, `ENOENT: ${p}`)
            const entries = readdirSync(p, { withFileTypes: true }).map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory(),
              fileType: entry.isDirectory() ? 'directory' : 'file',
            }))
            return reply(msg.id, { entries })
          }
          case 'fs/getMetadata': {
            const p = toPath(msg.params.path)
            if (!existsSync(p)) return error(msg.id, -32603, `ENOENT: ${p}`)
            const st = statSync(p)
            return reply(msg.id, {
              path: msg.params.path,
              isFile: st.isFile(),
              isDirectory: st.isDirectory(),
              fileType: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other',
              size: st.size,
              mtimeMs: st.mtimeMs,
            })
          }
          case 'fs/remove': {
            const p = toPath(msg.params.path)
            rmSync(p, { recursive: msg.params.recursive === true, force: true })
            return reply(msg.id, {})
          }
          case 'fs/createDirectory': {
            mkdirSync(toPath(msg.params.path), { recursive: true })
            return reply(msg.id, {})
          }
          case 'fs/canonicalize': {
            const p = toPath(msg.params.path)
            if (!existsSync(p)) return error(msg.id, -32603, `ENOENT: ${p}`)
            return reply(msg.id, { path: realpathSync(p) })
          }
          default:
            return error(msg.id, -32601, `mock: unknown method ${String(msg.method)}`)
        }
      })
    })
  })
}

export default startMockExecServer
