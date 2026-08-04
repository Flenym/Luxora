import { parentPort, workerData } from "node:worker_threads";
import type { PersistCeremonyMutation } from "@luxora/passkey-domain";
import type {
  PasskeyStepUpClaimsProjection,
  PasskeyUserHandleBinding
} from "../domain/types.js";
import { AesGcmContentCipher } from "../infrastructure/content-cipher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";

interface WorkerInput {
  databasePath: string;
  encodedKey: string;
  gate: SharedArrayBuffer;
  mutation: PersistCeremonyMutation;
  nowMs: number;
  stepUpClaims?: PasskeyStepUpClaimsProjection;
  userHandleBinding?: PasskeyUserHandleBinding;
}

const input = workerData as WorkerInput;
const gate = new Int32Array(input.gate);
const store = new SqliteStore(
  input.databasePath,
  new AesGcmContentCipher({ passkey: input.encodedKey }, "passkey"),
  () => input.nowMs
);

parentPort?.postMessage({ type: "ready" });
Atomics.wait(gate, 0, 0);

try {
  if (input.stepUpClaims === undefined) {
    await store.commit(input.mutation);
  } else {
    if (input.userHandleBinding === undefined) throw new Error("missing user-handle binding");
    await store.commitInitialPasskeyRegistration(
      input.mutation,
      input.stepUpClaims,
      input.userHandleBinding
    );
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
