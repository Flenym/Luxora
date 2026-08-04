import { parentPort, workerData } from "node:worker_threads";
import type {
  AddChatMemberRequest,
  EditMessageRequest,
  ForwardMessageRequest,
  RemoveChatMemberRequest,
  SendMessageRequest,
  UpdateChatMemberRoleRequest
} from "@luxora/protocol";
import { AppError } from "../errors.js";
import { SearchHasher } from "../infrastructure/search-hasher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { ChatService } from "../services/chat-service.js";

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

interface WorkerInput {
  databasePath: string;
  operation: ChatRaceOperation;
  fixedNow?: string;
  holdMilliseconds: number;
  gate: SharedArrayBuffer;
}

const data = workerData as WorkerInput;
const port = parentPort;
if (port === null) throw new Error("Chat concurrency worker requires a parent port");

function installFixedClock(iso: string): void {
  const NativeDate = globalThis.Date;
  const fixedMilliseconds = new NativeDate(iso).getTime();
  if (!Number.isSafeInteger(fixedMilliseconds)) throw new Error("Worker fixed clock is invalid");
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

const store = new SqliteStore(data.databasePath);
const service = new ChatService(
  store,
  { publish() {}, publishEphemeral() {} },
  new SearchHasher({}, undefined)
);

try {
  if (data.fixedNow !== undefined) installFixedClock(data.fixedNow);
  const value = store.immediateTransaction(() => {
    const result = execute(service, data.operation);
    port.postMessage({ type: "writer-held" });
    // Hold the fully-mutated transaction open so another process observes the
    // old committed snapshot, then contends at its first write/CAS.
    Atomics.wait(new Int32Array(data.gate), 0, 0, data.holdMilliseconds);
    return result;
  });
  port.postMessage({ type: "result", outcome: { ok: true, value } });
} catch (error) {
  port.postMessage({
    type: "result",
    outcome: error instanceof AppError
      ? {
          ok: false,
          statusCode: error.statusCode,
          code: error.code,
          message: error.message
        }
      : {
          ok: false,
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
  });
} finally {
  store.close();
}
