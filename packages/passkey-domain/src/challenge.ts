import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { reject } from "./errors.js";
import {
  PASSKEY_CHALLENGE_BYTES,
  type ChallengeDescriptor,
  type IssuedChallenge
} from "./types.js";
import { assertOpaqueId } from "./validation.js";

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function decodeChallenge(challenge: string): Buffer {
  if (!CHALLENGE_PATTERN.test(challenge)) {
    reject("VALIDATION_FAILED", "challenge must be unpadded base64url of exactly 32 bytes");
  }
  const decoded = Buffer.from(challenge, "base64url");
  if (decoded.length !== PASSKEY_CHALLENGE_BYTES || decoded.toString("base64url") !== challenge) {
    reject("VALIDATION_FAILED", "challenge must canonically encode exactly 32 bytes");
  }
  return decoded;
}

export function describeIssuedChallenge(issued: IssuedChallenge): ChallengeDescriptor {
  assertOpaqueId("challenge reference", issued.reference, 192);
  const decoded = decodeChallenge(issued.challenge);
  if (issued.reference.includes(issued.challenge)) {
    reject("VALIDATION_FAILED", "challenge reference must not contain the raw challenge");
  }
  return {
    reference: issued.reference,
    digest: createHash("sha256").update(decoded).digest("hex"),
    byteLength: PASSKEY_CHALLENGE_BYTES
  };
}

export function assertChallengeMatchesDescriptor(
  challenge: string,
  descriptor: ChallengeDescriptor
): void {
  const decoded = decodeChallenge(challenge);
  const actual = createHash("sha256").update(decoded).digest();
  const expected = Buffer.from(descriptor.digest, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    reject("CHALLENGE_INTEGRITY_FAILED", "challenge secret does not match its durable digest");
  }
}
