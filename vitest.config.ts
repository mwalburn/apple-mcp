import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Shared runners have hit 6s+ on tests that take <200ms locally.
    testTimeout: 20_000,
  },
});
