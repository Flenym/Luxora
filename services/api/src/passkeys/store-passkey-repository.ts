import type { Store } from "../domain/store.js";
import type { PasskeyCredentialRecord, PasskeyUserHandleBinding } from "../domain/types.js";
import type {
  PasskeyCredentialRepository,
  StoredPasskeyCredential,
  StoredPasskeyUserHandle
} from "./simplewebauthn-adapter.js";

const AUTHENTICATOR_TRANSPORTS = new Set<string>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb"
]);

type RepositoryStore = Pick<
  Store,
  | "findPasskeyUserHandleByRef"
  | "findPasskeyCredentialById"
  | "findPasskeyCredentialByRecordId"
  | "listPasskeyCredentialsByAccountId"
>;

function mapHandle(binding: PasskeyUserHandleBinding): StoredPasskeyUserHandle {
  const decoded = Buffer.from(binding.userHandle, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== binding.userHandle) {
    throw new Error("Passkey repository projection is invalid");
  }
  return Object.freeze({
    userHandleRef: binding.reference,
    accountId: binding.accountId,
    userHandle: new Uint8Array(decoded)
  });
}

function mapCredential(record: PasskeyCredentialRecord): StoredPasskeyCredential {
  if (record.transports.some((transport) => !AUTHENTICATOR_TRANSPORTS.has(transport))) {
    throw new Error("Passkey repository projection is invalid");
  }
  return Object.freeze({
    credentialRecordId: record.recordId,
    credentialRevision: record.revision,
    credentialId: record.credentialId,
    publicKey: new Uint8Array(record.publicKey),
    algorithm: record.algorithm,
    accountId: record.accountId,
    userHandleRef: record.userHandleRef,
    discoveryMode: record.discoveryMode,
    credentialSetRef: record.credentialSetRef,
    signCount: record.signCount,
    backupEligible: record.backupEligible,
    backupState: record.backupState,
    transports: Object.freeze([...record.transports]) as StoredPasskeyCredential["transports"]
  });
}

/**
 * The SQLite-facing record names intentionally differ from the maintained
 * verifier boundary. This mapper performs the only plaintext conversion and
 * never logs lookup arguments, misses, decrypted handles, IDs, or keys.
 */
export class StorePasskeyCredentialRepository implements PasskeyCredentialRepository {
  constructor(private readonly store: RepositoryStore) {}

  async findPasskeyUserHandleByRef(userHandleRef: string): Promise<StoredPasskeyUserHandle | null> {
    const binding = await this.store.findPasskeyUserHandleByRef(userHandleRef);
    return binding === null ? null : mapHandle(binding);
  }

  async findPasskeyCredentialById(credentialId: string): Promise<StoredPasskeyCredential | null> {
    const record = await this.store.findPasskeyCredentialById(credentialId);
    return record === null ? null : mapCredential(record);
  }

  async findPasskeyCredentialByRecordId(credentialRecordId: string): Promise<StoredPasskeyCredential | null> {
    const record = await this.store.findPasskeyCredentialByRecordId(credentialRecordId);
    return record === null ? null : mapCredential(record);
  }

  async listPasskeyCredentialsByAccountId(accountId: string): Promise<readonly StoredPasskeyCredential[]> {
    const records = await this.store.listPasskeyCredentialsByAccountId(accountId);
    return Object.freeze(records.map(mapCredential));
  }
}
