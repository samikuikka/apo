import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
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
