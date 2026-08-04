import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import type { Store } from "./domain/store.js";
import { AppError } from "./errors.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { TokenSecurity } from "./security.js";
import { AuthService } from "./services/auth-service.js";
import { testConfig } from "./test-helpers.js";

interface RunningWriter {
  writerHeld: Promise<void>;
  outcome: Promise<{ ok: boolean; message?: string }>;
  worker: Worker;
}

function delegatedStore(
  store: SqliteStore,
  overrides: Partial<Record<keyof Store, unknown>>
): Store {
  return new Proxy(store as unknown as Record<PropertyKey, unknown>, {
    get(target, property) {
      const override = overrides[property as keyof Store];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, store);
      return typeof value === "function" ? value.bind(store) : value;
    }
  }) as unknown as Store;
}

class FailingTokenSecurity extends TokenSecurity {
  override async signAccessToken(): Promise<{ token: string; tokenId: string }> {
    throw new Error("test signer unavailable");
  }
}

class RecoveringTokenSecurity extends TokenSecurity {
  failSigning = true;

  override async signAccessToken(
    userId: string,
    sessionId: string
  ): Promise<{ token: string; tokenId: string }> {
    if (this.failSigning) throw new Error("test transient signer failure");
    return super.signAccessToken(userId, sessionId);
  }
}

function startCompetingRotation(
  databasePath: string,
  rawToken: string,
  rotatedAt: string
): RunningWriter {
  const worker = new Worker(
    new URL("./test-support/auth-refresh-race-worker.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      workerData: {
        databasePath,
        rawToken,
        rotatedAt,
        holdMilliseconds: 150,
        gate: new SharedArrayBuffer(4)
      }
    }
  );
  let markHeld: (() => void) | undefined;
  let failHeld: ((error: Error) => void) | undefined;
  let finish: ((outcome: { ok: boolean; message?: string }) => void) | undefined;
  let failOutcome: ((error: Error) => void) | undefined;
  let heldSettled = false;
  let outcomeSettled = false;
  const writerHeld = new Promise<void>((resolve, reject) => {
    markHeld = resolve;
    failHeld = reject;
  });
  const outcome = new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
    finish = resolve;
    failOutcome = reject;
  });
  worker.on("message", (message: any) => {
    if (message.type === "writer-held" && !heldSettled) {
      heldSettled = true;
      markHeld?.();
    }
    if (message.type === "result" && !outcomeSettled) {
      outcomeSettled = true;
      finish?.(message);
    }
  });
  worker.on("error", (error) => {
    if (!heldSettled) {
      heldSettled = true;
      failHeld?.(error);
    }
    if (!outcomeSettled) {
      outcomeSettled = true;
      failOutcome?.(error);
    }
  });
  worker.on("exit", (code) => {
    if (!heldSettled || !outcomeSettled) {
      const error = new Error(
        `Auth refresh race worker exited with code ${code} before completing its protocol`
      );
      if (!heldSettled) {
        heldSettled = true;
        failHeld?.(error);
      }
      if (!outcomeSettled) {
        outcomeSettled = true;
        failOutcome?.(error);
      }
    } else if (code !== 0) {
      const error = new Error(`Auth refresh race worker exited with code ${code}`);
      failHeld?.(error);
      failOutcome?.(error);
    }
  });
  return { writerHeld, outcome, worker };
}

describe("refresh-token race and expiry boundaries", () => {
  const temporaryDirectories: string[] = [];
  const workers: Worker[] = [];
  const stores: SqliteStore[] = [];
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(workers.splice(0).map(async (worker) => {
      if (worker.threadId !== -1) await worker.terminate();
    }));
    for (const store of stores.splice(0)) store.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns one rotation and one reuse response, then rejects the raced session", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "refresh_race",
        displayName: "Refresh race",
        password: "correct horse battery staple",
        deviceName: "Race device"
      }
    });
    expect(registration.statusCode).toBe(201);
    const original = registration.json();

    const attempts = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refreshToken: original.tokens.refreshToken }
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refreshToken: original.tokens.refreshToken }
      })
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    const winner = attempts.find((response) => response.statusCode === 200);
    const reuse = attempts.find((response) => response.statusCode === 401);
    expect(reuse?.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", message: "Refresh token reuse detected; session revoked" }
    });
    expect(winner).toBeDefined();

    const rejectedWinner = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${winner?.json().tokens.accessToken as string}` }
    });
    expect(rejectedWinner.statusCode).toBe(401);
  });

  it("maps an independent SQLite writer race to strict reuse instead of a 500", async () => {
    const directory = mkdtempSync(join(tmpdir(), "luxora-auth-refresh-race-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    const config = testConfig({ databasePath });
    const store = new SqliteStore(databasePath);
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const raw = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "writer_race",
      usernameNormalized: "writer_race",
      displayName: "Writer race",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Writer race device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: raw.hash,
        createdAt,
        expiresAt
      });
    });
    const terminated: string[] = [];
    const service = new AuthService(
      store,
      security,
      config,
      { terminateSession(id) { terminated.push(id); } },
      () => new Date("2026-08-03T12:01:00.000Z")
    );
    const competitor = startCompetingRotation(databasePath, raw.raw, "2026-08-03T12:00:30.000Z");
    workers.push(competitor.worker);
    await competitor.writerHeld;

    await expect(service.refresh(raw.raw)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "Refresh token reuse detected; session revoked"
    } satisfies Partial<AppError>);
    await expect(competitor.outcome).resolves.toMatchObject({ ok: true });
    expect(terminated).toEqual([sessionId]);
    expect(store.isSessionActive(sessionId, userId, "2026-08-03T12:01:00.000Z")).toBe(false);

    const observer = new Database(databasePath, { readonly: true });
    try {
      const rows = observer.prepare("SELECT token_hash, used_at FROM refresh_tokens ORDER BY created_at")
        .all() as Array<{ token_hash: string; used_at: string | null }>;
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.used_at === null)).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(raw.raw);
      expect(rows.every((row) => !row.token_hash.startsWith("luxr_"))).toBe(true);
    } finally {
      observer.close();
    }
  });

  it("samples expiry time after entering the writer-reserved transaction", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-08-04T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "writer_wait_expiry",
      usernameNormalized: "writer_wait_expiry",
      displayName: "Writer wait expiry",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Writer wait device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    let writerReserved = false;
    const reservedStore = delegatedStore(store, {
      immediateTransaction: <T>(operation: () => T): T => {
        writerReserved = true;
        return store.immediateTransaction(operation);
      }
    });
    const service = new AuthService(
      reservedStore,
      security,
      config,
      undefined,
      () => new Date(writerReserved ? expiresAt : "2026-08-04T11:59:59.999Z")
    );

    await expect(service.refresh(refresh.raw)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "Invalid or expired refresh token"
    } satisfies Partial<AppError>);
    expect(store.findRefreshToken(refresh.hash)?.usedAt).toBeNull();
  });

  it("does not extend a shorter refresh-family expiry to the session expiry", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const tokenExpiresAt = "2026-08-04T12:00:00.000Z";
    const sessionExpiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "family_expiry",
      usernameNormalized: "family_expiry",
      displayName: "Family expiry",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Family expiry device",
        createdAt,
        expiresAt: sessionExpiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt: tokenExpiresAt
      });
    });
    const service = new AuthService(
      store,
      security,
      config,
      undefined,
      () => new Date("2026-08-04T11:59:59.999Z")
    );

    const rotated = await service.refresh(refresh.raw);
    const replacement = store.findRefreshToken(security.hashRefreshToken(rotated.refreshToken));
    expect(replacement?.expiresAt).toBe(tokenExpiresAt);
  });

  it("reconciles a commit-then-error ambiguity by revoking the committed lineage", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "ambiguous_commit",
      usernameNormalized: "ambiguous_commit",
      displayName: "Ambiguous commit",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Ambiguous commit device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    const ambiguousStore = delegatedStore(store, {
      immediateTransaction: <T>(operation: () => T): T => {
        store.immediateTransaction(operation);
        throw Object.assign(new Error("test timeout after commit"), { code: "SQLITE_IOERR" });
      }
    });
    const terminated: string[] = [];
    const service = new AuthService(
      ambiguousStore,
      security,
      config,
      { terminateSession(id) { terminated.push(id); } },
      () => new Date("2026-08-03T12:01:00.000Z")
    );

    await expect(service.refresh(refresh.raw)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "Refresh token reuse detected; session revoked"
    } satisfies Partial<AppError>);
    expect(store.findRefreshToken(refresh.hash)?.usedAt).toBe("2026-08-03T12:01:00.000Z");
    expect(store.isSessionActive(sessionId, userId, "2026-08-03T12:01:00.000Z")).toBe(false);
    expect(terminated).toEqual([sessionId]);
  });

  it("maps uncommitted SQLite writer contention to a retryable safe error", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "writer_busy",
      usernameNormalized: "writer_busy",
      displayName: "Writer busy",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Writer busy device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    const busyStore = delegatedStore(store, {
      immediateTransaction: () => {
        throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
      }
    });
    const service = new AuthService(
      busyStore,
      security,
      config,
      undefined,
      () => new Date("2026-08-03T12:01:00.000Z")
    );

    await expect(service.refresh(refresh.raw)).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Refresh temporarily unavailable"
    } satisfies Partial<AppError>);
    expect(store.findRefreshToken(refresh.hash)?.usedAt).toBeNull();
    expect(store.isSessionActive(sessionId, userId, "2026-08-03T12:01:00.000Z")).toBe(true);
  });

  it("keeps the strict reuse response when transport cleanup throws after durable revoke", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "cleanup_failure",
      usernameNormalized: "cleanup_failure",
      displayName: "Cleanup failure",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Cleanup failure device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    const casLossStore = delegatedStore(store, {
      rotateRefreshToken: () => false
    });
    const service = new AuthService(
      casLossStore,
      security,
      config,
      { terminateSession() { throw new Error("test transport cleanup failure"); } },
      () => new Date("2026-08-03T12:01:00.000Z")
    );

    await expect(service.refresh(refresh.raw)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "Refresh token reuse detected; session revoked"
    } satisfies Partial<AppError>);
    expect(store.findRefreshToken(refresh.hash)?.usedAt).toBeNull();
    expect(store.isSessionActive(sessionId, userId, "2026-08-03T12:01:00.000Z")).toBe(false);
  });

  it("refuses a cross-session replacement at the SQLite CAS boundary", () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const originalSessionId = randomUUID();
    const otherSessionId = randomUUID();
    const original = security.newRefreshToken();
    const other = security.newRefreshToken();
    const replacement = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "cross_session_cas",
      usernameNormalized: "cross_session_cas",
      displayName: "Cross-session CAS",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.createSession({
      id: originalSessionId,
      userId,
      deviceName: "Original session",
      createdAt,
      expiresAt
    }, {
      id: randomUUID(),
      sessionId: originalSessionId,
      tokenHash: original.hash,
      createdAt,
      expiresAt
    });
    store.createSession({
      id: otherSessionId,
      userId,
      deviceName: "Other session",
      createdAt,
      expiresAt
    }, {
      id: randomUUID(),
      sessionId: otherSessionId,
      tokenHash: other.hash,
      createdAt,
      expiresAt
    });
    const usedAt = "2026-08-03T12:01:00.000Z";

    expect(store.rotateRefreshToken(randomUUID(), {
      id: randomUUID(),
      sessionId: otherSessionId,
      tokenHash: replacement.hash,
      createdAt: usedAt,
      expiresAt
    }, usedAt)).toBe(false);
    const originalRecord = store.findRefreshToken(original.hash);
    expect(originalRecord?.usedAt).toBeNull();

    expect(store.rotateRefreshToken(originalRecord?.id as string, {
      id: randomUUID(),
      sessionId: otherSessionId,
      tokenHash: replacement.hash,
      createdAt: usedAt,
      expiresAt
    }, usedAt)).toBe(false);
    expect(store.rotateRefreshToken(originalRecord?.id as string, {
      id: randomUUID(),
      sessionId: originalSessionId,
      tokenHash: replacement.hash,
      createdAt: usedAt,
      expiresAt: usedAt
    }, usedAt)).toBe(false);
    expect(store.findRefreshToken(original.hash)?.usedAt).toBeNull();
    expect(store.findRefreshToken(replacement.hash)).toBeNull();
  });

  it("rolls back standalone consume when replacement insertion fails", () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const originalSessionId = randomUUID();
    const existingSessionId = randomUUID();
    const original = security.newRefreshToken();
    const existing = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "atomic_store_rotation",
      usernameNormalized: "atomic_store_rotation",
      displayName: "Atomic store rotation",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.createSession({
      id: originalSessionId,
      userId,
      deviceName: "Original atomic store device",
      createdAt,
      expiresAt
    }, {
      id: randomUUID(),
      sessionId: originalSessionId,
      tokenHash: original.hash,
      createdAt,
      expiresAt
    });
    store.createSession({
      id: existingSessionId,
      userId,
      deviceName: "Existing atomic store device",
      createdAt,
      expiresAt
    }, {
      id: randomUUID(),
      sessionId: existingSessionId,
      tokenHash: existing.hash,
      createdAt,
      expiresAt
    });
    const originalRecord = store.findRefreshToken(original.hash);
    expect(() => store.rotateRefreshToken(originalRecord?.id as string, {
      id: randomUUID(),
      sessionId: originalSessionId,
      tokenHash: existing.hash,
      createdAt: "2026-08-03T12:01:00.000Z",
      expiresAt
    }, "2026-08-03T12:01:00.000Z")).toThrow(/UNIQUE/);
    expect(store.findRefreshToken(original.hash)?.usedAt).toBeNull();
    expect(store.findRefreshToken(existing.hash)?.sessionId).toBe(existingSessionId);
  });

  it("does not persist a device session when initial access-token signing fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "luxora-auth-signer-failure-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    const config = testConfig({ databasePath });
    const store = new SqliteStore(databasePath);
    stores.push(store);
    const security = new FailingTokenSecurity(config);
    const service = new AuthService(
      store,
      security,
      config,
      undefined,
      () => new Date("2026-08-03T12:00:00.000Z")
    );

    await expect(service.register({
      username: "signer_failure",
      displayName: "Signer failure",
      password: "correct horse battery staple",
      deviceName: "Signer failure device"
    })).rejects.toThrow("test signer unavailable");
    const user = store.findUserByUsername("signer_failure");
    expect(user).not.toBeNull();
    const observer = new Database(databasePath, { readonly: true });
    try {
      const row = observer.prepare("SELECT count(*) AS count FROM device_sessions WHERE user_id = ?")
        .get(user?.id) as { count: number };
      expect(row.count).toBe(0);
    } finally {
      observer.close();
    }
  });

  it("does not consume refresh state when signing fails and permits a safe retry", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new RecoveringTokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "refresh_signer_retry",
      usernameNormalized: "refresh_signer_retry",
      displayName: "Refresh signer retry",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Refresh signer retry device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    const service = new AuthService(
      store,
      security,
      config,
      undefined,
      () => new Date("2026-08-03T12:01:00.000Z")
    );

    await expect(service.refresh(refresh.raw)).rejects.toThrow("test transient signer failure");
    expect(store.findRefreshToken(refresh.hash)?.usedAt).toBeNull();
    expect(store.isSessionActive(sessionId, userId, "2026-08-03T12:01:00.000Z")).toBe(true);

    security.failSigning = false;
    const rotated = await service.refresh(refresh.raw);
    expect(rotated.sessionId).toBe(sessionId);
    expect(store.findRefreshToken(refresh.hash)?.usedAt).toBe("2026-08-03T12:01:00.000Z");
  });

  it.each([
    { now: "2026-08-04T11:59:59.999Z", succeeds: true },
    { now: "2026-08-04T12:00:00.000Z", succeeds: false }
  ])("enforces the exact refresh/session expiry boundary at $now", async ({ now, succeeds }) => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-08-04T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: `expiry_${succeeds ? "before" : "exact"}`,
      usernameNormalized: `expiry_${succeeds ? "before" : "exact"}`,
      displayName: "Expiry boundary",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Expiry device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    const service = new AuthService(store, security, config, undefined, () => new Date(now));

    if (succeeds) {
      const rotated = await service.refresh(refresh.raw);
      expect(rotated.sessionId).toBe(sessionId);
      expect(store.findRefreshToken(refresh.hash)?.usedAt).toBe(now);
    } else {
      await expect(service.refresh(refresh.raw)).rejects.toMatchObject({
        statusCode: 401,
        code: "UNAUTHENTICATED",
        message: "Invalid or expired refresh token"
      } satisfies Partial<AppError>);
      expect(store.findRefreshToken(refresh.hash)?.usedAt).toBeNull();
    }
  });

  it("keeps refresh audit/session timestamps monotonic during a wall-clock rollback", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-09-02T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "clock_rollback",
      usernameNormalized: "clock_rollback",
      displayName: "Clock rollback",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Rollback device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    const instants = [
      new Date("2026-08-03T12:05:00.000Z"),
      new Date("2026-08-03T11:55:00.000Z")
    ];
    let clockIndex = 0;
    const service = new AuthService(
      store,
      security,
      config,
      undefined,
      () => instants[Math.min(clockIndex++, instants.length - 1)] as Date
    );

    const rotated = await service.refresh(refresh.raw);
    const original = store.findRefreshToken(refresh.hash);
    const replacement = store.findRefreshToken(security.hashRefreshToken(rotated.refreshToken));
    expect(original?.usedAt).toBe("2026-08-03T12:05:00.000Z");
    expect(replacement?.createdAt).toBe("2026-08-03T12:05:00.000Z");
    expect(replacement?.session.lastSeenAt).toBe("2026-08-03T12:05:00.000Z");
  });

  it("rechecks expiry after access-token signing and before the rotation commit", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const security = new TokenSecurity(config);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = security.newRefreshToken();
    const createdAt = "2026-08-03T12:00:00.000Z";
    const expiresAt = "2026-08-04T12:00:00.000Z";
    store.createUser({
      id: userId,
      username: "expiry_during_sign",
      usernameNormalized: "expiry_during_sign",
      displayName: "Expiry during sign",
      passwordHash: "test-only-password-hash",
      createdAt
    });
    store.transaction(() => {
      store.createSession({
        id: sessionId,
        userId,
        deviceName: "Expiry signing device",
        createdAt,
        expiresAt
      }, {
        id: randomUUID(),
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt
      });
    });
    const instants = [
      new Date("2026-08-04T11:59:59.999Z"),
      new Date("2026-08-04T12:00:00.000Z")
    ];
    let clockIndex = 0;
    const service = new AuthService(
      store,
      security,
      config,
      undefined,
      () => instants[Math.min(clockIndex++, instants.length - 1)] as Date
    );

    await expect(service.refresh(refresh.raw)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "Invalid or expired refresh token"
    } satisfies Partial<AppError>);
    expect(store.findRefreshToken(refresh.hash)?.usedAt).toBeNull();
  });
});
