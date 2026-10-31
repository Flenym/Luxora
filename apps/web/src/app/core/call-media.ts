/**
 * Isolated call-media adapter for the Luxora web messenger.
 *
 * Truth rules: the Beta-0.1 QA server runs with `features.calls=false` and its
 * `POST /v1/calls/:id/join-grant` answers `503 SERVICE_UNAVAILABLE`. In that
 * configuration the messenger never claims connected audio/video; call state
 * stays `media:"unavailable"` with an explicit reason.
 *
 * The LiveKit path below is only entered when capabilities advertise calls and
 * a join grant succeeded. `livekit-client` is loaded with a dynamic import so
 * the marketing/messenger bundle does not ship it for the default build.
 */
import type { CallMediaState, MediaMode } from "../contract";
import type { JoinGrant } from "./api";

export interface CallMediaConnectInput {
  grant: JoinGrant;
  mediaMode: MediaMode;
  onStateChange(state: CallMediaState, error?: string): void;
}

export interface CallMediaConnection {
  disconnect(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
}

export interface CallMediaAdapter {
  readonly label: string;
  connect(input: CallMediaConnectInput): Promise<CallMediaConnection>;
}

export class CallMediaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallMediaUnavailableError";
  }
}

/**
 * Honest fallback: the server advertised calls but no media plane is wired in
 * this client build. It never fakes a connection.
 */
export class UnavailableCallMediaAdapter implements CallMediaAdapter {
  readonly label = "unavailable";

  async connect(input: CallMediaConnectInput): Promise<CallMediaConnection> {
    input.onStateChange("unavailable", "The media plane is not configured in this build");
    throw new CallMediaUnavailableError("The media plane is not configured in this build");
  }
}

/** Minimal LiveKit adapter, only reachable when the server proves calls work. */
export class LiveKitCallMediaAdapter implements CallMediaAdapter {
  readonly label = "livekit";

  async connect(input: CallMediaConnectInput): Promise<CallMediaConnection> {
    input.onStateChange("connecting");
    let room: import("livekit-client").Room | null = null;
    try {
      const livekit = await import("livekit-client");
      room = new livekit.Room();
      await room.connect(input.grant.serverUrl, input.grant.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (input.mediaMode === "video") {
        await room.localParticipant.setCameraEnabled(true);
      }
      room.on(livekit.RoomEvent.Disconnected, () => {
        input.onStateChange("failed", "The call media connection ended");
      });
      input.onStateChange("connected");
      const activeRoom = room;
      return {
        async disconnect() {
          await activeRoom.disconnect();
        },
        async setMuted(muted: boolean) {
          await activeRoom.localParticipant.setMicrophoneEnabled(!muted);
        }
      };
    } catch (error) {
      if (room !== null) {
        try {
          await room.disconnect();
        } catch {
          // best-effort teardown
        }
      }
      const message = error instanceof Error && error.message.length > 0
        ? error.message
        : "Could not start the call media connection";
      input.onStateChange("failed", message);
      throw new CallMediaUnavailableError(message);
    }
  }
}

/** Adapter factory used by the provider when capabilities allow calls. */
export function createCallMediaAdapter(mediaPlaneSupported: boolean): CallMediaAdapter {
  return mediaPlaneSupported ? new LiveKitCallMediaAdapter() : new UnavailableCallMediaAdapter();
}
