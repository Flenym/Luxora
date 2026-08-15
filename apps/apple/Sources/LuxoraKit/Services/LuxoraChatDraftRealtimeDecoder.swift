import Foundation

struct ChatDraftRealtimeDispatch: Equatable, Sendable {
    let accountID: UUID
    let chatID: UUID
    let state: SynchronizedChatDraftState
    let changedAt: Date
    let sequence: Int
    let cursor: String
}

enum ChatDraftRealtimeFrameDecoder {
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
        let draft: APIChatDraft?
        let revision: Int
        let changedAt: Date
    }

    static func decode(_ data: Data) throws -> ChatDraftRealtimeDispatch? {
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
        guard loose.event.type == "chat.draft.changed" else { return nil }

        let object: [String: Any]
        do {
            object = try jsonObject(from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }

        // V1 intentionally filters this private event. A cursorless target
        // frame is ignored, while an explicit null cursor is malformed V2.
        guard object.keys.contains("cursor") else { return nil }
        guard loose.cursor != nil, object["cursor"] is String,
              Set(object.keys) == ["type", "sequence", "cursor", "event"],
              let eventObject = object["event"] as? [String: Any],
              Set(eventObject.keys) == [
                  "type", "audience", "accountId", "chatId", "draft", "revision", "changedAt",
              ]
        else { throw LuxoraAPIError.invalidResponse }

        if let draftObject = eventObject["draft"] as? [String: Any] {
            guard Set(draftObject.keys) == [
                "chatId", "text", "replyToMessageId", "revision", "updatedAt",
            ] else { throw LuxoraAPIError.invalidResponse }
        } else if !(eventObject["draft"] is NSNull) {
            throw LuxoraAPIError.invalidResponse
        }

        let dispatch: Dispatch
        do {
            dispatch = try decoder.decode(Dispatch.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        guard dispatch.type == "dispatch",
              dispatch.sequence > 0,
              dispatch.sequence <= SynchronizedChatDraftContract.maximumSafeInteger,
              dispatch.event.type == "chat.draft.changed",
              dispatch.event.audience == "account_sessions",
              SynchronizedChatDraftContract.isRFCUUID(dispatch.event.accountId),
              SynchronizedChatDraftContract.isRFCUUID(dispatch.event.chatId),
              dispatch.event.revision > 0,
              RealtimeCursorValidator.isValid(dispatch.cursor)
        else { throw LuxoraAPIError.invalidResponse }

        let state = try SynchronizedChatDraftContract.validatedState(
            draft: dispatch.event.draft,
            revision: dispatch.event.revision,
            expectedChatID: dispatch.event.chatId
        )
        if let draft = state.draft, draft.updatedAt != dispatch.event.changedAt {
            throw LuxoraAPIError.invalidResponse
        }
        return ChatDraftRealtimeDispatch(
            accountID: dispatch.event.accountId,
            chatID: dispatch.event.chatId,
            state: state,
            changedAt: dispatch.event.changedAt,
            sequence: dispatch.sequence,
            cursor: dispatch.cursor
        )
    }

    private static func jsonObject(from data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LuxoraAPIError.invalidResponse
        }
        return object
    }
}
