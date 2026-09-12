import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  AddChatMemberRequest,
  EditMessageRequest,
  ForwardMessageRequest,
  RemoveChatMemberRequest,
  SendMessageRequest,
  UpdateChatMemberRoleRequest
} from "@luxora/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageRecord, StoredEvent, UserRecord } from "./domain/types.js";
import { AppError } from "./errors.js";
import { AesGcmContentCipher, type ContentCipher } from "./infrastructure/content-cipher.js";
import { SearchHasher } from "./infrastructure/search-hasher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { ChatService } from "./services/chat-service.js";

const BASE_TIME = "2026-08-03T12:00:00.000Z";
const CLOCK_BEHIND = "2026-08-02T12:00:00.000Z";
const CLOCK_AHEAD = "2026-08-04T12:00:00.000Z";
const CLOCK_AHEAD_PLUS_ONE = "2026-08-04T12:00:00.001Z";

type ChatRaceOperation =
  | { type: "send"; userId: string; chatId: string; input: SendMessageRequest }
  | { type: "forward"; userId: string; sourceMessageId: string; input: ForwardMessageRequest }
  | { type: "edit"; userId: string; messageId: string; input: EditMessageRequest }
  | { type: "delete"; userId: string; messageId: string }
  | { type: "read"; userId: string; chatId: string; messageId: string }
  | { type: "delivered"; userId: string; chatId: string; messageId: string }
  | { type: "reaction"; userId: string; messageId: string; emoji: string; active: boolean }
  | { type: "membership-add"; userId: string; chatId: string; input: AddChatMemberRequest }
  | {
      type: "membership-role";
      userId: string;
      chatId: string;
      targetUserId: string;
      input: UpdateChatMemberRoleRequest;
    }
  | {
      type: "membership-remove";
      userId: string;
      chatId: string;
      targetUserId: string;
      input: RemoveChatMemberRequest;
    };

type RaceOutcome =
  | { ok: true; value: any }
  | { ok: false; statusCode: number; code: string; message: string };

interface RunningWorker {
  writerHeld: Promise<void>;
  outcome: Promise<RaceOutcome>;
  worker: Worker;
}

interface Fixture {
  databasePath: string;
  store: SqliteStore;
  service: ChatService;
  owner: UserRecord;
  member: UserRecord;
  chatId: string;
  createMessage(senderId: string, body: string, createdAt?: string, id?: string): MessageRecord;
}

function startCompetingWriter(
  databasePath: string,
  operation: ChatRaceOperation,
  fixedNow?: string
): RunningWorker {
  const worker = new Worker(
    new URL("./test-support/chat-concurrency-race-worker.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      workerData: {
        databasePath,
        operation,
        fixedNow,
        holdMilliseconds: 180,
        gate: new SharedArrayBuffer(4)
      }
    }
  );
  let heldSettled = false;
  let outcomeSettled = false;
  let resolveHeld: (() => void) | undefined;
  let rejectHeld: ((error: Error) => void) | undefined;
  let resolveOutcome: ((outcome: RaceOutcome) => void) | undefined;
  let rejectOutcome: ((error: Error) => void) | undefined;
  const writerHeld = new Promise<void>((resolve, reject) => {
    resolveHeld = resolve;
    rejectHeld = reject;
  });
  const outcome = new Promise<RaceOutcome>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  worker.on("message", (message: any) => {
    if (message.type === "writer-held" && !heldSettled) {
      heldSettled = true;
      resolveHeld?.();
      return;
    }
    if (message.type === "result" && !outcomeSettled) {
      outcomeSettled = true;
      resolveOutcome?.(message.outcome as RaceOutcome);
      if (!heldSettled) {
        heldSettled = true;
        rejectHeld?.(new Error("Competing chat operation failed before holding a writer transaction"));
      }
    }
  });
  worker.on("error", (error) => {
    if (!heldSettled) {
      heldSettled = true;
      rejectHeld?.(error);
    }
    if (!outcomeSettled) {
      outcomeSettled = true;
      rejectOutcome?.(error);
    }
  });
  worker.on("exit", (code) => {
    if (!heldSettled || !outcomeSettled) {
      const error = new Error(`Chat race worker exited with code ${code} before completing its protocol`);
      if (!heldSettled) {
        heldSettled = true;
        rejectHeld?.(error);
      }
      if (!outcomeSettled) {
        outcomeSettled = true;
        rejectOutcome?.(error);
      }
    }
  });
  return { writerHeld, outcome, worker };
}

function execute(service: ChatService, operation: ChatRaceOperation): unknown {
  switch (operation.type) {
    case "send": return service.sendMessage(operation.userId, operation.chatId, operation.input);
    case "forward": return service.forwardMessage(
      operation.userId,
      operation.sourceMessageId,
      operation.input
    );
    case "edit": return service.editMessage(operation.userId, operation.messageId, operation.input);
    case "delete": return service.deleteMessage(operation.userId, operation.messageId);
    case "read": return service.markRead(operation.userId, operation.chatId, operation.messageId);
    case "delivered": return service.markDelivered(operation.userId, operation.chatId, operation.messageId);
    case "reaction": return service.setReaction(
      operation.userId,
      operation.messageId,
      operation.emoji,
      operation.active
    );
    case "membership-add": return service.addMember(
      operation.userId,
      operation.chatId,
      operation.input
    );
    case "membership-role": return service.updateMemberRole(
      operation.userId,
      operation.chatId,
      operation.targetUserId,
      operation.input
    );
    case "membership-remove": return service.removeMember(
      operation.userId,
      operation.chatId,
      operation.targetUserId,
      operation.input
    );
  }
}

function capture(operation: () => unknown): RaceOutcome {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        ok: false,
        statusCode: error.statusCode,
        code: error.code,
        message: error.message
      };
    }
    return {
      ok: false,
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function requireSuccess(outcome: RaceOutcome): asserts outcome is Extract<RaceOutcome, { ok: true }> {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${JSON.stringify(outcome)}`);
  }
}

function withFixedClock<T>(iso: string | undefined, operation: () => T): T {
  if (iso === undefined) return operation();
  const NativeDate = globalThis.Date;
  const fixedMilliseconds = new NativeDate(iso).getTime();
  class FixedDate extends NativeDate {
    constructor(value?: string | number) {
      if (arguments.length === 0) super(fixedMilliseconds);
      else super(value as string | number);
    }

    static override now(): number {
      return fixedMilliseconds;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return operation();
  } finally {
    globalThis.Date = NativeDate;
  }
}

describe("chat convergence across independent SQLite writers", () => {
  const temporaryDirectories: string[] = [];
  const workers: Worker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(async (worker) => {
      if (worker.threadId !== -1) await worker.terminate();
    }));
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function setup(contentCipher?: ContentCipher): Fixture {
    const directory = mkdtempSync(join(tmpdir(), "luxora-chat-race-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    const store = new SqliteStore(databasePath, contentCipher);
    const service = new ChatService(
      store,
      { publish() {}, publishEphemeral() {} },
      new SearchHasher({}, undefined)
    );
    const createUser = (username: string): UserRecord => store.createUser({
      id: randomUUID(),
      username,
      usernameNormalized: username,
      displayName: username,
      passwordHash: "test-only-password-hash",
      createdAt: BASE_TIME
    });
    const owner = createUser(`owner_${randomUUID().slice(0, 8)}`);
    const member = createUser(`member_${randomUUID().slice(0, 8)}`);
    const chatId = randomUUID();
    store.createChat({
      id: chatId,
      kind: "group",
      title: "Race fixture",
      directKey: null,
      createdBy: owner.id,
      createdAt: BASE_TIME
    });
    store.addChatMember(chatId, owner.id, "owner", BASE_TIME);
    store.addChatMember(chatId, member.id, "member", BASE_TIME);
    const createMessage = (
      senderId: string,
      body: string,
      createdAt = BASE_TIME,
      id = randomUUID()
    ): MessageRecord => store.createMessage({
      id,
      chatId,
      senderId,
      body,
      replyToMessageId: null,
      topicId: null,
      forwardedFromMessageId: null,
      forwardedFromChatId: null,
      forwardedFromSenderId: null,
      forwardedFromSenderName: null,
      forwardedFromCreatedAt: null,
      clientNonce: randomUUID(),
      createdAt
    });
    return { databasePath, store, service, owner, member, chatId, createMessage };
  }

  function acceptRelationship(store: SqliteStore, left: UserRecord, right: UserRecord): void {
    const [leftUserId, rightUserId] = [left.id, right.id].sort() as [string, string];
    const requestId = randomUUID();
    store.createMessageRequest({
      id: requestId,
      pairKey: `${leftUserId}:${rightUserId}`,
      senderId: left.id,
      recipientId: right.id,
      clientNonce: randomUUID(),
      body: "Membership race relationship",
      linkUrl: null,
      senderProfile: {
        id: left.id,
        username: left.username,
        displayName: left.displayName,
        bio: left.bio,
        avatarUrl: left.avatarUrl
      },
      recipientProfile: {
        id: right.id,
        username: right.username,
        displayName: right.displayName,
        bio: right.bio,
        avatarUrl: right.avatarUrl
      },
      createdAt: BASE_TIME,
      expiresAt: "2026-09-03T12:00:00.000Z"
    });
    store.createAcceptedRelationship(
      `${leftUserId}:${rightUserId}`,
      leftUserId,
      rightUserId,
      requestId,
      BASE_TIME
    );
  }

  async function race(
    fixture: Fixture,
    workerOperation: ChatRaceOperation,
    mainOperation: ChatRaceOperation,
    clocks: { worker?: string; main?: string } = {}
  ): Promise<{ worker: RaceOutcome; main: RaceOutcome }> {
    const competing = startCompetingWriter(
      fixture.databasePath,
      workerOperation,
      clocks.worker
    );
    workers.push(competing.worker);
    await competing.writerHeld;
    const main = capture(() => withFixedClock(
      clocks.main,
      () => execute(fixture.service, mainOperation)
    ));
    return { worker: await competing.outcome, main };
  }

  function claimPendingEvents(fixture: Fixture): StoredEvent[] {
    const workerId = `assertion-worker-${randomUUID()}`;
    const now = "2026-08-05T12:00:00.000Z";
    const events: StoredEvent[] = [];
    const maxBatches = 1_000;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const claimed = fixture.store.claimRealtimeOutbox(
        workerId,
        now,
        "2026-08-05T12:01:00.000Z",
        500
      );
      if (claimed.length === 0) return events;

      for (const item of claimed) {
        if (!item.ok) {
          throw new Error(`Unexpected unreadable event ${item.eventSequence}`);
        }
        events.push(item.event);
        if (!fixture.store.markRealtimeOutboxPublished(item.event.sequence, workerId, now)) {
          throw new Error(`Failed to acknowledge event ${item.event.sequence}`);
        }
      }
    }

    throw new Error(`Outbox did not drain within ${maxBatches} assertion batches`);
  }

  it("converges identical send nonces to the first committed message", async () => {
    const fixture = setup();
    try {
      const identical: SendMessageRequest = {
        body: "same committed message",
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [],
        transcriptionConsent: false
      };
      const same = await race(
        fixture,
        { type: "send", userId: fixture.owner.id, chatId: fixture.chatId, input: identical },
        { type: "send", userId: fixture.owner.id, chatId: fixture.chatId, input: identical }
      );
      expect(same.worker.ok).toBe(true);
      requireSuccess(same.main);
      if (same.worker.ok) expect(same.main.value.id).toBe(same.worker.value.id);
      expect(fixture.store.findMessageByNonce(fixture.owner.id, identical.clientNonce)?.body)
        .toBe(identical.body);
      const events = claimPendingEvents(fixture);
      expect(events).toHaveLength(2);
      expect(events.every(({ event }) =>
        event.type === "message.created" && event.message.clientNonce === identical.clientNonce
      )).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a concurrently changed send fingerprint with a stable conflict", async () => {
    const fixture = setup();
    try {
      const nonce = randomUUID();
      const first: SendMessageRequest = {
        body: "first fingerprint",
        clientNonce: nonce,
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [],
        transcriptionConsent: false
      };
      const changed: SendMessageRequest = { ...first, body: "changed fingerprint" };
      const mismatch = await race(
        fixture,
        { type: "send", userId: fixture.owner.id, chatId: fixture.chatId, input: first },
        { type: "send", userId: fixture.owner.id, chatId: fixture.chatId, input: changed }
      );
      expect(mismatch.worker.ok).toBe(true);
      expect(mismatch.main).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "clientNonce was already used for a different message"
      });
      expect(fixture.store.findMessageByNonce(fixture.owner.id, nonce)?.body).toBe(first.body);
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("orders distinct concurrent sends by commit even when the second writer clock is behind", async () => {
    const fixture = setup();
    try {
      const first: SendMessageRequest = {
        body: "first committed send",
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [],
        transcriptionConsent: false
      };
      const second: SendMessageRequest = {
        ...first,
        body: "second committed send",
        clientNonce: randomUUID()
      };
      const outcome = await race(
        fixture,
        { type: "send", userId: fixture.owner.id, chatId: fixture.chatId, input: first },
        { type: "send", userId: fixture.owner.id, chatId: fixture.chatId, input: second },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      requireSuccess(outcome.worker);
      requireSuccess(outcome.main);
      expect(outcome.worker.value.createdAt).toBe(CLOCK_AHEAD);
      expect(outcome.main.value.createdAt).toBe(CLOCK_AHEAD_PLUS_ONE);
      expect(fixture.store.findChatRecord(fixture.chatId)).toMatchObject({
        lastMessageId: outcome.main.value.id,
        updatedAt: CLOCK_AHEAD_PLUS_ONE
      });
      const events = claimPendingEvents(fixture);
      expect(events).toHaveLength(4);
      const firstSequences = events
        .filter(({ event }) => event.type === "message.created" && event.message.clientNonce === first.clientNonce)
        .map(({ sequence }) => sequence);
      const secondSequences = events
        .filter(({ event }) => event.type === "message.created" && event.message.clientNonce === second.clientNonce)
        .map(({ sequence }) => sequence);
      expect(Math.max(...firstSequences)).toBeLessThan(Math.min(...secondSequences));
    } finally {
      fixture.store.close();
    }
  });

  it("keeps an exact send retry stable after the message is edited and then deleted", () => {
    const fixture = setup();
    try {
      const input: SendMessageRequest = {
        body: "immutable send command",
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [],
        transcriptionConsent: false
      };
      const sent = fixture.service.sendMessage(fixture.owner.id, fixture.chatId, input);

      fixture.service.editMessage(fixture.owner.id, sent.id, { body: "current edited projection" });
      const afterEditSequence = fixture.store.getLatestSequence();
      expect(fixture.service.sendMessage(fixture.owner.id, fixture.chatId, input)).toMatchObject({
        id: sent.id,
        body: "current edited projection",
        revision: 1
      });
      expect(fixture.store.getLatestSequence()).toBe(afterEditSequence);

      fixture.service.deleteMessage(fixture.owner.id, sent.id);
      const afterDeleteSequence = fixture.store.getLatestSequence();
      expect(fixture.service.sendMessage(fixture.owner.id, fixture.chatId, input)).toMatchObject({
        id: sent.id,
        body: null,
        deletedAt: expect.any(String)
      });
      expect(fixture.store.getLatestSequence()).toBe(afterDeleteSequence);
      expect(capture(() => fixture.service.sendMessage(fixture.owner.id, fixture.chatId, {
        ...input,
        body: "changed nonce reuse"
      }))).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "clientNonce was already used for a different message"
      });
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("fails closed when a legacy send row has no immutable request fingerprint", () => {
    const fixture = setup();
    try {
      const nonce = randomUUID();
      const legacy = fixture.store.createMessage({
        id: randomUUID(),
        chatId: fixture.chatId,
        senderId: fixture.owner.id,
        body: "legacy body A",
        replyToMessageId: null,
        topicId: null,
        forwardedFromMessageId: null,
        forwardedFromChatId: null,
        forwardedFromSenderId: null,
        forwardedFromSenderName: null,
        forwardedFromCreatedAt: null,
        forwardSourceMessageId: null,
        requestFingerprint: null,
        clientNonce: nonce,
        createdAt: BASE_TIME
      });
      fixture.service.editMessage(fixture.owner.id, legacy.id, { body: "legacy body B" });
      const sequenceBeforeRetries = fixture.store.getLatestSequence();
      for (const body of ["legacy body A", "legacy body B"]) {
        expect(capture(() => fixture.service.sendMessage(fixture.owner.id, fixture.chatId, {
          body,
          clientNonce: nonce,
          replyToMessageId: null,
          topicId: null,
          attachmentIds: [],
          transcriptionConsent: false
        }))).toMatchObject({
          ok: false,
          statusCode: 409,
          code: "CONFLICT",
          message: "clientNonce was already used for a different message"
        });
      }
      expect(fixture.store.getLatestSequence()).toBe(sequenceBeforeRetries);
      expect(fixture.store.findMessageRecord(legacy.id)).toMatchObject({
        body: "legacy body B",
        revision: 1,
        requestFingerprint: null
      });
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("encrypts the durable send fingerprint and keeps it out of message projections", () => {
    const fixture = setup(new AesGcmContentCipher(
      { current: randomBytes(32).toString("base64url") },
      "current"
    ));
    try {
      const bodyCanary = "request_fingerprint_private_canary";
      const sent = fixture.service.sendMessage(fixture.owner.id, fixture.chatId, {
        body: bodyCanary,
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [],
        transcriptionConsent: false
      });
      expect("requestFingerprint" in sent).toBe(false);
      expect(fixture.store.findMessageRecord(sent.id)?.requestFingerprint).toContain(bodyCanary);

      const inspection = new Database(fixture.databasePath, { readonly: true });
      const row = inspection.prepare(`
        SELECT body, request_fingerprint_ciphertext FROM messages WHERE id = ?
      `).get(sent.id) as { body: string; request_fingerprint_ciphertext: string };
      inspection.close();
      expect(row.body.startsWith("luxora:v1.")).toBe(true);
      expect(row.request_fingerprint_ciphertext.startsWith("luxora:v1.")).toBe(true);
      expect(row.request_fingerprint_ciphertext).not.toContain(bodyCanary);
    } finally {
      fixture.store.close();
    }
  });

  it("converges identical concurrent forward nonces to one forwarded snapshot", async () => {
    const fixture = setup();
    try {
      const source = fixture.createMessage(fixture.owner.id, "forward source");
      const input: ForwardMessageRequest = {
        chatId: fixture.chatId,
        clientNonce: randomUUID(),
        topicId: null
      };
      const outcome = await race(
        fixture,
        { type: "forward", userId: fixture.owner.id, sourceMessageId: source.id, input },
        { type: "forward", userId: fixture.owner.id, sourceMessageId: source.id, input }
      );
      requireSuccess(outcome.worker);
      requireSuccess(outcome.main);
      expect(outcome.main.value.id).toBe(outcome.worker.value.id);
      expect(fixture.store.findMessageByNonce(fixture.owner.id, input.clientNonce)).toMatchObject({
        body: source.body,
        forwardedFromMessageId: source.id
      });
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a concurrently changed forward source with a stable nonce conflict", async () => {
    const fixture = setup();
    try {
      const firstSource = fixture.createMessage(fixture.owner.id, "first forward source");
      const changedSource = fixture.createMessage(fixture.owner.id, "changed forward source");
      const input: ForwardMessageRequest = {
        chatId: fixture.chatId,
        clientNonce: randomUUID(),
        topicId: null
      };
      const outcome = await race(
        fixture,
        { type: "forward", userId: fixture.owner.id, sourceMessageId: firstSource.id, input },
        { type: "forward", userId: fixture.owner.id, sourceMessageId: changedSource.id, input }
      );
      requireSuccess(outcome.worker);
      expect(outcome.main).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "clientNonce was already used for a different message"
      });
      expect(fixture.store.findMessageByNonce(fixture.owner.id, input.clientNonce)).toMatchObject({
        body: firstSource.body,
        forwardedFromMessageId: firstSource.id
      });
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("keeps an exact forward retry stable after the source is edited and then deleted", () => {
    const fixture = setup();
    try {
      const source = fixture.createMessage(fixture.owner.id, "immutable forwarded snapshot");
      const input: ForwardMessageRequest = {
        chatId: fixture.chatId,
        clientNonce: randomUUID(),
        topicId: null
      };
      const forwarded = fixture.service.forwardMessage(fixture.owner.id, source.id, input);
      expect(forwarded.body).toBe("immutable forwarded snapshot");

      fixture.service.editMessage(fixture.owner.id, source.id, { body: "source changed later" });
      const afterEditSequence = fixture.store.getLatestSequence();
      expect(fixture.service.forwardMessage(fixture.owner.id, source.id, input).id).toBe(forwarded.id);
      expect(fixture.store.getLatestSequence()).toBe(afterEditSequence);

      fixture.service.deleteMessage(fixture.owner.id, source.id);
      const afterDeleteSequence = fixture.store.getLatestSequence();
      expect(fixture.service.forwardMessage(fixture.owner.id, source.id, input).id).toBe(forwarded.id);
      expect(fixture.store.getLatestSequence()).toBe(afterDeleteSequence);
      expect(capture(() => fixture.service.forwardMessage(fixture.owner.id, source.id, {
        ...input,
        clientNonce: randomUUID()
      }))).toMatchObject({ ok: false, statusCode: 404, code: "NOT_FOUND" });

      expect(fixture.store.findMessageByNonce(fixture.owner.id, input.clientNonce)).toMatchObject({
        id: forwarded.id,
        body: "immutable forwarded snapshot",
        forwardSourceMessageId: source.id
      });
      expect(claimPendingEvents(fixture)).toHaveLength(4);
    } finally {
      fixture.store.close();
    }
  });

  it("fails closed for a legacy forward row whose immediate source identity is ambiguous", () => {
    const fixture = setup();
    try {
      const root = fixture.createMessage(fixture.owner.id, "shared root");
      const createLegacyForward = (body: string, clientNonce: string): MessageRecord =>
        fixture.store.createMessage({
          id: randomUUID(),
          chatId: fixture.chatId,
          senderId: fixture.owner.id,
          body,
          replyToMessageId: null,
          topicId: null,
          forwardedFromMessageId: root.id,
          forwardedFromChatId: fixture.chatId,
          forwardedFromSenderId: fixture.owner.id,
          forwardedFromSenderName: fixture.owner.displayName,
          forwardedFromCreatedAt: root.createdAt,
          forwardSourceMessageId: null,
          clientNonce,
          createdAt: BASE_TIME
        });
      const reusedNonce = randomUUID();
      createLegacyForward("first legacy snapshot", reusedNonce);
      const differentSource = createLegacyForward("second legacy snapshot", randomUUID());

      expect(capture(() => fixture.service.forwardMessage(fixture.owner.id, differentSource.id, {
        chatId: fixture.chatId,
        clientNonce: reusedNonce,
        topicId: null
      }))).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "clientNonce was already used for a different message"
      });
    } finally {
      fixture.store.close();
    }
  });

  it("allows one expected-revision edit and returns a stable conflict for the loser", async () => {
    const fixture = setup();
    try {
      const original = fixture.createMessage(fixture.owner.id, "revision zero");
      const outcome = await race(
        fixture,
        {
          type: "edit",
          userId: fixture.owner.id,
          messageId: original.id,
          input: { body: "worker revision one", expectedRevision: 0 }
        },
        {
          type: "edit",
          userId: fixture.owner.id,
          messageId: original.id,
          input: { body: "main revision one", expectedRevision: 0 }
        },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(outcome.worker.ok).toBe(true);
      expect(outcome.main).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "Message was changed by another client"
      });
      expect(fixture.store.findMessageRecord(original.id)).toMatchObject({
        body: "worker revision one",
        revision: 1,
        editedAt: CLOCK_AHEAD
      });
      expect(fixture.store.listMessageVersions(original.id)).toMatchObject([
        { revision: 0, body: "revision zero" }
      ]);
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("serializes unguarded edit/edit into two revisions without corrupting history", async () => {
    const fixture = setup();
    try {
      const original = fixture.createMessage(fixture.owner.id, "unguarded revision zero");
      const outcome = await race(
        fixture,
        {
          type: "edit",
          userId: fixture.owner.id,
          messageId: original.id,
          input: { body: "worker unguarded revision" }
        },
        {
          type: "edit",
          userId: fixture.owner.id,
          messageId: original.id,
          input: { body: "main unguarded revision" }
        },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(outcome.worker.ok).toBe(true);
      requireSuccess(outcome.main);
      expect(fixture.store.findMessageRecord(original.id)).toMatchObject({
        body: "main unguarded revision",
        revision: 2,
        editedAt: CLOCK_AHEAD_PLUS_ONE
      });
      expect(fixture.store.listMessageVersions(original.id).map(({ revision, body }) => ({
        revision,
        body
      }))).toEqual([
        { revision: 1, body: "worker unguarded revision" },
        { revision: 0, body: "unguarded revision zero" }
      ]);
      expect(claimPendingEvents(fixture)).toHaveLength(4);
    } finally {
      fixture.store.close();
    }
  });

  it("makes delete dominate an in-flight edit and rejects edit after an in-flight delete", async () => {
    const fixture = setup();
    try {
      const editedThenDeleted = fixture.createMessage(fixture.owner.id, "delete wins one");
      const first = await race(
        fixture,
        {
          type: "edit",
          userId: fixture.owner.id,
          messageId: editedThenDeleted.id,
          input: { body: "transient edit", expectedRevision: 0 }
        },
        { type: "delete", userId: fixture.owner.id, messageId: editedThenDeleted.id },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(first.worker.ok).toBe(true);
      expect(first.main.ok).toBe(true);
      expect(fixture.store.findMessageRecord(editedThenDeleted.id)).toMatchObject({
        body: null,
        revision: 2,
        deletedAt: CLOCK_AHEAD_PLUS_ONE
      });
      expect(fixture.store.listMessageVersions(editedThenDeleted.id)).toEqual([]);

      const deletedThenEdited = fixture.createMessage(fixture.owner.id, "delete wins two");
      const second = await race(
        fixture,
        { type: "delete", userId: fixture.owner.id, messageId: deletedThenEdited.id },
        {
          type: "edit",
          userId: fixture.owner.id,
          messageId: deletedThenEdited.id,
          input: { body: "must not resurrect", expectedRevision: 0 }
        },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(second.worker.ok).toBe(true);
      expect(second.main).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "Message was changed by another client"
      });
      expect(fixture.store.findMessageRecord(deletedThenEdited.id)).toMatchObject({
        body: null,
        revision: 1,
        deletedAt: CLOCK_AHEAD
      });
      const events = claimPendingEvents(fixture);
      expect(events).toHaveLength(4);
      expect(events.every(({ event }) => event.type === "message.deleted")).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  it("never regresses the read pointer when an older target commits after a newer target", async () => {
    const fixture = setup();
    try {
      const older = fixture.createMessage(fixture.owner.id, "older", "2026-08-03T12:01:00.000Z");
      const newer = fixture.createMessage(fixture.owner.id, "newer", "2026-08-03T12:02:00.000Z");
      const outcome = await race(
        fixture,
        { type: "read", userId: fixture.member.id, chatId: fixture.chatId, messageId: newer.id },
        { type: "read", userId: fixture.member.id, chatId: fixture.chatId, messageId: older.id },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(outcome.worker.ok).toBe(true);
      requireSuccess(outcome.main);
      expect(outcome.main.value).toEqual([]);
      expect(fixture.store.getChatForUser(fixture.chatId, fixture.member.id)?.unreadCount).toBe(0);
      expect(fixture.store.listMessageReceipts(newer.id)).toMatchObject([
        { userId: fixture.member.id, deliveredAt: CLOCK_AHEAD, readAt: CLOCK_AHEAD }
      ]);
      const events = claimPendingEvents(fixture);
      expect(events).toHaveLength(2);
      expect(events.every(({ event }) =>
        event.type === "receipt.read" && event.messageId === newer.id
      )).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  it("uses the immutable message ID tie-break when concurrent read targets share a timestamp", async () => {
    const fixture = setup();
    try {
      const [lowerId, higherId] = [randomUUID(), randomUUID()].sort() as [string, string];
      const lower = fixture.createMessage(
        fixture.owner.id,
        "lower equal-time ID",
        "2026-08-03T12:03:00.000Z",
        lowerId
      );
      const higher = fixture.createMessage(
        fixture.owner.id,
        "higher equal-time ID",
        "2026-08-03T12:03:00.000Z",
        higherId
      );
      const outcome = await race(
        fixture,
        { type: "read", userId: fixture.member.id, chatId: fixture.chatId, messageId: higher.id },
        { type: "read", userId: fixture.member.id, chatId: fixture.chatId, messageId: lower.id },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(outcome.worker.ok).toBe(true);
      requireSuccess(outcome.main);
      expect(outcome.main.value).toEqual([]);
      expect(fixture.store.getChatForUser(fixture.chatId, fixture.member.id)?.unreadCount).toBe(0);
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("keeps delivered/read idempotent and makes read imply delivery in both commit orders", async () => {
    const fixture = setup();
    try {
      const readFirst = fixture.createMessage(
        fixture.owner.id,
        "read first",
        "2026-08-03T12:01:00.000Z"
      );
      const first = await race(
        fixture,
        { type: "read", userId: fixture.member.id, chatId: fixture.chatId, messageId: readFirst.id },
        { type: "delivered", userId: fixture.member.id, chatId: fixture.chatId, messageId: readFirst.id },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(first.worker.ok).toBe(true);
      expect(first.main).toMatchObject({ ok: true, value: [] });
      expect(fixture.store.listMessageReceipts(readFirst.id)).toEqual([{
        userId: fixture.member.id,
        deliveredAt: CLOCK_AHEAD,
        readAt: CLOCK_AHEAD
      }]);

      const deliveredFirst = fixture.createMessage(
        fixture.owner.id,
        "delivered first",
        "2026-08-03T12:02:00.000Z"
      );
      const second = await race(
        fixture,
        {
          type: "delivered",
          userId: fixture.member.id,
          chatId: fixture.chatId,
          messageId: deliveredFirst.id
        },
        { type: "read", userId: fixture.member.id, chatId: fixture.chatId, messageId: deliveredFirst.id },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(second.worker.ok).toBe(true);
      requireSuccess(second.main);
      expect(fixture.store.listMessageReceipts(deliveredFirst.id)).toEqual([{
        userId: fixture.member.id,
        deliveredAt: CLOCK_AHEAD,
        readAt: CLOCK_AHEAD
      }]);
      expect(claimPendingEvents(fixture)).toHaveLength(6);
    } finally {
      fixture.store.close();
    }
  });

  it("applies opposing reaction desired states by commit order despite ±24h clocks", async () => {
    const fixture = setup();
    try {
      const message = fixture.createMessage(fixture.owner.id, "reaction race");
      const emoji = "🔥";
      const removeLast = await race(
        fixture,
        { type: "reaction", userId: fixture.member.id, messageId: message.id, emoji, active: true },
        { type: "reaction", userId: fixture.member.id, messageId: message.id, emoji, active: false },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(removeLast.worker.ok).toBe(true);
      expect(removeLast.main.ok).toBe(true);
      expect(fixture.store.getReactionSummary(message.id, fixture.member.id)).toEqual([]);

      fixture.store.setReaction(message.id, fixture.member.id, emoji, true, BASE_TIME);
      const addLast = await race(
        fixture,
        { type: "reaction", userId: fixture.member.id, messageId: message.id, emoji, active: false },
        { type: "reaction", userId: fixture.member.id, messageId: message.id, emoji, active: true },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      expect(addLast.worker.ok).toBe(true);
      expect(addLast.main.ok).toBe(true);
      expect(fixture.store.getReactionSummary(message.id, fixture.member.id)).toEqual([
        { emoji, count: 1, reactedByMe: true }
      ]);
      const events = claimPendingEvents(fixture);
      expect(events).toHaveLength(8);
      expect(events.every(({ event }) => event.type === "reaction.updated")).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  it("converges an identical member-add nonce to one row and one durable event set", async () => {
    const fixture = setup();
    try {
      const candidateUsername = `candidate_${randomUUID().slice(0, 8)}`;
      const candidate = fixture.store.createUser({
        id: randomUUID(),
        username: candidateUsername,
        usernameNormalized: candidateUsername,
        displayName: "Race candidate",
        passwordHash: "test-only-password-hash",
        createdAt: BASE_TIME
      });
      acceptRelationship(fixture.store, fixture.owner, candidate);
      const input: AddChatMemberRequest = {
        userId: candidate.id,
        role: "member",
        clientNonce: randomUUID()
      };
      const outcome = await race(
        fixture,
        { type: "membership-add", userId: fixture.owner.id, chatId: fixture.chatId, input },
        { type: "membership-add", userId: fixture.owner.id, chatId: fixture.chatId, input }
      );
      requireSuccess(outcome.worker);
      requireSuccess(outcome.main);
      expect([outcome.worker.value.replayed, outcome.main.value.replayed].sort()).toEqual([false, true]);
      expect(outcome.main.value.membership).toEqual(outcome.worker.value.membership);
      expect(fixture.store.getChatMember(fixture.chatId, candidate.id)).toMatchObject({
        role: "member",
        revision: 1
      });
      const events = claimPendingEvents(fixture);
      expect(events).toHaveLength(4);
      expect(events.filter(({ event }) => event.type === "chat.member.changed")).toHaveLength(3);
      expect(events.filter(({ event }) => event.type === "chat.created")).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  it("prevents membership ABA after remove and re-add, including a rolled-back clock", () => {
    const fixture = setup();
    try {
      acceptRelationship(fixture.store, fixture.owner, fixture.member);
      const removeNonce = randomUUID();
      const removed = withFixedClock(CLOCK_AHEAD, () => fixture.service.removeMember(
        fixture.owner.id,
        fixture.chatId,
        fixture.member.id,
        { expectedRevision: 1, clientNonce: removeNonce }
      ));
      expect(removed.membership.revision).toBe(2);

      const addInput: AddChatMemberRequest = {
        userId: fixture.member.id,
        role: "member",
        clientNonce: randomUUID()
      };
      const readded = withFixedClock(CLOCK_BEHIND, () => fixture.service.addMember(
        fixture.owner.id,
        fixture.chatId,
        addInput
      ));
      expect(readded).toMatchObject({ replayed: false, membership: { revision: 3 } });
      expect(readded.membership.joinedAt > removed.membership.updatedAt).toBe(true);
      expect(withFixedClock(CLOCK_AHEAD, () => capture(() => fixture.service.updateMemberRole(
        fixture.owner.id,
        fixture.chatId,
        fixture.member.id,
        { role: "admin", expectedRevision: 1, clientNonce: randomUUID() }
      )))).toMatchObject({ ok: false, statusCode: 409, message: "Chat membership revision is stale" });
      expect(withFixedClock(CLOCK_AHEAD, () => capture(() => fixture.service.removeMember(
        fixture.owner.id,
        fixture.chatId,
        fixture.member.id,
        { expectedRevision: 1, clientNonce: randomUUID() }
      )))).toMatchObject({ ok: false, statusCode: 409, message: "Chat membership revision is stale" });

      const promoted = withFixedClock(CLOCK_BEHIND, () => fixture.service.updateMemberRole(
        fixture.owner.id,
        fixture.chatId,
        fixture.member.id,
        { role: "admin", expectedRevision: 3, clientNonce: randomUUID() }
      ));
      expect(promoted.membership).toMatchObject({ revision: 4, role: "admin" });
      expect(promoted.membership.updatedAt > readded.membership.updatedAt).toBe(true);

      // Exact replay remains the original response even after a later role
      // mutation advances the active row.
      const replay = withFixedClock(CLOCK_AHEAD, () => fixture.service.addMember(
        fixture.owner.id,
        fixture.chatId,
        addInput
      ));
      expect(replay).toEqual({ ...readded, replayed: true });
      expect(fixture.store.getChatMember(fixture.chatId, fixture.member.id)).toMatchObject({
        revision: 4,
        role: "admin"
      });
      const events = claimPendingEvents(fixture);
      expect(events.filter(({ event }) => event.type === "chat.member.changed")).toHaveLength(6);
      expect(events.filter(({ event }) => event.type === "chat.created")).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  it("lets only one expected membership revision win across independent writers", async () => {
    const fixture = setup();
    try {
      const outcome = await race(
        fixture,
        {
          type: "membership-role",
          userId: fixture.owner.id,
          chatId: fixture.chatId,
          targetUserId: fixture.member.id,
          input: { role: "admin", expectedRevision: 1, clientNonce: randomUUID() }
        },
        {
          type: "membership-role",
          userId: fixture.owner.id,
          chatId: fixture.chatId,
          targetUserId: fixture.member.id,
          input: { role: "admin", expectedRevision: 1, clientNonce: randomUUID() }
        },
        { worker: CLOCK_AHEAD, main: CLOCK_BEHIND }
      );
      requireSuccess(outcome.worker);
      expect(outcome.main).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "Chat membership revision is stale"
      });
      expect(fixture.store.getChatMember(fixture.chatId, fixture.member.id)).toMatchObject({
        role: "admin",
        revision: 2,
        updatedAt: CLOCK_AHEAD
      });
      expect(claimPendingEvents(fixture)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("makes a committed removal defeat an in-flight message from the removed member", async () => {
    const fixture = setup();
    try {
      const sendInput: SendMessageRequest = {
        body: "must lose to membership removal",
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [],
        transcriptionConsent: false
      };
      const outcome = await race(
        fixture,
        {
          type: "membership-remove",
          userId: fixture.owner.id,
          chatId: fixture.chatId,
          targetUserId: fixture.member.id,
          input: { expectedRevision: 1, clientNonce: randomUUID() }
        },
        { type: "send", userId: fixture.member.id, chatId: fixture.chatId, input: sendInput }
      );
      requireSuccess(outcome.worker);
      expect(outcome.main).toMatchObject({
        ok: false,
        statusCode: 403,
        code: "FORBIDDEN",
        message: "You are not a member of this chat"
      });
      expect(fixture.store.getChatMember(fixture.chatId, fixture.member.id)).toBeNull();
      expect(fixture.store.findMessageByNonce(fixture.member.id, sendInput.clientNonce)).toBeNull();
      const events = claimPendingEvents(fixture);
      expect(events).toHaveLength(2);
      expect(events.every(({ event }) =>
        event.type === "chat.member.changed" && event.change === "removed"
      )).toBe(true);
    } finally {
      fixture.store.close();
    }
  });
});
