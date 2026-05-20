import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test isolates env vars + tmp dirs through helpers; running
    // sequentially keeps Q_CODE_HOME isolation simple and the suite
    // small enough that wall-clock cost is dominated by I/O anyway.
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Hand-rolled CLI scripts and the wiring layer are best covered
      // by the legacy `pnpm test:*` script suite + e2e.
      exclude: [
        'src/index.ts',
        'src/scripts/**',
        'src/server/**',
        'src/utils/logger.ts'
      ]
    }
  }
})
