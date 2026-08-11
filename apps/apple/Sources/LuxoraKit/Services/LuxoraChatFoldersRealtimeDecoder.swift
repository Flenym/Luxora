import Foundation

struct ChatFoldersRealtimeDispatch: Equatable, Sendable {
    let accountID: UUID
    let stateRevision: Int
    let changedAt: Date
    let sequence: Int
    let cursor: String
}

enum ChatFoldersRealtimeFrameDecoder {
    private struct Header: Decodable { let type: String }
    private struct EventHeader: Decodable { let type: String }
    private struct LooseDispatch: Decodable {
        let cursor: String?
        let event: EventHeader
    }
    private struct Dispatch: Decodable {
        struct Event: Decodable {
            let type: String
            let audience: String
            let accountId: UUID
            let stateRevision: Int
            let changedAt: Date
        }

        let type: String
        let sequence: Int
        let cursor: String
        let event: Event
    }

    static func decode(_ data: Data) throws -> ChatFoldersRealtimeDispatch? {
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
        guard loose.event.type == "chat.folders.updated" else { return nil }

        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw LuxoraAPIError.invalidResponse }
        // The strict V1 stream intentionally has no cursor and filters this
        // account-private event. Explicit null is malformed V2, not V1.
        guard object.keys.contains("cursor") else { return nil }
        guard loose.cursor != nil, object["cursor"] is String,
              Set(object.keys) == ["type", "sequence", "cursor", "event"],
              let event = object["event"] as? [String: Any],
              Set(event.keys) == [
                  "type", "audience", "accountId", "stateRevision", "changedAt",
              ]
        else { throw LuxoraAPIError.invalidResponse }

        let dispatch: Dispatch
        do {
            dispatch = try decoder.decode(Dispatch.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        guard dispatch.type == "dispatch",
              dispatch.sequence > 0,
              dispatch.event.type == "chat.folders.updated",
              dispatch.event.audience == "actor_account",
              dispatch.event.stateRevision >= 0,
              RealtimeCursorValidator.isValid(dispatch.cursor)
        else { throw LuxoraAPIError.invalidResponse }
        return ChatFoldersRealtimeDispatch(
            accountID: dispatch.event.accountId,
            stateRevision: dispatch.event.stateRevision,
            changedAt: dispatch.event.changedAt,
            sequence: dispatch.sequence,
            cursor: dispatch.cursor
        )
    }
}
