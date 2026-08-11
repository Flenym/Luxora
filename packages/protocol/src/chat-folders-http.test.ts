import { describe, expect, it } from "vitest";
import {
  CapabilitiesResponseV1Schema,
  ChatFolderDeleteResponseSchema,
  ChatFolderListResponseSchema,
  ChatFolderMutationResponseSchema,
  ChatFolderOverrideSchema,
  ChatFolderOverridesSchema,
  ChatFolderReorderResponseSchema,
  ChatFolderRulesSchema,
  ChatFolderSchema,
  ChatFoldersRealtimeEventSchema,
  ChatFolderTitleSchema,
  CreateChatFolderRequestSchema,
  createCapabilitiesResponseV1,
  DeleteChatFolderRequestSchema,
  DurableRealtimeEventSchema,
  MAX_CHAT_FOLDERS,
  MAX_CHAT_FOLDER_OVERRIDES,
  MAX_CHAT_FOLDER_TITLE_LENGTH,
  PatchChatFolderRequestSchema,
  RealtimeEventSchema,
  ReorderChatFoldersRequestSchema
} from "./index.js";

const CREATED_AT = "2026-08-11T09:00:00.000Z";
const UPDATED_AT = "2026-08-11T09:01:00.000Z";

const idFor = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

const RULES = {
  includeKinds: ["direct", "group", "channel"],
  unreadOnly: false,
  excludeMuted: true,
  includeArchived: false
};

const folderFor = (value: number, position = value) => ({
  id: idFor(value + 1),
  title: `Папка ${value + 1}`,
  position,
  revision: 1,
  rules: RULES,
  overrides: [],
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT
});

describe("chat folder HTTP contract", () => {
  it("publishes the Beta-0.1 folder limits", () => {
    expect(MAX_CHAT_FOLDERS).toBe(10);
    expect(MAX_CHAT_FOLDER_TITLE_LENGTH).toBe(48);
    expect(MAX_CHAT_FOLDER_OVERRIDES).toBe(100);
  });

  it("advertises enabled chat folders and their exact public capability limits", () => {
    const capabilities = createCapabilitiesResponseV1({
      maxAttachmentBytes: 104_857_600,
      userStorageQuotaBytes: 1_073_741_824,
      uploadChunkSizeBytes: 1_048_576,
      uploadSessionTtlSeconds: 3_600,
      serverSearchConfigured: false,
      phoneAuthenticationAvailable: false
    });

    expect(capabilities.features.chatFolders).toBe(true);
    expect(capabilities.limits).toMatchObject({
      maxChatFolders: 10,
      maxChatFolderTitleLength: 48,
      maxChatFolderOverrides: 100
    });
    expect(CapabilitiesResponseV1Schema.safeParse({
      ...capabilities,
      features: { ...capabilities.features, chatFolders: false }
    }).success).toBe(false);
    for (const [limit, invalidValue] of [
      ["maxChatFolders", 11],
      ["maxChatFolderTitleLength", 49],
      ["maxChatFolderOverrides", 101]
    ] as const) {
      expect(CapabilitiesResponseV1Schema.safeParse({
        ...capabilities,
        limits: { ...capabilities.limits, [limit]: invalidValue }
      }).success).toBe(false);
    }
  });

  it("trims titles and counts their Unicode code points", () => {
    expect(ChatFolderTitleSchema.parse("  Работа  ")).toBe("Работа");
    expect(ChatFolderTitleSchema.safeParse(" ").success).toBe(false);
    expect(ChatFolderTitleSchema.safeParse("😀".repeat(MAX_CHAT_FOLDER_TITLE_LENGTH)).success).toBe(true);
    expect(ChatFolderTitleSchema.safeParse("😀".repeat(MAX_CHAT_FOLDER_TITLE_LENGTH + 1)).success).toBe(false);
  });

  it("requires complete strict rules with at most three unique chat kinds", () => {
    expect(ChatFolderRulesSchema.parse(RULES)).toEqual(RULES);
    expect(ChatFolderRulesSchema.safeParse({ ...RULES, includeKinds: [] }).success).toBe(true);
    expect(ChatFolderRulesSchema.safeParse({ ...RULES, includeKinds: ["direct", "direct"] }).success).toBe(false);
    expect(ChatFolderRulesSchema.safeParse({
      ...RULES,
      includeKinds: ["direct", "group", "channel", "direct"]
    }).success).toBe(false);
    expect(ChatFolderRulesSchema.safeParse({ ...RULES, includeKinds: ["bot"] }).success).toBe(false);
    expect(ChatFolderRulesSchema.safeParse({
      includeKinds: ["direct"],
      unreadOnly: false,
      excludeMuted: true
    }).success).toBe(false);
    expect(ChatFolderRulesSchema.safeParse({ ...RULES, unknown: true }).success).toBe(false);
  });

  it("keeps every override strict and permits pins only for included chats", () => {
    expect(ChatFolderOverrideSchema.parse({
      chatId: idFor(101),
      mode: "include",
      pinnedPosition: 0
    })).toEqual({ chatId: idFor(101), mode: "include", pinnedPosition: 0 });
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "include",
      pinnedPosition: 99
    }).success).toBe(true);
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "exclude",
      pinnedPosition: null
    }).success).toBe(true);
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "exclude",
      pinnedPosition: 0
    }).success).toBe(false);
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "include",
      pinnedPosition: -1
    }).success).toBe(false);
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "include",
      pinnedPosition: 100
    }).success).toBe(false);
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "include",
      pinnedPosition: 1.5
    }).success).toBe(false);
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "include"
    }).success).toBe(false);
    expect(ChatFolderOverrideSchema.safeParse({
      chatId: idFor(101),
      mode: "include",
      pinnedPosition: null,
      unknown: true
    }).success).toBe(false);
  });

  it("limits overrides and rejects duplicate canonical chat ids or pin positions", () => {
    const maximum = Array.from({ length: MAX_CHAT_FOLDER_OVERRIDES }, (_, index) => ({
      chatId: idFor(index + 200),
      mode: "include",
      pinnedPosition: index
    }));
    expect(ChatFolderOverridesSchema.safeParse(maximum).success).toBe(true);
    expect(ChatFolderOverridesSchema.safeParse([
      ...maximum,
      { chatId: idFor(999), mode: "include", pinnedPosition: null }
    ]).success).toBe(false);
    expect(ChatFolderOverridesSchema.safeParse([
      { chatId: idFor(301), mode: "include", pinnedPosition: null },
      { chatId: idFor(301).toUpperCase(), mode: "exclude", pinnedPosition: null }
    ]).success).toBe(false);
    expect(ChatFolderOverridesSchema.safeParse([
      { chatId: idFor(302), mode: "include", pinnedPosition: 7 },
      { chatId: idFor(303), mode: "include", pinnedPosition: 7 }
    ]).success).toBe(false);
  });

  it("validates a strict persisted folder and its revision, position, and chronology", () => {
    expect(ChatFolderSchema.parse(folderFor(0))).toEqual(folderFor(0));
    expect(ChatFolderSchema.safeParse({ ...folderFor(0), position: 9_999 }).success).toBe(true);
    expect(ChatFolderSchema.safeParse({ ...folderFor(0), position: 10_000 }).success).toBe(false);
    expect(ChatFolderSchema.safeParse({ ...folderFor(0), position: -1 }).success).toBe(false);
    expect(ChatFolderSchema.safeParse({ ...folderFor(0), revision: 0 }).success).toBe(false);
    expect(ChatFolderSchema.safeParse({
      ...folderFor(0),
      createdAt: UPDATED_AT,
      updatedAt: CREATED_AT
    }).success).toBe(false);
    expect(ChatFolderSchema.safeParse({ ...folderFor(0), accountId: idFor(500) }).success).toBe(false);
  });

  it("requires all create fields and rejects unknown input", () => {
    const request = {
      title: "Работа",
      rules: RULES,
      overrides: [],
      clientNonce: idFor(401)
    };
    expect(CreateChatFolderRequestSchema.parse(request)).toEqual(request);
    expect(CreateChatFolderRequestSchema.safeParse({ ...request, overrides: undefined }).success).toBe(false);
    expect(CreateChatFolderRequestSchema.safeParse({ ...request, clientNonce: undefined }).success).toBe(false);
    expect(CreateChatFolderRequestSchema.safeParse({ ...request, position: 0 }).success).toBe(false);
  });

  it("requires a strict non-empty mutable patch and optimistic revision", () => {
    const command = { expectedRevision: 1, clientNonce: idFor(402) };
    expect(PatchChatFolderRequestSchema.safeParse({ ...command, title: "Личное" }).success).toBe(true);
    expect(PatchChatFolderRequestSchema.safeParse({ ...command, rules: RULES }).success).toBe(true);
    expect(PatchChatFolderRequestSchema.safeParse({ ...command, overrides: [] }).success).toBe(true);
    expect(PatchChatFolderRequestSchema.safeParse(command).success).toBe(false);
    expect(PatchChatFolderRequestSchema.safeParse({ ...command, expectedRevision: 0, title: "Личное" }).success).toBe(false);
    expect(PatchChatFolderRequestSchema.safeParse({ ...command, position: 1 }).success).toBe(false);
    expect(PatchChatFolderRequestSchema.safeParse({ ...command, title: "Личное", unknown: true }).success).toBe(false);
  });

  it("keeps delete commands strict and revision-bound", () => {
    const command = { expectedRevision: 2, clientNonce: idFor(403) };
    expect(DeleteChatFolderRequestSchema.parse(command)).toEqual(command);
    expect(DeleteChatFolderRequestSchema.safeParse({ ...command, expectedRevision: 0 }).success).toBe(false);
    expect(DeleteChatFolderRequestSchema.safeParse({ ...command, folderId: idFor(1) }).success).toBe(false);
    expect(DeleteChatFolderRequestSchema.safeParse({ clientNonce: idFor(403) }).success).toBe(false);
  });

  it("accepts only a non-empty, bounded, unique exact reorder set", () => {
    const folderIds = Array.from({ length: MAX_CHAT_FOLDERS }, (_, index) => idFor(index + 1));
    const request = { folderIds, expectedStateRevision: 12, clientNonce: idFor(404) };
    expect(ReorderChatFoldersRequestSchema.parse(request)).toEqual(request);
    expect(ReorderChatFoldersRequestSchema.safeParse({
      folderIds,
      clientNonce: idFor(404)
    }).success).toBe(false);
    expect(ReorderChatFoldersRequestSchema.safeParse({
      ...request,
      expectedStateRevision: -1
    }).success).toBe(false);
    expect(ReorderChatFoldersRequestSchema.safeParse({ ...request, folderIds: [] }).success).toBe(false);
    expect(ReorderChatFoldersRequestSchema.safeParse({
      ...request,
      folderIds: [...folderIds, idFor(11)]
    }).success).toBe(false);
    expect(ReorderChatFoldersRequestSchema.safeParse({
      ...request,
      folderIds: [idFor(1), idFor(1).toUpperCase()]
    }).success).toBe(false);
    expect(ReorderChatFoldersRequestSchema.safeParse({ ...request, exact: true }).success).toBe(false);
  });

  it("returns a strict bounded list with unique ids and positions", () => {
    const items = Array.from({ length: MAX_CHAT_FOLDERS }, (_, index) => folderFor(index));
    expect(ChatFolderListResponseSchema.parse({ items, stateRevision: 0 })).toEqual({
      items,
      stateRevision: 0
    });
    expect(ChatFolderListResponseSchema.safeParse({
      items: [...items, folderFor(10)],
      stateRevision: 1
    }).success).toBe(false);
    expect(ChatFolderListResponseSchema.safeParse({
      items: [folderFor(0), { ...folderFor(1), id: idFor(1).toUpperCase() }],
      stateRevision: 1
    }).success).toBe(false);
    expect(ChatFolderListResponseSchema.safeParse({
      items: [folderFor(0), folderFor(1, 0)],
      stateRevision: 1
    }).success).toBe(false);
    expect(ChatFolderListResponseSchema.safeParse({ items: [], stateRevision: -1 }).success).toBe(false);
    expect(ChatFolderListResponseSchema.safeParse({ items: [], stateRevision: 0, replayed: false }).success).toBe(false);
  });

  it("returns strict revisioned and replay-aware mutation shapes", () => {
    const folder = folderFor(0);
    expect(ChatFolderMutationResponseSchema.parse({
      folder,
      stateRevision: 1,
      replayed: false
    })).toEqual({ folder, stateRevision: 1, replayed: false });
    expect(ChatFolderMutationResponseSchema.safeParse({
      folder,
      stateRevision: 1
    }).success).toBe(false);
    expect(ChatFolderMutationResponseSchema.safeParse({
      folder,
      stateRevision: 1,
      replayed: false,
      unknown: true
    }).success).toBe(false);

    expect(ChatFolderDeleteResponseSchema.parse({
      folderId: idFor(1),
      stateRevision: 2,
      replayed: true
    })).toEqual({ folderId: idFor(1), stateRevision: 2, replayed: true });
    expect(ChatFolderDeleteResponseSchema.safeParse({
      folderId: idFor(1),
      stateRevision: 2,
      replayed: true,
      folder
    }).success).toBe(false);

    expect(ChatFolderReorderResponseSchema.parse({
      items: [folder],
      stateRevision: 3,
      replayed: false
    })).toEqual({ items: [folder], stateRevision: 3, replayed: false });
    expect(ChatFolderReorderResponseSchema.safeParse({
      items: [folder],
      stateRevision: 3,
      replayed: "false"
    }).success).toBe(false);
  });
});

describe("chat folder durable realtime contract", () => {
  const event = {
    type: "chat.folders.updated" as const,
    audience: "actor_account" as const,
    accountId: idFor(501),
    stateRevision: 4,
    changedAt: UPDATED_AT
  };

  it("adds the exact account-bound event to durable v2 but not strict v1", () => {
    expect(ChatFoldersRealtimeEventSchema.parse(event)).toEqual(event);
    expect(DurableRealtimeEventSchema.safeParse(event).success).toBe(true);
    expect(RealtimeEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an unbound, mis-scoped, invalid, or extended event", () => {
    expect(ChatFoldersRealtimeEventSchema.safeParse({
      ...event,
      audience: "member_account"
    }).success).toBe(false);
    expect(ChatFoldersRealtimeEventSchema.safeParse({
      ...event,
      accountId: undefined
    }).success).toBe(false);
    expect(ChatFoldersRealtimeEventSchema.safeParse({
      ...event,
      stateRevision: -1
    }).success).toBe(false);
    expect(ChatFoldersRealtimeEventSchema.safeParse({
      ...event,
      stateRevision: 1.5
    }).success).toBe(false);
    expect(ChatFoldersRealtimeEventSchema.safeParse({
      ...event,
      replayed: false
    }).success).toBe(false);
  });
});
