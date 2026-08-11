import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  CreateChatFolderRequest,
  DeleteChatFolderRequest,
  PatchChatFolderRequest,
  ReorderChatFoldersRequest
} from "@luxora/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatFolderRecord, UserRecord } from "./domain/types.js";
import { AppError } from "./errors.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { ChatFolderService } from "./services/chat-folder-service.js";

const BASE_TIME = "2026-08-11T10:00:00.000Z";
const RACE_TIME = "2026-08-11T10:01:00.000Z";
const FUTURE_TIME = "2026-08-12T10:00:00.000Z";
const ROLLED_BACK_TIME = "2026-08-10T10:00:00.000Z";
const WORKER_PROTOCOL_TIMEOUT_MS = 5_000;

const DEFAULT_RULES = {
  includeKinds: ["direct", "group", "channel"],
  unreadOnly: false,
  excludeMuted: true,
  includeArchived: false
} as const;

type FolderRaceOperation =
  | { type: "create"; userId: string; input: CreateChatFolderRequest }
  | {
      type: "patch";
      userId: string;
      folderId: string;
      input: PatchChatFolderRequest;
    }
  | {
      type: "delete";
      userId: string;
      folderId: string;
      input: DeleteChatFolderRequest;
    }
  | { type: "reorder"; userId: string; input: ReorderChatFoldersRequest };

type RaceOutcome =
  | { ok: true; value: any }
  | { ok: false; statusCode: number; code: string; message: string };

interface Fixture {
  directory: string;
  databasePath: string;
  encryptionKeyId: string;
  encryptionKey: string;
  account: UserRecord;
}

interface RunningWorker {
  worker: Worker;
  ready: Promise<void>;
  outcome: Promise<RaceOutcome>;
  closed: Promise<void>;
}

interface ExpectedHealth {
  stateRevision: number;
  eventCount: number;
  folderCount: number;
  receiptCount: number;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

const port = parentPort;
if (port === null) throw new Error("Chat-folder race worker requires a parent port");

function installFixedClock(iso) {
  const NativeDate = globalThis.Date;
  const fixedMilliseconds = new NativeDate(iso).getTime();
  class FixedDate extends NativeDate {
    constructor(value) {
      if (arguments.length === 0) super(fixedMilliseconds);
      else super(value);
    }
    static now() {
      return fixedMilliseconds;
    }
  }
  globalThis.Date = FixedDate;
}

function execute(service, operation) {
  switch (operation.type) {
    case "create":
      return service.create(operation.userId, operation.input);
    case "patch":
      return service.patch(operation.userId, operation.folderId, operation.input);
    case "delete":
      return service.delete(operation.userId, operation.folderId, operation.input);
    case "reorder":
      return service.reorder(operation.userId, operation.input);
    default:
      throw new Error("Unknown chat-folder race operation");
  }
}

function failure(error) {
  if (
    error !== null &&
    typeof error === "object" &&
    typeof error.statusCode === "number" &&
    typeof error.code === "string"
  ) {
    return {
      ok: false,
      statusCode: error.statusCode,
      code: error.code,
      message: typeof error.message === "string" ? error.message : "Application error"
    };
  }
  return {
    ok: false,
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}

void (async () => {
  let store;
  try {
    const { tsImport } = await import("tsx/esm/api");
    const [
      { SqliteStore },
      { AesGcmContentCipher },
      { ChatFolderService }
    ] = await Promise.all([
      tsImport(workerData.sqliteStoreUrl, workerData.workerParentUrl),
      tsImport(workerData.contentCipherUrl, workerData.workerParentUrl),
      tsImport(workerData.chatFolderServiceUrl, workerData.workerParentUrl)
    ]);
    installFixedClock(workerData.fixedNow);
    store = new SqliteStore(
      workerData.databasePath,
      new AesGcmContentCipher(
        { [workerData.encryptionKeyId]: workerData.encryptionKey },
        workerData.encryptionKeyId
      )
    );
    const service = new ChatFolderService(store, {
      publish() {},
      publishEphemeral() {}
    });
    const gate = new Int32Array(workerData.gate);
    Atomics.add(gate, 0, 1);
    Atomics.notify(gate, 0);
    port.postMessage({ type: "ready" });
    Atomics.wait(gate, 1, 0);

    let outcome;
    try {
      outcome = { ok: true, value: execute(service, workerData.operation) };
    } catch (error) {
      outcome = failure(error);
    }
    Atomics.add(gate, 2, 1);
    Atomics.notify(gate, 2);
    store.close();
    store = undefined;
    port.postMessage({ type: "result", outcome });
  } catch (error) {
    if (store !== undefined) {
      try {
        store.close();
      } catch {}
    }
    port.postMessage({ type: "result", outcome: failure(error) });
  }
})();
`;

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

function withFixedClock<T>(iso: string, operation: () => T): T {
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

describe("chat-folder convergence across independent SQLite writers", () => {
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

  function cipher(fixture: Pick<Fixture, "encryptionKeyId" | "encryptionKey">) {
    return new AesGcmContentCipher(
      { [fixture.encryptionKeyId]: fixture.encryptionKey },
      fixture.encryptionKeyId
    );
  }

  function openStore(fixture: Fixture): SqliteStore {
    return new SqliteStore(fixture.databasePath, cipher(fixture));
  }

  function openService(fixture: Fixture): {
    store: SqliteStore;
    service: ChatFolderService;
  } {
    const store = openStore(fixture);
    return {
      store,
      service: new ChatFolderService(store, { publish() {}, publishEphemeral() {} })
    };
  }

  function setup(): Fixture {
    const directory = mkdtempSync(join(tmpdir(), "luxora-chat-folders-race-"));
    temporaryDirectories.push(directory);
    const fixtureWithoutAccount = {
      directory,
      databasePath: join(directory, "luxora.sqlite"),
      encryptionKeyId: "chat_folder_race",
      encryptionKey: randomBytes(32).toString("base64url")
    };
    const store = new SqliteStore(
      fixtureWithoutAccount.databasePath,
      cipher(fixtureWithoutAccount)
    );
    try {
      const username = "folder_race_" + randomUUID().slice(0, 8);
      const account = store.createUser({
        id: randomUUID(),
        username,
        usernameNormalized: username,
        displayName: username,
        passwordHash: "test-only-password-hash",
        createdAt: BASE_TIME
      });
      return { ...fixtureWithoutAccount, account };
    } finally {
      store.close();
    }
  }

  function createInput(title: string, clientNonce = randomUUID()): CreateChatFolderRequest {
    return {
      title,
      rules: { ...DEFAULT_RULES, includeKinds: [...DEFAULT_RULES.includeKinds] },
      overrides: [],
      clientNonce
    };
  }

  function seedFolders(
    fixture: Fixture,
    count: number,
    createdAt = BASE_TIME
  ): ChatFolderRecord[] {
    const { store, service } = openService(fixture);
    try {
      return withFixedClock(createdAt, () => Array.from({ length: count }, (_, index) =>
        service.create(
          fixture.account.id,
          createInput("Seed " + (index + 1))
        ).folder
      )).map((folder) => store.findChatFolder(fixture.account.id, folder.id) as ChatFolderRecord);
    } finally {
      store.close();
    }
  }

  function seedOwnedChats(fixture: Fixture, count: number): string[] {
    const store = openStore(fixture);
    try {
      return Array.from({ length: count }, (_, index) => {
        const chatId = randomUUID();
        store.createChat({
          id: chatId,
          kind: "group",
          title: "Snapshot chat " + (index + 1),
          directKey: null,
          createdBy: fixture.account.id,
          createdAt: BASE_TIME
        });
        store.addChatMember(chatId, fixture.account.id, "owner", BASE_TIME);
        return chatId;
      });
    } finally {
      store.close();
    }
  }

  function startWorker(
    fixture: Fixture,
    operation: FolderRaceOperation,
    gate: SharedArrayBuffer
  ): RunningWorker {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: ["--import", "tsx"],
      workerData: {
        databasePath: fixture.databasePath,
        encryptionKeyId: fixture.encryptionKeyId,
        encryptionKey: fixture.encryptionKey,
        fixedNow: RACE_TIME,
        operation,
        gate,
        workerParentUrl: import.meta.url,
        sqliteStoreUrl: new URL("./infrastructure/sqlite-store.ts", import.meta.url).href,
        contentCipherUrl: new URL("./infrastructure/content-cipher.ts", import.meta.url).href,
        chatFolderServiceUrl: new URL("./services/chat-folder-service.ts", import.meta.url).href
      }
    });
    workers.push(worker);

    let readySettled = false;
    let outcomeSettled = false;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    let resolveOutcome: ((outcome: RaceOutcome) => void) | undefined;
    let rejectOutcome: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const outcome = new Promise<RaceOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const closed = new Promise<void>((resolve, reject) => {
      worker.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Chat-folder race worker exited with code " + code));
        if (!readySettled) {
          readySettled = true;
          rejectReady?.(new Error("Chat-folder race worker exited before reaching the barrier"));
        }
        if (!outcomeSettled) {
          outcomeSettled = true;
          rejectOutcome?.(new Error("Chat-folder race worker exited before returning an outcome"));
        }
      });
    });
    worker.on("message", (message: any) => {
      if (message.type === "ready" && !readySettled) {
        readySettled = true;
        resolveReady?.();
        return;
      }
      if (message.type !== "result" || outcomeSettled) return;
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(new Error(
          "Chat-folder race worker failed before reaching the barrier: " +
          JSON.stringify(message.outcome)
        ));
      }
      outcomeSettled = true;
      resolveOutcome?.(message.outcome as RaceOutcome);
    });
    worker.once("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(error);
      }
      if (outcomeSettled) return;
      outcomeSettled = true;
      rejectOutcome?.(error);
    });
    return { worker, ready, outcome, closed };
  }

  function releaseWorkers(gateBuffer: SharedArrayBuffer, count: number): void {
    const gate = new Int32Array(gateBuffer);
    expect(Atomics.load(gate, 0)).toBe(count);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1, count);
  }

  async function race(
    fixture: Fixture,
    first: FolderRaceOperation,
    second: FolderRaceOperation
  ): Promise<[RaceOutcome, RaceOutcome]> {
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const firstWorker = startWorker(fixture, first, gate);
    const secondWorker = startWorker(fixture, second, gate);
    await Promise.all([firstWorker.ready, secondWorker.ready]);
    releaseWorkers(gate, 2);
    const outcomes = await Promise.all([firstWorker.outcome, secondWorker.outcome]);
    await Promise.all([firstWorker.closed, secondWorker.closed]);
    return outcomes;
  }

  function assertOneSuccessOneConflict(outcomes: RaceOutcome[]): RaceOutcome {
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const failure = outcomes.find((outcome) => !outcome.ok);
    expect(failure).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "CONFLICT"
    });
    return failure as RaceOutcome;
  }

  function assertHealth(fixture: Fixture, expected: ExpectedHealth): ChatFolderRecord[] {
    const store = openStore(fixture);
    const inspection = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(inspection.pragma("foreign_key_check")).toEqual([]);

      const state = inspection.prepare(
        "SELECT revision FROM chat_folder_states WHERE user_id = ?"
      ).get(fixture.account.id) as { revision: number } | undefined;
      expect(state?.revision ?? 0).toBe(expected.stateRevision);
      expect(store.getChatFolderStateRevision(fixture.account.id)).toBe(expected.stateRevision);

      const eventCount = inspection.prepare(
        "SELECT count(*) AS count FROM realtime_events " +
        "WHERE audience_user_id = ? AND event_type = 'chat.folders.updated'"
      ).get(fixture.account.id) as { count: number };
      expect(eventCount.count).toBe(expected.eventCount);
      const outboxCount = inspection.prepare(
        "SELECT count(*) AS count FROM realtime_outbox"
      ).get() as { count: number };
      expect(outboxCount.count).toBe(expected.eventCount);

      const receipts = inspection.prepare(
        "SELECT response_ciphertext FROM chat_folder_command_receipts WHERE user_id = ?"
      ).all(fixture.account.id) as Array<{ response_ciphertext: string }>;
      expect(receipts).toHaveLength(expected.receiptCount);
      expect(receipts.every((receipt) =>
        receipt.response_ciphertext.startsWith("luxora:v1.")
      )).toBe(true);

      const folders = store.listChatFolders(fixture.account.id);
      expect(folders).toHaveLength(expected.folderCount);
      expect(folders.map((folder) => folder.position)).toEqual(
        Array.from({ length: expected.folderCount }, (_, index) => index)
      );
      expect(new Set(folders.map((folder) => folder.id)).size).toBe(expected.folderCount);
      expect(folders.every((folder) => folder.revision >= 1)).toBe(true);
      const listed = new ChatFolderService(
        store,
        { publish() {}, publishEphemeral() {} }
      ).list(fixture.account.id);
      expect(listed.stateRevision).toBe(expected.stateRevision);
      expect(listed.items.map((folder) => folder.id)).toEqual(
        folders.map((folder) => folder.id)
      );
      return folders;
    } finally {
      inspection.close();
      store.close();
    }
  }

  it("converges the exact same create nonce to one folder, receipt and event", async () => {
    const fixture = setup();
    const input = createInput("Exact concurrent create", randomUUID());
    const outcomes = await race(
      fixture,
      { type: "create", userId: fixture.account.id, input },
      { type: "create", userId: fixture.account.id, input }
    );

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    if (outcomes[0].ok && outcomes[1].ok) {
      expect(outcomes[0].value.folder.id).toBe(outcomes[1].value.folder.id);
      expect([
        outcomes[0].value.replayed,
        outcomes[1].value.replayed
      ].sort()).toEqual([false, true]);
      expect([
        outcomes[0].value.stateRevision,
        outcomes[1].value.stateRevision
      ]).toEqual([1, 1]);
    }
    const folders = assertHealth(fixture, {
      stateRevision: 1,
      eventCount: 1,
      folderCount: 1,
      receiptCount: 1
    });
    expect(folders[0]?.title).toBe(input.title);
  });

  it("returns a stable 409 when the same create nonce is reused with changed content", async () => {
    const fixture = setup();
    const nonce = randomUUID();
    const firstInput = createInput("First create fingerprint", nonce);
    const secondInput = createInput("Changed create fingerprint", nonce);
    const outcomes = await race(
      fixture,
      { type: "create", userId: fixture.account.id, input: firstInput },
      { type: "create", userId: fixture.account.id, input: secondInput }
    );
    const conflict = assertOneSuccessOneConflict(outcomes);
    const success = outcomes.find((outcome) => outcome.ok);
    if (success === undefined || !success.ok) throw new Error("Expected one create winner");
    const winningInput = success.value.folder.title === firstInput.title ? firstInput : secondInput;
    const losingInput = winningInput === firstInput ? secondInput : firstInput;

    const { store, service } = openService(fixture);
    try {
      const firstRetry = capture(() => service.create(fixture.account.id, losingInput));
      const secondRetry = capture(() => service.create(fixture.account.id, losingInput));
      expect(firstRetry).toEqual(conflict);
      expect(secondRetry).toEqual(conflict);
      expect(service.create(fixture.account.id, winningInput)).toMatchObject({
        folder: { id: success.value.folder.id, title: winningInput.title },
        stateRevision: 1,
        replayed: true
      });
    } finally {
      store.close();
    }
    assertHealth(fixture, {
      stateRevision: 1,
      eventCount: 1,
      folderCount: 1,
      receiptCount: 1
    });
  });

  it("allows one expectedRevision patch writer and rejects the stale writer", async () => {
    const fixture = setup();
    const [original] = seedFolders(fixture, 1);
    if (original === undefined) throw new Error("Expected a seeded folder");
    const firstPatch: PatchChatFolderRequest = {
      title: "First patch winner",
      expectedRevision: 1,
      clientNonce: randomUUID()
    };
    const secondPatch: PatchChatFolderRequest = {
      title: "Second patch winner",
      expectedRevision: 1,
      clientNonce: randomUUID()
    };
    const outcomes = await race(
      fixture,
      { type: "patch", userId: fixture.account.id, folderId: original.id, input: firstPatch },
      { type: "patch", userId: fixture.account.id, folderId: original.id, input: secondPatch }
    );
    assertOneSuccessOneConflict(outcomes);
    const winner = outcomes.find((outcome) => outcome.ok);
    if (winner === undefined || !winner.ok) throw new Error("Expected one patch winner");

    const folders = assertHealth(fixture, {
      stateRevision: 2,
      eventCount: 2,
      folderCount: 1,
      receiptCount: 2
    });
    expect(folders[0]).toMatchObject({
      id: original.id,
      title: winner.value.folder.title,
      revision: 2,
      position: 0
    });
  });

  it("keeps state valid when delete races an expectedRevision patch", async () => {
    const fixture = setup();
    const [original] = seedFolders(fixture, 1);
    if (original === undefined) throw new Error("Expected a seeded folder");
    const deleteInput: DeleteChatFolderRequest = {
      expectedRevision: 1,
      clientNonce: randomUUID()
    };
    const patchInput: PatchChatFolderRequest = {
      title: "Patch racing delete",
      expectedRevision: 1,
      clientNonce: randomUUID()
    };
    const [deleted, patched] = await race(
      fixture,
      { type: "delete", userId: fixture.account.id, folderId: original.id, input: deleteInput },
      { type: "patch", userId: fixture.account.id, folderId: original.id, input: patchInput }
    );
    expect([deleted, patched].filter((outcome) => outcome.ok)).toHaveLength(1);
    const loser = [deleted, patched].find((outcome) => !outcome.ok);
    if (loser === undefined || loser.ok) throw new Error("Expected one delete/patch loser");
    expect([404, 409]).toContain(loser.statusCode);

    const folderCount = deleted.ok ? 0 : 1;
    const folders = assertHealth(fixture, {
      stateRevision: 2,
      eventCount: 2,
      folderCount,
      receiptCount: 2
    });
    if (!deleted.ok) {
      expect(patched.ok).toBe(true);
      expect(deleted).toMatchObject({ statusCode: 409, code: "CONFLICT" });
      expect(folders[0]).toMatchObject({
        id: original.id,
        title: patchInput.title,
        revision: 2
      });
    } else {
      expect(patched).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    }
  });

  it("keeps positions and revisions valid when delete races a real reorder", async () => {
    const fixture = setup();
    const seeded = seedFolders(fixture, 3);
    const [first, second, third] = seeded;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Expected three seeded folders");
    }
    const deleteInput: DeleteChatFolderRequest = {
      expectedRevision: 1,
      clientNonce: randomUUID()
    };
    const reorderInput: ReorderChatFoldersRequest = {
      folderIds: [third.id, second.id, first.id],
      expectedStateRevision: 3,
      clientNonce: randomUUID()
    };
    const [deleted, reordered] = await race(
      fixture,
      { type: "delete", userId: fixture.account.id, folderId: first.id, input: deleteInput },
      { type: "reorder", userId: fixture.account.id, input: reorderInput }
    );
    assertOneSuccessOneConflict([deleted, reordered]);

    const folderCount = deleted.ok ? 2 : 3;
    const folders = assertHealth(fixture, {
      stateRevision: 4,
      eventCount: 4,
      folderCount,
      receiptCount: 4
    });
    if (deleted.ok) {
      expect(reordered).toMatchObject({ statusCode: 409, code: "CONFLICT" });
      expect(folders.map((folder) => folder.id)).toEqual([second.id, third.id]);
      expect(folders.map((folder) => folder.revision)).toEqual([2, 2]);
    } else {
      expect(deleted).toMatchObject({ statusCode: 409, code: "CONFLICT" });
      expect(folders.map((folder) => folder.id)).toEqual(reorderInput.folderIds);
      expect(folders.map((folder) => folder.revision)).toEqual([2, 1, 2]);
    }
  });

  it("allows only one reorder writer for the same account state revision", async () => {
    const fixture = setup();
    const seeded = seedFolders(fixture, 3);
    const [first, second, third] = seeded;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Expected three seeded folders");
    }
    const firstReorder: ReorderChatFoldersRequest = {
      folderIds: [third.id, first.id, second.id],
      expectedStateRevision: 3,
      clientNonce: randomUUID()
    };
    const secondReorder: ReorderChatFoldersRequest = {
      folderIds: [second.id, third.id, first.id],
      expectedStateRevision: 3,
      clientNonce: randomUUID()
    };
    const outcomes = await race(
      fixture,
      { type: "reorder", userId: fixture.account.id, input: firstReorder },
      { type: "reorder", userId: fixture.account.id, input: secondReorder }
    );
    assertOneSuccessOneConflict(outcomes);
    const winner = outcomes.find((outcome) => outcome.ok);
    if (winner === undefined || !winner.ok) throw new Error("Expected one reorder winner");

    const folders = assertHealth(fixture, {
      stateRevision: 4,
      eventCount: 4,
      folderCount: 3,
      receiptCount: 4
    });
    expect(folders.map((folder) => folder.id)).toEqual(
      winner.value.items.map((folder: { id: string }) => folder.id)
    );
    expect(folders.map((folder) => folder.revision)).toEqual([2, 2, 2]);
  });

  it("reads folders, overrides and state revision from one SQLite snapshot", async () => {
    const fixture = setup();
    const [firstChatId, secondChatId] = seedOwnedChats(fixture, 2);
    if (firstChatId === undefined || secondChatId === undefined) {
      throw new Error("Expected two snapshot fixture chats");
    }
    const { store: seedStore, service: seedService } = openService(fixture);
    let original: ChatFolderRecord;
    try {
      original = seedService.create(fixture.account.id, {
        ...createInput("Old snapshot folder"),
        overrides: [{ chatId: firstChatId, mode: "include", pinnedPosition: 0 }]
      }).folder as ChatFolderRecord;
    } finally {
      seedStore.close();
    }

    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const writer = startWorker(fixture, {
      type: "patch",
      userId: fixture.account.id,
      folderId: original.id,
      input: {
        title: "New snapshot folder",
        overrides: [{ chatId: secondChatId, mode: "exclude", pinnedPosition: null }],
        expectedRevision: 1,
        clientNonce: randomUUID()
      }
    }, gate);
    await writer.ready;

    const reader = openStore(fixture);
    const unwrappedList = reader.listChatFolders.bind(reader);
    let interceptedListReads = 0;
    reader.listChatFolders = (userId: string): ChatFolderRecord[] => {
      const items = unwrappedList(userId);
      interceptedListReads += 1;
      releaseWorkers(gate, 1);
      const workerGate = new Int32Array(gate);
      const waitResult = Atomics.wait(
        workerGate,
        2,
        0,
        WORKER_PROTOCOL_TIMEOUT_MS
      );
      if (waitResult === "timed-out") {
        throw new Error("Snapshot writer did not commit while the reader transaction was open");
      }
      expect(Atomics.load(workerGate, 2)).toBe(1);
      return items;
    };

    let oldSnapshot: ReturnType<SqliteStore["getChatFolderSnapshot"]>;
    try {
      oldSnapshot = reader.getChatFolderSnapshot(fixture.account.id);
    } finally {
      reader.listChatFolders = unwrappedList;
    }
    const writerOutcome = await writer.outcome;
    await writer.closed;
    expect(writerOutcome).toMatchObject({
      ok: true,
      value: {
        folder: {
          id: original.id,
          title: "New snapshot folder",
          revision: 2,
          overrides: [{ chatId: secondChatId, mode: "exclude", pinnedPosition: null }]
        },
        stateRevision: 2
      }
    });
    expect(interceptedListReads).toBe(1);
    expect(oldSnapshot).toMatchObject({
      items: [{
        id: original.id,
        title: "Old snapshot folder",
        revision: 1,
        overrides: [{ chatId: firstChatId, mode: "include", pinnedPosition: 0 }]
      }],
      stateRevision: 1
    });

    const newSnapshot = reader.getChatFolderSnapshot(fixture.account.id);
    reader.close();
    expect(newSnapshot).toMatchObject({
      items: [{
        id: original.id,
        title: "New snapshot folder",
        revision: 2,
        overrides: [{ chatId: secondChatId, mode: "exclude", pinnedPosition: null }]
      }],
      stateRevision: 2
    });
    assertHealth(fixture, {
      stateRevision: 2,
      eventCount: 2,
      folderCount: 1,
      receiptCount: 2
    });
  });

  it("keeps patch, reorder and delete monotonic after the wall clock rolls back", () => {
    const fixture = setup();
    const seeded = seedFolders(fixture, 3, FUTURE_TIME);
    const [first, second, third] = seeded;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Expected three future-dated folders");
    }
    const patchNonce = randomUUID();
    const reorderNonce = randomUUID();
    const deleteNonce = randomUUID();

    const { store, service } = openService(fixture);
    try {
      withFixedClock(ROLLED_BACK_TIME, () => {
        const patched = service.patch(fixture.account.id, first.id, {
          title: "Future floor patch",
          expectedRevision: 1,
          clientNonce: patchNonce
        });
        expect(Date.parse(patched.folder.updatedAt)).toBeGreaterThan(Date.parse(FUTURE_TIME));

        const reordered = service.reorder(fixture.account.id, {
          folderIds: [third.id, second.id, first.id],
          expectedStateRevision: 4,
          clientNonce: reorderNonce
        });
        expect(reordered.stateRevision).toBe(5);
        expect(reordered.items.filter((folder) => folder.revision > 1).every((folder) =>
          Date.parse(folder.updatedAt) > Date.parse(FUTURE_TIME)
        )).toBe(true);

        const currentThird = store.findChatFolder(fixture.account.id, third.id);
        if (currentThird === null) throw new Error("Expected reordered delete target");
        expect(service.delete(fixture.account.id, third.id, {
          expectedRevision: currentThird.revision,
          clientNonce: deleteNonce
        })).toMatchObject({ folderId: third.id, stateRevision: 6 });
      });
    } finally {
      store.close();
    }

    const inspection = new Database(fixture.databasePath, { readonly: true });
    try {
      const receipts = inspection.prepare(`
        SELECT client_nonce, operation, created_at, expires_at
        FROM chat_folder_command_receipts
        WHERE user_id = ? AND client_nonce IN (?, ?, ?)
      `).all(
        fixture.account.id,
        patchNonce,
        reorderNonce,
        deleteNonce
      ) as Array<{
        client_nonce: string;
        operation: string;
        created_at: string;
        expires_at: string;
      }>;
      expect(receipts).toHaveLength(3);
      const receiptByNonce = new Map(receipts.map((receipt) => [receipt.client_nonce, receipt]));
      expect(receiptByNonce.get(patchNonce)?.operation).toBe("update");
      expect(receiptByNonce.get(reorderNonce)?.operation).toBe("reorder");
      expect(receiptByNonce.get(deleteNonce)?.operation).toBe("delete");
      const expectedExpiry = new Date(
        Date.parse(ROLLED_BACK_TIME) + 86_400 * 1_000
      ).toISOString();
      for (const receipt of receipts) {
        expect(receipt.created_at).toBe(ROLLED_BACK_TIME);
        expect(receipt.expires_at).toBe(expectedExpiry);
        expect((Date.parse(receipt.expires_at) - Date.parse(receipt.created_at)) / 1_000)
          .toBe(86_400);
      }
      const state = inspection.prepare(`
        SELECT updated_at FROM chat_folder_states WHERE user_id = ?
      `).get(fixture.account.id) as { updated_at: string };
      expect(Date.parse(state.updated_at)).toBeGreaterThan(Date.parse(FUTURE_TIME));
      expect(receipts.every((receipt) => receipt.created_at !== state.updated_at)).toBe(true);
      expect(receipts.every((receipt) => Date.parse(receipt.expires_at) < Date.parse(state.updated_at)))
        .toBe(true);
    } finally {
      inspection.close();
    }

    const folders = assertHealth(fixture, {
      stateRevision: 6,
      eventCount: 6,
      folderCount: 2,
      receiptCount: 6
    });
    expect(folders.map((folder) => folder.id)).toEqual([second.id, first.id]);
    expect(folders.every((folder) => Date.parse(folder.updatedAt) > Date.parse(FUTURE_TIME)))
      .toBe(true);
    expect(folders.map((folder) => folder.revision)).toEqual([2, 4]);
  });

  it("never exceeds ten folders under concurrent distinct creates", async () => {
    const fixture = setup();
    seedFolders(fixture, 9);
    const firstInput = createInput("Concurrent limit A");
    const secondInput = createInput("Concurrent limit B");
    const outcomes = await race(
      fixture,
      { type: "create", userId: fixture.account.id, input: firstInput },
      { type: "create", userId: fixture.account.id, input: secondInput }
    );
    assertOneSuccessOneConflict(outcomes);

    const folders = assertHealth(fixture, {
      stateRevision: 10,
      eventCount: 10,
      folderCount: 10,
      receiptCount: 10
    });
    expect(folders.filter((folder) =>
      folder.title === firstInput.title || folder.title === secondInput.title
    )).toHaveLength(1);
  });
});
