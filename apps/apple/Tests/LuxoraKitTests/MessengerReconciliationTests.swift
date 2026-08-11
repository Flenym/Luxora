import Foundation
@testable import LuxoraKit
import LuxoraDesignFixtures
import XCTest

@MainActor
final class MessengerReconciliationTests: XCTestCase {
    func testAuthoritativeBundlePublishesChatsMessagesRequestsReactionsReceiptsAndPinsTogether() throws {
        let store = LuxoraDesignFixtures.makeStore()
        let me = store.currentUser
        let peer = Self.apiUser(id: UUID(), username: "mira", displayName: "Мира")
        let chatID = UUID()
        let messageID = UUID()
        let now = Date()
        let chat = APIChat(
            id: chatID,
            kind: "direct",
            title: "Мира",
            avatarUrl: nil,
            role: "member",
            memberCount: 2,
            lastMessage: nil,
            lastActivityAt: now,
            createdAt: now,
            unreadCount: 0,
            archivedAt: now,
            mutedUntil: now.addingTimeInterval(3_600)
        )
        let message = APIMessage(
            id: messageID,
            chatId: chatID,
            sender: Self.apiUser(
                id: me.id,
                username: me.username,
                displayName: me.displayName
            ),
            kind: "text",
            body: "Состояние из снимка",
            replyToMessageId: nil,
            topicId: nil,
            forwardedFrom: nil,
            isPinned: false,
            clientNonce: UUID(),
            revision: 3,
            createdAt: now,
            updatedAt: now,
            editedAt: nil,
            deletedAt: nil
        )
        let request = APIMessageRequest(
            id: UUID(),
            direction: .incoming,
            state: .pending,
            body: "Можно написать?",
            sender: APIPublicProfile(
                id: peer.id,
                username: peer.username,
                displayName: peer.displayName,
                bio: peer.bio,
                avatarUrl: nil,
                avatarPath: nil
            ),
            recipient: nil,
            createdAt: now,
            expiresAt: now.addingTimeInterval(86_400),
            acceptedAt: nil
        )
        let bundle = LuxoraReconciliationBundle(
            boundary: Self.boundary(),
            currentUser: Self.apiUser(
                id: me.id,
                username: me.username,
                displayName: me.displayName
            ),
            incomingRequests: [request],
            outgoingRequests: [],
            blocks: [],
            chats: [
                ReconciliationChatState(
                    chat: chat,
                    members: [],
                    messages: [
                        ReconciliationMessageState(
                            message: message,
                            reactions: [
                                APIReactionSummary(emoji: "🔥", count: 2, reactedByMe: true),
                            ],
                            receipts: [
                                APIMessageReceipt(userId: peer.id, deliveredAt: now, readAt: now),
                            ]
                        ),
                    ],
                    pins: [
                        APIMessagePin(
                            chatId: chatID,
                            messageId: messageID,
                            pinnedBy: peer,
                            pinnedAt: now
                        ),
                    ],
                    topics: []
                ),
            ],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )

        try store.applyReconciliation(bundle, currentUserID: me.id)

        XCTAssertEqual(store.conversations.map(\.id), [chatID])
        XCTAssertTrue(store.conversations[0].isArchived)
        XCTAssertTrue(store.conversations[0].isMuted)
        let projected = try XCTUnwrap(store.messagesByConversation[chatID]?.first)
        XCTAssertEqual(projected.text, "Состояние из снимка")
        XCTAssertEqual(projected.delivery, .read)
        XCTAssertEqual(projected.reactions, [MessageReaction(emoji: "🔥", count: 2, isMine: true)])
        XCTAssertTrue(store.metadata(for: messageID).isPinned)
        XCTAssertEqual(store.messageRequests(.incoming).map(\.id), [request.id])
        XCTAssertEqual(store.selectedConversationID, chatID)
        XCTAssertEqual(store.conversationListState, .loaded)
    }

    func testInvalidRequestProjectionLeavesPreviousStoreCompletelyUnchanged() {
        let store = LuxoraDesignFixtures.makeStore()
        let conversationIDs = store.conversations.map(\.id)
        let messages = store.messagesByConversation
        let selection = store.selectedConversationID
        let now = Date(timeIntervalSince1970: 1_786_435_200)
        let invalidIncoming = APIMessageRequest(
            id: UUID(),
            direction: .incoming,
            state: .pending,
            body: "Нет безопасного отправителя",
            sender: nil,
            recipient: nil,
            createdAt: now,
            expiresAt: now.addingTimeInterval(60),
            acceptedAt: nil
        )
        let bundle = LuxoraReconciliationBundle(
            boundary: Self.boundary(),
            currentUser: Self.apiUser(
                id: store.currentUser.id,
                username: store.currentUser.username,
                displayName: store.currentUser.displayName
            ),
            incomingRequests: [invalidIncoming],
            outgoingRequests: [],
            blocks: [],
            chats: [],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )

        XCTAssertThrowsError(try store.applyReconciliation(bundle, currentUserID: store.currentUser.id))
        XCTAssertEqual(store.conversations.map(\.id), conversationIDs)
        XCTAssertEqual(store.messagesByConversation, messages)
        XCTAssertEqual(store.selectedConversationID, selection)
    }

    func testProfileOnlyBundleUpdatesSelfAndAvatarForAccountWithNoChats() throws {
        let store = LuxoraDesignFixtures.makeStore()
        let userID = store.currentUser.id
        let reconciledUser = Self.apiUser(
            id: userID,
            username: store.currentUser.username,
            displayName: "Егор после синхронизации",
            bio: "Профиль изменён на втором устройстве",
            avatarPath: "/v1/attachments/avatar-after-sync/content"
        )
        let bundle = LuxoraReconciliationBundle(
            boundary: Self.boundary(),
            currentUser: reconciledUser,
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )

        try store.applyReconciliation(bundle, currentUserID: userID)

        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertTrue(store.messagesByConversation.isEmpty)
        XCTAssertEqual(store.currentUser.id, userID)
        XCTAssertEqual(store.currentUser.displayName, "Егор после синхронизации")
        XCTAssertEqual(store.currentUserBio, "Профиль изменён на втором устройстве")
        XCTAssertEqual(
            store.currentUser.avatarPath,
            "/v1/attachments/avatar-after-sync/content"
        )
    }

    func testDelayedAccountAReconciliationCannotMutateReplacementAccountBStore() {
        let accountA = Self.apiUser(
            id: UUID(),
            username: "account_a",
            displayName: "Аккаунт A",
            bio: "Старый сеанс",
            avatarPath: "/avatars/a"
        )
        let accountB = Self.apiUser(
            id: UUID(),
            username: "account_b",
            displayName: "Аккаунт B",
            bio: "Текущий сеанс",
            avatarPath: "/avatars/b"
        )
        let store = MessengerStore(
            conversations: [],
            messagesByConversation: [:],
            currentUser: accountB.participant,
            currentUserBio: accountB.bio
        )
        let staleBundleFromA = LuxoraReconciliationBundle(
            boundary: Self.boundary(),
            currentUser: accountA,
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )

        XCTAssertThrowsError(
            try store.applyReconciliation(staleBundleFromA, currentUserID: accountA.id)
        )
        XCTAssertEqual(store.currentUser, accountB.participant)
        XCTAssertEqual(store.currentUserBio, accountB.bio)
        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertTrue(store.messagesByConversation.isEmpty)
    }

    func testRealtimeReceiptReactionAndMembershipRemovalUpdateLoadedProjection() throws {
        let store = LuxoraDesignFixtures.makeStore()
        let conversationID = try XCTUnwrap(store.selectedConversationID)
        let message = try XCTUnwrap(store.selectedMessages.first(where: { $0.isOutgoing }))
        var sentMessage = message
        sentMessage.delivery = .sent
        store.applyRealtimeMessage(sentMessage)

        store.applyRealtimeMessageReceipt(
            chatID: conversationID,
            messageID: message.id,
            isRead: false
        )
        XCTAssertEqual(
            store.messagesByConversation[conversationID]?.first(where: { $0.id == message.id })?.delivery,
            .delivered
        )
        store.applyRealtimeMessageReceipt(
            chatID: conversationID,
            messageID: message.id,
            isRead: true
        )
        store.applyRealtimeMessageReactions(
            chatID: conversationID,
            messageID: message.id,
            reactions: [MessageReaction(emoji: "❤️", count: 4, isMine: false)]
        )
        let updated = try XCTUnwrap(
            store.messagesByConversation[conversationID]?.first(where: { $0.id == message.id })
        )
        XCTAssertEqual(updated.delivery, .read)
        XCTAssertEqual(updated.reactions, [MessageReaction(emoji: "❤️", count: 4, isMine: false)])

        let event = RealtimeChatMembershipEvent(
            audience: .removedAccount,
            change: .removed,
            membership: APIChatMembership(
                chatId: conversationID,
                userId: store.currentUser.id,
                role: "member",
                revision: 2,
                joinedAt: .distantPast,
                updatedAt: .now
            ),
            actorUserID: UUID(),
            changedAt: .now
        )
        XCTAssertFalse(store.applyRealtimeMembership(event, currentUserID: store.currentUser.id))
        XCTAssertFalse(store.conversations.contains(where: { $0.id == conversationID }))
        XCTAssertNil(store.messagesByConversation[conversationID])
    }

    private static func apiUser(
        id: UUID,
        username: String,
        displayName: String,
        bio: String = "",
        avatarPath: String? = nil
    ) -> APIUser {
        APIUser(
            id: id,
            username: username,
            displayName: displayName,
            bio: bio,
            avatarUrl: nil,
            avatarPath: avatarPath,
            createdAt: Date(timeIntervalSince1970: 1_786_435_200),
            presence: nil,
            lastSeenAt: nil
        )
    }

    private static func boundary() -> RealtimeReconciliationBoundary {
        RealtimeReconciliationBoundary(
            sequence: 7,
            cursor: "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))",
            capturedAt: Date(timeIntervalSince1970: 1_786_435_200),
            cursorExpiresAt: Date(timeIntervalSince1970: 1_787_040_000)
        )
    }
}
