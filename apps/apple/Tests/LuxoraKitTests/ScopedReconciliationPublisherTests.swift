import Foundation
@testable import LuxoraKit
import LuxoraDesignFixtures
import XCTest

@MainActor
final class ScopedReconciliationPublisherTests: XCTestCase {
    func testInvalidCommunityPreflightLeavesEveryProjectionCursorAndInflightLoadUnchanged() async throws {
        let messenger = LuxoraDesignFixtures.makeStore()
        let userID = messenger.currentUser.id
        let originalUser = messenger.currentUser
        let originalBio = messenger.currentUserBio
        let originalConversations = messenger.conversations
        let originalMessages = messenger.messagesByConversation
        let originalSelection = messenger.selectedConversationID

        let community = CommunityStore(
            currentUserID: userID,
            communities: messenger.conversations
        )
        let originalCommunities = community.communities
        let originalMembers = community.membersByCommunity
        let originalCommunityStates = community.communityStates
        let originalMemberListStates = community.memberListStates

        let existingChatID = try XCTUnwrap(messenger.conversations.first?.id)
        let existingPreferences = ChatPreferences(
            archivedAt: Date(timeIntervalSince1970: 1_786_435_200),
            mutedUntil: nil
        )
        let preferences = ChatPreferencesStore()
        _ = preferences.configureRemote(
            accountID: userID,
            loader: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        preferences.replaceConfirmed([existingChatID: existingPreferences])
        let originalPreferences = preferences.confirmed

        let folderGate = ReconciliationFolderLoadGate()
        let folders = ChatFoldersStore()
        let foldersBinding = folders.configureRemote(
            accountID: userID,
            loader: { try await folderGate.load() },
            creator: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            deleter: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            reorderer: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        try folders.replaceConfirmed(
            ChatFolderListSnapshot(folders: [], stateRevision: 0),
            binding: foldersBinding
        )
        let folderLoad = Task { await folders.refresh(force: true) }
        try await waitUntil { await folderGate.isWaiting }
        XCTAssertEqual(folders.loadState, .loading)

        let oldCursor = Self.validCursor(seed: "o")
        let newCursor = Self.validCursor(seed: "n")
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "account-b-access",
                refreshToken: "account-b-refresh",
                sessionID: UUID(),
                realtimeV2Cursor: oldCursor
            ),
            refreshOperation: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            persistOperation: { _ in }
        )
        let invalidBundle = Self.invalidCommunityBundle(
            currentUser: originalUser,
            currentUserBio: originalBio,
            cursor: newCursor
        )
        var cursorCommitCallCount = 0

        do {
            try ScopedReconciliationPublisher.publish(
                invalidBundle,
                currentUserID: userID,
                messengerStore: messenger,
                communityStore: community,
                preferencesStore: preferences,
                foldersStore: folders,
                foldersBinding: foldersBinding
            )
            cursorCommitCallCount += 1
            try await coordinator.commitRealtimeV2Cursor(newCursor)
            XCTFail("An invalid community projection must abort the entire publication")
        } catch CommunityStoreError.invalidMemberPage {
            // Expected preflight failure before any commit or cancellation.
        } catch {
            XCTFail("Expected invalidMemberPage, received \(error)")
        }

        XCTAssertEqual(messenger.currentUser, originalUser)
        XCTAssertEqual(messenger.currentUserBio, originalBio)
        XCTAssertEqual(messenger.conversations, originalConversations)
        XCTAssertEqual(messenger.messagesByConversation, originalMessages)
        XCTAssertEqual(messenger.selectedConversationID, originalSelection)
        XCTAssertEqual(community.communities, originalCommunities)
        XCTAssertEqual(community.membersByCommunity, originalMembers)
        XCTAssertEqual(community.communityStates, originalCommunityStates)
        XCTAssertEqual(community.memberListStates, originalMemberListStates)
        XCTAssertEqual(preferences.confirmed, originalPreferences)
        XCTAssertTrue(folders.folders.isEmpty)
        XCTAssertEqual(folders.stateRevision, 0)
        XCTAssertEqual(folders.loadState, .loading, "Preflight must not cancel active work")
        XCTAssertEqual(cursorCommitCallCount, 0)
        let cursorAfterFailure = await coordinator.realtimeV2Cursor()
        XCTAssertEqual(cursorAfterFailure, oldCursor)

        await folderGate.finish(
            ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )
        _ = await folderLoad.value
        XCTAssertEqual(folders.loadState, .loaded)
    }

    func testInvalidFolderPreflightLeavesAllFourStoresAndCursorCommitProbeUntouched() throws {
        let messenger = LuxoraDesignFixtures.makeStore()
        let userID = messenger.currentUser.id
        let originalUser = messenger.currentUser
        let originalBio = messenger.currentUserBio
        let originalConversations = messenger.conversations
        let originalMessages = messenger.messagesByConversation

        let community = CommunityStore(
            currentUserID: userID,
            communities: messenger.conversations
        )
        let originalCommunities = community.communities
        let originalMembers = community.membersByCommunity

        let existingChatID = try XCTUnwrap(messenger.conversations.first?.id)
        let preferences = ChatPreferencesStore()
        _ = preferences.configureRemote(
            accountID: userID,
            loader: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        preferences.replaceConfirmed([
            existingChatID: ChatPreferences(archivedAt: nil, mutedUntil: .distantFuture),
        ])
        let originalPreferences = preferences.confirmed

        let folders = ChatFoldersStore()
        let foldersBinding = folders.configureRemote(
            accountID: userID,
            loader: { throw ReconciliationPublisherHarnessError.unexpectedCall },
            creator: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            deleter: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            reorderer: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        try folders.replaceConfirmed(
            ChatFolderListSnapshot(folders: [], stateRevision: 0),
            binding: foldersBinding
        )
        let invalidFolderBundle = Self.invalidFolderBundle(currentUser: originalUser)
        let cursorCommitProbe = ReconciliationCursorCommitProbe()

        do {
            try ScopedReconciliationPublisher.publish(
                invalidFolderBundle,
                currentUserID: userID,
                messengerStore: messenger,
                communityStore: community,
                preferencesStore: preferences,
                foldersStore: folders,
                foldersBinding: foldersBinding
            )
            cursorCommitProbe.commit(invalidFolderBundle.boundary.cursor)
            XCTFail("An invalid folder snapshot must abort the entire publication")
        } catch LuxoraAPIError.invalidResponse {
            // Expected before any store or cursor publication.
        } catch {
            XCTFail("Expected invalidResponse, received \(error)")
        }

        XCTAssertEqual(messenger.currentUser, originalUser)
        XCTAssertEqual(messenger.currentUserBio, originalBio)
        XCTAssertEqual(messenger.conversations, originalConversations)
        XCTAssertEqual(messenger.messagesByConversation, originalMessages)
        XCTAssertEqual(community.communities, originalCommunities)
        XCTAssertEqual(community.membersByCommunity, originalMembers)
        XCTAssertEqual(preferences.confirmed, originalPreferences)
        XCTAssertTrue(folders.folders.isEmpty)
        XCTAssertEqual(folders.stateRevision, 0)
        XCTAssertEqual(cursorCommitProbe.callCount, 0)
        XCTAssertNil(cursorCommitProbe.cursor)
    }

    func testInvalidPreflightCannotRunDraftLifecyclePurgeOrLosePendingNonce() async throws {
        let chatID = UUID()
        let messenger = Self.draftLifecycleMessenger(chatID: chatID)
        let userID = messenger.currentUser.id
        let joinedAt = Date(timeIntervalSince1970: 1_786_000_000)
        XCTAssertFalse(
            messenger.applyRealtimeMembership(
                RealtimeChatMembershipEvent(
                    audience: .memberAccount,
                    change: .roleUpdated,
                    membership: APIChatMembership(
                        chatId: chatID,
                        userId: userID,
                        role: "member",
                        revision: 2,
                        joinedAt: joinedAt,
                        updatedAt: joinedAt.addingTimeInterval(60)
                    ),
                    actorUserID: userID,
                    changedAt: joinedAt.addingTimeInterval(60)
                ),
                currentUserID: userID,
                causalSequence: 2
            )
        )

        let mutationProbe = ReconciliationDraftFailureProbe()
        let drafts = SynchronizedChatDraftStore()
        drafts.configureRemote(
            accountID: userID,
            sessionID: UUID(),
            loader: { chatID in
                SynchronizedChatDraftState(
                    draft: SynchronizedChatDraft(
                        chatID: chatID,
                        content: .init(text: "server base"),
                        revision: 2,
                        updatedAt: joinedAt
                    ),
                    revision: 2
                )
            },
            putter: { chatID, command in
                try await mutationProbe.fail(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        messenger.configureSynchronizedDrafts(drafts)
        await messenger.loadSynchronizedDraft(for: chatID)
        messenger.draft = "private dirty text with pending CAS"
        drafts.cancelScheduledPersist(for: chatID)
        let initialPersisted = await drafts.persist(chatID)
        XCTAssertFalse(initialPersisted)
        let firstCommands = await mutationProbe.commands
        XCTAssertEqual(firstCommands.count, 1)
        let firstCommand = try XCTUnwrap(firstCommands.first)
        XCTAssertTrue(drafts.dirtyChatIDs.contains(chatID))

        let community = CommunityStore(
            currentUserID: userID,
            communities: messenger.conversations
        )
        let preferences = ChatPreferencesStore()
        _ = preferences.configureRemote(
            accountID: userID,
            loader: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        let folders = ChatFoldersStore()
        let foldersBinding = folders.configureRemote(
            accountID: userID,
            loader: { throw ReconciliationPublisherHarnessError.unexpectedCall },
            creator: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            deleter: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            reorderer: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        try folders.replaceConfirmed(
            ChatFolderListSnapshot(folders: [], stateRevision: 0),
            binding: foldersBinding
        )
        let invalidBundle = Self.invalidLifecycleFolderBundle(
            messenger: messenger,
            chatID: chatID,
            joinedAt: joinedAt.addingTimeInterval(3_600)
        )
        let cursorCommitProbe = ReconciliationCursorCommitProbe()
        var recoveryPlan: SynchronizedChatDraftRecoveryPlan?

        do {
            try ScopedReconciliationPublisher.publish(
                invalidBundle,
                currentUserID: userID,
                messengerStore: messenger,
                communityStore: community,
                preferencesStore: preferences,
                foldersStore: folders,
                foldersBinding: foldersBinding,
                beforeCommit: {
                    let resets = messenger.synchronizedDraftLifecycleResetChatIDs(
                        in: invalidBundle,
                        currentUserID: userID
                    )
                    recoveryPlan = drafts.prepareForRecovery(
                        retainedChatIDs: [chatID],
                        lifecycleResetChatIDs: resets
                    )
                }
            )
            cursorCommitProbe.commit(invalidBundle.boundary.cursor)
            XCTFail("Invalid folders must abort before draft recovery")
        } catch LuxoraAPIError.invalidResponse {
            // Expected from folder preflight.
        } catch {
            XCTFail("Expected invalidResponse, received \(error)")
        }

        XCTAssertNil(recoveryPlan)
        XCTAssertEqual(cursorCommitProbe.callCount, 0)
        XCTAssertNil(cursorCommitProbe.cursor)
        XCTAssertEqual(messenger.draft, "private dirty text with pending CAS")
        XCTAssertEqual(
            messenger.composerDraftsByConversation[chatID],
            "private dirty text with pending CAS"
        )
        XCTAssertEqual(drafts.localDraft(for: chatID).text, "private dirty text with pending CAS")
        XCTAssertTrue(drafts.dirtyChatIDs.contains(chatID))
        XCTAssertNotNil(drafts.confirmedState(for: chatID))

        let retried = await drafts.persist(chatID)
        XCTAssertFalse(retried)
        let retriedCommands = await mutationProbe.commands
        XCTAssertEqual(retriedCommands.count, 2)
        XCTAssertEqual(
            retriedCommands.map(\.clientNonce),
            [firstCommand.clientNonce, firstCommand.clientNonce],
            "Failed preflight must preserve the exact idempotent command"
        )
    }

    private static func invalidCommunityBundle(
        currentUser: Participant,
        currentUserBio: String,
        cursor: String
    ) -> LuxoraReconciliationBundle {
        let now = Date(timeIntervalSince1970: 1_786_435_200)
        let user = APIUser(
            id: currentUser.id,
            username: currentUser.username,
            displayName: "Не должен примениться",
            bio: "Не должен примениться",
            avatarUrl: nil,
            avatarPath: "/avatars/uncommitted",
            createdAt: now,
            presence: "online",
            lastSeenAt: now
        )
        let invalidGroup = APIChat(
            id: UUID(),
            kind: "group",
            title: "Несогласованная группа",
            avatarUrl: nil,
            role: "owner",
            memberCount: 2,
            lastMessage: nil,
            lastActivityAt: now,
            createdAt: now,
            unreadCount: 4,
            archivedAt: nil,
            mutedUntil: nil
        )
        return LuxoraReconciliationBundle(
            boundary: RealtimeReconciliationBoundary(
                sequence: 99,
                cursor: cursor,
                capturedAt: now,
                cursorExpiresAt: now.addingTimeInterval(86_400)
            ),
            currentUser: user,
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [
                ReconciliationChatState(
                    chat: invalidGroup,
                    members: [], // memberCount=2 must fail Community preflight.
                    messages: [],
                    pins: [],
                    topics: []
                ),
            ],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 1)
        )
    }

    private static func validCursor(seed: Character) -> String {
        "luxora-rt1.\(String(repeating: seed, count: 40)).\(String(repeating: seed, count: 40))"
    }

    private static func invalidFolderBundle(
        currentUser: Participant
    ) -> LuxoraReconciliationBundle {
        let now = Date(timeIntervalSince1970: 1_786_435_200)
        return LuxoraReconciliationBundle(
            boundary: RealtimeReconciliationBoundary(
                sequence: 100,
                cursor: validCursor(seed: "f"),
                capturedAt: now,
                cursorExpiresAt: now.addingTimeInterval(86_400)
            ),
            currentUser: APIUser(
                id: currentUser.id,
                username: currentUser.username,
                displayName: "Профиль из неприменённого снимка",
                bio: "Не публиковать",
                avatarUrl: nil,
                avatarPath: "/avatars/not-published",
                createdAt: now,
                presence: "online",
                lastSeenAt: now
            ),
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: -1)
        )
    }

    private static func invalidLifecycleFolderBundle(
        messenger: MessengerStore,
        chatID: UUID,
        joinedAt: Date
    ) -> LuxoraReconciliationBundle {
        let user = APIUser(
            id: messenger.currentUser.id,
            username: messenger.currentUser.username,
            displayName: messenger.currentUser.displayName,
            bio: messenger.currentUserBio,
            avatarUrl: nil,
            avatarPath: messenger.currentUser.avatarPath,
            createdAt: joinedAt,
            presence: nil,
            lastSeenAt: nil
        )
        let membership = APIChatMembership(
            chatId: chatID,
            userId: user.id,
            role: "member",
            revision: 1,
            joinedAt: joinedAt,
            updatedAt: joinedAt
        )
        return LuxoraReconciliationBundle(
            boundary: RealtimeReconciliationBoundary(
                sequence: 101,
                cursor: validCursor(seed: "l"),
                capturedAt: joinedAt,
                cursorExpiresAt: joinedAt.addingTimeInterval(86_400)
            ),
            currentUser: user,
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [
                ReconciliationChatState(
                    chat: APIChat(
                        id: chatID,
                        kind: "direct",
                        title: messenger.selectedConversation?.title ?? "Чат",
                        avatarUrl: nil,
                        role: "member",
                        memberCount: 1,
                        lastMessage: nil,
                        lastActivityAt: joinedAt,
                        createdAt: joinedAt,
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
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: -1)
        )
    }

    private static func draftLifecycleMessenger(chatID: UUID) -> MessengerStore {
        let participant = Participant(
            id: UUID(),
            displayName: "Владелец",
            username: "draft_owner",
            initials: "В",
            accentHex: "2F1893",
            isOnline: true,
            status: "online"
        )
        let conversation = Conversation(
            id: chatID,
            title: "Приватный чат",
            subtitle: "",
            kind: .direct,
            avatar: participant,
            memberCount: 1,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: Date(timeIntervalSince1970: 1_786_435_200),
            folder: "personal",
            serverRole: "member"
        )
        let store = MessengerStore(
            conversations: [conversation],
            messagesByConversation: [chatID: []],
            currentUser: participant,
            selectedConversationID: chatID,
            loadedConversationIDs: [chatID]
        )
        store.connectionState = .online
        return store
    }

    private func waitUntil(
        _ predicate: @escaping @Sendable () async -> Bool
    ) async throws {
        for _ in 0..<200 {
            if await predicate() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Timed out waiting for the in-flight folder load")
    }
}

private actor ReconciliationFolderLoadGate {
    private var continuation: CheckedContinuation<ChatFolderListSnapshot, Error>?

    var isWaiting: Bool { continuation != nil }

    func load() async throws -> ChatFolderListSnapshot {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish(_ snapshot: ChatFolderListSnapshot) {
        continuation?.resume(returning: snapshot)
        continuation = nil
    }
}

private enum ReconciliationPublisherHarnessError: Error {
    case unexpectedCall
}

private actor ReconciliationDraftFailureProbe {
    private(set) var commands: [ChatDraftPutCommand] = []

    func fail(
        chatID: UUID,
        command: ChatDraftPutCommand
    ) throws -> ChatDraftMutationResult {
        _ = chatID
        commands.append(command)
        throw ReconciliationPublisherHarnessError.unexpectedCall
    }
}

@MainActor
private final class ReconciliationCursorCommitProbe {
    private(set) var callCount = 0
    private(set) var cursor: String?

    func commit(_ cursor: String) {
        callCount += 1
        self.cursor = cursor
    }
}
