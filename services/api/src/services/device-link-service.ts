import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import type {
  DeviceLinkChallengeResponse,
  CreateDeviceLinkChallengeRequest,
  DeviceLinkRedeemResponse
} from "@luxora/protocol";
import { AuthTokensSchema, DeviceLinkChallengeResponseSchema } from "@luxora/protocol";
import type { DeviceLinkChallengeRecord } from "../domain/types.js";
import type { Store } from "../domain/store.js";
import { conflict, forbidden, rateLimited, unauthenticated, badRequest, serviceUnavailable } from "../errors.js";
import type { TokenSecurity } from "../security.js";
import type { EventPublisher } from "./event-publisher.js";
import { appendSyncInvalidations } from "./sync-invalidation.js";
import { hashPassword, verifyPassword } from "./password-auth.js";
import { DEVICE_LINK_SAS_WORDS } from "./device-link-wordlist.js";

// Argon2id is intentionally expensive: one salted timing hash per process so
// passwordless or unknown approvers take the same verification path.
const TIMING_DUMMY_PASSWORD_HASH = hashPassword(
  "not-a-real-password-used-for-timing-only"
);

/** Spec §10.2: challenge lifetime is 120 seconds, single-use. */
export const DEVICE_LINK_TTL_MS = 120_000;
/** Spec §10.2: polling starts at a two-second interval. */
export const DEVICE_LINK_POLL_INTERVAL_MS = 2_000;
/** Terminal rows are removed within 24 hours (spec §14.3 QR row). */
export const DEVICE_LINK_PURGE_AFTER_MS = 24 * 60 * 60 * 1_000;
const SWEEP_BATCH_SIZE = 100;

function hashSecret(linkSecret: string): string {
  return createHash("sha256").update(`luxora-device-link-v1:${linkSecret}`, "utf8").digest("hex");
}

function validSecretFormat(linkSecret: unknown): linkSecret is string {
  return typeof linkSecret === "string" && /^[a-f0-9]{64}$/u.test(linkSecret);
}

function checkSecret(linkSecret: string | undefined, record: DeviceLinkChallengeRecord): void {
  if (!validSecretFormat(linkSecret)) throw unauthenticated("Device link challenge was not found");
  const presented = Buffer.from(hashSecret(linkSecret), "hex");
  const stored = Buffer.from(record.linkSecretHash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw unauthenticated("Device link challenge was not found");
  }
}

function project(record: DeviceLinkChallengeRecord, retryAfterMs: number): DeviceLinkChallengeResponse {
  return DeviceLinkChallengeResponseSchema.parse({
    challenge: {
      linkId: record.linkId,
      state: record.status,
      expiresAt: record.expiresAt,
      retryAfterMs
    }
  });
}

/**
 * Four-word short authentication string (spec §10.1.5): 32 bits derived
 * from the approved transcript, shown on both endpoints as a relay warning.
 * Deterministic so the target poll and the approve response always agree.
 */
export function deriveSasWords(linkSecretHash: string, approverAccountId: string): [string, string, string, string] {
  const digest = createHash("sha256")
    .update(`luxora-device-link-sas-v1:${linkSecretHash}:${approverAccountId}`, "utf8")
    .digest();
  const words = [0, 1, 2, 3].map((index) => DEVICE_LINK_SAS_WORDS[digest[index] as number] as string);
  return [words[0] as string, words[1] as string, words[2] as string, words[3] as string];
}

function projectDecision(
  record: DeviceLinkChallengeRecord,
  approverAccountId: string | null
): DeviceLinkChallengeResponse {
  return DeviceLinkChallengeResponseSchema.parse({
    challenge: {
      linkId: record.linkId,
      state: record.status,
      expiresAt: record.expiresAt,
      retryAfterMs: 0,
      sasWords: approverAccountId === null ? null : deriveSasWords(record.linkSecretHash, approverAccountId)
    }
  });
}

/**
 * Device-link challenge lifecycle, first slice (IDENTITY_ACCESS §10.1-10.2,
 * §14.3 QR row): create/poll/close/expire/purge. Approval, grant redemption
 * and session issuance arrive in later slices.
 *
 * The link secret is returned once at creation; the server stores only its
 * digest. Unknown ids and wrong secrets are indistinguishable (401, no
 * oracle). Polling never reveals account data. A poll inside the minimum
 * interval is rejected with 429 so clients must honor `retryAfterMs`.
 */
export class DeviceLinkService {
  readonly #store: Store;
  readonly #tokens: TokenSecurity | undefined;
  readonly #publisher: Pick<EventPublisher, "publish"> | undefined;
  readonly #options: {
    refreshTokenTtlDays?: number;
    accessTokenTtlSeconds?: number;
    syncInvalidationEnabled?: boolean;
  };

  constructor(
    store: Store,
    tokens?: TokenSecurity,
    publisher?: Pick<EventPublisher, "publish">,
    options: {
      refreshTokenTtlDays?: number;
      accessTokenTtlSeconds?: number;
      syncInvalidationEnabled?: boolean;
    } = {}
  ) {
    this.#store = store;
    this.#tokens = tokens;
    this.#publisher = publisher;
    this.#options = options;
  }

  createChallenge(input: CreateDeviceLinkChallengeRequest, now: Date): {
    linkId: string;
    linkSecret: string;
    expiresAt: string;
    pollIntervalMs: number;
  } {
    const createdAt = now.toISOString();
    const linkId = randomUUID();
    const linkSecret = randomBytes(32).toString("hex");
    const expiresAt = new Date(now.getTime() + DEVICE_LINK_TTL_MS).toISOString();
    this.#store.createDeviceLinkChallenge({
      linkId,
      linkSecretHash: hashSecret(linkSecret),
      targetLabel: input.targetLabel ?? null,
      proofPublicKeyJwk: input.proofPublicKey === undefined ? null : JSON.stringify(input.proofPublicKey),
      createdAt,
      expiresAt
    });
    return { linkId, linkSecret, expiresAt, pollIntervalMs: DEVICE_LINK_POLL_INTERVAL_MS };
  }

  pollChallenge(
    linkId: string,
    linkSecret: string | undefined,
    now: Date
  ): DeviceLinkChallengeResponse {
    const observed = now.toISOString();
    const record = this.#store.findDeviceLinkChallenge(linkId);
    if (record === null) throw unauthenticated("Device link challenge was not found");
    checkSecret(linkSecret, record);
    if (record.status === "pending" && record.expiresAt <= observed) {
      this.#store.transitionDeviceLinkChallenge(linkId, "pending", "expired", observed);
      return project({ ...record, status: "expired", decidedAt: observed }, 0);
    }
    if (record.status === "approved" && record.approvedByAccountId !== null) {
      return projectDecision(record, record.approvedByAccountId);
    }
    // Backoff applies only to the pending wait loop. Terminal answers are
    // final and cheap, so they skip the throttle (the caller already proved
    // secret possession).
    if (record.status === "pending" && record.lastPolledAt !== null) {
      const elapsed = Date.parse(observed) - Date.parse(record.lastPolledAt);
      if (elapsed < DEVICE_LINK_POLL_INTERVAL_MS) {
        const retryAfterMs = DEVICE_LINK_POLL_INTERVAL_MS - elapsed;
        throw rateLimited("Device link poll is too frequent", {
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
          retryAfterMs
        });
      }
    }
    this.#store.touchDeviceLinkChallenge(linkId, observed);
    return project(record, 0);
  }

  closeChallenge(
    linkId: string,
    linkSecret: string | undefined,
    now: Date
  ): DeviceLinkChallengeResponse {
    const observed = now.toISOString();
    const record = this.#store.findDeviceLinkChallenge(linkId);
    if (record === null) throw unauthenticated("Device link challenge was not found");
    checkSecret(linkSecret, record);
    if (record.status === "pending" && record.expiresAt <= observed) {
      this.#store.transitionDeviceLinkChallenge(linkId, "pending", "expired", observed);
      return project({ ...record, status: "expired", decidedAt: observed }, 0);
    }
    if (record.status === "pending") {
      this.#store.transitionDeviceLinkChallenge(linkId, "pending", "closed", observed);
      return project({ ...record, status: "closed", decidedAt: observed }, 0);
    }
    return project(record, 0);
  }

  /**
   * Trusted-device decision (IDENTITY_ACCESS §10.1.4-10.1.5, partial).
   * Requires the approver's live bearer session, link-secret possession (QR
   * scan) AND a fresh password step-up bound to this exact approval
   * (linkId + approver + session verified below before the state CAS).
   * HONESTY LIMITATION: password is a knowledge factor, not
   * phishing-resistant; passkey-ceremony step-up arrives in the next slice
   * before any client ships.
   */
  approveChallenge(
    approverUserId: string,
    approverSessionId: string,
    linkId: string,
    input: { linkSecret: string | undefined; password: string },
    now: Date
  ): Promise<DeviceLinkChallengeResponse> {
    return this.#decideChallenge(
      approverUserId,
      approverSessionId,
      linkId,
      { linkSecret: input.linkSecret, password: input.password },
      "approved",
      now
    );
  }

  denyChallenge(
    approverUserId: string,
    linkId: string,
    linkSecret: string | undefined,
    now: Date
  ): Promise<DeviceLinkChallengeResponse> {
    return this.#decideChallenge(approverUserId, null, linkId, { linkSecret, password: undefined }, "denied", now);
  }

  async #decideChallenge(
    approverUserId: string,
    approverSessionId: string | null,
    linkId: string,
    input: { linkSecret: string | undefined; password: string | undefined },
    toStatus: "approved" | "denied",
    now: Date
  ): Promise<DeviceLinkChallengeResponse> {
    const observed = now.toISOString();
    const record = this.#store.findDeviceLinkChallenge(linkId);
    if (record === null) throw unauthenticated("Device link challenge was not found");
    checkSecret(input.linkSecret, record);
    if (record.status === "pending" && record.expiresAt <= observed) {
      this.#store.transitionDeviceLinkChallenge(linkId, "pending", "expired", observed);
      throw conflict("Device link challenge has expired", {
        challenge: project({ ...record, status: "expired", decidedAt: observed }, 0).challenge
      });
    }
    if (record.status !== "pending") {
      const decided = this.#store.findDeviceLinkChallenge(linkId) ?? record;
      const approver = decided.approvedByAccountId;
      const current = decided.status === "approved" && approver !== null
        ? projectDecision(decided, approver)
        : project(decided, 0);
      throw conflict("Device link challenge is already decided", { challenge: current.challenge });
    }
    if (toStatus === "approved") {
      if (input.password === undefined) throw badRequest("Device link approval requires a password");
      return this.#approvePending(approverUserId, approverSessionId as string, linkId, input.password, observed);
    }
    const decided = this.#store.decideDeviceLinkChallenge(linkId, "denied", null, observed);
    if (!decided) {
      throw conflict("Device link challenge is already decided", {
        challenge: project({ ...record, status: record.status, decidedAt: observed }, 0).challenge
      });
    }
    return project({ ...record, status: "denied", decidedAt: observed }, 0);
  }

  async #approvePending(
    approverUserId: string,
    approverSessionId: string,
    linkId: string,
    password: string,
    observed: string
  ): Promise<DeviceLinkChallengeResponse> {
    const user = this.#store.findUserById(approverUserId);
    const candidateHash = user?.passwordHash ?? await TIMING_DUMMY_PASSWORD_HASH;
    let valid = false;
    try {
      valid = await verifyPassword(candidateHash, password);
    } catch {
      await verifyPassword(await TIMING_DUMMY_PASSWORD_HASH, password).catch(() => false);
    }
    if (!valid || user === null || !user.passwordAuthEnabled) {
      throw forbidden("Device link approval authentication failed");
    }
    if (!this.#store.isSessionActive(approverSessionId, approverUserId, observed)) {
      throw forbidden("Device link approval authentication failed");
    }
    const decided = this.#store.decideDeviceLinkChallenge(linkId, "approved", approverUserId, observed);
    if (!decided) {
      const current = this.#store.findDeviceLinkChallenge(linkId);
      if (current === null) throw conflict("Device link challenge is already decided");
      const approver = current.approvedByAccountId;
      const projection = current.status === "approved" && approver !== null
        ? projectDecision(current, approver)
        : project(current, 0);
      throw conflict("Device link challenge is already decided", { challenge: projection.challenge });
    }
    const committed = this.#store.findDeviceLinkChallenge(linkId);
    if (committed === null) throw conflict("Device link challenge is already decided");
    return projectDecision(committed, approverUserId);
  }

  sweep(now: Date): { expired: number; purged: number } {
    const observed = now.toISOString();
    const expired = this.#store.expireDeviceLinkChallenges(observed, SWEEP_BATCH_SIZE);
    const purgeBefore = new Date(now.getTime() - DEVICE_LINK_PURGE_AFTER_MS).toISOString();
    const purged = this.#store.purgeDeviceLinkChallenges(purgeBefore, SWEEP_BATCH_SIZE);
    return { expired, purged };
  }

  /**
   * Grant redemption (IDENTITY_ACCESS §10.1.6-10.1.7): the target proves
   * possession of the proof private key whose public half was bound at
   * challenge creation. Possession — not the link secret — authorizes the
   * redemption, so a relayed/screenshot QR alone cannot complete linking.
   * On success the server atomically consumes the challenge (single-use CAS)
   * and issues a fresh session/token family for the approver's account; all
   * existing sessions receive a `session_list_changed` invalidation.
   */
  async redeemChallenge(
    linkId: string,
    input: { linkSecret: string | undefined; proofSignature: string | undefined },
    now: Date
  ): Promise<DeviceLinkRedeemResponse> {
    const tokens = this.#tokens;
    if (tokens === undefined) throw serviceUnavailable("Device link redemption is not configured");
    const observed = now.toISOString();
    const record = this.#store.findDeviceLinkChallenge(linkId);
    if (record === null) throw unauthenticated("Device link challenge was not found");
    checkSecret(input.linkSecret, record);
    if (record.status === "pending" && record.expiresAt <= observed) {
      this.#store.transitionDeviceLinkChallenge(linkId, "pending", "expired", observed);
      throw conflict("Device link challenge has expired");
    }
    if (record.status !== "approved" || record.approvedByAccountId === null) {
      throw conflict("Device link challenge is not redeemable");
    }
    if (record.proofPublicKeyJwk === null) {
      throw conflict("Device link challenge predates proof keys and cannot be redeemed");
    }
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey({
        key: JSON.parse(record.proofPublicKeyJwk) as Record<string, unknown>,
        format: "jwk"
      });
    } catch {
      throw conflict("Device link challenge predates proof keys and cannot be redeemed");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw conflict("Device link challenge predates proof keys and cannot be redeemed");
    }
    let signature: Buffer;
    try {
      if (input.proofSignature === undefined) throw new Error("missing");
      signature = Buffer.from(input.proofSignature, "base64url");
      if (signature.length !== 64) throw new Error("length");
    } catch {
      throw forbidden("Device link proof verification failed");
    }
    const message = Buffer.from(`luxora-device-link-redeem-v1:${linkId}`, "utf8");
    let proven = false;
    try {
      proven = verify(null, message, publicKey, signature);
    } catch {
      proven = false;
    }
    if (!proven) throw forbidden("Device link proof verification failed");

    const sessionId = randomUUID();
    const refresh = tokens.newRefreshToken();
    const refreshTokenTtlDays = this.#options.refreshTokenTtlDays ?? 30;
    const accessTokenTtlSeconds = this.#options.accessTokenTtlSeconds ?? 900;
    const expiresAt = new Date(now.getTime() + refreshTokenTtlDays * 24 * 60 * 60_000).toISOString();
    const access = await tokens.signAccessToken(record.approvedByAccountId, sessionId);
    const consumed = this.#store.transaction(() => {
      this.#store.createSession({
        id: sessionId,
        userId: record.approvedByAccountId as string,
        deviceName: record.targetLabel ?? "Linked device",
        createdAt: observed,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt: observed,
        expiresAt
      });
      return this.#store.consumeDeviceLinkChallenge(linkId, sessionId, observed);
    });
    if (!consumed) throw conflict("Device link challenge is already decided");
    const events = appendSyncInvalidations(
      this.#store,
      [record.approvedByAccountId as string],
      "session_list_changed",
      observed,
      this.#options.syncInvalidationEnabled ?? true
    );
    this.#publisher?.publish(events);
    return {
      tokens: AuthTokensSchema.parse({
        accessToken: access.token,
        refreshToken: refresh.raw,
        tokenType: "Bearer",
        expiresIn: accessTokenTtlSeconds,
        sessionId
      })
    };
  }
}
