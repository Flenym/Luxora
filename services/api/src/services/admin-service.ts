import { z } from "zod";
import {
  AdminChatListResponseSchema,
  AdminStatusResponseSchema,
  AdminUserListResponseSchema,
  IdSchema,
  TimestampSchema,
  type AdminChatListResponse,
  type AdminStatusResponse,
  type AdminUserListResponse
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";

const AdminCursorSchema = z.object({
  createdAt: TimestampSchema,
  id: IdSchema
}).strict();

const PAGE_LIMIT_MAX = 100;

function encodeCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): { createdAt: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  const result = AdminCursorSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/**
 * Read-only operator projections for the loopback admin console.
 * The service never touches password material, digests, ciphertext, tokens
 * or phone numbers; those columns are simply not selected.
 */
export class AdminService {
  constructor(private readonly store: Store) {}

  status(): AdminStatusResponse {
    return AdminStatusResponseSchema.parse(this.store.adminStatus());
  }

  users(limit: number, cursor?: string): AdminUserListResponse {
    const bounded = Math.min(Math.max(1, Math.floor(limit)), PAGE_LIMIT_MAX);
    const decoded = decodeCursor(cursor);
    const page = this.store.adminUserPage(bounded, decoded);
    return AdminUserListResponseSchema.parse({
      items: page.items,
      nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor)
    });
  }

  chats(limit: number, cursor?: string): AdminChatListResponse {
    const bounded = Math.min(Math.max(1, Math.floor(limit)), PAGE_LIMIT_MAX);
    const decoded = decodeCursor(cursor);
    const page = this.store.adminChatPage(bounded, decoded);
    return AdminChatListResponseSchema.parse({
      items: page.items,
      nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor)
    });
  }
}
