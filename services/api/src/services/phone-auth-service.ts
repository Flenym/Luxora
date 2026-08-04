import { randomUUID } from "node:crypto";
import {
  AuthResponseSchema,
  PhoneUsernameAvailabilityResponseSchema,
  PhoneChallengeResponseSchema,
  PhoneAuthenticatedResponseSchema,
  PhoneProfileRequiredResponseSchema,
  VerifyPhoneChallengeResponseSchema,
  type AuthTokens,
  type CompletePhoneRegistration,
  type CheckPhoneUsername,
  type PhoneChallengeResponse,
  type PhoneUsernameAvailabilityResponse,
  type RequestPhoneChallenge,
  type User,
  type VerifyPhoneChallenge,
  type VerifyPhoneChallengeResponse
} from "@luxora/protocol";
import { parsePhoneNumberWithError } from "libphonenumber-js/max";
import type { AppConfig } from "../config.js";
import type {
  NewRefreshToken,
  NewSession,
  PhoneAuthReceiptInput
} from "../domain/store.js";
import type { Store } from "../domain/store.js";
import type {
  PhoneAuthChallengeRecord,
  PhoneAuthCommandReceiptRecord,
  UserRecord
} from "../domain/types.js";
import {
  badRequest,
  conflict,
  rateLimited,
  serviceUnavailable,
  unauthenticated
} from "../errors.js";
import type { PhoneVerificationDeliveryProvider } from "../phone-auth/phone-delivery-provider.js";
import { PhoneAuthSecurity } from "../phone-auth/phone-auth-security.js";
import { TokenSecurity } from "../security.js";
import { createPasskeyDisabledPasswordHash } from "./password-auth.js";

const COMMIT_RETRY_LIMIT = 8;

function publicUser(user: UserRecord): User {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt
  };
}

function addSeconds(at: Date, seconds: number): string {
  return new Date(at.getTime() + seconds * 1_000).toISOString();
}

function addDays(at: Date, days: number): string {
  return new Date(at.getTime() + days * 86_400_000).toISOString();
}

function stablePayload(fields: readonly string[]): string {
  return fields.map((field) => `${field.length}:${field}`).join("|");
}

function usernameSuggestionSequence(username: string): readonly string[] {
  const numbered = /^(.*)_([0-9]{1,9})$/u.exec(username);
  const unslicedBase = (numbered?.[1] ?? username).replace(/_+$/u, "");
  const firstSuffix = numbered === null
    ? 1
    : Number.parseInt(numbered[2] as string, 10) + 1;
  const candidates: string[] = [];
  // Bound the advisory lookup work even when many nearby names are occupied.
  for (let offset = 0; offset < 100; offset += 1) {
    const suffix = String(firstSuffix + offset);
    const base = unslicedBase
      .slice(0, 32 - suffix.length - 1)
      .replace(/_+$/u, "");
    candidates.push(`${base}_${suffix}`);
  }
  return candidates;
}

function maskPhone(countryCallingCode: string, e164: string): string {
  const national = e164.slice(countryCallingCode.length + 1);
  const suffix = national.slice(-4).padStart(4, "•");
  return `+${countryCallingCode} ••• ••• ${suffix.slice(0, 2)} ${suffix.slice(2)}`;
}

function normalizePhone(input: RequestPhoneChallenge): {
  e164: string;
  countryCallingCode: string;
} {
  try {
    const parsed = parsePhoneNumberWithError(input.nationalNumber, {
      defaultCallingCode: input.countryCode,
      extract: false
    });
    if (parsed.countryCallingCode !== input.countryCode || !parsed.isValid()) {
      throw new Error("invalid phone number");
    }
    return { e164: parsed.number, countryCallingCode: parsed.countryCallingCode };
  } catch {
    throw badRequest("Enter a valid phone number");
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT_UNIQUE");
}

interface PreparedSession {
  session: NewSession;
  refreshToken: NewRefreshToken;
  tokens: AuthTokens;
}

export class PhoneAuthService {
  readonly #phoneSecurity: PhoneAuthSecurity | null;

  constructor(
    private readonly store: Store,
    private readonly accessTokens: TokenSecurity,
    private readonly config: AppConfig,
    private readonly delivery: PhoneVerificationDeliveryProvider | null,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.#phoneSecurity = config.phoneAuthEnabled
      ? new PhoneAuthSecurity(config.phoneAuthHmacSecret as string)
      : null;
  }

  get available(): boolean {
    return this.config.phoneAuthEnabled && this.delivery !== null && this.#phoneSecurity !== null;
  }

  #requireAvailable(): {
    security: PhoneAuthSecurity;
    delivery: PhoneVerificationDeliveryProvider;
  } {
    if (!this.available) throw serviceUnavailable("Phone authentication is not configured");
    return {
      security: this.#phoneSecurity as PhoneAuthSecurity,
      delivery: this.delivery as PhoneVerificationDeliveryProvider
    };
  }

  async requestChallenge(input: RequestPhoneChallenge): Promise<PhoneChallengeResponse> {
    const { security, delivery } = this.#requireAvailable();
    const normalized = normalizePhone(input);
    const phoneDigest = security.phoneDigest(normalized.e164);
    const fingerprint = security.fingerprint(
      "begin",
      stablePayload([normalized.e164, input.deviceName])
    );
    let challenge = this.store.findPhoneAuthChallengeByBeginNonce(input.clientNonce);
    if (challenge !== null && challenge.beginFingerprint !== fingerprint) {
      throw conflict("Idempotency key was already used with different input");
    }

    if (challenge === null) {
      const now = this.clock();
      const challengeId = randomUUID();
      const code = this.config.phoneAuthProvider === "development"
        ? this.config.phoneAuthDevelopmentCode as string
        : security.newVerificationCode();
      try {
        challenge = this.store.createPhoneAuthChallenge({
          id: challengeId,
          phoneDigest,
          e164: normalized.e164,
          codeDigest: security.codeDigest(challengeId, code),
          deliveryCode: code,
          deviceName: input.deviceName,
          maxAttempts: this.config.phoneAuthMaxAttempts,
          beginClientNonce: input.clientNonce,
          beginFingerprint: fingerprint,
          maskedPhone: maskPhone(normalized.countryCallingCode, normalized.e164),
          createdAt: now.toISOString(),
          expiresAt: addSeconds(now, this.config.phoneAuthChallengeTtlSeconds),
          retryAfterSeconds: this.config.phoneAuthRetryAfterSeconds
        });
        if (challenge === null) {
          const raced = this.store.findPhoneAuthChallengeByBeginNonce(input.clientNonce);
          if (raced !== null) {
            if (raced.beginFingerprint !== fingerprint) {
              throw conflict("Idempotency key was already used with different input");
            }
            challenge = raced;
          } else {
            throw rateLimited();
          }
        }
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        challenge = this.store.findPhoneAuthChallengeByBeginNonce(input.clientNonce);
        if (challenge === null || challenge.beginFingerprint !== fingerprint) {
          throw conflict("Idempotency key was already used with different input");
        }
      }
    }

    // A delivery failure is terminal and has no successful begin response to
    // replay. Verification lockout, by contrast, has consumed every attempt.
    if (challenge.state === "locked" && challenge.attemptsUsed === 0) {
      throw serviceUnavailable("Verification delivery is temporarily unavailable");
    }

    if (challenge.state === "pending_delivery") {
      if (challenge.expiresAt <= this.clock().toISOString()) {
        this.store.failPhoneAuthChallengeDelivery(
          challenge.id,
          challenge.revision,
          this.clock().toISOString()
        );
        throw serviceUnavailable("Verification challenge expired before delivery");
      }
      if (challenge.deliveryCode === null) {
        throw serviceUnavailable("Verification delivery is temporarily unavailable");
      }
      try {
        await delivery.sendVerificationCode({
          challengeId: challenge.id,
          e164: challenge.e164,
          code: challenge.deliveryCode,
          expiresAt: challenge.expiresAt
        });
      } catch {
        // Keep the same encrypted code/challenge pending for an exact retry.
        // Providers are required to deduplicate by challengeId, so an
        // ambiguous transport failure cannot create a second SMS command.
        throw serviceUnavailable("Verification delivery is temporarily unavailable");
      }
      const activated = this.store.activatePhoneAuthChallenge(
        challenge.id,
        challenge.revision,
        this.clock().toISOString()
      );
      if (!activated) {
        const current = this.store.findPhoneAuthChallengeById(challenge.id);
        if (current === null || current.state !== "pending") {
          throw serviceUnavailable("Verification delivery is temporarily unavailable");
        }
        challenge = current;
      }
    }

    return PhoneChallengeResponseSchema.parse({
      challengeId: challenge.id,
      maskedPhone: challenge.maskedPhone,
      expiresAt: challenge.expiresAt,
      retryAfterSeconds: challenge.retryAfterSeconds
    });
  }

  async verifyChallenge(
    challengeId: string,
    input: VerifyPhoneChallenge
  ): Promise<VerifyPhoneChallengeResponse> {
    const { security } = this.#requireAvailable();
    const scope = `verify:${challengeId}:${input.clientNonce}`;
    const fingerprint = security.fingerprint(
      "verify",
      stablePayload([challengeId, input.code, input.deviceName])
    );
    const replay = this.#replay(scope, fingerprint);
    if (replay !== null) return replay;

    for (let attempt = 0; attempt < COMMIT_RETRY_LIMIT; attempt += 1) {
      const challenge = this.store.findPhoneAuthChallengeById(challengeId);
      if (challenge === null || challenge.state !== "pending") {
        throw unauthenticated("Invalid or expired verification code");
      }
      const now = this.clock();
      const expired = challenge.expiresAt <= now.toISOString();
      if (expired || !security.codeMatches(challenge.id, input.code, challenge.codeDigest)) {
        const nextState = expired
          ? "expired" as const
          : challenge.attemptsUsed + 1 >= challenge.maxAttempts
            ? "locked" as const
            : "pending" as const;
        const receipt = this.#receipt({
          scope,
          operation: "verify",
          fingerprint,
          challengeId,
          resultKind: "invalid_code",
          responseJson: null,
          now,
          expiresAt: addSeconds(now, this.config.phoneAuthRegistrationTtlSeconds)
        });
        if (this.store.commitPhoneAuthRejected({
          challengeId,
          expectedRevision: challenge.revision,
          nextState,
          receipt
        })) {
          throw unauthenticated("Invalid or expired verification code");
        }
        const raced = this.#replay(scope, fingerprint);
        if (raced !== null) return raced;
        continue;
      }

      // Account existence is deliberately checked only after a correct code.
      const identity = this.store.findPhoneIdentityByDigest(challenge.phoneDigest);
      if (identity === null) {
        const registrationToken = security.newRegistrationToken();
        const registrationExpiresAt = addSeconds(
          now,
          this.config.phoneAuthRegistrationTtlSeconds
        );
        const response = PhoneProfileRequiredResponseSchema.parse({
          status: "profile_required",
          registrationToken: registrationToken.raw,
          maskedPhone: challenge.maskedPhone,
          expiresAt: registrationExpiresAt
        });
        const receipt = this.#receipt({
          scope,
          operation: "verify",
          fingerprint,
          challengeId,
          resultKind: "profile_required",
          responseJson: JSON.stringify(response),
          now,
          expiresAt: registrationExpiresAt
        });
        if (this.store.commitPhoneAuthProfileRequired({
          challengeId,
          expectedRevision: challenge.revision,
          registrationTokenHash: registrationToken.digest,
          registrationExpiresAt,
          receipt
        })) return response;
      } else {
        const user = this.store.findUserById(identity.userId);
        if (user === null) throw serviceUnavailable("Phone authentication data is inconsistent");
        const prepared = await this.#prepareSession(user.id, input.deviceName, now);
        const response = PhoneAuthenticatedResponseSchema.parse({
          status: "authenticated",
          user: publicUser(user),
          tokens: prepared.tokens
        });
        const receipt = this.#receipt({
          scope,
          operation: "verify",
          fingerprint,
          challengeId,
          resultKind: "authenticated",
          responseJson: JSON.stringify(response),
          now,
          expiresAt: prepared.session.expiresAt
        });
        if (this.store.commitPhoneAuthAuthenticated({
          challengeId,
          expectedRevision: challenge.revision,
          userId: user.id,
          session: prepared.session,
          refreshToken: prepared.refreshToken,
          receipt
        })) return response;
      }

      const raced = this.#replay(scope, fingerprint);
      if (raced !== null) return raced;
    }
    throw serviceUnavailable("Phone verification is temporarily unavailable");
  }

  async completeRegistration(input: CompletePhoneRegistration): Promise<{
    user: User;
    tokens: AuthTokens;
  }> {
    const { security } = this.#requireAvailable();
    const registrationTokenHash = security.registrationTokenDigest(input.registrationToken);
    const scope = `register:${registrationTokenHash}:${input.clientNonce}`;
    const fingerprint = security.fingerprint(
      "register",
      stablePayload([
        registrationTokenHash,
        input.displayName,
        input.username.toLowerCase(),
        input.bio,
        input.deviceName
      ])
    );
    const replay = this.#replayRegistration(scope, fingerprint);
    if (replay !== null) return replay;

    for (let attempt = 0; attempt < COMMIT_RETRY_LIMIT; attempt += 1) {
      const challenge = this.store.findPhoneAuthChallengeByRegistrationTokenHash(
        registrationTokenHash
      );
      const now = this.clock();
      if (
        challenge === null
        || challenge.state !== "verified"
        || challenge.registrationExpiresAt === null
        || challenge.registrationExpiresAt <= now.toISOString()
      ) throw unauthenticated("Invalid or expired registration token");

      const userId = randomUUID();
      const username = input.username;
      const usernameNormalized = username.toLowerCase();
      if (this.store.findUserByUsername(usernameNormalized) !== null) {
        throw conflict("Username is already taken");
      }
      const passwordHash = await createPasskeyDisabledPasswordHash();
      const prepared = await this.#prepareSession(userId, input.deviceName, now);
      const user: UserRecord = {
        id: userId,
        username,
        usernameNormalized,
        displayName: input.displayName,
        bio: input.bio,
        avatarUrl: null,
        passwordHash,
        passwordAuthEnabled: false,
        createdAt: now.toISOString(),
        lastSeenAt: null
      };
      const response = AuthResponseSchema.parse({
        user: publicUser(user),
        tokens: prepared.tokens
      });
      const receipt = this.#receipt({
        scope,
        operation: "register",
        fingerprint,
        challengeId: challenge.id,
        resultKind: "registered",
        responseJson: JSON.stringify(response),
        now,
        expiresAt: prepared.session.expiresAt
      });
      try {
        if (this.store.commitPhoneAuthRegistration({
          challengeId: challenge.id,
          expectedRevision: challenge.revision,
          registrationTokenHash,
          user: {
            id: user.id,
            username: user.username,
            usernameNormalized: user.usernameNormalized,
            displayName: user.displayName,
            bio: user.bio,
            passwordHash: user.passwordHash,
            createdAt: user.createdAt
          },
          session: prepared.session,
          refreshToken: prepared.refreshToken,
          receipt
        })) return response;
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
      }
      const raced = this.#replayRegistration(scope, fingerprint);
      if (raced !== null) return raced;
    }
    throw serviceUnavailable("Phone registration is temporarily unavailable");
  }

  checkUsername(input: CheckPhoneUsername): PhoneUsernameAvailabilityResponse {
    const { security } = this.#requireAvailable();
    const tokenHash = security.registrationTokenDigest(input.registrationToken);
    const challenge = this.store.findPhoneAuthChallengeByRegistrationTokenHash(tokenHash);
    const now = this.clock().toISOString();
    if (
      challenge === null
      || challenge.state !== "verified"
      || challenge.registrationExpiresAt === null
      || challenge.registrationExpiresAt <= now
    ) throw unauthenticated("Invalid or expired registration token");

    const available = this.store.findUserByUsername(input.username.toLowerCase()) === null;
    const suggestions: string[] = [];
    if (!available) {
      for (const candidate of usernameSuggestionSequence(input.username)) {
        if (this.store.findUserByUsername(candidate.toLowerCase()) === null) {
          suggestions.push(candidate);
          if (suggestions.length === 5) break;
        }
      }
    }
    return PhoneUsernameAvailabilityResponseSchema.parse({
      username: input.username,
      available,
      suggestions
    });
  }

  #receipt(input: {
    scope: string;
    operation: "verify" | "register";
    fingerprint: string;
    challengeId: string;
    resultKind: PhoneAuthReceiptInput["resultKind"];
    responseJson: string | null;
    now: Date;
    expiresAt: string;
  }): PhoneAuthReceiptInput {
    return {
      scope: input.scope,
      operation: input.operation,
      fingerprint: input.fingerprint,
      challengeId: input.challengeId,
      resultKind: input.resultKind,
      responseJson: input.responseJson,
      createdAt: input.now.toISOString(),
      expiresAt: input.expiresAt
    };
  }

  #replay(scope: string, fingerprint: string): VerifyPhoneChallengeResponse | null {
    const receipt = this.#matchingReceipt(scope, fingerprint);
    if (receipt === null) return null;
    if (receipt.resultKind === "invalid_code") {
      throw unauthenticated("Invalid or expired verification code");
    }
    if (receipt.operation !== "verify" || receipt.responseJson === null) {
      throw serviceUnavailable("Phone verification receipt is inconsistent");
    }
    return VerifyPhoneChallengeResponseSchema.parse(JSON.parse(receipt.responseJson));
  }

  #replayRegistration(
    scope: string,
    fingerprint: string
  ): { user: User; tokens: AuthTokens } | null {
    const receipt = this.#matchingReceipt(scope, fingerprint);
    if (receipt === null) return null;
    if (receipt.operation !== "register" || receipt.responseJson === null) {
      throw serviceUnavailable("Phone registration receipt is inconsistent");
    }
    return AuthResponseSchema.parse(JSON.parse(receipt.responseJson));
  }

  #matchingReceipt(
    scope: string,
    fingerprint: string
  ): PhoneAuthCommandReceiptRecord | null {
    const receipt = this.store.findPhoneAuthCommandReceipt(scope);
    if (receipt !== null && receipt.fingerprint !== fingerprint) {
      throw conflict("Idempotency key was already used with different input");
    }
    return receipt;
  }

  async #prepareSession(userId: string, deviceName: string, now: Date): Promise<PreparedSession> {
    const sessionId = randomUUID();
    const refresh = this.accessTokens.newRefreshToken();
    const expiresAt = addDays(now, this.config.refreshTokenTtlDays);
    const access = await this.accessTokens.signAccessToken(userId, sessionId);
    const session: NewSession = {
      id: sessionId,
      userId,
      deviceName,
      createdAt: now.toISOString(),
      expiresAt
    };
    const refreshToken: NewRefreshToken = {
      id: randomUUID(),
      sessionId,
      tokenHash: refresh.hash,
      createdAt: now.toISOString(),
      expiresAt
    };
    return {
      session,
      refreshToken,
      tokens: {
        accessToken: access.token,
        refreshToken: refresh.raw,
        tokenType: "Bearer",
        expiresIn: this.config.accessTokenTtlSeconds,
        sessionId
      }
    };
  }
}
