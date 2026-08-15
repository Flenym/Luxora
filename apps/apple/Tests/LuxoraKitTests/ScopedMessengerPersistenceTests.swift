import Foundation
@testable import LuxoraKit
import XCTest

final class ScopedMessengerPersistenceTests: XCTestCase, @unchecked Sendable {
    private let accountID = UUID(uuidString: "A1000000-0000-4000-8000-000000000001")!
    private let sessionID = UUID(uuidString: "B1000000-0000-4000-8000-000000000001")!
    private let chatID = UUID(uuidString: "C1000000-0000-4000-8000-000000000001")!
    private let userID = UUID(uuidString: "D1000000-0000-4000-8000-000000000001")!
    private let baseDate = Date(timeIntervalSince1970: 1_786_694_400)

    func testRestartRestoresConfirmedProjectionPendingOutboxAndCheckpointWithoutTokens() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let scope = primaryScope
        let first = ScopedMessengerPersistence(rootDirectory: directory, now: { self.baseDate })
        let conversation = makeConversation()
        let confirmed = makeSnapshot(
            nonce: UUID(uuidString: "E1000000-0000-4000-8000-000000000001")!,
            messageID: UUID(uuidString: "F1000000-0000-4000-8000-000000000001")!,
            body: "Подтверждено",
            sentAt: baseDate
        )
        try await first.replaceConfirmedProjection(
            scope: scope,
            conversations: [conversation],
            messages: [
                DurableConversationMessages(
                    conversationID: chatID,
                    snapshots: [confirmed]
                ),
            ]
        )
        let pendingNonce = UUID(uuidString: "E2000000-0000-4000-8000-000000000002")!
        _ = try await first.enqueueText(
            scope: scope,
            conversationID: chatID,
            clientNonce: pendingNonce,
            body: "  Будет отправлено  ",
            replyToMessageID: confirmed.message.id,
            enqueuedAt: baseDate.addingTimeInterval(1)
        )
        let cursor = validCursor("a")
        try await first.replaceConfirmedProjectionAndCheckpoint(
            scope: scope,
            conversations: [conversation],
            messages: [
                DurableConversationMessages(
                    conversationID: chatID,
                    snapshots: [confirmed]
                ),
            ],
            checkpoint: DurableRealtimeCheckpoint(
                sequence: 42,
                cursor: cursor,
                capturedAt: baseDate,
                expiresAt: baseDate.addingTimeInterval(604_800)
            )
        )

        let restarted = ScopedMessengerPersistence(rootDirectory: directory)
        let outcome = try await restarted.load(scope: scope)
        XCTAssertEqual(outcome.recovery, .none)
        XCTAssertEqual(outcome.state.conversations, [conversation])
        XCTAssertEqual(outcome.state.messages.first?.snapshots, [confirmed])
        XCTAssertEqual(outcome.state.pendingTextOutbox.count, 1)
        XCTAssertEqual(outcome.state.pendingTextOutbox.first?.clientNonce, pendingNonce)
        XCTAssertEqual(outcome.state.pendingTextOutbox.first?.body, "Будет отправлено")
        XCTAssertEqual(outcome.state.realtimeV2Checkpoint?.sequence, 42)
        XCTAssertEqual(outcome.state.realtimeV2Checkpoint?.cursor, cursor)

        let data = try Data(contentsOf: await restarted.fileURL(scope: scope))
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertFalse(text.localizedCaseInsensitiveContains("accessToken"))
        XCTAssertFalse(text.localizedCaseInsensitiveContains("refreshToken"))
        XCTAssertFalse(text.localizedCaseInsensitiveContains("bearer"))
    }

    func testCorruptFileIsQuarantinedAndNeverReplaysUntrustedBytes() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ScopedMessengerPersistence(rootDirectory: directory)
        try await seed(first)
        _ = try await first.enqueueText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: UUID(),
            body: "Не должно отправиться",
            replyToMessageID: nil
        )
        let fileURL = await first.fileURL(scope: primaryScope)
        try Data(#"{"schemaVersion":2,"pendingTextOutbox":["#.utf8).write(to: fileURL)

        let restarted = ScopedMessengerPersistence(rootDirectory: directory)
        let outcome = try await restarted.load(scope: primaryScope)
        guard case let .discardedCorruptFile(quarantinedURL) = outcome.recovery else {
            return XCTFail("Expected corruption recovery")
        }
        XCTAssertTrue(outcome.state.conversations.isEmpty)
        XCTAssertTrue(outcome.state.messages.isEmpty)
        XCTAssertTrue(outcome.state.pendingTextOutbox.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: quarantinedURL.path))

        let sender = SendProbe()
        let replay = await restarted.replayPending(scope: primaryScope) { pending in
            await sender.record(pending.clientNonce)
            return self.makeSnapshot(
                nonce: pending.clientNonce,
                messageID: UUID(),
                body: pending.body,
                sentAt: self.baseDate
            )
        }
        XCTAssertEqual(replay.remainingCount, 0)
        let recordedNonces = await sender.nonces()
        XCTAssertEqual(recordedNonces, [])
    }

    func testAccountAndSessionScopesRemainIsolatedAndExactLogoutOnlyPurgesTarget() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ScopedMessengerPersistence(rootDirectory: directory)
        let replacementSession = DurableMessagingScope(accountID: accountID, sessionID: UUID())
        let otherAccount = DurableMessagingScope(accountID: UUID(), sessionID: UUID())

        for (index, scope) in [primaryScope, replacementSession, otherAccount].enumerated() {
            try await persistence.replaceConfirmedProjection(
                scope: scope,
                conversations: [makeConversation(title: "Чат \(index)")],
                messages: []
            )
            _ = try await persistence.enqueueText(
                scope: scope,
                conversationID: chatID,
                clientNonce: UUID(),
                body: "scope-\(index)",
                replyToMessageID: nil
            )
        }

        try await persistence.remove(scope: primaryScope)
        let primaryURL = await persistence.fileURL(scope: primaryScope)
        let emptyPrimaryState = try await persistence.state(scope: primaryScope)
        let replacementState = try await persistence.state(scope: replacementSession)
        let otherState = try await persistence.state(scope: otherAccount)
        XCTAssertFalse(FileManager.default.fileExists(atPath: primaryURL.path))
        XCTAssertEqual(emptyPrimaryState.pendingTextOutbox.count, 0)
        XCTAssertEqual(replacementState.pendingTextOutbox.first?.body, "scope-1")
        XCTAssertEqual(otherState.pendingTextOutbox.first?.body, "scope-2")

        try await persistence.removeAccount(accountID)
        let removedReplacementState = try await persistence.state(scope: replacementSession)
        let retainedOtherState = try await persistence.state(scope: otherAccount)
        XCTAssertEqual(removedReplacementState.pendingTextOutbox.count, 0)
        XCTAssertEqual(retainedOtherState.pendingTextOutbox.first?.body, "scope-2")
    }

    func testRemoveSessionAfterActorRestartPurgesEveryExactDiskMatchOnly() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ScopedMessengerPersistence(rootDirectory: directory)
        let targetSessionID = sessionID
        let firstTarget = primaryScope
        let secondTarget = DurableMessagingScope(accountID: UUID(), sessionID: targetSessionID)
        let retained = DurableMessagingScope(accountID: accountID, sessionID: UUID())
        let scopes = [firstTarget, secondTarget, retained]

        for (index, scope) in scopes.enumerated() {
            try await first.replaceConfirmedProjection(
                scope: scope,
                conversations: [makeConversation(title: "Disk scope \(index)")],
                messages: []
            )
            _ = try await first.enqueueText(
                scope: scope,
                conversationID: chatID,
                clientNonce: UUID(),
                body: "disk-scope-\(index)",
                replyToMessageID: nil
            )
        }
        let firstTargetURL = await first.fileURL(scope: firstTarget)
        let secondTargetURL = await first.fileURL(scope: secondTarget)
        let retainedURL = await first.fileURL(scope: retained)
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstTargetURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: secondTargetURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: retainedURL.path))

        // A fresh actor has no cached scope metadata and must discover exact
        // matches with a bounded on-disk scan.
        let restarted = ScopedMessengerPersistence(rootDirectory: directory)
        try await restarted.removeSession(targetSessionID)

        XCTAssertFalse(FileManager.default.fileExists(atPath: firstTargetURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: secondTargetURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: retainedURL.path))
        let retainedState = try await restarted.state(scope: retained)
        XCTAssertEqual(retainedState.pendingTextOutbox.first?.body, "disk-scope-2")
    }

    func testRemoveAllDeletesOnlyConfiguredRootAndNeverFollowsSymlink() async throws {
        let container = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: container) }
        let root = container.appendingPathComponent("durable", isDirectory: true)
        let external = container.appendingPathComponent("external", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true)
        let sentinel = external.appendingPathComponent("must-survive.txt")
        try Data("outside-root".utf8).write(to: sentinel)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("external-link"),
            withDestinationURL: external
        )

        let persistence = ScopedMessengerPersistence(rootDirectory: root)
        try await persistence.replaceConfirmedProjection(
            scope: primaryScope,
            conversations: [makeConversation()],
            messages: []
        )
        try await persistence.removeAll()

        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sentinel.path))
        XCTAssertEqual(try String(contentsOf: sentinel, encoding: .utf8), "outside-root")
    }

    func testCommittedResponseLossRetriesSameNonceAndSettlesExactlyOnce() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ScopedMessengerPersistence(rootDirectory: directory, now: { self.baseDate })
        try await seed(first)
        let nonce = UUID(uuidString: "E3000000-0000-4000-8000-000000000003")!
        let server = IdempotentMessageServer(
            chatID: chatID,
            author: makeParticipant(),
            firstResponseMustBeLost: true
        )

        do {
            _ = try await first.sendText(
                scope: primaryScope,
                conversationID: chatID,
                clientNonce: nonce,
                body: "Одна команда",
                replyToMessageID: nil,
                sender: { try await server.send($0) }
            )
            XCTFail("Expected simulated response loss")
        } catch {}
        let afterLoss = try await first.state(scope: primaryScope)
        XCTAssertEqual(afterLoss.pendingTextOutbox.count, 1)
        XCTAssertEqual(afterLoss.pendingTextOutbox.first?.clientNonce, nonce)
        XCTAssertEqual(afterLoss.pendingTextOutbox.first?.attemptCount, 1)

        let restarted = ScopedMessengerPersistence(rootDirectory: directory, now: { self.baseDate.addingTimeInterval(5) })
        let replay = await restarted.replayPending(scope: primaryScope) {
            try await server.send($0)
        }
        XCTAssertNil(replay.errorDescription)
        XCTAssertEqual(replay.confirmed.count, 1)
        XCTAssertEqual(replay.confirmed.first?.message.clientID, nonce)
        XCTAssertEqual(replay.remainingCount, 0)
        let settled = try await restarted.state(scope: primaryScope)
        XCTAssertTrue(settled.pendingTextOutbox.isEmpty)
        XCTAssertEqual(settled.messages.first?.snapshots.count, 1)
        let logicalMessageCount = await server.logicalMessageCount()
        let requestNonces = await server.requestNonces()
        XCTAssertEqual(logicalMessageCount, 1)
        XCTAssertEqual(requestNonces, [nonce, nonce])
    }

    func testLocalConfirmationWriteFailureRetainsOutboxForIdempotentRetry() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = AtomicWriteProbe()
        let persistence = ScopedMessengerPersistence(
            rootDirectory: directory,
            now: { self.baseDate },
            atomicWriter: { try probe.write($0, to: $1) }
        )
        try await seed(persistence) // write 1
        let nonce = UUID(uuidString: "E4000000-0000-4000-8000-000000000004")!
        let server = IdempotentMessageServer(chatID: chatID, author: makeParticipant())
        probe.fail(onCall: 4) // enqueue 2, attempt 3, confirmation 4

        do {
            _ = try await persistence.sendText(
                scope: primaryScope,
                conversationID: chatID,
                clientNonce: nonce,
                body: "Commit повторится",
                replyToMessageID: nil,
                sender: { try await server.send($0) }
            )
            XCTFail("Expected injected disk failure")
        } catch {}
        let retainedAfterWriteFailure = try await persistence.state(scope: primaryScope)
        let firstLogicalCount = await server.logicalMessageCount()
        XCTAssertEqual(retainedAfterWriteFailure.pendingTextOutbox.count, 1)
        XCTAssertEqual(firstLogicalCount, 1)

        probe.fail(onCall: nil)
        let result = await persistence.replayPending(scope: primaryScope) {
            try await server.send($0)
        }
        XCTAssertNil(result.errorDescription)
        XCTAssertEqual(result.confirmed.count, 1)
        let settledState = try await persistence.state(scope: primaryScope)
        let finalLogicalCount = await server.logicalMessageCount()
        let writeFailureRequestNonces = await server.requestNonces()
        XCTAssertEqual(settledState.pendingTextOutbox.count, 0)
        XCTAssertEqual(finalLogicalCount, 1)
        XCTAssertEqual(writeFailureRequestNonces, [nonce, nonce])
    }

    func testCheckpointedProjectionWriteFailureAdvancesNeitherProjectionNorCursor() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = AtomicWriteProbe()
        let persistence = ScopedMessengerPersistence(
            rootDirectory: directory,
            now: { self.baseDate },
            atomicWriter: { try probe.write($0, to: $1) }
        )
        try await seed(persistence) // write 1
        let nonce = UUID()
        _ = try await persistence.enqueueText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: nonce,
            body: "Атомарная граница",
            replyToMessageID: nil
        ) // write 2
        let confirmed = makeSnapshot(
            nonce: nonce,
            messageID: UUID(),
            body: "Атомарная граница",
            sentAt: baseDate
        )
        let checkpoint = DurableRealtimeCheckpoint(
            sequence: 51,
            cursor: validCursor("b"),
            capturedAt: baseDate,
            expiresAt: baseDate.addingTimeInterval(604_800)
        )
        probe.fail(onCall: 3)

        do {
            try await persistence.replaceConfirmedProjectionAndCheckpoint(
                scope: primaryScope,
                conversations: [makeConversation(title: "Новая проекция")],
                messages: [
                    DurableConversationMessages(
                        conversationID: chatID,
                        snapshots: [confirmed]
                    ),
                ],
                checkpoint: checkpoint
            )
            XCTFail("Expected injected atomic write failure")
        } catch PersistenceTestError.injectedWriteFailure {}

        let unchanged = try await persistence.state(scope: primaryScope)
        XCTAssertEqual(unchanged.conversations.first?.title, "Luxora")
        XCTAssertTrue(unchanged.messages.flatMap(\.snapshots).isEmpty)
        XCTAssertEqual(unchanged.pendingTextOutbox.map(\.clientNonce), [nonce])
        XCTAssertNil(unchanged.realtimeV2Checkpoint)

        probe.fail(onCall: nil)
        try await persistence.replaceConfirmedProjectionAndCheckpoint(
            scope: primaryScope,
            conversations: [makeConversation(title: "Новая проекция")],
            messages: [
                DurableConversationMessages(
                    conversationID: chatID,
                    snapshots: [confirmed]
                ),
            ],
            checkpoint: checkpoint
        )
        let committed = try await persistence.state(scope: primaryScope)
        XCTAssertEqual(committed.conversations.first?.title, "Новая проекция")
        XCTAssertEqual(committed.messages.first?.snapshots, [confirmed])
        XCTAssertTrue(committed.pendingTextOutbox.isEmpty)
        XCTAssertEqual(committed.realtimeV2Checkpoint, checkpoint)
    }

    func testConcurrentRetriesShareOneNetworkTask() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ScopedMessengerPersistence(rootDirectory: directory)
        try await seed(persistence)
        let nonce = UUID(uuidString: "E5000000-0000-4000-8000-000000000005")!
        let server = IdempotentMessageServer(
            chatID: chatID,
            author: makeParticipant(),
            delayNanoseconds: 50_000_000
        )

        async let first = persistence.sendText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: nonce,
            body: "Параллельный retry",
            replyToMessageID: nil,
            sender: { try await server.send($0) }
        )
        async let second = persistence.sendText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: nonce,
            body: "Параллельный retry",
            replyToMessageID: nil,
            sender: { try await server.send($0) }
        )
        let results = try await [first, second]
        let concurrentRequestNonces = await server.requestNonces()
        let concurrentLogicalCount = await server.logicalMessageCount()
        let concurrentState = try await persistence.state(scope: primaryScope)
        XCTAssertEqual(results[0], results[1])
        XCTAssertEqual(concurrentRequestNonces, [nonce])
        XCTAssertEqual(concurrentLogicalCount, 1)
        XCTAssertTrue(concurrentState.pendingTextOutbox.isEmpty)
    }

    func testReplayPreservesOrdinalAndStopsAtFirstFailure() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ScopedMessengerPersistence(rootDirectory: directory)
        try await seed(persistence)
        let firstNonce = UUID(uuidString: "E6000000-0000-4000-8000-000000000006")!
        let secondNonce = UUID(uuidString: "E7000000-0000-4000-8000-000000000007")!
        _ = try await persistence.enqueueText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: firstNonce,
            body: "Первое",
            replyToMessageID: nil,
            enqueuedAt: baseDate.addingTimeInterval(100)
        )
        _ = try await persistence.enqueueText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: secondNonce,
            body: "Второе",
            replyToMessageID: nil,
            enqueuedAt: baseDate
        )
        let failedProbe = SendProbe(failingNonce: firstNonce)
        let stopped = await persistence.replayPending(scope: primaryScope) { pending in
            try await failedProbe.send(pending, snapshot: self.makeSnapshot(
                nonce: pending.clientNonce,
                messageID: UUID(),
                body: pending.body,
                sentAt: self.baseDate
            ))
        }
        let failedNonces = await failedProbe.nonces()
        XCTAssertEqual(stopped.stoppedAtNonce, firstNonce)
        XCTAssertEqual(stopped.remainingCount, 2)
        XCTAssertEqual(failedNonces, [firstNonce])

        let successProbe = SendProbe()
        let completed = await persistence.replayPending(scope: primaryScope) { pending in
            try await successProbe.send(pending, snapshot: self.makeSnapshot(
                nonce: pending.clientNonce,
                messageID: UUID(),
                body: pending.body,
                sentAt: self.baseDate.addingTimeInterval(TimeInterval(pending.ordinal))
            ))
        }
        let successNonces = await successProbe.nonces()
        XCTAssertEqual(successNonces, [firstNonce, secondNonce])
        XCTAssertEqual(completed.confirmed.map(\.message.clientID), [firstNonce, secondNonce])
        XCTAssertEqual(completed.remainingCount, 0)
    }

    func testLegacyV1MigratesOnceAndPreservesOutboxOrder() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ScopedMessengerPersistence(rootDirectory: directory)
        let fileURL = await persistence.fileURL(scope: primaryScope)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let nonce = UUID(uuidString: "E8000000-0000-4000-8000-000000000008")!
        let legacy = ScopedMessengerPersistence.LegacyStateV1(
            schemaVersion: 1,
            scope: primaryScope,
            conversations: [makeConversation()],
            messages: [],
            pendingTextOutbox: [
                .init(
                    clientNonce: nonce,
                    conversationID: chatID,
                    body: "Миграция",
                    replyToMessageID: nil,
                    enqueuedAt: baseDate,
                    ordinal: 1
                ),
            ],
            nextOutboxOrdinal: 2,
            updatedAt: baseDate
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(legacy).write(to: fileURL, options: .atomic)

        let outcome = try await persistence.load(scope: primaryScope)
        XCTAssertEqual(outcome.recovery, .migrated(fromSchemaVersion: 1))
        XCTAssertEqual(outcome.state.schemaVersion, 2)
        XCTAssertEqual(outcome.state.pendingTextOutbox.first?.clientNonce, nonce)
        XCTAssertEqual(outcome.state.pendingTextOutbox.first?.attemptCount, 0)
        XCTAssertNil(outcome.state.realtimeV2Checkpoint)

        let restarted = ScopedMessengerPersistence(rootDirectory: directory)
        let restartedOutcome = try await restarted.load(scope: primaryScope)
        let restartedState = try await restarted.state(scope: primaryScope)
        XCTAssertEqual(restartedOutcome.recovery, .none)
        XCTAssertEqual(restartedState.schemaVersion, 2)
    }

    @MainActor
    func testMessengerStoreRestoresPendingAndPublishesOnlyConfirmedProjection() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ScopedMessengerPersistence(rootDirectory: directory)
        try await seed(persistence)
        let firstNonce = UUID()
        let secondNonce = UUID()
        let first = try await persistence.enqueueText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: firstNonce,
            body: "Первое",
            replyToMessageID: nil,
            enqueuedAt: baseDate
        )
        let second = try await persistence.enqueueText(
            scope: primaryScope,
            conversationID: chatID,
            clientNonce: secondNonce,
            body: "Второе",
            replyToMessageID: nil,
            enqueuedAt: baseDate.addingTimeInterval(1)
        )
        let messenger = MessengerStore(
            conversations: [makeConversation()],
            messagesByConversation: [:],
            currentUser: makeParticipant()
        )

        messenger.restoreDurablePendingTextOutbox([second, first])
        XCTAssertEqual(
            messenger.messagesByConversation[chatID]?.map(\.clientID),
            [firstNonce, secondNonce]
        )
        XCTAssertEqual(
            messenger.messagesByConversation[chatID]?.map(\.delivery),
            [.sending, .sending]
        )
        XCTAssertTrue(messenger.durableConfirmedProjection().messages.first?.snapshots.isEmpty == true)

        let confirmed = makeSnapshot(
            nonce: firstNonce,
            messageID: UUID(),
            body: first.body,
            sentAt: baseDate
        )
        messenger.applyDurableOutboxConfirmation(confirmed)
        messenger.applyDurableOutboxFailure(clientNonce: secondNonce, detail: "offline")
        XCTAssertEqual(
            messenger.messagesByConversation[chatID]?.map(\.delivery),
            [.sent, .failed]
        )
        let projection = messenger.durableConfirmedProjection()
        XCTAssertEqual(projection.messages.first?.snapshots, [confirmed])
    }

    func testInconsistentServerConfirmationFailsClosedAndRetainsPending() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ScopedMessengerPersistence(rootDirectory: directory)
        try await seed(persistence)
        let nonce = UUID()

        do {
            _ = try await persistence.sendText(
                scope: primaryScope,
                conversationID: chatID,
                clientNonce: nonce,
                body: "Ожидаемый текст",
                replyToMessageID: nil,
                sender: { pending in
                    DurableConfirmedMessageSnapshot(
                        message: ChatMessage(
                            id: UUID(),
                            clientID: pending.clientNonce,
                            conversationID: pending.conversationID,
                            author: self.makeParticipant(),
                            text: "Подменённый текст",
                            sentAt: pending.enqueuedAt,
                            delivery: .sent,
                            isOutgoing: true
                        )
                    )
                }
            )
            XCTFail("Inconsistent confirmation must be rejected")
        } catch let error as DurableMessagingError {
            XCTAssertEqual(error, .inconsistentConfirmation)
        }
        let state = try await persistence.state(scope: primaryScope)
        XCTAssertEqual(state.pendingTextOutbox.map(\.clientNonce), [nonce])
        XCTAssertTrue(state.messages.flatMap(\.snapshots).isEmpty)
    }

    func testLogoutFencesLateConfirmationAndDoesNotRecreateScope() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ScopedMessengerPersistence(rootDirectory: directory)
        try await seed(persistence)
        let nonce = UUID(uuidString: "E9000000-0000-4000-8000-000000000009")!
        let gate = SuspendedSender()
        let task = Task {
            try await persistence.sendText(
                scope: primaryScope,
                conversationID: chatID,
                clientNonce: nonce,
                body: "Поздний ответ",
                replyToMessageID: nil,
                sender: { pending in
                    await gate.waitUntilReleased()
                    return self.makeSnapshot(
                        nonce: pending.clientNonce,
                        messageID: UUID(),
                        body: pending.body,
                        sentAt: self.baseDate
                    )
                }
            )
        }
        await gate.waitUntilStarted()
        try await persistence.remove(scope: primaryScope)
        await gate.release()
        do {
            _ = try await task.value
            XCTFail("Late confirmation must be fenced")
        } catch let error as DurableMessagingError {
            XCTAssertEqual(error, .scopeInvalidated)
        } catch is CancellationError {
            // remove(scope:) also cancels the underlying request task.
        }
        let removedURL = await persistence.fileURL(scope: primaryScope)
        XCTAssertFalse(FileManager.default.fileExists(atPath: removedURL.path))
    }

    private var primaryScope: DurableMessagingScope {
        DurableMessagingScope(accountID: accountID, sessionID: sessionID)
    }

    private func seed(_ persistence: ScopedMessengerPersistence) async throws {
        try await persistence.replaceConfirmedProjection(
            scope: primaryScope,
            conversations: [makeConversation()],
            messages: []
        )
    }

    private func makeParticipant() -> Participant {
        Participant(
            id: userID,
            displayName: "Егор",
            username: "flenym",
            initials: "Е",
            accentHex: "2481CC",
            isOnline: true,
            status: "в сети"
        )
    }

    private func makeConversation(title: String = "Luxora") -> Conversation {
        Conversation(
            id: chatID,
            title: title,
            subtitle: "Последнее сообщение",
            kind: .direct,
            avatar: makeParticipant(),
            memberCount: 2,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: baseDate,
            folder: "personal"
        )
    }

    private func makeSnapshot(
        nonce: UUID,
        messageID: UUID,
        body: String,
        sentAt: Date
    ) -> DurableConfirmedMessageSnapshot {
        DurableConfirmedMessageSnapshot(
            message: ChatMessage(
                id: messageID,
                clientID: nonce,
                conversationID: chatID,
                author: makeParticipant(),
                text: body,
                sentAt: sentAt,
                delivery: .sent,
                isOutgoing: true
            ),
            metadata: MessageRemoteMetadata(revision: 0)
        )
    }

    private func validCursor(_ seed: Character) -> String {
        "luxora-rt1.\(String(repeating: seed, count: 40)).\(String(repeating: seed, count: 40))"
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("luxora-durable-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

private enum PersistenceTestError: Error {
    case responseLost
    case injectedWriteFailure
    case injectedSendFailure
}

private final class AtomicWriteProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var callCount = 0
    private var failingCall: Int?

    func fail(onCall: Int?) {
        lock.lock()
        failingCall = onCall
        lock.unlock()
    }

    func write(_ data: Data, to url: URL) throws {
        lock.lock()
        callCount += 1
        let shouldFail = callCount == failingCall
        lock.unlock()
        if shouldFail { throw PersistenceTestError.injectedWriteFailure }
        try data.write(to: url, options: .atomic)
    }
}

private actor SendProbe {
    private var recorded: [UUID] = []
    private let failingNonce: UUID?

    init(failingNonce: UUID? = nil) {
        self.failingNonce = failingNonce
    }

    func record(_ nonce: UUID) {
        recorded.append(nonce)
    }

    func send(
        _ pending: DurablePendingTextMessage,
        snapshot: DurableConfirmedMessageSnapshot
    ) throws -> DurableConfirmedMessageSnapshot {
        recorded.append(pending.clientNonce)
        if pending.clientNonce == failingNonce { throw PersistenceTestError.injectedSendFailure }
        return snapshot
    }

    func nonces() -> [UUID] { recorded }
}

private actor IdempotentMessageServer {
    private let chatID: UUID
    private let author: Participant
    private var loseNextResponse: Bool
    private let delayNanoseconds: UInt64
    private var requests: [UUID] = []
    private var messages: [UUID: DurableConfirmedMessageSnapshot] = [:]

    init(
        chatID: UUID,
        author: Participant,
        firstResponseMustBeLost: Bool = false,
        delayNanoseconds: UInt64 = 0
    ) {
        self.chatID = chatID
        self.author = author
        loseNextResponse = firstResponseMustBeLost
        self.delayNanoseconds = delayNanoseconds
    }

    func send(_ pending: DurablePendingTextMessage) async throws -> DurableConfirmedMessageSnapshot {
        requests.append(pending.clientNonce)
        let snapshot: DurableConfirmedMessageSnapshot
        if let existing = messages[pending.clientNonce] {
            snapshot = existing
        } else {
            snapshot = DurableConfirmedMessageSnapshot(
                message: ChatMessage(
                    id: UUID(),
                    clientID: pending.clientNonce,
                    conversationID: chatID,
                    author: author,
                    text: pending.body,
                    sentAt: pending.enqueuedAt,
                    delivery: .sent,
                    isOutgoing: true
                ),
                metadata: MessageRemoteMetadata(revision: 0)
            )
            messages[pending.clientNonce] = snapshot
        }
        if delayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: delayNanoseconds)
        }
        if loseNextResponse {
            loseNextResponse = false
            throw PersistenceTestError.responseLost
        }
        return snapshot
    }

    func logicalMessageCount() -> Int { messages.count }
    func requestNonces() -> [UUID] { requests }
}

private actor SuspendedSender {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func waitUntilReleased() async {
        started = true
        let waiters = startWaiters
        startWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if released { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}
