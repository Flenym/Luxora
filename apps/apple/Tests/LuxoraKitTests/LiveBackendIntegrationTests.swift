import Foundation
import XCTest
@testable import LuxoraKit

final class LiveBackendIntegrationTests: XCTestCase {
    func testSynchronizedDraftHTTPAndRealtimeAgainstLiveDocker() async throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_TEST=1 while the local API is running")
        }

        let configuration = LuxoraClientConfiguration.development
        let api = LuxoraAPIClient(configuration: configuration)
        let realtime = LuxoraRealtimeClient(configuration: configuration)
        let suffix = UUID().uuidString
            .replacingOccurrences(of: "-", with: "")
            .prefix(10)
            .lowercased()
        let username = "draft_swift_\(suffix)"
        let password = "LuxoraDrafts!2026"
        let primary = try await api.register(
            username: username,
            displayName: "Swift Draft Primary",
            password: password,
            deviceName: "Swift draft primary"
        )
        let secondary = try await api.login(
            username: username,
            password: password,
            deviceName: "Swift draft secondary"
        )
        defer {
            Task {
                try? await api.revokeCurrentSession(token: primary.tokens.accessToken)
                try? await api.revokeCurrentSession(token: secondary.tokens.accessToken)
            }
        }

        let capabilities = try await api.capabilities()
        XCTAssertTrue(capabilities.features.drafts)
        XCTAssertEqual(
            capabilities.limits.maxDraftCodePoints,
            SynchronizedChatDraft.maximumTextCodePoints
        )
        XCTAssertEqual(capabilities.realtimeProtocolVersion, .scopedV2)

        let chat = try await api.createDirectChat(
            userID: primary.user.id,
            token: primary.tokens.accessToken
        )
        let initial = try await api.chatDraft(
            chatID: chat.id,
            token: primary.tokens.accessToken
        )
        XCTAssertNil(initial.draft)
        XCTAssertEqual(initial.revision, 0)

        let probe = LiveScopedRealtimeProbe()
        let ready = expectation(description: "Draft v2 ready")
        let checkpoint = expectation(description: "Draft v2 checkpoint")
        let changed = expectation(description: "Draft v2 changed")
        let streamTask = Task {
            do {
                for try await signal in realtime.scopedSignals(
                    token: secondary.tokens.accessToken,
                    resumeCursor: nil
                ) {
                    switch signal {
                    case .ready:
                        ready.fulfill()
                    case .checkpoint:
                        checkpoint.fulfill()
                    case let .chatDraft(dispatch):
                        await probe.recordDraft(dispatch)
                        changed.fulfill()
                        return
                    default:
                        break
                    }
                }
            } catch {
                // Expectations remain the deterministic source of failure.
            }
        }
        await fulfillment(of: [ready, checkpoint], timeout: 5)

        let command = ChatDraftPutCommand(
            content: SynchronizedChatDraftContent(text: "Swift draft \(suffix)"),
            expectedRevision: 0,
            clientNonce: .clientNonceV4()
        )
        let created = try await api.putChatDraft(
            chatID: chat.id,
            command: command,
            token: primary.tokens.accessToken
        )
        XCTAssertEqual(created.state.revision, 1)
        XCTAssertEqual(created.state.draft?.content, command.content)
        XCTAssertFalse(created.replayed)
        await fulfillment(of: [changed], timeout: 5)
        streamTask.cancel()

        let observedDraft = await probe.draft
        let dispatch = try XCTUnwrap(observedDraft)
        XCTAssertEqual(dispatch.accountID, primary.user.id)
        XCTAssertEqual(dispatch.chatID, chat.id)
        XCTAssertEqual(dispatch.state, created.state)
        XCTAssertTrue(RealtimeCursorValidator.isValid(dispatch.cursor))

        let exactReplay = try await api.putChatDraft(
            chatID: chat.id,
            command: command,
            token: primary.tokens.accessToken
        )
        XCTAssertEqual(exactReplay.state, created.state)
        XCTAssertTrue(exactReplay.replayed)

        let secondSessionProjection = try await api.chatDraft(
            chatID: chat.id,
            token: secondary.tokens.accessToken
        )
        XCTAssertEqual(secondSessionProjection, created.state)

        let deleted = try await api.deleteChatDraft(
            chatID: chat.id,
            command: ChatDraftDeleteCommand(
                expectedRevision: created.state.revision,
                clientNonce: .clientNonceV4()
            ),
            token: secondary.tokens.accessToken
        )
        XCTAssertNil(deleted.state.draft)
        XCTAssertEqual(deleted.state.revision, 2)
        XCTAssertFalse(deleted.replayed)
        let final = try await api.chatDraft(chatID: chat.id, token: primary.tokens.accessToken)
        XCTAssertEqual(final, deleted.state)
    }

    func testGlobalPeopleAndMessageSearchAgainstLiveDocker() async throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_TEST=1 while the local API is running")
        }

        let api = LuxoraAPIClient(configuration: .development)
        let suffix = UUID().uuidString
            .replacingOccurrences(of: "-", with: "")
            .prefix(10)
            .lowercased()
        let password = "LuxoraSearch!2026"
        let seeker = try await api.register(
            username: "search_a_\(suffix)",
            displayName: "Искатель \(suffix)",
            password: password,
            deviceName: "Swift search seeker"
        )
        let peer = try await api.register(
            username: "search_b_\(suffix)",
            displayName: "Собеседник \(suffix)",
            password: password,
            deviceName: "Swift search peer"
        )
        defer {
            Task {
                try? await api.revokeCurrentSession(token: seeker.tokens.accessToken)
                try? await api.revokeCurrentSession(token: peer.tokens.accessToken)
            }
        }

        let hiddenBeforeAcceptance = try await api.searchUsersPage(
            query: peer.user.username,
            cursor: nil,
            token: seeker.tokens.accessToken
        )
        XCTAssertTrue(hiddenBeforeAcceptance.items.isEmpty)

        let request = try await api.createMessageRequest(
            recipientUserID: peer.user.id,
            body: "Запрос на приватный поиск",
            clientNonce: .clientNonceV4(),
            token: seeker.tokens.accessToken
        )
        _ = try await api.acceptMessageRequest(id: request.id, token: peer.tokens.accessToken)

        let people = try await api.searchUsersPage(
            query: peer.user.username,
            cursor: nil,
            token: seeker.tokens.accessToken
        )
        XCTAssertEqual(people.items.map(\.id), [peer.user.id])
        XCTAssertNil(people.nextCursor)

        let savedChat = try await api.createDirectChat(
            userID: seeker.user.id,
            token: seeker.tokens.accessToken
        )
        let canary = "поиск-\(suffix)"
        let sent = try await api.sendMessage(
            chatID: savedChat.id,
            clientNonce: .clientNonceV4(),
            body: canary,
            token: seeker.tokens.accessToken
        )
        let messages = try await api.searchMessagesPage(
            query: canary,
            cursor: nil,
            token: seeker.tokens.accessToken
        )
        XCTAssertEqual(messages.items.map(\.id), [sent.id])
        XCTAssertNil(messages.nextCursor)
    }

    func testScopedRealtimeV2PreferencesCursorAndAuthoritativeRecoveryAgainstLiveDocker() async throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_TEST=1 while the local API is running")
        }

        let configuration = LuxoraClientConfiguration.development
        let api = LuxoraAPIClient(configuration: configuration)
        let realtime = LuxoraRealtimeClient(configuration: configuration)
        let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
        let authentication = try await api.register(
            username: "swift_v2_\(suffix)",
            displayName: "Swift v2 Integration",
            password: "LuxoraIntegration!2026",
            deviceName: "Swift v2 test"
        )
        let token = authentication.tokens.accessToken
        defer { Task { try? await api.revokeCurrentSession(token: token) } }

        let capabilities = try await api.capabilities()
        XCTAssertEqual(capabilities.realtimeProtocolVersion, .scopedV2)
        XCTAssertTrue(capabilities.features.reconciliation)

        let savedChat = try await api.createDirectChat(userID: authentication.user.id, token: token)
        let sent = try await api.sendMessage(
            chatID: savedChat.id,
            clientNonce: .clientNonceV4(),
            body: "Live v2 reconciliation contract",
            token: token
        )

        let initialBundle = try await api.reconciliationBundle(
            token: token,
            expectedUserID: authentication.user.id
        )
        XCTAssertEqual(initialBundle.chats.map { $0.chat.id }, [savedChat.id])
        XCTAssertEqual(initialBundle.chats.first?.messages.map { $0.message.id }, [sent.id])
        XCTAssertTrue(RealtimeCursorValidator.isValid(initialBundle.boundary.cursor))

        let probe = LiveScopedRealtimeProbe()
        let ready = expectation(description: "Scoped v2 ready")
        let checkpoint = expectation(description: "Scoped v2 checkpoint")
        let preference = expectation(description: "Scoped preference dispatch")
        let streamTask = Task {
            do {
                for try await signal in realtime.scopedSignals(token: token, resumeCursor: nil) {
                    switch signal {
                    case .ready:
                        ready.fulfill()
                    case let .checkpoint(sequence, cursor):
                        await probe.recordCheckpoint(sequence: sequence, cursor: cursor)
                        checkpoint.fulfill()
                    case let .chatPreferences(dispatch):
                        await probe.recordPreference(dispatch)
                        preference.fulfill()
                    default:
                        break
                    }
                }
            } catch {
                // Expectations below remain the source of deterministic failure.
            }
        }
        await fulfillment(of: [ready, checkpoint], timeout: 5)

        let muteUntil = Date().addingTimeInterval(3_600)
        let updated = try await api.updateChatPreferences(
            chatID: savedChat.id,
            patch: ChatPreferencesPatch(archived: true, mutedUntil: .until(muteUntil)),
            token: token
        )
        XCTAssertNotNil(updated.archivedAt)
        XCTAssertNotNil(updated.mutedUntil)
        await fulfillment(of: [preference], timeout: 5)
        streamTask.cancel()

        let observedPreference = await probe.preference
        let dispatch = try XCTUnwrap(observedPreference)
        XCTAssertEqual(dispatch.accountID, authentication.user.id)
        XCTAssertEqual(dispatch.chatID, savedChat.id)
        XCTAssertTrue(dispatch.preferences.isArchived)
        XCTAssertTrue(dispatch.preferences.isMuted(at: Date()))
        XCTAssertTrue(RealtimeCursorValidator.isValid(dispatch.cursor))

        let replacement = dispatch.cursor.last == "a" ? "b" : "a"
        let tamperedCursor = String(dispatch.cursor.dropLast()) + replacement
        let syncRequired = expectation(description: "Invalid cursor requires authoritative sync")
        let recoveryTask = Task {
            do {
                for try await signal in realtime.scopedSignals(token: token, resumeCursor: tamperedCursor) {
                    if case let .syncRequired(reason, _, recoveryPath) = signal {
                        await probe.recordSyncRequired(reason: reason, path: recoveryPath)
                        syncRequired.fulfill()
                        return
                    }
                }
            } catch {
                // The expectation reports a deterministic failure if recovery
                // is not announced before the server closes the socket.
            }
        }
        await fulfillment(of: [syncRequired], timeout: 5)
        recoveryTask.cancel()
        let observedSyncReason = await probe.syncReason
        let observedRecoveryPath = await probe.recoveryPath
        XCTAssertEqual(observedSyncReason, .cursorInvalid)
        XCTAssertEqual(observedRecoveryPath, "/v2/sync/snapshot")

        let recovered = try await api.reconciliationBundle(
            token: token,
            expectedUserID: authentication.user.id
        )
        let recoveredChat = try XCTUnwrap(recovered.chats.first(where: { $0.chat.id == savedChat.id }))
        XCTAssertNotNil(recoveredChat.chat.archivedAt)
        XCTAssertNotNil(recoveredChat.chat.mutedUntil)
        XCTAssertEqual(recoveredChat.messages.map { $0.message.id }, [sent.id])
        XCTAssertGreaterThanOrEqual(recovered.boundary.sequence, dispatch.sequence)
    }

    func testRegistrationSessionChatListAndRealtimeHandshake() async throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_TEST=1 while the local API is running")
        }

        let configuration = LuxoraClientConfiguration.development
        let api = LuxoraAPIClient(configuration: configuration)
        let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
        let username = "swift_\(suffix)"

        let authentication = try await api.register(
            username: username,
            displayName: "Swift Integration",
            password: "LuxoraIntegration!2026",
            deviceName: "Swift test"
        )

        let currentUser = try await api.currentUser(token: authentication.tokens.accessToken)
        let chats = try await api.chats(token: authentication.tokens.accessToken)

        XCTAssertEqual(currentUser.username, username)
        XCTAssertEqual(currentUser.id, authentication.user.id)
        XCTAssertTrue(chats.isEmpty)

        let savedChat = try await api.createDirectChat(
            userID: currentUser.id,
            token: authentication.tokens.accessToken
        )
        let sent = try await api.sendMessage(
            chatID: savedChat.id,
            clientNonce: .clientNonceV4(),
            body: "Live Swift chat contract",
            token: authentication.tokens.accessToken
        )
        let messages = try await api.messages(
            chatID: savedChat.id,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(messages.map(\.id), [sent.id])
        XCTAssertEqual(messages.first?.body, "Live Swift chat contract")

        let reply = try await api.sendMessage(
            chatID: savedChat.id,
            clientNonce: .clientNonceV4(),
            body: "Live reply contract",
            replyToMessageID: sent.id,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(reply.replyToMessageId, sent.id)

        let editedReply = try await api.editMessage(
            messageID: reply.id,
            body: "Live edited reply contract",
            expectedRevision: reply.revision,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(editedReply.body, "Live edited reply contract")
        XCTAssertEqual(editedReply.revision, reply.revision + 1)

        let pinned = try await api.setMessagePinned(
            chatID: savedChat.id,
            messageID: sent.id,
            active: true,
            token: authentication.tokens.accessToken
        )
        XCTAssertTrue(pinned)
        let pinnedPage = try await api.messages(
            chatID: savedChat.id,
            token: authentication.tokens.accessToken
        )
        XCTAssertTrue(pinnedPage.first(where: { $0.id == sent.id })?.isPinned == true)
        let unpinned = try await api.setMessagePinned(
            chatID: savedChat.id,
            messageID: sent.id,
            active: false,
            token: authentication.tokens.accessToken
        )
        XCTAssertFalse(unpinned)

        let forwardNonce = UUID.clientNonceV4()
        let forwarded = try await api.forwardMessage(
            messageID: sent.id,
            to: savedChat.id,
            clientNonce: forwardNonce,
            token: authentication.tokens.accessToken
        )
        let duplicateForward = try await api.forwardMessage(
            messageID: sent.id,
            to: savedChat.id,
            clientNonce: forwardNonce,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(duplicateForward.id, forwarded.id)
        XCTAssertEqual(forwarded.forwardedFrom?.senderDisplayName, authentication.user.displayName)

        let deletedReply = try await api.deleteMessage(
            messageID: editedReply.id,
            token: authentication.tokens.accessToken
        )
        XCTAssertNotNil(deletedReply.deletedAt)
        XCTAssertNil(deletedReply.body)

        let mutationPage = try await api.messages(
            chatID: savedChat.id,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(mutationPage.first(where: { $0.id == forwarded.id })?.clientNonce, forwardNonce)
        XCTAssertNotNil(mutationPage.first(where: { $0.id == editedReply.id })?.deletedAt)

        try await api.markRead(
            chatID: savedChat.id,
            messageID: sent.id,
            token: authentication.tokens.accessToken
        )
        let activeReactions = try await api.setReaction(
            messageID: sent.id,
            emoji: "🔥",
            active: true,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(activeReactions.first?.emoji, "🔥")
        XCTAssertEqual(activeReactions.first?.count, 1)
        XCTAssertEqual(activeReactions.first?.reactedByMe, true)
        let clearedReactions = try await api.setReaction(
            messageID: sent.id,
            emoji: "🔥",
            active: false,
            token: authentication.tokens.accessToken
        )
        XCTAssertTrue(clearedReactions.isEmpty)

        let refreshedChats = try await api.chats(token: authentication.tokens.accessToken)
        XCTAssertEqual(refreshedChats.map(\.id), [savedChat.id])

        let realtime = LuxoraRealtimeClient(configuration: configuration)
        let ready = expectation(description: "Realtime ready")
        let task = Task {
            for try await signal in realtime.signals(token: authentication.tokens.accessToken, resumeFrom: nil) {
                if case .ready = signal {
                    ready.fulfill()
                    return
                }
            }
        }
        await fulfillment(of: [ready], timeout: 5)
        task.cancel()
        try await api.revokeCurrentSession(token: authentication.tokens.accessToken)
    }

    func testMessageRequestsPrivacyDismissAndAcceptanceAgainstLiveDocker() async throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_TEST=1 while the local API is running")
        }

        let api = LuxoraAPIClient(configuration: .development)
        let suffix = UUID().uuidString
            .replacingOccurrences(of: "-", with: "")
            .prefix(10)
            .lowercased()
        let password = "LuxoraRequests!2026"
        let sender = try await api.register(
            username: "mr_sender_\(suffix)",
            displayName: "Отправитель Swift",
            password: password,
            deviceName: "Swift request sender"
        )
        let quietSender = try await api.register(
            username: "mr_quiet_\(suffix)",
            displayName: "Тихий отправитель Swift",
            password: password,
            deviceName: "Swift quiet sender"
        )
        let recipient = try await api.register(
            username: "mr_recipient_\(suffix)",
            displayName: "Получатель Swift",
            password: password,
            deviceName: "Swift request recipient"
        )

        let hidden = try await api.updatePrivacySettings(
            usernameDiscoverable: false,
            messageRequests: .nobody,
            token: recipient.tokens.accessToken
        )
        XCTAssertFalse(hidden.usernameDiscoverable)
        XCTAssertEqual(hidden.messageRequests, .nobody)
        let hiddenLookup = try await api.lookupUser(
            username: recipient.user.username,
            token: sender.tokens.accessToken
        )
        XCTAssertNil(hiddenLookup)
        do {
            _ = try await api.createMessageRequest(
                recipientUserID: recipient.user.id,
                body: "Этот запрос должен быть закрыт политикой",
                clientNonce: .clientNonceV4(),
                token: sender.tokens.accessToken
            )
            XCTFail("The live server accepted a request while recipient policy was nobody")
        } catch {
            XCTAssertFalse(error is CancellationError)
        }

        let visible = try await api.updatePrivacySettings(
            usernameDiscoverable: true,
            messageRequests: .everyone,
            token: recipient.tokens.accessToken
        )
        XCTAssertTrue(visible.usernameDiscoverable)
        XCTAssertEqual(visible.messageRequests, .everyone)
        let confirmedSettings = try await api.privacySettings(token: recipient.tokens.accessToken)
        XCTAssertEqual(confirmedSettings.snapshot, visible.snapshot)
        let visibleLookup = try await api.lookupUser(
            username: recipient.user.username.uppercased(),
            token: sender.tokens.accessToken
        )
        XCTAssertEqual(visibleLookup?.id, recipient.user.id)

        let acceptanceNonce = UUID.clientNonceV4()
        let acceptanceCandidate = try await api.createMessageRequest(
            recipientUserID: recipient.user.id,
            body: "Первое сообщение войдёт в подтверждённый чат",
            clientNonce: acceptanceNonce,
            token: sender.tokens.accessToken
        )
        let acceptanceReplay = try await api.createMessageRequest(
            recipientUserID: recipient.user.id,
            body: "Первое сообщение войдёт в подтверждённый чат",
            clientNonce: acceptanceNonce,
            token: sender.tokens.accessToken
        )
        XCTAssertEqual(acceptanceReplay.id, acceptanceCandidate.id)
        XCTAssertEqual(acceptanceCandidate.direction, .outgoing)

        let quietCandidate = try await api.createMessageRequest(
            recipientUserID: recipient.user.id,
            body: "Этот запрос будет удалён приватно",
            clientNonce: .clientNonceV4(),
            token: quietSender.tokens.accessToken
        )
        let recipientInbox = try await api.allMessageRequests(
            direction: .incoming,
            token: recipient.tokens.accessToken
        )
        XCTAssertEqual(
            Set(recipientInbox.map(\.id)),
            Set([acceptanceCandidate.id, quietCandidate.id])
        )
        XCTAssertTrue(recipientInbox.allSatisfy { $0.sender != nil && $0.recipient == nil })

        try await api.dismissMessageRequest(
            id: quietCandidate.id,
            token: recipient.tokens.accessToken
        )
        let inboxAfterDismiss = try await api.allMessageRequests(
            direction: .incoming,
            token: recipient.tokens.accessToken
        )
        XCTAssertFalse(inboxAfterDismiss.contains(where: { $0.id == quietCandidate.id }))
        let quietOutbox = try await api.allMessageRequests(
            direction: .outgoing,
            token: quietSender.tokens.accessToken
        )
        let privateProjection = try XCTUnwrap(
            quietOutbox.first(where: { $0.id == quietCandidate.id })
        )
        XCTAssertEqual(privateProjection.state, .pending)
        XCTAssertNotNil(privateProjection.recipient)
        XCTAssertNil(privateProjection.sender)

        let accepted = try await api.acceptMessageRequest(
            id: acceptanceCandidate.id,
            token: recipient.tokens.accessToken
        )
        XCTAssertEqual(accepted.request.id, acceptanceCandidate.id)
        XCTAssertEqual(accepted.request.state, .accepted)
        let acceptedMessages = try await api.messages(
            chatID: accepted.chat.id,
            token: recipient.tokens.accessToken
        )
        XCTAssertEqual(acceptedMessages.map(\.body), ["Первое сообщение войдёт в подтверждённый чат"])
        let senderChats = try await api.chats(token: sender.tokens.accessToken)
        let recipientChats = try await api.chats(token: recipient.tokens.accessToken)
        XCTAssertTrue(senderChats.contains(where: { $0.id == accepted.chat.id }))
        XCTAssertTrue(recipientChats.contains(where: { $0.id == accepted.chat.id }))

        try? await api.revokeCurrentSession(token: sender.tokens.accessToken)
        try? await api.revokeCurrentSession(token: quietSender.tokens.accessToken)
        try? await api.revokeCurrentSession(token: recipient.tokens.accessToken)
    }
}

private actor LiveScopedRealtimeProbe {
    private(set) var checkpointSequence: Int?
    private(set) var checkpointCursor: String?
    private(set) var preference: ChatPreferencesRealtimeDispatch?
    private(set) var draft: ChatDraftRealtimeDispatch?
    private(set) var syncReason: RealtimeV2SyncRequiredReason?
    private(set) var recoveryPath: String?

    func recordCheckpoint(sequence: Int, cursor: String) {
        checkpointSequence = sequence
        checkpointCursor = cursor
    }

    func recordPreference(_ dispatch: ChatPreferencesRealtimeDispatch) {
        preference = dispatch
    }

    func recordDraft(_ dispatch: ChatDraftRealtimeDispatch) {
        draft = dispatch
    }

    func recordSyncRequired(reason: RealtimeV2SyncRequiredReason, path: String) {
        syncReason = reason
        recoveryPath = path
    }
}
