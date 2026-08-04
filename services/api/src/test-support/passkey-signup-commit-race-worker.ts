import { parentPort, workerData } from "node:worker_threads";

import type {
  PersistPasskeySignupRejectedAttempt,
  PersistVerifiedPasskeySignup
} from "../domain/store.js";
import { AesGcmContentCipher } from "../infrastructure/content-cipher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";

interface WorkerBase {
  databasePath: string;
  encodedKey: string;
  gate: SharedArrayBuffer;
  nowMs: number;
}

type WorkerInput = WorkerBase & (
  | { operation: "rejected"; input: PersistPasskeySignupRejectedAttempt }
  | { operation: "verified"; input: PersistVerifiedPasskeySignup }
);

const input = workerData as WorkerInput;
const gate = new Int32Array(input.gate);
const store = new SqliteStore(
  input.databasePath,
  new AesGcmContentCipher({ active: input.encodedKey }, "active"),
  () => input.nowMs
);

parentPort?.postMessage({ type: "ready" });
Atomics.wait(gate, 0, 0);

try {
  if (input.operation === "rejected") {
    await store.commitPasskeySignupRejectedAttempt(input.input);
  } else {
    await store.commitVerifiedPasskeySignup(input.input);
  }
  parentPort?.postMessage({ type: "result", outcome: { ok: true } });
} catch (error) {
  parentPort?.postMessage({
    type: "result",
    outcome: {
      ok: false,
      name: error instanceof Error ? error.name : "Error"
    }
  });
} finally {
  store.close();
}
