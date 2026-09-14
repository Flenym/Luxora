import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class MessengerSynchronizedDraftIntegrationTests: XCTestCase {
    private let accountID = UUID(uuidString: "B650E2AB-4185-493D-81A2-BD4F19B84F0C")!
    private let sessionID = UUID(uuidString: "D650E2AB-4185-493D-81A2-BD4F19B84F0E")!
    private let chatA = UUID(uuidString: "9EC9347C-9306-4108-AAB4-E7762B73B201")!
    private let chatB = UUID(uuidString: "AEC9347C-9306-4108-AAB4-E7762B73B202")!
    private let messageID = UUID(uuidString: "A0DF9334-2EC0-422D-B5DE-11C775A42344")!

    func testLegacyCapabilityOffStillKeepsIndependentTextAndReplyForChatAAndB() {
        let target = message(id: messageID, chatID: chatA, outgoing: false)
        let messenger = makeMessenger(messages: [chatA: [target], chatB: []])
        XCTAssertFalse(messenger.synchronizedDraftsEnabled)

        messenger.draft = "draft A"
        messenger.composerMode = .reply(composerTarget(target))
        messenger.selectConversation(chatB)
        messenger.draft = "draft B"
        messenger.selectConversation(chatA)

        XCTAssertEqual(messenger.draft, "draft A")
        guard case let .reply(restored) = messenger.composerMode else {
            return XCTFail("Reply context for chat A must be restored")
        }
        XCTAssertEqual(restored.id, messageID)
        messenger.selectConversation(chatB)
        XCTAssertEqual(messenger.draft, "draft B")
        XCTAssertEqual(messenger.composerMode, .new)
    }

    func testEditTextNeverBecomesSynchronizedDraft() async throws {
        let outgoing = message(id: messageID, chatID: chatA, outgoing: true)
        let messenger = makeMessenger(messages: [chatA: [outgoing], chatB: []])
        let putter = MessengerDraftPutter()
        let drafts = makeDraftStore(
            loader: { [chatA] _ in Self.state(chatID: chatA, text: nil, revision: 0) },
            putter: { chatID, command in await putter.put(chatID: chatID, command: command) }
        )
        messenger.configureSynchronizedDrafts(drafts)
        await messenger.loadSynchronizedDraft(for: chatA)

        messenger.draft = "real draft"
        try await Task.sleep(nanoseconds: 500_000_000)
        messenger.beginEditing(outgoing)
        messenger.draft = "EDIT MODE MUST NOT SYNC"
        try await Task.sleep(nanoseconds: 500_000_000)

        let commands = await putter.commands
        XCTAssertEqual(commands.map(\.content.text), ["real draft"])
        XCTAssertEqual(drafts.localDraft(for: chatA).text, "real draft")
        messenger.cancelComposerMode()
        XCTAssertEqual(messenger.draft, "real draft")
    }

    func testSendClearsComposerAndDeletesConfirmedServerDraft() async throws {
        let messenger = makeMessenger(messages: [chatA: [], chatB: []])
        let deleter = MessengerDraftDeleter()
        let drafts = makeDraftStore(
            loader: { [chatA] _ in Self.state(chatID: chatA, text: "send me", revision: 3) },
            deleter: { chatID, command in await deleter.delete(chatID: chatID, command: command) }
        )
        messenger.configureSynchronizedDrafts(drafts)
        await messenger.loadSynchronizedDraft(for: chatA)
        XCTAssertEqual(messenger.draft, "send me")

        messenger.sendDraft()
        try await Task.sleep(nanoseconds: 550_000_000)

        let commands = await deleter.commands
        XCTAssertEqual(commands.count, 1)
        guard commands.count == 1 else { return }
        XCTAssertEqual(commands[0].expectedRevision, 3)
        XCTAssertEqual(messenger.draft, "")
        XCTAssertEqual(messenger.composerMode, .new)
        XCTAssertNil(drafts.confirmedState(for: chatA)?.draft)
        XCTAssertEqual(drafts.confirmedState(for: chatA)?.revision, 4)
    }

    func testMissingReplyTargetPreservesTextAndCorrectsRelationship() async throws {
        let missingID = UUID(uuidString: "F0DF9334-2EC0-422D-B5DE-11C775A42345")!
        let messenger = makeMessenger(messages: [chatA: [], chatB: []])
        let sender = RecordingMessengerSnapshotSender(author: Self.participant)
        messenger.configureRemote(
            sender: { _, _, _ in throw LuxoraAPIError.invalidResponse },
            loader: { _ in [] },
            messageSender: { chatID, clientID, body, replyID, _ in
                await sender.send(
                    chatID: chatID,
                    clientID: clientID,
                    body: body,
                    replyID: replyID
                )
            }
        )
        let putter = MessengerDraftPutter()
        let drafts = makeDraftStore(
            loader: { [chatA] _ in
                Self.state(
                    chatID: chatA,
                    text: "text survives",
                    replyID: missingID,
                    revision: 1
                )
            },
            putter: { chatID, command in await putter.put(chatID: chatID, command: command) }
        )
        messenger.configureSynchronizedDrafts(drafts)

        await messenger.loadSynchronizedDraft(for: chatA)

        // The server-side correction persist is debounced (400 ms); poll
        // instead of a fixed sleep so loaded CI runners cannot flake or
        // crash the runner on an empty subscript.
        let putDeadline = Date().addingTimeInterval(5)
        var commands: [ChatDraftPutCommand] = []
        repeat {
            try await Task.sleep(nanoseconds: 50_000_000)
            commands = await putter.commands
        } while commands.isEmpty && Date() < putDeadline

        XCTAssertEqual(messenger.draft, "text survives")
        XCTAssertEqual(messenger.composerMode, .new)
        XCTAssertNil(drafts.localDraft(for: chatA).replyToMessageID)
        XCTAssertEqual(commands.count, 1)
        guard commands.count == 1 else { return }
        XCTAssertEqual(commands[0].content.text, "text survives")
        XCTAssertNil(commands[0].content.replyToMessageID)
        XCTAssertEqual(commands[0].expectedRevision, 1)
        XCTAssertTrue(messenger.canSend)
        messenger.sendDraft()
        try await Task.sleep(nanoseconds: 50_000_000)
        let sends = await sender.calls
        XCTAssertEqual(sends.count, 1)
        guard let firstSend = sends.first else { return }
        XCTAssertNil(firstSend.replyID)
    }

    func testConfirmedRemoteDeletionClearsOnlyReplyAndPreservesText() async throws {
        let target = message(id: messageID, chatID: chatA, outgoing: false)
        let messenger = makeMessenger(messages: [chatA: [target], chatB: []])
        let putter = MessengerDraftPutter()
        let drafts = makeDraftStore(
            loader: { [chatA, messageID] _ in
                Self.state(
                    chatID: chatA,
                    text: "keep this text",
                    replyID: messageID,
                    revision: 2
                )
            },
            putter: { chatID, command in await putter.put(chatID: chatID, command: command) }
        )
        messenger.configureSynchronizedDrafts(drafts)
        await messenger.loadSynchronizedDraft(for: chatA)
        guard case .reply = messenger.composerMode else {
            return XCTFail("Expected restored reply before deletion")
        }

        var deleted = target
        deleted.text = "Удалённое сообщение"
        messenger.applyRealtimeMessageSnapshot(
            RemoteMessageSnapshot(
                message: deleted,
                metadata: MessageRemoteMetadata(revision: 1, isDeleted: true)
            )
        )

        let deletionDeadline = Date().addingTimeInterval(5)
        var commands = await putter.commands
        while commands.isEmpty && Date() < deletionDeadline {
            try await Task.sleep(nanoseconds: 50_000_000)
            commands = await putter.commands
        }

        XCTAssertEqual(messenger.draft, "keep this text")
        XCTAssertEqual(messenger.composerMode, .new)
        XCTAssertNil(drafts.localDraft(for: chatA).replyToMessageID)
        XCTAssertEqual(commands.count, 1)
        guard commands.count == 1 else { return }
        XCTAssertEqual(commands[0].content.text, "keep this text")
        XCTAssertNil(commands[0].content.replyToMessageID)
    }

    func testDraftGET404ScrubsActiveComposerMapsAndEditStaging() async {
        let outgoing = message(id: messageID, chatID: chatA, outgoing: true)
        let messenger = makeMessenger(messages: [chatA: [outgoing], chatB: []])
        messenger.draft = "private pre-edit text"
        messenger.beginEditing(outgoing)
        XCTAssertEqual(messenger.draftBeforeEditing, "private pre-edit text")
        let drafts = makeDraftStore(loader: { _ in
            throw LuxoraAPIError.server(
                status: 404,
                code: "NOT_FOUND",
                message: "private server detail"
            )
        })
        messenger.configureSynchronizedDrafts(drafts)

        await messenger.loadSynchronizedDraft(for: chatA)

        XCTAssertEqual(messenger.draft, "")
        XCTAssertEqual(messenger.composerMode, .new)
        XCTAssertNil(messenger.composerDraftsByConversation[chatA])
        XCTAssertNil(messenger.composerModesByConversation[chatA])
        XCTAssertNil(messenger.unresolvedReplyIDsByConversation[chatA])
        XCTAssertEqual(messenger.draftBeforeEditing, "")
        XCTAssertEqual(messenger.composerModeBeforeEditing, .new)
        XCTAssertEqual(drafts.localDraft(for: chatA), .empty)
    }

    func testSelectedMembershipRemovalPurgesDraftAfterSelectionDidSet() {
        let outgoing = message(id: messageID, chatID: chatA, outgoing: true)
        let messenger = makeMessenger(messages: [chatA: [outgoing], chatB: []])
        let drafts = makeDraftStore(loader: { [chatA] _ in
            Self.state(chatID: chatA, text: nil, revision: 0)
        })
        messenger.configureSynchronizedDrafts(drafts)
        messenger.draft = "selected private text"
        messenger.beginEditing(outgoing)

        messenger.applyConfirmedConversationRemoval(chatA)

        XCTAssertEqual(messenger.selectedConversationID, chatB)
        XCTAssertEqual(messenger.draft, "")
        XCTAssertNil(messenger.composerDraftsByConversation[chatA])
        XCTAssertNil(messenger.composerModesByConversation[chatA])
        XCTAssertNil(messenger.unresolvedReplyIDsByConversation[chatA])
        XCTAssertEqual(messenger.draftBeforeEditing, "")
        XCTAssertEqual(messenger.composerModeBeforeEditing, .new)
        XCTAssertEqual(drafts.localDraft(for: chatA), .empty)
        XCTAssertNil(messenger.messagesByConversation[chatA])
    }

    func testAuthoritativeConversationRefreshPurgesSelectedAndOrphanDrafts() async {
        let messenger = makeMessenger(messages: [chatA: [], chatB: []])
        let orphanChatID = UUID(uuidString: "BEC9347C-9306-4108-AAB4-E7762B73B203")!
        let drafts = makeDraftStore(loader: { chatID in
            Self.state(chatID: chatID, text: nil, revision: 0)
        })
        messenger.configureSynchronizedDrafts(drafts)
        messenger.draft = "selected secret"
        messenger.composerDraftsByConversation[orphanChatID] = "orphan secret"
        _ = drafts.setLocalDraft(for: orphanChatID, text: "orphan secret")
        let retained = messenger.conversations.first { $0.id == chatB }!
        messenger.configureRemote(
            sender: { _, _, _ in throw LuxoraAPIError.invalidResponse },
            loader: { _ in [] },
            conversationsLoader: { [retained] in [retained] }
        )

        await messenger.refreshConversations()

        XCTAssertEqual(messenger.selectedConversationID, chatB)
        XCTAssertEqual(messenger.draft, "")
        XCTAssertNil(messenger.composerDraftsByConversation[chatA])
        XCTAssertNil(messenger.composerDraftsByConversation[orphanChatID])
        XCTAssertEqual(drafts.localDraft(for: chatA), .empty)
        XCTAssertEqual(drafts.localDraft(for: orphanChatID), .empty)
    }

    func testUnresolvedServerReplySurvivesTypingUntilMessageHistoryResolves() async throws {
        let target = message(id: messageID, chatID: chatB, outgoing: false)
        let secondChatID = chatB
        let messageLoader = SuspendedMessengerSnapshotLoader(
            snapshots: [RemoteMessageSnapshot(message: target)]
        )
        let sender = RecordingMessengerSnapshotSender(author: Self.participant)
        let messenger = makeMessenger(
            messages: [chatA: [], chatB: []],
            loadedConversationIDs: [chatA]
        )
        messenger.configureRemote(
            sender: { _, _, _ in throw LuxoraAPIError.invalidResponse },
            loader: { _ in [] },
            messageSender: { chatID, clientID, body, replyID, _ in
                await sender.send(
                    chatID: chatID,
                    clientID: clientID,
                    body: body,
                    replyID: replyID
                )
            },
            messageSnapshotLoader: { chatID in
                guard chatID == secondChatID else { return [] }
                return await messageLoader.load()
            }
        )
        let putter = MessengerDraftPutter()
        let drafts = makeDraftStore(
            loader: { [chatB, messageID] _ in
                Self.state(
                    chatID: chatB,
                    text: "server reply text",
                    replyID: messageID,
                    revision: 1
                )
            },
            putter: { chatID, command in await putter.put(chatID: chatID, command: command) }
        )
        messenger.configureSynchronizedDrafts(drafts)
        await messenger.loadSynchronizedDraft(for: chatB)
        XCTAssertEqual(messenger.unresolvedReplyIDsByConversation[chatB], messageID)

        messenger.selectedConversationID = chatB
        let historyLoad = Task { await messenger.loadMessages(for: chatB) }
        await messageLoader.waitUntilStarted()
        messenger.draft = "typed before history"
        let typingDeadline = Date().addingTimeInterval(5)
        var commandsBeforeHistory = await putter.commands
        while commandsBeforeHistory.last?.content.text != "typed before history",
              Date() < typingDeadline {
            try await Task.sleep(nanoseconds: 50_000_000)
            commandsBeforeHistory = await putter.commands
        }
        XCTAssertEqual(commandsBeforeHistory.last?.content.text, "typed before history")
        XCTAssertEqual(commandsBeforeHistory.last?.content.replyToMessageID, messageID)
        XCTAssertFalse(messenger.canSend)
        messenger.sendDraft()
        let prematureSendCount = await sender.callCount()
        XCTAssertEqual(prematureSendCount, 0)
        XCTAssertEqual(messenger.draft, "typed before history")

        await messageLoader.release()
        await historyLoad.value

        guard case let .reply(resolved) = messenger.composerMode else {
            return XCTFail("Reply must become visible after authoritative history arrives")
        }
        XCTAssertEqual(resolved.id, messageID)
        XCTAssertNil(messenger.unresolvedReplyIDsByConversation[chatB])
        XCTAssertTrue(messenger.canSend)
        messenger.sendDraft()
        try await Task.sleep(nanoseconds: 50_000_000)
        let sendCalls = await sender.calls
        XCTAssertEqual(sendCalls.count, 1)
        XCTAssertEqual(sendCalls[0].replyID, messageID)
    }

    func testLateSynchronizedProjectionDoesNotOverwriteActiveEditBody() async {
        let outgoing = message(id: messageID, chatID: chatA, outgoing: true)
        let suspended = SuspendedMessengerDraftLoader(
            result: Self.state(chatID: chatA, text: "new synced draft", revision: 2)
        )
        let messenger = makeMessenger(messages: [chatA: [outgoing], chatB: []])
        let drafts = makeDraftStore(loader: { _ in await suspended.load() })
        messenger.configureSynchronizedDrafts(drafts)
        let loading = Task { await messenger.loadSynchronizedDraft(for: chatA) }
        await suspended.waitUntilStarted()

        messenger.beginEditing(outgoing)
        messenger.draft = "active edit body"
        await suspended.release()
        await loading.value

        XCTAssertEqual(messenger.draft, "active edit body")
        guard case let .edit(target) = messenger.composerMode else {
            return XCTFail("Late draft projection must keep edit mode")
        }
        XCTAssertEqual(target.id, messageID)
        XCTAssertEqual(messenger.draftBeforeEditing, "new synced draft")
        messenger.cancelComposerMode()
        XCTAssertEqual(messenger.draft, "new synced draft")
        XCTAssertEqual(messenger.composerMode, .new)
    }

    func testGapCleanInvalidationPreservesEditAndFreshGETUpdatesCancelStaging() async {
        let outgoing = message(id: messageID, chatID: chatA, outgoing: true)
        let loader = MessengerMutableDraftLoader(
            state: Self.state(chatID: chatA, text: "old synchronized", revision: 1)
        )
        let messenger = makeMessenger(messages: [chatA: [outgoing], chatB: []])
        let drafts = makeDraftStore(loader: { _ in await loader.load() })
        messenger.configureSynchronizedDrafts(drafts)
        await messenger.loadSynchronizedDraft(for: chatA)
        XCTAssertEqual(messenger.draft, "old synchronized")
        messenger.beginEditing(outgoing)
        messenger.draft = "active edit survives gap"
        await loader.replace(
            Self.state(chatID: chatA, text: "fresh after gap", revision: 2)
        )

        let plan = drafts.prepareForRecovery(retainedChatIDs: [chatA, chatB])
        messenger.applySynchronizedDraftRecoveryInvalidation(plan)

        XCTAssertEqual(messenger.draft, "active edit survives gap")
        guard case .edit = messenger.composerMode else {
            return XCTFail("Clean invalidation must not exit edit mode")
        }
        XCTAssertEqual(messenger.draftBeforeEditing, "")
        await messenger.loadSynchronizedDraft(for: chatA, force: true)
        XCTAssertEqual(messenger.draft, "active edit survives gap")
        XCTAssertEqual(messenger.draftBeforeEditing, "fresh after gap")
        messenger.cancelComposerMode()
        XCTAssertEqual(messenger.draft, "fresh after gap")
        XCTAssertEqual(messenger.composerMode, .new)
    }

    func testUnderlyingUnresolvedReplyDoesNotBlockEditingExistingMessage() async throws {
        let outgoing = message(id: messageID, chatID: chatA, outgoing: true)
        let unresolvedID = UUID(uuidString: "CFDF9334-2EC0-422D-B5DE-11C775A42347")!
        let messenger = makeMessenger(messages: [chatA: [outgoing], chatB: []])
        let drafts = makeDraftStore(loader: { [chatA] _ in
            Self.state(chatID: chatA, text: nil, revision: 0)
        })
        messenger.configureSynchronizedDrafts(drafts)
        await messenger.loadSynchronizedDraft(for: chatA)
        messenger.draft = "underlying reply draft"
        drafts.cancelScheduledPersist(for: chatA)
        XCTAssertTrue(
            drafts.setLocalDraft(
                for: chatA,
                text: "underlying reply draft",
                replyToMessageID: unresolvedID
            )
        )
        messenger.unresolvedReplyIDsByConversation[chatA] = unresolvedID
        XCTAssertEqual(messenger.unresolvedReplyIDsByConversation[chatA], unresolvedID)
        XCTAssertFalse(messenger.canSend)

        messenger.beginEditing(outgoing)
        messenger.draft = "edited safely"
        XCTAssertTrue(messenger.canSend)
        messenger.sendDraft()
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(
            messenger.messagesByConversation[chatA]?.first(where: { $0.id == messageID })?.text,
            "edited safely"
        )
        XCTAssertEqual(messenger.draft, "underlying reply draft")
        XCTAssertEqual(drafts.localDraft(for: chatA).replyToMessageID, unresolvedID)
    }

    func testLateEditResponseCannotReanimateRemovedConversation() async throws {
        let outgoing = message(id: messageID, chatID: chatA, outgoing: true)
        let editor = SuspendedMessengerEditor(chatID: chatA, author: Self.participant)
        let messenger = makeMessenger(messages: [chatA: [outgoing], chatB: []])
        messenger.configureRemote(
            sender: { _, _, _ in throw LuxoraAPIError.invalidResponse },
            loader: { _ in [] },
            messageEditor: { messageID, body, revision in
                await editor.edit(messageID: messageID, body: body, revision: revision)
            }
        )
        messenger.draft = "private before edit"
        messenger.beginEditing(outgoing)
        messenger.draft = "late edited body"
        messenger.sendDraft()
        await editor.waitUntilStarted()

        messenger.applyConfirmedConversationRemoval(chatA)
        await editor.release()
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(messenger.conversations.contains(where: { $0.id == chatA }))
        XCTAssertNil(messenger.messagesByConversation[chatA])
        XCTAssertNil(messenger.composerDraftsByConversation[chatA])
        XCTAssertEqual(messenger.draftBeforeEditing, "")
        XCTAssertEqual(messenger.composerModeBeforeEditing, .new)
    }

    private func makeMessenger(
        messages: [UUID: [ChatMessage]],
        loadedConversationIDs: Set<UUID>? = nil
    ) -> MessengerStore {
        let participant = Self.participant
        let primaryChatID = chatA
        let conversations = [chatA, chatB].map { chatID in
            Conversation(
                id: chatID,
                title: chatID == chatA ? "A" : "B",
                subtitle: "",
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
        }
        let store = MessengerStore(
            conversations: conversations,
            messagesByConversation: messages,
            currentUser: participant,
            selectedConversationID: chatA,
            loadedConversationIDs: loadedConversationIDs ?? Set([chatA, chatB])
        )
        store.configureRemote(
            sender: { conversationID, clientID, body in
                ChatMessage(
                    id: clientID,
                    clientID: clientID,
                    conversationID: conversationID,
                    author: participant,
                    text: body,
                    sentAt: .now,
                    delivery: .sent,
                    isOutgoing: true
                )
            },
            loader: { chatID in messages[chatID] ?? [] },
            messageSender: { conversationID, clientID, body, replyID, _ in
                RemoteMessageSnapshot(
                    message: ChatMessage(
                        id: clientID,
                        clientID: clientID,
                        conversationID: conversationID,
                        author: participant,
                        text: body,
                        sentAt: .now,
                        delivery: .sent,
                        isOutgoing: true
                    ),
                    metadata: MessageRemoteMetadata(replyToMessageID: replyID)
                )
            },
            messageEditor: { messageID, body, revision in
                RemoteMessageSnapshot(
                    message: ChatMessage(
                        id: messageID,
                        conversationID: primaryChatID,
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
        store.connectionState = .online
        return store
    }

    private func makeDraftStore(
        loader: @escaping SynchronizedChatDraftStore.Loader,
        putter: @escaping SynchronizedChatDraftStore.Putter = { _, _ in
            throw LuxoraAPIError.invalidResponse
        },
        deleter: @escaping SynchronizedChatDraftStore.Deleter = { _, _ in
            throw LuxoraAPIError.invalidResponse
        }
    ) -> SynchronizedChatDraftStore {
        let store = SynchronizedChatDraftStore()
        store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: loader,
            putter: putter,
            deleter: deleter
        )
        return store
    }

    private func message(id: UUID, chatID: UUID, outgoing: Bool) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationID: chatID,
            author: Self.participant,
            text: "target",
            sentAt: .now,
            delivery: .sent,
            isOutgoing: outgoing
        )
    }

    private func composerTarget(_ message: ChatMessage) -> MessageComposerTarget {
        MessageComposerTarget(
            id: message.id,
            authorName: message.author.displayName,
            preview: message.text,
            revision: 0
        )
    }

    private nonisolated static func state(
        chatID: UUID,
        text: String?,
        replyID: UUID? = nil,
        revision: Int
    ) -> SynchronizedChatDraftState {
        SynchronizedChatDraftState(
            draft: text.map {
                SynchronizedChatDraft(
                    chatID: chatID,
                    content: .init(text: $0, replyToMessageID: replyID),
                    revision: revision,
                    updatedAt: Date(timeIntervalSince1970: TimeInterval(revision + 1))
                )
            },
            revision: revision
        )
    }

    private nonisolated static let participant = Participant(
        id: UUID(uuidString: "C0DF9334-2EC0-422D-B5DE-11C775A42346")!,
        displayName: "Flenym",
        username: "flenym",
        initials: "F",
        accentHex: "2F1893",
        isOnline: true,
        status: "online"
    )
}

private actor MessengerDraftPutter {
    private(set) var commands: [ChatDraftPutCommand] = []

    func put(chatID: UUID, command: ChatDraftPutCommand) -> ChatDraftMutationResult {
        commands.append(command)
        let revision = command.expectedRevision + 1
        return ChatDraftMutationResult(
            state: SynchronizedChatDraftState(
                draft: SynchronizedChatDraft(
                    chatID: chatID,
                    content: command.content,
                    revision: revision,
                    updatedAt: Date(timeIntervalSince1970: TimeInterval(revision + 1))
                ),
                revision: revision
            ),
            replayed: false
        )
    }
}

private actor MessengerDraftDeleter {
    private(set) var commands: [ChatDraftDeleteCommand] = []

    func delete(chatID: UUID, command: ChatDraftDeleteCommand) -> ChatDraftMutationResult {
        commands.append(command)
        return ChatDraftMutationResult(
            state: SynchronizedChatDraftState(
                draft: nil,
                revision: command.expectedRevision + 1
            ),
            replayed: false
        )
    }
}

private actor SuspendedMessengerSnapshotLoader {
    private let snapshots: [RemoteMessageSnapshot]
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(snapshots: [RemoteMessageSnapshot]) { self.snapshots = snapshots }

    func load() async -> [RemoteMessageSnapshot] {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return snapshots
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor SuspendedMessengerDraftLoader {
    private let result: SynchronizedChatDraftState
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(result: SynchronizedChatDraftState) { self.result = result }

    func load() async -> SynchronizedChatDraftState {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return result
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor MessengerMutableDraftLoader {
    private var state: SynchronizedChatDraftState

    init(state: SynchronizedChatDraftState) { self.state = state }

    func load() -> SynchronizedChatDraftState { state }

    func replace(_ state: SynchronizedChatDraftState) {
        self.state = state
    }
}

private actor SuspendedMessengerEditor {
    private let chatID: UUID
    private let author: Participant
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(chatID: UUID, author: Participant) {
        self.chatID = chatID
        self.author = author
    }

    func edit(
        messageID: UUID,
        body: String,
        revision: Int?
    ) async -> RemoteMessageSnapshot {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return RemoteMessageSnapshot(
            message: ChatMessage(
                id: messageID,
                conversationID: chatID,
                author: author,
                text: body,
                sentAt: .now,
                delivery: .sent,
                isOutgoing: true
            ),
            metadata: MessageRemoteMetadata(revision: (revision ?? 0) + 1)
        )
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private struct MessengerSendCall: Sendable {
    let chatID: UUID
    let replyID: UUID?
}

private actor RecordingMessengerSnapshotSender {
    private let author: Participant
    private(set) var calls: [MessengerSendCall] = []

    init(author: Participant) { self.author = author }

    func send(
        chatID: UUID,
        clientID: UUID,
        body: String,
        replyID: UUID?
    ) -> RemoteMessageSnapshot {
        calls.append(MessengerSendCall(chatID: chatID, replyID: replyID))
        return RemoteMessageSnapshot(
            message: ChatMessage(
                id: clientID,
                clientID: clientID,
                conversationID: chatID,
                author: author,
                text: body,
                sentAt: .now,
                delivery: .sent,
                isOutgoing: true
            ),
            metadata: MessageRemoteMetadata(replyToMessageID: replyID)
        )
    }

    func callCount() -> Int { calls.count }
}
