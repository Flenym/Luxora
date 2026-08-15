import Foundation

public enum GlobalSearchScope: String, CaseIterable, Identifiable, Sendable {
    case chats = "Чаты"
    case channels = "Каналы"
    case people = "Люди"
    case messages = "Сообщения"
    case media = "Медиа"

    public var id: String { rawValue }

    var isRemote: Bool {
        switch self {
        case .people, .messages, .media:
            true
        case .chats, .channels:
            false
        }
    }
}

public struct GlobalMessageSearchResult: Identifiable, Equatable, Hashable, Sendable {
    public let id: UUID
    public let conversationID: UUID
    public let sender: Participant
    public let text: String
    public let createdAt: Date

    public init(
        id: UUID,
        conversationID: UUID,
        sender: Participant,
        text: String,
        createdAt: Date
    ) {
        self.id = id
        self.conversationID = conversationID
        self.sender = sender
        self.text = text
        self.createdAt = createdAt
    }
}

public struct GlobalFileSearchResult: Identifiable, Equatable, Hashable, Sendable {
    public let id: UUID
    public let kind: String
    public let fileName: String
    public let mimeType: String
    public let sizeBytes: Int
    public let downloadPath: String
    public let safetyStatus: String
    public let createdAt: Date

    public init(
        id: UUID,
        kind: String,
        fileName: String,
        mimeType: String,
        sizeBytes: Int,
        downloadPath: String,
        safetyStatus: String,
        createdAt: Date
    ) {
        self.id = id
        self.kind = kind
        self.fileName = fileName
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.downloadPath = downloadPath
        self.safetyStatus = safetyStatus
        self.createdAt = createdAt
    }

    public var formattedSize: String {
        ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file)
    }
}

struct GlobalSearchPage<Item: Sendable>: Sendable {
    let items: [Item]
    let nextCursor: String?
}
