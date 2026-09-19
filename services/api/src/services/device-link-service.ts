import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  DeviceLinkChallengeResponse,
  CreateDeviceLinkChallengeRequest
} from "@luxora/protocol";
import { DeviceLinkChallengeResponseSchema } from "@luxora/protocol";
import type { DeviceLinkChallengeRecord } from "../domain/types.js";
import type { Store } from "../domain/store.js";
import { rateLimited, unauthenticated } from "../errors.js";

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

  sweep(now: Date): { expired: number; purged: number } {
    const observed = now.toISOString();
    const expired = this.store.expireDeviceLinkChallenges(observed, SWEEP_BATCH_SIZE);
    const purgeBefore = new Date(now.getTime() - DEVICE_LINK_PURGE_AFTER_MS).toISOString();
    const purged = this.store.purgeDeviceLinkChallenges(purgeBefore, SWEEP_BATCH_SIZE);
    return { expired, purged };
  }
}
