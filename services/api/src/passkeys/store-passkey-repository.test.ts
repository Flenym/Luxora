import { describe, expect, it } from "vitest";
import type { PasskeyCredentialRecord, PasskeyUserHandleBinding } from "../domain/types.js";
import { StorePasskeyCredentialRepository } from "./store-passkey-repository.js";

const handle: PasskeyUserHandleBinding = {
  reference: "user-handle:one",
  accountId: "account-one",
  userHandle: Buffer.alloc(32, 0x5a).toString("base64url"),
  createdAtMs: 1
};

const credential: PasskeyCredentialRecord = {
  recordId: "credential-record:one",
  credentialId: Buffer.from("credential-one", "utf8").toString("base64url"),
  accountId: handle.accountId,
  userHandleRef: handle.reference,
  publicKey: new Uint8Array([1, 2, 3]),
  algorithm: -7,
  discoveryMode: "discoverable",
  credentialSetRef: null,
  revision: 4,
  signCount: 9,
  backupEligible: true,
  backupState: false,
  transports: ["internal", "cable"],
  registrationCeremonyId: "ceremony-one",
  createdAtMs: 1,
  updatedAtMs: 2
};

function repository(overrides: {
  readonly handle?: PasskeyUserHandleBinding | null;
  readonly credential?: PasskeyCredentialRecord | null;
} = {}) {
  const selectedHandle = overrides.handle === undefined ? handle : overrides.handle;
  const selectedCredential = overrides.credential === undefined ? credential : overrides.credential;
  return new StorePasskeyCredentialRepository({
    async findPasskeyUserHandleByRef() { return selectedHandle; },
    async findPasskeyCredentialById() { return selectedCredential; },
    async findPasskeyCredentialByRecordId() { return selectedCredential; },
    async listPasskeyCredentialsByAccountId() {
      return selectedCredential === null ? [] : [selectedCredential];
    }
  });
}

describe("Store passkey verifier repository projection", () => {
  it("decodes the encrypted-store handle projection and renames credential CAS fields", async () => {
    const projected = repository();
    const projectedHandle = await projected.findPasskeyUserHandleByRef(handle.reference);
    const projectedCredential = await projected.findPasskeyCredentialById(credential.credentialId);

    expect(projectedHandle).toEqual({
      userHandleRef: handle.reference,
      accountId: handle.accountId,
      userHandle: new Uint8Array(Buffer.from(handle.userHandle, "base64url"))
    });
    expect(projectedCredential).toMatchObject({
      credentialRecordId: credential.recordId,
      credentialRevision: credential.revision,
      transports: ["internal", "cable"]
    });
    expect(projectedCredential?.publicKey).not.toBe(credential.publicKey);
  });

  it("fails closed on a non-canonical user handle or unknown transport", async () => {
    await expect(repository({ handle: { ...handle, userHandle: "AB" } })
      .findPasskeyUserHandleByRef(handle.reference)).rejects.toThrow("projection is invalid");
    await expect(repository({ credential: { ...credential, transports: ["future-transport"] } })
      .findPasskeyCredentialById(credential.credentialId)).rejects.toThrow("projection is invalid");
  });

  it("preserves misses without inventing credential or user state", async () => {
    const projected = repository({ handle: null, credential: null });
    await expect(projected.findPasskeyUserHandleByRef("missing")).resolves.toBeNull();
    await expect(projected.findPasskeyCredentialById("missing")).resolves.toBeNull();
    await expect(projected.listPasskeyCredentialsByAccountId("missing")).resolves.toEqual([]);
  });
});
