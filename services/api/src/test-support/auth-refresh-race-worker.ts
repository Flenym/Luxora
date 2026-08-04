import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { SqliteStore } from "../infrastructure/sqlite-store.js";

interface WorkerData {
  databasePath: string;
  rawToken: string;
  rotatedAt: string;
  holdMilliseconds: number;
  gate: SharedArrayBuffer;
}

const data = workerData as WorkerData;
const port = parentPort;
if (port === null) throw new Error("Auth refresh race worker requires a parent port");

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");
const store = new SqliteStore(data.databasePath);

try {
  store.immediateTransaction(() => {
    const current = store.findRefreshToken(hash(data.rawToken));
    if (current === null || current.usedAt !== null) {
      throw new Error("Refresh race fixture did not find an unused token");
    }
    const replacementRaw = `luxr_${randomBytes(32).toString("base64url")}`;
    const rotated = store.rotateRefreshToken(current.id, {
      id: randomUUID(),
      sessionId: current.sessionId,
      tokenHash: hash(replacementRaw),
      createdAt: data.rotatedAt,
      expiresAt: current.session.expiresAt
    }, data.rotatedAt);
    if (!rotated) throw new Error("Refresh race fixture lost its writer CAS");
    port.postMessage({ type: "writer-held" });
    Atomics.wait(new Int32Array(data.gate), 0, 0, data.holdMilliseconds);
  });
  port.postMessage({ type: "result", ok: true });
} catch (error) {
  port.postMessage({
    type: "result",
    ok: false,
    message: error instanceof Error ? error.message : String(error)
  });
} finally {
  store.close();
}
