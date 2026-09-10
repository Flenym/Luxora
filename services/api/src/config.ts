import { z } from "zod";
import { parseTrustedProxyCidrs } from "./client-ip.js";

const booleanFromString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes"].includes(value.toLowerCase());
}, z.boolean());

const strictFeatureFlag = z.enum(["0", "1", "false", "true"])
  .default("false")
  .transform((value) => value === "1" || value === "true");

const strictDefaultOnFeatureFlag = z.enum(["0", "1", "false", "true"])
  .default("true")
  .transform((value) => value === "1" || value === "true");

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATABASE_PATH: z.string().min(1).default("./data/luxora.db"),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:5173"),
  TRUST_PROXY: z.enum(["0", "1", "false", "true"]).optional(),
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  METRICS_TOKEN: z.string().min(20).optional(),
  DATA_ENCRYPTION_KEYS: z.string().optional(),
  ACTIVE_DATA_ENCRYPTION_KEY_ID: z.string().min(1).max(64).optional(),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_PATH: z.string().min(1).default("./data/blobs"),
  UPLOAD_STAGING_PATH: z.string().min(1).default("./data/uploads"),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(1_048_576).max(5_368_709_120).default(104_857_600),
  USER_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(1_073_741_824),
  UPLOAD_CHUNK_SIZE_BYTES: z.coerce.number().int().min(262_144).max(4_194_304).default(1_048_576),
  UPLOAD_SESSION_TTL_MINUTES: z.coerce.number().int().min(10).max(1440).default(60),
  ORPHAN_ATTACHMENT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  S3_BUCKET: z.string().min(3).optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: booleanFromString.default(false),
  S3_SERVER_SIDE_ENCRYPTION: z.enum(["AES256", "aws:kms"]).default("AES256"),
  S3_KMS_KEY_ID: z.string().min(1).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PASSKEY_BOOTSTRAP_REFRESH_KEYS: z.string().optional(),
  ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID: z.string().min(1).max(64).optional(),
  PASSKEY_INTERNAL_ROUTES_ENABLED: strictFeatureFlag,
  PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED: strictFeatureFlag,
  PASSKEY_SIGNUP_AUTHORIZATION_SECRET: z.string().optional(),
  PASSKEY_SIGNUP_REFRESH_KEYS: z.string().optional(),
  ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: z.string().min(1).max(64).optional(),
  PHONE_AUTH_ENABLED: strictFeatureFlag,
  PHONE_AUTH_PROVIDER: z.enum(["disabled", "development", "external"]).default("disabled"),
  PHONE_AUTH_HMAC_SECRET: z.string().min(32).optional(),
  PHONE_AUTH_DEVELOPMENT_CODE: z.string().regex(/^[0-9]{6}$/u).optional(),
  PHONE_AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(120).max(600).default(300),
  PHONE_AUTH_REGISTRATION_TTL_SECONDS: z.coerce.number().int().min(300).max(1_800).default(600),
  PHONE_AUTH_RETRY_AFTER_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
  PHONE_AUTH_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  PHONE_AUTH_RECOVERY_DELAY_SECONDS: z.coerce.number().int().min(0).max(604_800).default(300),
  PHONE_AUTH_RECOVERY_TTL_SECONDS: z.coerce.number().int().min(600).max(1_209_600).default(86_400),
  SYNC_INVALIDATION_ENABLED: strictDefaultOnFeatureFlag
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databasePath: string;
  jwtSecret: string;
  corsOrigins: string[];
  trustedProxyCidrs: readonly string[];
  metricsToken?: string;
  dataEncryptionKeys: Record<string, string>;
  activeDataEncryptionKeyId?: string;
  storageDriver: "local" | "s3";
  storageLocalPath: string;
  uploadStagingPath: string;
  maxAttachmentBytes: number;
  userStorageQuotaBytes: number;
  uploadChunkSizeBytes: number;
  uploadSessionTtlMinutes: number;
  orphanAttachmentTtlHours: number;
  s3?: {
    bucket: string;
    region: string;
    endpoint?: string;
    forcePathStyle: boolean;
    serverSideEncryption: "AES256" | "aws:kms";
    kmsKeyId?: string;
  };
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  /** Dedicated rotation keyring for deterministic first-login refresh recovery. */
  passkeyBootstrapRefreshKeys?: Record<string, string>;
  activePasskeyBootstrapRefreshKeyId?: string;
  /** Dedicated pre-account authorization root; never shared with JWT signing. */
  passkeySignupAuthorizationSecret?: string;
  /** Signup-only rotated roots for deterministic initial-refresh recovery. */
  passkeySignupRefreshKeys?: Record<string, string>;
  activePasskeySignupRefreshKeyId?: string;
  /**
   * Development/test integration seam only. It does not advertise the public
   * passkey capability and production configuration is forbidden from enabling it.
   */
  passkeyInternalRoutesEnabled: boolean;
  /** Separate development/test-only composition gate for pre-account signup. */
  passkeyInternalSignupRoutesEnabled: boolean;
  phoneAuthEnabled: boolean;
  phoneAuthProvider: "disabled" | "development" | "external";
  phoneAuthHmacSecret?: string;
  phoneAuthDevelopmentCode?: string;
  phoneAuthChallengeTtlSeconds: number;
  phoneAuthRegistrationTtlSeconds: number;
  phoneAuthRetryAfterSeconds: number;
  phoneAuthMaxAttempts: number;
  /** Deliberate confirmation window between recovery start and completion. */
  phoneAuthRecoveryDelaySeconds: number;
  /** Bounded completion window measured from confirmAt. */
  phoneAuthRecoveryTtlSeconds: number;
  /** Emergency rollback seam; false suppresses only sync.invalidated emission and delivery. */
  syncInvalidationEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const source = { ...env };
  if (source["NODE_ENV"] === "test" && source["JWT_SECRET"] === undefined) {
    source["JWT_SECRET"] = "test-only-secret-with-at-least-thirty-two-bytes";
  }

  const parsed = ConfigSchema.parse(source);
  if (parsed.TRUST_PROXY === "1" || parsed.TRUST_PROXY === "true") {
    throw new Error("TRUST_PROXY=true is forbidden; configure explicit TRUSTED_PROXY_CIDRS");
  }
  const trustedProxyCidrs = parseTrustedProxyCidrs(parsed.TRUSTED_PROXY_CIDRS);
  if (parsed.NODE_ENV === "production" && parsed.CORS_ORIGINS.split(",").includes("*")) {
    throw new Error("CORS_ORIGINS cannot contain '*' in production");
  }
  if (parsed.NODE_ENV === "production" && parsed.PASSKEY_INTERNAL_ROUTES_ENABLED) {
    throw new Error("PASSKEY_INTERNAL_ROUTES_ENABLED cannot be enabled in production");
  }
  if (parsed.NODE_ENV === "production" && parsed.PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED) {
    throw new Error("PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED cannot be enabled in production");
  }
  let dataEncryptionKeys: Record<string, string> = {};
  if (parsed.DATA_ENCRYPTION_KEYS !== undefined) {
    let untrusted: unknown;
    try {
      untrusted = JSON.parse(parsed.DATA_ENCRYPTION_KEYS) as unknown;
    } catch {
      throw new Error("DATA_ENCRYPTION_KEYS must be a JSON object");
    }
    if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) {
      throw new Error("DATA_ENCRYPTION_KEYS must be a JSON object");
    }
    for (const [keyId, encodedKey] of Object.entries(untrusted)) {
      if (
        keyId.length === 0 ||
        Buffer.byteLength(keyId, "utf8") > 64 ||
        typeof encodedKey !== "string"
      ) {
        throw new Error("DATA_ENCRYPTION_KEYS contains an invalid entry");
      }
      const decoded = Buffer.from(encodedKey, "base64url");
      if (decoded.length !== 32 || decoded.toString("base64url") !== encodedKey) {
        throw new Error(`Data encryption key '${keyId}' must be exactly 32 bytes encoded as base64url`);
      }
      dataEncryptionKeys[keyId] = encodedKey;
    }
  }
  if (
    parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID !== undefined &&
    dataEncryptionKeys[parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID] === undefined
  ) {
    throw new Error("ACTIVE_DATA_ENCRYPTION_KEY_ID is not present in DATA_ENCRYPTION_KEYS");
  }
  if (
    parsed.NODE_ENV !== "test" &&
    (parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID === undefined || Object.keys(dataEncryptionKeys).length === 0)
  ) {
    throw new Error(
      "Luxora API requires DATA_ENCRYPTION_KEYS and ACTIVE_DATA_ENCRYPTION_KEY_ID outside tests"
    );
  }
  let passkeyBootstrapRefreshKeys: Record<string, string> | undefined;
  if (parsed.PASSKEY_BOOTSTRAP_REFRESH_KEYS !== undefined) {
    let untrusted: unknown;
    try {
      untrusted = JSON.parse(parsed.PASSKEY_BOOTSTRAP_REFRESH_KEYS) as unknown;
    } catch {
      throw new Error("PASSKEY_BOOTSTRAP_REFRESH_KEYS must be a JSON object");
    }
    if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) {
      throw new Error("PASSKEY_BOOTSTRAP_REFRESH_KEYS must be a JSON object");
    }
    passkeyBootstrapRefreshKeys = {};
    for (const [keyId, encodedKey] of Object.entries(untrusted)) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyId)
        || typeof encodedKey !== "string"
      ) {
        throw new Error("PASSKEY_BOOTSTRAP_REFRESH_KEYS contains an invalid entry");
      }
      const decoded = Buffer.from(encodedKey, "base64url");
      if (decoded.length !== 32 || decoded.toString("base64url") !== encodedKey) {
        throw new Error(`Passkey bootstrap refresh key '${keyId}' must be exactly 32 bytes encoded as base64url`);
      }
      passkeyBootstrapRefreshKeys[keyId] = encodedKey;
    }
    if (Object.keys(passkeyBootstrapRefreshKeys).length === 0) {
      throw new Error("PASSKEY_BOOTSTRAP_REFRESH_KEYS cannot be empty");
    }
  }
  if (
    (passkeyBootstrapRefreshKeys === undefined)
      !== (parsed.ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID === undefined)
    || (parsed.ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID !== undefined
      && passkeyBootstrapRefreshKeys?.[parsed.ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID] === undefined)
  ) {
    throw new Error(
      "PASSKEY_BOOTSTRAP_REFRESH_KEYS and ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID must identify one active key"
    );
  }
  let passkeySignupRefreshKeys: Record<string, string> | undefined;
  if (parsed.PASSKEY_SIGNUP_REFRESH_KEYS !== undefined) {
    let untrusted: unknown;
    try {
      untrusted = JSON.parse(parsed.PASSKEY_SIGNUP_REFRESH_KEYS) as unknown;
    } catch {
      throw new Error("PASSKEY_SIGNUP_REFRESH_KEYS must be a JSON object");
    }
    if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) {
      throw new Error("PASSKEY_SIGNUP_REFRESH_KEYS must be a JSON object");
    }
    passkeySignupRefreshKeys = {};
    for (const [keyId, encodedKey] of Object.entries(untrusted)) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyId)
        || typeof encodedKey !== "string"
      ) {
        throw new Error("PASSKEY_SIGNUP_REFRESH_KEYS contains an invalid entry");
      }
      const decoded = Buffer.from(encodedKey, "base64url");
      if (decoded.length !== 32 || decoded.toString("base64url") !== encodedKey) {
        throw new Error(
          `Passkey signup refresh key '${keyId}' must be exactly 32 bytes encoded as base64url`
        );
      }
      passkeySignupRefreshKeys[keyId] = encodedKey;
    }
    if (Object.keys(passkeySignupRefreshKeys).length === 0) {
      throw new Error("PASSKEY_SIGNUP_REFRESH_KEYS cannot be empty");
    }
  }
  const hasPasskeySignupAuthorization = parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET !== undefined;
  const hasPasskeySignupRefreshKeys = passkeySignupRefreshKeys !== undefined;
  const hasActivePasskeySignupRefreshKey = parsed.ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID !== undefined;
  if (
    hasPasskeySignupAuthorization !== hasPasskeySignupRefreshKeys
    || hasPasskeySignupRefreshKeys !== hasActivePasskeySignupRefreshKey
    || (parsed.ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID !== undefined
      && passkeySignupRefreshKeys?.[parsed.ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID] === undefined)
  ) {
    throw new Error(
      "PASSKEY_SIGNUP_AUTHORIZATION_SECRET, PASSKEY_SIGNUP_REFRESH_KEYS and ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID must identify one complete signup key set"
    );
  }
  if (
    parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET !== undefined
    && Buffer.byteLength(parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET, "utf8") < 32
  ) {
    throw new Error("PASSKEY_SIGNUP_AUTHORIZATION_SECRET must contain at least 32 bytes");
  }
  const signupRefreshMaterials = Object.values(passkeySignupRefreshKeys ?? {});
  const bootstrapRefreshMaterials = Object.values(passkeyBootstrapRefreshKeys ?? {});
  const dataEncryptionMaterials = Object.values(dataEncryptionKeys);
  const signupAuthorizationPeers = [
    parsed.JWT_SECRET,
    ...signupRefreshMaterials,
    ...bootstrapRefreshMaterials,
    ...dataEncryptionMaterials
  ];
  if (
    (parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET !== undefined
      && signupAuthorizationPeers.includes(parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET))
    || new Set(signupRefreshMaterials).size !== signupRefreshMaterials.length
    || signupRefreshMaterials.some((key) =>
      key === parsed.JWT_SECRET
      || bootstrapRefreshMaterials.includes(key)
      || dataEncryptionMaterials.includes(key))
  ) {
    throw new Error("Passkey signup secrets must use independent key material");
  }
  if (parsed.PHONE_AUTH_ENABLED) {
    if (parsed.PHONE_AUTH_PROVIDER === "disabled") {
      throw new Error("PHONE_AUTH_ENABLED requires a phone delivery provider");
    }
    if (parsed.PHONE_AUTH_HMAC_SECRET === undefined) {
      throw new Error("PHONE_AUTH_ENABLED requires PHONE_AUTH_HMAC_SECRET");
    }
    if (
      parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID === undefined
      || dataEncryptionKeys[parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID] === undefined
    ) {
      throw new Error("Phone authentication requires an active data-encryption key");
    }
    if (parsed.PHONE_AUTH_HMAC_SECRET === parsed.JWT_SECRET
      || dataEncryptionMaterials.includes(parsed.PHONE_AUTH_HMAC_SECRET)
      || bootstrapRefreshMaterials.includes(parsed.PHONE_AUTH_HMAC_SECRET)
      || signupRefreshMaterials.includes(parsed.PHONE_AUTH_HMAC_SECRET)
      || parsed.PHONE_AUTH_HMAC_SECRET === parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET) {
      throw new Error("Phone authentication requires independent HMAC key material");
    }
    if (parsed.PHONE_AUTH_PROVIDER === "development") {
      if (parsed.NODE_ENV === "production") {
        throw new Error("Development phone delivery cannot be enabled in production");
      }
      if (parsed.PHONE_AUTH_DEVELOPMENT_CODE === undefined) {
        throw new Error("Development phone delivery requires PHONE_AUTH_DEVELOPMENT_CODE");
      }
    }
    if (
      parsed.PHONE_AUTH_PROVIDER === "external"
      && parsed.PHONE_AUTH_DEVELOPMENT_CODE !== undefined
    ) {
      throw new Error("PHONE_AUTH_DEVELOPMENT_CODE is valid only for the development provider");
    }
    if (
      parsed.NODE_ENV === "production"
      && parsed.PHONE_AUTH_RECOVERY_DELAY_SECONDS < 3_600
    ) {
      throw new Error(
        "PHONE_AUTH_RECOVERY_DELAY_SECONDS must be at least 3600 seconds in production"
      );
    }
  } else if (
    parsed.PHONE_AUTH_PROVIDER !== "disabled"
    || parsed.PHONE_AUTH_HMAC_SECRET !== undefined
    || parsed.PHONE_AUTH_DEVELOPMENT_CODE !== undefined
  ) {
    throw new Error("Phone authentication configuration requires PHONE_AUTH_ENABLED=true");
  }
  if (parsed.PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED) {
    if (
      parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET === undefined
      || passkeySignupRefreshKeys === undefined
      || parsed.ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID === undefined
    ) {
      throw new Error(
        "PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED requires the complete signup key set"
      );
    }
    if (
      parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID === undefined
      || dataEncryptionKeys[parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID] === undefined
    ) {
      throw new Error("Passkey signup requires an active data-encryption key");
    }
    if (parsed.ACCESS_TOKEN_TTL_SECONDS < 601) {
      throw new Error("Passkey signup access-token TTL must be at least 601 seconds");
    }
  }
  if (parsed.USER_STORAGE_QUOTA_BYTES < parsed.MAX_ATTACHMENT_BYTES) {
    throw new Error("USER_STORAGE_QUOTA_BYTES must be at least MAX_ATTACHMENT_BYTES");
  }
  if (parsed.STORAGE_DRIVER === "s3") {
    if (parsed.S3_BUCKET === undefined) throw new Error("S3_BUCKET is required for STORAGE_DRIVER=s3");
    if (parsed.S3_SERVER_SIDE_ENCRYPTION === "aws:kms" && parsed.S3_KMS_KEY_ID === undefined) {
      throw new Error("S3_KMS_KEY_ID is required for aws:kms server-side encryption");
    }
    if (parsed.S3_SERVER_SIDE_ENCRYPTION === "AES256" && parsed.S3_KMS_KEY_ID !== undefined) {
      throw new Error("S3_KMS_KEY_ID can only be used with aws:kms server-side encryption");
    }
    if (
      parsed.NODE_ENV === "production" &&
      parsed.S3_SERVER_SIDE_ENCRYPTION === "aws:kms" &&
      parsed.S3_KMS_KEY_ID !== undefined &&
      !/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[A-Za-z0-9-]+$/u.test(parsed.S3_KMS_KEY_ID)
    ) {
      throw new Error("Production S3_KMS_KEY_ID must be the canonical KMS key ARN, not an alias");
    }
    if (
      parsed.NODE_ENV === "production" &&
      parsed.S3_ENDPOINT !== undefined &&
      new URL(parsed.S3_ENDPOINT).protocol !== "https:"
    ) {
      throw new Error("Production S3_ENDPOINT must use HTTPS");
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    jwtSecret: parsed.JWT_SECRET,
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    trustedProxyCidrs,
    ...(parsed.METRICS_TOKEN === undefined ? {} : { metricsToken: parsed.METRICS_TOKEN }),
    dataEncryptionKeys,
    ...(parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID === undefined
      ? {}
      : { activeDataEncryptionKeyId: parsed.ACTIVE_DATA_ENCRYPTION_KEY_ID }),
    storageDriver: parsed.STORAGE_DRIVER,
    storageLocalPath: parsed.STORAGE_LOCAL_PATH,
    uploadStagingPath: parsed.UPLOAD_STAGING_PATH,
    maxAttachmentBytes: parsed.MAX_ATTACHMENT_BYTES,
    userStorageQuotaBytes: parsed.USER_STORAGE_QUOTA_BYTES,
    uploadChunkSizeBytes: parsed.UPLOAD_CHUNK_SIZE_BYTES,
    uploadSessionTtlMinutes: parsed.UPLOAD_SESSION_TTL_MINUTES,
    orphanAttachmentTtlHours: parsed.ORPHAN_ATTACHMENT_TTL_HOURS,
    ...(parsed.STORAGE_DRIVER === "local" ? {} : {
      s3: {
        bucket: parsed.S3_BUCKET as string,
        region: parsed.S3_REGION,
        ...(parsed.S3_ENDPOINT === undefined ? {} : { endpoint: parsed.S3_ENDPOINT }),
        forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
        serverSideEncryption: parsed.S3_SERVER_SIDE_ENCRYPTION,
        ...(parsed.S3_KMS_KEY_ID === undefined ? {} : { kmsKeyId: parsed.S3_KMS_KEY_ID })
      }
    }),
    accessTokenTtlSeconds: parsed.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: parsed.REFRESH_TOKEN_TTL_DAYS,
    ...(passkeyBootstrapRefreshKeys === undefined ? {} : {
      passkeyBootstrapRefreshKeys,
      activePasskeyBootstrapRefreshKeyId: parsed.ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID as string
    }),
    ...(passkeySignupRefreshKeys === undefined ? {} : {
      passkeySignupAuthorizationSecret: parsed.PASSKEY_SIGNUP_AUTHORIZATION_SECRET as string,
      passkeySignupRefreshKeys,
      activePasskeySignupRefreshKeyId: parsed.ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID as string
    }),
    passkeyInternalRoutesEnabled: parsed.PASSKEY_INTERNAL_ROUTES_ENABLED,
    passkeyInternalSignupRoutesEnabled: parsed.PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED,
    phoneAuthEnabled: parsed.PHONE_AUTH_ENABLED,
    phoneAuthProvider: parsed.PHONE_AUTH_PROVIDER,
    ...(parsed.PHONE_AUTH_HMAC_SECRET === undefined
      ? {}
      : { phoneAuthHmacSecret: parsed.PHONE_AUTH_HMAC_SECRET }),
    ...(parsed.PHONE_AUTH_DEVELOPMENT_CODE === undefined
      ? {}
      : { phoneAuthDevelopmentCode: parsed.PHONE_AUTH_DEVELOPMENT_CODE }),
    phoneAuthChallengeTtlSeconds: parsed.PHONE_AUTH_CHALLENGE_TTL_SECONDS,
    phoneAuthRegistrationTtlSeconds: parsed.PHONE_AUTH_REGISTRATION_TTL_SECONDS,
    phoneAuthRetryAfterSeconds: parsed.PHONE_AUTH_RETRY_AFTER_SECONDS,
    phoneAuthMaxAttempts: parsed.PHONE_AUTH_MAX_ATTEMPTS,
    phoneAuthRecoveryDelaySeconds: parsed.PHONE_AUTH_RECOVERY_DELAY_SECONDS,
    phoneAuthRecoveryTtlSeconds: parsed.PHONE_AUTH_RECOVERY_TTL_SECONDS,
    syncInvalidationEnabled: parsed.SYNC_INVALIDATION_ENABLED
  };
}
