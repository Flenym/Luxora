import { useState } from "react";
import { AdminApiError, fetchChats, fetchStatus, fetchUsers } from "./api";
import type { AdminChat, AdminStatus, AdminUser } from "./api";

type View = "status" | "users" | "chats";

interface Connection {
  base: string;
  token: string;
}

const TOKEN_KEY = "luxora-admin-token";
const BASE_KEY = "luxora-admin-base";

function loadConnection(): Connection {
  if (typeof sessionStorage === "undefined") return { base: "", token: "" };
  return {
    base: sessionStorage.getItem(BASE_KEY) ?? "http://127.0.0.1:2222",
    token: sessionStorage.getItem(TOKEN_KEY) ?? "",
  };
}

export default function App() {
  const [base, setBase] = useState(() => loadConnection().base);
  const [token, setToken] = useState(() => loadConnection().token);
  const [connected, setConnected] = useState<Connection | null>(null);
  const [view, setView] = useState<View>("status");
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userCursor, setUserCursor] = useState<string | null>(null);
  const [chats, setChats] = useState<AdminChat[]>([]);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(nextBase: string, nextToken: string): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await fetchStatus(nextBase, nextToken);
      sessionStorage.setItem(BASE_KEY, nextBase);
      sessionStorage.setItem(TOKEN_KEY, nextToken);
      setConnected({ base: nextBase, token: nextToken });
      setStatus(snapshot);
      setUsers([]);
      setUserCursor(null);
      setChats([]);
      setChatCursor(null);
      setView("status");
    } catch (failure) {
      setError(describeError(failure, nextBase));
    } finally {
      setLoading(false);
    }
  }

  async function loadUsers(more: boolean): Promise<void> {
    if (connected === null) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchUsers(
        connected.base,
        connected.token,
        30,
        more && userCursor !== null ? userCursor : undefined,
      );
      setUsers((previous) => (more ? [...previous, ...page.items] : page.items));
      setUserCursor(page.nextCursor);
    } catch (failure) {
      setError(describeError(failure, connected.base));
    } finally {
      setLoading(false);
    }
  }

  async function loadChats(more: boolean): Promise<void> {
    if (connected === null) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchChats(
        connected.base,
        connected.token,
        30,
        more && chatCursor !== null ? chatCursor : undefined,
      );
      setChats((previous) => (more ? [...previous, ...page.items] : page.items));
      setChatCursor(page.nextCursor);
    } catch (failure) {
      setError(describeError(failure, connected.base));
    } finally {
      setLoading(false);
    }
  }

  function disconnect(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setConnected(null);
    setStatus(null);
    setUsers([]);
    setChats([]);
    setError(null);
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <div style={styles.brand}>Luxora · консоль оператора</div>
          <div style={styles.sub}>Beta-0.1 · только чтение · только loopback</div>
        </div>
        {connected !== null && (
          <button type="button" style={styles.ghost} onClick={disconnect}>
            Отключиться
          </button>
        )}
      </header>

      {connected === null ? (
        <section style={styles.card}>
          <h2 style={styles.h2}>Подключение</h2>
          <p style={styles.muted}>
            Нужен запущенный API и токен <code>ADMIN_TOKEN</code> из серверного окружения.
            Без токена поверхность недоступна (сервер отвечает 503).
          </p>
          <label style={styles.label}>
            Адрес API
            <input
              style={styles.input}
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="http://127.0.0.1:2222"
              autoComplete="off"
            />
          </label>
          <label style={styles.label}>
            Токен администратора
            <input
              style={styles.input}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            style={styles.primary}
            disabled={loading || base.trim() === "" || token.trim() === ""}
            onClick={() => void connect(base.trim(), token.trim())}
          >
            {loading ? "Подключаемся…" : "Подключиться"}
          </button>
          {error !== null && <p style={styles.error}>{error}</p>}
        </section>
      ) : (
        <>
          <nav style={styles.tabs}>
            {(
              [
                ["status", "Состояние"],
                ["users", "Пользователи"],
                ["chats", "Чаты"],
              ] as [View, string][]
            ).map(([key, title]) => (
              <button
                key={key}
                type="button"
                style={view === key ? styles.tabActive : styles.tab}
                onClick={() => {
                  setView(key);
                  setError(null);
                  if (key === "users" && users.length === 0) void loadUsers(false);
                  if (key === "chats" && chats.length === 0) void loadChats(false);
                }}
              >
                {title}
              </button>
            ))}
            <span style={styles.endpoint}>{connected.base}</span>
          </nav>

          {error !== null && <p style={styles.error}>{error}</p>}

          {view === "status" && status !== null && (
            <section style={styles.card}>
              <h2 style={styles.h2}>Состояние сервера</h2>
              <dl style={styles.grid}>
                <Stat label="Миграция" value={status.migrationId} />
                <Stat label="Пользователи" value={status.users} />
                <Stat label="Активные сессии" value={status.activeSessions} />
                <Stat label="Сообщения" value={status.messages} />
                <Stat label="Телефонные привязки" value={status.phoneIdentities} />
                <Stat label="Чаты: личные" value={status.chatsByKind.direct} />
                <Stat label="Чаты: группы" value={status.chatsByKind.group} />
                <Stat label="Чаты: каналы" value={status.chatsByKind.channel} />
                <Stat label="Outbox: ожидают" value={status.pendingOutbox} warn={status.pendingOutbox > 0} />
                <Stat label="Outbox: ошибки" value={status.failedOutbox} warn={status.failedOutbox > 0} />
              </dl>
              <button
                type="button"
                style={styles.ghost}
                disabled={loading}
                onClick={() => void connect(connected.base, connected.token)}
              >
                Обновить
              </button>
            </section>
          )}

          {view === "users" && (
            <section style={styles.card}>
              <h2 style={styles.h2}>Пользователи</h2>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <Th>Логин</Th>
                    <Th>Имя</Th>
                    <Th>Телефон</Th>
                    <Th>2FA</Th>
                    <Th>Сессии</Th>
                    <Th>Чаты</Th>
                    <Th>Создан</Th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td style={styles.td}>@{user.username}</td>
                      <td style={styles.td}>{user.displayName}</td>
                      <td style={styles.td}>{user.phoneBound ? "да" : "нет"}</td>
                      <td style={styles.td}>{user.phonePasswordEnabled ? "вкл" : "выкл"}</td>
                      <td style={styles.td}>{user.activeSessions}</td>
                      <td style={styles.td}>{user.chatCount}</td>
                      <td style={styles.td}>{new Date(user.createdAt).toLocaleString("ru-RU")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {users.length === 0 && !loading && <p style={styles.muted}>Нажмите «Загрузить».</p>}
              <div style={styles.row}>
                <button type="button" style={styles.ghost} disabled={loading} onClick={() => void loadUsers(false)}>
                  Загрузить
                </button>
                {userCursor !== null && (
                  <button type="button" style={styles.ghost} disabled={loading} onClick={() => void loadUsers(true)}>
                    Ещё
                  </button>
                )}
              </div>
            </section>
          )}

          {view === "chats" && (
            <section style={styles.card}>
              <h2 style={styles.h2}>Чаты</h2>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <Th>Тип</Th>
                    <Th>Название</Th>
                    <Th>Участники</Th>
                    <Th>Сообщения</Th>
                    <Th>Создан</Th>
                  </tr>
                </thead>
                <tbody>
                  {chats.map((chat) => (
                    <tr key={chat.id}>
                      <td style={styles.td}>{chat.kind}</td>
                      <td style={styles.td}>{chat.title ?? "—"}</td>
                      <td style={styles.td}>{chat.memberCount}</td>
                      <td style={styles.td}>{chat.messageCount}</td>
                      <td style={styles.td}>{new Date(chat.createdAt).toLocaleString("ru-RU")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {chats.length === 0 && !loading && <p style={styles.muted}>Нажмите «Загрузить».</p>}
              <div style={styles.row}>
                <button type="button" style={styles.ghost} disabled={loading} onClick={() => void loadChats(false)}>
                  Загрузить
                </button>
                {chatCursor !== null && (
                  <button type="button" style={styles.ghost} disabled={loading} onClick={() => void loadChats(true)}>
                    Ещё
                  </button>
                )}
              </div>
            </section>
          )}
        </>
      )}

      <footer style={styles.footer}>
        Панель только читает данные. Секреты (пароли, токены, номера) сервер не отдаёт.
      </footer>
    </div>
  );
}

function Th({ children }: { children: string }) {
  return <th style={styles.th}>{children}</th>;
}

function Stat({ label, value, warn = false }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div style={styles.stat}>
      <dt style={styles.dt}>{label}</dt>
      <dd style={{ ...styles.dd, color: warn ? "#ffb020" : "#f2f3f7" }}>{value}</dd>
    </div>
  );
}

function describeError(failure: unknown, base: string): string {
  if (failure instanceof AdminApiError) {
    if (failure.status === 503) return "Админ-панель выключена: задайте ADMIN_TOKEN в окружении сервера.";
    if (failure.status === 401) return "Неверный токен администратора.";
    if (failure.status === 0 || failure.message.includes("fetch")) {
      return `Нет связи с API (${base}). Проверьте, что сервер запущен.`;
    }
    return failure.message;
  }
  if (failure instanceof TypeError) return `Нет связи с API (${base}). Проверьте, что сервер запущен.`;
  return "Неизвестная ошибка подключения.";
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    margin: "0 auto",
    maxWidth: 1080,
    padding: "28px 20px 60px",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    background: "#07070b",
    color: "#f2f3f7",
    minHeight: "100vh",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  brand: { fontSize: 22, fontWeight: 700 },
  sub: { color: "#8b8fa3", fontSize: 13, marginTop: 4 },
  card: {
    background: "#101018",
    border: "1px solid #22222e",
    borderRadius: 14,
    padding: 20,
    marginBottom: 18,
  },
  h2: { margin: "0 0 12px", fontSize: 17 },
  muted: { color: "#8b8fa3", fontSize: 13 },
  label: { display: "block", fontSize: 13, margin: "12px 0" },
  input: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    marginTop: 6,
    padding: "10px 12px",
    borderRadius: 9,
    border: "1px solid #2c2c3a",
    background: "#0b0b12",
    color: "#f2f3f7",
    fontSize: 14,
  },
  primary: {
    marginTop: 6,
    padding: "10px 18px",
    borderRadius: 9,
    border: "none",
    background: "linear-gradient(135deg, #7c5cff, #4f8cff)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  ghost: {
    padding: "8px 14px",
    borderRadius: 9,
    border: "1px solid #2c2c3a",
    background: "transparent",
    color: "#f2f3f7",
    fontSize: 13,
    cursor: "pointer",
  },
  error: { color: "#ff8080", fontSize: 13 },
  tabs: { display: "flex", gap: 8, alignItems: "center", marginBottom: 14 },
  tab: {
    padding: "8px 16px",
    borderRadius: 9,
    border: "1px solid #2c2c3a",
    background: "transparent",
    color: "#f2f3f7",
    cursor: "pointer",
  },
  tabActive: {
    padding: "8px 16px",
    borderRadius: 9,
    border: "none",
    background: "linear-gradient(135deg, #7c5cff, #4f8cff)",
    color: "#fff",
    cursor: "pointer",
  },
  endpoint: { marginLeft: "auto", color: "#8b8fa3", fontSize: 12 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, margin: "0 0 14px" },
  stat: { background: "#0b0b12", border: "1px solid #22222e", borderRadius: 10, padding: 12 },
  dt: { fontSize: 12, color: "#8b8fa3" },
  dd: { margin: "4px 0 0", fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", color: "#8b8fa3", fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #22222e" },
  td: { padding: "8px 10px", borderBottom: "1px solid #1a1a24" },
  row: { display: "flex", gap: 8, marginTop: 12 },
  footer: { color: "#5b5f73", fontSize: 12, marginTop: 8 },
};
