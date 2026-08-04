import { parentPort, workerData } from "node:worker_threads";
import type { CreateMessageRequest, CreateSafetyReport } from "@luxora/protocol";
import { AppError } from "../errors.js";
import { SearchHasher } from "../infrastructure/search-hasher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { IdentityAccessService } from "../services/identity-access-service.js";

interface WorkerData {
  databasePath: string;
  holdMilliseconds: number;
  gate: SharedArrayBuffer;
  operation:
    | { type: "message-request"; actorUserId: string; input: CreateMessageRequest }
    | { type: "safety-report"; actorUserId: string; input: CreateSafetyReport };
}

const data = workerData as WorkerData;
const port = parentPort;
if (port === null) throw new Error("Identity race worker requires a parent port");

const store = new SqliteStore(data.databasePath);
const service = new IdentityAccessService(
  store,
  { publish() {}, publishEphemeral() {} },
  new SearchHasher({}, undefined)
);

try {
  const result = store.immediateTransaction(() => {
    const value = data.operation.type === "message-request"
      ? service.createMessageRequest(data.operation.actorUserId, data.operation.input)
      : service.createSafetyReport(data.operation.actorUserId, data.operation.input);
    // Keep an uncommitted writer open while the main test connection enters
    // the same service command. Atomics.wait blocks only this worker thread.
    port.postMessage({ type: "writer-held" });
    Atomics.wait(new Int32Array(data.gate), 0, 0, data.holdMilliseconds);
    return value;
  });
  port.postMessage({ type: "result", outcome: { ok: true, value: result } });
} catch (error) {
  port.postMessage({
    type: "result",
    outcome: error instanceof AppError
      ? {
          ok: false,
          statusCode: error.statusCode,
          code: error.code,
          message: error.message
        }
      : {
          ok: false,
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
  });
} finally {
  store.close();
}
