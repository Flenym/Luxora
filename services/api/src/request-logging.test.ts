import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

describe("query-safe structured API request logging", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("keeps request path/method/status/id/duration while excluding query, auth, password, token, and content canaries", async () => {
    let output = "";
    app = await buildApp({
      config: testConfig(),
      logger: true,
      logStream: { write(message) { output += message; } }
    });
    const passwordCanary = "Canary-password-never-log-2026";
    const queryCanary = "log_query_canary";
    const contentCanary = "CANARY_PRIVATE_MESSAGE_CONTENT_9f18";
    const invalidTokenCanary = "CANARY_BEARER_TOKEN_3bc1";
    const clientRequestIdCanary = "CLIENT_CONTROLLED_REQUEST_ID_NEVER_LOG_4f2a";
    const attachmentIdCanary = randomUUID();
    const unmatchedPathCanary = "CLIENT_CONTROLLED_UNMATCHED_PATH_NEVER_LOG_71dd";

    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: queryCanary,
        displayName: "Log canary",
        password: passwordCanary,
        deviceName: "Canary device"
      }
    });
    expect(registered.statusCode).toBe(201);
    const accessToken = registered.json().tokens.accessToken as string;
    const refreshToken = registered.json().tokens.refreshToken as string;

    const lookup = await app.inject({
      method: "GET",
      url: `/v1/users/lookup?username=${queryCanary}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(lookup.statusCode).toBe(200);
    const contentRequest = await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        recipientUserId: randomUUID(),
        body: contentCanary,
        clientNonce: randomUUID()
      }
    });
    expect(contentRequest.statusCode).toBe(403);
    const invalidBearer = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${invalidTokenCanary}` }
    });
    expect(invalidBearer.statusCode).toBe(401);
    const missingAttachment = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentIdCanary}/content`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-request-id": clientRequestIdCanary
      }
    });
    expect(missingAttachment.statusCode).toBe(404);
    expect(missingAttachment.json().error.requestId).not.toBe(clientRequestIdCanary);
    const unmatched = await app.inject({
      method: "GET",
      url: `/unmatched/${unmatchedPathCanary}`,
      headers: { "x-request-id": clientRequestIdCanary }
    });
    expect(unmatched.statusCode).toBe(404);
    const linkChallenge = await app.inject({
      method: "POST",
      url: "/v1/device-links/challenges",
      payload: { targetLabel: "Log canary device" }
    });
    expect(linkChallenge.statusCode).toBe(201);
    const linkSecret = linkChallenge.json().linkSecret as string;
    const linkPoll = await app.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${linkChallenge.json().linkId as string}/poll`,
      payload: { linkSecret }
    });
    expect(linkPoll.statusCode).toBe(200);
    const webhookCanary = "CANARY_WEBHOOK_AUTH_7e21";
    const forgedWebhook = await app.inject({
      method: "POST",
      url: "/v1/internal/calls/livekit-webhook",
      headers: {
        "content-type": "application/webhook+json",
        authorization: webhookCanary
      },
      payload: Buffer.from("{}", "utf8")
    });
    expect(forgedWebhook.statusCode).toBe(401);
    await app.close();
    app = undefined;

    for (const forbidden of [
      `?username=${queryCanary}`,
      queryCanary,
      passwordCanary,
      contentCanary,
      invalidTokenCanary,
      clientRequestIdCanary,
      attachmentIdCanary,
      unmatchedPathCanary,
      accessToken,
      refreshToken,
      "authorization",
      linkSecret,
      webhookCanary
    ]) {
      expect(output).not.toContain(forbidden);
    }

    const lines = output.trim().split("\n").map((line) => JSON.parse(line) as any);
    const incoming = lines.find((line) =>
      line.msg === "incoming request" && line.req?.path === "/v1/users/lookup"
    );
    expect(incoming).toBeDefined();
    expect(incoming.req).toEqual({ method: "GET", path: "/v1/users/lookup" });
    expect(typeof incoming.reqId).toBe("string");
    const completed = lines.find((line) =>
      line.msg === "request completed" && line.reqId === incoming.reqId
    );
    expect(completed).toMatchObject({ res: { statusCode: 200 } });
    expect(typeof completed.responseTime).toBe("number");

    const attachmentIncoming = lines.find((line) =>
      line.msg === "incoming request" && line.req?.path === "/v1/attachments/:id/content"
    );
    expect(attachmentIncoming).toBeDefined();
    expect(attachmentIncoming.reqId).not.toBe(clientRequestIdCanary);
    const unmatchedIncoming = lines.find((line) =>
      line.msg === "incoming request" && line.req?.method === "GET"
        && (line.req?.path === "<unmatched>" || line.req?.path === "/*")
    );
    expect(unmatchedIncoming).toBeDefined();
  });
});
