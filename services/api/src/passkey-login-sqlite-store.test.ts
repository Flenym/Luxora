import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PASSKEY_CHALLENGE_BYTES,
  StoreCredentialStateConflictError,
  StoreDuplicateCommandError,
  StoreRevisionConflictError
} from "@luxora/passkey-domain";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PasskeyLoginEventType,
  PersistPasskeyLoginBegin,
  PersistPasskeyLoginRejectedAttempt,
  PersistPasskeyLoginTerminal,
  PersistVerifiedPasskeyLogin
} from "./domain/store.js";
import type { PasskeyCredentialRecord, PasskeyLoginIntentState } from "./domain/types.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { migrations } from "./infrastructure/migrations.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { PasskeyBootstrapRefreshTokenSecurity } from "./passkeys/bootstrap-refresh-token.js";
import { PasskeyLoginExpirySweeper } from "./services/passkey-login-expiry-sweeper.js";

const NOW_MS = 1_800_000_000_000;
const TIMEOUT_MS = 300_000;
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_RECORD_ID = "33333333-3333-4333-8333-333333333333";
const REGISTRATION_ID = "44444444-4444-4444-8444-444444444444";
const INTENT_A = "55555555-5555-4555-8555-555555555555";
const INTENT_B = "66666666-6666-4666-8666-666666666666";
const LOGIN_SESSION_A = "77777777-7777-4777-8777-777777777777";
const LOGIN_SESSION_B = "88888888-8888-4888-8888-888888888888";
const REFRESH_ID_A = "99999999-9999-4999-8999-999999999999";
const REFRESH_ID_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NON_CANONICAL_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const REFRESH_KEY_ID = "v1.active";
const CREDENTIAL_ID = Buffer.from("luxora-login-credential", "utf8").toString("base64url");
const USER_HANDLE = randomBytes(32).toString("base64url");
const USER_HANDLE_REF = "passkey-login-user-handle";
const DELIVERY_NONCE_A = randomBytes(32).toString("base64url");
const DELIVERY_NONCE_B = randomBytes(32).toString("base64url");
const REFRESH_ROOT_KEY = randomBytes(32).toString("base64url");

interface MutableClock {
  value: number;
}

interface StoreFixture {
  path: string;
  encodedCipherKey: string;
  cipher: AesGcmContentCipher;
  clock: MutableClock;
  store: SqliteStore;
}

interface BegunLogin {
  input: PersistPasskeyLoginBegin;
  challenge: string;
  deliveryNonce: string;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBytes(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");
}

function refreshHash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("base64url");
}

function bootstrapDatabase(path: string, cipher: AesGcmContentCipher): void {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const apply = (index: number): void => {
    const migration = migrations[index];
    if (migration === undefined) throw new Error("missing migration fixture");
    database.exec(migration.sql);
    database.prepare(`
      INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)
    `).run(migration.id, new Date(NOW_MS).toISOString());
  };
  for (let index = 0; index <= 8; index += 1) apply(index);

  const createdAt = new Date(NOW_MS - 10_000).toISOString();
  const expiresAt = new Date(NOW_MS + 86_400_000).toISOString();
  database.prepare(`
    INSERT INTO users (
      id, username, username_normalized, display_name, password_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ACCOUNT_ID,
    "passkey_login_user",
    "passkey_login_user",
    "Passkey Login User",
    "test-only-password-hash",
    createdAt,
    createdAt
  );
  database.prepare(`
    INSERT INTO device_sessions (
      id, user_id, device_name, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    CREDENTIAL_SESSION_ID,
    ACCOUNT_ID,
    "Credential registration session",
    createdAt,
    createdAt,
    expiresAt
  );
  database.prepare(`
    INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "credential-registration-refresh",
    CREDENTIAL_SESSION_ID,
    refreshHash("credential-registration-refresh"),
    createdAt,
    expiresAt
  );
  database.prepare(`
    INSERT INTO passkey_user_handles (
      reference, account_id, handle_digest, handle_ciphertext, created_at_ms
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    USER_HANDLE_REF,
    ACCOUNT_ID,
    digestText(USER_HANDLE),
    cipher.encrypt(USER_HANDLE, `passkey-user-handle:${USER_HANDLE_REF}:${ACCOUNT_ID}`),
    NOW_MS - 10_000
  );
  database.prepare(`
    INSERT INTO passkey_ceremonies (
      ceremony_id, schema_version, kind, purpose_type, purpose_target_digest,
      account_id, session_id, device_id, user_handle_ref, challenge_reference,
      challenge_digest, state, revision, attempts_used, max_attempts,
      expires_at_ms, updated_at_ms, snapshot_json
    ) VALUES (
      ?, 1, 'registration', 'authenticator.add', ?, ?, ?, ?, ?, ?, ?,
      'consumed', 2, 0, 3, ?, ?, '{}'
    )
  `).run(
    REGISTRATION_ID,
    digestText("authenticator.add"),
    ACCOUNT_ID,
    CREDENTIAL_SESSION_ID,
    CREDENTIAL_SESSION_ID,
    USER_HANDLE_REF,
    "seed-registration-challenge",
    digestText("seed-registration-challenge"),
    NOW_MS + TIMEOUT_MS,
    NOW_MS - 10_000
  );
  const publicKey = Buffer.from([1, 2, 3, 4]).toString("base64url");
  database.prepare(`
    INSERT INTO passkey_credentials (
      record_id, credential_id_digest, credential_id_ciphertext, account_id,
      user_handle_ref, credential_material_ciphertext, algorithm, discovery_mode,
      credential_set_ref, revision, sign_count, backup_eligible, backup_state,
      registration_ceremony_id, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, -7, 'discoverable', NULL, 1, 0, 1, 0, ?, ?, ?)
  `).run(
    CREDENTIAL_RECORD_ID,
    digestText(CREDENTIAL_ID),
    cipher.encrypt(CREDENTIAL_ID, `passkey-credential-id:${CREDENTIAL_RECORD_ID}`),
    ACCOUNT_ID,
    USER_HANDLE_REF,
    cipher.encrypt(JSON.stringify({
      accountId: ACCOUNT_ID,
      algorithm: -7,
      credentialSetRef: null,
      discoveryMode: "discoverable",
      publicKey,
      transports: ["internal"],
      userHandleRef: USER_HANDLE_REF
    }), `passkey-credential-material:${CREDENTIAL_RECORD_ID}`),
    REGISTRATION_ID,
    NOW_MS - 10_000,
    NOW_MS - 10_000
  );

  for (let index = 9; index < migrations.length; index += 1) apply(index);
  database.close();
}

function mutation(
  intentId: string,
  revision: number,
  state: PasskeyLoginIntentState,
  type: PasskeyLoginEventType,
  atMs: number,
  label: string,
  outboxId = `login-outbox:${label}`
) {
  const eventId = `login-event:${label}`;
  const commandScope = `login-command:${label}`;
  return {
    event: {
      eventId,
      intentId,
      revision,
      type,
      commandScope,
      occurredAtMs: atMs,
      state
    },
    outbox: {
      outboxId,
      topic: "luxora.passkey-login.v1" as const,
      partitionKey: intentId,
      eventId,
      availableAtMs: atMs
    },
    commandReceipt: {
      scope: commandScope,
      fingerprint: digestText(`fingerprint:${label}`),
      intentId,
      resultRevision: revision,
      resultState: state,
      eventId,
      createdAtMs: atMs
    }
  };
}

function rejectedInput(
  current: PersistPasskeyLoginBegin | PersistPasskeyLoginRejectedAttempt,
  expectedRevision: number,
  atMs: number,
  label: string,
  exhausted: boolean,
  outboxId?: string
): PersistPasskeyLoginRejectedAttempt {
  const intentId = "intent" in current ? current.intent.intentId : current.intentId;
  return {
    intentId,
    expectedRevision,
    updatedAtMs: atMs,
    nextState: exhausted ? "rejected" : "pending",
    ...mutation(
      intentId,
      expectedRevision + 1,
      exhausted ? "rejected" : "pending",
      exhausted
        ? "passkey.login.attempts_exhausted"
        : "passkey.login.verification_rejected",
      atMs,
      label,
      outboxId
    )
  };
}

function terminalInput(
  begun: PersistPasskeyLoginBegin,
  atMs: number,
  label: string,
  state: "cancelled" | "expired"
): PersistPasskeyLoginTerminal {
  return {
    intentId: begun.intent.intentId,
    expectedRevision: begun.intent.revision,
    terminalAtMs: atMs,
    nextState: state,
    ...mutation(
      begun.intent.intentId,
      begun.intent.revision + 1,
      state,
      state === "cancelled"
        ? "passkey.login.cancelled"
        : "passkey.login.expired",
      atMs,
      label
    )
  };
}

function verifiedInput(
  begun: BegunLogin,
  credential: PasskeyCredentialRecord,
  intentId: string,
  sessionId: string,
  refreshId: string,
  deliveryNonce: string,
  atMs: number,
  label: string
): { input: PersistVerifiedPasskeyLogin; refreshRaw: string } {
  const refreshSecurity = new PasskeyBootstrapRefreshTokenSecurity(
    { [REFRESH_KEY_ID]: REFRESH_ROOT_KEY },
    REFRESH_KEY_ID
  );
  const derived = refreshSecurity.deriveActive({
    intentId,
    accountId: ACCOUNT_ID,
    sessionId,
    deliveryNonce
  });
  const createdAt = new Date(atMs).toISOString();
  const expiresAt = new Date(atMs + 30 * 86_400_000).toISOString();
  return {
    refreshRaw: derived.raw,
    input: {
      intentId,
      expectedRevision: 1,
      committedAtMs: atMs,
      credential: {
        accountId: credential.accountId,
        userHandleRef: credential.userHandleRef,
        credentialRecordId: credential.recordId,
        credentialRevision: credential.revision,
        algorithm: credential.algorithm,
        discoveryMode: "discoverable",
        previousSignCount: credential.signCount,
        newSignCount: 0,
        previousBackupEligible: credential.backupEligible,
        backupEligible: credential.backupEligible,
        previousBackupState: credential.backupState,
        backupState: credential.backupState,
        userHandleBindingVerified: true,
        userPresent: true,
        userVerified: true
      },
      session: {
        id: sessionId,
        userId: credential.accountId,
        deviceName: "Passkey login",
        createdAt,
        expiresAt
      },
      refreshToken: {
        id: refreshId,
        sessionId,
        tokenHash: derived.hash,
        createdAt,
        expiresAt,
        derivationKeyId: derived.keyId,
        deliveryNonceDigest: derived.deliveryNonceDigest
      },
      accessToken: {
        tokenId: intentId,
        issuedAtSec: Math.floor(atMs / 1_000),
        expiresAtSec: Math.floor(atMs / 1_000) + 900
      },
      ...mutation(
        intentId,
        2,
        "consumed",
        "passkey.login.consumed",
        atMs,
        label
      )
    }
  };
}

describe("SQLite identifier-free passkey login store", () => {
  const directories: string[] = [];
  const stores: SqliteStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // A restart test may already have closed it.
      }
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function openFixture(label: string): StoreFixture {
    const directory = mkdtempSync(join(tmpdir(), `luxora-passkey-login-${label}-`));
    directories.push(directory);
    const path = join(directory, "luxora.sqlite");
    const encodedCipherKey = randomBytes(32).toString("base64url");
    const cipher = new AesGcmContentCipher({ passkey: encodedCipherKey }, "passkey");
    bootstrapDatabase(path, cipher);
    const clock = { value: NOW_MS };
    const store = new SqliteStore(path, cipher, () => clock.value);
    stores.push(store);
    return { path, encodedCipherKey, cipher, clock, store };
  }

  async function begin(
    fixture: StoreFixture,
    intentId: string,
    deliveryNonce: string,
    label: string
  ): Promise<BegunLogin> {
    const issued = await fixture.store.issue({
      byteLength: PASSKEY_CHALLENGE_BYTES,
      expiresAtMs: NOW_MS + TIMEOUT_MS
    });
    const started = mutation(
      intentId,
      1,
      "pending",
      "passkey.login.started",
      NOW_MS,
      `${label}:started`
    );
    const input: PersistPasskeyLoginBegin = {
      intent: {
        intentId,
        schemaVersion: 1,
        purpose: {
          type: "session.create",
          targetDigest: digestText("luxora:session.create:v1")
        },
        policyVersion: 1,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 30 * 86_400,
        recoveryGraceSeconds: 300,
        expectedRpId: "auth.luxora.app",
        expectedOrigin: "https://auth.luxora.app",
        timeoutMs: TIMEOUT_MS,
        maxResponseBytes: 65_536,
        maxAttempts: 3,
        allowedAlgorithms: [-7, -257],
        userVerification: "required",
        crossOriginAllowed: false,
        credentialBoundary: {
          mode: "discoverable_any",
          credentialSetRef: null
        },
        challenge: {
          reference: issued.reference,
          digest: digestBytes(issued.challenge)
        },
        deliveryNonceDigest: digestBytes(deliveryNonce),
        refreshDerivationKeyId: REFRESH_KEY_ID,
        state: "pending",
        revision: 1,
        attemptsUsed: 0,
        createdAtMs: NOW_MS,
        expiresAtMs: NOW_MS + TIMEOUT_MS,
        updatedAtMs: NOW_MS,
        terminalAtMs: null,
        terminalReason: null
      },
      ...started,
      creationReceipt: {
        scope: `login-create:${label}`,
        fingerprint: digestText(`create-fingerprint:${label}`),
        intentId,
        resultRevision: 1,
        resultState: "pending",
        eventId: started.event.eventId,
        createdAtMs: NOW_MS
      }
    };
    await fixture.store.commitPasskeyLoginBegin(input);
    return { input, challenge: issued.challenge, deliveryNonce };
  }

  function closeFixtureStore(fixture: StoreFixture): void {
    const index = stores.indexOf(fixture.store);
    if (index >= 0) stores.splice(index, 1);
    fixture.store.close();
  }

  it("commits a privacy-safe pending intent and exact linked receipts", async () => {
    const fixture = openFixture("begin");
    // The service captures intent time before the vault samples its own clock.
    fixture.clock.value = NOW_MS + 1;
    const begun = await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "begin");

    const loaded = await fixture.store.findPasskeyLoginIntent(INTENT_A);
    expect(loaded).toMatchObject({
      intentId: INTENT_A,
      purpose: { type: "session.create" },
      credentialBoundary: { mode: "discoverable_any", credentialSetRef: null },
      state: "pending",
      revision: 1,
      attemptsUsed: 0,
      resolution: null,
      accessTokenTtlSeconds: 900,
      sessionTtlSeconds: 30 * 86_400,
      recoveryGraceSeconds: 300,
      deliveryNonceDigest: digestBytes(DELIVERY_NONCE_A),
      refreshDerivationKeyId: REFRESH_KEY_ID
    });
    expect(await fixture.store.findPasskeyLoginCommandReceipt(
      begun.input.commandReceipt.scope
    )).toEqual(begun.input.commandReceipt);
    expect(await fixture.store.findPasskeyLoginCreationReceipt(
      begun.input.creationReceipt.scope
    )).toEqual(begun.input.creationReceipt);
    expect(await fixture.store.resolve(loaded!.challenge.reference)).toBe(begun.challenge);

    await expect(fixture.store.commitPasskeyLoginBegin(begun.input))
      .rejects.toBeInstanceOf(StoreDuplicateCommandError);
  });

  it("rejects accessor, hidden, symbol-extended, and proxied algorithm tuples without reading them", async () => {
    const fixture = openFixture("algorithm-boundary");
    const begun = await begin(
      fixture,
      INTENT_A,
      DELIVERY_NONCE_A,
      "algorithm-boundary"
    );
    let accessorReads = 0;
    const accessorTuple = [-7, -257];
    Object.defineProperty(accessorTuple, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return -7;
      }
    });
    const hiddenTuple = [-7, -257];
    Object.defineProperty(hiddenTuple, "0", {
      configurable: true,
      enumerable: false,
      value: -7,
      writable: true
    });
    const symbolTuple = [-7, -257] as Array<number> & { [key: symbol]: boolean };
    symbolTuple[Symbol("hidden-algorithm-extension")] = true;
    let proxyReads = 0;
    const proxyTuple = new Proxy([-7, -257], {
      get: () => {
        proxyReads += 1;
        throw new Error("algorithm proxy must not be read");
      }
    });

    for (const allowedAlgorithms of [
      accessorTuple,
      hiddenTuple,
      symbolTuple,
      proxyTuple
    ]) {
      const hostile = {
        ...begun.input,
        intent: {
          ...begun.input.intent,
          allowedAlgorithms
        }
      } as unknown as PersistPasskeyLoginBegin;
      await expect(fixture.store.commitPasskeyLoginBegin(hostile))
        .rejects.toThrow("Passkey repository integrity check failed");
    }
    expect(accessorReads).toBe(0);
    expect(proxyReads).toBe(0);
  });

  it("rejects hostile string-like opaque IDs, base64url, digests, and key IDs without coercion", async () => {
    const fixture = openFixture("string-no-coercion");
    const begun = await begin(
      fixture,
      INTENT_A,
      DELIVERY_NONCE_A,
      "string-no-coercion"
    );
    let coercionReads = 0;
    const hostileStringLike = (): object => {
      const value = Object.create(null) as object;
      Object.defineProperties(value, {
        [Symbol.toPrimitive]: {
          configurable: true,
          get: () => {
            coercionReads += 1;
            throw new Error("hostile Symbol.toPrimitive getter executed");
          }
        },
        toString: {
          configurable: true,
          get: () => {
            coercionReads += 1;
            throw new Error("hostile toString getter executed");
          }
        }
      });
      return value;
    };

    const hostileOpaqueId = {
      ...begun.input,
      intent: {
        ...begun.input.intent,
        challenge: {
          ...begun.input.intent.challenge,
          reference: hostileStringLike()
        }
      }
    } as unknown as PersistPasskeyLoginBegin;
    const hostileDigest = {
      ...begun.input,
      intent: {
        ...begun.input.intent,
        purpose: {
          ...begun.input.intent.purpose,
          targetDigest: hostileStringLike()
        }
      }
    } as unknown as PersistPasskeyLoginBegin;
    const hostileKeyId = {
      ...begun.input,
      intent: {
        ...begun.input.intent,
        refreshDerivationKeyId: hostileStringLike()
      }
    } as unknown as PersistPasskeyLoginBegin;

    for (const hostile of [hostileOpaqueId, hostileDigest, hostileKeyId]) {
      await expect(fixture.store.commitPasskeyLoginBegin(hostile))
        .rejects.toThrow("Passkey repository integrity check failed");
    }
    expect(await fixture.store.findPasskeyCredentialById(
      hostileStringLike() as unknown as string
    )).toBeNull();
    expect(coercionReads).toBe(0);
  });

  it("requires one canonical UUID identity across the begin aggregate", async () => {
    const fixture = openFixture("begin-id-boundary");
    const begun = await begin(
      fixture,
      INTENT_A,
      DELIVERY_NONCE_A,
      "begin-id-boundary"
    );
    const hostile = {
      ...begun.input,
      intent: { ...begun.input.intent, intentId: NON_CANONICAL_ID },
      event: { ...begun.input.event, intentId: NON_CANONICAL_ID },
      outbox: { ...begun.input.outbox, partitionKey: NON_CANONICAL_ID },
      commandReceipt: {
        ...begun.input.commandReceipt,
        intentId: NON_CANONICAL_ID
      },
      creationReceipt: {
        ...begun.input.creationReceipt,
        intentId: NON_CANONICAL_ID
      }
    } as PersistPasskeyLoginBegin;

    await expect(fixture.store.commitPasskeyLoginBegin(hostile))
      .rejects.toThrow("Passkey repository integrity check failed");
    expect(await fixture.store.findPasskeyLoginIntent(NON_CANONICAL_ID)).toBeNull();
  });

  it("rolls back an incomplete rejected attempt and deletes the challenge only when exhausted", async () => {
    const fixture = openFixture("reject");
    const begun = await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "reject");
    fixture.clock.value = NOW_MS + 1;
    const colliding = rejectedInput(
      begun.input,
      1,
      fixture.clock.value,
      "reject:attempt-1",
      false,
      begun.input.outbox.outboxId
    );
    await expect(fixture.store.commitPasskeyLoginRejectedAttempt(colliding)).rejects.toThrow();
    expect(await fixture.store.findPasskeyLoginIntent(INTENT_A)).toMatchObject({
      state: "pending",
      revision: 1,
      attemptsUsed: 0
    });
    expect(await fixture.store.findPasskeyLoginCommandReceipt(
      colliding.commandReceipt.scope
    )).toBeNull();

    const first = rejectedInput(
      begun.input,
      1,
      fixture.clock.value,
      "reject:attempt-1",
      false
    );
    await fixture.store.commitPasskeyLoginRejectedAttempt(first);
    fixture.clock.value += 1;
    const second = rejectedInput(first, 2, fixture.clock.value, "reject:attempt-2", false);
    await fixture.store.commitPasskeyLoginRejectedAttempt(second);
    fixture.clock.value += 1;
    const third = rejectedInput(second, 3, fixture.clock.value, "reject:attempt-3", true);
    await fixture.store.commitPasskeyLoginRejectedAttempt(third);

    const rejected = await fixture.store.findPasskeyLoginIntent(INTENT_A);
    expect(rejected).toMatchObject({
      state: "rejected",
      revision: 4,
      attemptsUsed: 3,
      terminalReason: "attempts_exhausted",
      resolution: null
    });
    expect(await fixture.store.resolve(rejected!.challenge.reference)).toBeNull();
    await expect(fixture.store.commitPasskeyLoginRejectedAttempt(third))
      .rejects.toBeInstanceOf(StoreDuplicateCommandError);
  });

  it.each([
    ["cancelled", NOW_MS + 1] as const,
    ["expired", NOW_MS + TIMEOUT_MS] as const
  ])("atomically commits a %s terminal lifecycle with receipt and challenge cleanup", async (
    state,
    terminalAtMs
  ) => {
    const fixture = openFixture(`terminal-${state}`);
    const begun = await begin(
      fixture,
      INTENT_A,
      DELIVERY_NONCE_A,
      `terminal-${state}`
    );
    fixture.clock.value = terminalAtMs;
    const terminal = terminalInput(
      begun.input,
      terminalAtMs,
      `terminal-${state}:commit`,
      state
    );

    await fixture.store.commitPasskeyLoginTerminal(terminal);

    expect(await fixture.store.findPasskeyLoginIntent(INTENT_A)).toMatchObject({
      state,
      revision: 2,
      attemptsUsed: 0,
      terminalAtMs,
      terminalReason: state,
      resolution: null
    });
    expect(await fixture.store.findPasskeyLoginCommandReceipt(
      terminal.commandReceipt.scope
    )).toEqual(terminal.commandReceipt);
    expect(await fixture.store.resolve(begun.input.intent.challenge.reference)).toBeNull();
    await expect(fixture.store.commitPasskeyLoginTerminal(terminal))
      .rejects.toBeInstanceOf(StoreDuplicateCommandError);
  });

  it("lists expired pending intents in bounded expiry/ID order without coercion", async () => {
    const fixture = openFixture("expiry-list");
    await begin(fixture, INTENT_B, DELIVERY_NONCE_B, "expiry-list-b");
    await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "expiry-list-a");

    expect(await fixture.store.listExpiredPendingPasskeyLoginIntents(
      NOW_MS + TIMEOUT_MS - 1,
      2
    )).toEqual([]);
    const first = await fixture.store.listExpiredPendingPasskeyLoginIntents(
      NOW_MS + TIMEOUT_MS,
      1
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.map((value) => value.intentId)).toEqual([INTENT_A]);
    expect((await fixture.store.listExpiredPendingPasskeyLoginIntents(
      NOW_MS + TIMEOUT_MS,
      2
    )).map((value) => value.intentId)).toEqual([INTENT_A, INTENT_B]);
    await expect(fixture.store.listExpiredPendingPasskeyLoginIntents(
      NOW_MS + TIMEOUT_MS,
      1_000
    )).resolves.toHaveLength(2);

    for (const [observedAtMs, limit] of [
      [-1, 1],
      [1.5, 1],
      [NOW_MS, 0],
      [NOW_MS, 1.5],
      [NOW_MS, 1_001],
      [NOW_MS, "1"]
    ] as const) {
      await expect(fixture.store.listExpiredPendingPasskeyLoginIntents(
        observedAtMs as number,
        limit as number
      )).rejects.toThrow("Passkey repository integrity check failed");
    }
  });

  it("fails closed when an expiry candidate no longer matches the durable projection", async () => {
    const fixture = openFixture("expiry-list-integrity");
    await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "expiry-list-integrity");
    closeFixtureStore(fixture);

    const database = new Database(fixture.path);
    database.pragma("ignore_check_constraints = ON");
    database.exec(`
      DROP TRIGGER trg_passkey_login_intents_immutable_binding;
      DROP TRIGGER trg_passkey_login_intents_state_transition;
    `);
    database.prepare(`
      UPDATE passkey_login_intents SET expected_origin = 'https://attacker.invalid'
      WHERE intent_id = ?
    `).run(INTENT_A);
    database.close();

    const restarted = new SqliteStore(fixture.path, fixture.cipher, () => (
      NOW_MS + TIMEOUT_MS
    ));
    stores.push(restarted);
    await expect(restarted.listExpiredPendingPasskeyLoginIntents(
      NOW_MS + TIMEOUT_MS,
      1
    )).rejects.toThrow("Passkey repository integrity check failed");
  });

  it("sweeps a durable expired intent with challenge, event, outbox, and receipt atomically", async () => {
    const fixture = openFixture("expiry-sweep");
    const begun = await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "expiry-sweep");
    fixture.clock.value = NOW_MS + TIMEOUT_MS;
    let nextId = 0;
    const sweeper = new PasskeyLoginExpirySweeper(fixture.store, {
      batchSize: 1,
      maxBatchesPerSweep: 2,
      clock: () => fixture.clock.value,
      idFactory: () => {
        nextId += 1;
        return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
      }
    });

    await expect(sweeper.sweep()).resolves.toEqual({
      scanned: 1,
      expired: 1,
      skipped: 0,
      batches: 2,
      busy: false
    });
    expect(await fixture.store.findPasskeyLoginIntent(INTENT_A)).toMatchObject({
      state: "expired",
      revision: 2,
      terminalAtMs: fixture.clock.value,
      terminalReason: "expired",
      resolution: null
    });
    expect(await fixture.store.resolve(begun.input.intent.challenge.reference)).toBeNull();

    const database = new Database(fixture.path);
    const event = database.prepare(`
      SELECT event_id, command_scope, event_json
      FROM passkey_login_events
      WHERE intent_id = ? AND event_type = 'passkey.login.expired'
    `).get(INTENT_A) as {
      event_id: string;
      command_scope: string;
      event_json: string;
    } | undefined;
    expect(event).toBeDefined();
    expect(event!.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event!.command_scope).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(event!.event_json)).toEqual({
      type: "passkey.login.expired",
      intentId: INTENT_A,
      revision: 2,
      state: "expired"
    });
    const outbox = database.prepare(`
      SELECT outbox_id, event_id, topic, partition_key, payload_json
      FROM passkey_login_outbox
      WHERE event_id = ?
    `).get(event!.event_id) as Record<string, unknown> | undefined;
    expect(outbox).toMatchObject({
      event_id: event!.event_id,
      topic: "luxora.passkey-login.v1",
      partition_key: INTENT_A
    });
    expect(outbox?.["outbox_id"]).toMatch(/^[0-9a-f-]{36}$/);
    const receipt = database.prepare(`
      SELECT scope, fingerprint, result_revision, result_state, event_id
      FROM passkey_login_command_receipts
      WHERE scope = ?
    `).get(event!.command_scope) as Record<string, unknown> | undefined;
    expect(receipt).toMatchObject({
      scope: event!.command_scope,
      result_revision: 2,
      result_state: "expired",
      event_id: event!.event_id
    });
    expect(receipt?.["fingerprint"]).toMatch(/^[0-9a-f]{64}$/);
    database.close();

    await expect(sweeper.sweep()).resolves.toEqual({
      scanned: 0,
      expired: 0,
      skipped: 0,
      batches: 1,
      busy: false
    });
  });

  it("atomically CASes 0→0, creates one session, and recovers the hash after restart", async () => {
    const fixture = openFixture("success");
    const begun = await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "success");
    const credential = await fixture.store.findPasskeyCredentialByRecordId(CREDENTIAL_RECORD_ID);
    expect(credential).not.toBeNull();
    fixture.clock.value = NOW_MS + 10;
    const verified = verifiedInput(
      begun,
      credential!,
      INTENT_A,
      LOGIN_SESSION_A,
      REFRESH_ID_A,
      DELIVERY_NONCE_A,
      fixture.clock.value,
      "success:verify"
    );
    await fixture.store.commitVerifiedPasskeyLogin(verified.input);

    const consumed = await fixture.store.findPasskeyLoginIntent(INTENT_A);
    expect(consumed).toMatchObject({
      state: "consumed",
      revision: 2,
      attemptsUsed: 0,
      terminalReason: "verified",
      resolution: {
        accountId: ACCOUNT_ID,
        userHandleRef: USER_HANDLE_REF,
        credentialRecordId: CREDENTIAL_RECORD_ID,
        credentialRevisionBefore: 1,
        credentialRevisionAfter: 2,
        signCountBefore: 0,
        observedSignCount: 0,
        signCountAfter: 0,
        sessionId: LOGIN_SESSION_A,
        initialRefreshTokenId: REFRESH_ID_A,
        initialAccessTokenExpiresAtSec: Math.floor(fixture.clock.value / 1_000) + 900
      }
    });
    expect(await fixture.store.findPasskeyCredentialByRecordId(CREDENTIAL_RECORD_ID))
      .toMatchObject({ revision: 2, signCount: 0 });
    const durableRefresh = fixture.store.findRefreshToken(verified.input.refreshToken.tokenHash);
    expect(durableRefresh).toMatchObject({
      id: REFRESH_ID_A,
      sessionId: LOGIN_SESSION_A,
      tokenHash: verified.input.refreshToken.tokenHash,
      usedAt: null,
      session: { revokedAt: null }
    });
    const originInspection = new Database(fixture.path, { readonly: true });
    expect(originInspection.prepare(`
      SELECT session_id, account_id, credential_record_id, created_at_ms
      FROM passkey_session_credential_origins WHERE session_id = ?
    `).get(LOGIN_SESSION_A)).toEqual({
      session_id: LOGIN_SESSION_A,
      account_id: ACCOUNT_ID,
      credential_record_id: CREDENTIAL_RECORD_ID,
      created_at_ms: fixture.clock.value
    });
    originInspection.close();
    expect(await fixture.store.resolve(consumed!.challenge.reference)).toBeNull();

    closeFixtureStore(fixture);
    for (const file of [fixture.path, `${fixture.path}-wal`]) {
      if (!existsSync(file)) continue;
      const durableBytes = readFileSync(file).toString("latin1");
      expect(durableBytes).not.toContain(verified.refreshRaw);
      expect(durableBytes).not.toContain(DELIVERY_NONCE_A);
      expect(durableBytes).not.toContain(begun.challenge);
    }

    const restarted = new SqliteStore(fixture.path, fixture.cipher, () => fixture.clock.value);
    stores.push(restarted);
    const recovered = new PasskeyBootstrapRefreshTokenSecurity(
      { [REFRESH_KEY_ID]: REFRESH_ROOT_KEY },
      REFRESH_KEY_ID
    ).rederive({
      intentId: INTENT_A,
      accountId: ACCOUNT_ID,
      sessionId: LOGIN_SESSION_A,
      deliveryNonce: DELIVERY_NONCE_A
    }, REFRESH_KEY_ID);
    expect(recovered.raw).toBe(verified.refreshRaw);
    expect(recovered.hash).toBe(verified.input.refreshToken.tokenHash);
    expect(restarted.findRefreshToken(recovered.hash)).toMatchObject({
      id: REFRESH_ID_A,
      sessionId: LOGIN_SESSION_A,
      usedAt: null
    });
  });

  it("records a regressed observed counter as risk telemetry without lowering the durable counter", async () => {
    const fixture = openFixture("counter-regression");
    const database = new Database(fixture.path);
    database.prepare(`
      UPDATE passkey_credentials SET sign_count = 7 WHERE record_id = ?
    `).run(CREDENTIAL_RECORD_ID);
    database.close();

    const begun = await begin(
      fixture,
      INTENT_A,
      DELIVERY_NONCE_A,
      "counter-regression"
    );
    const credential = await fixture.store.findPasskeyCredentialByRecordId(
      CREDENTIAL_RECORD_ID
    );
    expect(credential).toMatchObject({ signCount: 7, revision: 1 });
    fixture.clock.value = NOW_MS + 10;
    const verified = verifiedInput(
      begun,
      credential!,
      INTENT_A,
      LOGIN_SESSION_A,
      REFRESH_ID_A,
      DELIVERY_NONCE_A,
      fixture.clock.value,
      "counter-regression:verify"
    );
    expect(verified.input.credential).toMatchObject({
      previousSignCount: 7,
      newSignCount: 0
    });

    await fixture.store.commitVerifiedPasskeyLogin(verified.input);

    expect(await fixture.store.findPasskeyCredentialByRecordId(CREDENTIAL_RECORD_ID))
      .toMatchObject({ revision: 2, signCount: 7 });
    expect(await fixture.store.findPasskeyLoginIntent(INTENT_A)).toMatchObject({
      state: "consumed",
      resolution: {
        signCountBefore: 7,
        observedSignCount: 0,
        signCountAfter: 7
      }
    });
  });

  it("rejects stale credential winners and rolls every session/token side effect back", async () => {
    const fixture = openFixture("race");
    const first = await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "race-a");
    const second = await begin(fixture, INTENT_B, DELIVERY_NONCE_B, "race-b");
    const staleCredential = await fixture.store.findPasskeyCredentialByRecordId(
      CREDENTIAL_RECORD_ID
    );
    expect(staleCredential).not.toBeNull();
    fixture.clock.value = NOW_MS + 10;
    const winner = verifiedInput(
      first,
      staleCredential!,
      INTENT_A,
      LOGIN_SESSION_A,
      REFRESH_ID_A,
      DELIVERY_NONCE_A,
      fixture.clock.value,
      "race-a:verify"
    );
    await fixture.store.commitVerifiedPasskeyLogin(winner.input);

    fixture.clock.value += 1;
    const loser = verifiedInput(
      second,
      staleCredential!,
      INTENT_B,
      LOGIN_SESSION_B,
      REFRESH_ID_B,
      DELIVERY_NONCE_B,
      fixture.clock.value,
      "race-b:verify"
    );
    await expect(fixture.store.commitVerifiedPasskeyLogin(loser.input))
      .rejects.toBeInstanceOf(StoreCredentialStateConflictError);
    expect(await fixture.store.findPasskeyLoginIntent(INTENT_B)).toMatchObject({
      state: "pending",
      revision: 1,
      resolution: null
    });
    expect(fixture.store.findRefreshToken(loser.input.refreshToken.tokenHash)).toBeNull();
    expect(await fixture.store.findPasskeyLoginCommandReceipt(
      loser.input.commandReceipt.scope
    )).toBeNull();
    expect(await fixture.store.resolve(second.input.intent.challenge.reference))
      .toBe(second.challenge);
  });

  it("rejects raw refresh material, key-binding drift, and a commit crossing expiry", async () => {
    const fixture = openFixture("hostile");
    const begun = await begin(fixture, INTENT_A, DELIVERY_NONCE_A, "hostile");
    const credential = await fixture.store.findPasskeyCredentialByRecordId(CREDENTIAL_RECORD_ID);
    expect(credential).not.toBeNull();
    fixture.clock.value = NOW_MS + 10;
    const verified = verifiedInput(
      begun,
      credential!,
      INTENT_A,
      LOGIN_SESSION_A,
      REFRESH_ID_A,
      DELIVERY_NONCE_A,
      fixture.clock.value,
      "hostile:verify"
    );
    const withRaw = {
      ...verified.input,
      refreshToken: {
        ...verified.input.refreshToken,
        raw: verified.refreshRaw
      }
    } as unknown as PersistVerifiedPasskeyLogin;
    await expect(fixture.store.commitVerifiedPasskeyLogin(withRaw))
      .rejects.toThrow("Passkey repository integrity check failed");
    const hiddenRawRefresh = Object.defineProperty({
      ...verified.input.refreshToken
    }, "raw", {
      value: verified.refreshRaw,
      enumerable: false
    });
    await expect(fixture.store.commitVerifiedPasskeyLogin({
      ...verified.input,
      refreshToken: hiddenRawRefresh
    }))
      .rejects.toThrow("Passkey repository integrity check failed");
    const getterCanary = "RAW_PASSKEY_LOGIN_GETTER_CANARY";
    const hostileInput = Object.defineProperty({
      ...verified.input
    }, "committedAtMs", {
      enumerable: true,
      get: () => {
        throw new Error(getterCanary);
      }
    }) as PersistVerifiedPasskeyLogin;
    try {
      await fixture.store.commitVerifiedPasskeyLogin(hostileInput);
      throw new Error("expected hostile input to fail");
    } catch (error) {
      expect(String(error)).toBe("PasskeyRepositoryIntegrityError: Passkey repository integrity check failed");
      expect(String(error)).not.toContain(getterCanary);
    }

    const wrongKey = {
      ...verified.input,
      refreshToken: {
        ...verified.input.refreshToken,
        derivationKeyId: "v2"
      }
    };
    await expect(fixture.store.commitVerifiedPasskeyLogin(wrongKey))
      .rejects.toBeInstanceOf(StoreRevisionConflictError);
    expect(fixture.store.findRefreshToken(verified.input.refreshToken.tokenHash)).toBeNull();

    const shortAccess = {
      ...verified.input,
      accessToken: {
        ...verified.input.accessToken,
        expiresAtSec: verified.input.accessToken.issuedAtSec + 60
      }
    };
    fixture.clock.value = shortAccess.accessToken.expiresAtSec * 1_000;
    await expect(fixture.store.commitVerifiedPasskeyLogin(shortAccess))
      .rejects.toBeInstanceOf(StoreRevisionConflictError);
    expect(fixture.store.findRefreshToken(verified.input.refreshToken.tokenHash)).toBeNull();

    fixture.clock.value = NOW_MS + TIMEOUT_MS;
    await expect(fixture.store.commitVerifiedPasskeyLogin(verified.input))
      .rejects.toBeInstanceOf(StoreRevisionConflictError);
    expect(await fixture.store.findPasskeyLoginIntent(INTENT_A)).toMatchObject({
      state: "pending",
      revision: 1,
      resolution: null
    });
    expect(fixture.store.findRefreshToken(verified.input.refreshToken.tokenHash)).toBeNull();
  });

  it("rejects non-boolean authenticator flags and non-canonical crypto identity inputs", async () => {
    const fixture = openFixture("verified-boundary");
    const begun = await begin(
      fixture,
      INTENT_A,
      DELIVERY_NONCE_A,
      "verified-boundary"
    );
    const credential = await fixture.store.findPasskeyCredentialByRecordId(
      CREDENTIAL_RECORD_ID
    );
    expect(credential).not.toBeNull();
    fixture.clock.value = NOW_MS + 10;
    const verified = verifiedInput(
      begun,
      credential!,
      INTENT_A,
      LOGIN_SESSION_A,
      REFRESH_ID_A,
      DELIVERY_NONCE_A,
      fixture.clock.value,
      "verified-boundary:verify"
    );

    for (const field of [
      "previousBackupEligible",
      "backupEligible",
      "previousBackupState",
      "backupState"
    ] as const) {
      const hostile = {
        ...verified.input,
        credential: {
          ...verified.input.credential,
          [field]: field.endsWith("State") ? 0 : 1
        }
      } as unknown as PersistVerifiedPasskeyLogin;
      await expect(fixture.store.commitVerifiedPasskeyLogin(hostile))
        .rejects.toThrow("Passkey repository integrity check failed");
    }

    const hostileAccount = {
      ...verified.input,
      credential: {
        ...verified.input.credential,
        accountId: NON_CANONICAL_ID
      },
      session: {
        ...verified.input.session,
        userId: NON_CANONICAL_ID
      }
    } as PersistVerifiedPasskeyLogin;
    const hostileSession = {
      ...verified.input,
      session: {
        ...verified.input.session,
        id: NON_CANONICAL_ID
      },
      refreshToken: {
        ...verified.input.refreshToken,
        sessionId: NON_CANONICAL_ID
      }
    } as PersistVerifiedPasskeyLogin;
    const hostileRefreshId = {
      ...verified.input,
      refreshToken: {
        ...verified.input.refreshToken,
        id: NON_CANONICAL_ID
      }
    } as PersistVerifiedPasskeyLogin;
    for (const hostile of [hostileAccount, hostileSession, hostileRefreshId]) {
      await expect(fixture.store.commitVerifiedPasskeyLogin(hostile))
        .rejects.toThrow("Passkey repository integrity check failed");
    }
    expect(fixture.store.findRefreshToken(verified.input.refreshToken.tokenHash)).toBeNull();
    expect(await fixture.store.findPasskeyLoginIntent(INTENT_A)).toMatchObject({
      state: "pending",
      revision: 1,
      resolution: null
    });
  });

  it("fails closed when a durable consumed crypto identity is no longer canonical", async () => {
    const fixture = openFixture("durable-id-boundary");
    const begun = await begin(
      fixture,
      INTENT_A,
      DELIVERY_NONCE_A,
      "durable-id-boundary"
    );
    const credential = await fixture.store.findPasskeyCredentialByRecordId(
      CREDENTIAL_RECORD_ID
    );
    expect(credential).not.toBeNull();
    fixture.clock.value = NOW_MS + 10;
    const verified = verifiedInput(
      begun,
      credential!,
      INTENT_A,
      LOGIN_SESSION_A,
      REFRESH_ID_A,
      DELIVERY_NONCE_A,
      fixture.clock.value,
      "durable-id-boundary:verify"
    );
    await fixture.store.commitVerifiedPasskeyLogin(verified.input);
    closeFixtureStore(fixture);

    const database = new Database(fixture.path);
    database.pragma("foreign_keys = OFF");
    database.pragma("ignore_check_constraints = ON");
    database.exec(`
      DROP TRIGGER trg_passkey_login_intents_state_transition;
      DROP TRIGGER trg_passkey_login_intents_consumed_proof;
    `);
    database.prepare(`
      UPDATE passkey_login_intents
      SET resolved_account_id = ?
      WHERE intent_id = ?
    `).run(NON_CANONICAL_ID, INTENT_A);
    database.close();

    const restarted = new SqliteStore(fixture.path, fixture.cipher, () => fixture.clock.value);
    stores.push(restarted);
    await expect(restarted.findPasskeyLoginIntent(INTENT_A))
      .rejects.toThrow("Passkey repository integrity check failed");
  });
});
