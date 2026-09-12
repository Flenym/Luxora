export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  phoneBound: boolean;
  phonePasswordEnabled: boolean;
  passwordAuthEnabled: boolean;
  activeSessions: number;
  chatCount: number;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface AdminChat {
  id: string;
  kind: "direct" | "group" | "channel";
  title: string | null;
  memberCount: number;
  messageCount: number;
  createdAt: string;
}

export interface AdminStatus {
  migrationId: string;
  users: number;
  activeSessions: number;
  chatsByKind: { direct: number; group: number; channel: number };
  messages: number;
  phoneIdentities: number;
  pendingOutbox: number;
  failedOutbox: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

async function requestJson<T>(base: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const envelope = body as { error?: { code?: string; message?: string } } | null;
    throw new AdminApiError(
      response.status,
      envelope?.error?.message ?? `Сервер ответил ${response.status}`,
    );
  }
  return body as T;
}

export function fetchStatus(base: string, token: string): Promise<AdminStatus> {
  return requestJson<AdminStatus>(base, token, "/v1/admin/status");
}

export function fetchUsers(
  base: string,
  token: string,
  limit: number,
  cursor?: string,
): Promise<Page<AdminUser>> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) params.set("cursor", cursor);
  return requestJson<Page<AdminUser>>(base, token, `/v1/admin/users?${params}`);
}

export function fetchChats(
  base: string,
  token: string,
  limit: number,
  cursor?: string,
): Promise<Page<AdminChat>> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) params.set("cursor", cursor);
  return requestJson<Page<AdminChat>>(base, token, `/v1/admin/chats?${params}`);
}
