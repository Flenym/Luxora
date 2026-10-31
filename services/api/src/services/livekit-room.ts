import { SignJWT } from "jose";

/**
 * Creates the LiveKit room for a call before any participant token is issued.
 *
 * LiveKit rooms are created on demand only when `auto_create` is enabled on the
 * SFU. Luxora's SFU configuration disables auto-create, so without this call a
 * valid join token is rejected with "requested room does not exist".
 *
 * CreateRoom is idempotent in LiveKit: creating an existing room returns it.
 */
export interface LiveKitRoomClient {
  ensureRoom(roomName: string): Promise<void>;
}

export interface LiveKitRoomClientOptions {
  /** HTTP(S) base of the LiveKit server, derived from CALLS_LIVEKIT_URL. */
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  timeoutMs?: number;
}

const ROOM_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * CALLS_LIVEKIT_URL is `wss://host[:port]` (signalling). The Twirp API lives on
 * the same origin over https.
 */
export function livekitHttpBase(livekitUrl: string): string {
  const url = new URL(livekitUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export function createLiveKitRoomClient(options: LiveKitRoomClientOptions): LiveKitRoomClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 5_000;

  async function adminToken(): Promise<string> {
    const issuedAtSeconds = Math.floor(nowMs() / 1_000);
    return new SignJWT({
      video: { roomCreate: true, roomList: true }
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(options.apiKey)
      .setSubject("luxora-calls-admin")
      .setIssuedAt(issuedAtSeconds)
      .setNotBefore(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + 60)
      .sign(new TextEncoder().encode(options.apiSecret));
  }

  return {
    async ensureRoom(roomName: string): Promise<void> {
      if (!ROOM_NAME_PATTERN.test(roomName)) {
        throw new Error("LiveKit room name is not a valid identifier");
      }
      const token = await adminToken();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${options.baseUrl}/twirp/livekit.RoomService/CreateRoom`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: roomName, emptyTimeout: 60, maxParticipants: 50 }),
          signal: controller.signal
        });
        if (!response.ok) {
          // Never echo the body or token; the status is enough for operators.
          throw new Error(`LiveKit CreateRoom failed with status ${response.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
