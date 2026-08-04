import Foundation

public enum MessageDelivery: String, Codable, Sendable {
    case sending
    case sent
    case delivered
    case read
    case failed

    public var symbol: String {
        switch self {
        case .sending: "clock"
        case .sent: "checkmark"
        case .delivered: "checkmark.circle"
        case .read: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        }
    }
}

public struct MessageReaction: Identifiable, Hashable, Codable, Sendable {
    public var id: String { emoji }
    public let emoji: String
    public var count: Int
    public var isMine: Bool

    public init(emoji: String, count: Int, isMine: Bool) {
        self.emoji = emoji
        self.count = count
        self.isMine = isMine
    }
}

public struct ChatMessage: Identifiable, Hashable, Codable, Sendable {
    public let id: UUID
    public let clientID: UUID
    public let conversationID: UUID
    public let author: Participant
    public var text: String
    public var sentAt: Date
    public var editedAt: Date?
    public var delivery: MessageDelivery
    public var isOutgoing: Bool
    public var replyPreview: String?
    public var reactions: [MessageReaction]

    public init(
        id: UUID,
        clientID: UUID = UUID(),
        conversationID: UUID,
        author: Participant,
        text: String,
        sentAt: Date,
        editedAt: Date? = nil,
        delivery: MessageDelivery,
        isOutgoing: Bool,
        replyPreview: String? = nil,
        reactions: [MessageReaction] = []
    ) {
        self.id = id
        self.clientID = clientID
        self.conversationID = conversationID
        self.author = author
        self.text = text
        self.sentAt = sentAt
        self.editedAt = editedAt
        self.delivery = delivery
        self.isOutgoing = isOutgoing
        self.replyPreview = replyPreview
        self.reactions = reactions
    }
}
