import XCTest
@testable import LuxoraKit
import LuxoraDesignFixtures

@MainActor
final class MessengerStoreTests: XCTestCase {
    func testSendDraftAddsOptimisticMessageAndClearsComposer() {
        let store = LuxoraDesignFixtures.makeStore()
        let currentUser = store.currentUser
        store.connectionState = .online
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: UUID(),
                    clientID: clientID,
                    conversationID: conversationID,
                    author: currentUser,
                    text: body,
                    sentAt: .now,
                    delivery: .sent,
                    isOutgoing: true
                )
            },
            loader: { _ in [] }
        )
        let originalCount = store.selectedMessages.count
        store.draft = "A reliable optimistic message"

        store.sendDraft()

        XCTAssertEqual(store.selectedMessages.count, originalCount + 1)
        XCTAssertEqual(store.selectedMessages.last?.text, "A reliable optimistic message")
        XCTAssertEqual(store.selectedMessages.last?.delivery, .sending)
        XCTAssertTrue(store.draft.isEmpty)
    }

    func testOfflineFixtureCannotPretendToSend() {
        let store = LuxoraDesignFixtures.makeStore()
        let originalCount = store.selectedMessages.count
        store.draft = "Must wait for a real server connection"

        store.sendDraft()

        XCTAssertFalse(store.canSend)
        XCTAssertEqual(store.selectedMessages.count, originalCount)
        XCTAssertEqual(store.draft, "Must wait for a real server connection")
    }

    func testSessionTeardownCancelsAnInFlightSend() async {
        let store = LuxoraDesignFixtures.makeStore()
        let currentUser = store.currentUser
        let probe = RemoteOperationProbe()
        store.connectionState = .online
        store.configureRemote(
            sender: { conversationID, clientID, body in
                await probe.markStarted()
                do {
                    try await Task.sleep(for: .seconds(30))
                    return ChatMessage(
                        id: UUID(),
                        clientID: clientID,
                        conversationID: conversationID,
                        author: currentUser,
                        text: body,
                        sentAt: .now,
                        delivery: .sent,
                        isOutgoing: true
                    )
                } catch is CancellationError {
                    await probe.markCancelled()
                    throw CancellationError()
                }
            },
            loader: { _ in [] }
        )
        store.draft = "Cancel this request during session teardown"

        store.sendDraft()
        await probe.waitUntilStarted()
        store.cancelRemoteOperations()
        await probe.waitUntilCancelled()

        let wasCancelled = await probe.wasCancelled
        XCTAssertTrue(wasCancelled)
    }

    func testWhitespaceCannotBeSent() {
        let store = LuxoraDesignFixtures.makeStore()
        let originalCount = store.selectedMessages.count
        store.draft = "   \n "

        store.sendDraft()

        XCTAssertEqual(store.selectedMessages.count, originalCount)
        XCTAssertFalse(store.canSend)
    }

    func testChannelComposerFailsClosedForMemberAndOpensAfterConfirmedAdminRole() throws {
        let fixture = LuxoraDesignFixtures.makeStore()
        var channel = try XCTUnwrap(fixture.conversations.first(where: { $0.kind == .channel }))
        channel.serverRole = ChatMembershipRole.member.rawValue
        let currentUser = fixture.currentUser
        let store = MessengerStore(
            conversations: [channel],
            messagesByConversation: [channel.id: []],
            currentUser: currentUser,
            selectedConversationID: channel.id,
            loadedConversationIDs: [channel.id]
        )
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: UUID(),
                    clientID: clientID,
                    conversationID: conversationID,
                    author: currentUser,
                    text: body,
                    sentAt: .now,
                    delivery: .sent,
                    isOutgoing: true
                )
            },
            loader: { _ in [] }
        )
        store.connectionState = .online
        store.draft = "Публикация"

        XCTAssertFalse(store.canSend)

        channel.serverRole = ChatMembershipRole.admin.rawValue
        store.applyRealtimeConversation(channel)

        XCTAssertTrue(store.canSend)
    }

    func testFolderAndQueryComposePredictably() {
        let store = LuxoraDesignFixtures.makeStore()
        store.selectedFolder = .work
        store.searchQuery = "studio"

        XCTAssertEqual(store.filteredConversations.map(\.title), ["Luxora Studio"])
    }

    func testReactionToggleIsReversible() {
        let store = LuxoraDesignFixtures.makeStore()
        guard let message = store.selectedMessages.first(where: { !$0.reactions.isEmpty }),
              let reaction = message.reactions.first
        else {
            return XCTFail("Fixture must include a reaction")
        }

        store.toggleReaction(reaction.emoji, messageID: message.id)
        let toggled = store.selectedMessages.first(where: { $0.id == message.id })?.reactions.first

        XCTAssertNotEqual(toggled?.isMine, reaction.isMine)
    }

    func testRefreshConversationsUsesServerDataWithoutErasingLocalOrganization() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let currentUser = store.currentUser
        let existingMessages = store.messagesByConversation
        let selectedID = try XCTUnwrap(store.selectedConversationID)
        var remoteConversations = store.conversations
        let remoteIndex = try XCTUnwrap(remoteConversations.firstIndex(where: { $0.id == selectedID }))
        remoteConversations[remoteIndex].subtitle = "Обновлено сервером"
        remoteConversations[remoteIndex].isPinned = false
        remoteConversations[remoteIndex].folder = "work"
        let serverConversations = remoteConversations
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: UUID(), clientID: clientID, conversationID: conversationID,
                    author: currentUser, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                )
            },
            loader: { conversationID in existingMessages[conversationID, default: []] },
            conversationsLoader: { serverConversations }
        )

        await store.refreshConversations()

        let refreshed = try XCTUnwrap(store.conversations.first(where: { $0.id == selectedID }))
        XCTAssertEqual(store.conversationListState, .loaded)
        XCTAssertEqual(refreshed.subtitle, "Обновлено сервером")
        XCTAssertTrue(refreshed.isPinned, "A server refresh must preserve the local pin")
        XCTAssertEqual(refreshed.folder, "personal", "A server refresh must preserve the local folder")
    }

    func testFailedRefreshKeepsLoadedChatsAndExposesRetryState() async {
        let store = LuxoraDesignFixtures.makeStore()
        let originalIDs = store.conversations.map(\.id)
        let currentUser = store.currentUser
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: UUID(), clientID: clientID, conversationID: conversationID,
                    author: currentUser, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                )
            },
            loader: { _ in [] },
            conversationsLoader: { throw MessengerStoreTestError.unavailable }
        )

        await store.refreshConversations()

        XCTAssertEqual(store.conversations.map(\.id), originalIDs)
        guard case .failed = store.conversationListState else {
            return XCTFail("Expected an explicit failed refresh state")
        }
    }

    func testKnownPeopleSearchCreatesAndSelectsServerConversation() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let currentUser = store.currentUser
        let participant = try XCTUnwrap(store.conversations.first(where: { $0.kind == .direct })?.avatar)
        let createdID = UUID()
        let created = Conversation(
            id: createdID,
            title: participant.displayName,
            subtitle: "Сообщений пока нет",
            kind: .direct,
            avatar: participant,
            memberCount: 2,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: .now,
            folder: "personal"
        )
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: UUID(), clientID: clientID, conversationID: conversationID,
                    author: currentUser, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                )
            },
            loader: { _ in [] },
            peopleSearcher: { _ in [participant] },
            directConversationCreator: { _ in created }
        )

        await store.searchKnownPeople("mira")
        let selected = await store.createDirectConversation(with: participant.id)

        XCTAssertEqual(store.peopleSearchState, .loaded)
        XCTAssertEqual(store.peopleSearchResults.map(\.id), [participant.id])
        XCTAssertEqual(selected, createdID)
        XCTAssertEqual(store.selectedConversationID, createdID)
        XCTAssertTrue(store.conversations.contains(where: { $0.id == createdID }))
    }

    func testFailedOptimisticSendRetriesWithTheSameIdempotencyNonce() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let currentUser = store.currentUser
        let initialMessages = store.messagesByConversation
        let probe = RetrySendProbe()
        store.connectionState = .online
        store.configureRemote(
            sender: { conversationID, clientID, body in
                try await probe.send(
                    conversationID: conversationID,
                    clientID: clientID,
                    body: body,
                    author: currentUser
                )
            },
            loader: { conversationID in initialMessages[conversationID, default: []] }
        )
        await store.loadMessages(for: try XCTUnwrap(store.selectedConversationID), force: true)
        store.draft = "Повторить безопасно"

        store.sendDraft()
        try await waitUntil {
            store.selectedMessages.contains { $0.text == "Повторить безопасно" && $0.delivery == .failed }
        }
        let failed = try XCTUnwrap(store.selectedMessages.first { $0.text == "Повторить безопасно" })
        store.retryMessage(failed.id)
        try await waitUntil {
            store.selectedMessages.contains { $0.text == "Повторить безопасно" && $0.delivery == .sent }
        }

        let nonces = await probe.nonces
        XCTAssertEqual(nonces.count, 2)
        XCTAssertEqual(nonces[0], nonces[1], "Retry must preserve the server idempotency nonce")
    }

    func testProfileResponseLossKeepsOldProjectionAndExactRetryUpdatesEveryOwnedSnapshot() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let original = store.currentUser
        let initialMessages = store.messagesByConversation
        let probe = ProfileUpdateProbe()
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: UUID(), clientID: clientID, conversationID: conversationID,
                    author: original, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                )
            },
            loader: { conversationID in initialMessages[conversationID, default: []] },
            profileUpdater: { displayName, bio in
                try await probe.update(
                    displayName: displayName,
                    bio: bio,
                    original: original
                )
            }
        )

        let first = await store.updateCurrentUserProfile(
            displayName: "  Егор Flenym  ",
            bio: "  Создаёт Luxora Beta-0.1  "
        )
        XCTAssertFalse(first)
        XCTAssertEqual(store.currentUser, original, "Ambiguous response loss must not invent local success")
        guard case .failed = store.profileUpdateState else {
            return XCTFail("Response loss must remain visibly retryable")
        }

        let second = await store.updateCurrentUserProfile(
            displayName: "  Егор Flenym  ",
            bio: "  Создаёт Luxora Beta-0.1  "
        )
        XCTAssertTrue(second)
        XCTAssertEqual(store.profileUpdateState, .loaded)
        XCTAssertEqual(store.currentUser.displayName, "Егор Flenym")
        XCTAssertEqual(store.currentUserBio, "Создаёт Luxora Beta-0.1")

        let calls = await probe.calls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0], calls[1], "PATCH retry must preserve the exact normalized body")
        XCTAssertEqual(calls[0].displayName, "Егор Flenym")
        XCTAssertEqual(calls[0].bio, "Создаёт Luxora Beta-0.1")

        let ownedAvatar = try XCTUnwrap(store.conversations.first { $0.kind == .saved }?.avatar)
        XCTAssertEqual(ownedAvatar.displayName, "Егор Flenym")
        let ownedMessage = try XCTUnwrap(
            store.messagesByConversation.values.flatMap { $0 }.first { $0.author.id == original.id }
        )
        XCTAssertEqual(ownedMessage.author.displayName, "Егор Flenym")
    }

    func testSessionTeardownRejectsLateProfileSuccessAndRestoresIdleState() async {
        let store = LuxoraDesignFixtures.makeStore()
        let original = store.currentUser
        let probe = SuspendedProfileUpdateProbe(original: original)
        let initialMessages = store.messagesByConversation
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: UUID(), clientID: clientID, conversationID: conversationID,
                    author: original, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                )
            },
            loader: { conversationID in initialMessages[conversationID, default: []] },
            profileUpdater: { displayName, bio in
                await probe.update(displayName: displayName, bio: bio)
            }
        )

        let update = Task {
            await store.updateCurrentUserProfile(
                displayName: "Поздний профиль",
                bio: "Не должен примениться после выхода"
            )
        }
        await probe.waitUntilStarted()
        XCTAssertEqual(store.profileUpdateState, .loading)

        store.cancelRemoteOperations()
        XCTAssertEqual(store.profileUpdateState, .idle)
        await probe.release()

        let accepted = await update.value
        XCTAssertFalse(accepted)
        XCTAssertEqual(store.currentUser, original)
        XCTAssertNotEqual(store.currentUser.displayName, "Поздний профиль")
        XCTAssertEqual(store.profileUpdateState, .idle)
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        condition: @escaping @MainActor () -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for MessengerStore state")
    }
}

private enum MessengerStoreTestError: Error {
    case unavailable
}

private actor RetrySendProbe {
    private(set) var nonces: [UUID] = []

    func send(
        conversationID: UUID,
        clientID: UUID,
        body: String,
        author: Participant
    ) throws -> ChatMessage {
        nonces.append(clientID)
        if nonces.count == 1 { throw MessengerStoreTestError.unavailable }
        return ChatMessage(
            id: UUID(),
            clientID: clientID,
            conversationID: conversationID,
            author: author,
            text: body,
            sentAt: .now,
            delivery: .sent,
            isOutgoing: true
        )
    }
}

private actor ProfileUpdateProbe {
    struct Call: Equatable, Sendable {
        let displayName: String
        let bio: String
    }

    private(set) var calls: [Call] = []

    func update(
        displayName: String,
        bio: String,
        original: Participant
    ) throws -> CurrentUserProfileSnapshot {
        calls.append(Call(displayName: displayName, bio: bio))
        if calls.count == 1 { throw MessengerStoreTestError.unavailable }
        var participant = original
        participant.displayName = displayName
        participant.initials = "ЕФ"
        participant.status = bio.isEmpty ? "@\(participant.username)" : bio
        return CurrentUserProfileSnapshot(participant: participant, bio: bio)
    }
}

private actor SuspendedProfileUpdateProbe {
    private let original: Participant
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(original: Participant) {
        self.original = original
    }

    func update(displayName: String, bio: String) async -> CurrentUserProfileSnapshot {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { continuation in
            releaseContinuation = continuation
        }

        // Intentionally ignore cancellation to model a transport that reports
        // a successful response after the owning session has already detached.
        var participant = original
        participant.displayName = displayName
        participant.status = bio
        return CurrentUserProfileSnapshot(participant: participant, bio: bio)
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor RemoteOperationProbe {
    private var started = false
    private(set) var wasCancelled = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var cancellationWaiters: [CheckedContinuation<Void, Never>] = []

    func markStarted() {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func markCancelled() {
        wasCancelled = true
        cancellationWaiters.forEach { $0.resume() }
        cancellationWaiters.removeAll()
    }

    func waitUntilCancelled() async {
        guard !wasCancelled else { return }
        await withCheckedContinuation { cancellationWaiters.append($0) }
    }
}
