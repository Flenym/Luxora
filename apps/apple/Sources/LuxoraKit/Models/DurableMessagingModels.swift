import Foundation

/// A cache namespace is deliberately bound to both the account and the server
/// device session. A replacement login can therefore never inherit another
/// account's projection, outbox, or scoped realtime cursor.
struct DurableMessagingScope: Codable, Equatable, Hashable, Sendable {
    let accountID: UUID
    let sessionID: UUID
}

struct DurableRealtimeCheckpoint: Codable, Equatable, Sendable {
    let sequence: Int
    let cursor: String
    let capturedAt: Date
    let expiresAt: Date
}

struct DurableConfirmedMessageSnapshot: Codable, Equatable, Sendable {
    var message: ChatMessage
    var metadata: MessageRemoteMetadata

    init(message: ChatMessage, metadata: MessageRemoteMetadata = MessageRemoteMetadata()) {
        self.message = message
        self.metadata = metadata
    }

    init(_ snapshot: RemoteMessageSnapshot) {
        self.init(message: snapshot.message, metadata: snapshot.metadata)
    }

    var remoteSnapshot: RemoteMessageSnapshot {
        RemoteMessageSnapshot(message: message, metadata: metadata)
    }
}

struct DurableConversationMessages: Codable, Equatable, Sendable {
    let conversationID: UUID
    var snapshots: [DurableConfirmedMessageSnapshot]
}

struct DurablePendingTextMessage: Codable, Equatable, Sendable {
    let clientNonce: UUID
    let conversationID: UUID
    let body: String
    let replyToMessageID: UUID?
    let enqueuedAt: Date
    let ordinal: UInt64
    var attemptCount: Int
    var lastAttemptAt: Date?
}

struct DurableMessagingState: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 2

    var schemaVersion: Int
    let scope: DurableMessagingScope
    var generation: UInt64
    var conversations: [Conversation]
    var messages: [DurableConversationMessages]
    var pendingTextOutbox: [DurablePendingTextMessage]
    var realtimeV2Checkpoint: DurableRealtimeCheckpoint?
    var nextOutboxOrdinal: UInt64
    var updatedAt: Date

    static func empty(scope: DurableMessagingScope, now: Date) -> Self {
        Self(
            schemaVersion: currentSchemaVersion,
            scope: scope,
            generation: 0,
            conversations: [],
            messages: [],
            pendingTextOutbox: [],
            realtimeV2Checkpoint: nil,
            nextOutboxOrdinal: 1,
            updatedAt: now
        )
    }
}

enum DurableMessagingRecovery: Equatable, Sendable {
    case none
    case migrated(fromSchemaVersion: Int)
    case discardedCorruptFile(URL)
}

struct DurableMessagingLoadOutcome: Equatable, Sendable {
    let state: DurableMessagingState
    let recovery: DurableMessagingRecovery
}

struct DurableOutboxReplayResult: Equatable, Sendable {
    var confirmed: [DurableConfirmedMessageSnapshot]
    var remainingCount: Int
    var stoppedAtNonce: UUID?
    var errorDescription: String?
    var alreadyRunning: Bool

    static func running(remainingCount: Int) -> Self {
        Self(
            confirmed: [],
            remainingCount: remainingCount,
            stoppedAtNonce: nil,
            errorDescription: nil,
            alreadyRunning: true
        )
    }
}

enum DurableMessagingError: LocalizedError, Equatable, Sendable {
    case unsupportedSchema(Int)
    case invalidState
    case nonceCollision
    case invalidPendingMessage
    case invalidCheckpoint
    case scopeInvalidated
    case inconsistentConfirmation

    var errorDescription: String? {
        switch self {
        case let .unsupportedSchema(version):
            "Неподдерживаемая версия локального хранилища: \(version)."
        case .invalidState:
            "Локальное хранилище сообщений повреждено."
        case .nonceCollision:
            "Локальный идентификатор уже относится к другому сообщению."
        case .invalidPendingMessage:
            "Исходящее сообщение не прошло локальную проверку."
        case .invalidCheckpoint:
            "Контрольная точка синхронизации некорректна."
        case .scopeInvalidated:
            "Сеанс локального хранилища уже завершён."
        case .inconsistentConfirmation:
            "Ответ сервера не соответствует исходящему сообщению."
        }
    }
}
