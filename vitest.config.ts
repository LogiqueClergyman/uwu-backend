import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The gated live E2E waits on Setu + Algorand round-trips.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      // Excluded = generated or operational code with no hand-written logic to
      // unit-test (kept out of the denominator so the % reflects OUR code):
      //   - contracts/*      → algokit-generated typed app client (not authored here)
      //   - scripts/*        → one-shot deploy/ops scripts
      //   - server.ts        → Express app bootstrap + listen()
      //   - db/index.ts      → live Neon connection (needs a real database)
      exclude: [
        'src/contracts/**',
        'src/scripts/**',
        'src/server.ts',
        'src/db/index.ts',
      ],
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
});
