import Foundation
import LuxoraKit

public enum LuxoraDesignFixtures {
    private static let meID = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
    private static let miraID = UUID(uuidString: "20000000-0000-0000-0000-000000000001")!
    private static let studioID = UUID(uuidString: "30000000-0000-0000-0000-000000000001")!
    private static let designID = UUID(uuidString: "40000000-0000-0000-0000-000000000001")!
    private static let savedID = UUID(uuidString: "50000000-0000-0000-0000-000000000001")!

    public static var primaryConversationID: UUID { miraID }

    public static var currentCapabilities: ServerCapabilities {
        ServerCapabilities(
            trust: .init(
                profile: "cloud_preview",
                contentReadableByServer: true,
                endToEndEncryption: false
            ),
            features: .init(
                phoneAuthentication: true,
                passwordAuthentication: true,
                deviceSessions: true,
                messaging: true,
                identityAccess: true,
                safetyReports: true,
                realtime: true,
                reconciliation: true,
                mediaUploads: true,
                serverSearchConfigured: false,
                calls: false,
                passkeys: false,
                push: false
            ),
            limits: .init(
                maxMessageCodePoints: 10_000,
                maxAttachmentsPerMessage: 10,
                maxAttachmentBytes: 104_857_600
            )
        )
    }

    public static var featureMatrix: LuxoraFeatureMatrix {
        LuxoraFeatureMatrix(capabilityState: .available(currentCapabilities))
    }

    @MainActor
    public static func makeStore() -> MessengerStore {
        let me = Participant(
            id: meID,
            displayName: "Alex Morgan",
            username: "alex",
            initials: "AM",
            accentHex: "7C48D4",
            isOnline: true,
            status: "Building something luminous"
        )
        let mira = Participant(
            id: UUID(uuidString: "21000000-0000-0000-0000-000000000001")!,
            displayName: "Mira Chen",
            username: "mira",
            initials: "MC",
            accentHex: "3A6FF7",
            isOnline: true,
            status: "Designing calm software"
        )
        let studio = Participant(
            id: UUID(uuidString: "31000000-0000-0000-0000-000000000001")!,
            displayName: "Luxora Studio",
            username: "luxora",
            initials: "LS",
            accentHex: "5C3FB7",
            isOnline: true,
            status: "18 members online"
        )
        let design = Participant(
            id: UUID(uuidString: "41000000-0000-0000-0000-000000000001")!,
            displayName: "Design Dispatch",
            username: "design-dispatch",
            initials: "DD",
            accentHex: "181FB2",
            isOnline: false,
            status: "Channel"
        )

        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let conversations = [
            Conversation(
                id: miraID,
                title: mira.displayName,
                subtitle: "The motion feels natural now ✦",
                kind: .direct,
                avatar: mira,
                memberCount: 2,
                unreadCount: 2,
                isMuted: false,
                isPinned: true,
                isTyping: true,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-45),
                folder: "personal"
            ),
            Conversation(
                id: studioID,
                title: studio.displayName,
                subtitle: "Noah: API contract is ready for review",
                kind: .group,
                avatar: studio,
                memberCount: 42,
                unreadCount: 7,
                isMuted: false,
                isPinned: true,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-240),
                folder: "work"
            ),
            Conversation(
                id: designID,
                title: design.displayName,
                subtitle: "A field guide to humane notifications",
                kind: .channel,
                avatar: design,
                memberCount: 18_420,
                unreadCount: 0,
                isMuted: true,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-3_600),
                folder: "work"
            ),
            Conversation(
                id: savedID,
                title: "Saved",
                subtitle: "Flight details and launch notes",
                kind: .saved,
                avatar: me,
                memberCount: 1,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-8_000),
                folder: "personal"
            ),
        ]

        let miraMessages = [
            ChatMessage(
                id: UUID(uuidString: "22000000-0000-0000-0000-000000000001")!,
                conversationID: miraID,
                author: mira,
                text: "I simplified the transition between the chat list and conversation.",
                sentAt: now.addingTimeInterval(-1_400),
                delivery: .read,
                isOutgoing: false
            ),
            ChatMessage(
                id: UUID(uuidString: "22000000-0000-0000-0000-000000000002")!,
                conversationID: miraID,
                author: me,
                text: "Perfect. It should feel responsive, not theatrical — content first.",
                sentAt: now.addingTimeInterval(-1_180),
                delivery: .read,
                isOutgoing: true,
                reactions: [MessageReaction(emoji: "✨", count: 2, isMine: false)]
            ),
            ChatMessage(
                id: UUID(uuidString: "22000000-0000-0000-0000-000000000003")!,
                conversationID: miraID,
                author: mira,
                text: "Exactly. Glass stays with navigation and controls; messages remain quiet and readable.",
                sentAt: now.addingTimeInterval(-720),
                delivery: .read,
                isOutgoing: false,
                replyPreview: "It should feel responsive, not theatrical"
            ),
            ChatMessage(
                id: UUID(uuidString: "22000000-0000-0000-0000-000000000004")!,
                conversationID: miraID,
                author: mira,
                text: "The motion feels natural now ✦",
                sentAt: now.addingTimeInterval(-45),
                delivery: .delivered,
                isOutgoing: false
            ),
        ]

        let studioMessages = [
            ChatMessage(
                id: UUID(uuidString: "32000000-0000-0000-0000-000000000001")!,
                conversationID: studioID,
                author: studio,
                text: "Welcome to the product room. Today we are locking the realtime event envelope and delivery semantics.",
                sentAt: now.addingTimeInterval(-4_500),
                delivery: .read,
                isOutgoing: false
            ),
            ChatMessage(
                id: UUID(uuidString: "32000000-0000-0000-0000-000000000002")!,
                conversationID: studioID,
                author: me,
                text: "Let’s keep client-generated IDs for optimistic sends and a monotonic server sequence for recovery.",
                sentAt: now.addingTimeInterval(-3_900),
                delivery: .read,
                isOutgoing: true,
                reactions: [MessageReaction(emoji: "👍", count: 8, isMine: true)]
            ),
        ]

        let designMessages = [
            ChatMessage(
                id: UUID(uuidString: "42000000-0000-0000-0000-000000000001")!,
                conversationID: designID,
                author: design,
                text: "A field guide to humane notifications: urgency is a user decision, not an engagement lever.",
                sentAt: now.addingTimeInterval(-3_600),
                delivery: .read,
                isOutgoing: false,
                reactions: [MessageReaction(emoji: "💜", count: 124, isMine: false)]
            ),
        ]

        let savedMessages = [
            ChatMessage(
                id: UUID(uuidString: "52000000-0000-0000-0000-000000000001")!,
                conversationID: savedID,
                author: me,
                text: "Launch principle: clarity before novelty; privacy before growth.",
                sentAt: now.addingTimeInterval(-8_000),
                delivery: .read,
                isOutgoing: true
            ),
        ]

        return MessengerStore(
            conversations: conversations,
            messagesByConversation: [
                miraID: miraMessages,
                studioID: studioMessages,
                designID: designMessages,
                savedID: savedMessages,
            ],
            currentUser: me,
            selectedConversationID: miraID
        )
    }
}
