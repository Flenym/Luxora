import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  DeviceLinkChallengeResponse,
  CreateDeviceLinkChallengeRequest
} from "@luxora/protocol";
import { DeviceLinkChallengeResponseSchema } from "@luxora/protocol";
import type { DeviceLinkChallengeRecord } from "../domain/types.js";
import type { Store } from "../domain/store.js";
import { conflict, rateLimited, unauthenticated } from "../errors.js";
import { DEVICE_LINK_SAS_WORDS } from "./device-link-wordlist.js";

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
  constructor(private readonly store: Store) {}

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
    this.store.createDeviceLinkChallenge({
      linkId,
      linkSecretHash: hashSecret(linkSecret),
      targetLabel: input.targetLabel ?? null,
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
    const record = this.store.findDeviceLinkChallenge(linkId);
    if (record === null) throw unauthenticated("Device link challenge was not found");
    checkSecret(linkSecret, record);
    if (record.status === "pending" && record.expiresAt <= observed) {
      this.store.transitionDeviceLinkChallenge(linkId, "pending", "expired", observed);
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
    this.store.touchDeviceLinkChallenge(linkId, observed);
    return project(record, 0);
  }

  closeChallenge(
    linkId: string,
    linkSecret: string | undefined,
    now: Date
  ): DeviceLinkChallengeResponse {
    const observed = now.toISOString();
    const record = this.store.findDeviceLinkChallenge(linkId);
    if (record === null) throw unauthenticated("Device link challenge was not found");
    checkSecret(linkSecret, record);
    if (record.status === "pending" && record.expiresAt <= observed) {
      this.store.transitionDeviceLinkChallenge(linkId, "pending", "expired", observed);
      return project({ ...record, status: "expired", decidedAt: observed }, 0);
    }
    if (record.status === "pending") {
      this.store.transitionDeviceLinkChallenge(linkId, "pending", "closed", observed);
      return project({ ...record, status: "closed", decidedAt: observed }, 0);
    }
    return project(record, 0);
  }

  /**
   * Trusted-device decision (IDENTITY_ACCESS §10.1.4-10.1.5, partial).
   * Requires the approver's live bearer session plus link-secret possession
   * (QR scan). HONESTY LIMITATION: transaction-bound step-up is NOT yet
   * enforced — it arrives in the next slice before any client ships, and
   * until then approval binds bearer session + secret + explicit action
   * inside the 120-second single-use window.
   */
  approveChallenge(
    approverUserId: string,
    linkId: string,
    linkSecret: string | undefined,
    now: Date
  ): DeviceLinkChallengeResponse {
    return this.#decideChallenge(approverUserId, linkId, linkSecret, "approved", now);
  }

  denyChallenge(
    approverUserId: string,
    linkId: string,
    linkSecret: string | undefined,
    now: Date
  ): DeviceLinkChallengeResponse {
    return this.#decideChallenge(approverUserId, linkId, linkSecret, "denied", now);
  }

  #decideChallenge(
    approverUserId: string,
    linkId: string,
    linkSecret: string | undefined,
    toStatus: "approved" | "denied",
    now: Date
  ): DeviceLinkChallengeResponse {
    const observed = now.toISOString();
    const record = this.store.findDeviceLinkChallenge(linkId);
    if (record === null) throw unauthenticated("Device link challenge was not found");
    checkSecret(linkSecret, record);
    if (record.status === "pending" && record.expiresAt <= observed) {
      this.store.transitionDeviceLinkChallenge(linkId, "pending", "expired", observed);
      throw conflict("Device link challenge has expired", {
        challenge: project({ ...record, status: "expired", decidedAt: observed }, 0).challenge
      });
    }
    if (record.status !== "pending") {
      const decided = this.store.findDeviceLinkChallenge(linkId) ?? record;
      const approver = decided.approvedByAccountId;
      const current = decided.status === "approved" && approver !== null
        ? projectDecision(decided, approver)
        : project(decided, 0);
      throw conflict("Device link challenge is already decided", { challenge: current.challenge });
    }
    const decided = this.store.decideDeviceLinkChallenge(
      linkId,
      toStatus,
      toStatus === "approved" ? approverUserId : null,
      observed
    );
    if (!decided) {
      throw conflict("Device link challenge is already decided", {
        challenge: project({ ...record, status: record.status, decidedAt: observed }, 0).challenge
      });
    }
    if (toStatus === "denied") {
      return project({ ...record, status: "denied", decidedAt: observed }, 0);
    }
    return projectDecision({ ...record, status: "approved", decidedAt: observed }, approverUserId);
  }

  sweep(now: Date): { expired: number; purged: number } {
    const observed = now.toISOString();
    const expired = this.store.expireDeviceLinkChallenges(observed, SWEEP_BATCH_SIZE);
    const purgeBefore = new Date(now.getTime() - DEVICE_LINK_PURGE_AFTER_MS).toISOString();
    const purged = this.store.purgeDeviceLinkChallenges(purgeBefore, SWEEP_BATCH_SIZE);
    return { expired, purged };
  }
}
