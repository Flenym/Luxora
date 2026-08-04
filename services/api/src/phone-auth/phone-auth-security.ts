import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export class PhoneAuthSecurity {
  readonly #secret: Buffer;

  constructor(secret: string) {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Phone authentication HMAC secret must contain at least 32 bytes");
    }
    this.#secret = Buffer.from(secret, "utf8");
  }

  #digest(domain: string, value: string): string {
    return createHmac("sha256", this.#secret)
      .update(`luxora-phone-auth:v1:${domain}\u0000`, "utf8")
      .update(value, "utf8")
      .digest("hex");
  }

  phoneDigest(e164: string): string {
    return this.#digest("phone", e164);
  }

  codeDigest(challengeId: string, code: string): string {
    return this.#digest("code", `${challengeId}\u0000${code}`);
  }

  registrationTokenDigest(token: string): string {
    return this.#digest("registration-token", token);
  }

  fingerprint(operation: string, canonicalPayload: string): string {
    return this.#digest(`fingerprint:${operation}`, canonicalPayload);
  }

  codeMatches(challengeId: string, candidate: string, expectedDigest: string): boolean {
    if (!DIGEST_PATTERN.test(expectedDigest)) return false;
    const actual = Buffer.from(this.codeDigest(challengeId, candidate), "hex");
    const expected = Buffer.from(expectedDigest, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  newVerificationCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  newRegistrationToken(): { raw: string; digest: string } {
    const raw = `luxpr_${randomBytes(32).toString("base64url")}`;
    return { raw, digest: this.registrationTokenDigest(raw) };
  }
}
