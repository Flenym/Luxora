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

    func testReconciliationPurgesSelectedAndOrphanComposerDraftPrivacyState() throws {
        let store = LuxoraDesignFixtures.makeStore()
        let selectedChatID = try XCTUnwrap(store.selectedConversationID)
        let orphanChatID = UUID()
        let drafts = SynchronizedChatDraftStore()
        drafts.configureRemote(
            accountID: store.currentUser.id,
            sessionID: UUID(),
            loader: { _ in throw LuxoraAPIError.invalidResponse },
            putter: { _, _ in throw LuxoraAPIError.invalidResponse },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        store.configureSynchronizedDrafts(drafts)
        store.draft = "selected reconciliation secret"
        store.composerDraftsByConversation[orphanChatID] = "orphan reconciliation secret"
        store.unresolvedReplyIDsByConversation[orphanChatID] = UUID()
        _ = drafts.setLocalDraft(
            for: orphanChatID,
            text: "orphan reconciliation secret"
        )
        let bundle = LuxoraReconciliationBundle(
            boundary: Self.boundary(),
            currentUser: Self.apiUser(
                id: store.currentUser.id,
                username: store.currentUser.username,
                displayName: store.currentUser.displayName
            ),
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )

        try store.applyReconciliation(bundle, currentUserID: store.currentUser.id)

        XCTAssertNil(store.selectedConversationID)
        XCTAssertEqual(store.draft, "")
        XCTAssertNil(store.composerDraftsByConversation[selectedChatID])
        XCTAssertNil(store.composerDraftsByConversation[orphanChatID])
        XCTAssertNil(store.unresolvedReplyIDsByConversation[orphanChatID])
        XCTAssertEqual(drafts.localDraft(for: selectedChatID), .empty)
        XCTAssertEqual(drafts.localDraft(for: orphanChatID), .empty)
    }

    func testRealReconciliationPreservesRetainedEditAndConflictSafeExpectedRevision() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let chatID = try XCTUnwrap(store.selectedConversationID)
        let conversation = try XCTUnwrap(store.selectedConversation)
        let outgoing = try XCTUnwrap(store.selectedMessages.first(where: \.isOutgoing))
        let originalRevision = store.metadata(for: outgoing.id).revision
        let participant = store.currentUser
        store.configureRemote(
            sender: { _, _, _ in throw LuxoraAPIError.invalidResponse },
            loader: { _ in [] },
            messageEditor: { messageID, body, revision in
                RemoteMessageSnapshot(
                    message: ChatMessage(
                        id: messageID,
                        conversationID: chatID,
                        author: participant,
                        text: body,
                        sentAt: .now,
                        delivery: .sent,
                        isOutgoing: true
                    ),
                    metadata: MessageRemoteMetadata(revision: (revision ?? 0) + 1)
                )
            }
        )
        let draftLoader = ReconciliationDraftLoader(
            state: SynchronizedChatDraftState(
                draft: SynchronizedChatDraft(
                    chatID: chatID,
                    content: .init(text: "old underlying draft"),
                    revision: 1,
                    updatedAt: .now
                ),
                revision: 1
            )
        )
        let drafts = SynchronizedChatDraftStore()
        drafts.configureRemote(
            accountID: participant.id,
            sessionID: UUID(),
            loader: { _ in await draftLoader.load() },
            putter: { _, _ in throw LuxoraAPIError.invalidResponse },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        store.configureSynchronizedDrafts(drafts)
        await store.loadSynchronizedDraft(for: chatID)
        store.beginEditing(outgoing)
        store.draft = "unsaved edit across gap"
        let plan = drafts.prepareForRecovery(retainedChatIDs: [chatID])
        let now = Date()
        let apiMessage = APIMessage(
            id: outgoing.id,
            chatId: chatID,
            sender: Self.apiUser(
                id: participant.id,
                username: participant.username,
                displayName: participant.displayName
            ),
            kind: "text",
            body: "authoritative server body",
            replyToMessageId: nil,
            topicId: nil,
            forwardedFrom: nil,
            isPinned: false,
            clientNonce: outgoing.clientID,
            revision: 8,
            createdAt: outgoing.sentAt,
            updatedAt: now,
            editedAt: now,
            deletedAt: nil
        )
        let bundle = LuxoraReconciliationBundle(
            boundary: Self.boundary(),
            currentUser: Self.apiUser(
                id: participant.id,
                username: participant.username,
                displayName: participant.displayName
            ),
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [
                ReconciliationChatState(
                    chat: APIChat(
                        id: chatID,
                        kind: "direct",
                        title: conversation.title,
                        avatarUrl: nil,
                        role: "member",
                        memberCount: 2,
                        lastMessage: apiMessage,
                        lastActivityAt: now,
                        createdAt: now,
                        unreadCount: 0,
                        archivedAt: nil,
                        mutedUntil: nil
                    ),
                    members: [],
                    messages: [
                        ReconciliationMessageState(
                            message: apiMessage,
                            reactions: [],
                            receipts: []
                        ),
                    ],
                    pins: [],
                    topics: []
                ),
            ],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )

        try store.applyReconciliation(bundle, currentUserID: participant.id)
        store.applySynchronizedDraftRecoveryInvalidation(plan)

        XCTAssertEqual(store.draft, "unsaved edit across gap")
        guard case let .edit(target) = store.composerMode else {
            return XCTFail("Retained authoritative message must keep edit mode")
        }
        XCTAssertEqual(target.id, outgoing.id)
        XCTAssertEqual(target.revision, originalRevision)
        XCTAssertTrue(store.synchronizedDraftStore === drafts)
        XCTAssertEqual(drafts.mutationState(for: chatID), .idle)
        XCTAssertEqual(drafts.loadState(for: chatID), .idle)
        XCTAssertEqual(store.draft, "unsaved edit across gap")
        XCTAssertEqual(store.draftBeforeEditing, "")
        store.cancelComposerMode()
        XCTAssertEqual(store.draft, "")
    }

    func testMissedRemoveAndReaddLifecycleHardPurgesDirtyDraftBeforeFreshGET() async throws {
        let chatID = UUID()
        let store = Self.draftLifecycleMessenger(chatID: chatID)
        let accountID = store.currentUser.id
        let oldJoinedAt = Date(timeIntervalSince1970: 1_786_000_000)
        let oldMembership = RealtimeChatMembershipEvent(
            audience: .memberAccount,
            change: .roleUpdated,
            membership: APIChatMembership(
                chatId: chatID,
                userId: accountID,
                role: "member",
                revision: 4,
                joinedAt: oldJoinedAt,
                updatedAt: oldJoinedAt.addingTimeInterval(60)
            ),
            actorUserID: accountID,
            changedAt: oldJoinedAt.addingTimeInterval(60)
        )
        XCTAssertFalse(
            store.applyRealtimeMembership(
                oldMembership,
                currentUserID: accountID,
                causalSequence: 4
            )
        )

        let loader = ReconciliationDraftLoader(
            state: Self.draftState(chatID: chatID, text: "old server draft", revision: 4)
        )
        let putter = ReconciliationDraftPutter()
        let drafts = SynchronizedChatDraftStore()
        drafts.configureRemote(
            accountID: accountID,
            sessionID: UUID(),
            loader: { _ in await loader.load() },
            putter: { chatID, command in
                await putter.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        store.configureSynchronizedDrafts(drafts)
        await store.loadSynchronizedDraft(for: chatID)
        store.draft = "private text from the removed membership"
        drafts.cancelScheduledPersist(for: chatID)
        XCTAssertTrue(drafts.dirtyChatIDs.contains(chatID))

        let newJoinedAt = oldJoinedAt.addingTimeInterval(3_600)
        let bundle = Self.retainedChatBundle(
            store: store,
            chatID: chatID,
            membership: APIChatMembership(
                chatId: chatID,
                userId: accountID,
                role: "member",
                revision: 1,
                joinedAt: newJoinedAt,
                updatedAt: newJoinedAt
            )
        )
        let lifecycleResets = store.synchronizedDraftLifecycleResetChatIDs(
            in: bundle,
            currentUserID: accountID
        )
        XCTAssertEqual(lifecycleResets, [chatID])
        let plan = drafts.prepareForRecovery(
            retainedChatIDs: [chatID],
            lifecycleResetChatIDs: lifecycleResets
        )

        try store.applyReconciliation(bundle, currentUserID: accountID)
        store.applySynchronizedDraftRecoveryInvalidation(plan)

        XCTAssertEqual(plan.lifecycleResetChatIDs, [chatID])
        XCTAssertFalse(plan.dirtyPreservedChatIDs.contains(chatID))
        XCTAssertEqual(store.draft, "")
        XCTAssertNil(store.composerDraftsByConversation[chatID])
        XCTAssertEqual(drafts.localDraft(for: chatID), .empty)
        XCTAssertFalse(drafts.dirtyChatIDs.contains(chatID))

        await loader.replace(Self.draftState(chatID: chatID, text: nil, revision: 5))
        let refreshed = await drafts.refresh(chatID, force: true)
        try await Task.sleep(nanoseconds: 450_000_000)
        XCTAssertTrue(refreshed)
        XCTAssertEqual(drafts.confirmedState(for: chatID)?.revision, 5)
        let putCount = await putter.count
        XCTAssertEqual(putCount, 0, "Pre-removal private text must never be PUT")
    }

    func testSameMembershipLifetimeRoleChangePreservesDirtyDraftForCASRebase() async throws {
        let chatID = UUID()
        let store = Self.draftLifecycleMessenger(chatID: chatID)
        let accountID = store.currentUser.id
        let joinedAt = Date(timeIntervalSince1970: 1_786_000_000)
        XCTAssertFalse(
            store.applyRealtimeMembership(
                RealtimeChatMembershipEvent(
                    audience: .memberAccount,
                    change: .roleUpdated,
                    membership: APIChatMembership(
                        chatId: chatID,
                        userId: accountID,
                        role: "member",
                        revision: 4,
                        joinedAt: joinedAt,
                        updatedAt: joinedAt.addingTimeInterval(60)
                    ),
                    actorUserID: accountID,
                    changedAt: joinedAt.addingTimeInterval(60)
                ),
                currentUserID: accountID,
                causalSequence: 4
            )
        )

        let loader = ReconciliationDraftLoader(
            state: Self.draftState(chatID: chatID, text: "old server draft", revision: 4)
        )
        let putter = ReconciliationDraftPutter()
        let drafts = SynchronizedChatDraftStore()
        drafts.configureRemote(
            accountID: accountID,
            sessionID: UUID(),
            loader: { _ in await loader.load() },
            putter: { chatID, command in
                await putter.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        store.configureSynchronizedDrafts(drafts)
        await store.loadSynchronizedDraft(for: chatID)
        store.draft = "dirty text survives role update"
        drafts.cancelScheduledPersist(for: chatID)

        let bundle = Self.retainedChatBundle(
            store: store,
            chatID: chatID,
            membership: APIChatMembership(
                chatId: chatID,
                userId: accountID,
                role: "admin",
                revision: 5,
                joinedAt: joinedAt,
                updatedAt: joinedAt.addingTimeInterval(120)
            )
        )
        let lifecycleResets = store.synchronizedDraftLifecycleResetChatIDs(
            in: bundle,
            currentUserID: accountID
        )
        XCTAssertTrue(lifecycleResets.isEmpty)
        let plan = drafts.prepareForRecovery(
            retainedChatIDs: [chatID],
            lifecycleResetChatIDs: lifecycleResets
        )
        try store.applyReconciliation(bundle, currentUserID: accountID)
        store.applySynchronizedDraftRecoveryInvalidation(plan)

        XCTAssertEqual(plan.dirtyPreservedChatIDs, [chatID])
        XCTAssertEqual(store.draft, "dirty text survives role update")
        XCTAssertEqual(drafts.localDraft(for: chatID).text, "dirty text survives role update")

        await loader.replace(Self.draftState(chatID: chatID, text: "remote moved", revision: 7))
        let refreshed = await drafts.refresh(chatID, force: true)
        XCTAssertTrue(refreshed)
        drafts.cancelScheduledPersist(for: chatID)
        let persisted = await drafts.persist(chatID)
        XCTAssertTrue(persisted)
        let commands = await putter.commands
        XCTAssertEqual(commands.map(\.content.text), ["dirty text survives role update"])
        XCTAssertEqual(commands.map(\.expectedRevision), [7])
    }

    func testLifecycleResetHardScrubsLocalComposerWhenServerDraftFeatureIsOff() throws {
        let chatID = UUID()
        let store = Self.draftLifecycleMessenger(chatID: chatID)
        let outgoing = try XCTUnwrap(store.selectedMessages.first(where: \.isOutgoing))
        let accountID = store.currentUser.id
        let oldJoinedAt = Date(timeIntervalSince1970: 1_786_000_000)
        XCTAssertNil(store.synchronizedDraftStore)
        XCTAssertFalse(
            store.applyRealtimeMembership(
                RealtimeChatMembershipEvent(
                    audience: .memberAccount,
                    change: .roleUpdated,
                    membership: APIChatMembership(
                        chatId: chatID,
                        userId: accountID,
                        role: "member",
                        revision: 3,
                        joinedAt: oldJoinedAt,
                        updatedAt: oldJoinedAt.addingTimeInterval(60)
                    ),
                    actorUserID: accountID,
                    changedAt: oldJoinedAt.addingTimeInterval(60)
                ),
                currentUserID: accountID,
                causalSequence: 3
            )
        )
        store.draft = "local private draft"
        store.beginEditing(outgoing)
        store.draft = "unsaved edit body"
        XCTAssertEqual(store.draftBeforeEditing, "local private draft")

        let newJoinedAt = oldJoinedAt.addingTimeInterval(3_600)
        let bundle = Self.retainedChatBundle(
            store: store,
            chatID: chatID,
            membership: APIChatMembership(
                chatId: chatID,
                userId: accountID,
                role: "member",
                revision: 1,
                joinedAt: newJoinedAt,
                updatedAt: newJoinedAt
            )
        )
        let lifecycleResets = store.synchronizedDraftLifecycleResetChatIDs(
            in: bundle,
            currentUserID: accountID
        )
        XCTAssertEqual(lifecycleResets, [chatID])

        try store.applyReconciliation(bundle, currentUserID: accountID)
        store.applyComposerLifecycleReset(chatIDs: lifecycleResets)

        XCTAssertEqual(store.draft, "")
        XCTAssertEqual(store.composerMode, .new)
        XCTAssertEqual(store.draftBeforeEditing, "")
        XCTAssertEqual(store.composerModeBeforeEditing, .new)
        XCTAssertNil(store.composerDraftsByConversation[chatID])
        XCTAssertNil(store.composerModesByConversation[chatID])
        XCTAssertNil(store.unresolvedReplyIDsByConversation[chatID])
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

    private static func retainedChatBundle(
        store: MessengerStore,
        chatID: UUID,
        membership: APIChatMembership
    ) -> LuxoraReconciliationBundle {
        let now = membership.updatedAt
        let title = store.conversations.first(where: { $0.id == chatID })?.title ?? "Чат"
        let user = apiUser(
            id: store.currentUser.id,
            username: store.currentUser.username,
            displayName: store.currentUser.displayName
        )
        return LuxoraReconciliationBundle(
            boundary: boundary(),
            currentUser: user,
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [
                ReconciliationChatState(
                    chat: APIChat(
                        id: chatID,
                        kind: "direct",
                        title: title,
                        avatarUrl: nil,
                        role: membership.role,
                        memberCount: 1,
                        lastMessage: nil,
                        lastActivityAt: now,
                        createdAt: membership.joinedAt,
                        unreadCount: 0,
                        archivedAt: nil,
                        mutedUntil: nil
                    ),
                    members: [APIChatMember(membership: membership, user: user)],
                    messages: [],
                    pins: [],
                    topics: []
                ),
            ],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )
    }

    private static func draftState(
        chatID: UUID,
        text: String?,
        revision: Int
    ) -> SynchronizedChatDraftState {
        SynchronizedChatDraftState(
            draft: text.map {
                SynchronizedChatDraft(
                    chatID: chatID,
                    content: .init(text: $0),
                    revision: revision,
                    updatedAt: Date(timeIntervalSince1970: 1_786_435_200)
                )
            },
            revision: revision
        )
    }

    private static func draftLifecycleMessenger(chatID: UUID) -> MessengerStore {
        let participant = apiUser(
            id: UUID(),
            username: "draft_owner",
            displayName: "Владелец"
        ).participant
        let message = ChatMessage(
            id: UUID(),
            conversationID: chatID,
            author: participant,
            text: "Исходящее сообщение",
            sentAt: Date(timeIntervalSince1970: 1_786_435_200),
            delivery: .sent,
            isOutgoing: true
        )
        let conversation = Conversation(
            id: chatID,
            title: "Приватный чат",
            subtitle: message.text,
            kind: .direct,
            avatar: participant,
            memberCount: 1,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: message.sentAt,
            folder: "personal",
            serverRole: "member"
        )
        let store = MessengerStore(
            conversations: [conversation],
            messagesByConversation: [chatID: [message]],
            currentUser: participant,
            selectedConversationID: chatID,
            loadedConversationIDs: [chatID]
        )
        store.configureRemote(
            sender: { _, _, _ in throw LuxoraAPIError.invalidResponse },
            loader: { _ in [message] },
            messageEditor: { messageID, body, revision in
                RemoteMessageSnapshot(
                    message: ChatMessage(
                        id: messageID,
                        conversationID: chatID,
                        author: participant,
                        text: body,
                        sentAt: message.sentAt,
                        delivery: .sent,
                        isOutgoing: true
                    ),
                    metadata: MessageRemoteMetadata(revision: (revision ?? 0) + 1)
                )
            }
        )
        store.connectionState = .online
        return store
    }
}

private actor ReconciliationDraftLoader {
    private var state: SynchronizedChatDraftState

    init(state: SynchronizedChatDraftState) { self.state = state }

    func load() -> SynchronizedChatDraftState { state }

    func replace(_ state: SynchronizedChatDraftState) {
        self.state = state
    }
}

private actor ReconciliationDraftPutter {
    private(set) var commands: [ChatDraftPutCommand] = []

    var count: Int { commands.count }

    func put(
        chatID: UUID,
        command: ChatDraftPutCommand
    ) -> ChatDraftMutationResult {
        commands.append(command)
        let nextRevision = command.expectedRevision + 1
        return ChatDraftMutationResult(
            state: SynchronizedChatDraftState(
                draft: SynchronizedChatDraft(
                    chatID: chatID,
                    content: command.content,
                    revision: nextRevision,
                    updatedAt: Date(timeIntervalSince1970: 1_786_435_200)
                ),
                revision: nextRevision
            ),
            replayed: false
        )
    }
}
