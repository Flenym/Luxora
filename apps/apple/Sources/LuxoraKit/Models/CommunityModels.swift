import Foundation

public enum CommunityKind: String, CaseIterable, Codable, Identifiable, Sendable {
    case group
    case channel

    public var id: String { rawValue }

    public var russianTitle: String {
        switch self {
        case .group: "Группа"
        case .channel: "Канал"
        }
    }

    var conversationKind: ConversationKind {
        switch self {
        case .group: .group
        case .channel: .channel
        }
    }
}

public enum ChatMembershipRole: String, CaseIterable, Codable, Identifiable, Sendable {
    case owner
    case admin
    case member

    public var id: String { rawValue }

    public var russianTitle: String {
        switch self {
        case .owner: "Владелец"
        case .admin: "Администратор"
        case .member: "Участник"
        }
    }

    public var isPrivileged: Bool {
        self == .owner || self == .admin
    }
}

public struct ChatMembership: Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID { userID }
    public let chatID: UUID
    public let userID: UUID
    public var role: ChatMembershipRole
    public var revision: Int
    public let joinedAt: Date
    public var updatedAt: Date

    public init(
        chatID: UUID,
        userID: UUID,
        role: ChatMembershipRole,
        revision: Int,
        joinedAt: Date,
        updatedAt: Date
    ) {
        self.chatID = chatID
        self.userID = userID
        self.role = role
        self.revision = revision
        self.joinedAt = joinedAt
        self.updatedAt = updatedAt
    }
}

public enum CommunityMembershipSignalChange: String, Equatable, Sendable {
    case added
    case roleUpdated = "role_updated"
    case removed
}

public struct CommunityMember: Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID { membership.userID }
    public var membership: ChatMembership
    public var participant: Participant

    public init(membership: ChatMembership, participant: Participant) {
        self.membership = membership
        self.participant = participant
    }
}

struct CommunityMembershipMutationReceipt: Equatable, Sendable {
    let membership: ChatMembership
    let replayed: Bool
}

public struct CommunityInviteLink: Equatable, Hashable, Sendable {
    public let id: UUID
    public let chatID: UUID
    public let createdBy: UUID
    public let approvalRequired: Bool
    public let expiresAt: Date?
    public let maxUses: Int?
    public let useCount: Int
    public let revokedAt: Date?
    public let createdAt: Date

    public init(
        id: UUID,
        chatID: UUID,
        createdBy: UUID,
        approvalRequired: Bool = false,
        expiresAt: Date?,
        maxUses: Int?,
        useCount: Int,
        revokedAt: Date?,
        createdAt: Date
    ) {
        self.id = id
        self.chatID = chatID
        self.createdBy = createdBy
        self.approvalRequired = approvalRequired
        self.expiresAt = expiresAt
        self.maxUses = maxUses
        self.useCount = useCount
        self.revokedAt = revokedAt
        self.createdAt = createdAt
    }

    public var isRevoked: Bool { revokedAt != nil }

    public func isExpired(now: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= now
    }

    public var isExhausted: Bool {
        guard let maxUses else { return false }
        return useCount >= maxUses
    }
}

public struct CommunityInviteCreation: Equatable, Sendable {
    public let invite: CommunityInviteLink
    public let token: String
    public let replayed: Bool

    public init(invite: CommunityInviteLink, token: String, replayed: Bool) {
        self.invite = invite
        self.token = token
        self.replayed = replayed
    }
}

public struct CommunityInviteRevocation: Equatable, Sendable {
    public let invite: CommunityInviteLink
    public let replayed: Bool

    public init(invite: CommunityInviteLink, replayed: Bool) {
        self.invite = invite
        self.replayed = replayed
    }
}

public enum CommunityJoinRequestState: String, Equatable, Hashable, Sendable, Codable {
    case pending
    case approved
    case denied
}

public struct CommunityJoinRequest: Equatable, Hashable, Sendable {
    public let id: UUID
    public let chatID: UUID
    public let userID: UUID
    public let inviteLinkID: UUID
    public let state: CommunityJoinRequestState
    public let decidedBy: UUID?
    public let createdAt: Date
    public let decidedAt: Date?

    public init(
        id: UUID,
        chatID: UUID,
        userID: UUID,
        inviteLinkID: UUID,
        state: CommunityJoinRequestState,
        decidedBy: UUID?,
        createdAt: Date,
        decidedAt: Date?
    ) {
        self.id = id
        self.chatID = chatID
        self.userID = userID
        self.inviteLinkID = inviteLinkID
        self.state = state
        self.decidedBy = decidedBy
        self.createdAt = createdAt
        self.decidedAt = decidedAt
    }
}

public enum CommunityInviteJoinOutcome: Equatable, Sendable {
    case joined(membership: ChatMembership, replayed: Bool)
    case pending(request: CommunityJoinRequest, replayed: Bool)
}

public struct CommunityJoinDecision: Equatable, Sendable {
    public let request: CommunityJoinRequest
    public let membership: ChatMembership?
    public let replayed: Bool

    public init(request: CommunityJoinRequest, membership: ChatMembership?, replayed: Bool) {
        self.request = request
        self.membership = membership
        self.replayed = replayed
    }
}

public enum CommunityOwnershipTransferState: String, Equatable, Hashable, Sendable, Codable {
    case pending
    case accepted
    case cancelled
    case expired
}

public struct CommunityOwnershipTransfer: Equatable, Hashable, Sendable {
    public let id: UUID
    public let chatID: UUID
    public let fromUserID: UUID
    public let toUserID: UUID
    public let state: CommunityOwnershipTransferState
    public let expiresAt: Date
    public let createdAt: Date
    public let decidedAt: Date?
    public let decidedBy: UUID?

    public init(
        id: UUID,
        chatID: UUID,
        fromUserID: UUID,
        toUserID: UUID,
        state: CommunityOwnershipTransferState,
        expiresAt: Date,
        createdAt: Date,
        decidedAt: Date?,
        decidedBy: UUID?
    ) {
        self.id = id
        self.chatID = chatID
        self.fromUserID = fromUserID
        self.toUserID = toUserID
        self.state = state
        self.expiresAt = expiresAt
        self.createdAt = createdAt
        self.decidedAt = decidedAt
        self.decidedBy = decidedBy
    }
}

public struct CommunityOwnershipTransferReceipt: Equatable, Sendable {
    public let transfer: CommunityOwnershipTransfer
    public let replayed: Bool

    public init(transfer: CommunityOwnershipTransfer, replayed: Bool) {
        self.transfer = transfer
        self.replayed = replayed
    }
}

public struct ChatTopic: Equatable, Hashable, Sendable, Identifiable {
    public var id: UUID { topicID }
    public let topicID: UUID
    public let chatID: UUID
    public let title: String
    public let createdBy: Participant
    public let createdAt: Date
    public let updatedAt: Date
    public let closedAt: Date?

    public init(
        topicID: UUID,
        chatID: UUID,
        title: String,
        createdBy: Participant,
        createdAt: Date,
        updatedAt: Date,
        closedAt: Date?
    ) {
        self.topicID = topicID
        self.chatID = chatID
        self.title = title
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.closedAt = closedAt
    }

    public var isClosed: Bool { closedAt != nil }
}

public enum CommunityMemberMutationKind: String, CaseIterable, Hashable, Sendable {
    case add
    case changeRole
    case remove

    public var russianTitle: String {
        switch self {
        case .add: "Добавление участника"
        case .changeRole: "Изменение роли"
        case .remove: "Удаление участника"
        }
    }
}

public struct CommunityMemberMutationKey: Equatable, Hashable, Sendable {
    public let chatID: UUID
    public let userID: UUID
    public let kind: CommunityMemberMutationKind

    public init(chatID: UUID, userID: UUID, kind: CommunityMemberMutationKind) {
        self.chatID = chatID
        self.userID = userID
        self.kind = kind
    }
}

public struct CommunityMemberMutationFailure: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let key: CommunityMemberMutationKey
    public let detail: String

    public init(
        id: UUID = UUID(),
        key: CommunityMemberMutationKey,
        detail: String
    ) {
        self.id = id
        self.key = key
        self.detail = detail
    }
}
