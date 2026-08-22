/**
 * tsdown preset for @dsh-external/dshssh — host (node) half only for now.
 * The client (web) half will be added when the GUI suggested-actions panel
 * lands; it will mirror the dsh-stickers browser-bundle shape
 * (window.__ModuleLoader__.load banner, platform externals).
 */
import type { UserConfig } from 'tsdown'

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
] satisfies UserConfig[]
