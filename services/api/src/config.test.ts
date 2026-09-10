import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const DATA_KEY = Buffer.alloc(32, 9).toString("base64url");
const BOOTSTRAP_REFRESH_KEY = Buffer.alloc(32, 17).toString("base64url");
const SIGNUP_REFRESH_KEY = Buffer.alloc(32, 19).toString("base64url");
const SIGNUP_AUTHORIZATION_SECRET = "signup-authorization-secret-that-is-independent";
const PHONE_AUTH_HMAC_SECRET = "phone-auth-hmac-secret-that-is-independent";
const KMS_ARN = "arn:aws:kms:eu-central-1:123456789012:key/00000000-0000-0000-0000-000000000000";

function production(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    JWT_SECRET: "production-test-secret-with-at-least-thirty-two-bytes",
    DATA_ENCRYPTION_KEYS: JSON.stringify({ active: DATA_KEY }),
    ACTIVE_DATA_ENCRYPTION_KEY_ID: "active",
    STORAGE_DRIVER: "s3",
    S3_BUCKET: "luxora-test",
    ...overrides
  };
}

describe("media storage configuration", () => {
  it("rejects KMS aliases in production so response key verification is canonical", () => {
    expect(() => loadConfig(production({
      S3_SERVER_SIDE_ENCRYPTION: "aws:kms",
      S3_KMS_KEY_ID: "alias/luxora"
    }))).toThrow("canonical KMS key ARN");
    expect(loadConfig(production({
      S3_SERVER_SIDE_ENCRYPTION: "aws:kms",
      S3_KMS_KEY_ID: KMS_ARN
    })).s3?.kmsKeyId).toBe(KMS_ARN);
  });

  it("rejects contradictory AES256 and KMS parameters", () => {
    expect(() => loadConfig(production({
      S3_SERVER_SIDE_ENCRYPTION: "AES256",
      S3_KMS_KEY_ID: KMS_ARN
    }))).toThrow("only be used with aws:kms");
  });

  it("rejects data-key identifiers that overflow the local blob header in UTF-8", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      DATA_ENCRYPTION_KEYS: JSON.stringify({ ["я".repeat(40)]: DATA_KEY })
    })).toThrow("invalid entry");
  });
});

describe("internal passkey route configuration", () => {
  it("is disabled by default and accepts only explicit canonical boolean values", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes"
    }).passkeyInternalRoutesEnabled).toBe(false);
    expect(loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes"
    }).passkeyInternalSignupRoutesEnabled).toBe(false);
    expect(loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      PASSKEY_INTERNAL_ROUTES_ENABLED: "1"
    }).passkeyInternalRoutesEnabled).toBe(true);
    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      PASSKEY_INTERNAL_ROUTES_ENABLED: "yes"
    })).toThrow();
    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED: "yes"
    })).toThrow();
  });

  it("parses a dedicated rotatable bootstrap refresh keyring only as an exact pair", () => {
    const configured = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      PASSKEY_BOOTSTRAP_REFRESH_KEYS: JSON.stringify({ "2026-08.v1": BOOTSTRAP_REFRESH_KEY }),
      ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID: "2026-08.v1"
    });
    expect(configured.passkeyBootstrapRefreshKeys).toEqual({
      "2026-08.v1": BOOTSTRAP_REFRESH_KEY
    });
    expect(configured.activePasskeyBootstrapRefreshKeyId).toBe("2026-08.v1");

    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      PASSKEY_BOOTSTRAP_REFRESH_KEYS: JSON.stringify({ "2026-08.v1": BOOTSTRAP_REFRESH_KEY })
    })).toThrow("must identify one active key");
    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      PASSKEY_BOOTSTRAP_REFRESH_KEYS: JSON.stringify({ "bad key": BOOTSTRAP_REFRESH_KEY }),
      ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID: "bad key"
    })).toThrow("invalid entry");
  });

  it("parses only a complete independently keyed pre-account signup gate", () => {
    const configured = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      DATA_ENCRYPTION_KEYS: JSON.stringify({ active: DATA_KEY }),
      ACTIVE_DATA_ENCRYPTION_KEY_ID: "active",
      PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED: "true",
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: SIGNUP_AUTHORIZATION_SECRET,
      PASSKEY_SIGNUP_REFRESH_KEYS: JSON.stringify({ "signup.2026-08": SIGNUP_REFRESH_KEY }),
      ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: "signup.2026-08"
    });
    expect(configured).toMatchObject({
      passkeyInternalSignupRoutesEnabled: true,
      passkeySignupAuthorizationSecret: SIGNUP_AUTHORIZATION_SECRET,
      passkeySignupRefreshKeys: { "signup.2026-08": SIGNUP_REFRESH_KEY },
      activePasskeySignupRefreshKeyId: "signup.2026-08"
    });
  });

  it("fails closed on partial, weak, shared or unencrypted signup configuration", () => {
    const base = {
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes"
    } satisfies NodeJS.ProcessEnv;
    expect(() => loadConfig({
      ...base,
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: SIGNUP_AUTHORIZATION_SECRET
    })).toThrow("complete signup key set");
    expect(() => loadConfig({
      ...base,
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: "too-short",
      PASSKEY_SIGNUP_REFRESH_KEYS: JSON.stringify({ signup: SIGNUP_REFRESH_KEY }),
      ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: "signup"
    })).toThrow("at least 32 bytes");
    expect(() => loadConfig({
      ...base,
      PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED: "true",
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: SIGNUP_AUTHORIZATION_SECRET,
      PASSKEY_SIGNUP_REFRESH_KEYS: JSON.stringify({ signup: SIGNUP_REFRESH_KEY }),
      ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: "signup"
    })).toThrow("requires an active data-encryption key");
    expect(() => loadConfig({
      ...base,
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: base.JWT_SECRET,
      PASSKEY_SIGNUP_REFRESH_KEYS: JSON.stringify({ signup: SIGNUP_REFRESH_KEY }),
      ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: "signup"
    })).toThrow("independent key material");
    expect(() => loadConfig({
      ...base,
      PASSKEY_BOOTSTRAP_REFRESH_KEYS: JSON.stringify({ login: SIGNUP_REFRESH_KEY }),
      ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID: "login",
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: SIGNUP_AUTHORIZATION_SECRET,
      PASSKEY_SIGNUP_REFRESH_KEYS: JSON.stringify({ signup: SIGNUP_REFRESH_KEY }),
      ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: "signup"
    })).toThrow("independent key material");
  });

  it("rejects every signup key-material reuse edge and duplicate rotation roots", () => {
    const base = {
      NODE_ENV: "test",
      JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: SIGNUP_AUTHORIZATION_SECRET,
      PASSKEY_SIGNUP_REFRESH_KEYS: JSON.stringify({ signup: SIGNUP_REFRESH_KEY }),
      ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: "signup"
    } satisfies NodeJS.ProcessEnv;

    expect(() => loadConfig({
      ...base,
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: SIGNUP_REFRESH_KEY
    })).toThrow("independent key material");
    expect(() => loadConfig({
      ...base,
      PASSKEY_BOOTSTRAP_REFRESH_KEYS: JSON.stringify({ login: BOOTSTRAP_REFRESH_KEY }),
      ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID: "login",
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: BOOTSTRAP_REFRESH_KEY
    })).toThrow("independent key material");
    expect(() => loadConfig({
      ...base,
      DATA_ENCRYPTION_KEYS: JSON.stringify({ data: DATA_KEY }),
      PASSKEY_SIGNUP_AUTHORIZATION_SECRET: DATA_KEY
    })).toThrow("independent key material");
    expect(() => loadConfig({
      ...base,
      JWT_SECRET: SIGNUP_REFRESH_KEY
    })).toThrow("independent key material");
    expect(() => loadConfig({
      ...base,
      PASSKEY_SIGNUP_REFRESH_KEYS: JSON.stringify({
        "signup.old": SIGNUP_REFRESH_KEY,
        "signup.active": SIGNUP_REFRESH_KEY
      }),
      ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID: "signup.active"
    })).toThrow("independent key material");
  });

  it("cannot expose the incomplete route family in production", () => {
    expect(() => loadConfig(production({
      PASSKEY_INTERNAL_ROUTES_ENABLED: "true"
    }))).toThrow("cannot be enabled in production");
    expect(() => loadConfig(production({
      PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED: "true"
    }))).toThrow("cannot be enabled in production");
  });
});

describe("phone authentication configuration", () => {
  const encryptedTestBase = {
    NODE_ENV: "test",
    JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes",
    DATA_ENCRYPTION_KEYS: JSON.stringify({ active: DATA_KEY }),
    ACTIVE_DATA_ENCRYPTION_KEY_ID: "active"
  } satisfies NodeJS.ProcessEnv;

  it("is disabled by default and accepts a fully isolated development provider", () => {
    expect(loadConfig(encryptedTestBase)).toMatchObject({
      phoneAuthEnabled: false,
      phoneAuthProvider: "disabled",
      phoneAuthChallengeTtlSeconds: 300,
      phoneAuthRegistrationTtlSeconds: 600,
      phoneAuthRetryAfterSeconds: 60,
      phoneAuthMaxAttempts: 5
    });
    expect(loadConfig({
      ...encryptedTestBase,
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "development",
      PHONE_AUTH_HMAC_SECRET,
      PHONE_AUTH_DEVELOPMENT_CODE: "123456"
    })).toMatchObject({
      phoneAuthEnabled: true,
      phoneAuthProvider: "development",
      phoneAuthHmacSecret: PHONE_AUTH_HMAC_SECRET,
      phoneAuthDevelopmentCode: "123456"
    });
  });

  it("fails closed on partial, unencrypted, shared, malformed, or production development setup", () => {
    expect(() => loadConfig({
      ...encryptedTestBase,
      PHONE_AUTH_PROVIDER: "development",
      PHONE_AUTH_HMAC_SECRET,
      PHONE_AUTH_DEVELOPMENT_CODE: "123456"
    })).toThrow("requires PHONE_AUTH_ENABLED=true");
    expect(() => loadConfig({
      ...encryptedTestBase,
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_HMAC_SECRET
    })).toThrow("delivery provider");
    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: encryptedTestBase.JWT_SECRET,
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "development",
      PHONE_AUTH_HMAC_SECRET,
      PHONE_AUTH_DEVELOPMENT_CODE: "123456"
    })).toThrow("active data-encryption key");
    expect(() => loadConfig({
      ...encryptedTestBase,
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "development",
      PHONE_AUTH_HMAC_SECRET: encryptedTestBase.JWT_SECRET,
      PHONE_AUTH_DEVELOPMENT_CODE: "123456"
    })).toThrow("independent HMAC key material");
    expect(() => loadConfig({
      ...encryptedTestBase,
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "development",
      PHONE_AUTH_HMAC_SECRET,
      PHONE_AUTH_DEVELOPMENT_CODE: "12345"
    })).toThrow();
    expect(() => loadConfig(production({
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "development",
      PHONE_AUTH_HMAC_SECRET,
      PHONE_AUTH_DEVELOPMENT_CODE: "123456"
    }))).toThrow("cannot be enabled in production");
  });

  it("accepts an external production provider but never a development code with it", () => {
    expect(loadConfig(production({
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "external",
      PHONE_AUTH_HMAC_SECRET,
      PHONE_AUTH_RECOVERY_DELAY_SECONDS: "3600"
    }))).toMatchObject({
      phoneAuthEnabled: true,
      phoneAuthProvider: "external",
      phoneAuthRecoveryDelaySeconds: 3600,
      phoneAuthRecoveryTtlSeconds: 86_400
    });
    expect(() => loadConfig(production({
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "external",
      PHONE_AUTH_HMAC_SECRET
    }))).toThrow("PHONE_AUTH_RECOVERY_DELAY_SECONDS must be at least 3600 seconds in production");
    expect(() => loadConfig({
      ...encryptedTestBase,
      PHONE_AUTH_ENABLED: "true",
      PHONE_AUTH_PROVIDER: "external",
      PHONE_AUTH_HMAC_SECRET,
      PHONE_AUTH_DEVELOPMENT_CODE: "123456"
    })).toThrow("valid only for the development provider");
  });
});

describe("sync invalidation emergency rollback configuration", () => {
  it("defaults on, accepts an explicit production kill switch, and rejects ambiguous values", () => {
    expect(loadConfig(production()).syncInvalidationEnabled).toBe(true);
    expect(loadConfig(production({
      SYNC_INVALIDATION_ENABLED: "false"
    })).syncInvalidationEnabled).toBe(false);
    expect(loadConfig(production({
      SYNC_INVALIDATION_ENABLED: "0"
    })).syncInvalidationEnabled).toBe(false);
    expect(loadConfig(production({
      SYNC_INVALIDATION_ENABLED: "true"
    })).syncInvalidationEnabled).toBe(true);
    expect(() => loadConfig(production({
      SYNC_INVALIDATION_ENABLED: "yes"
    }))).toThrow();
    expect(() => loadConfig(production({
      SYNC_INVALIDATION_ENABLED: "FALSE"
    }))).toThrow();
  });
});
