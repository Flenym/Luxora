import Foundation

public enum ConversationKind: String, Codable, CaseIterable, Sendable {
    case direct
    case group
    case channel
    case saved

    public var symbol: String {
        switch self {
        case .direct: "person.fill"
        case .group: "person.2.fill"
        case .channel: "megaphone.fill"
        case .saved: "bookmark.fill"
        }
    }
}

public enum ConversationFolder: String, CaseIterable, Identifiable, Sendable {
    case all
    case archived
    case unread
    case personal
    case work
    case groups
    case channels
    case saved

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: LuxoraL10n.text("folder.all")
        case .archived: "Архив"
        case .unread: LuxoraL10n.text("folder.unread")
        case .personal: LuxoraL10n.text("folder.personal")
        case .work: LuxoraL10n.text("folder.work")
        case .groups: LuxoraL10n.text("folder.groups")
        case .channels: LuxoraL10n.text("folder.channels")
        case .saved: LuxoraL10n.text("folder.saved")
        }
    }

    public func includes(_ conversation: Conversation) -> Bool {
        switch self {
        case .archived:
            conversation.isArchived
        case .all:
            !conversation.isArchived
        case .unread:
            !conversation.isArchived && conversation.unreadCount > 0
        case .personal:
            !conversation.isArchived && conversation.folder == "personal"
        case .work:
            !conversation.isArchived && conversation.folder == "work"
        case .groups:
            !conversation.isArchived && conversation.kind == .group
        case .channels:
            !conversation.isArchived && conversation.kind == .channel
        case .saved:
            !conversation.isArchived && conversation.kind == .saved
        }
    }
}

public struct Conversation: Identifiable, Hashable, Codable, Sendable {
    public let id: UUID
    public var title: String
    public var subtitle: String
    public var kind: ConversationKind
    public var avatar: Participant
    public var memberCount: Int
    public var unreadCount: Int
    public var isMuted: Bool
    /// Exact server deadline for a finite mute. `isMuted` is the current
    /// rendered projection and MessengerStore recomputes it at this deadline.
    public var mutedUntil: Date?
    public var isPinned: Bool
    public var isTyping: Bool
    public var isArchived: Bool
    public var lastActivity: Date
    public var folder: String
    /// Server membership role. Nil means the client does not have enough
    /// authority information and must hide privileged actions.
    public var serverRole: String?

    public init(
        id: UUID,
        title: String,
        subtitle: String,
        kind: ConversationKind,
        avatar: Participant,
        memberCount: Int,
        unreadCount: Int,
        isMuted: Bool,
        mutedUntil: Date? = nil,
        isPinned: Bool,
        isTyping: Bool,
        isArchived: Bool,
        lastActivity: Date,
        folder: String,
        serverRole: String? = nil
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
        self.avatar = avatar
        self.memberCount = memberCount
        self.unreadCount = unreadCount
        self.isMuted = isMuted
        self.mutedUntil = mutedUntil
        self.isPinned = isPinned
        self.isTyping = isTyping
        self.isArchived = isArchived
        self.lastActivity = lastActivity
        self.folder = folder
        self.serverRole = serverRole
    }
}
