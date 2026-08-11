import { randomUUID } from "node:crypto";
import {
  AuthResponseSchema,
  PhonePasswordRequiredResponseSchema,
  PhoneUsernameAvailabilityResponseSchema,
  PhoneChallengeResponseSchema,
  PhoneAuthenticatedResponseSchema,
  PhoneProfileRequiredResponseSchema,
  VerifyPhoneChallengeResponseSchema,
  type AuthTokens,
  type CompletePhoneRegistration,
  type CompletePhonePasswordChallenge,
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
  PhoneAuthPasswordReceiptInput,
  PhoneAuthReceiptInput
} from "../domain/store.js";
import type { Store } from "../domain/store.js";
import type {
  PhoneAuthChallengeRecord,
  PhoneAuthCommandReceiptRecord,
  PhoneAuthPasswordReceiptRecord,
  UserRecord
} from "../domain/types.js";
import {
  AppError,
  badRequest,
  conflict,
  serviceUnavailable
} from "../errors.js";
import type { PhoneVerificationDeliveryProvider } from "../phone-auth/phone-delivery-provider.js";
import { PhoneAuthSecurity } from "../phone-auth/phone-auth-security.js";
import { TokenSecurity } from "../security.js";
import { createPasskeyDisabledPasswordHash, verifyPassword } from "./password-auth.js";

const COMMIT_RETRY_LIMIT = 8;

type PhoneVerificationFailure = "invalid_code" | "expired" | "attempts_exhausted";
const PHONE_VERIFICATION_FAILURES: readonly PhoneVerificationFailure[] = [
  "invalid_code",
  "expired",
  "attempts_exhausted"
];

function failureReceiptScope(scope: string, reason: PhoneVerificationFailure): string {
  // Migration 18 intentionally keeps rejected receipts payload-free. Encoding
  // the bounded outcome in the command scope preserves an exact durable replay
  // without weakening the database rule that invalid OTP receipts contain no
  // encrypted or plaintext response body.
  return `${scope}:failure:${reason}`;
}

function verificationFailure(reason: PhoneVerificationFailure): AppError {
  switch (reason) {
    case "invalid_code":
      return new AppError(
        401,
        "PHONE_AUTH_CODE_INVALID",
        "The verification code is invalid",
        { reason }
      );
    case "expired":
      return new AppError(
        401,
        "PHONE_AUTH_CHALLENGE_EXPIRED",
        "The verification challenge has expired",
        { reason }
      );
    case "attempts_exhausted":
      return new AppError(
        401,
        "PHONE_AUTH_ATTEMPTS_EXHAUSTED",
        "Verification attempts are exhausted",
        { reason }
      );
  }
}

function challengeInvalid(): AppError {
  return new AppError(
    401,
    "PHONE_AUTH_CHALLENGE_INVALID",
    "The verification challenge is invalid"
  );
}

function resendCooldown(seconds: number): AppError {
  return new AppError(
    429,
    "PHONE_AUTH_RESEND_COOLDOWN",
    `Retry after ${seconds} seconds`,
    { retryAfterSeconds: seconds }
  );
}

function deliveryUnavailable(message = "Verification delivery is temporarily unavailable"): AppError {
  return new AppError(503, "PHONE_AUTH_DELIVERY_UNAVAILABLE", message);
}

function phoneAuthTemporarilyUnavailable(message: string): AppError {
  return new AppError(503, "PHONE_AUTH_TEMPORARILY_UNAVAILABLE", message);
}

function registrationExpired(): AppError {
  return new AppError(
    401,
    "PHONE_AUTH_REGISTRATION_EXPIRED",
    "The phone registration grant is invalid or expired"
  );
}

function passwordTokenInvalid(): AppError {
  return new AppError(
    401,
    "PHONE_AUTH_PASSWORD_TOKEN_INVALID",
    "The phone password challenge is invalid or expired"
  );
}

function passwordRejected(reason: "password_invalid" | "attempts_exhausted"): AppError {
  return reason === "attempts_exhausted"
    ? new AppError(
        401,
        "PHONE_AUTH_PASSWORD_ATTEMPTS_EXHAUSTED",
        "Password attempts are exhausted",
        { reason }
      )
    : new AppError(
        401,
        "PHONE_AUTH_PASSWORD_INVALID",
        "The password is invalid",
        { reason }
      );
}

function publicUser(user: UserRecord): User {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    avatarPath: user.avatarPath ?? null,
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
            throw resendCooldown(this.config.phoneAuthRetryAfterSeconds);
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
      throw deliveryUnavailable();
    }

    if (challenge.state === "pending_delivery") {
      if (challenge.expiresAt <= this.clock().toISOString()) {
        this.store.failPhoneAuthChallengeDelivery(
          challenge.id,
          challenge.revision,
          this.clock().toISOString()
        );
        throw new AppError(
          401,
          "PHONE_AUTH_CHALLENGE_EXPIRED",
          "Verification challenge expired before delivery"
        );
      }
      if (challenge.deliveryCode === null) {
        throw deliveryUnavailable();
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
        throw deliveryUnavailable();
      }
      const activated = this.store.activatePhoneAuthChallenge(
        challenge.id,
        challenge.revision,
        this.clock().toISOString()
      );
      if (!activated) {
        const current = this.store.findPhoneAuthChallengeById(challenge.id);
        if (current === null || current.state !== "pending") {
          throw deliveryUnavailable();
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
      if (challenge === null) throw challengeInvalid();
      if (challenge.state === "expired") throw verificationFailure("expired");
      if (challenge.state === "locked") {
        throw challenge.attemptsUsed >= challenge.maxAttempts
          ? verificationFailure("attempts_exhausted")
          : challengeInvalid();
      }
      if (challenge.state !== "pending") throw challengeInvalid();
      const now = this.clock();
      const expired = challenge.expiresAt <= now.toISOString();
      if (expired || !security.codeMatches(challenge.id, input.code, challenge.codeDigest)) {
        const nextState = expired
          ? "expired" as const
          : challenge.attemptsUsed + 1 >= challenge.maxAttempts
            ? "locked" as const
            : "pending" as const;
        const failure: PhoneVerificationFailure = expired
          ? "expired"
          : nextState === "locked"
            ? "attempts_exhausted"
            : "invalid_code";
        const receipt = this.#receipt({
          scope: failureReceiptScope(scope, failure),
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
          throw verificationFailure(failure);
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
        if (user.phonePasswordEnabled) {
          const passwordToken = security.newPasswordToken();
          const passwordExpiresAt = addSeconds(
            now,
            this.config.phoneAuthRegistrationTtlSeconds
          );
          const response = PhonePasswordRequiredResponseSchema.parse({
            status: "password_required",
            passwordToken: passwordToken.raw,
            maskedPhone: challenge.maskedPhone,
            expiresAt: passwordExpiresAt
          });
          const receipt = this.#passwordReceipt({
            scope,
            fingerprint,
            challengeId,
            resultKind: "password_required",
            responseJson: JSON.stringify(response),
            now,
            expiresAt: passwordExpiresAt
          });
          if (this.store.commitPhoneAuthPasswordRequired({
            challengeId,
            expectedRevision: challenge.revision,
            userId: user.id,
            passwordTokenHash: passwordToken.digest,
            passwordExpiresAt,
            receipt
          })) return response;
        } else {
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
      }

      const raced = this.#replay(scope, fingerprint);
      if (raced !== null) return raced;
    }
    throw phoneAuthTemporarilyUnavailable("Phone verification is temporarily unavailable");
  }

  async completePassword(
    input: CompletePhonePasswordChallenge
  ): Promise<VerifyPhoneChallengeResponse> {
    const { security } = this.#requireAvailable();
    const passwordTokenHash = security.passwordTokenDigest(input.passwordToken);
    const scope = `password:${passwordTokenHash}:${input.clientNonce}`;
    const fingerprint = security.fingerprint(
      "password",
      stablePayload([
        passwordTokenHash,
        input.password,
        input.deviceName
      ])
    );
    const replay = this.#replayPassword(scope, fingerprint);
    if (replay !== null) return replay;

    for (let attempt = 0; attempt < COMMIT_RETRY_LIMIT; attempt += 1) {
      const challenge = this.store.findPhoneAuthChallengeByRegistrationTokenHash(
        passwordTokenHash
      );
      const now = this.clock();
      if (
        challenge === null
        || challenge.state !== "verified"
        || challenge.registrationExpiresAt === null
        || challenge.registrationExpiresAt <= now.toISOString()
      ) throw passwordTokenInvalid();
      const identity = this.store.findPhoneIdentityByDigest(challenge.phoneDigest);
      if (identity === null) throw passwordTokenInvalid();
      const user = this.store.findUserById(identity.userId);
      if (
        user === null
        || !user.phonePasswordEnabled
        || user.phonePasswordHash === null
      ) throw passwordTokenInvalid();

      let valid = false;
      try {
        valid = await verifyPassword(user.phonePasswordHash, input.password);
      } catch {
        valid = false;
      }
      if (!valid) {
        const outcome = this.store.commitPhoneAuthPasswordRejected({
          challengeId: challenge.id,
          expectedRevision: challenge.revision,
          userId: user.id,
          passwordTokenHash,
          maxAttempts: this.config.phoneAuthMaxAttempts,
          receipt: {
            scope,
            fingerprint,
            challengeId: challenge.id,
            createdAt: now.toISOString(),
            expiresAt: challenge.registrationExpiresAt
          }
        });
        if (outcome !== null) throw passwordRejected(outcome);
        const raced = this.#replayPassword(scope, fingerprint);
        if (raced !== null) return raced;
        continue;
      }

      const prepared = await this.#prepareSession(user.id, input.deviceName, now);
      const response = PhoneAuthenticatedResponseSchema.parse({
        status: "authenticated",
        user: publicUser(user),
        tokens: prepared.tokens
      });
      const receipt = this.#passwordReceipt({
        scope,
        fingerprint,
        challengeId: challenge.id,
        resultKind: "authenticated",
        responseJson: JSON.stringify(response),
        now,
        expiresAt: prepared.session.expiresAt
      });
      if (this.store.commitPhoneAuthPasswordAuthenticated({
        challengeId: challenge.id,
        expectedRevision: challenge.revision,
        userId: user.id,
        passwordTokenHash,
        session: prepared.session,
        refreshToken: prepared.refreshToken,
        receipt
      })) return response;
      const raced = this.#replayPassword(scope, fingerprint);
      if (raced !== null) return raced;
    }
    throw phoneAuthTemporarilyUnavailable("Phone password verification is temporarily unavailable");
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
      ) throw registrationExpired();

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
        phonePasswordHash: null,
        phonePasswordEnabled: false,
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
    throw phoneAuthTemporarilyUnavailable("Phone registration is temporarily unavailable");
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
    ) throw registrationExpired();

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

  #passwordReceipt<ResultKind extends PhoneAuthPasswordReceiptInput["resultKind"]>(input: {
    scope: string;
    fingerprint: string;
    challengeId: string;
    resultKind: ResultKind;
    responseJson: string | null;
    now: Date;
    expiresAt: string;
  }): PhoneAuthPasswordReceiptInput & { resultKind: ResultKind } {
    return {
      scope: input.scope,
      fingerprint: input.fingerprint,
      challengeId: input.challengeId,
      resultKind: input.resultKind,
      responseJson: input.responseJson,
      createdAt: input.now.toISOString(),
      expiresAt: input.expiresAt
    };
  }

  #replay(scope: string, fingerprint: string): VerifyPhoneChallengeResponse | null {
    for (const reason of PHONE_VERIFICATION_FAILURES) {
      const failureReceipt = this.#matchingReceipt(
        failureReceiptScope(scope, reason),
        fingerprint
      );
      if (failureReceipt === null) continue;
      if (
        failureReceipt.operation !== "verify"
        || failureReceipt.resultKind !== "invalid_code"
        || failureReceipt.responseJson !== null
      ) {
        throw phoneAuthTemporarilyUnavailable("Phone verification receipt is inconsistent");
      }
      throw verificationFailure(reason);
    }
    const receipt = this.#matchingReceipt(scope, fingerprint);
    if (receipt === null) {
      const passwordReceipt = this.#matchingPasswordReceipt(scope, fingerprint);
      if (passwordReceipt === null) return null;
      if (
        passwordReceipt.resultKind !== "password_required"
        || passwordReceipt.responseJson === null
      ) {
        throw phoneAuthTemporarilyUnavailable("Phone password receipt is inconsistent");
      }
      return VerifyPhoneChallengeResponseSchema.parse(
        JSON.parse(passwordReceipt.responseJson)
      );
    }
    if (receipt.resultKind === "invalid_code") {
      // Legacy receipts created before the outcome suffix represented only an
      // ordinary wrong code and remain exactly replayable after this upgrade.
      if (receipt.responseJson !== null) {
        throw phoneAuthTemporarilyUnavailable("Phone verification receipt is inconsistent");
      }
      throw verificationFailure("invalid_code");
    }
    if (receipt.operation !== "verify" || receipt.responseJson === null) {
      throw phoneAuthTemporarilyUnavailable("Phone verification receipt is inconsistent");
    }
    return VerifyPhoneChallengeResponseSchema.parse(JSON.parse(receipt.responseJson));
  }

  #replayPassword(
    scope: string,
    fingerprint: string
  ): VerifyPhoneChallengeResponse | null {
    const receipt = this.#matchingPasswordReceipt(scope, fingerprint);
    if (receipt === null) return null;
    if (receipt.resultKind === "password_invalid") {
      if (receipt.responseJson !== null) {
        throw phoneAuthTemporarilyUnavailable("Phone password receipt is inconsistent");
      }
      throw passwordRejected("password_invalid");
    }
    if (receipt.resultKind === "attempts_exhausted") {
      if (receipt.responseJson !== null) {
        throw phoneAuthTemporarilyUnavailable("Phone password receipt is inconsistent");
      }
      throw passwordRejected("attempts_exhausted");
    }
    if (receipt.resultKind !== "authenticated" || receipt.responseJson === null) {
      throw phoneAuthTemporarilyUnavailable("Phone password receipt is inconsistent");
    }
    return PhoneAuthenticatedResponseSchema.parse(JSON.parse(receipt.responseJson));
  }

  #replayRegistration(
    scope: string,
    fingerprint: string
  ): { user: User; tokens: AuthTokens } | null {
    const receipt = this.#matchingReceipt(scope, fingerprint);
    if (receipt === null) return null;
    if (receipt.operation !== "register" || receipt.responseJson === null) {
      throw phoneAuthTemporarilyUnavailable("Phone registration receipt is inconsistent");
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

  #matchingPasswordReceipt(
    scope: string,
    fingerprint: string
  ): PhoneAuthPasswordReceiptRecord | null {
    const receipt = this.store.findPhoneAuthPasswordReceipt(scope);
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
