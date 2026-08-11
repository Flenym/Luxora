import Foundation

public enum MessageRequestDirection: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case incoming
    case outgoing

    public var id: String { rawValue }

    public var russianTitle: String {
        switch self {
        case .incoming: "Входящие"
        case .outgoing: "Исходящие"
        }
    }
}

public enum MessageRequestState: String, Codable, Sendable {
    case pending
    case accepted
    case recipientDismissed = "recipient_dismissed"
    case expired

    public var russianTitle: String {
        switch self {
        case .pending: "Ожидает"
        case .accepted: "Принят"
        case .recipientDismissed: "Удалён"
        case .expired: "Истёк"
        }
    }
}

public struct MessageRequestItem: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let direction: MessageRequestDirection
    public var state: MessageRequestState
    public let body: String
    public let participant: Participant
    public let createdAt: Date
    public let expiresAt: Date

    public init(
        id: UUID,
        direction: MessageRequestDirection,
        state: MessageRequestState,
        body: String,
        participant: Participant,
        createdAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.direction = direction
        self.state = state
        self.body = body
        self.participant = participant
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public enum MessageRequestPolicy: String, CaseIterable, Codable, Identifiable, Sendable {
    case everyone
    case nobody

    public var id: String { rawValue }

    public var russianTitle: String {
        switch self {
        case .everyone: "Все пользователи"
        case .nobody: "Никто"
        }
    }
}

public struct PrivacySettingsSnapshot: Equatable, Sendable {
    public let usernameDiscoverable: Bool
    public let messageRequests: MessageRequestPolicy

    public init(usernameDiscoverable: Bool, messageRequests: MessageRequestPolicy) {
        self.usernameDiscoverable = usernameDiscoverable
        self.messageRequests = messageRequests
    }
}

struct MessageRequestAcceptResult: Sendable {
    let request: MessageRequestItem
    let conversation: Conversation
    /// The server atomically materializes the request body as the first direct
    /// message. Keeping that projection in the acceptance receipt prevents the
    /// newly opened chat from briefly (or permanently, after a load failure)
    /// claiming that it is empty.
    let firstMessage: RemoteMessageSnapshot
}
