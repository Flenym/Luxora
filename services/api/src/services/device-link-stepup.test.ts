import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthenticationVerificationExpectations,
  MaintainedWebAuthnVerifierAdapter,
  RegistrationVerificationExpectations
} from "@luxora/passkey-domain";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "../domain/types.js";
import { AppError } from "../errors.js";
import { parsePasskeyResponseBody } from "../http/passkey-response-body.js";
import { AesGcmContentCipher } from "../infrastructure/content-cipher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import type {
  AuthenticationOptionsInput,
  RegistrationOptionsInput,
  SimpleWebAuthnVerifierAdapter
} from "../passkeys/simplewebauthn-adapter.js";
import { StepUpTokenSecurity } from "../passkeys/step-up-token.js";
import { seedExistingPasskeyCredentialForTest } from "../test-support/passkey-service-fixture.js";
import { canonicalTargetDigest, PasskeyService } from "./passkey-service.js";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const START_MS = Date.parse("2026-09-20T00:00:00.000Z");
const TOKEN_SECRET = "device-link-step-up-token-test-secret-at-least-32-bytes";
const EXISTING_CREDENTIAL_ID = Buffer.from("device-link-step-up-credential", "utf8").toString("base64url");
const EXISTING_RECORD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

interface MutableClock {
  value: number;
}

const directories: string[] = [];
const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Service seam only: domain orchestration and encrypted persistence are real;
 * WebAuthn cryptography remains covered by the maintained-adapter suite.
 */
class SeamFakeWebAuthnAdapter implements MaintainedWebAuthnVerifierAdapter {
  readonly implementation = Object.freeze({
    kind: "maintained-webauthn-server-library" as const,
    libraryName: "@simplewebauthn/server",
    libraryVersion: "13.3.2",
    reviewReference: "device-link-step-up-seam-not-cryptography"
  });

  constructor(private readonly store: SqliteStore) {}

  async createRegistrationOptions(
    _input: RegistrationOptionsInput
  ): ReturnType<SimpleWebAuthnVerifierAdapter["createRegistrationOptions"]> {
    throw new Error("registration is outside this device-link test seam");
  }

  async createAuthenticationOptions(
    input: AuthenticationOptionsInput
  ): ReturnType<SimpleWebAuthnVerifierAdapter["createAuthenticationOptions"]> {
    return {
      challenge: input.expectedChallenge,
      rpId: input.expectedRpId,
      timeout: input.timeoutMs,
      userVerification: "required" as const,
      allowCredentials: []
    };
  }

  async verifyRegistration(_response: unknown, _expectations: RegistrationVerificationExpectations) {
    return { status: "rejected" as const, reason: "invalid_webauthn_response" as const };
  }

  async verifyAuthentication(_response: unknown, expectations: AuthenticationVerificationExpectations) {
    const record = await this.store.findPasskeyCredentialById(EXISTING_CREDENTIAL_ID);
    if (record === null || record.accountId !== expectations.expectedAccountId) {
      return { status: "rejected" as const, reason: "invalid_webauthn_response" as const };
    }
    return {
      status: "verified" as const,
      kind: "authentication" as const,
      credential: {
        credentialRecordId: record.recordId,
        credentialRevision: record.revision,
        accountId: expectations.expectedAccountId,
        discoveryMode: "discoverable" as const,
        userHandleBindingVerified: true as const,
        previousSignCount: record.signCount,
        newSignCount: record.signCount + 1,
        previousBackupEligible: record.backupEligible,
        backupEligible: record.backupEligible,
        previousBackupState: record.backupState,
        backupState: record.backupState,
        userPresent: true as const,
        userVerified: true as const
      }
    };
  }
}

interface Harness {
  readonly store: SqliteStore;
  readonly clock: MutableClock;
  readonly principal: AuthenticatedPrincipal;
  readonly service: PasskeyService;
}

async function createHarness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "luxora-device-link-stepup-"));
  directories.push(directory);
  const databasePath = join(directory, "luxora.sqlite");
  const clock: MutableClock = { value: START_MS };
  const key = Buffer.alloc(32, 0x42).toString("base64url");
  const cipher = new AesGcmContentCipher({ service: key }, "service");
  const store = new SqliteStore(databasePath, cipher, () => clock.value);
  stores.push(store);
  const createdAt = new Date(clock.value).toISOString();
  const sessionExpiresAt = new Date(clock.value + 86_400_000).toISOString();
  store.createUser({
    id: ACCOUNT_ID,
    username: "LinkApprover",
    usernameNormalized: "linkapprover",
    displayName: "Link Approver",
    passwordHash: "not-used-by-step-up-test",
    createdAt
  });
  store.createSession({
    id: SESSION_ID,
    userId: ACCOUNT_ID,
    deviceName: "Test endpoint",
    createdAt,
    expiresAt: sessionExpiresAt
  }, {
    id: randomUUID(),
    sessionId: SESSION_ID,
    tokenHash: createHash("sha256").update("device-link-step-up-refresh", "utf8").digest("hex"),
    createdAt,
    expiresAt: sessionExpiresAt
  });
  const handle = await store.getOrCreatePasskeyUserHandleBinding(ACCOUNT_ID);
  seedExistingPasskeyCredentialForTest({
    databasePath,
    cipher,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    userHandleRef: handle.reference,
    credentialId: EXISTING_CREDENTIAL_ID,
    recordId: EXISTING_RECORD_ID,
    nowMs: clock.value,
    targetDigest: createHash("sha256").update("device-link-fixture", "utf8").digest("hex")
  });
  const tokens = new StepUpTokenSecurity(TOKEN_SECRET, () => new Date(clock.value));
  const service = new PasskeyService(store, {
    adapter: new SeamFakeWebAuthnAdapter(store),
    nowMs: () => clock.value,
    stepUpTokens: tokens
  });
  const principal: AuthenticatedPrincipal = { userId: ACCOUNT_ID, sessionId: SESSION_ID, tokenId: TOKEN_ID };
  return { store, clock, principal, service };
}

function expectedDigest(): string {
  return canonicalTargetDigest({
    accountId: ACCOUNT_ID,
    operation: "device-link.approve",
    sessionId: SESSION_ID,
    linkId: LINK_ID
  });
}

describe("device-link step-up issuance", () => {
  it("mints a link-bound device-link.approve token through a consumed ceremony", async () => {
    const harness = await createHarness();
    harness.store.createDeviceLinkChallenge({
      linkId: LINK_ID,
      linkSecretHash: createHash("sha256").update("secret", "utf8").digest("hex"),
      targetLabel: null,
      proofPublicKeyJwk: null,
      createdAt: new Date(harness.clock.value).toISOString(),
      expiresAt: new Date(harness.clock.value + 120_000).toISOString()
    });

    const begun = await harness.service.beginStepUp(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      operation: "device-link.approve",
      linkId: LINK_ID
    });
    harness.clock.value += 1_000;
    const verified = await harness.service.verify(harness.principal, {
      ceremonyId: begun.ceremony.id,
      commandId: randomUUID(),
      expectedRevision: begun.ceremony.revision,
      response: parsePasskeyResponseBody(Buffer.from(JSON.stringify({ fixture: "authentication" }), "utf8"))
    });
    if (!("stepUpAuthorization" in verified)) throw new Error("step-up authorization missing");
    expect(verified.stepUpAuthorization.purpose).toBe("device-link.approve");

    const claims = decodeJwt(verified.stepUpAuthorization.token) as Record<string, unknown>;
    expect(claims["purpose"]).toBe("device-link.approve");
    expect(claims["target_digest"]).toBe(expectedDigest());
    expect(claims["sub"]).toBe(ACCOUNT_ID);
    expect(claims["sid"]).toBe(SESSION_ID);

    const grant = harness.store.findDeviceLinkStepUpGrant(begun.ceremony.id);
    expect(grant).toMatchObject({
      linkId: LINK_ID,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      targetDigest: expectedDigest()
    });
  });

  it("rejects unknown links and keeps authenticator.add issuance untouched", async () => {
    const harness = await createHarness();
    await expect(harness.service.beginStepUp(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      operation: "device-link.approve",
      linkId: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    })).rejects.toMatchObject({ statusCode: 404 });

    await expect(harness.service.beginStepUp(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      operation: "device-link.approve",
      linkId: undefined
    })).rejects.toMatchObject({ statusCode: 400 });

    const begun = await harness.service.beginStepUp(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      operation: "authenticator.add"
    });
    expect(begun.operation).toBe("authenticator.add");
  });
});
