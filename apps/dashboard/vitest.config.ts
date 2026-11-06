import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    // happy-dom over jsdom: the suite spends more aggregate CPU booting the
    // DOM environment and importing modules per file than running the tests
    // (145s env + 129s tests aggregate under jsdom, locally). happy-dom
    // boots and renders roughly twice as cheap, all 1167 tests pass, and
    // the step is far less sensitive to GitHub's ~2x runner-CPU variance.
    // One visible trade: unmocked fetches now go through node's real
    // sockets (jsdom never left the process), so a few tasks tests log
    // ECONNRESET noise while asserting the same error-handling paths.
    environment: "happy-dom",
    include: ["src/lib/__tests__/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./vitest.setup.ts"],
  },
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
