import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AddChatMemberRequestSchema,
  CheckPhoneUsernameSchema,
  CompletePhonePasswordChallengeSchema,
  ConfigurePhonePasswordSchema,
  createCapabilitiesResponseV1,
  CreateChatFolderRequestSchema,
  CreateChatRequestSchema,
  CreateMessageRequestSchema,
  CreateSafetyReportSchema,
  CreateTopicRequestSchema,
  CreateUploadRequestSchema,
  CursorQuerySchema,
  DeleteChatDraftRequestSchema,
  DeleteChatFolderRequestSchema,
  DisablePhonePasswordSchema,
  EditMessageRequestSchema,
  ForwardMessageRequestSchema,
  IdSchema,
  LoginRequestSchema,
  MarkReadRequestSchema,
  PatchChatPreferencesSchema,
  PatchChatFolderRequestSchema,
  PatchNotificationSettingsSchema,
  PatchCurrentUserSchema,
  PatchPrivacySettingsSchema,
  PutChatDraftRequestSchema,
  CompletePhoneRegistrationSchema,
  CompletePhoneRecoverySchema,
  CompletePhoneBindingSchema,
  ReactionRequestSchema,
  RELEASE_LABEL,
  RefreshRequestSchema,
  RequestPhoneChallengeSchema,
  RemoveChatMemberRequestSchema,
  ReorderChatFoldersRequestSchema,
  SetProfileAvatarSchema,
  RegisterRequestSchema,
  SearchQuerySchema,
  SendMessageRequestSchema,
  StartPhoneBindingSchema,
  StartPhoneRecoverySchema,
  UsernameSchema,
  UpdateChatMemberRoleRequestSchema,
  UpdateTopicRequestSchema,
  UpsertPushRegistrationSchema,
  VerifyPhoneChallengeSchema
} from "@luxora/protocol";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Store } from "../domain/store.js";
import { AppError, badRequest, unauthenticated } from "../errors.js";
import type { ByteRange, StorageProvider } from "../infrastructure/storage.js";
import type { Metrics } from "../metrics.js";
import type { AttachmentService } from "../services/attachment-service.js";
import type { AuthService } from "../services/auth-service.js";
import type { AdminService } from "../services/admin-service.js";
import type { ChatService } from "../services/chat-service.js";
import type { ChatDraftService } from "../services/chat-draft-service.js";
import type { ChatFolderService } from "../services/chat-folder-service.js";
import type { IdentityAccessService } from "../services/identity-access-service.js";
import type { NotificationService } from "../services/notification-service.js";
import type { PhoneAuthService } from "../services/phone-auth-service.js";
import type { ProfileAvatarService } from "../services/profile-avatar-service.js";
import type { SearchService } from "../services/search-service.js";
import type { UploadService } from "../services/upload-service.js";
import { createIdentityRateLimitGuards } from "./identity-rate-limit.js";

const IdParamSchema = z.object({ id: IdSchema });
const MessageIdParamSchema = z.object({ messageId: IdSchema });
const ChatMessageParamSchema = z.object({ id: IdSchema, messageId: IdSchema });
const ChatMemberParamSchema = z.object({ id: IdSchema, userId: IdSchema }).strict();
const UploadChunkParamSchema = z.object({ id: IdSchema, index: z.coerce.number().int().nonnegative() });
const TopicParamSchema = z.object({ id: IdSchema });
const AccountParamSchema = z.object({ accountId: IdSchema }).strict();
const ExactUsernameQuerySchema = z.object({ username: UsernameSchema }).strict();
const MessageRequestListQuerySchema = CursorQuerySchema.extend({
  direction: z.enum(["incoming", "outgoing"])
}).strict();
const UserSearchSchema = CursorQuerySchema.extend({ q: z.string().trim().min(1).max(80) });
const ChatMessagesQuerySchema = CursorQuerySchema.extend({ topicId: IdSchema.optional() });
const FileSearchQuerySchema = CursorQuerySchema.extend({ q: z.string().trim().min(1).max(200) });

interface RouteDependencies {
  config: AppConfig;
  store: Store;
  auth: AuthService;
  chats: ChatService;
  chatDrafts: ChatDraftService;
  chatFolders: ChatFolderService;
  identity: IdentityAccessService;
  notifications: NotificationService;
  phoneAuth: PhoneAuthService;
  profileAvatars: ProfileAvatarService;
  uploads: UploadService;
  attachments: AttachmentService;
  search: SearchService;
  admin: AdminService;
  storage: StorageProvider;
  metrics: Metrics;
  serverSearchConfigured: boolean;
  authGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function parseChunkRange(value: string | string[] | undefined): { start: number; end: number; total: number } {
  if (typeof value !== "string") throw badRequest("Content-Range header is required");
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (match === null) throw badRequest("Content-Range must use 'bytes start-end/total'");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) {
    throw badRequest("Content-Range contains invalid byte offsets");
  }
  return { start, end, total };
}

function parseDownloadRange(value: string | undefined, totalSize: number, reply: FastifyReply): ByteRange | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => {
    reply.header("content-range", `bytes */${totalSize}`);
    throw new AppError(416, "BAD_REQUEST", "Requested byte range is not satisfiable");
  };
  if (value.includes(",")) return invalid();
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return invalid();
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return invalid();
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? totalSize - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) {
      return invalid();
    }
    end = Math.min(end, totalSize - 1);
  }
  return { start, end };
}

function contentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(/['()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function hasMetricsToken(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function requireAdminToken(request: FastifyRequest, configured: string | undefined): void {
  if (configured === undefined) {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Administration is not enabled");
  }
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    throw unauthenticated("Admin token required");
  }
  const actual = Buffer.from(header.slice(7));
  const target = Buffer.from(configured);
  if (actual.length !== target.length || !timingSafeEqual(actual, target)) {
    throw unauthenticated("Admin token required");
  }
}

export function registerHttpRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  const identityRateLimits = createIdentityRateLimitGuards(app);

  app.get("/health/live", async () => ({ status: "ok", release: RELEASE_LABEL }));
  app.get("/health/ready", async (_request, reply) => {
    let ready = false;
    try {
      ready = dependencies.store.ping() &&
        await dependencies.storage.ready() &&
        await dependencies.uploads.ready();
    } catch {
      ready = false;
    }
    if (!ready) {
      return reply.code(503).send({ status: "not_ready" });
    }
    return reply.send({ status: "ready", release: RELEASE_LABEL });
  });
  app.get("/metrics", async (request, reply) => {
    if (
      dependencies.config.metricsToken !== undefined &&
      !hasMetricsToken(request, dependencies.config.metricsToken)
    ) {
      throw unauthenticated("Metrics token required");
    }
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(dependencies.metrics.render());
  });

  app.get("/v1/capabilities", async () => createCapabilitiesResponseV1({
    maxAttachmentBytes: dependencies.config.maxAttachmentBytes,
    userStorageQuotaBytes: dependencies.config.userStorageQuotaBytes,
    uploadChunkSizeBytes: dependencies.config.uploadChunkSizeBytes,
    uploadSessionTtlSeconds: dependencies.config.uploadSessionTtlMinutes * 60,
    serverSearchConfigured: dependencies.serverSearchConfigured,
    phoneAuthenticationAvailable: dependencies.phoneAuth.available
  }, dependencies.config.syncInvalidationEnabled));

  app.post("/v1/auth/phone/challenges", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = RequestPhoneChallengeSchema.parse(request.body);
    return reply.code(201).send(await dependencies.phoneAuth.requestChallenge(input));
  });

  app.post("/v1/auth/phone/challenges/:id/verify", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = VerifyPhoneChallengeSchema.parse(request.body);
    return reply.send(await dependencies.phoneAuth.verifyChallenge(id, input));
  });

  app.post("/v1/auth/phone/password", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CompletePhonePasswordChallengeSchema.parse(request.body);
    return reply.send(await dependencies.phoneAuth.completePassword(input));
  });

  app.post("/v1/auth/phone/registrations", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CompletePhoneRegistrationSchema.parse(request.body);
    return reply.code(201).send(await dependencies.phoneAuth.completeRegistration(input));
  });

  app.post("/v1/auth/phone/usernames/check", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CheckPhoneUsernameSchema.parse(request.body);
    return reply.send(dependencies.phoneAuth.checkUsername(input));
  });

  app.post("/v1/auth/phone/recovery/start", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = StartPhoneRecoverySchema.parse(request.body);
    return reply.code(201).send(await dependencies.phoneAuth.startRecovery(input));
  });

  app.post("/v1/auth/phone/recovery/complete", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CompletePhoneRecoverySchema.parse(request.body);
    return reply.send(await dependencies.phoneAuth.completeRecovery(input));
  });

  app.post("/v1/me/phone/binding/challenges", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = StartPhoneBindingSchema.parse(request.body);
    return reply.code(201).send(await dependencies.phoneAuth.beginBinding(
      request.auth.userId,
      input
    ));
  });

  app.post("/v1/me/phone/binding/complete", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const input = CompletePhoneBindingSchema.parse(request.body);
    return dependencies.phoneAuth.completeBinding(request.auth.userId, input);
  });

  app.post("/v1/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = RegisterRequestSchema.parse(request.body);
    return reply.code(201).send(await dependencies.auth.register(input));
  });

  app.post("/v1/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = LoginRequestSchema.parse(request.body);
    return reply.send(await dependencies.auth.login(input));
  });

  app.post("/v1/auth/refresh", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = RefreshRequestSchema.parse(request.body);
    return reply.send({ tokens: await dependencies.auth.refresh(input.refreshToken) });
  });

  app.get("/v1/auth/sessions", { preHandler: dependencies.authGuard }, async (request) => ({
    items: dependencies.auth.listSessions(request.auth)
  }));

  app.delete("/v1/auth/sessions/current", { preHandler: dependencies.authGuard }, async (request, reply) => {
    dependencies.auth.revokeSession(request.auth, request.auth.sessionId);
    return reply.code(204).send();
  });

  app.delete("/v1/auth/sessions/:id", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    dependencies.auth.revokeSession(request.auth, id);
    return reply.code(204).send();
  });

  app.get("/v1/me", { preHandler: dependencies.authGuard }, async (request) => ({
    user: dependencies.auth.getUser(request.auth.userId)
  }));

  app.patch("/v1/me", { preHandler: dependencies.authGuard }, async (request) => {
    const input = PatchCurrentUserSchema.parse(request.body);
    return { user: dependencies.auth.updateUser(request.auth.userId, input) };
  });

  app.put("/v1/me/avatar", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request) => {
    const input = SetProfileAvatarSchema.parse(request.body);
    return { user: await dependencies.profileAvatars.set(request.auth.userId, input.attachmentId) };
  });

  app.delete("/v1/me/avatar", { preHandler: dependencies.authGuard }, async (request) => ({
    user: dependencies.profileAvatars.clear(request.auth.userId)
  }));

  app.get("/v1/me/phone-password", { preHandler: dependencies.authGuard }, async (request) =>
    dependencies.auth.phonePasswordStatus(request.auth.userId)
  );

  app.put("/v1/me/phone-password", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const input = ConfigurePhonePasswordSchema.parse(request.body);
    return dependencies.auth.configurePhonePassword(request.auth.userId, input);
  });

  app.delete("/v1/me/phone-password", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const input = DisablePhonePasswordSchema.parse(request.body);
    return dependencies.auth.disablePhonePassword(request.auth.userId, input);
  });

  app.get("/v1/push/registrations/current", {
    preHandler: dependencies.authGuard
  }, async (request) => ({
    registration: dependencies.notifications.currentRegistration(request.auth)
  }));

  app.put("/v1/push/registrations/current", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request) => {
    const input = UpsertPushRegistrationSchema.parse(request.body);
    return { registration: dependencies.notifications.register(request.auth, input) };
  });

  app.delete("/v1/push/registrations/current", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    dependencies.notifications.unregister(request.auth);
    return reply.code(204).send();
  });

  app.get("/v1/notifications/settings", {
    preHandler: dependencies.authGuard
  }, async (request) => ({
    settings: dependencies.notifications.settings(request.auth.userId)
  }));

  app.patch("/v1/notifications/settings", {
    preHandler: dependencies.authGuard
  }, async (request) => {
    const input = PatchNotificationSettingsSchema.parse(request.body);
    return {
      settings: dependencies.notifications.updateSettings(request.auth.userId, input)
    };
  });

  app.get("/v1/users/search", {
    preHandler: [dependencies.authGuard, identityRateLimits.discovery],
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request) => {
    const query = UserSearchSchema.parse(request.query);
    return dependencies.identity.searchKnownUsers(
      request.auth.userId,
      query.q,
      query.limit,
      query.cursor
    );
  });

  app.get("/v1/users/lookup", {
    preHandler: [dependencies.authGuard, identityRateLimits.discovery],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request) => {
    const { username } = ExactUsernameQuerySchema.parse(request.query);
    return { profile: dependencies.identity.lookupUser(request.auth.userId, username) };
  });

  app.get("/v1/privacy", { preHandler: dependencies.authGuard }, async (request) => ({
    settings: dependencies.identity.getPrivacySettings(request.auth.userId)
  }));

  app.patch("/v1/privacy", { preHandler: dependencies.authGuard }, async (request) => {
    const input = PatchPrivacySettingsSchema.parse(request.body);
    return { settings: dependencies.identity.updatePrivacySettings(request.auth.userId, input) };
  });

  app.post("/v1/message-requests", {
    preHandler: [dependencies.authGuard, identityRateLimits.requestCreate],
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CreateMessageRequestSchema.parse(request.body);
    return reply.code(201).send({
      request: dependencies.identity.createMessageRequest(request.auth.userId, input)
    });
  });

  app.get("/v1/message-requests", { preHandler: dependencies.authGuard }, async (request) => {
    const query = MessageRequestListQuerySchema.parse(request.query);
    return dependencies.identity.listMessageRequests(
      request.auth.userId,
      query.direction,
      query.limit,
      query.cursor
    );
  });

  app.post("/v1/message-requests/:id/accept", {
    preHandler: [dependencies.authGuard, identityRateLimits.relationshipMutation],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return dependencies.identity.acceptMessageRequest(request.auth.userId, id);
  });

  app.delete("/v1/message-requests/:id", {
    preHandler: [dependencies.authGuard, identityRateLimits.relationshipMutation],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    dependencies.identity.dismissMessageRequest(request.auth.userId, id);
    return reply.code(204).send();
  });

  app.put("/v1/blocks/:accountId", {
    preHandler: [dependencies.authGuard, identityRateLimits.relationshipMutation],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request) => {
    const { accountId } = AccountParamSchema.parse(request.params);
    return dependencies.identity.blockAccount(request.auth.userId, accountId);
  });

  app.delete("/v1/blocks/:accountId", {
    preHandler: [dependencies.authGuard, identityRateLimits.relationshipMutation],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request) => {
    const { accountId } = AccountParamSchema.parse(request.params);
    return dependencies.identity.unblockAccount(request.auth.userId, accountId);
  });

  app.get("/v1/blocks", { preHandler: dependencies.authGuard }, async (request) => {
    const query = CursorQuerySchema.parse(request.query);
    return dependencies.identity.listBlocks(request.auth.userId, query.limit, query.cursor);
  });

  app.post("/v1/safety/reports", {
    preHandler: [dependencies.authGuard, identityRateLimits.safetyReport],
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const input = CreateSafetyReportSchema.parse(request.body);
    return reply.code(201).send({
      report: dependencies.identity.createSafetyReport(request.auth.userId, input)
    });
  });

  app.get("/v1/chat-folders", { preHandler: dependencies.authGuard }, async (request) => {
    return dependencies.chatFolders.list(request.auth.userId);
  });

  app.post("/v1/chat-folders", {
    preHandler: [dependencies.authGuard, identityRateLimits.chatFolderMutation],
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CreateChatFolderRequestSchema.parse(request.body);
    return reply.code(201).send(dependencies.chatFolders.create(request.auth.userId, input));
  });

  app.put("/v1/chat-folders/order", {
    preHandler: [dependencies.authGuard, identityRateLimits.chatFolderMutation],
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request) => {
    const input = ReorderChatFoldersRequestSchema.parse(request.body);
    return dependencies.chatFolders.reorder(request.auth.userId, input);
  });

  app.patch("/v1/chat-folders/:id", {
    preHandler: [dependencies.authGuard, identityRateLimits.chatFolderMutation],
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = PatchChatFolderRequestSchema.parse(request.body);
    return dependencies.chatFolders.patch(request.auth.userId, id, input);
  });

  app.delete("/v1/chat-folders/:id", {
    preHandler: [dependencies.authGuard, identityRateLimits.chatFolderMutation],
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = DeleteChatFolderRequestSchema.parse(request.body);
    return dependencies.chatFolders.delete(request.auth.userId, id, input);
  });

  app.get("/v1/chats", { preHandler: dependencies.authGuard }, async (request) => {
    const query = CursorQuerySchema.parse(request.query);
    return dependencies.chats.listChats(request.auth.userId, query.limit, query.cursor);
  });

  app.post("/v1/chats", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const input = CreateChatRequestSchema.parse(request.body);
    return reply.code(201).send({ chat: dependencies.chats.createChat(request.auth.userId, input) });
  });

  app.get("/v1/chats/:id", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { chat: dependencies.chats.getChat(request.auth.userId, id) };
  });

  app.get("/v1/chats/:id/preferences", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { preferences: dependencies.chats.getPreferences(request.auth.userId, id) };
  });

  app.patch("/v1/chats/:id/preferences", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = PatchChatPreferencesSchema.parse(request.body);
    return { preferences: dependencies.chats.updatePreferences(request.auth.userId, id, input) };
  });

  app.get("/v1/chats/:id/draft", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return dependencies.chatDrafts.get(request.auth.userId, id);
  });

  app.put("/v1/chats/:id/draft", {
    preHandler: [dependencies.authGuard, identityRateLimits.chatDraftMutation],
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = PutChatDraftRequestSchema.parse(request.body);
    return dependencies.chatDrafts.put(request.auth.userId, id, input);
  });

  app.delete("/v1/chats/:id/draft", {
    preHandler: [dependencies.authGuard, identityRateLimits.chatDraftMutation],
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = DeleteChatDraftRequestSchema.parse(request.body);
    return dependencies.chatDrafts.delete(request.auth.userId, id, input);
  });

  app.get("/v1/chats/:id/members", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return dependencies.chats.listMembers(request.auth.userId, id);
  });

  app.post("/v1/chats/:id/members", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = AddChatMemberRequestSchema.parse(request.body);
    return reply.code(201).send(dependencies.chats.addMember(request.auth.userId, id, input));
  });

  app.patch("/v1/chats/:id/members/:userId", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id, userId } = ChatMemberParamSchema.parse(request.params);
    const input = UpdateChatMemberRoleRequestSchema.parse(request.body);
    return dependencies.chats.updateMemberRole(request.auth.userId, id, userId, input);
  });

  app.delete("/v1/chats/:id/members/:userId", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id, userId } = ChatMemberParamSchema.parse(request.params);
    const input = RemoveChatMemberRequestSchema.parse(request.body);
    return dependencies.chats.removeMember(request.auth.userId, id, userId, input);
  });

  app.get("/v1/chats/:id/messages", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const query = ChatMessagesQuerySchema.parse(request.query);
    return dependencies.chats.listMessages(request.auth.userId, id, query.limit, query.cursor, query.topicId);
  });

  app.post("/v1/chats/:id/messages", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = SendMessageRequestSchema.parse(request.body);
    return reply.code(201).send({ message: dependencies.chats.sendMessage(request.auth.userId, id, input) });
  });

  app.patch("/v1/messages/:messageId", { preHandler: dependencies.authGuard }, async (request) => {
    const { messageId } = MessageIdParamSchema.parse(request.params);
    const input = EditMessageRequestSchema.parse(request.body);
    return { message: dependencies.chats.editMessage(request.auth.userId, messageId, input) };
  });

  app.delete("/v1/messages/:messageId", { preHandler: dependencies.authGuard }, async (request) => {
    const { messageId } = MessageIdParamSchema.parse(request.params);
    return { message: dependencies.chats.deleteMessage(request.auth.userId, messageId) };
  });

  app.get("/v1/messages/:messageId/history", { preHandler: dependencies.authGuard }, async (request) => {
    const { messageId } = MessageIdParamSchema.parse(request.params);
    return { items: dependencies.chats.getMessageHistory(request.auth.userId, messageId) };
  });

  app.post("/v1/messages/:messageId/forward", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const { messageId } = MessageIdParamSchema.parse(request.params);
    const input = ForwardMessageRequestSchema.parse(request.body);
    return reply.code(201).send({ message: dependencies.chats.forwardMessage(request.auth.userId, messageId, input) });
  });

  app.get("/v1/chats/:id/pins", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { items: dependencies.chats.listPins(request.auth.userId, id) };
  });

  app.put("/v1/chats/:id/pins/:messageId", { preHandler: dependencies.authGuard }, async (request) => {
    const { id, messageId } = ChatMessageParamSchema.parse(request.params);
    return { pin: dependencies.chats.pinMessage(request.auth.userId, id, messageId) };
  });

  app.delete("/v1/chats/:id/pins/:messageId", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const { id, messageId } = ChatMessageParamSchema.parse(request.params);
    dependencies.chats.unpinMessage(request.auth.userId, id, messageId);
    return reply.code(204).send();
  });

  app.get("/v1/chats/:id/topics", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { items: dependencies.chats.listTopics(request.auth.userId, id) };
  });

  app.post("/v1/chats/:id/topics", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = CreateTopicRequestSchema.parse(request.body);
    return reply.code(201).send({ topic: dependencies.chats.createTopic(request.auth.userId, id, input) });
  });

  app.patch("/v1/topics/:id", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = TopicParamSchema.parse(request.params);
    const input = UpdateTopicRequestSchema.parse(request.body);
    return { topic: dependencies.chats.updateTopic(request.auth.userId, id, input) };
  });

  app.post("/v1/uploads", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CreateUploadRequestSchema.parse(request.body);
    return reply.code(201).send({ upload: dependencies.uploads.createSession(request.auth.userId, input) });
  });

  app.get("/v1/uploads/:id", { preHandler: dependencies.authGuard }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { upload: dependencies.uploads.getSession(request.auth.userId, id) };
  });

  app.put("/v1/uploads/:id/chunks/:index", {
    onRequest: dependencies.authGuard,
    bodyLimit: dependencies.config.uploadChunkSizeBytes,
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id, index } = UploadChunkParamSchema.parse(request.params);
    if (!Buffer.isBuffer(request.body)) throw badRequest("Chunk body must be application/octet-stream");
    const range = parseChunkRange(request.headers["content-range"]);
    const sha256 = request.headers["x-chunk-sha256"];
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw badRequest("X-Chunk-SHA256 must be a lowercase SHA-256 hex digest");
    }
    const contentLength = request.headers["content-length"];
    if (contentLength === undefined || Number(contentLength) !== request.body.length) {
      throw badRequest("Content-Length must exactly match the chunk body");
    }
    return {
      upload: await dependencies.uploads.putChunk(request.auth.userId, id, {
        index,
        ...range,
        sha256,
        bytes: request.body
      })
    };
  });

  app.post("/v1/uploads/:id/complete", {
    preHandler: dependencies.authGuard,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { upload: await dependencies.uploads.complete(request.auth.userId, id) };
  });

  app.get("/v1/attachments/:id/content", {
    onRequest: [async (_request, reply) => {
      reply
        .header("accept-ranges", "bytes")
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff");
    }, dependencies.authGuard]
  }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const record = dependencies.attachments.authorize(request.auth.userId, id);
    const range = parseDownloadRange(request.headers.range, record.sizeBytes, reply);
    const download = await dependencies.attachments.download(request.auth.userId, id, range);
    reply
      .header("content-disposition", contentDisposition(download.attachment.fileName, false))
      .header("content-length", download.content.contentLength)
      .header("content-type", download.attachment.detectedMimeType)
      .header("etag", `"${download.attachment.sha256}"`)
      .header("x-content-safety-status", "unscanned");
    if (download.content.range !== null) {
      reply.code(206).header(
        "content-range",
        `bytes ${download.content.range.start}-${download.content.range.end}/${download.content.totalSize}`
      );
    }
    return reply.send(download.content.stream);
  });

  app.get("/v1/search/messages", { preHandler: dependencies.authGuard }, async (request) => {
    const query = SearchQuerySchema.parse(request.query);
    return dependencies.search.messages(
      request.auth.userId,
      query.q,
      query.limit,
      query.cursor,
      query.chatId
    );
  });

  app.get("/v1/search/files", { preHandler: dependencies.authGuard }, async (request) => {
    const query = FileSearchQuerySchema.parse(request.query);
    return dependencies.search.attachments(request.auth.userId, query.q, query.limit, query.cursor);
  });

  app.get("/v1/admin/status", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    requireAdminToken(request, dependencies.config.adminToken);
    return reply.header("cache-control", "private, no-store").send(dependencies.admin.status());
  });

  app.get("/v1/admin/users", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    requireAdminToken(request, dependencies.config.adminToken);
    const query = CursorQuerySchema.parse(request.query);
    return reply.header("cache-control", "private, no-store")
      .send(dependencies.admin.users(query.limit, query.cursor ?? undefined));
  });

  app.get("/v1/admin/chats", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    requireAdminToken(request, dependencies.config.adminToken);
    const query = CursorQuerySchema.parse(request.query);
    return reply.header("cache-control", "private, no-store")
      .send(dependencies.admin.chats(query.limit, query.cursor ?? undefined));
  });

  app.post("/v1/chats/:id/read", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = MarkReadRequestSchema.parse(request.body);
    dependencies.chats.markRead(request.auth.userId, id, input.messageId);
    return reply.code(204).send();
  });

  app.post("/v1/chats/:id/delivered", { preHandler: dependencies.authGuard }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const input = MarkReadRequestSchema.parse(request.body);
    dependencies.chats.markDelivered(request.auth.userId, id, input.messageId);
    return reply.code(204).send();
  });

  app.put("/v1/messages/:messageId/reactions", { preHandler: dependencies.authGuard }, async (request) => {
    const { messageId } = MessageIdParamSchema.parse(request.params);
    const { emoji } = ReactionRequestSchema.parse(request.body);
    return { items: dependencies.chats.setReaction(request.auth.userId, messageId, emoji, true) };
  });

  app.delete("/v1/messages/:messageId/reactions", { preHandler: dependencies.authGuard }, async (request) => {
    const { messageId } = MessageIdParamSchema.parse(request.params);
    const { emoji } = ReactionRequestSchema.parse(request.body);
    return { items: dependencies.chats.setReaction(request.auth.userId, messageId, emoji, false) };
  });
}
