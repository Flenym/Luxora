import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { SqliteStore } from "../infrastructure/sqlite-store.js";

interface WorkerInput {
  databasePath: string;
  gate: SharedArrayBuffer;
}

const input = workerData as WorkerInput;
const port = parentPort;
if (port === null) throw new Error("Migration open worker requires a parent port");

port.postMessage({ type: "ready" });
Atomics.wait(new Int32Array(input.gate), 0, 0);

try {
  const store = new SqliteStore(input.databasePath);
  const ping = store.ping();
  store.close();
  const inspection = new Database(input.databasePath, { readonly: true });
  const migrationCount = (inspection.prepare(`
    SELECT COUNT(*) AS count FROM schema_migrations
  `).get() as { count: number }).count;
  inspection.close();
  port.postMessage({ type: "result", outcome: { ok: true, ping, migrationCount } });
} catch (error) {
  port.postMessage({
    type: "result",
    outcome: {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      code: typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    }
  });
}
