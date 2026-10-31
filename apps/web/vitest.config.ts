import { defineConfig } from "vitest/config";

/**
 * The web data layer must be testable without a DOM: node environment, no
 * jsdom dependency. Only `apps/web/src/app/core/**` is unit-tested (the React
 * provider is exercised through its pure pieces instead).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/app/core/**/*.test.ts"],
    globals: false,
    testTimeout: 10_000,
    restoreMocks: true
  }
});
