import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { RELEASE_LABEL } from "@luxora/protocol";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { Store } from "./domain/store.js";
import { AppError } from "./errors.js";
import { createAuthGuard } from "./http/auth-guard.js";
import { registerPasskeyAuthenticatorManagementRoutes } from "./http/passkey-authenticator-management-routes.js";
import { registerPasskeyLoginRoutes } from "./http/passkey-login-routes.js";
import { registerPasskeyRoutes } from "./http/passkey-routes.js";
import { registerPasskeySignupRoutes } from "./http/passkey-signup-routes.js";
import { registerHttpRoutes } from "./http/routes.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { contentCipherFromConfig } from "./infrastructure/content-cipher.js";
import { SearchHasher } from "./infrastructure/search-hasher.js";
import { createStorageProvider, type StorageProvider } from "./infrastructure/storage.js";
import { Metrics } from "./metrics.js";
import { RealtimeCursorCodec } from "./realtime/cursor.js";
import { RealtimeHub } from "./realtime/hub.js";
import { registerRealtimeRoutes } from "./realtime/routes.js";
import { TokenSecurity } from "./security.js";
import { PasskeyBootstrapRefreshTokenSecurity } from "./passkeys/bootstrap-refresh-token.js";
import { BootstrapTokenSecurity } from "./passkeys/bootstrap-token.js";
import { SimpleWebAuthnVerifierAdapter } from "./passkeys/simplewebauthn-adapter.js";
import { PasskeySignupAuthorizationSecurity } from "./passkeys/signup-authorization-token.js";
import { PasskeySignupRefreshTokenSecurity } from "./passkeys/signup-refresh-token.js";
import {
  DevelopmentPhoneVerificationDeliveryProvider,
  type PhoneVerificationDeliveryProvider
} from "./phone-auth/phone-delivery-provider.js";
import { StepUpTokenSecurity } from "./passkeys/step-up-token.js";
import { StorePasskeyCredentialRepository } from "./passkeys/store-passkey-repository.js";
import { AttachmentService } from "./services/attachment-service.js";
import { AuthService } from "./services/auth-service.js";
import { ChatFolderService } from "./services/chat-folder-service.js";
import { ChatService } from "./services/chat-service.js";
import { IdentityAccessService } from "./services/identity-access-service.js";
import { NotificationService } from "./services/notification-service.js";
import { PasskeyAuthenticatorManagementService } from "./services/passkey-authenticator-management-service.js";
import { PasskeyLoginExpirySweeper } from "./services/passkey-login-expiry-sweeper.js";
import { PasskeyLoginService } from "./services/passkey-login-service.js";
import { PasskeyService } from "./services/passkey-service.js";
import { PasskeySignupExpirySweeper } from "./services/passkey-signup-expiry-sweeper.js";
import { PasskeySignupService } from "./services/passkey-signup-service.js";
import { PhoneAuthService } from "./services/phone-auth-service.js";
import { ProfileAvatarService } from "./services/profile-avatar-service.js";
import { SearchService } from "./services/search-service.js";
import { RealtimeOutboxPublisher } from "./services/realtime-outbox-publisher.js";
import { UploadService } from "./services/upload-service.js";
import { clientIpBucketKey } from "./client-ip.js";

export interface BuildAppOptions {
  config?: AppConfig;
  store?: Store;
  logger?: boolean;
  logStream?: { write(message: string): void };
  phoneDeliveryProvider?: PhoneVerificationDeliveryProvider;
}

export interface LuxoraApp extends FastifyInstance {
  luxora: {
    config: AppConfig;
    store: Store;
    metrics: Metrics;
    hub: RealtimeHub;
    outbox: RealtimeOutboxPublisher;
    storage: StorageProvider;
    uploads: UploadService;
  };
}

function validationIssues(error: unknown): unknown[] | null {
  if (error instanceof ZodError) return error.issues;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues;
  }
  return null;
}

function querySafeRequestPath(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl.length === 0) return "/";
  const queryStart = rawUrl.indexOf("?");
  const fragmentStart = rawUrl.indexOf("#");
  const boundaries = [queryStart, fragmentStart].filter((index) => index >= 0);
  const end = boundaries.length === 0 ? rawUrl.length : Math.min(...boundaries);
  const withoutQuery = rawUrl.slice(0, end);
  if (withoutQuery.startsWith("http://") || withoutQuery.startsWith("https://")) {
    try {
      return new URL(withoutQuery).pathname;
    } catch {
      return "/";
    }
  }
  return withoutQuery || "/";
}

function querySafeRequestRoute(request: {
  readonly routeOptions?: { readonly url?: string | undefined };
}): string {
  const routeTemplate = request.routeOptions?.url;
  if (typeof routeTemplate !== "string" || routeTemplate.length === 0) {
    return "<unmatched>";
  }
  // Fastify's matched route template contains placeholders such as `:id`, not
  // the concrete account/chat/message/upload identifiers supplied by a client.
  return querySafeRequestPath(routeTemplate);
}

function rebuildSearchIndexes(store: Store, hasher: SearchHasher): number {
  const keyId = hasher.keyId;
  if (keyId === undefined || store.getSearchIndexKeyId() === keyId) return 0;
  const batchSize = 500;
  let indexed = 0;
  let afterMessageId: string | undefined;
  while (true) {
    const batch = store.listMessagesForSearchIndex(afterMessageId, batchSize);
    if (batch.length === 0) break;
    store.transaction(() => {
      for (const message of batch) {
        store.replaceMessageSearchTokens(
          message.id,
          message.body === null ? [] : hasher.index(message.body)
        );
      }
    });
    indexed += batch.length;
    afterMessageId = batch.at(-1)?.id;
    if (batch.length < batchSize) break;
  }
  let afterAttachmentId: string | undefined;
  while (true) {
    const batch = store.listAttachmentsForSearchIndex(afterAttachmentId, batchSize);
    if (batch.length === 0) break;
    store.transaction(() => {
      for (const attachment of batch) {
        store.replaceAttachmentSearchTokens(attachment.id, hasher.index(attachment.fileName));
      }
    });
    indexed += batch.length;
    afterAttachmentId = batch.at(-1)?.id;
    if (batch.length < batchSize) break;
  }
  store.setSearchIndexKeyId(keyId, new Date().toISOString());
  return indexed;
}

async function purgeExpiredPasskeySecrets(store: Store, nowMs = Date.now()): Promise<number> {
  const batchSize = 1_000;
  const maximumBatches = 10;
  let purged = 0;
  for (let batch = 0; batch < maximumBatches; batch += 1) {
    const count = await store.purgeExpiredPasskeyChallengeSecrets(nowMs, batchSize);
    purged += count;
    if (count < batchSize) break;
  }
  return purged;
}

function purgeExpiredChatFolderReceipts(
  store: Store,
  at = new Date().toISOString()
): number {
  const batchSize = 1_000;
  const maximumBatches = 10;
  let purged = 0;
  for (let batch = 0; batch < maximumBatches; batch += 1) {
    const count = store.purgeExpiredChatFolderCommandReceipts(at, batchSize);
    purged += count;
    if (count < batchSize) break;
  }
  return purged;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<LuxoraApp> {
  const config = options.config ?? loadConfig();
  // Callers may inject an already-materialized AppConfig and bypass
  // loadConfig(). Reassert security gates at the composition boundary before
  // Fastify, storage, or any route is created.
  if (config.nodeEnv === "production" && config.passkeyInternalRoutesEnabled) {
    throw new Error("PASSKEY_INTERNAL_ROUTES_ENABLED cannot be enabled in production");
  }
  if (config.nodeEnv === "production" && config.passkeyInternalSignupRoutesEnabled) {
    throw new Error("PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED cannot be enabled in production");
  }
  if (
    config.nodeEnv !== "test"
    && (
      config.activeDataEncryptionKeyId === undefined
      || config.dataEncryptionKeys[config.activeDataEncryptionKeyId] === undefined
    )
  ) {
    throw new Error(
      "Luxora API requires an active data-encryption key outside tests"
    );
  }
  if (config.phoneAuthEnabled) {
    if (config.phoneAuthProvider === "disabled" || config.phoneAuthHmacSecret === undefined) {
      throw new Error("Enabled phone authentication requires its provider and HMAC secret");
    }
    if (Buffer.byteLength(config.phoneAuthHmacSecret, "utf8") < 32) {
      throw new Error("Phone authentication HMAC secret must contain at least 32 bytes");
    }
    const activePhoneDataKeyId = config.activeDataEncryptionKeyId;
    if (
      activePhoneDataKeyId === undefined
      || config.dataEncryptionKeys[activePhoneDataKeyId] === undefined
    ) {
      throw new Error("Phone authentication requires an active data-encryption key");
    }
    if (
      config.phoneAuthHmacSecret === config.jwtSecret
      || Object.values(config.dataEncryptionKeys).includes(config.phoneAuthHmacSecret)
    ) throw new Error("Phone authentication requires independent HMAC key material");
    if (config.phoneAuthProvider === "development") {
      if (config.nodeEnv === "production") {
        throw new Error("Development phone delivery cannot be enabled in production");
      }
      if (config.phoneAuthDevelopmentCode === undefined) {
        throw new Error("Development phone delivery requires a fixed verification code");
      }
      if (!/^[0-9]{6}$/u.test(config.phoneAuthDevelopmentCode)) {
        throw new Error("Development phone verification code must contain exactly six digits");
      }
    }
    if (config.phoneAuthProvider === "external" && config.phoneAuthDevelopmentCode !== undefined) {
      throw new Error("Development phone verification code is forbidden for an external provider");
    }
    if (config.phoneAuthProvider === "external" && options.phoneDeliveryProvider === undefined) {
      throw new Error("External phone delivery provider implementation is required");
    }
  } else if (
    config.phoneAuthProvider !== "disabled"
    || config.phoneAuthHmacSecret !== undefined
    || config.phoneAuthDevelopmentCode !== undefined
    || options.phoneDeliveryProvider !== undefined
  ) {
    throw new Error("Phone authentication configuration requires phoneAuthEnabled=true");
  }
  const passkeyRefreshKeys = config.passkeyBootstrapRefreshKeys;
  const activePasskeyRefreshKeyId = config.activePasskeyBootstrapRefreshKeyId;
  const hasPasskeyRefreshKeys = passkeyRefreshKeys !== undefined;
  const hasActivePasskeyRefreshKey = activePasskeyRefreshKeyId !== undefined;
  if (hasPasskeyRefreshKeys !== hasActivePasskeyRefreshKey) {
    throw new Error(
      "PASSKEY_BOOTSTRAP_REFRESH_KEYS and ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID must be configured together"
    );
  }
  let passkeyRefreshTokens: PasskeyBootstrapRefreshTokenSecurity | undefined;
  if (
    config.passkeyInternalRoutesEnabled
    && passkeyRefreshKeys !== undefined
    && activePasskeyRefreshKeyId !== undefined
  ) {
    const activeDataKeyId = config.activeDataEncryptionKeyId;
    if (
      activeDataKeyId === undefined
      || config.dataEncryptionKeys[activeDataKeyId] === undefined
    ) {
      throw new Error("Passkey login requires an active data-encryption key");
    }
    if (config.accessTokenTtlSeconds < 601) {
      throw new Error("Passkey login access-token TTL must be at least 601 seconds");
    }
    passkeyRefreshTokens = new PasskeyBootstrapRefreshTokenSecurity(
      passkeyRefreshKeys,
      activePasskeyRefreshKeyId
    );
  }
  const passkeySignupAuthorizationSecret = config.passkeySignupAuthorizationSecret;
  const passkeySignupRefreshKeys = config.passkeySignupRefreshKeys;
  const activePasskeySignupRefreshKeyId = config.activePasskeySignupRefreshKeyId;
  const hasPasskeySignupAuthorization = passkeySignupAuthorizationSecret !== undefined;
  const hasPasskeySignupRefreshKeys = passkeySignupRefreshKeys !== undefined;
  const hasActivePasskeySignupRefreshKey = activePasskeySignupRefreshKeyId !== undefined;
  if (
    hasPasskeySignupAuthorization !== hasPasskeySignupRefreshKeys
    || hasPasskeySignupRefreshKeys !== hasActivePasskeySignupRefreshKey
  ) {
    throw new Error(
      "PASSKEY_SIGNUP_AUTHORIZATION_SECRET, PASSKEY_SIGNUP_REFRESH_KEYS and ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID must be configured together"
    );
  }
  const signupRefreshMaterials = Object.values(passkeySignupRefreshKeys ?? {});
  const bootstrapRefreshMaterials = Object.values(passkeyRefreshKeys ?? {});
  const dataEncryptionMaterials = Object.values(config.dataEncryptionKeys);
  if (
    config.phoneAuthHmacSecret !== undefined
    && [
      passkeySignupAuthorizationSecret,
      ...signupRefreshMaterials,
      ...bootstrapRefreshMaterials
    ].includes(config.phoneAuthHmacSecret)
  ) {
    throw new Error("Phone authentication requires independent HMAC key material");
  }
  const signupAuthorizationPeers = [
    config.jwtSecret,
    ...signupRefreshMaterials,
    ...bootstrapRefreshMaterials,
    ...dataEncryptionMaterials
  ];
  if (
    (passkeySignupAuthorizationSecret !== undefined
      && signupAuthorizationPeers.includes(passkeySignupAuthorizationSecret))
    || new Set(signupRefreshMaterials).size !== signupRefreshMaterials.length
    || signupRefreshMaterials.some((key) =>
      key === config.jwtSecret
      || bootstrapRefreshMaterials.includes(key)
      || dataEncryptionMaterials.includes(key))
  ) {
    throw new Error("Passkey signup secrets must use independent key material");
  }
  let passkeySignupAuthorizations: PasskeySignupAuthorizationSecurity | undefined;
  let passkeySignupRefreshTokens: PasskeySignupRefreshTokenSecurity | undefined;
  if (config.passkeyInternalSignupRoutesEnabled) {
    if (
      passkeySignupAuthorizationSecret === undefined
      || passkeySignupRefreshKeys === undefined
      || activePasskeySignupRefreshKeyId === undefined
    ) {
      throw new Error(
        "PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED requires the complete signup key set"
      );
    }
    const activeDataKeyId = config.activeDataEncryptionKeyId;
    if (
      activeDataKeyId === undefined
      || config.dataEncryptionKeys[activeDataKeyId] === undefined
    ) {
      throw new Error("Passkey signup requires an active data-encryption key");
    }
    if (config.accessTokenTtlSeconds < 601) {
      throw new Error("Passkey signup access-token TTL must be at least 601 seconds");
    }
    passkeySignupAuthorizations = new PasskeySignupAuthorizationSecurity(
      passkeySignupAuthorizationSecret
    );
    passkeySignupRefreshTokens = new PasskeySignupRefreshTokenSecurity(
      passkeySignupRefreshKeys,
      activePasskeySignupRefreshKeyId
    );
  }
  const loggerEnabled = options.logger ?? config.nodeEnv !== "test";
  const app = Fastify({
    logger: loggerEnabled
      ? {
          level: config.nodeEnv === "production" ? "info" : "debug",
          ...(options.logStream === undefined ? {} : { stream: options.logStream }),
          serializers: {
            req(request) {
              return {
                method: request.method,
                path: querySafeRequestRoute(request)
              };
            }
          },
          redact: {
            paths: [
              "req.headers.authorization",
              "request.headers.authorization",
              "req.headers['step-up-authorization']",
              "request.headers['step-up-authorization']",
              "headers['step-up-authorization']",
              "req.headers['bootstrap-authorization']",
              "request.headers['bootstrap-authorization']",
              "headers['bootstrap-authorization']",
              "body.password",
              "body.refreshToken",
              "body.stepUpToken",
              "body.code",
              "body.registrationToken",
              "accessToken",
              "refreshToken",
              "stepUpToken"
            ],
            censor: "[REDACTED]"
          }
        }
      : false,
    trustProxy: config.trustedProxyCidrs.length === 0 ? false : [...config.trustedProxyCidrs],
    bodyLimit: 1_048_576,
    // Correlation IDs are server-generated. Accepting an arbitrary client value
    // would turn reqId itself into attacker-controlled log content/linkability.
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID()
  }) as unknown as LuxoraApp;

  const store = options.store ?? new SqliteStore(
    config.databasePath,
    contentCipherFromConfig(config.dataEncryptionKeys, config.activeDataEncryptionKeyId),
    Date.now,
    config.syncInvalidationEnabled
  );
  const passkeyLoginExpiry = new PasskeyLoginExpirySweeper(store, {
    batchSize: 100,
    maxBatchesPerSweep: 10
  });
  const passkeySignupExpiry = new PasskeySignupExpirySweeper(store, {
    batchSize: 100,
    maxBatchesPerSweep: 10
  });
  const metrics = new Metrics();
  const security = new TokenSecurity(config);
  const cursors = new RealtimeCursorCodec(config.jwtSecret);
  const hub = new RealtimeHub(store, metrics, cursors, config.syncInvalidationEnabled);
  const outbox = new RealtimeOutboxPublisher(store, hub, {
    shouldPublish: (event) => config.syncInvalidationEnabled
      || event.event.type !== "sync.invalidated",
    onFailure: ({ stage, eventSequence, error }) => {
      app.log.warn({ err: error, stage, eventSequence }, "Realtime outbox delivery attempt failed");
    }
  });
  const auth = new AuthService(store, security, config, hub, undefined, outbox);
  const phoneDelivery = options.phoneDeliveryProvider
    ?? (config.phoneAuthProvider === "development"
      ? new DevelopmentPhoneVerificationDeliveryProvider()
      : null);
  const phoneAuth = new PhoneAuthService(store, security, config, phoneDelivery);
  const searchHasher = new SearchHasher(config.dataEncryptionKeys, config.activeDataEncryptionKeyId);
  const reindexedItems = rebuildSearchIndexes(store, searchHasher);
  if (reindexedItems > 0) app.log.info({ indexedItems: reindexedItems }, "Search indexes rebuilt");
  const storage = await createStorageProvider(config);
  const chats = new ChatService(store, outbox, searchHasher);
  const chatFolders = new ChatFolderService(store, outbox);
  const identity = new IdentityAccessService(store, outbox, searchHasher);
  const notifications = new NotificationService(store);
  const uploads = await UploadService.create(store, storage, searchHasher, outbox, config);
  const attachments = new AttachmentService(store, storage);
  const profileAvatars = new ProfileAvatarService(
    store,
    storage,
    config.userStorageQuotaBytes,
    undefined,
    outbox,
    config.syncInvalidationEnabled
  );
  const search = new SearchService(store, searchHasher);
  const authGuard = createAuthGuard(security, store);
  app.luxora = { config, store, metrics, hub, outbox, storage, uploads };

  app.addContentTypeParser("application/octet-stream", {
    parseAs: "buffer",
    bodyLimit: config.uploadChunkSizeBytes
  }, (_request, body, done) => {
    done(null, body);
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" }
  });
  await app.register(cors, {
    credentials: false,
    origin(origin, callback) {
      if (origin === undefined || config.corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    }
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => clientIpBucketKey(request.ip)
  });
  await app.register(websocket, {
    options: { maxPayload: 65_536, perMessageDeflate: false }
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Luxora API",
        description: "HTTP commands, synchronized resources, and realtime gateway for Luxora.",
        version: RELEASE_LABEL,
        contact: { name: "Flenym" }
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
        }
      },
      tags: [
        { name: "auth", description: "Authentication and device sessions" },
        { name: "identity", description: "Privacy, discovery, relationships, and blocks" },
        { name: "safety", description: "Private abuse-report submission" },
        { name: "chats", description: "Chats, messages, receipts, and reactions" },
        { name: "realtime", description: "Authenticated WebSocket event stream" },
        { name: "operations", description: "Health and telemetry" }
      ]
    }
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
    staticCSP: true
  });

  app.addHook("onResponse", async (request, reply) => {
    metrics.recordRequest(
      request.method,
      request.routeOptions.url ?? "unmatched",
      reply.statusCode
    );
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const isPublicCapabilitiesRoute = request.method === "GET" && request.routeOptions.url === "/v1/capabilities";
    if (isPublicCapabilitiesRoute) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    } else if (
      (!isPublicCapabilitiesRoute && request.url.startsWith("/v1/")) ||
      request.url.startsWith("/v2/sync/")
    ) {
      reply.header("cache-control", "private, no-store");
      reply.header("pragma", "no-cache");
    }
    return payload;
  });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: request.id
      }
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const issues = validationIssues(error);
    if (issues !== null) {
      metrics.recordError("VALIDATION_FAILED");
      return reply.code(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed",
          requestId: request.id,
          details: { issues }
        }
      });
    }
    if (error instanceof AppError) {
      metrics.recordError(error.code);
      if (
        error.statusCode === 429
        && typeof error.details?.["retryAfterSeconds"] === "number"
      ) {
        reply.header("retry-after", String(error.details["retryAfterSeconds"]));
      }
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      });
    }
    const frameworkStatus = (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
    ) ? error.statusCode : undefined;
    if (frameworkStatus === 429) {
      metrics.recordError("RATE_LIMITED");
      return reply.code(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          requestId: request.id
        }
      });
    }
    if (frameworkStatus !== undefined && frameworkStatus >= 400 && frameworkStatus < 500) {
      metrics.recordError("BAD_REQUEST");
      const message = frameworkStatus === 413
        ? "Request payload is too large"
        : frameworkStatus === 415
          ? "Unsupported media type"
          : "Malformed request";
      return reply.code(frameworkStatus).send({
        error: {
          code: "BAD_REQUEST",
          message,
          requestId: request.id
        }
      });
    }
    metrics.recordError("INTERNAL_ERROR");
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId: request.id
      }
    });
  });

  registerHttpRoutes(app, {
    config,
    store,
    auth,
    phoneAuth,
    profileAvatars,
    chats,
    chatFolders,
    uploads,
    attachments,
    identity,
    notifications,
    search,
    storage,
    metrics,
    serverSearchConfigured: searchHasher.available,
    authGuard
  });
  if (config.passkeyInternalRoutesEnabled || config.passkeyInternalSignupRoutesEnabled) {
    const passkeyRepository = new StorePasskeyCredentialRepository(store);
    const passkeyAdapter = new SimpleWebAuthnVerifierAdapter(passkeyRepository);
    if (config.passkeyInternalRoutesEnabled) {
      // This is deliberately a non-production integration seam. Public
      // capabilities remain false until recovery and the remaining independent
      // production gates have passed.
      const stepUpTokens = new StepUpTokenSecurity(config.jwtSecret);
      const passkeys = new PasskeyService(store, {
        adapter: passkeyAdapter,
        stepUpTokens
      });
      registerPasskeyRoutes(app, { service: passkeys, authGuard });
      const authenticatorManagement = new PasskeyAuthenticatorManagementService({
        store,
        stepUpTokens,
        onSessionsRevoked: (sessionIds) => {
          for (const sessionId of sessionIds) hub.terminateSession(sessionId);
        },
        onSessionRevocationCleanupFailure: (error, sessionIds) => {
          app.log.error(
            { err: error, revokedSessionCount: sessionIds.length },
            "Revoked authenticator session cleanup failed"
          );
        }
      });
      registerPasskeyAuthenticatorManagementRoutes(app, {
        ceremonies: passkeys,
        management: authenticatorManagement,
        authGuard
      });
      if (passkeyRefreshTokens !== undefined) {
        const login = new PasskeyLoginService({
          store,
          adapter: passkeyAdapter,
          bootstrapTokens: new BootstrapTokenSecurity(config.jwtSecret),
          refreshTokens: passkeyRefreshTokens,
          accessTokens: security,
          policy: {
            accessTokenTtlSeconds: config.accessTokenTtlSeconds,
            sessionTtlSeconds: config.refreshTokenTtlDays * 86_400,
            recoveryGraceSeconds: 300
          }
        });
        registerPasskeyLoginRoutes(app, { service: login });
      }
    }
    if (
      config.passkeyInternalSignupRoutesEnabled
      && passkeySignupAuthorizations !== undefined
      && passkeySignupRefreshTokens !== undefined
    ) {
      const signup = new PasskeySignupService({
        store,
        adapter: passkeyAdapter,
        authorizations: passkeySignupAuthorizations,
        refreshTokens: passkeySignupRefreshTokens,
        accessTokens: security,
        policy: {
          accessTokenTtlSeconds: config.accessTokenTtlSeconds,
          sessionTtlSeconds: config.refreshTokenTtlDays * 86_400,
          recoveryGraceSeconds: 300
        }
      });
      registerPasskeySignupRoutes(app, { service: signup });
    }
  }
  app.get("/openapi.json", async () => app.swagger());
  registerRealtimeRoutes(app, {
    store,
    security,
    chats,
    hub,
    cursors,
    allowedOrigins: config.corsOrigins
  });

  let cleanupTimer: NodeJS.Timeout | undefined;
  app.addHook("onClose", async () => {
    if (cleanupTimer !== undefined) clearInterval(cleanupTimer);
    cleanupTimer = undefined;
    outbox.close();
    hub.closeAll();
    await uploads.close();
    await storage.close();
    store.close();
  });
  await app.ready();
  outbox.start();
  try {
    const result = await uploads.cleanup();
    if (result.cleanupFailures > 0) {
      app.log.warn(result, "Upload cleanup completed with retryable failures");
    } else if (result.expiredUploads > 0 || result.orphanAttachments > 0) {
      app.log.info(result, "Upload cleanup completed");
    }
  } catch (error) {
    app.log.error({ err: error }, "Initial upload cleanup failed");
  }
  try {
    const result = await passkeyLoginExpiry.sweep();
    if (result.expired > 0 || result.skipped > 0) {
      app.log.info(result, "Expired passkey login intents reconciled");
    }
  } catch (error) {
    app.log.error({ err: error }, "Initial passkey login expiry sweep failed");
  }
  try {
    const result = await passkeySignupExpiry.sweep();
    if (result.expired > 0 || result.reconciled > 0 || result.skipped > 0) {
      app.log.info(result, "Expired passkey signup intents reconciled");
    }
  } catch (error) {
    app.log.error({ err: error }, "Initial passkey signup expiry sweep failed");
  }
  try {
    const purgedPasskeySecrets = await purgeExpiredPasskeySecrets(store);
    if (purgedPasskeySecrets > 0) {
      app.log.info({ purgedPasskeySecrets }, "Expired passkey challenge secrets purged");
    }
  } catch (error) {
    app.log.error({ err: error }, "Initial passkey challenge cleanup failed");
  }
  try {
    const purgedChatFolderReceipts = purgeExpiredChatFolderReceipts(store);
    if (purgedChatFolderReceipts > 0) {
      app.log.info({ purgedChatFolderReceipts }, "Expired chat-folder receipts purged");
    }
  } catch (error) {
    app.log.error({ err: error }, "Initial chat-folder receipt cleanup failed");
  }
  cleanupTimer = setInterval(() => {
    void uploads.cleanup().then((result) => {
      if (result.cleanupFailures > 0) {
        app.log.warn(result, "Upload cleanup completed with retryable failures");
      } else if (result.expiredUploads > 0 || result.orphanAttachments > 0) {
        app.log.info(result, "Upload cleanup completed");
      }
    }).catch((error: unknown) => {
      app.log.error({ err: error }, "Periodic upload cleanup failed");
    });
    void passkeyLoginExpiry.sweep().then((result) => {
      if (result.expired > 0 || result.skipped > 0) {
        app.log.info(result, "Expired passkey login intents reconciled");
      }
    }).catch((error: unknown) => {
      app.log.error({ err: error }, "Periodic passkey login expiry sweep failed");
    });
    void passkeySignupExpiry.sweep().then((result) => {
      if (result.expired > 0 || result.reconciled > 0 || result.skipped > 0) {
        app.log.info(result, "Expired passkey signup intents reconciled");
      }
    }).catch((error: unknown) => {
      app.log.error({ err: error }, "Periodic passkey signup expiry sweep failed");
    });
    void purgeExpiredPasskeySecrets(store).then((purgedPasskeySecrets) => {
      if (purgedPasskeySecrets > 0) {
        app.log.info({ purgedPasskeySecrets }, "Expired passkey challenge secrets purged");
      }
    }).catch((error: unknown) => {
      app.log.error({ err: error }, "Periodic passkey challenge cleanup failed");
    });
    try {
      const purgedChatFolderReceipts = purgeExpiredChatFolderReceipts(store);
      if (purgedChatFolderReceipts > 0) {
        app.log.info({ purgedChatFolderReceipts }, "Expired chat-folder receipts purged");
      }
    } catch (error) {
      app.log.error({ err: error }, "Periodic chat-folder receipt cleanup failed");
    }
  }, 10 * 60_000);
  cleanupTimer.unref();
  return app;
}
