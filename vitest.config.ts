import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // The pure modules under test hold no DOM state, so a single worker is both
    // faster and avoids spawning a process pool per test file on Windows, where
    // tearing those processes down is slow and can fail outright.
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
