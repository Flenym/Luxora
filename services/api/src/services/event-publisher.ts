import type { ServerRealtimeMessage } from "@luxora/protocol";
import type { StoredEvent } from "../domain/types.js";

export interface EventPublisher {
  publish(events: StoredEvent[]): void;
  publishEphemeral(userIds: string[], message: ServerRealtimeMessage, excludeConnectionId?: string): void;
}

export class NoopEventPublisher implements EventPublisher {
  publish(_events: StoredEvent[]): void {}
  publishEphemeral(_userIds: string[], _message: ServerRealtimeMessage, _excludeConnectionId?: string): void {}
}
