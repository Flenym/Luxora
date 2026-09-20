import Foundation

enum RealtimeSignal: Sendable {
    case ready(sequence: Int)
    case chat(APIChat, sequence: Int)
    case message(APIMessage, sequence: Int)
    case messagePin(chatID: UUID, messageID: UUID, active: Bool, sequence: Int)
    case messageReceipt(
        chatID: UUID,
        messageID: UUID,
        isRead: Bool,
        sequence: Int
    )
    case messageReactions(
        chatID: UUID,
        messageID: UUID,
        reactions: [APIReactionSummary],
        sequence: Int
    )
    case chatMembership(RealtimeChatMembershipEvent, sequence: Int)
    case messageRequestCreated(APIMessageRequest, sequence: Int)
    case messageRequestRemoved(requestID: UUID, sequence: Int)
    case messageRequestAccepted(requestID: UUID, chat: APIChat, sequence: Int)
    case messageRequestExpired(requestID: UUID, sequence: Int)
    case cursor(sequence: Int)
    case typing(conversationID: UUID, isTyping: Bool)
    case syncRequired
}

struct RealtimeChatMembershipEvent: Sendable {
    enum Audience: String, Decodable, Sendable {
        case memberAccount = "member_account"
        case removedAccount = "removed_account"
    }

    enum Change: String, Decodable, Sendable {
        case added
        case roleUpdated = "role_updated"
        case removed
    }

    let audience: Audience
    let change: Change
    let membership: APIChatMembership
    let actorUserID: UUID
    let changedAt: Date
}

final class LuxoraRealtimeClient: @unchecked Sendable {
    let configuration: LuxoraClientConfiguration
    let session: URLSession

    init(configuration: LuxoraClientConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func signals(token: String, resumeFrom: Int?) -> AsyncThrowingStream<RealtimeSignal, Error> {
        let socket = session.webSocketTask(with: configuration.realtimeURL)
        socket.resume()

        return AsyncThrowingStream { continuation in
            let worker = Task {
                do {
                    var authentication: [String: Any] = [
                        "type": "authenticate",
                        "accessToken": token,
                    ]
                    if let resumeFrom { authentication["resumeFrom"] = resumeFrom }
                    let authenticationData = try JSONSerialization.data(withJSONObject: authentication)
                    guard let authenticationText = String(data: authenticationData, encoding: .utf8) else {
                        throw LuxoraAPIError.invalidResponse
                    }
                    try await socket.send(.string(authenticationText))

                    while !Task.isCancelled {
                        let frame = try await socket.receive()
                        let data: Data
                        switch frame {
                        case let .data(value): data = value
                        case let .string(value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        if let signal = try RealtimeFrameDecoder.decode(data) {
                            continuation.yield(signal)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                worker.cancel()
                socket.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    func scopedSignals(
        token: String,
        resumeCursor: String?
    ) -> AsyncThrowingStream<RealtimeV2Signal, Error> {
        guard let url = try? configuration.realtimeURL(for: .scopedV2) else {
            return AsyncThrowingStream { $0.finish(throwing: LuxoraAPIError.invalidResponse) }
        }
        let socket = session.webSocketTask(with: url)
        socket.resume()

        return AsyncThrowingStream { continuation in
            let worker = Task {
                do {
                    let hello = try await socket.receive()
                    try RealtimeHelloDecoder.validate(
                        Self.data(from: hello),
                        expectedVersion: LuxoraRealtimeProtocolVersion.scopedV2.rawValue
                    )

                    var authentication: [String: Any] = [
                        "type": "authenticate",
                        "accessToken": token,
                    ]
                    if let resumeCursor { authentication["resumeCursor"] = resumeCursor }
                    let authenticationData = try JSONSerialization.data(withJSONObject: authentication)
                    guard let authenticationText = String(data: authenticationData, encoding: .utf8) else {
                        throw LuxoraAPIError.invalidResponse
                    }
                    try await socket.send(.string(authenticationText))

                    while !Task.isCancelled {
                        let frame = try await socket.receive()
                        if let signal = try RealtimeV2FrameDecoder.decode(Self.data(from: frame)) {
                            continuation.yield(signal)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                worker.cancel()
                socket.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    private static func data(from frame: URLSessionWebSocketTask.Message) throws -> Data {
        switch frame {
        case let .data(value): value
        case let .string(value): Data(value.utf8)
        @unknown default: throw LuxoraAPIError.invalidResponse
        }
    }
}

enum RealtimeFrameDecoder {
    private struct Header: Decodable { let type: String }
    private struct Ready: Decodable { let sequence: Int }
    private struct Typing: Decodable {
        let chatId: UUID
        let isTyping: Bool
    }
    private struct Dispatch: Decodable {
        let sequence: Int
        let event: Event
    }
    private enum Event: Decodable {
        case chat(APIChat)
        case message(APIMessage)
        case pin(APIMessagePin)
        case unpin(chatID: UUID, messageID: UUID)
        case receipt(chatID: UUID, messageID: UUID, isRead: Bool)
        case reactions(chatID: UUID, messageID: UUID, reactions: [APIReactionSummary])
        case membership(RealtimeChatMembershipEvent)
        case messageRequestCreated(APIMessageRequest)
        case messageRequestRemoved(UUID)
        case messageRequestAccepted(requestID: UUID, chat: APIChat)
        case messageRequestExpired(UUID)
        case ignored

        private enum CodingKeys: String, CodingKey {
            case type
            case message
            case pin
            case chatId
            case messageId
            case request
            case requestId
            case chat
            case reactions
            case audience
            case change
            case membership
            case actorUserId
            case changedAt
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let type = try container.decode(String.self, forKey: .type)
            switch type {
            case "chat.created":
                self = .chat(try container.decode(APIChat.self, forKey: .chat))
            case "message.created", "message.updated", "message.deleted":
                self = .message(try container.decode(APIMessage.self, forKey: .message))
            case "message.pinned":
                self = .pin(try container.decode(APIMessagePin.self, forKey: .pin))
            case "message.unpinned":
                self = .unpin(
                    chatID: try container.decode(UUID.self, forKey: .chatId),
                    messageID: try container.decode(UUID.self, forKey: .messageId)
                )
            case "receipt.delivered", "receipt.read":
                self = .receipt(
                    chatID: try container.decode(UUID.self, forKey: .chatId),
                    messageID: try container.decode(UUID.self, forKey: .messageId),
                    isRead: type == "receipt.read"
                )
            case "reaction.updated":
                self = .reactions(
                    chatID: try container.decode(UUID.self, forKey: .chatId),
                    messageID: try container.decode(UUID.self, forKey: .messageId),
                    reactions: try container.decode([APIReactionSummary].self, forKey: .reactions)
                )
            case "chat.member.changed":
                let event = RealtimeChatMembershipEvent(
                    audience: try container.decode(
                        RealtimeChatMembershipEvent.Audience.self,
                        forKey: .audience
                    ),
                    change: try container.decode(
                        RealtimeChatMembershipEvent.Change.self,
                        forKey: .change
                    ),
                    membership: try container.decode(APIChatMembership.self, forKey: .membership),
                    actorUserID: try container.decode(UUID.self, forKey: .actorUserId),
                    changedAt: try container.decode(Date.self, forKey: .changedAt)
                )
                guard event.membership.revision > 0,
                      event.membership.updatedAt >= event.membership.joinedAt,
                      event.audience != .removedAccount || event.change == .removed,
                      event.change != .removed || event.membership.updatedAt == event.changedAt
                else {
                    throw DecodingError.dataCorruptedError(
                        forKey: .membership,
                        in: container,
                        debugDescription: "Invalid chat membership event"
                    )
                }
                self = .membership(event)
            case "relationship.request.created":
                self = .messageRequestCreated(
                    try container.decode(APIMessageRequest.self, forKey: .request)
                )
            case "relationship.request.removed":
                self = .messageRequestRemoved(
                    try container.decode(UUID.self, forKey: .requestId)
                )
            case "relationship.request.accepted":
                self = .messageRequestAccepted(
                    requestID: try container.decode(UUID.self, forKey: .requestId),
                    chat: try container.decode(APIChat.self, forKey: .chat)
                )
            case "relationship.request.expired":
                self = .messageRequestExpired(
                    try container.decode(UUID.self, forKey: .requestId)
                )
            default:
                self = .ignored
            }
        }
    }

    static func decode(_ data: Data) throws -> RealtimeSignal? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        switch try decoder.decode(Header.self, from: data).type {
        case "ready":
            return .ready(sequence: try decoder.decode(Ready.self, from: data).sequence)
        case "dispatch":
            let dispatch = try decoder.decode(Dispatch.self, from: data)
            switch dispatch.event {
            case let .chat(chat):
                return .chat(chat, sequence: dispatch.sequence)
            case let .message(message):
                return .message(message, sequence: dispatch.sequence)
            case let .pin(pin):
                return .messagePin(
                    chatID: pin.chatId,
                    messageID: pin.messageId,
                    active: true,
                    sequence: dispatch.sequence
                )
            case let .unpin(chatID, messageID):
                return .messagePin(
                    chatID: chatID,
                    messageID: messageID,
                    active: false,
                    sequence: dispatch.sequence
                )
            case let .receipt(chatID, messageID, isRead):
                return .messageReceipt(
                    chatID: chatID,
                    messageID: messageID,
                    isRead: isRead,
                    sequence: dispatch.sequence
                )
            case let .reactions(chatID, messageID, reactions):
                guard Set(reactions.map(\.emoji)).count == reactions.count,
                      reactions.allSatisfy({ !$0.emoji.isEmpty && $0.count >= 0 })
                else { throw LuxoraAPIError.invalidResponse }
                return .messageReactions(
                    chatID: chatID,
                    messageID: messageID,
                    reactions: reactions,
                    sequence: dispatch.sequence
                )
            case let .membership(event):
                return .chatMembership(event, sequence: dispatch.sequence)
            case let .messageRequestCreated(request):
                return .messageRequestCreated(request, sequence: dispatch.sequence)
            case let .messageRequestRemoved(requestID):
                return .messageRequestRemoved(requestID: requestID, sequence: dispatch.sequence)
            case let .messageRequestAccepted(requestID, chat):
                return .messageRequestAccepted(
                    requestID: requestID,
                    chat: chat,
                    sequence: dispatch.sequence
                )
            case let .messageRequestExpired(requestID):
                return .messageRequestExpired(requestID: requestID, sequence: dispatch.sequence)
            case .ignored:
                break
            }
            // Every durable dispatch advances the resume cursor, including event
            // kinds this thin harness does not render yet.
            return .cursor(sequence: dispatch.sequence)
        case "typing.updated":
            let typing = try decoder.decode(Typing.self, from: data)
            return .typing(conversationID: typing.chatId, isTyping: typing.isTyping)
        case "sync.required":
            return .syncRequired
        default:
            return nil
        }
    }
}

enum RealtimeV2SyncRequiredReason: String, Decodable, Sendable {
    case cursorInvalid = "cursor_invalid"
    case cursorScopeMismatch = "cursor_scope_mismatch"
    case cursorExpired = "cursor_expired"
    case cursorAhead = "cursor_ahead"
    case replayWindowExceeded = "replay_window_exceeded"
    case backpressure
}

enum RealtimeSyncInvalidationReason: String, Decodable, Equatable, Sendable {
    case profileUpdated = "profile_updated"
    case avatarUpdated = "avatar_updated"
    case attachmentRemoved = "attachment_removed"
    case sessionListChanged = "session_list_changed"
}

struct RealtimeSyncInvalidationDispatch: Sendable {
    let accountID: UUID
    let reason: RealtimeSyncInvalidationReason
    let changedAt: Date
    let sequence: Int
    let cursor: String
}

enum RealtimeV2Signal: Sendable {
    case ready(
        userID: UUID,
        sessionID: UUID,
        sequence: Int,
        headSequence: Int,
        cursor: String?,
        resumed: Bool
    )
    case dispatch(RealtimeSignal, sequence: Int, cursor: String)
    case chatPreferences(ChatPreferencesRealtimeDispatch)
    case chatFolders(ChatFoldersRealtimeDispatch)
    case chatDraft(ChatDraftRealtimeDispatch)
    case syncInvalidated(RealtimeSyncInvalidationDispatch)
    case checkpoint(sequence: Int, cursor: String)
    case typing(conversationID: UUID, isTyping: Bool)
    case syncRequired(
        reason: RealtimeV2SyncRequiredReason,
        headSequence: Int,
        recoveryPath: String
    )
    case serverError(code: String, message: String)
}

enum RealtimeCursorValidator {
    static func isValid(_ cursor: String) -> Bool {
        guard (80...512).contains(cursor.count) else { return false }
        let components = cursor.split(separator: ".", omittingEmptySubsequences: false)
        guard components.count == 3,
              components[0] == "luxora-rt1",
              !components[1].isEmpty,
              !components[2].isEmpty
        else { return false }
        return components.dropFirst().allSatisfy { component in
            component.unicodeScalars.allSatisfy { scalar in
                (48...57).contains(scalar.value)
                    || (65...90).contains(scalar.value)
                    || (97...122).contains(scalar.value)
                    || scalar.value == 45
                    || scalar.value == 95
            }
        }
    }
}

enum RealtimeHelloDecoder {
    private struct Hello: Decodable {
        let type: String
        let protocolVersion: Int
        let connectionId: UUID
        let heartbeatIntervalMs: Int
    }

    static func validate(_ data: Data, expectedVersion: Int) throws {
        let object = try RealtimeV2FrameDecoder.object(from: data)
        guard Set(object.keys) == [
            "type", "protocolVersion", "connectionId", "heartbeatIntervalMs",
        ] else { throw LuxoraAPIError.invalidResponse }
        let hello: Hello
        do {
            hello = try JSONDecoder().decode(Hello.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        guard hello.type == "hello",
              hello.protocolVersion == expectedVersion,
              hello.heartbeatIntervalMs > 0
        else { throw LuxoraAPIError.invalidResponse }
        _ = hello.connectionId
    }
}

enum RealtimeV2FrameDecoder {
    private struct Header: Decodable { let type: String }
    private struct Ready: Decodable {
        struct Retention: Decodable {
            let maxReplayEvents: Int
            let cursorTtlSeconds: Int
        }
        let type: String
        let userId: UUID
        let sessionId: UUID
        let sequence: Int
        let headSequence: Int
        let cursor: String?
        let resumed: Bool
        let resumeMode: String
        let retention: Retention
    }
    private struct DispatchHeader: Decodable {
        struct Event: Decodable { let type: String }
        let type: String
        let sequence: Int
        let cursor: String
        let event: Event
    }
    private struct SyncInvalidationFrame: Decodable {
        struct Event: Decodable {
            let type: String
            let audience: String
            let accountId: UUID
            let reason: RealtimeSyncInvalidationReason
            let changedAt: Date
        }
        let type: String
        let sequence: Int
        let cursor: String
        let event: Event
    }
    private struct Checkpoint: Decodable {
        let type: String
        let sequence: Int
        let cursor: String
    }
    private struct Typing: Decodable {
        let type: String
        let chatId: UUID
        let userId: UUID
        let isTyping: Bool
        let expiresAt: Date
    }
    private struct SyncRequired: Decodable {
        struct Recovery: Decodable {
            let type: String
            let path: String
        }
        let type: String
        let reason: RealtimeV2SyncRequiredReason
        let headSequence: Int
        let recovery: Recovery
    }
    private struct ServerError: Decodable {
        let type: String
        let code: String
        let message: String
    }

    static func decode(_ data: Data) throws -> RealtimeV2Signal? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let header: Header
        do {
            header = try decoder.decode(Header.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }

        switch header.type {
        case "ready":
            let object = try object(from: data)
            guard Set(object.keys) == [
                "type", "userId", "sessionId", "sequence", "headSequence",
                "cursor", "resumed", "resumeMode", "retention",
            ],
            let retentionObject = object["retention"] as? [String: Any],
            Set(retentionObject.keys) == ["maxReplayEvents", "cursorTtlSeconds"]
            else { throw LuxoraAPIError.invalidResponse }
            let ready = try decode(Ready.self, data: data, decoder: decoder)
            guard ready.type == "ready",
                  ready.sequence >= 0,
                  ready.headSequence >= ready.sequence,
                  ["none", "scoped_cursor"].contains(ready.resumeMode),
                  ready.retention.maxReplayEvents == 500,
                  ready.retention.cursorTtlSeconds == 604_800,
                  ready.cursor.map(RealtimeCursorValidator.isValid) ?? true,
                  (ready.resumed == (ready.resumeMode == "scoped_cursor")),
                  !(ready.resumed && ready.cursor == nil)
            else { throw LuxoraAPIError.invalidResponse }
            return .ready(
                userID: ready.userId,
                sessionID: ready.sessionId,
                sequence: ready.sequence,
                headSequence: ready.headSequence,
                cursor: ready.cursor,
                resumed: ready.resumed
            )

        case "dispatch":
            let object = try object(from: data)
            guard Set(object.keys) == ["type", "sequence", "cursor", "event"],
                  object["cursor"] is String,
                  let eventObject = object["event"] as? [String: Any],
                  let eventType = eventObject["type"] as? String
            else { throw LuxoraAPIError.invalidResponse }
            let dispatch = try decode(DispatchHeader.self, data: data, decoder: decoder)
            guard dispatch.type == "dispatch",
                  dispatch.sequence > 0,
                  RealtimeCursorValidator.isValid(dispatch.cursor)
            else { throw LuxoraAPIError.invalidResponse }
            if eventType == "chat.preferences.updated" {
                guard let preferences = try ChatPreferencesRealtimeFrameDecoder.decode(data) else {
                    throw LuxoraAPIError.invalidResponse
                }
                return .chatPreferences(preferences)
            }
            if eventType == "chat.folders.updated" {
                guard let folders = try ChatFoldersRealtimeFrameDecoder.decode(data) else {
                    throw LuxoraAPIError.invalidResponse
                }
                return .chatFolders(folders)
            }
            if eventType == "chat.draft.changed" {
                guard let draft = try ChatDraftRealtimeFrameDecoder.decode(data) else {
                    throw LuxoraAPIError.invalidResponse
                }
                return .chatDraft(draft)
            }
            if eventType == "sync.invalidated" {
                guard Set(eventObject.keys) == [
                    "type", "audience", "accountId", "reason", "changedAt",
                ] else { throw LuxoraAPIError.invalidResponse }
                let frame = try decode(SyncInvalidationFrame.self, data: data, decoder: decoder)
                guard frame.type == "dispatch",
                      frame.sequence == dispatch.sequence,
                      frame.cursor == dispatch.cursor,
                      frame.event.type == "sync.invalidated",
                      frame.event.audience == "account_projection"
                else { throw LuxoraAPIError.invalidResponse }
                return .syncInvalidated(RealtimeSyncInvalidationDispatch(
                    accountID: frame.event.accountId,
                    reason: frame.event.reason,
                    changedAt: frame.event.changedAt,
                    sequence: frame.sequence,
                    cursor: frame.cursor
                ))
            }
            guard let signal = try RealtimeFrameDecoder.decode(data) else {
                throw LuxoraAPIError.invalidResponse
            }
            return .dispatch(signal, sequence: dispatch.sequence, cursor: dispatch.cursor)

        case "sync.checkpoint":
            let object = try object(from: data)
            guard Set(object.keys) == ["type", "sequence", "cursor"] else {
                throw LuxoraAPIError.invalidResponse
            }
            let checkpoint = try decode(Checkpoint.self, data: data, decoder: decoder)
            guard checkpoint.type == "sync.checkpoint",
                  checkpoint.sequence >= 0,
                  RealtimeCursorValidator.isValid(checkpoint.cursor)
            else { throw LuxoraAPIError.invalidResponse }
            return .checkpoint(sequence: checkpoint.sequence, cursor: checkpoint.cursor)

        case "typing.updated":
            let object = try object(from: data)
            guard Set(object.keys) == [
                "type", "chatId", "userId", "isTyping", "expiresAt",
            ] else { throw LuxoraAPIError.invalidResponse }
            let typing = try decode(Typing.self, data: data, decoder: decoder)
            guard typing.type == "typing.updated" else { throw LuxoraAPIError.invalidResponse }
            _ = typing.userId
            _ = typing.expiresAt
            return .typing(conversationID: typing.chatId, isTyping: typing.isTyping)

        case "sync.required":
            let object = try object(from: data)
            guard Set(object.keys) == ["type", "reason", "headSequence", "recovery"],
                  let recoveryObject = object["recovery"] as? [String: Any],
                  Set(recoveryObject.keys) == ["type", "path"]
            else { throw LuxoraAPIError.invalidResponse }
            let required = try decode(SyncRequired.self, data: data, decoder: decoder)
            guard required.type == "sync.required",
                  required.headSequence >= 0,
                  required.recovery.type == "http_snapshot",
                  required.recovery.path == "/v2/sync/snapshot"
            else { throw LuxoraAPIError.invalidResponse }
            return .syncRequired(
                reason: required.reason,
                headSequence: required.headSequence,
                recoveryPath: required.recovery.path
            )

        case "error":
            let object = try object(from: data)
            guard Set(object.keys) == ["type", "code", "message"] else {
                throw LuxoraAPIError.invalidResponse
            }
            let error = try decode(ServerError.self, data: data, decoder: decoder)
            guard error.type == "error",
                  !error.code.isEmpty,
                  !error.message.isEmpty
            else { throw LuxoraAPIError.invalidResponse }
            return .serverError(code: error.code, message: error.message)

        case "heartbeat", "heartbeat.ack", "presence.updated":
            return nil
        default:
            return nil
        }
    }

    static func object(from data: Data) throws -> [String: Any] {
        do {
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw LuxoraAPIError.invalidResponse
            }
            return object
        } catch let error as LuxoraAPIError {
            throw error
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
    }

    private static func decode<Value: Decodable>(
        _ type: Value.Type,
        data: Data,
        decoder: JSONDecoder
    ) throws -> Value {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
    }
}
