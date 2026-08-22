/**
 * RemoteDock — 输入框上方 dock：runtime 状态 + 一键操作 + 日志尾 + 远端文件
 * 浏览器（目录导航 / 文件预览 / 右键下载）。纯内联样式，数据走 /api/dshssh。
 */
import { useEffect, useState } from 'react'

interface HostView {
  name: string
  state: 'connecting' | 'ready' | 'error' | 'offline'
  lastError?: string
  logs: Array<{ at: string; level: string; text: string }>
}

interface FsEntry { name: string; type: 'file' | 'directory' }

interface DockProps {
  t: (key: string) => string
}

const STATE_COLOR: Record<string, string> = {
  ready: '#22c55e',
  connecting: '#f59e0b',
  error: '#ef4444',
  offline: '#94a3b8',
}

interface MenuState { x: number; y: number; entry: FsEntry; path: string }

export function RemoteDock({ t }: DockProps) {
  const [hosts, setHosts] = useState<HostView[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // 文件浏览器状态
  const [browserHost, setBrowserHost] = useState<string | null>(null)
  const [browserPath, setBrowserPath] = useState('/')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const label = (key: string): string => {
    const value = t(key)
    return typeof value === 'string' ? value : key
  }

  const refresh = () => {
    void fetch('/api/dshssh/state')
      .then((r) => r.json())
      .then((data) => setHosts(data.hosts ?? []))
      .catch(() => { /* host routes unavailable */ })
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const act = (host: string, action: string) => {
    setBusy(`${host}:${action}`)
    void fetch('/api/dshssh/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, action }),
    }).then((r) => r.json()).then(() => { setBusy(null); refresh() }).catch(() => setBusy(null))
  }

  const openBrowser = (host: string) => {
    const next = browserHost === host ? null : host
    setBrowserHost(next)
    setBrowserPath('/')
    setEntries([])
    setPreview(null)
    if (next !== null) listDir(next, '/')
  }

  const listDir = (host: string, path: string) => {
    void fetch(`/api/dshssh/fs/list?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((data) => { if (!data.error) { setEntries(data.entries ?? []); setBrowserPath(path); setPreview(null) } })
      .catch(() => {})
  }

  const viewFile = (host: string, path: string) => {
    void fetch(`/api/dshssh/fs/read?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((data) => { if (!data.error) setPreview({ path, content: data.content ?? '', truncated: data.truncated === true }) })
      .catch(() => {})
  }

  const downloadFile = (host: string, path: string) => {
    void fetch(`/api/dshssh/fs/download?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.blob())
      .then((blob) => {
        const name = path.split('/').pop() ?? 'download'
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      })
      .catch(() => {})
  }

  const chip = (host: HostView) => (
    <span key={host.name} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
      borderRadius: 999, background: 'rgba(127,127,127,0.12)', fontSize: 12,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: STATE_COLOR[host.state] ?? '#94a3b8', display: 'inline-block' }} />
      {host.name}
      <span style={{ opacity: 0.6 }}>{host.state}</span>
      {host.lastError !== undefined && (
        <span style={{ color: '#ef4444', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={host.lastError}>
          {host.lastError}
        </span>
      )}
    </span>
  )

  const button = (host: string, action: string, text: string) => (
    <button
      key={`${host}-${action}`}
      disabled={busy !== null}
      onClick={() => act(host, action)}
      style={{
        fontSize: 11, padding: '1px 6px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent', color: 'inherit', cursor: busy === null ? 'pointer' : 'default', opacity: busy === null ? 1 : 0.5,
      }}
    >
      {busy === `${host}:${action}` ? label('busy') : text}
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 8px', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>{label('title')}</strong>
        {hosts.length === 0 ? <span style={{ opacity: 0.6 }}>{label('noHosts')}</span> : null}
        {hosts.map((host) => (
          <span key={host.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {chip(host)}
            {button(host.name, 'connect', label('connect'))}
            {button(host.name, 'deploy', label('deploy'))}
            {button(host.name, 'verify', label('verify'))}
            {button(host.name, 'smoke', label('smoke'))}
            {button(host.name, 'disconnect', label('disconnect'))}
            <button
              onClick={() => setExpanded(expanded === host.name ? null : host.name)}
              style={{ fontSize: 11, padding: '1px 4px', borderRadius: 6, border: 'none', background: 'transparent', color: 'inherit', opacity: 0.7, cursor: 'pointer' }}
            >
              {label('logs')}
            </button>
            <button
              onClick={() => openBrowser(host.name)}
              style={{ fontSize: 11, padding: '1px 6px', borderRadius: 6, border: '1px solid rgba(34,197,94,0.4)', background: browserHost === host.name ? 'rgba(34,197,94,0.15)' : 'transparent', color: 'inherit', cursor: 'pointer' }}
            >
              📁 {label('files')}
            </button>
          </span>
        ))}
      </div>

      {expanded !== null && hosts.filter((h) => h.name === expanded).map((host) => (
        <pre key={host.name} style={{ maxHeight: 140, overflow: 'auto', margin: 0, padding: 6, background: 'rgba(0,0,0,0.25)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap' }}>
          {host.logs.map((line) => `[${line.level}] ${line.text}`).join('\n') || '(no logs)'}
        </pre>
      ))}

      {browserHost !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid rgba(34,197,94,0.25)', borderRadius: 8, padding: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <strong>📁 {browserHost}</strong>
            <button onClick={() => listDir(browserHost, '/')} style={{ ...iconBtn }}>🏠</button>
            <button onClick={() => { const p = browserPath.split('/').slice(0, -1).join('/') || '/'; listDir(browserHost, p) }} style={{ ...iconBtn }}>⬆</button>
            <input
              value={browserPath}
              onChange={(e) => setBrowserPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') listDir(browserHost, browserPath) }}
              style={{ flex: 1, minWidth: 120, fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit' }}
            />
          </div>
          <div style={{ maxHeight: 200, overflow: 'auto', fontSize: 11 }}>
            {entries.map((entry) => (
              <div
                key={entry.name}
                onClick={() => entry.type === 'directory' ? listDir(browserHost, `${browserPath === '/' ? '' : browserPath}/${entry.name}`) : viewFile(browserHost, `${browserPath === '/' ? '' : browserPath}/${entry.name}`)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, entry, path: `${browserPath === '/' ? '' : browserPath}/${entry.name}` })
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px', borderRadius: 4, cursor: 'pointer' }}
              >
                <span>{entry.type === 'directory' ? '📁' : '📄'}</span>
                <span style={{ flex: 1 }}>{entry.name}</span>
                {entry.type === 'file' && <button onClick={(e) => { e.stopPropagation(); downloadFile(browserHost, `${browserPath === '/' ? '' : browserPath}/${entry.name}`) }} style={{ ...iconBtn, fontSize: 10 }}>⤓</button>}
              </div>
            ))}
            {entries.length === 0 && <div style={{ opacity: 0.6, padding: 4 }}>{label('emptyDir')}</div>}
          </div>
          {preview !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <strong style={{ fontSize: 11 }}>{preview.path}</strong>
                {preview.truncated && <span style={{ opacity: 0.6 }}>{label('truncated')}</span>}
                <button onClick={() => downloadFile(browserHost, preview.path)} style={{ ...iconBtn, fontSize: 10 }}>⤓ {label('download')}</button>
                <button onClick={() => setPreview(null)} style={{ ...iconBtn, marginLeft: 'auto' }}>✕</button>
              </div>
              <pre style={{ maxHeight: 220, overflow: 'auto', margin: 0, padding: 6, background: 'rgba(0,0,0,0.25)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap' }}>{preview.content}</pre>
            </div>
          )}
        </div>
      )}

      {menu !== null && (
        <div
          style={{
            position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999,
            background: 'rgba(30,30,30,0.98)', border: '1px solid rgba(127,127,127,0.4)', borderRadius: 6,
            padding: 4, fontSize: 12, minWidth: 140,
          }}
        >
          <div style={{ padding: '2px 8px', opacity: 0.6, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{menu.entry.name}</div>
          {menu.entry.type === 'file' && (
            <>
              <div style={{ ...menuItem }} onClick={() => { viewFile(browserHost!, menu.path); setMenu(null) }}>👁 {label('view')}</div>
              <div style={{ ...menuItem }} onClick={() => { downloadFile(browserHost!, menu.path); setMenu(null) }}>⤓ {label('download')}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  fontSize: 11, padding: '1px 5px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent', color: 'inherit', cursor: 'pointer',
}

const menuItem: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
}

export default RemoteDock
