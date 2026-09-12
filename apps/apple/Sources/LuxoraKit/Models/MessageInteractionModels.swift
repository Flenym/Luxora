import Foundation

public struct MessageForwardProvenance: Codable, Equatable, Hashable, Sendable {
    public let senderDisplayName: String
    public let originalCreatedAt: Date

    public init(senderDisplayName: String, originalCreatedAt: Date) {
        self.senderDisplayName = senderDisplayName
        self.originalCreatedAt = originalCreatedAt
    }
}

public struct MessageRemoteMetadata: Codable, Equatable, Hashable, Sendable {
    public var revision: Int?
    public var replyToMessageID: UUID?
    public var forwardedFrom: MessageForwardProvenance?
    public var isPinned: Bool
    public var isDeleted: Bool
    public var attachmentIDs: [UUID]
    public var transcriptionConsent: Bool

    public init(
        revision: Int? = nil,
        replyToMessageID: UUID? = nil,
        forwardedFrom: MessageForwardProvenance? = nil,
        isPinned: Bool = false,
        isDeleted: Bool = false,
        attachmentIDs: [UUID] = [],
        transcriptionConsent: Bool = false
    ) {
        self.revision = revision
        self.replyToMessageID = replyToMessageID
        self.forwardedFrom = forwardedFrom
        self.isPinned = isPinned
        self.isDeleted = isDeleted
        self.attachmentIDs = attachmentIDs
        self.transcriptionConsent = transcriptionConsent
    }

    private enum CodingKeys: String, CodingKey {
        case revision, replyToMessageID, forwardedFrom
        case isPinned, isDeleted, attachmentIDs, transcriptionConsent
    }

    // Durable caches written before media support may miss the newer keys.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        revision = try container.decodeIfPresent(Int.self, forKey: .revision)
        replyToMessageID = try container.decodeIfPresent(UUID.self, forKey: .replyToMessageID)
        forwardedFrom = try container.decodeIfPresent(MessageForwardProvenance.self, forKey: .forwardedFrom)
        isPinned = try container.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        isDeleted = try container.decodeIfPresent(Bool.self, forKey: .isDeleted) ?? false
        attachmentIDs = try container.decodeIfPresent([UUID].self, forKey: .attachmentIDs) ?? []
        transcriptionConsent = try container.decodeIfPresent(Bool.self, forKey: .transcriptionConsent) ?? false
    }
}

struct RemoteMessageSnapshot: Codable, Equatable, Sendable {
    var message: ChatMessage
    var metadata: MessageRemoteMetadata

    init(message: ChatMessage, metadata: MessageRemoteMetadata = MessageRemoteMetadata()) {
        self.message = message
        self.metadata = metadata
    }
}

public struct MessageComposerTarget: Identifiable, Equatable, Hashable, Sendable {
    public let id: UUID
    public let authorName: String
    public let preview: String
    public let revision: Int?

    public init(id: UUID, authorName: String, preview: String, revision: Int?) {
        self.id = id
        self.authorName = authorName
        self.preview = preview
        self.revision = revision
    }
}

public enum MessageComposerMode: Equatable, Hashable, Sendable {
    case new
    case reply(MessageComposerTarget)
    case edit(MessageComposerTarget)

    public var target: MessageComposerTarget? {
        switch self {
        case .new: nil
        case let .reply(target), let .edit(target): target
        }
    }
}

public enum MessageMutationKind: String, CaseIterable, Equatable, Hashable, Sendable {
    case edit
    case delete
    case forward
    case pin

    public var russianTitle: String {
        switch self {
        case .edit: "Изменение сообщения"
        case .delete: "Удаление сообщения"
        case .forward: "Пересылка сообщения"
        case .pin: "Закрепление сообщения"
        }
    }
}

public struct MessageMutationKey: Equatable, Hashable, Sendable {
    public let messageID: UUID
    public let kind: MessageMutationKind

    public init(messageID: UUID, kind: MessageMutationKind) {
        self.messageID = messageID
        self.kind = kind
    }
}

public struct MessageMutationFailure: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let key: MessageMutationKey
    public let detail: String

    public init(id: UUID = UUID(), key: MessageMutationKey, detail: String) {
        self.id = id
        self.key = key
        self.detail = detail
    }
}
