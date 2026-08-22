/**
 * RemoteDock — 输入框上方 dock：runtime 状态 + 一键操作 + 日志尾。
 * 纯内联样式（避免 CSS 模块构建复杂度），数据走 /api/dshssh。
 */
import { useEffect, useState } from 'react'

interface HostView {
  name: string
  state: 'connecting' | 'ready' | 'error' | 'offline'
  lastError?: string
  logs: Array<{ at: string; level: string; text: string }>
}

interface DockProps {
  t: (key: string) => string
}

const STATE_COLOR: Record<string, string> = {
  ready: '#22c55e',
  connecting: '#f59e0b',
  error: '#ef4444',
  offline: '#94a3b8',
}

export function RemoteDock({ t }: DockProps) {
  const [hosts, setHosts] = useState<HostView[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

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

  const act = (host: string, action: string) => {
    setBusy(`${host}:${action}`)
    void fetch('/api/dshssh/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, action }),
    }).then((r) => r.json()).then(() => { setBusy(null); refresh() }).catch(() => setBusy(null))
  }

  const label = (key: string): string => {
    const value = t(key)
    return typeof value === 'string' ? value : key
  }

  const chip = (host: HostView) => (
    <span
      key={host.name}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
        borderRadius: 999, background: 'rgba(127,127,127,0.12)', fontSize: 12,
      }}
    >
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
          </span>
        ))}
      </div>
      {expanded !== null && hosts.filter((h) => h.name === expanded).map((host) => (
        <pre key={host.name} style={{ maxHeight: 140, overflow: 'auto', margin: 0, padding: 6, background: 'rgba(0,0,0,0.25)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap' }}>
          {host.logs.map((line) => `[${line.level}] ${line.text}`).join('\n') || '(no logs)'}
        </pre>
      ))}
    </div>
  )
}

export default RemoteDock
