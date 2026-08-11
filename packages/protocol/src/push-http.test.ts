import { describe, expect, it } from "vitest";
import {
  NotificationSettingsSchema,
  PatchNotificationSettingsSchema,
  PushRegistrationSchema,
  UpsertPushRegistrationSchema
} from "./index.js";

describe("push registration HTTP contract", () => {
  it("normalizes bounded APNs bytes without assuming Apple's token size", () => {
    expect(UpsertPushRegistrationSchema.parse({
      platform: "apns",
      environment: "development",
      token: "AB".repeat(32)
    })).toEqual({
      platform: "apns",
      environment: "development",
      token: "ab".repeat(32)
    });

    expect(UpsertPushRegistrationSchema.safeParse({
      platform: "apns",
      environment: "development",
      token: "a".repeat(33)
    }).success).toBe(false);
    expect(UpsertPushRegistrationSchema.safeParse({
      platform: "fcm",
      environment: "development",
      token: "ab".repeat(32)
    }).success).toBe(false);
    expect(UpsertPushRegistrationSchema.safeParse({
      platform: "apns",
      environment: "production",
      token: "ab".repeat(32),
      topic: "attacker.example"
    }).success).toBe(false);
  });

  it("keeps registration projections token-free and server-topic-bound", () => {
    const parsed = PushRegistrationSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      platform: "apns",
      environment: "production",
      topic: "app.luxora.mobile",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z"
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "createdAt",
      "environment",
      "id",
      "platform",
      "topic",
      "updatedAt"
    ]);
  });
});

describe("notification preference HTTP contract", () => {
  it("requires a real strict patch and accepts privacy-minimized defaults", () => {
    expect(PatchNotificationSettingsSchema.safeParse({}).success).toBe(false);
    expect(PatchNotificationSettingsSchema.safeParse({ sound: true, unknown: false }).success).toBe(false);
    expect(PatchNotificationSettingsSchema.parse({ previewMode: "hidden", sound: false })).toEqual({
      previewMode: "hidden",
      sound: false
    });

    expect(NotificationSettingsSchema.parse({
      messageAlerts: true,
      messageRequestAlerts: true,
      mentionAlerts: true,
      sound: true,
      badge: true,
      previewMode: "hidden",
      updatedAt: "2026-08-11T00:00:00.000Z"
    }).previewMode).toBe("hidden");
  });
});
