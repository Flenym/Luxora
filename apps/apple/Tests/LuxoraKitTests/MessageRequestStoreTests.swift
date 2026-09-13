import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class MessageRequestStoreTests: XCTestCase {
    func testListFailureDoesNotReplacePreviouslyConfirmedInbox() async throws {
        let store = makeStore()
        let request = incomingRequest()
        configure(store, loader: { _ in [request] })

        await store.loadMessageRequests(.incoming)
        XCTAssertEqual(store.messageRequests(.incoming), [request])
        XCTAssertEqual(store.messageRequestListState(.incoming), .loaded)

        configure(store, loader: { _ in throw MessageRequestStoreTestError.rejected })
        await store.loadMessageRequests(.incoming, force: true)

        XCTAssertEqual(store.messageRequests(.incoming), [request])
        guard case .failed = store.messageRequestListState(.incoming) else {
            return XCTFail("Authoritative failure must stay visible")
        }
    }

    func testListRejectsMixedDirectionProjectionInsteadOfSilentlyHidingIt() async throws {
        let store = makeStore()
        let outgoing = MessageRequestItem(
            id: requestID,
            direction: .outgoing,
            state: .pending,
            body: "Несогласованный ответ",
            participant: participant(id: peerID, name: "Егор", username: "egor"),
            createdAt: Date(timeIntervalSince1970: 1_800_000_000),
            expiresAt: Date(timeIntervalSince1970: 1_802_592_000)
        )
        configure(store, loader: { _ in [outgoing] })

        await store.loadMessageRequests(.incoming)

        XCTAssertTrue(store.messageRequests(.incoming).isEmpty)
        guard case .failed = store.messageRequestListState(.incoming) else {
            return XCTFail("A mixed-direction server page must be rejected")
        }
    }

    func testLatestExactLookupWinsWhenEarlierResponseArrivesLast() async throws {
        let store = makeStore()
        let slow = participant(id: peerID, name: "Медленный", username: "slow_user")
        let fast = participant(id: secondPeerID, name: "Быстрый", username: "fast_user")
        configure(store, exactLookup: { username in
            if username == "slow_user" {
                try await Task.sleep(for: .milliseconds(180))
                return slow
            }
            try await Task.sleep(for: .milliseconds(10))
            return fast
        })

        store.lookupMessageRequestRecipient("@slow_user")
        try await Task.sleep(for: .milliseconds(20))
        store.lookupMessageRequestRecipient("@fast_user")
        try await waitUntil {
            store.messageRequestLookupState == .loaded
                && store.messageRequestLookupResult?.id == fast.id
        }
        try await Task.sleep(for: .milliseconds(220))

        XCTAssertEqual(store.messageRequestLookupResult?.id, fast.id)
        XCTAssertEqual(store.messageRequestLookupState, .loaded)
    }

    func testCreateRetryReusesNonceAndPublishesOnlyServerConfirmedOutboxItem() async throws {
        let store = makeStore()
        let probe = MessageRequestCreateProbe()
        let recipient = participant(id: peerID, name: "Егор", username: "egor")
        configure(
            store,
            exactLookup: { _ in recipient },
            creator: { recipientID, body, nonce in
                try await probe.create(recipientID: recipientID, body: body, nonce: nonce)
            }
        )

        store.lookupMessageRequestRecipient("@egor")
        try await waitUntil { store.messageRequestLookupState == .loaded }
        XCTAssertEqual(store.messageRequestLookupResult?.id, peerID)

        store.createMessageRequest(to: peerID, body: "Здравствуйте")
        try await waitUntil {
            if case .failed = store.messageRequestCreationState { true } else { false }
        }
        XCTAssertTrue(store.messageRequests(.outgoing).isEmpty)

        store.retryMessageRequestCreation()
        try await waitUntil { store.messageRequestCreationState == .loaded }

        XCTAssertEqual(store.messageRequests(.outgoing).map(\.id), [requestID])
        let nonces = await probe.nonces
        XCTAssertEqual(nonces.count, 2)
        XCTAssertEqual(nonces.first, nonces.last)
    }

    func testAcceptFailureKeepsRequestAndRetryCreatesConfirmedDirect() async throws {
        let store = makeStore()
        let request = incomingRequest()
        let acceptedConversation = conversation(id: chatID, participant: request.participant)
        let probe = MessageRequestAcceptProbe(
            result: MessageRequestAcceptResult(
                request: MessageRequestItem(
                    id: request.id,
                    direction: .incoming,
                    state: .accepted,
                    body: request.body,
                    participant: request.participant,
                    createdAt: request.createdAt,
                    expiresAt: request.expiresAt
                ),
                conversation: acceptedConversation,
                firstMessage: acceptedFirstMessage(for: request, conversationID: acceptedConversation.id)
            )
        )
        configure(store, accepter: { id in try await probe.accept(id) })
        store.applyRealtimeMessageRequestCreated(request)

        store.acceptMessageRequest(request.id)
        try await waitUntil {
            if case .failed = store.messageRequestMutationState(request.id) { true } else { false }
        }
        XCTAssertEqual(store.messageRequests(.incoming).map(\.id), [request.id])
        XCTAssertFalse(store.conversations.contains(where: { $0.id == chatID }))

        store.retryMessageRequestMutation(request.id)
        try await waitUntil { store.messageRequestMutationState(request.id) == .loaded }

        XCTAssertTrue(store.messageRequests(.incoming).isEmpty)
        XCTAssertTrue(store.conversations.contains(where: { $0.id == chatID }))
        XCTAssertEqual(store.messagesByConversation[chatID]?.map(\.text), [request.body])
        XCTAssertEqual(store.messagesByConversation[chatID]?.first?.author.id, request.participant.id)
        XCTAssertEqual(store.messageState(for: chatID), .loaded)
        XCTAssertEqual(store.consumeAcceptedMessageRequestConversation(), chatID)
        XCTAssertNil(store.consumeAcceptedMessageRequestConversation())
    }

    func testInconsistentAcceptanceNeverRemovesInboxRequestOrOpensWrongChat() async throws {
        let store = makeStore()
        let request = incomingRequest()
        let wrongConversation = conversation(id: chatID, participant: request.participant)
        let firstMessage = acceptedFirstMessage(
            for: request,
            conversationID: wrongConversation.id
        )
        configure(
            store,
            accepter: { _ in
                MessageRequestAcceptResult(
                    request: MessageRequestItem(
                        id: UUID(uuidString: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")!,
                        direction: .incoming,
                        state: .accepted,
                        body: request.body,
                        participant: request.participant,
                        createdAt: request.createdAt,
                        expiresAt: request.expiresAt
                    ),
                    conversation: wrongConversation,
                    firstMessage: firstMessage
                )
            }
        )
        store.applyRealtimeMessageRequestCreated(request)

        store.acceptMessageRequest(request.id)
        try await waitUntil {
            if case .failed = store.messageRequestMutationState(request.id) { true } else { false }
        }

        XCTAssertEqual(store.messageRequests(.incoming), [request])
        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertNil(store.consumeAcceptedMessageRequestConversation())
    }

    func testAcceptanceRejectsFirstMessageThatDoesNotMatchAtomicServerReceipt() async throws {
        let store = makeStore()
        let request = incomingRequest()
        let acceptedConversation = conversation(id: chatID, participant: request.participant)
        var mutableMismatchedMessage = acceptedFirstMessage(
            for: request,
            conversationID: acceptedConversation.id
        )
        mutableMismatchedMessage.message.text = "Другой текст"
        let mismatchedMessage = mutableMismatchedMessage
        configure(
            store,
            accepter: { _ in
                MessageRequestAcceptResult(
                    request: MessageRequestItem(
                        id: request.id,
                        direction: .incoming,
                        state: .accepted,
                        body: request.body,
                        participant: request.participant,
                        createdAt: request.createdAt,
                        expiresAt: request.expiresAt
                    ),
                    conversation: acceptedConversation,
                    firstMessage: mismatchedMessage
                )
            }
        )
        store.applyRealtimeMessageRequestCreated(request)

        store.acceptMessageRequest(request.id)
        try await waitUntil {
            if case .failed = store.messageRequestMutationState(request.id) { true } else { false }
        }

        XCTAssertEqual(store.messageRequests(.incoming), [request])
        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertNil(store.messagesByConversation[chatID])
        XCTAssertNil(store.consumeAcceptedMessageRequestConversation())
    }

    func testDismissIsRecipientPrivateAndNeverRemovesBefore204Confirmation() async throws {
        let store = makeStore()
        let request = incomingRequest()
        let probe = MessageRequestDismissProbe()
        configure(store, dismisser: { id in try await probe.dismiss(id) })
        store.applyRealtimeMessageRequestCreated(request)

        store.dismissMessageRequest(request.id)
        try await waitUntil {
            if case .failed = store.messageRequestMutationState(request.id) { true } else { false }
        }
        XCTAssertEqual(store.messageRequests(.incoming).map(\.id), [request.id])

        store.retryMessageRequestMutation(request.id)
        try await waitUntil { store.messageRequestMutationState(request.id) == .loaded }

        XCTAssertTrue(store.messageRequests(.incoming).isEmpty)
        let dismissedIDs = await probe.ids
        XCTAssertEqual(dismissedIDs, [request.id, request.id])
    }

    func testPrivacyUpdateNeverLiesOptimisticallyAndRetriesExactChoice() async throws {
        let store = makeStore()
        let initial = PrivacySettingsSnapshot(
            usernameDiscoverable: true,
            messageRequests: .everyone
        )
        let probe = PrivacySettingsUpdateProbe()
        configure(
            store,
            privacyLoader: { initial },
            privacyUpdater: { discoverable, requests, lastSeen, profilePhoto, forwards, voiceMessages, calls in
                try await probe.update(
                    discoverable: discoverable,
                    requests: requests,
                    lastSeen: lastSeen,
                    profilePhoto: profilePhoto,
                    forwards: forwards,
                    voiceMessages: voiceMessages,
                    calls: calls
                )
            }
        )
        await store.loadPrivacySettings()
        XCTAssertEqual(store.privacySettings, initial)

        store.updatePrivacySettings(usernameDiscoverable: false, messageRequests: .nobody)
        XCTAssertEqual(store.privacySettings, initial)
        try await waitUntil {
            if case .failed = store.privacySettingsState { true } else { false }
        }
        XCTAssertEqual(store.privacySettings, initial)

        store.retryPrivacySettingsUpdate()
        try await waitUntil { store.privacySettingsState == .loaded && store.privacySettings != initial }

        XCTAssertEqual(
            store.privacySettings,
            PrivacySettingsSnapshot(usernameDiscoverable: false, messageRequests: .nobody)
        )
        let calls = await probe.calls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].0, calls[1].0)
        XCTAssertEqual(calls[0].1, calls[1].1)
    }

    func testPrivacyUpdateRejectsServerResponseThatDoesNotConfirmChoice() async throws {
        let store = makeStore()
        let initial = PrivacySettingsSnapshot(
            usernameDiscoverable: true,
            messageRequests: .everyone
        )
        configure(
            store,
            privacyLoader: { initial },
            privacyUpdater: { _, _, _, _, _, _, _ in initial }
        )
        await store.loadPrivacySettings()

        store.updatePrivacySettings(usernameDiscoverable: false, messageRequests: .nobody)
        try await waitUntil {
            if case .failed = store.privacySettingsState { true } else { false }
        }

        XCTAssertEqual(store.privacySettings, initial)
    }

    func testCancellationResetsInFlightRequestMutationWithoutRemovingRequest() async throws {
        let store = makeStore()
        let request = incomingRequest()
        configure(store, accepter: { _ in
            try await Task.sleep(for: .seconds(30))
            throw MessageRequestStoreTestError.rejected
        })
        store.applyRealtimeMessageRequestCreated(request)

        store.acceptMessageRequest(request.id)
        try await waitUntil { store.messageRequestMutationState(request.id) == .loading }
        store.cancelRemoteOperations()

        XCTAssertEqual(store.messageRequestMutationState(request.id), .idle)
        XCTAssertEqual(store.messageRequests(.incoming).map(\.id), [request.id])
    }

    private func configure(
        _ store: MessengerStore,
        loader: (@Sendable (MessageRequestDirection) async throws -> [MessageRequestItem])? = nil,
        exactLookup: (@Sendable (String) async throws -> Participant?)? = nil,
        creator: (@Sendable (UUID, String, UUID) async throws -> MessageRequestItem)? = nil,
        accepter: (@Sendable (UUID) async throws -> MessageRequestAcceptResult)? = nil,
        dismisser: (@Sendable (UUID) async throws -> Void)? = nil,
        privacyLoader: (@Sendable () async throws -> PrivacySettingsSnapshot)? = nil,
        privacyUpdater: (@Sendable (Bool?, MessageRequestPolicy?, PrivacyVisibility?, PrivacyVisibility?, PrivacyVisibility?, PrivacyVisibility?, PrivacyVisibility?) async throws -> PrivacySettingsSnapshot)? = nil
    ) {
        let currentUser = store.currentUser
        store.configureRemote(
            sender: { conversationID, nonce, body in
                ChatMessage(
                    id: nonce,
                    clientID: nonce,
                    conversationID: conversationID,
                    author: currentUser,
                    text: body,
                    sentAt: .now,
                    delivery: .sent,
                    isOutgoing: true
                )
            },
            loader: { _ in [] },
            messageRequestLoader: loader,
            exactUserLookup: exactLookup,
            messageRequestCreator: creator,
            messageRequestAccepter: accepter,
            messageRequestDismisser: dismisser,
            privacySettingsLoader: privacyLoader,
            privacySettingsUpdater: privacyUpdater
        )
    }

    private func makeStore() -> MessengerStore {
        MessengerStore(
            conversations: [],
            messagesByConversation: [:],
            currentUser: participant(
                id: currentUserID,
                name: "Flenym",
                username: "flenyм"
            )
        )
    }

    private func incomingRequest() -> MessageRequestItem {
        MessageRequestItem(
            id: requestID,
            direction: .incoming,
            state: .pending,
            body: "Здравствуйте",
            participant: participant(id: peerID, name: "Егор", username: "egor"),
            createdAt: Date(timeIntervalSince1970: 1_800_000_000),
            expiresAt: Date(timeIntervalSince1970: 1_802_592_000)
        )
    }

    private func conversation(id: UUID, participant: Participant) -> Conversation {
        Conversation(
            id: id,
            title: participant.displayName,
            subtitle: "Здравствуйте",
            kind: .direct,
            avatar: participant,
            memberCount: 2,
            unreadCount: 1,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: Date(timeIntervalSince1970: 1_800_000_010),
            folder: "personal",
            serverRole: "member"
        )
    }

    private func acceptedFirstMessage(
        for request: MessageRequestItem,
        conversationID: UUID
    ) -> RemoteMessageSnapshot {
        RemoteMessageSnapshot(
            message: ChatMessage(
                id: UUID(uuidString: "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0")!,
                clientID: request.id,
                conversationID: conversationID,
                author: request.participant,
                text: request.body,
                sentAt: request.createdAt,
                delivery: .sent,
                isOutgoing: false
            ),
            metadata: MessageRemoteMetadata(revision: 0)
        )
    }

    private func participant(id: UUID, name: String, username: String) -> Participant {
        Participant(
            id: id,
            displayName: name,
            username: username,
            initials: String(name.prefix(2)).uppercased(),
            accentHex: "5C3FB7",
            isOnline: false,
            status: "@\(username)"
        )
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        condition: @escaping @MainActor () -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition() {
            if clock.now >= deadline { throw MessageRequestStoreTestError.timeout }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private let currentUserID = UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!
    private let peerID = UUID(uuidString: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!
    private let secondPeerID = UUID(uuidString: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc")!
    private let requestID = UUID(uuidString: "cccccccc-cccc-4ccc-8ccc-cccccccccccc")!
    private let chatID = UUID(uuidString: "dddddddd-dddd-4ddd-8ddd-dddddddddddd")!
}

private enum MessageRequestStoreTestError: LocalizedError {
    case rejected
    case timeout

    var errorDescription: String? {
        switch self {
        case .rejected: "Сервер отклонил тестовую операцию."
        case .timeout: "Тест не дождался состояния."
        }
    }
}

private actor MessageRequestCreateProbe {
    private(set) var nonces: [UUID] = []

    func create(recipientID: UUID, body: String, nonce: UUID) throws -> MessageRequestItem {
        nonces.append(nonce)
        if nonces.count == 1 { throw MessageRequestStoreTestError.rejected }
        return MessageRequestItem(
            id: UUID(uuidString: "cccccccc-cccc-4ccc-8ccc-cccccccccccc")!,
            direction: .outgoing,
            state: .pending,
            body: body,
            participant: Participant(
                id: recipientID,
                displayName: "Егор",
                username: "egor",
                initials: "ЕГ",
                accentHex: "5C3FB7",
                isOnline: false,
                status: "@egor"
            ),
            createdAt: .now,
            expiresAt: .now.addingTimeInterval(2_592_000)
        )
    }
}

private actor MessageRequestAcceptProbe {
    private let result: MessageRequestAcceptResult
    private var attempts = 0

    init(result: MessageRequestAcceptResult) { self.result = result }

    func accept(_ id: UUID) throws -> MessageRequestAcceptResult {
        attempts += 1
        if attempts == 1 { throw MessageRequestStoreTestError.rejected }
        return result
    }
}

private actor MessageRequestDismissProbe {
    private(set) var ids: [UUID] = []

    func dismiss(_ id: UUID) throws {
        ids.append(id)
        if ids.count == 1 { throw MessageRequestStoreTestError.rejected }
    }
}

private actor PrivacySettingsUpdateProbe {
    private(set) var calls: [(Bool?, MessageRequestPolicy?)] = []

    func update(
        discoverable: Bool?,
        requests: MessageRequestPolicy?,
        lastSeen: PrivacyVisibility?,
        profilePhoto: PrivacyVisibility?,
        forwards: PrivacyVisibility?,
        voiceMessages: PrivacyVisibility?,
        calls: PrivacyVisibility?
    ) throws -> PrivacySettingsSnapshot {
        self.calls.append((discoverable, requests))
        if self.calls.count == 1 { throw MessageRequestStoreTestError.rejected }
        return PrivacySettingsSnapshot(
            usernameDiscoverable: discoverable ?? true,
            messageRequests: requests ?? .everyone,
            lastSeen: lastSeen ?? .everyone,
            profilePhoto: profilePhoto ?? .everyone,
            forwards: forwards ?? .everyone,
            voiceMessages: voiceMessages ?? .everyone,
            calls: calls ?? .everyone
        )
    }
}
