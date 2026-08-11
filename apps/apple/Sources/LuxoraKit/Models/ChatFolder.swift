import Foundation

public enum ChatFolderContract {
    public static let maximumFolders = 10
    public static let maximumTitleCodePoints = 48
    public static let maximumOverrides = 100
    public static let idempotencyTTLSeconds = 86_400
    public static let maximumActiveCommandReceipts = 64
}

public enum ChatFolderChatKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case direct
    case group
    case channel

    public var id: String { rawValue }

    public var russianTitle: String {
        switch self {
        case .direct: "Личные чаты"
        case .group: "Группы"
        case .channel: "Каналы"
        }
    }

    func includes(_ conversationKind: ConversationKind) -> Bool {
        switch (self, conversationKind) {
        case (.direct, .direct), (.direct, .saved), (.group, .group), (.channel, .channel): true
        default: false
        }
    }
}

public struct ChatFolderRules: Codable, Equatable, Hashable, Sendable {
    public var includeKinds: [ChatFolderChatKind]
    public var unreadOnly: Bool
    public var excludeMuted: Bool
    public var includeArchived: Bool

    public init(
        includeKinds: [ChatFolderChatKind],
        unreadOnly: Bool,
        excludeMuted: Bool,
        includeArchived: Bool
    ) {
        self.includeKinds = includeKinds
        self.unreadOnly = unreadOnly
        self.excludeMuted = excludeMuted
        self.includeArchived = includeArchived
    }

    public static let allUnarchived = ChatFolderRules(
        includeKinds: ChatFolderChatKind.allCases,
        unreadOnly: false,
        excludeMuted: false,
        includeArchived: false
    )

    func validated() throws -> ChatFolderRules {
        guard includeKinds.count <= ChatFolderChatKind.allCases.count,
              Set(includeKinds).count == includeKinds.count
        else { throw LuxoraAPIError.invalidResponse }
        return self
    }
}

public enum ChatFolderOverrideMode: String, Codable, Sendable {
    case include
    case exclude
}

public struct ChatFolderOverride: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let chatID: UUID
    public var mode: ChatFolderOverrideMode
    public var pinnedPosition: Int?

    public var id: UUID { chatID }

    public init(chatID: UUID, mode: ChatFolderOverrideMode, pinnedPosition: Int?) {
        self.chatID = chatID
        self.mode = mode
        self.pinnedPosition = pinnedPosition
    }

    private enum CodingKeys: String, CodingKey {
        case chatID = "chatId"
        case mode
        case pinnedPosition
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.pinnedPosition) else {
            throw DecodingError.keyNotFound(
                CodingKeys.pinnedPosition,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "pinnedPosition must be present as null or an integer"
                )
            )
        }
        let rawChatID = try container.decode(String.self, forKey: .chatID)
        guard let decodedChatID = UUID(uuidString: rawChatID) else {
            throw DecodingError.dataCorruptedError(
                forKey: .chatID,
                in: container,
                debugDescription: "chatId must be a UUID"
            )
        }
        chatID = decodedChatID
        mode = try container.decode(ChatFolderOverrideMode.self, forKey: .mode)
        pinnedPosition = try container.decodeIfPresent(Int.self, forKey: .pinnedPosition)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(chatID.apiPathComponent, forKey: .chatID)
        try container.encode(mode, forKey: .mode)
        if let pinnedPosition {
            try container.encode(pinnedPosition, forKey: .pinnedPosition)
        } else {
            try container.encodeNil(forKey: .pinnedPosition)
        }
    }

    func validated() throws -> ChatFolderOverride {
        guard pinnedPosition.map({ (0...99).contains($0) }) ?? true,
              mode == .include || pinnedPosition == nil
        else { throw LuxoraAPIError.invalidResponse }
        return self
    }
}

public struct ChatFolder: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: UUID
    public let title: String
    public let position: Int
    public let revision: Int
    public let rules: ChatFolderRules
    public let overrides: [ChatFolderOverride]
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: UUID,
        title: String,
        position: Int,
        revision: Int,
        rules: ChatFolderRules,
        overrides: [ChatFolderOverride],
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.title = title
        self.position = position
        self.revision = revision
        self.rules = rules
        self.overrides = overrides
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var includedChatIDs: Set<UUID> {
        Set(overrides.lazy.filter { $0.mode == .include }.map(\.chatID))
    }

    public var excludedChatIDs: Set<UUID> {
        Set(overrides.lazy.filter { $0.mode == .exclude }.map(\.chatID))
    }

    public func includes(_ conversation: Conversation) -> Bool {
        if let override = overrides.first(where: { $0.chatID == conversation.id }) {
            return override.mode == .include
        }
        guard rules.includeKinds.contains(where: { $0.includes(conversation.kind) }),
              !rules.unreadOnly || conversation.unreadCount > 0,
              !rules.excludeMuted || !conversation.isMuted,
              rules.includeArchived || !conversation.isArchived
        else { return false }
        return true
    }

    public func projectedConversations(_ conversations: [Conversation]) -> [Conversation] {
        let pinByChat = Dictionary(
            uniqueKeysWithValues: overrides.compactMap { override in
                override.pinnedPosition.map { (override.chatID, $0) }
            }
        )
        return conversations.filter(includes).sorted { lhs, rhs in
            let leftPin = pinByChat[lhs.id]
            let rightPin = pinByChat[rhs.id]
            switch (leftPin, rightPin) {
            case let (.some(left), .some(right)) where left != right: return left < right
            case (.some, .none): return true
            case (.none, .some): return false
            default:
                if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
                return lhs.lastActivity > rhs.lastActivity
            }
        }
    }

    func validated() throws -> ChatFolder {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedTitle == title,
              !title.isEmpty,
              title.unicodeScalars.count <= ChatFolderContract.maximumTitleCodePoints,
              (0...9_999).contains(position),
              revision > 0,
              updatedAt >= createdAt,
              overrides.count <= ChatFolderContract.maximumOverrides,
              Set(overrides.map(\.chatID)).count == overrides.count
        else { throw LuxoraAPIError.invalidResponse }
        _ = try rules.validated()
        let validatedOverrides = try overrides.map { try $0.validated() }
        let pins = validatedOverrides.compactMap(\.pinnedPosition)
        guard Set(pins).count == pins.count else { throw LuxoraAPIError.invalidResponse }
        return self
    }
}

public struct ChatFolderListSnapshot: Equatable, Sendable {
    public let folders: [ChatFolder]
    public let stateRevision: Int

    public init(folders: [ChatFolder], stateRevision: Int) {
        self.folders = folders
        self.stateRevision = stateRevision
    }

    func validated() throws -> ChatFolderListSnapshot {
        guard folders.count <= ChatFolderContract.maximumFolders,
              stateRevision >= 0,
              Set(folders.map(\.id)).count == folders.count,
              Set(folders.map(\.position)).count == folders.count
        else { throw LuxoraAPIError.invalidResponse }
        _ = try folders.map { try $0.validated() }
        guard folders == folders.sorted(by: { $0.position < $1.position }) else {
            throw LuxoraAPIError.invalidResponse
        }
        return self
    }
}

public struct ChatFolderDraft: Equatable, Sendable {
    public var title: String
    public var rules: ChatFolderRules
    public var overrides: [ChatFolderOverride]

    public init(title: String, rules: ChatFolderRules, overrides: [ChatFolderOverride]) {
        self.title = title
        self.rules = rules
        self.overrides = overrides
    }

    public static let empty = ChatFolderDraft(
        title: "",
        rules: .allUnarchived,
        overrides: []
    )

    func validated() throws -> ChatFolderDraft {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.unicodeScalars.count <= ChatFolderContract.maximumTitleCodePoints,
              overrides.count <= ChatFolderContract.maximumOverrides,
              Set(overrides.map(\.chatID)).count == overrides.count
        else { throw LuxoraAPIError.invalidResponse }
        _ = try rules.validated()
        _ = try overrides.map { try $0.validated() }
        let pins = overrides.compactMap(\.pinnedPosition)
        guard Set(pins).count == pins.count else { throw LuxoraAPIError.invalidResponse }
        return ChatFolderDraft(title: normalized, rules: rules, overrides: overrides)
    }
}
