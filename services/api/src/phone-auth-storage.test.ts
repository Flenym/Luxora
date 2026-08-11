import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";

const RAW_PHONE = "+79991234567";
const RAW_CODE = "482913";
const RAW_DEVICE = "SECRET-PHONE-DEVICE";
const RAW_RESPONSE = JSON.stringify({
  user: { id: "response-user" },
  tokens: { accessToken: "SECRET-ACCESS", refreshToken: "SECRET-REFRESH" }
});
const RAW_PASSWORD_RESPONSE = JSON.stringify({
  status: "password_required",
  passwordToken: "luxpw_SECRET-PASSWORD-CONTINUATION"
});

describe("phone authentication durable storage", () => {
  const directories: string[] = [];
  let store: SqliteStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function openStore(): { path: string; store: SqliteStore; cipher: AesGcmContentCipher } {
    const directory = mkdtempSync(join(tmpdir(), "luxora-phone-storage-"));
    directories.push(directory);
    const path = join(directory, "luxora.sqlite");
    const cipher = new AesGcmContentCipher(
      { active: Buffer.alloc(32, 73).toString("base64url") },
      "active"
    );
    store = new SqliteStore(path, cipher);
    return { path, store, cipher };
  }

  it("encrypts phone, delivery code, device and bearer response while retaining keyed indexes", () => {
    const opened = openStore();
    const challengeId = randomUUID();
    const beginNonce = randomUUID();
    const createdAt = "2026-08-04T12:00:00.000Z";
    const challenge = opened.store.createPhoneAuthChallenge({
      id: challengeId,
      phoneDigest: "a".repeat(64),
      e164: RAW_PHONE,
      codeDigest: "b".repeat(64),
      deliveryCode: RAW_CODE,
      deviceName: RAW_DEVICE,
      maxAttempts: 5,
      beginClientNonce: beginNonce,
      beginFingerprint: "c".repeat(64),
      maskedPhone: "+7 ••• ••• 45 67",
      createdAt,
      expiresAt: "2026-08-04T12:05:00.000Z",
      retryAfterSeconds: 60
    });
    expect(challenge).toMatchObject({
      e164: RAW_PHONE,
      deliveryCode: RAW_CODE,
      deviceName: RAW_DEVICE,
      state: "pending_delivery",
      revision: 1
    });
    expect(opened.store.activatePhoneAuthChallenge(
      challengeId,
      1,
      "2026-08-04T12:00:01.000Z"
    )).toBe(true);
    expect(opened.store.findPhoneAuthChallengeById(challengeId)).toMatchObject({
      state: "pending",
      revision: 2,
      deliveryCode: null,
      e164: RAW_PHONE,
      deviceName: RAW_DEVICE
    });

    const registrationTokenHash = "d".repeat(64);
    const profileResponse = JSON.stringify({
      status: "profile_required",
      registrationToken: "luxpr_SECRET-REGISTRATION-TOKEN"
    });
    expect(opened.store.commitPhoneAuthProfileRequired({
      challengeId,
      expectedRevision: 2,
      registrationTokenHash,
      registrationExpiresAt: "2026-08-04T12:10:02.000Z",
      receipt: {
        scope: `verify:${challengeId}:${randomUUID()}`,
        operation: "verify",
        fingerprint: "e".repeat(64),
        challengeId,
        resultKind: "profile_required",
        responseJson: profileResponse,
        createdAt: "2026-08-04T12:00:02.000Z",
        expiresAt: "2026-08-04T12:10:02.000Z"
      }
    })).toBe(true);

    const userId = randomUUID();
    const sessionId = randomUUID();
    const registrationScope = `register:${registrationTokenHash}:${randomUUID()}`;
    expect(opened.store.commitPhoneAuthRegistration({
      challengeId,
      expectedRevision: 3,
      registrationTokenHash,
      user: {
        id: userId,
        username: "storage_user",
        usernameNormalized: "storage_user",
        displayName: "Storage User",
        bio: "Encrypted phone registration",
        passwordHash: "discarded-password-hash",
        createdAt: "2026-08-04T12:00:03.000Z"
      },
      session: {
        id: sessionId,
        userId,
        deviceName: "Registered session",
        createdAt: "2026-08-04T12:00:03.000Z",
        expiresAt: "2026-09-03T12:00:03.000Z"
      },
      refreshToken: {
        id: randomUUID(),
        sessionId,
        tokenHash: "f".repeat(64),
        createdAt: "2026-08-04T12:00:03.000Z",
        expiresAt: "2026-09-03T12:00:03.000Z"
      },
      receipt: {
        scope: registrationScope,
        operation: "register",
        fingerprint: "1".repeat(64),
        challengeId,
        resultKind: "registered",
        responseJson: RAW_RESPONSE,
        createdAt: "2026-08-04T12:00:03.000Z",
        expiresAt: "2026-09-03T12:00:03.000Z"
      }
    })).toBe(true);
    expect(opened.store.findPhoneIdentityByDigest("a".repeat(64))).toMatchObject({
      userId,
      phoneDigest: "a".repeat(64)
    });
    expect(opened.store.findPhoneAuthCommandReceipt(registrationScope)?.responseJson)
      .toBe(RAW_RESPONSE);
    expect(opened.store.findUserById(userId)).toMatchObject({
      username: "storage_user",
      bio: "Encrypted phone registration",
      passwordAuthEnabled: false,
      phonePasswordHash: null,
      phonePasswordEnabled: false
    });

    expect(opened.store.compareAndSetPhonePassword({
      userId,
      expectedPhonePasswordHash: null,
      expectedEnabled: false,
      nextPhonePasswordHash: "argon-password-hash-canary",
      nextEnabled: true,
      at: "2026-08-04T12:00:04.000Z"
    })).toBe(true);
    expect(opened.store.findUserById(userId)).toMatchObject({
      passwordHash: "discarded-password-hash",
      passwordAuthEnabled: false,
      phonePasswordHash: "argon-password-hash-canary",
      phonePasswordEnabled: true
    });
    const passwordChallengeId = randomUUID();
    const passwordChallenge = opened.store.createPhoneAuthChallenge({
      id: passwordChallengeId,
      phoneDigest: "a".repeat(64),
      e164: RAW_PHONE,
      codeDigest: "3".repeat(64),
      deliveryCode: RAW_CODE,
      deviceName: RAW_DEVICE,
      maxAttempts: 5,
      beginClientNonce: randomUUID(),
      beginFingerprint: "4".repeat(64),
      maskedPhone: "+7 ••• ••• 45 67",
      createdAt: "2026-08-04T12:01:00.000Z",
      expiresAt: "2026-08-04T12:06:00.000Z",
      retryAfterSeconds: 60
    });
    expect(passwordChallenge).not.toBeNull();
    expect(opened.store.activatePhoneAuthChallenge(
      passwordChallengeId,
      1,
      "2026-08-04T12:01:01.000Z"
    )).toBe(true);
    const passwordScope = `verify:${passwordChallengeId}:${randomUUID()}`;
    expect(opened.store.commitPhoneAuthPasswordRequired({
      challengeId: passwordChallengeId,
      expectedRevision: 2,
      userId,
      passwordTokenHash: "2".repeat(64),
      passwordExpiresAt: "2026-08-04T12:11:02.000Z",
      receipt: {
        scope: passwordScope,
        fingerprint: "5".repeat(64),
        challengeId: passwordChallengeId,
        resultKind: "password_required",
        responseJson: RAW_PASSWORD_RESPONSE,
        createdAt: "2026-08-04T12:01:02.000Z",
        expiresAt: "2026-08-04T12:11:02.000Z"
      }
    })).toBe(true);
    expect(opened.store.findPhoneAuthPasswordReceipt(passwordScope)?.responseJson)
      .toBe(RAW_PASSWORD_RESPONSE);

    opened.store.close();
    store = undefined;
    const database = new Database(opened.path);
    const identityEnvelope = database.prepare(`
      SELECT phone_ciphertext FROM phone_identities WHERE user_id = ?
    `).get(userId) as { phone_ciphertext: string };
    expect(() => database.prepare(`
      UPDATE phone_auth_password_receipts SET fingerprint = ? WHERE scope = ?
    `).run("6".repeat(64), passwordScope)).toThrow(/phone password receipt is immutable/u);
    expect(() => database.prepare(`
      DELETE FROM phone_auth_password_events WHERE command_scope = ?
    `).run(passwordScope)).toThrow(/phone password audit cannot be deleted/u);
    expect(() => database.prepare(`
      UPDATE users SET phone_password_hash = NULL WHERE id = ?
    `).run(userId)).toThrow(/enabled phone password requires a hash/u);
    database.close();
    expect(opened.cipher.decrypt(
      identityEnvelope.phone_ciphertext,
      `phone-identity:${userId}:number`
    )).toBe(RAW_PHONE);
    expect(() => opened.cipher.decrypt(
      identityEnvelope.phone_ciphertext,
      `phone-auth:${challengeId}:number`
    )).toThrow();
    const bytes = readFileSync(opened.path);
    for (const secret of [
      RAW_PHONE,
      RAW_CODE,
      RAW_DEVICE,
      "+7 ••• ••• 45 67",
      profileResponse,
      RAW_RESPONSE,
      "SECRET-ACCESS",
      "SECRET-REFRESH",
      "SECRET-REGISTRATION-TOKEN",
      RAW_PASSWORD_RESPONSE,
      "SECRET-PASSWORD-CONTINUATION"
    ]) expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
  });

  it("enforces the per-phone resend window inside the writer transaction", () => {
    const opened = openStore();
    const base = {
      phoneDigest: "8".repeat(64),
      e164: RAW_PHONE,
      codeDigest: "9".repeat(64),
      deliveryCode: RAW_CODE,
      deviceName: RAW_DEVICE,
      maxAttempts: 5,
      beginFingerprint: "a".repeat(64),
      maskedPhone: "+7 ••• ••• 45 67",
      expiresAt: "2026-08-04T12:05:00.000Z",
      retryAfterSeconds: 60
    };
    expect(opened.store.createPhoneAuthChallenge({
      ...base,
      id: randomUUID(),
      beginClientNonce: randomUUID(),
      createdAt: "2026-08-04T12:00:00.000Z"
    })).not.toBeNull();
    expect(opened.store.createPhoneAuthChallenge({
      ...base,
      id: randomUUID(),
      beginClientNonce: randomUUID(),
      createdAt: "2026-08-04T12:00:59.999Z"
    })).toBeNull();
    expect(opened.store.createPhoneAuthChallenge({
      ...base,
      id: randomUUID(),
      beginClientNonce: randomUUID(),
      createdAt: "2026-08-04T12:01:00.000Z",
      expiresAt: "2026-08-04T12:06:00.000Z"
    })).not.toBeNull();
  });

  it("keeps identities, receipts, events and terminal challenges immutable", () => {
    const opened = openStore();
    const challengeId = randomUUID();
    opened.store.createPhoneAuthChallenge({
      id: challengeId,
      phoneDigest: "2".repeat(64),
      e164: RAW_PHONE,
      codeDigest: "3".repeat(64),
      deliveryCode: RAW_CODE,
      deviceName: RAW_DEVICE,
      maxAttempts: 3,
      beginClientNonce: randomUUID(),
      beginFingerprint: "4".repeat(64),
      maskedPhone: "+7 ••• ••• 45 67",
      createdAt: "2026-08-04T12:00:00.000Z",
      expiresAt: "2026-08-04T12:05:00.000Z",
      retryAfterSeconds: 60
    });
    expect(opened.store.failPhoneAuthChallengeDelivery(
      challengeId,
      1,
      "2026-08-04T12:00:01.000Z"
    )).toBe(true);

    opened.store.close();
    store = undefined;
    const database = new Database(opened.path);
    expect(() => database.prepare(
      "UPDATE phone_auth_challenges SET updated_at = ? WHERE id = ?"
    ).run("2026-08-04T12:00:02.000Z", challengeId)).toThrow("transition is invalid");
    expect(() => database.prepare(
      "DELETE FROM phone_auth_events WHERE challenge_id = ?"
    ).run(challengeId)).toThrow("cannot be deleted");
    expect(() => database.prepare(
      "DELETE FROM phone_auth_challenges WHERE id = ?"
    ).run(challengeId)).toThrow("cannot be deleted");
    database.close();
  });
});
