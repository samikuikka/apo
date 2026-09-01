import { defineConfig } from 'vitest/config';
import codspeedPlugin from '@codspeed/vitest-plugin';

export default defineConfig({
  // The plugin is inert outside a CodSpeed runner: `pnpm test` and
  // `pnpm bench` behave exactly as before when CODSPEED_ENV is unset.
  plugins: [codspeedPlugin()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/examples/**', 'tests/**'],
    },
  },
});
