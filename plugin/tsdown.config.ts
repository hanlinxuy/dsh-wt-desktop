/**
 * tsdown preset for @dsh-external/dshssh — three outputs:
 *  - lib/index.js + lib/invariant.js — host (node) half;
 *  - lib/exec-server.js — self-built headless runtime (ws bundled, single file);
 *  - lib/client.js — browser bundle handed to window.__ModuleLoader__.load
 *    (platform externals resolve through the loader's frozen module table).
 */
import type { UserConfig } from 'tsdown'

/** Module specifiers the dsh web shell shares into its frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']

const PLUGIN_ID = '@dsh-external/dshssh'

export default [
  {
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    // Self-contained bundle: bundle everything except cordis (framework identity
    // must stay shared) and node builtins, so the plugin works when installed
    // via file:/git links without its own node_modules.
    noExternal: (id: string) => (id === 'cordis' || id.startsWith('node:') ? undefined : true),
  },
  {
    // 自建 headless runtime：单文件产物（ws 已打包），部署到目标机只需 Node。
    entry: { 'exec-server': 'src/exec-server.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: false,
    noExternal: ['ws'],
  },
  {
    // Web 半区：/plugins/@dsh-external/dshssh/client.js
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
