import Foundation

/// Durable call-control state change delivered over V2 realtime.
///
/// The server publishes control state only (no media, SDP, ICE, TURN or grant
/// material). Clients re-read the full call over REST (`GET /v1/calls/:id`)
/// before acting on it, so this payload is intentionally small.
struct CallStateRealtimeDispatch: Equatable, Sendable {
    let callID: UUID
    let chatID: UUID
    let state: CallStateValue
    let revision: Int
    let occurredAt: Date
    let sequence: Int
    let cursor: String
}

enum CallStateValue: String, Codable, Equatable, Sendable, CaseIterable {
    case created
    case inviting
    case ringing
    case connecting
    case active
    case reconnecting
    case ending
    case ended
}

enum CallRealtimeFrameDecoder {
    private struct Header: Decodable {
        let type: String
    }

    private struct LooseDispatch: Decodable {
        let cursor: String?
        let event: EventHeader
    }

    private struct EventHeader: Decodable {
        let type: String
    }

    private struct Dispatch: Decodable {
        let type: String
        let sequence: Int
        let cursor: String
        let event: Event
    }

    private struct Event: Decodable {
        let type: String
        let callId: UUID
        let chatId: UUID
        let state: CallStateValue
        let revision: Int
        let occurredAt: Date
    }

    /// Returns nil for frames that are not call-state events, so the caller can
    /// route them elsewhere. Throws on a call-state frame that is malformed.
    static func decode(_ data: Data) throws -> CallStateRealtimeDispatch? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let header: Header
        let loose: LooseDispatch
        do {
            header = try decoder.decode(Header.self, from: data)
            guard header.type == "dispatch" else { return nil }
            loose = try decoder.decode(LooseDispatch.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        guard loose.event.type == "call.state.changed" else { return nil }

        let object: [String: Any]
        do {
            guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw LuxoraAPIError.invalidResponse
            }
            object = parsed
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        guard Set(object.keys) == ["type", "sequence", "cursor", "event"],
              let eventObject = object["event"] as? [String: Any],
              Set(eventObject.keys) == ["type", "callId", "chatId", "state", "revision", "occurredAt"]
        else { throw LuxoraAPIError.invalidResponse }

        let dispatch: Dispatch
        do {
            dispatch = try decoder.decode(Dispatch.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        guard dispatch.type == "dispatch",
              dispatch.sequence > 0,
              RealtimeCursorValidator.isValid(dispatch.cursor),
              dispatch.event.revision >= 0
        else { throw LuxoraAPIError.invalidResponse }

        return CallStateRealtimeDispatch(
            callID: dispatch.event.callId,
            chatID: dispatch.event.chatId,
            state: dispatch.event.state,
            revision: dispatch.event.revision,
            occurredAt: dispatch.event.occurredAt,
            sequence: dispatch.sequence,
            cursor: dispatch.cursor
        )
    }
}
