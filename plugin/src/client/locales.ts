/** dshssh dock locale keys (union of string literals — LocaleNamespaceMap pattern). */
export type DockKey =
  | 'title'
  | 'noHosts'
  | 'connect'
  | 'deploy'
  | 'verify'
  | 'smoke'
  | 'disconnect'
  | 'logs'
  | 'busy'
  | 'files'
  | 'emptyDir'
  | 'truncated'
  | 'download'
  | 'view'

export const zh: Record<DockKey, string> = {
  title: 'Remote Runtimes',
  noHosts: '暂无 runtime — 用 /remote connect <host> 添加',
  connect: '连接',
  deploy: '部署',
  verify: '验证',
  smoke: '冒烟',
  disconnect: '断开',
  logs: '日志',
  busy: '执行中…',
  files: '文件',
  emptyDir: '（空目录）',
  truncated: '（已截断预览，点 ⤓ 下载完整文件）',
  download: '下载',
  view: '查看',
}

export const en: Record<DockKey, string> = {
  title: 'Remote Runtimes',
  noHosts: 'No runtimes — add one with /remote connect <host>',
  connect: 'Connect',
  deploy: 'Deploy',
  verify: 'Verify',
  smoke: 'Smoke',
  disconnect: 'Disconnect',
  logs: 'Logs',
  busy: 'Running…',
  files: 'Files',
  emptyDir: '(empty)',
  truncated: '(truncated preview — ⤓ to download full file)',
  download: 'Download',
  view: 'View',
}
