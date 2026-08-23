/**
 * vitest config — dshssh 插件测试（对齐上游 dsh 分层测试政策）。
 * 测试走「真实实现」：自建 exec-server（非 mock）+ 真实 cordis 装配。
 * keyless：无网络/无远端；真实远端场景由带环境变量的 e2e spec 自跳过。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/transport.ts', 'src/exec-server.ts', 'src/manager.ts', 'src/subprocess.ts', 'src/fs.ts'],
      thresholds: {
        // 诚实门槛（当前基线，防回归）：HTTP 路由/真实 SSH 路径由 e2e 覆盖；
        // 后续补 GUI 层测试逐步上调（上游目标：按文件 100%）。
        lines: 60,
        functions: 55,
        branches: 35,
      },
    },
  },
})
