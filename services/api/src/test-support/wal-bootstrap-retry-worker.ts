import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { SqliteStore } from "../infrastructure/sqlite-store.js";

interface WorkerInput {
  databasePath: string;
  startupGate: SharedArrayBuffer;
  writeGate: SharedArrayBuffer;
}

const input = workerData as WorkerInput;
const port = parentPort;
if (port === null) throw new Error("WAL bootstrap retry worker requires a parent port");

port.postMessage({ type: "ready" });
Atomics.wait(new Int32Array(input.startupGate), 0, 0);

let store: SqliteStore | undefined;
try {
  store = new SqliteStore(input.databasePath);
  port.postMessage({ type: "opened" });
  Atomics.wait(new Int32Array(input.writeGate), 0, 0);
  const userId = randomUUID();
  store.createUser({
    id: userId,
    username: `wal_${userId.slice(0, 8)}`,
    usernameNormalized: `wal_${userId.slice(0, 8)}`,
    displayName: "WAL Retry",
    passwordHash: "test-only-hash",
    createdAt: "2026-08-03T12:00:00.000Z"
  });
  port.postMessage({ type: "result", outcome: { ok: true, userId } });
} catch (error) {
  port.postMessage({
    type: "result",
    outcome: {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  });
} finally {
  store?.close();
}
