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
