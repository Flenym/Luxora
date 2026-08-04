import { describe, expect, it } from "vitest";
import {
  AddChatMemberRequestSchema,
  AuthResponseSchema,
  BlockListResponseSchema,
  ClientRealtimeMessageSchema,
  ChatMemberSchema,
  ChatMembershipMutationResponseSchema,
  CheckPhoneUsernameSchema,
  CompletePhoneRegistrationSchema,
  CheckPhoneUsernameSchema,
  CompletePhoneRegistrationSchema,
  CreateMessageRequestSchema,
  CreateSafetyReportSchema,
  CreateUploadRequestSchema,
  DurableRealtimeEventSchema,
  IA1RealtimeEventSchema,
  IA1ServerRealtimeMessageSchema,
  IdSchema,
  MessageRequestRecipientProjectionSchema,
  MessageRequestSenderProjectionSchema,
  PatchPrivacySettingsSchema,
  PhoneChallengeResponseSchema,
  PhoneUsernameAvailabilityResponseSchema,
  PhoneRegistrationTokenSchema,
  PhoneUsernameAvailabilityResponseSchema,
  RequestPhoneChallengeSchema,
  PrivacySettingsSchema,
  PublicProfileSchema,
  REALTIME_CURSOR_TTL_SECONDS,
  REALTIME_MAX_REPLAY_EVENTS,
  RealtimeEventSchema,
  RealtimeSnapshotResponseSchema,
  RemoveChatMemberRequestSchema,
  RegisterRequestSchema,
  SafetyReportSummarySchema,
  SendMessageRequestSchema,
  VerifyPhoneChallengeResponseSchema,
  VerifyPhoneChallengeSchema,
  UserLookupResponseSchema
} from "./index.js";

describe("protocol validation", () => {
  it("canonicalizes UUID inputs and nested response payloads to lowercase", () => {
    const userId = "9ec9347c-9306-4108-aab4-e7762b73b201";
    const sessionId = "a0df9334-2ec0-422d-b5de-11c775a42344";

    expect(IdSchema.parse(userId.toUpperCase())).toBe(userId);
    expect(IdSchema.safeParse("00000000-0000-0000-0000-000000000000").success)
      .toBe(false);
    expect(IdSchema.safeParse("00000000-0000-4000-7000-000000000001").success)
      .toBe(false);
    expect(SendMessageRequestSchema.parse({
      clientNonce: sessionId.toUpperCase(),
      body: "canonical nonce"
    }).clientNonce).toBe(sessionId);

    const response = AuthResponseSchema.parse({
      user: {
        id: userId.toUpperCase(),
        username: "aurora_1",
        displayName: "Aurora",
        bio: "",
        avatarUrl: null,
        createdAt: "2026-08-03T12:00:00.000Z"
      },
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenType: "Bearer",
        expiresIn: 900,
        sessionId: sessionId.toUpperCase()
      }
    });

    expect(response.user.id).toBe(userId);
    expect(response.tokens.sessionId).toBe(sessionId);
  });

  it("normalizes valid registration input defaults", () => {
    const value = RegisterRequestSchema.parse({
      username: "aurora_1",
      displayName: "Aurora",
      password: "correct horse battery staple"
    });

    expect(value.deviceName).toBe("Unknown device");
  });

  it("keeps phone authentication input strict and response status discriminated", () => {
    const nonce = "9ec9347c-9306-4108-aab4-e7762b73b201";
    expect(RequestPhoneChallengeSchema.parse({
      countryCode: "7",
      nationalNumber: "9991234567",
      clientNonce: nonce
    })).toEqual({
      countryCode: "7",
      nationalNumber: "9991234567",
      deviceName: "Unknown device",
      clientNonce: nonce
    });
    expect(RequestPhoneChallengeSchema.safeParse({
      countryCode: "+7",
      nationalNumber: "9991234567",
      clientNonce: nonce
    }).success).toBe(false);
    expect(RequestPhoneChallengeSchema.safeParse({
      countryCode: "7",
      nationalNumber: "9991234567",
      clientNonce: nonce,
      trusted: true
    }).success).toBe(false);
    expect(VerifyPhoneChallengeSchema.safeParse({
      code: "12345",
      clientNonce: nonce
    }).success).toBe(false);

    const registrationToken = `luxpr_${"a".repeat(43)}`;
    expect(PhoneRegistrationTokenSchema.parse(registrationToken)).toBe(registrationToken);
    expect(PhoneChallengeResponseSchema.safeParse({
      challengeId: nonce,
      maskedPhone: "+7 ••• •••-45-67",
      expiresAt: "2026-08-04T12:05:00.000Z",
      retryAfterSeconds: 60
    }).success).toBe(true);
    expect(VerifyPhoneChallengeResponseSchema.safeParse({
      status: "profile_required",
      registrationToken,
      maskedPhone: "+7 ••• •••-45-67",
      expiresAt: "2026-08-04T12:10:00.000Z"
    }).success).toBe(true);
    expect(VerifyPhoneChallengeResponseSchema.safeParse({
      status: "profile_required",
      registrationToken,
      maskedPhone: "+7 ••• •••-45-67",
      expiresAt: "2026-08-04T12:10:00.000Z",
      user: {}
    }).success).toBe(false);
    expect(CheckPhoneUsernameSchema.safeParse({
      registrationToken,
      username: "egor_name"
    }).success).toBe(true);
    expect(PhoneUsernameAvailabilityResponseSchema.safeParse({
      username: "egor_name",
      available: false,
      suggestions: ["egor_name_1", "egor_name_2"]
    }).success).toBe(true);
    expect(PhoneUsernameAvailabilityResponseSchema.safeParse({
      username: "egor_name",
      available: true,
      suggestions: ["egor_name_1"]
    }).success).toBe(false);
    expect(CompletePhoneRegistrationSchema.parse({
      registrationToken,
      displayName: " Егор ",
      username: "egor_name",
      clientNonce: nonce
    })).toEqual({
      registrationToken,
      displayName: "Егор",
      username: "egor_name",
      bio: "",
      deviceName: "Unknown device",
      clientNonce: nonce
    });
  });

  it("rejects unknown message fields and oversized content", () => {
    expect(() => SendMessageRequestSchema.parse({
      clientNonce: "9ec9347c-9306-4108-aab4-e7762b73b201",
      body: "hello",
      admin: true
    })).toThrow();
  });

  it("accepts resumable realtime authentication", () => {
    const value = ClientRealtimeMessageSchema.parse({
      type: "authenticate",
      accessToken: "a".repeat(40),
      resumeFrom: 42
    });

    expect(value.type).toBe("authenticate");

    const cursor = `luxora-rt1.${"a".repeat(96)}.${"b".repeat(43)}`;
    expect(ClientRealtimeMessageSchema.safeParse({
      type: "authenticate",
      accessToken: "a".repeat(40),
      resumeCursor: cursor
    }).success).toBe(true);
    expect(ClientRealtimeMessageSchema.safeParse({
      type: "authenticate",
      accessToken: "a".repeat(40),
      resumeFrom: 42,
      resumeCursor: cursor
    }).success).toBe(true);
    expect(ClientRealtimeMessageSchema.safeParse({
      type: "authenticate",
      accessToken: "a".repeat(40),
      resumeCursor: "corrupted"
    }).success).toBe(true);
    expect(ClientRealtimeMessageSchema.safeParse({
      type: "authenticate",
      accessToken: "a".repeat(40),
      resumeCursor: "x".repeat(513)
    }).success).toBe(false);

  });

  it("counts astral emoji as one Unicode code point in message limits", () => {
    expect(SendMessageRequestSchema.safeParse({
      clientNonce: "9ec9347c-9306-4108-aab4-e7762b73b201",
      body: "💎".repeat(10_000)
    }).success).toBe(true);
    expect(SendMessageRequestSchema.safeParse({
      clientNonce: "9ec9347c-9306-4108-aab4-e7762b73b201",
      body: "💎".repeat(10_001)
    }).success).toBe(false);
  });

  it("requires text or an attachment while allowing media-only messages", () => {
    const nonce = "9ec9347c-9306-4108-aab4-e7762b73b201";
    expect(SendMessageRequestSchema.safeParse({ clientNonce: nonce, body: null }).success).toBe(false);
    const media = SendMessageRequestSchema.parse({
      clientNonce: nonce,
      body: null,
      attachmentIds: ["a0df9334-2ec0-422d-b5de-11c775a42344"]
    });
    expect(media.attachmentIds).toHaveLength(1);
  });

  it("validates upload metadata by media kind", () => {
    const base = {
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      sizeBytes: 42,
      sha256: "a".repeat(64),
      idempotencyKey: "9ec9347c-9306-4108-aab4-e7762b73b201"
    };
    expect(CreateUploadRequestSchema.safeParse({
      ...base,
      kind: "voice",
      metadata: { durationMs: 1_200, waveform: [0, 127, 255] }
    }).success).toBe(true);
    expect(CreateUploadRequestSchema.safeParse({
      ...base,
      kind: "file",
      metadata: { durationMs: 1_200 }
    }).success).toBe(false);
  });

  it("labels unscanned attachments as stored rather than safety-ready", () => {
    expect(RealtimeEventSchema.safeParse({
      type: "attachment.stored",
      attachment: {
        id: "a0df9334-2ec0-422d-b5de-11c775a42344",
        kind: "image",
        fileName: "pixel.png",
        mimeType: "image/png",
        sizeBytes: 68,
        sha256: "b".repeat(64),
        downloadPath: "/v1/attachments/a0df9334-2ec0-422d-b5de-11c775a42344/content",
        safetyStatus: "unscanned",
        metadataTrust: "client_declared",
        metadata: { width: 1, height: 1 },
        createdAt: "2026-08-03T12:00:00.000Z"
      }
    }).success).toBe(true);
  });

  it("keeps chat membership mutations strict, versioned and v2-only in realtime", () => {
    const chatId = "9ec9347c-9306-4108-aab4-e7762b73b201";
    const userId = "a0df9334-2ec0-422d-b5de-11c775a42344";
    const actorUserId = "b650e2ab-4185-493d-81a2-bd4f19b84f0c";
    const joinedAt = "2026-08-03T12:00:00.000Z";
    const updatedAt = "2026-08-03T12:01:00.000Z";
    const membership = { chatId, userId, role: "member", revision: 2, joinedAt, updatedAt };

    expect(AddChatMemberRequestSchema.parse({
      userId: userId.toUpperCase(),
      clientNonce: actorUserId
    })).toEqual({ userId, role: "member", clientNonce: actorUserId });
    expect(RemoveChatMemberRequestSchema.safeParse({
      expectedRevision: 0,
      clientNonce: actorUserId
    }).success).toBe(false);
    expect(ChatMembershipMutationResponseSchema.safeParse({
      membership,
      replayed: false,
      ignored: true
    }).success).toBe(false);
    expect(ChatMemberSchema.safeParse({
      membership,
      user: {
        id: actorUserId,
        username: "wrong_user",
        displayName: "Wrong user",
        bio: "",
        avatarUrl: null,
        createdAt: joinedAt
      }
    }).success).toBe(false);

    const removed = {
      type: "chat.member.changed",
      audience: "removed_account",
      change: "removed",
      membership,
      actorUserId,
      changedAt: updatedAt
    };
    expect(DurableRealtimeEventSchema.safeParse(removed).success).toBe(true);
    expect(RealtimeEventSchema.safeParse(removed).success).toBe(false);
    expect(DurableRealtimeEventSchema.safeParse({
      ...removed,
      change: "role_updated"
    }).success).toBe(false);
    expect(DurableRealtimeEventSchema.safeParse({
      ...removed,
      changedAt: "2026-08-03T12:02:00.000Z"
    }).success).toBe(false);
  });
});

describe("IA-1 identity and safety contract", () => {
  const aliceId = "9ec9347c-9306-4108-aab4-e7762b73b201";
  const bobId = "a0df9334-2ec0-422d-b5de-11c775a42344";
  const requestId = "b650e2ab-4185-493d-81a2-bd4f19b84f0c";
  const reportId = "c8d4c075-17f5-4c8d-a447-9216972c4864";
  const timestamp = "2026-08-03T12:00:00.000Z";
  const profile = {
    id: bobId,
    username: "bob_1",
    displayName: "Bob",
    bio: "Public bio",
    avatarUrl: null
  };

  it("keeps the exact public profile projection free of private identity and presence fields", () => {
    expect(PublicProfileSchema.parse(profile)).toEqual(profile);

    for (const leakedField of ["presence", "lastSeenAt", "email", "phone", "sessions"]) {
      expect(PublicProfileSchema.safeParse({
        ...profile,
        [leakedField]: leakedField === "presence" ? "online" : "private"
      }).success).toBe(false);
    }

    expect(UserLookupResponseSchema.safeParse({ profile: null }).success).toBe(true);
    expect(UserLookupResponseSchema.safeParse({ profile, count: 1 }).success).toBe(false);
  });

  it("uses strict privacy settings and rejects empty patches", () => {
    expect(PrivacySettingsSchema.safeParse({
      usernameDiscoverable: true,
      messageRequests: "everyone"
    }).success).toBe(true);
    expect(PatchPrivacySettingsSchema.safeParse({ messageRequests: "nobody" }).success).toBe(true);
    expect(PatchPrivacySettingsSchema.safeParse({}).success).toBe(false);
    expect(PatchPrivacySettingsSchema.safeParse({ usernameDiscoverable: false, admin: true }).success).toBe(false);
  });

  it("counts message-request text in Unicode code points and derives a validated HTTP(S) link marker", () => {
    const atLimit = CreateMessageRequestSchema.parse({
      recipientUserId: bobId,
      body: "💎".repeat(1_000),
      clientNonce: aliceId
    });
    expect(atLimit.body).toHaveLength(2_000);
    expect(atLimit.validatedLink).toBeNull();

    expect(CreateMessageRequestSchema.safeParse({
      recipientUserId: bobId,
      body: "💎".repeat(1_001),
      clientNonce: aliceId
    }).success).toBe(false);

    const withLink = CreateMessageRequestSchema.parse({
      recipientUserId: bobId,
      body: "Hello https://example.com/request",
      clientNonce: aliceId
    });
    expect(withLink.validatedLink).toBe("https://example.com/request");
  });

  it("rejects unknown request fields, multiple links, malformed links, and unsafe schemes", () => {
    const base = { recipientUserId: bobId, clientNonce: aliceId };
    expect(CreateMessageRequestSchema.safeParse({ ...base, body: "Hello", admin: true }).success).toBe(false);
    expect(CreateMessageRequestSchema.safeParse({
      ...base,
      body: "https://one.example https://two.example"
    }).success).toBe(false);
    expect(CreateMessageRequestSchema.safeParse({ ...base, body: "ftp://example.com/file" }).success).toBe(false);
    expect(CreateMessageRequestSchema.safeParse({ ...base, body: "javascript:alert(1)" }).success).toBe(false);
    expect(CreateMessageRequestSchema.safeParse({ ...base, body: "http://" }).success).toBe(false);
  });

  it("allows the recipient state machine while making dismissal unrepresentable to the sender", () => {
    const common = {
      id: requestId,
      body: "Hello",
      createdAt: timestamp,
      expiresAt: "2026-09-02T12:00:00.000Z"
    };

    expect(MessageRequestRecipientProjectionSchema.safeParse({
      ...common,
      direction: "incoming",
      state: "recipient_dismissed",
      sender: { ...profile, id: aliceId, username: "alice_1" }
    }).success).toBe(true);

    expect(MessageRequestSenderProjectionSchema.safeParse({
      ...common,
      direction: "outgoing",
      state: "recipient_dismissed",
      recipient: profile
    }).success).toBe(false);

    expect(MessageRequestRecipientProjectionSchema.safeParse({
      ...common,
      direction: "incoming",
      state: "pending",
      sender: { ...profile, presence: "online" }
    }).success).toBe(false);
  });

  it("keeps block list entries privacy-safe and internally consistent", () => {
    expect(BlockListResponseSchema.safeParse({
      items: [{ accountId: bobId, profileSnapshot: profile, blockedAt: timestamp }],
      nextCursor: null
    }).success).toBe(true);
    expect(BlockListResponseSchema.safeParse({
      items: [{ accountId: aliceId, profileSnapshot: profile, blockedAt: timestamp }],
      nextCursor: null
    }).success).toBe(false);
    expect(BlockListResponseSchema.safeParse({
      items: [{ accountId: bobId, profileSnapshot: { ...profile, email: "hidden@example.com" }, blockedAt: timestamp }],
      nextCursor: null
    }).success).toBe(false);
  });

  it("accepts only exact selected message evidence and returns a non-content report summary", () => {
    const report = {
      subjectAccountId: bobId,
      category: "spam",
      evidence: [{ type: "message", messageId: requestId }],
      comment: "Unwanted request",
      alsoBlock: true,
      clientNonce: aliceId
    };
    expect(CreateSafetyReportSchema.safeParse(report).success).toBe(true);
    expect(CreateSafetyReportSchema.safeParse({
      ...report,
      evidence: [{ type: "message", messageId: requestId, neighboringMessages: true }]
    }).success).toBe(false);
    expect(CreateSafetyReportSchema.safeParse({
      ...report,
      evidence: [report.evidence[0], report.evidence[0]]
    }).success).toBe(false);
    expect(CreateSafetyReportSchema.safeParse({ ...report, evidence: [] }).success).toBe(false);
    expect(CreateSafetyReportSchema.safeParse({ ...report, category: "impersonation", evidence: [] }).success).toBe(true);
    expect(CreateSafetyReportSchema.safeParse({
      ...report,
      evidence: Array.from({ length: 21 }, (_, index) => ({
        type: "message",
        messageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
      }))
    }).success).toBe(false);

    const summary = {
      id: reportId,
      subjectAccountId: bobId,
      category: "spam",
      evidenceCount: 1,
      alsoBlocked: true,
      status: "submitted",
      submittedAt: timestamp
    };
    expect(SafetyReportSummarySchema.safeParse(summary).success).toBe(true);
    expect(SafetyReportSummarySchema.safeParse({ ...summary, comment: "must not echo" }).success).toBe(false);
  });

  it("keeps IA-1 events out of strict v1 while v2 dispatch accepts messaging and IA-1", () => {
    const cursor = `luxora-rt1.${"a".repeat(96)}.${"b".repeat(43)}`;
    const blockChanged = {
      type: "relationship.block.changed",
      audience: "actor_account",
      accountId: bobId,
      blocked: true,
      changedAt: timestamp
    };
    expect(IA1RealtimeEventSchema.safeParse(blockChanged).success).toBe(true);
    expect(RealtimeEventSchema.safeParse(blockChanged).success).toBe(false);
    expect(DurableRealtimeEventSchema.safeParse(blockChanged).success).toBe(true);
    expect(DurableRealtimeEventSchema.safeParse({
      type: "message.unpinned",
      chatId: aliceId,
      messageId: requestId
    }).success).toBe(true);

    expect(IA1ServerRealtimeMessageSchema.safeParse({
      type: "dispatch",
      sequence: 42,
      cursor,
      event: blockChanged
    }).success).toBe(true);
    expect(IA1ServerRealtimeMessageSchema.safeParse({
      type: "hello",
      protocolVersion: 2,
      connectionId: requestId,
      heartbeatIntervalMs: 30_000
    }).success).toBe(true);
    expect(IA1ServerRealtimeMessageSchema.safeParse({
      type: "hello",
      protocolVersion: 1,
      connectionId: requestId,
      heartbeatIntervalMs: 30_000
    }).success).toBe(false);

    expect(IA1ServerRealtimeMessageSchema.safeParse({
      type: "ready",
      userId: aliceId,
      sessionId: requestId,
      sequence: 40,
      headSequence: 42,
      cursor,
      resumed: true,
      resumeMode: "scoped_cursor",
      retention: {
        maxReplayEvents: REALTIME_MAX_REPLAY_EVENTS,
        cursorTtlSeconds: REALTIME_CURSOR_TTL_SECONDS
      }
    }).success).toBe(true);
    expect(IA1ServerRealtimeMessageSchema.safeParse({
      type: "sync.required",
      reason: "cursor_scope_mismatch",
      headSequence: 42,
      recovery: { type: "http_snapshot", path: "/v2/sync/snapshot" }
    }).success).toBe(true);
  });

  it("defines a bounded authoritative snapshot boundary without payload data", () => {
    const cursor = `luxora-rt1.${"a".repeat(96)}.${"b".repeat(43)}`;
    const snapshot = {
      contractVersion: 1,
      scope: "account_session",
      boundary: {
        sequence: 42,
        cursor,
        capturedAt: timestamp,
        cursorExpiresAt: "2026-08-10T12:00:00.000Z"
      },
      reset: {
        required: true,
        collections: [
          "message_requests",
          "blocks",
          "chats",
          "members",
          "messages",
          "pins",
          "topics",
          "reactions",
          "receipts",
          "attachments",
          "safety_reports"
        ]
      },
      resources: {
        incomingMessageRequests: "/v1/message-requests?direction=incoming",
        outgoingMessageRequests: "/v1/message-requests?direction=outgoing",
        blocks: "/v2/sync/blocks",
        chats: "/v2/sync/chats",
        attachments: "/v1/attachments",
        safetyReports: "/v1/safety/reports",
        membersTemplate: "/v1/chats/{chatId}/members",
        messagesTemplate: "/v1/chats/{chatId}/messages",
        pinsTemplate: "/v1/chats/{chatId}/pins",
        topicsTemplate: "/v1/chats/{chatId}/topics",
        reactionsTemplate: "/v1/messages/{messageId}/reactions",
        receiptsTemplate: "/v1/messages/{messageId}/receipts"
      },
      pagination: {
        cursorParameter: "cursor",
        limitParameter: "limit",
        nextCursorField: "nextCursor",
        maxPageSize: 100
      },
      resume: {
        websocketPath: "/v2/realtime",
        authenticateField: "resumeCursor",
        applyEventsIdempotently: true,
        sequenceAdjacencyRequired: false
      }
    };
    expect(RealtimeSnapshotResponseSchema.parse(snapshot)).toEqual(snapshot);
    expect(RealtimeSnapshotResponseSchema.safeParse({
      ...snapshot,
      messageSnippet: "must never be embedded"
    }).success).toBe(false);
    expect(RealtimeSnapshotResponseSchema.safeParse({
      ...snapshot,
      reset: {
        required: true,
        collections: Array.from({ length: 11 }, () => "chats")
      }
    }).success).toBe(false);
  });

  it("has no sender-visible dismiss event and cannot address block or report events to their subject", () => {
    expect(IA1RealtimeEventSchema.safeParse({
      type: "relationship.request.removed",
      audience: "recipient_account",
      requestId,
      removedAt: timestamp
    }).success).toBe(true);
    expect(IA1RealtimeEventSchema.safeParse({
      type: "relationship.request.removed",
      audience: "sender_account",
      requestId,
      removedAt: timestamp
    }).success).toBe(false);
    expect(IA1RealtimeEventSchema.safeParse({
      type: "relationship.request.dismissed",
      audience: "sender_account",
      requestId,
      dismissedAt: timestamp
    }).success).toBe(false);
    expect(IA1RealtimeEventSchema.safeParse({
      type: "relationship.block.changed",
      audience: "target_account",
      accountId: bobId,
      blocked: true,
      changedAt: timestamp
    }).success).toBe(false);
    expect(IA1RealtimeEventSchema.safeParse({
      type: "safety.report.submitted",
      audience: "subject_account",
      report: {
        id: reportId,
        subjectAccountId: bobId,
        category: "spam",
        evidenceCount: 1,
        alsoBlocked: false,
        status: "submitted",
        submittedAt: timestamp
      }
    }).success).toBe(false);
  });
});
