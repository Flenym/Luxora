import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration suite deliberately runs production-cost Argon2id,
    // SQLite writer races and bounded websocket waits. Serial file execution
    // prevents a small CI runner from turning those security properties into
    // nondeterministic CPU/memory starvation.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
