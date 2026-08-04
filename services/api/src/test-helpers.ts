import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { LuxoraApp } from "./app.js";

export interface TestIdentity {
  id: string;
  accessToken: string;
}

export async function establishAcceptedRelationship(
  app: LuxoraApp,
  sender: TestIdentity,
  recipient: TestIdentity
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/message-requests",
    headers: { authorization: `Bearer ${sender.accessToken}` },
    payload: {
      recipientUserId: recipient.id,
      body: "Test conversation request",
      clientNonce: randomUUID()
    }
  });
  if (created.statusCode !== 201) {
    throw new Error(`Could not create test message request: ${created.statusCode} ${created.body}`);
  }

  const accepted = await app.inject({
    method: "POST",
    url: `/v1/message-requests/${created.json().request.id as string}/accept`,
    headers: { authorization: `Bearer ${recipient.accessToken}` }
  });
  if (accepted.statusCode !== 200) {
    throw new Error(`Could not accept test message request: ${accepted.statusCode} ${accepted.body}`);
  }
  return accepted.json().chat.id as string;
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8080,
    databasePath: ":memory:",
    jwtSecret: "test-only-secret-with-at-least-thirty-two-bytes",
    corsOrigins: ["http://localhost:3000"],
    trustedProxyCidrs: [],
    dataEncryptionKeys: {},
    storageDriver: "local",
    storageLocalPath: ":memory:",
    uploadStagingPath: ":memory:",
    maxAttachmentBytes: 10_485_760,
    userStorageQuotaBytes: 52_428_800,
    uploadChunkSizeBytes: 262_144,
    uploadSessionTtlMinutes: 60,
    orphanAttachmentTtlHours: 24,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlDays: 30,
    passkeyInternalRoutesEnabled: false,
    passkeyInternalSignupRoutesEnabled: false,
    phoneAuthEnabled: false,
    phoneAuthProvider: "disabled",
    phoneAuthChallengeTtlSeconds: 300,
    phoneAuthRegistrationTtlSeconds: 600,
    phoneAuthRetryAfterSeconds: 60,
    phoneAuthMaxAttempts: 5,
    ...overrides
  };
}
