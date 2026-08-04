import { parentPort, workerData } from "node:worker_threads";

import type {
  PersistPasskeyAuthenticatorRename,
  PersistPasskeyAuthenticatorRevoke
} from "../domain/store.js";
import { AesGcmContentCipher } from "../infrastructure/content-cipher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";

type ManagementMutation = PersistPasskeyAuthenticatorRename | PersistPasskeyAuthenticatorRevoke;

interface WorkerInput {
  readonly databasePath: string;
  readonly encodedKey: string;
  readonly keyId: string;
  readonly gate: SharedArrayBuffer;
  readonly input: ManagementMutation;
  readonly nowMs: number;
}

const workerInput = workerData as WorkerInput;
const gate = new Int32Array(workerInput.gate);
const store = new SqliteStore(
  workerInput.databasePath,
  new AesGcmContentCipher(
    { [workerInput.keyId]: workerInput.encodedKey },
    workerInput.keyId
  ),
  () => workerInput.nowMs
);

parentPort?.postMessage({ type: "ready" });
Atomics.wait(gate, 0, 0);

try {
  const result = workerInput.input.operation === "rename"
    ? await store.commitPasskeyAuthenticatorRename(workerInput.input)
    : await store.commitPasskeyAuthenticatorRevoke(workerInput.input);
  parentPort?.postMessage({
    type: "result",
    outcome: {
      ok: true,
      replayed: result.replayed,
      revision: result.authenticator.revision,
      lifecycleState: result.authenticator.lifecycleState
    }
  });
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
