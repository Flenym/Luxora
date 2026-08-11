import { randomUUID } from "node:crypto";
import {
  PhonePasswordStatusSchema,
  type ConfigurePhonePassword,
  type AuthResponse,
  type AuthTokens,
  type DisablePhonePassword,
  type LoginRequest,
  type PatchCurrentUser,
  type PhonePasswordStatus,
  type RegisterRequest,
  type Session,
  type User
} from "@luxora/protocol";
import type { AppConfig } from "../config.js";
import type { Store } from "../domain/store.js";
import type { AuthenticatedPrincipal, UserRecord } from "../domain/types.js";
import { conflict, notFound, serviceUnavailable, unauthenticated } from "../errors.js";
import { TokenSecurity } from "../security.js";
import {
  createPasskeyDisabledPasswordHash,
  hashPassword,
  verifyPassword
} from "./password-auth.js";
import type { EventPublisher } from "./event-publisher.js";
import { appendSyncInvalidations } from "./sync-invalidation.js";

// Argon2id is intentionally expensive. Keep one salted timing hash per
// process/module instance instead of starting another background hash for
// every composed Fastify app (tests and safe-start probes create many apps).
// Unknown-account logins still perform the same Argon2 verification path.
const TIMING_DUMMY_PASSWORD_HASH = hashPassword(
  "not-a-real-password-used-for-timing-only"
);

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

function expiresAtFromDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

function latestTimestamp(...timestamps: string[]): string {
  return timestamps.reduce((latest, candidate) => candidate > latest ? candidate : latest);
}

function earliestTimestamp(...timestamps: string[]): string {
  return timestamps.reduce((earliest, candidate) => candidate < earliest ? candidate : earliest);
}

function isTransientStoreContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "string" && (
    code === "SQLITE_BUSY" ||
    code.startsWith("SQLITE_BUSY_") ||
    code === "SQLITE_LOCKED" ||
    code.startsWith("SQLITE_LOCKED_")
  );
}

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly tokens: TokenSecurity,
    private readonly config: AppConfig,
    private readonly sessionTerminator?: { terminateSession(sessionId: string): void },
    private readonly clock: () => Date = () => new Date(),
    private readonly publisher?: Pick<EventPublisher, "publish">
  ) {}

  async register(input: RegisterRequest): Promise<AuthResponse> {
    const now = this.clock();
    const usernameNormalized = input.username.toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const existing = this.store.findUserByUsername(usernameNormalized);
    if (existing !== null) throw conflict("Username is already taken");

    let user: UserRecord;
    try {
      user = this.store.createUser({
        id,
        username: input.username,
        usernameNormalized,
        displayName: input.displayName,
        passwordHash,
        createdAt: now.toISOString()
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw conflict("Username is already taken");
      }
      throw error;
    }

    const authTokens = await this.#createSession(user.id, input.deviceName, now);
    return { user: publicUser(user), tokens: authTokens };
  }

  async login(input: LoginRequest): Promise<AuthResponse> {
    const user = this.store.findUserByUsername(input.username.toLowerCase());
    const candidateHash = user?.passwordHash ?? await TIMING_DUMMY_PASSWORD_HASH;
    let valid = false;
    try {
      valid = await verifyPassword(candidateHash, input.password);
    } catch {
      // Corrupt legacy data must not create a fast username oracle.
      await verifyPassword(await TIMING_DUMMY_PASSWORD_HASH, input.password).catch(() => false);
    }
    if (!valid || user === null || !user.passwordAuthEnabled) {
      throw unauthenticated("Invalid username or password");
    }

    const tokens = await this.#createSession(user.id, input.deviceName, this.clock());
    return { user: publicUser(user), tokens };
  }

  async refresh(rawToken: string): Promise<AuthTokens> {
    const checkedAtIso = this.clock().toISOString();
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const record = this.store.findRefreshToken(tokenHash);
    if (record === null) throw unauthenticated("Invalid refresh token");
    if (record.usedAt !== null) {
      this.store.revokeSession(
        record.sessionId,
        latestTimestamp(checkedAtIso, record.createdAt, record.usedAt, record.session.lastSeenAt)
      );
      this.#terminateRevokedSession(record.sessionId);
      throw unauthenticated("Refresh token reuse detected; session revoked");
    }
    if (
      record.expiresAt <= checkedAtIso ||
      record.session.expiresAt <= checkedAtIso ||
      record.session.revokedAt !== null
    ) {
      throw unauthenticated("Invalid or expired refresh token");
    }

    // Sign before consuming the one-time refresh token. Signing is pure; if it
    // fails, the client can safely retry instead of losing the session to a
    // partial rotation. The writer-reserved transaction below rechecks every
    // mutable predicate before committing the replacement.
    const access = await this.tokens.signAccessToken(record.session.userId, record.sessionId);
    const replacement = this.tokens.newRefreshToken();
    const replacementId = randomUUID();
    let outcome:
      | { kind: "rotated"; sessionId: string }
      | { kind: "reused"; sessionId: string }
      | { kind: "invalid" };
    try {
      outcome = this.store.immediateTransaction(():
        | { kind: "rotated"; sessionId: string }
        | { kind: "reused"; sessionId: string }
        | { kind: "invalid" } => {
        // This sample must happen after the writer reservation is held. Taking
        // it before BEGIN IMMEDIATE would allow lock wait to cross expiry.
        const commitAtIso = this.clock().toISOString();
        const current = this.store.findRefreshToken(tokenHash);
        if (current === null) return { kind: "invalid" };
        const observedAt = latestTimestamp(
          checkedAtIso,
          commitAtIso,
          current.createdAt,
          current.session.lastSeenAt
        );
        if (current.usedAt !== null) {
          const reuseAt = latestTimestamp(observedAt, current.usedAt);
          this.store.revokeSession(current.sessionId, reuseAt);
          return { kind: "reused", sessionId: current.sessionId };
        }
        if (
          current.expiresAt <= observedAt ||
          current.session.expiresAt <= observedAt ||
          current.session.revokedAt !== null
        ) {
          return { kind: "invalid" };
        }
        const rotated = this.store.rotateRefreshToken(current.id, {
          id: replacementId,
          sessionId: current.sessionId,
          tokenHash: replacement.hash,
          createdAt: observedAt,
          // Rotation cannot lengthen a deliberately shorter token/family bound.
          expiresAt: earliestTimestamp(current.expiresAt, current.session.expiresAt)
        }, observedAt);
        if (!rotated) {
          // Defensive for alternative Store implementations. SQLite holds an
          // IMMEDIATE writer reservation here, so a failed CAS means reuse.
          this.store.revokeSession(current.sessionId, observedAt);
          return { kind: "reused", sessionId: current.sessionId };
        }
        this.store.touchSession(current.sessionId, observedAt);
        return { kind: "rotated", sessionId: current.sessionId };
      });
    } catch (error) {
      // A future store/driver can report an error after the commit outcome is
      // ambiguous. An authoritative reread that observes consumption is enough
      // to fail closed: revoke the known session instead of leaving an
      // unrecoverable replacement active or leaking an internal error.
      const reconciledSessionId = this.#reconcileConsumedRefresh(
        tokenHash,
        checkedAtIso
      );
      if (reconciledSessionId !== null) {
        this.#terminateRevokedSession(reconciledSessionId);
        throw unauthenticated("Refresh token reuse detected; session revoked");
      }
      if (isTransientStoreContention(error)) {
        throw serviceUnavailable("Refresh temporarily unavailable");
      }
      throw error;
    }
    if (outcome.kind === "reused") {
      this.#terminateRevokedSession(outcome.sessionId);
      throw unauthenticated("Refresh token reuse detected; session revoked");
    }
    if (outcome.kind === "invalid") {
      throw unauthenticated("Invalid or expired refresh token");
    }
    return {
      accessToken: access.token,
      refreshToken: replacement.raw,
      tokenType: "Bearer",
      expiresIn: this.config.accessTokenTtlSeconds,
      sessionId: outcome.sessionId
    };
  }

  listSessions(principal: AuthenticatedPrincipal): Session[] {
    return this.store.listSessions(principal.userId, principal.sessionId);
  }

  revokeSession(principal: AuthenticatedPrincipal, sessionId: string): void {
    const belongsToUser = this.store.listSessions(principal.userId, principal.sessionId)
      .some((session) => session.id === sessionId);
    if (!belongsToUser) throw notFound("Session not found");
    this.store.revokeSession(sessionId, this.clock().toISOString());
    this.#terminateRevokedSession(sessionId);
  }

  getUser(userId: string): User {
    const user = this.store.findUserById(userId);
    if (user === null) throw notFound("User not found");
    return publicUser(user);
  }

  updateUser(userId: string, input: PatchCurrentUser): User {
    const changedAt = this.clock().toISOString();
    const outcome = this.store.immediateTransaction(() => {
      const current = this.store.findUserById(userId);
      if (current === null) throw notFound("User not found");
      const changed = (input.displayName !== undefined && input.displayName !== current.displayName) ||
        (input.bio !== undefined && input.bio !== current.bio);
      if (!changed) return { user: current, events: [] };

      const user = this.store.updateUserProfile(userId, input, changedAt);
      if (user === null) throw notFound("User not found");
      const events = appendSyncInvalidations(
        this.store,
        this.store.listProfileProjectionAudienceUserIds(userId),
        "profile_updated",
        changedAt,
        this.config.syncInvalidationEnabled
      );
      return { user, events };
    });
    this.publisher?.publish(outcome.events);
    return publicUser(outcome.user);
  }

  phonePasswordStatus(userId: string): PhonePasswordStatus {
    const user = this.store.findUserById(userId);
    if (user === null) throw notFound("User not found");
    const eligible = this.store.findPhoneIdentityByUserId(userId) !== null;
    return PhonePasswordStatusSchema.parse({
      eligible,
      enabled: eligible && user.phonePasswordEnabled
    });
  }

  async configurePhonePassword(
    userId: string,
    input: ConfigurePhonePassword
  ): Promise<PhonePasswordStatus> {
    const user = this.store.findUserById(userId);
    if (user === null) throw notFound("User not found");
    if (this.store.findPhoneIdentityByUserId(userId) === null) {
      throw conflict("A verified phone identity is required");
    }
    if (user.phonePasswordEnabled) {
      let currentValid = false;
      if (input.currentPassword !== undefined && user.phonePasswordHash !== null) {
        try {
          currentValid = await verifyPassword(user.phonePasswordHash, input.currentPassword);
        } catch {
          currentValid = false;
        }
      }
      if (!currentValid) throw unauthenticated("Invalid current password");
    }

    const nextPhonePasswordHash = await hashPassword(input.password);
    const changed = this.store.compareAndSetPhonePassword({
      userId,
      expectedPhonePasswordHash: user.phonePasswordHash,
      expectedEnabled: user.phonePasswordEnabled,
      nextPhonePasswordHash,
      nextEnabled: true,
      at: this.clock().toISOString()
    });
    if (!changed) throw conflict("Phone password changed concurrently; retry");
    return PhonePasswordStatusSchema.parse({ eligible: true, enabled: true });
  }

  async disablePhonePassword(
    userId: string,
    input: DisablePhonePassword
  ): Promise<PhonePasswordStatus> {
    const user = this.store.findUserById(userId);
    if (user === null) throw notFound("User not found");
    if (this.store.findPhoneIdentityByUserId(userId) === null) {
      throw conflict("A verified phone identity is required");
    }
    if (!user.phonePasswordEnabled) {
      return PhonePasswordStatusSchema.parse({ eligible: true, enabled: false });
    }
    let currentValid = false;
    if (user.phonePasswordHash !== null) {
      try {
        currentValid = await verifyPassword(user.phonePasswordHash, input.currentPassword);
      } catch {
        currentValid = false;
      }
    }
    if (!currentValid) throw unauthenticated("Invalid current password");

    const placeholderHash = await createPasskeyDisabledPasswordHash();
    const changed = this.store.compareAndSetPhonePassword({
      userId,
      expectedPhonePasswordHash: user.phonePasswordHash,
      expectedEnabled: true,
      nextPhonePasswordHash: placeholderHash,
      nextEnabled: false,
      at: this.clock().toISOString()
    });
    if (!changed) throw conflict("Phone password changed concurrently; retry");
    return PhonePasswordStatusSchema.parse({ eligible: true, enabled: false });
  }

  async #createSession(userId: string, deviceName: string, now: Date): Promise<AuthTokens> {
    const sessionId = randomUUID();
    const refresh = this.tokens.newRefreshToken();
    const expiresAt = expiresAtFromDays(now, this.config.refreshTokenTtlDays);
    // Sign before creating durable bearer state. A signer/KMS failure must not
    // leave an orphan session whose only raw refresh credential was never
    // delivered to the client.
    const access = await this.tokens.signAccessToken(userId, sessionId);
    this.store.transaction(() => {
      this.store.createSession({
        id: sessionId,
        userId,
        deviceName,
        createdAt: now.toISOString(),
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt: now.toISOString(),
        expiresAt
      });
    });
    return {
      accessToken: access.token,
      refreshToken: refresh.raw,
      tokenType: "Bearer",
      expiresIn: this.config.accessTokenTtlSeconds,
      sessionId
    };
  }

  #reconcileConsumedRefresh(tokenHash: string, fallbackAt: string): string | null {
    try {
      const current = this.store.findRefreshToken(tokenHash);
      if (current === null || current.usedAt === null) return null;
      const at = latestTimestamp(
        fallbackAt,
        this.clock().toISOString(),
        current.createdAt,
        current.usedAt,
        current.session.lastSeenAt
      );
      this.store.revokeSession(current.sessionId, at);
      return current.sessionId;
    } catch {
      // Preserve the original store error if authoritative reconciliation is
      // itself unavailable; production drivers must fault-inject this boundary.
      return null;
    }
  }

  #terminateRevokedSession(sessionId: string): void {
    try {
      this.sessionTerminator?.terminateSession(sessionId);
    } catch {
      // Durable session state is the authorization authority. Transport cleanup
      // is post-commit best effort and must not turn a committed revoke into 500.
    }
  }
}
