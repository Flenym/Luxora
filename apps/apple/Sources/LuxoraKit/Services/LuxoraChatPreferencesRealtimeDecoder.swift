import Foundation

struct ChatPreferencesRealtimeDispatch: Equatable, Sendable {
    let accountID: UUID
    let chatID: UUID
    let preferences: ChatPreferences
    let changedAt: Date
    let sequence: Int
    let cursor: String
}

enum ChatPreferencesRealtimeFrameDecoder {
    private struct Header: Decodable {
        let type: String
    }

    private struct EventHeader: Decodable {
        let type: String
    }

    private struct LooseDispatch: Decodable {
        let cursor: String?
        let event: EventHeader
    }

    private struct Dispatch: Decodable {
        let type: String
        let sequence: Int
        let cursor: String
        let event: Event
    }

    private struct Event: Decodable {
        let type: String
        let audience: String
        let accountId: UUID
        let chatId: UUID
        let preferences: APIChatPreferences
        let changedAt: Date
    }

    static func decode(_ data: Data) throws -> ChatPreferencesRealtimeDispatch? {
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
        guard loose.event.type == "chat.preferences.updated" else { return nil }

        let object: [String: Any]
        do {
            object = try Self.object(from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        // V1 has no cursor key and intentionally filters this event. An
        // explicit JSON null is not a v1 frame: it is a malformed v2 envelope
        // and must never be silently treated as safely applied.
        guard object.keys.contains("cursor") else { return nil }
        guard loose.cursor != nil, object["cursor"] is String else {
            throw LuxoraAPIError.invalidResponse
        }
        guard Set(object.keys) == ["type", "sequence", "cursor", "event"],
              let eventObject = object["event"] as? [String: Any],
              Set(eventObject.keys) == [
                  "type", "audience", "accountId", "chatId", "preferences", "changedAt",
              ],
              let preferencesObject = eventObject["preferences"] as? [String: Any],
              Set(preferencesObject.keys) == ["archivedAt", "mutedUntil"]
        else { throw LuxoraAPIError.invalidResponse }

        let dispatch: Dispatch
        do {
            dispatch = try decoder.decode(Dispatch.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        guard dispatch.type == "dispatch",
              dispatch.sequence > 0,
              dispatch.event.type == "chat.preferences.updated",
              dispatch.event.audience == "member_account",
              RealtimeCursorValidator.isValid(dispatch.cursor)
        else { throw LuxoraAPIError.invalidResponse }

        return ChatPreferencesRealtimeDispatch(
            accountID: dispatch.event.accountId,
            chatID: dispatch.event.chatId,
            preferences: ChatPreferences(response: dispatch.event.preferences),
            changedAt: dispatch.event.changedAt,
            sequence: dispatch.sequence,
            cursor: dispatch.cursor
        )
    }

    private static func object(from data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LuxoraAPIError.invalidResponse
        }
        return object
    }

}
