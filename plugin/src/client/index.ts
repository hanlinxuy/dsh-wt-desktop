/**
 * dshssh client half — 「Remote Runtimes」dock above the conversation input:
 * per-host status chips + one-click actions (connect/deploy/verify/smoke/
 * disconnect) + recent log tail. Data via /api/dshssh (host half).
 * @module @dsh-external/dshssh/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RemoteDock } from './RemoteDock.tsx'
import { en, zh, type DockKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshssh: DockKey }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dshssh', { zh, en }), 'dshssh: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'dshssh', order: 40, locale: 'dshssh', inject: () => ({}) },
    RemoteDock as unknown as ReactComponentType,
  ))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReactComponentType = (props: any) => React.ReactNode
