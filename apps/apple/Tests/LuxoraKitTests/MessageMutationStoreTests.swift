import XCTest
@testable import LuxoraKit
import LuxoraDesignFixtures

@MainActor
final class MessageMutationStoreTests: XCTestCase {
    func testReplySendsTargetIDAndResolvesPreviewOnlyAfterConfiguredSupport() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let target = try XCTUnwrap(store.selectedMessages.first(where: { !$0.isOutgoing }))
        let currentUser = store.currentUser
        let probe = ReplyMutationProbe()
        configure(store, messageSender: { conversationID, nonce, body, replyID in
            await probe.record(nonce: nonce, replyID: replyID)
            return RemoteMessageSnapshot(
                message: ChatMessage(
                    id: UUID(), clientID: nonce, conversationID: conversationID,
                    author: currentUser, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                ),
                metadata: MessageRemoteMetadata(revision: 0, replyToMessageID: replyID)
            )
        })
        store.connectionState = .online
        try await waitUntil {
            store.messageState(for: target.conversationID) == .loaded
        }

        store.beginReply(to: target)
        store.draft = "Точный ответ"
        store.sendDraft()

        try await waitUntil { store.selectedMessages.last?.delivery == .sent }
        let confirmed = try XCTUnwrap(store.selectedMessages.last)
        let capturedReplyID = await probe.replyID
        XCTAssertEqual(capturedReplyID, target.id)
        XCTAssertEqual(store.metadata(for: confirmed.id).replyToMessageID, target.id)
        XCTAssertTrue(confirmed.replyPreview?.contains(target.author.displayName) == true)
        XCTAssertEqual(store.composerMode, .new)
    }

    func testEditFailureKeepsDraftAndRevisionThenRetryAppliesServerSnapshot() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let original = try XCTUnwrap(store.selectedMessages.first(where: \.isOutgoing))
        let currentUser = store.currentUser
        store.applyRealtimeMessageSnapshot(RemoteMessageSnapshot(
            message: original,
            metadata: MessageRemoteMetadata(revision: 7)
        ))
        let probe = EditMutationProbe()
        configure(store, messageEditor: { messageID, body, expectedRevision in
            try await probe.edit(
                original: original,
                messageID: messageID,
                body: body,
                expectedRevision: expectedRevision,
                author: currentUser
            )
        })
        store.connectionState = .online

        store.beginEditing(original)
        store.draft = "Исправленный текст"
        store.sendDraft()
        try await waitUntil { store.messageMutationFailure?.key.kind == .edit }

        XCTAssertEqual(store.selectedMessages.first(where: { $0.id == original.id })?.text, original.text)
        XCTAssertEqual(store.draft, "Исправленный текст")
        guard case let .edit(target) = store.composerMode else {
            return XCTFail("Edit mode must remain available after failure")
        }
        XCTAssertEqual(target.revision, 7)

        store.retryLastMessageMutation()
        try await waitUntil {
            store.selectedMessages.first(where: { $0.id == original.id })?.text == "Исправленный текст"
        }

        let revisions = await probe.revisions
        XCTAssertEqual(revisions, [7, 7])
        XCTAssertEqual(store.metadata(for: original.id).revision, 8)
        XCTAssertEqual(store.composerMode, .new)
    }

    func testDeleteNeverCreatesLocalTombstoneWhenServerRejects() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let original = try XCTUnwrap(store.selectedMessages.first(where: \.isOutgoing))
        configure(store, messageDeleter: { _ in
            try await Task.sleep(for: .milliseconds(40))
            throw MutationTestError.rejected
        })
        store.connectionState = .online

        store.deleteMessage(original.id)
        XCTAssertEqual(store.selectedMessages.first(where: { $0.id == original.id })?.text, original.text)
        XCTAssertFalse(store.metadata(for: original.id).isDeleted)
        try await waitUntil { store.messageMutationFailure?.key.kind == .delete }

        XCTAssertEqual(store.selectedMessages.first(where: { $0.id == original.id })?.text, original.text)
        XCTAssertFalse(store.metadata(for: original.id).isDeleted)
    }

    func testForwardRetryReusesNonceAndInsertsOnlyConfirmedMessage() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let source = try XCTUnwrap(store.selectedMessages.first)
        let target = try XCTUnwrap(store.conversations.first(where: { $0.kind == .saved }))
        let currentUser = store.currentUser
        let beforeCount = store.messagesByConversation[target.id, default: []].count
        let beforeIDs = Set(store.messagesByConversation[target.id, default: []].map(\.id))
        let probe = ForwardMutationProbe()
        configure(store, messageForwarder: { sourceID, targetID, nonce in
            try await probe.forward(
                source: source,
                sourceID: sourceID,
                targetID: targetID,
                nonce: nonce,
                author: currentUser
            )
        })
        store.connectionState = .online

        store.forwardMessage(source.id, to: target.id)
        try await waitUntil { store.messageMutationFailure?.key.kind == .forward }
        XCTAssertEqual(store.messagesByConversation[target.id, default: []].count, beforeCount)

        store.retryLastMessageMutation()
        try await waitUntil {
            store.messagesByConversation[target.id, default: []].count == beforeCount + 1
        }

        let nonces = await probe.nonces
        XCTAssertEqual(nonces.count, 2)
        XCTAssertEqual(nonces[0], nonces[1])
        let confirmed = try XCTUnwrap(
            store.messagesByConversation[target.id]?.first(where: { !beforeIDs.contains($0.id) })
        )
        XCTAssertEqual(confirmed.text, source.text)
        XCTAssertEqual(
            store.metadata(for: confirmed.id).forwardedFrom?.senderDisplayName,
            source.author.displayName
        )
    }

    func testPinFailureDoesNotLieLocallyAndRetryUsesServerConfirmation() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let message = try XCTUnwrap(store.selectedMessages.first)
        let conversationID = try XCTUnwrap(store.selectedConversationID)
        let probe = PinMutationProbe()
        configure(store, messagePinSetter: { chatID, messageID, active in
            try await probe.set(chatID: chatID, messageID: messageID, active: active)
        })
        store.connectionState = .online

        store.togglePin(message.id, in: conversationID)
        try await waitUntil { store.messageMutationFailure?.key.kind == .pin }
        XCTAssertFalse(store.metadata(for: message.id).isPinned)

        store.retryLastMessageMutation()
        try await waitUntil { store.metadata(for: message.id).isPinned }
        let activeValues = await probe.activeValues
        XCTAssertEqual(activeValues, [true, true])
    }

    func testServerRolesGateDeletePinAndChannelForwarding() throws {
        let fixture = LuxoraDesignFixtures.makeStore()
        var conversations = fixture.conversations
        let groupIndex = try XCTUnwrap(conversations.firstIndex(where: { $0.kind == .group }))
        let channelIndex = try XCTUnwrap(conversations.firstIndex(where: { $0.kind == .channel }))
        conversations[groupIndex].serverRole = "admin"
        conversations[channelIndex].serverRole = "member"
        let store = MessengerStore(
            conversations: conversations,
            messagesByConversation: fixture.messagesByConversation,
            currentUser: fixture.currentUser,
            selectedConversationID: conversations[groupIndex].id
        )
        configure(
            store,
            messageDeleter: { snapshotID in throw MutationTestError.rejected },
            messageForwarder: { _, _, _ in throw MutationTestError.rejected },
            messagePinSetter: { _, _, _ in throw MutationTestError.rejected }
        )
        let incomingGroupMessage = try XCTUnwrap(
            store.messagesByConversation[conversations[groupIndex].id]?.first(where: { !$0.isOutgoing })
        )

        XCTAssertTrue(store.canDelete(incomingGroupMessage))
        XCTAssertTrue(store.canPin(incomingGroupMessage, in: conversations[groupIndex]))
        XCTAssertFalse(store.canForward(to: conversations[channelIndex]))

        var adminChannel = conversations[channelIndex]
        adminChannel.serverRole = "owner"
        XCTAssertTrue(store.canForward(to: adminChannel))
    }

    func testCancellationResetsLoadingMutationAndComposerMode() async throws {
        let store = LuxoraDesignFixtures.makeStore()
        let original = try XCTUnwrap(store.selectedMessages.first(where: \.isOutgoing))
        configure(store, messageEditor: { _, _, _ in
            try await Task.sleep(for: .seconds(30))
            throw MutationTestError.rejected
        })
        store.connectionState = .online
        store.beginEditing(original)
        store.draft = "Не должен заблокировать новый сеанс"
        store.sendDraft()
        XCTAssertEqual(store.messageMutationState(messageID: original.id, kind: .edit), .loading)

        store.cancelRemoteOperations()

        XCTAssertEqual(store.messageMutationState(messageID: original.id, kind: .edit), .idle)
        XCTAssertEqual(store.composerMode, .new)
        XCTAssertNil(store.messageMutationFailure)
    }

    func testRealtimeSnapshotAndPinEventsRehydrateAllInteractionMetadata() throws {
        let store = LuxoraDesignFixtures.makeStore()
        let original = try XCTUnwrap(store.selectedMessages.first)
        let snapshot = RemoteMessageSnapshot(
            message: original,
            metadata: MessageRemoteMetadata(
                revision: 3,
                replyToMessageID: store.selectedMessages.dropFirst().first?.id,
                forwardedFrom: MessageForwardProvenance(
                    senderDisplayName: "Mira",
                    originalCreatedAt: .now
                ),
                isPinned: false,
                isDeleted: false
            )
        )

        store.applyRealtimeMessageSnapshot(snapshot)
        store.applyRealtimePin(chatID: original.conversationID, messageID: original.id, active: true)

        let metadata = store.metadata(for: original.id)
        XCTAssertEqual(metadata.revision, 3)
        XCTAssertNotNil(metadata.replyToMessageID)
        XCTAssertEqual(metadata.forwardedFrom?.senderDisplayName, "Mira")
        XCTAssertTrue(metadata.isPinned)
    }

    func testRealtimeTombstoneClearsAndRejectsReactionState() throws {
        let store = LuxoraDesignFixtures.makeStore()
        let original = try XCTUnwrap(store.selectedMessages.first(where: { !$0.reactions.isEmpty }))
        var tombstone = original
        tombstone.text = "Сообщение удалено"

        store.applyRealtimeMessageSnapshot(RemoteMessageSnapshot(
            message: tombstone,
            metadata: MessageRemoteMetadata(revision: 2, isDeleted: true)
        ))
        store.toggleReaction("🔥", messageID: original.id)

        XCTAssertTrue(
            try XCTUnwrap(store.selectedMessages.first(where: { $0.id == original.id })).reactions.isEmpty
        )
        XCTAssertTrue(store.metadata(for: original.id).isDeleted)
    }

    private func configure(
        _ store: MessengerStore,
        messageSender: (@Sendable (UUID, UUID, String, UUID?) async throws -> RemoteMessageSnapshot)? = nil,
        messageEditor: (@Sendable (UUID, String, Int?) async throws -> RemoteMessageSnapshot)? = nil,
        messageDeleter: (@Sendable (UUID) async throws -> RemoteMessageSnapshot)? = nil,
        messageForwarder: (@Sendable (UUID, UUID, UUID) async throws -> RemoteMessageSnapshot)? = nil,
        messagePinSetter: (@Sendable (UUID, UUID, Bool) async throws -> Bool)? = nil
    ) {
        let currentUser = store.currentUser
        let initialMessages = store.messagesByConversation
        store.configureRemote(
            sender: { conversationID, nonce, body in
                ChatMessage(
                    id: UUID(), clientID: nonce, conversationID: conversationID,
                    author: currentUser, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                )
            },
            loader: { conversationID in initialMessages[conversationID, default: []] },
            messageSender: messageSender,
            messageEditor: messageEditor,
            messageDeleter: messageDeleter,
            messageForwarder: messageForwarder,
            messagePinSetter: messagePinSetter
        )
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
        XCTFail("Timed out waiting for a message mutation")
    }
}

private enum MutationTestError: LocalizedError {
    case rejected
    var errorDescription: String? { "Сервер отклонил тестовое действие" }
}

private actor ReplyMutationProbe {
    private(set) var nonce: UUID?
    private(set) var replyID: UUID?

    func record(nonce: UUID, replyID: UUID?) {
        self.nonce = nonce
        self.replyID = replyID
    }
}

private actor EditMutationProbe {
    private(set) var revisions: [Int?] = []

    func edit(
        original: ChatMessage,
        messageID: UUID,
        body: String,
        expectedRevision: Int?,
        author: Participant
    ) throws -> RemoteMessageSnapshot {
        revisions.append(expectedRevision)
        if revisions.count == 1 { throw MutationTestError.rejected }
        return RemoteMessageSnapshot(
            message: ChatMessage(
                id: messageID, clientID: original.clientID,
                conversationID: original.conversationID, author: author,
                text: body, sentAt: original.sentAt, editedAt: .now,
                delivery: .sent, isOutgoing: true
            ),
            metadata: MessageRemoteMetadata(revision: 8)
        )
    }
}

private actor ForwardMutationProbe {
    private(set) var nonces: [UUID] = []

    func forward(
        source: ChatMessage,
        sourceID: UUID,
        targetID: UUID,
        nonce: UUID,
        author: Participant
    ) throws -> RemoteMessageSnapshot {
        precondition(source.id == sourceID)
        nonces.append(nonce)
        if nonces.count == 1 { throw MutationTestError.rejected }
        return RemoteMessageSnapshot(
            message: ChatMessage(
                id: UUID(), clientID: nonce, conversationID: targetID,
                author: author, text: source.text, sentAt: .now,
                delivery: .sent, isOutgoing: true
            ),
            metadata: MessageRemoteMetadata(
                revision: 0,
                forwardedFrom: MessageForwardProvenance(
                    senderDisplayName: source.author.displayName,
                    originalCreatedAt: source.sentAt
                )
            )
        )
    }
}

private actor PinMutationProbe {
    private(set) var activeValues: [Bool] = []

    func set(chatID: UUID, messageID: UUID, active: Bool) throws -> Bool {
        _ = chatID
        _ = messageID
        activeValues.append(active)
        if activeValues.count == 1 { throw MutationTestError.rejected }
        return active
    }
}
