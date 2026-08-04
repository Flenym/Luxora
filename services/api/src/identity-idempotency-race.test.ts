import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { CreateMessageRequest, CreateSafetyReport } from "@luxora/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { UserRecord } from "./domain/types.js";
import { AppError } from "./errors.js";
import { SearchHasher } from "./infrastructure/search-hasher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { IdentityAccessService } from "./services/identity-access-service.js";

type RaceOperation =
  | { type: "message-request"; actorUserId: string; input: CreateMessageRequest }
  | { type: "safety-report"; actorUserId: string; input: CreateSafetyReport };

type RaceOutcome =
  | { ok: true; value: any }
  | { ok: false; statusCode: number; code: string; message: string };

interface RunningWorker {
  writerHeld: Promise<void>;
  outcome: Promise<RaceOutcome>;
  worker: Worker;
}

function startCompetingWriter(databasePath: string, operation: RaceOperation): RunningWorker {
  const worker = new Worker(
    new URL("./test-support/identity-nonce-race-worker.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      workerData: {
        databasePath,
        operation,
        holdMilliseconds: 120,
        gate: new SharedArrayBuffer(4)
      }
    }
  );
  let markWriterHeld: (() => void) | undefined;
  let finish: ((outcome: RaceOutcome) => void) | undefined;
  let failWriterHeld: ((error: Error) => void) | undefined;
  let failOutcome: ((error: Error) => void) | undefined;
  const writerHeld = new Promise<void>((resolve, reject) => {
    markWriterHeld = resolve;
    failWriterHeld = reject;
  });
  const outcome = new Promise<RaceOutcome>((resolve, reject) => {
    finish = resolve;
    failOutcome = reject;
  });
  worker.on("message", (message: any) => {
    if (message.type === "writer-held") markWriterHeld?.();
    if (message.type === "result") finish?.(message.outcome as RaceOutcome);
  });
  worker.on("error", (error) => {
    failWriterHeld?.(error);
    failOutcome?.(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Identity race worker exited with code ${code}`);
      failWriterHeld?.(error);
      failOutcome?.(error);
    }
  });
  return { writerHeld, outcome, worker };
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

describe("IA-1 nonce idempotency across independent SQLite writers", () => {
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

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), "luxora-ia1-race-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    const store = new SqliteStore(databasePath);
    const service = new IdentityAccessService(
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
      createdAt: "2026-08-03T12:00:00.000Z"
    });
    return { databasePath, store, service, createUser };
  }

  it("returns the first message request for an identical fingerprint and 409 for changed reuse", async () => {
    const { databasePath, store, service, createUser } = setup();
    try {
      const sender = createUser("race_sender");
      const firstRecipient = createUser("race_recipient_one");
      const secondRecipient = createUser("race_recipient_two");

      const identicalInput: CreateMessageRequest = {
        recipientUserId: firstRecipient.id,
        body: "identical request body",
        validatedLink: null,
        clientNonce: randomUUID()
      };
      const identicalWorker = startCompetingWriter(databasePath, {
        type: "message-request",
        actorUserId: sender.id,
        input: identicalInput
      });
      workers.push(identicalWorker.worker);
      await identicalWorker.writerHeld;
      const identicalMain = capture(() => service.createMessageRequest(sender.id, identicalInput));
      const identicalOther = await identicalWorker.outcome;
      expect(identicalMain.ok).toBe(true);
      expect(identicalOther.ok).toBe(true);
      if (identicalMain.ok && identicalOther.ok) {
        expect(identicalMain.value.id).toBe(identicalOther.value.id);
      }

      const nonce = randomUUID();
      const firstFingerprint: CreateMessageRequest = {
        recipientUserId: secondRecipient.id,
        body: "first fingerprint",
        validatedLink: null,
        clientNonce: nonce
      };
      const changedFingerprint: CreateMessageRequest = {
        ...firstFingerprint,
        body: "changed fingerprint"
      };
      const conflictWorker = startCompetingWriter(databasePath, {
        type: "message-request",
        actorUserId: sender.id,
        input: firstFingerprint
      });
      workers.push(conflictWorker.worker);
      await conflictWorker.writerHeld;
      const conflictMain = capture(() => service.createMessageRequest(sender.id, changedFingerprint));
      const firstOutcome = await conflictWorker.outcome;
      expect(firstOutcome.ok).toBe(true);
      expect(conflictMain).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "clientNonce was already used for a different message request"
      });
    } finally {
      store.close();
    }
  });

  it("returns the first safety report for an identical fingerprint and 409 for changed reuse", async () => {
    const { databasePath, store, service, createUser } = setup();
    try {
      const reporter = createUser("race_reporter");
      const subject = createUser("race_subject");
      const chatId = randomUUID();
      const at = "2026-08-03T12:00:00.000Z";
      store.createChat({
        id: chatId,
        kind: "direct",
        title: null,
        directKey: [reporter.id, subject.id].sort().join(":"),
        createdBy: subject.id,
        createdAt: at
      });
      store.addChatMember(chatId, reporter.id, "member", at);
      store.addChatMember(chatId, subject.id, "member", at);
      const evidenceMessage = store.createMessage({
        id: randomUUID(),
        chatId,
        senderId: subject.id,
        body: "selected evidence",
        replyToMessageId: null,
        topicId: null,
        forwardedFromMessageId: null,
        forwardedFromChatId: null,
        forwardedFromSenderId: null,
        forwardedFromSenderName: null,
        forwardedFromCreatedAt: null,
        clientNonce: randomUUID(),
        createdAt: at
      });
      const input: CreateSafetyReport = {
        subjectAccountId: subject.id,
        category: "harassment",
        evidence: [{ type: "message", messageId: evidenceMessage.id }],
        comment: "exact selected context",
        alsoBlock: false,
        clientNonce: randomUUID()
      };

      const identicalWorker = startCompetingWriter(databasePath, {
        type: "safety-report",
        actorUserId: reporter.id,
        input
      });
      workers.push(identicalWorker.worker);
      await identicalWorker.writerHeld;
      const identicalMain = capture(() => service.createSafetyReport(reporter.id, input));
      const identicalOther = await identicalWorker.outcome;
      expect(identicalMain.ok).toBe(true);
      expect(identicalOther.ok).toBe(true);
      if (identicalMain.ok && identicalOther.ok) {
        expect(identicalMain.value.id).toBe(identicalOther.value.id);
      }

      const changedNonce = randomUUID();
      const firstFingerprint: CreateSafetyReport = { ...input, clientNonce: changedNonce };
      const changedFingerprint: CreateSafetyReport = {
        ...firstFingerprint,
        category: "spam"
      };
      const conflictWorker = startCompetingWriter(databasePath, {
        type: "safety-report",
        actorUserId: reporter.id,
        input: firstFingerprint
      });
      workers.push(conflictWorker.worker);
      await conflictWorker.writerHeld;
      const conflictMain = capture(() => service.createSafetyReport(reporter.id, changedFingerprint));
      const firstOutcome = await conflictWorker.outcome;
      expect(firstOutcome.ok).toBe(true);
      expect(conflictMain).toMatchObject({
        ok: false,
        statusCode: 409,
        code: "CONFLICT",
        message: "clientNonce was already used for a different safety report"
      });
    } finally {
      store.close();
    }
  });
});
