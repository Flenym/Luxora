import { createHash, randomUUID } from "node:crypto";
import {
  NotificationSettingsSchema,
  PushRegistrationSchema,
  type NotificationSettings,
  type PatchNotificationSettings,
  type PushRegistration,
  type UpsertPushRegistration
} from "@luxora/protocol";
import type { AuthenticatedPrincipal } from "../domain/types.js";
import type { Store } from "../domain/store.js";

const IOS_PUSH_TOPIC = "app.luxora.mobile" as const;

export class NotificationService {
  constructor(
    private readonly store: Store,
    private readonly clock: () => Date = () => new Date()
  ) {}

  currentRegistration(principal: AuthenticatedPrincipal): PushRegistration | null {
    const record = this.store.findCurrentPushRegistration(principal.userId, principal.sessionId);
    if (record === null) return null;
    return PushRegistrationSchema.parse({
      id: record.id,
      platform: record.platform,
      environment: record.environment,
      topic: record.topic,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  }

  register(
    principal: AuthenticatedPrincipal,
    input: UpsertPushRegistration
  ): PushRegistration {
    const tokenDigest = createHash("sha256").update(input.token, "utf8").digest("hex");
    const record = this.store.upsertPushRegistration({
      id: randomUUID(),
      userId: principal.userId,
      sessionId: principal.sessionId,
      platform: input.platform,
      environment: input.environment,
      topic: IOS_PUSH_TOPIC,
      token: input.token,
      tokenDigest,
      at: this.clock().toISOString()
    });
    return PushRegistrationSchema.parse({
      id: record.id,
      platform: record.platform,
      environment: record.environment,
      topic: record.topic,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  }

  unregister(principal: AuthenticatedPrincipal): boolean {
    return this.store.revokeCurrentPushRegistration(
      principal.userId,
      principal.sessionId,
      this.clock().toISOString()
    );
  }

  settings(userId: string): NotificationSettings {
    const record = this.store.getNotificationSettings(userId);
    return NotificationSettingsSchema.parse({
      messageAlerts: record.messageAlerts,
      messageRequestAlerts: record.messageRequestAlerts,
      mentionAlerts: record.mentionAlerts,
      sound: record.sound,
      badge: record.badge,
      previewMode: record.previewMode,
      updatedAt: record.updatedAt
    });
  }

  updateSettings(userId: string, update: PatchNotificationSettings): NotificationSettings {
    const definedUpdate: Partial<{
      messageAlerts: boolean;
      messageRequestAlerts: boolean;
      mentionAlerts: boolean;
      sound: boolean;
      badge: boolean;
      previewMode: Exclude<PatchNotificationSettings["previewMode"], undefined>;
    }> = {};
    if (update.messageAlerts !== undefined) definedUpdate.messageAlerts = update.messageAlerts;
    if (update.messageRequestAlerts !== undefined) {
      definedUpdate.messageRequestAlerts = update.messageRequestAlerts;
    }
    if (update.mentionAlerts !== undefined) definedUpdate.mentionAlerts = update.mentionAlerts;
    if (update.sound !== undefined) definedUpdate.sound = update.sound;
    if (update.badge !== undefined) definedUpdate.badge = update.badge;
    if (update.previewMode !== undefined) definedUpdate.previewMode = update.previewMode;
    const record = this.store.updateNotificationSettings(
      userId,
      definedUpdate,
      this.clock().toISOString()
    );
    return NotificationSettingsSchema.parse({
      messageAlerts: record.messageAlerts,
      messageRequestAlerts: record.messageRequestAlerts,
      mentionAlerts: record.mentionAlerts,
      sound: record.sound,
      badge: record.badge,
      previewMode: record.previewMode,
      updatedAt: record.updatedAt
    });
  }
}
