import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class SynchronizedChatDraftStoreTests: XCTestCase {
    private let accountID = UUID(uuidString: "B650E2AB-4185-493D-81A2-BD4F19B84F0C")!
    private let replacementAccountID = UUID(uuidString: "C650E2AB-4185-493D-81A2-BD4F19B84F0D")!
    private let sessionID = UUID(uuidString: "D650E2AB-4185-493D-81A2-BD4F19B84F0E")!
    private let replacementSessionID = UUID(uuidString: "E650E2AB-4185-493D-81A2-BD4F19B84F0F")!
    private let chatID = UUID(uuidString: "9EC9347C-9306-4108-AAB4-E7762B73B201")!
    private let secondChatID = UUID(uuidString: "AEC9347C-9306-4108-AAB4-E7762B73B202")!

    func testRefreshAndLocalEditsRemainFencedPerChat() async {
        let firstChatID = chatID
        let secondChatID = secondChatID
        let store = SynchronizedChatDraftStore()
        configure(store) { chatID in
            chatID == firstChatID
                ? Self.state(chatID: firstChatID, text: "Первый", revision: 2)
                : Self.state(chatID: secondChatID, text: "Второй", revision: 4)
        }

        await store.refresh(firstChatID)
        await store.refresh(secondChatID)
        XCTAssertTrue(store.setLocalDraft(for: firstChatID, text: "Первый изменён"))

        XCTAssertEqual(store.localDraft(for: firstChatID).text, "Первый изменён")
        XCTAssertEqual(store.localDraft(for: secondChatID).text, "Второй")
        XCTAssertEqual(store.confirmedState(for: firstChatID)?.draft?.text, "Первый")
        XCTAssertEqual(store.confirmedState(for: secondChatID)?.revision, 4)
        XCTAssertEqual(store.dirtyChatIDs, [firstChatID])
    }

    func testAmbiguousFailureRetriesExactPutWithSameNonceAndCAS() async {
        let chatID = chatID
        let putter = RetryDraftPutter(chatID: chatID)
        let store = SynchronizedChatDraftStore()
        configure(store) { chatID in await putter.load(chatID: chatID) } putter: {
            chatID, command in
            try await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "Надёжный повтор"))

        let firstAttempt = await store.persist(chatID)
        let secondAttempt = await store.persist(chatID)
        XCTAssertFalse(firstAttempt)
        XCTAssertTrue(secondAttempt)

        let commands = await putter.commands
        XCTAssertEqual(commands.count, 2)
        XCTAssertEqual(commands[0], commands[1])
        XCTAssertEqual(commands[0].expectedRevision, 0)
        XCTAssertEqual(commands[0].content.text, "Надёжный повтор")
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 1)
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
        let loadCount = await putter.loadCount
        XCTAssertEqual(loadCount, 2, "An exact replay must be followed by an authoritative GET")
    }

    func testReplayedPutCannotResurrectDraftDeletedAfterOriginalCommit() async {
        let chatID = chatID
        let historicalAcknowledgement = ChatDraftMutationResult(
            state: Self.state(chatID: chatID, text: "historical", revision: 1),
            replayed: true
        )
        let loader = ScriptedDraftLoader(results: [
            .success(Self.state(chatID: chatID, text: nil, revision: 0)),
            .success(Self.state(chatID: chatID, text: nil, revision: 2)),
        ])
        let putter = FixedReplayDraftPutter(result: historicalAcknowledgement)
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(minimumIntervalNanoseconds: 0)
            }
        )
        configure(store) { chatID in try await loader.load(chatID) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "historical"))

        let accepted = await store.persist(chatID)

        XCTAssertTrue(accepted)
        XCTAssertNil(store.confirmedState(for: chatID)?.draft)
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 2)
        XCTAssertEqual(store.localDraft(for: chatID), .empty)
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
        let commands = await putter.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(Set(commands.map(\.clientNonce)).count, 1)
        let loadCount = await loader.count
        XCTAssertEqual(loadCount, 2)
    }

    func testReplayedDeleteCannotEraseDraftRecreatedAfterOriginalCommit() async {
        let chatID = chatID
        let historicalAcknowledgement = ChatDraftMutationResult(
            state: Self.state(chatID: chatID, text: nil, revision: 2),
            replayed: true
        )
        let loader = ScriptedDraftLoader(results: [
            .success(Self.state(chatID: chatID, text: "before delete", revision: 1)),
            .success(Self.state(chatID: chatID, text: "recreated", revision: 3)),
        ])
        let deleter = FixedReplayDraftDeleter(result: historicalAcknowledgement)
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(minimumIntervalNanoseconds: 0)
            }
        )
        configure(store) { chatID in try await loader.load(chatID) } deleter: {
            chatID, command in
            await deleter.delete(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: ""))

        let accepted = await store.persist(chatID)

        XCTAssertTrue(accepted)
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "recreated")
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 3)
        XCTAssertEqual(store.localDraft(for: chatID).text, "recreated")
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
        let commands = await deleter.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(Set(commands.map(\.clientNonce)).count, 1)
        let loadCount = await loader.count
        XCTAssertEqual(loadCount, 2)
    }

    func testFailedAuthoritativeGETAfterReplayRetainsExactPendingNonceForRetry() async {
        let chatID = chatID
        let replayedState = Self.state(chatID: chatID, text: "retry exact replay", revision: 1)
        let loader = ScriptedDraftLoader(results: [
            .success(Self.state(chatID: chatID, text: nil, revision: 0)),
            .failure(.transport("authoritative GET unavailable")),
            .success(replayedState),
        ])
        let putter = FixedReplayDraftPutter(result: ChatDraftMutationResult(
            state: replayedState,
            replayed: true
        ))
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(minimumIntervalNanoseconds: 0)
            }
        )
        configure(store) { chatID in try await loader.load(chatID) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "retry exact replay"))

        let firstAccepted = await store.persist(chatID)
        let retryAccepted = await store.persist(chatID)

        XCTAssertFalse(firstAccepted)
        XCTAssertTrue(retryAccepted)
        let commands = await putter.commands
        XCTAssertEqual(commands.count, 2)
        XCTAssertEqual(commands[0], commands[1])
        XCTAssertEqual(Set(commands.map(\.clientNonce)).count, 1)
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 1)
        XCTAssertEqual(store.localDraft(for: chatID).text, "retry exact replay")
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
        let loadCount = await loader.count
        XCTAssertEqual(loadCount, 3)
    }

    func testNewerLocalEditSurvivesAuthoritativeGETAfterReplay() async {
        let chatID = chatID
        let acknowledgedState = Self.state(chatID: chatID, text: "acknowledged", revision: 1)
        let loader = ReplayResolutionDraftLoader(
            initial: Self.state(chatID: chatID, text: nil, revision: 0),
            resolution: acknowledgedState
        )
        let putter = FixedReplayDraftPutter(result: ChatDraftMutationResult(
            state: acknowledgedState,
            replayed: true
        ))
        let store = SynchronizedChatDraftStore()
        configure(store) { chatID in await loader.load(chatID) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "acknowledged"))

        let save = Task { await store.persist(chatID) }
        await loader.waitUntilResolutionStarted()
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "typed while replay GET was pending"))
        await loader.releaseResolution()

        let accepted = await save.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "acknowledged")
        XCTAssertEqual(store.localDraft(for: chatID).text, "typed while replay GET was pending")
        XCTAssertTrue(store.dirtyChatIDs.contains(chatID))
    }

    func testRealtimeUpdateCancelsPendingAuthoritativeReplayGET() async {
        let chatID = chatID
        let acknowledgedState = Self.state(chatID: chatID, text: "historical", revision: 1)
        let loader = ReplayResolutionDraftLoader(
            initial: Self.state(chatID: chatID, text: nil, revision: 0),
            resolution: acknowledgedState
        )
        let putter = FixedReplayDraftPutter(result: ChatDraftMutationResult(
            state: acknowledgedState,
            replayed: true
        ))
        let store = SynchronizedChatDraftStore()
        let binding = store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: { chatID in await loader.load(chatID) },
            putter: { chatID, command in
                await putter.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "historical"))

        let save = Task { await store.persist(chatID) }
        await loader.waitUntilResolutionStarted()
        let changedAt = Date(timeIntervalSince1970: 100)
        let realtimeState = SynchronizedChatDraftState(
            draft: SynchronizedChatDraft(
                chatID: chatID,
                content: .init(text: "newer realtime"),
                revision: 2,
                updatedAt: changedAt
            ),
            revision: 2
        )
        let application = store.applyRealtime(
            ChatDraftRealtimeDispatch(
                accountID: accountID,
                chatID: chatID,
                state: realtimeState,
                changedAt: changedAt,
                sequence: 1,
                cursor: "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
            ),
            binding: binding
        )
        store.cancelScheduledPersist(for: chatID)
        await loader.releaseResolution()

        let accepted = await save.value
        XCTAssertEqual(application, .accepted)
        XCTAssertFalse(accepted)
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "newer realtime")
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 2)
    }

    func testRemovalCancelsPendingAuthoritativeReplayGETAndHardScrubsText() async {
        let chatID = chatID
        let acknowledgedState = Self.state(chatID: chatID, text: "must not return", revision: 1)
        let loader = ReplayResolutionDraftLoader(
            initial: Self.state(chatID: chatID, text: nil, revision: 0),
            resolution: acknowledgedState
        )
        let putter = FixedReplayDraftPutter(result: ChatDraftMutationResult(
            state: acknowledgedState,
            replayed: true
        ))
        let store = SynchronizedChatDraftStore()
        configure(store) { chatID in await loader.load(chatID) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "must not return"))

        let save = Task { await store.persist(chatID) }
        await loader.waitUntilResolutionStarted()
        store.removeChat(chatID)
        await loader.releaseResolution()

        let accepted = await save.value
        XCTAssertFalse(accepted)
        XCTAssertNil(store.confirmedState(for: chatID))
        XCTAssertEqual(store.localDraft(for: chatID), .empty)
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
    }

    func testSessionReplacementCancelsPendingAuthoritativeReplayGET() async {
        let chatID = chatID
        let acknowledgedState = Self.state(chatID: chatID, text: "old account secret", revision: 1)
        let loader = ReplayResolutionDraftLoader(
            initial: Self.state(chatID: chatID, text: nil, revision: 0),
            resolution: acknowledgedState
        )
        let putter = FixedReplayDraftPutter(result: ChatDraftMutationResult(
            state: acknowledgedState,
            replayed: true
        ))
        let store = SynchronizedChatDraftStore()
        configure(store) { chatID in await loader.load(chatID) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "old account secret"))

        let save = Task { await store.persist(chatID) }
        await loader.waitUntilResolutionStarted()
        configureReplacement(store) { _ in
            Self.state(chatID: chatID, text: "replacement account", revision: 1)
        }
        await loader.releaseResolution()

        let accepted = await save.value
        XCTAssertFalse(accepted)
        XCTAssertNil(store.confirmedState(for: chatID))
        XCTAssertEqual(store.localDraft(for: chatID), .empty)
    }

    func testCASConflictKeepsConfirmedAndLocalValuesWithoutDisplayingPrivatePayload() async {
        let chatID = chatID
        let privateText = "СЕКРЕТНЫЙ ТЕКСТ"
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in Self.state(chatID: chatID, text: "server", revision: 3) } putter: {
            _, _ in
            throw LuxoraAPIError.server(
                status: 409,
                code: "CONFLICT",
                message: "\(privateText) server-secret-token"
            )
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: privateText))

        let accepted = await store.persist(chatID)
        XCTAssertFalse(accepted)

        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "server")
        XCTAssertEqual(store.localDraft(for: chatID).text, privateText)
        guard case let .failed(message) = store.mutationState(for: chatID) else {
            return XCTFail("Expected visible conflict")
        }
        XCTAssertTrue(message.contains("другом устройстве"))
        XCTAssertFalse(message.contains(privateText))
        XCTAssertFalse(message.contains("token"))
    }

    func testLateLoadFromReplacedAccountAndSessionCannotPublishOrLeakText() async {
        let chatID = chatID
        let suspended = SuspendedDraftLoader(
            result: Self.state(chatID: chatID, text: "old-account-secret", revision: 9)
        )
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in await suspended.load() }
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "local-old-account-secret"))

        let oldLoad = Task { await store.refresh(chatID) }
        await suspended.waitUntilStarted()
        configureReplacement(store) { _ in
            Self.state(chatID: chatID, text: "new account", revision: 1)
        }
        XCTAssertEqual(store.localDraft(for: chatID), .empty)
        XCTAssertNil(store.confirmedState(for: chatID))

        await suspended.release()
        _ = await oldLoad.value
        XCTAssertNil(store.confirmedState(for: chatID))
        XCTAssertEqual(store.localDraft(for: chatID), .empty)

        await store.refresh(chatID)
        XCTAssertEqual(store.localDraft(for: chatID).text, "new account")
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 1)
    }

    func testNewerLocalEditSurvivesLateSuccessfulPut() async {
        let chatID = chatID
        let suspended = SuspendedDraftPutter(chatID: chatID)
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in Self.state(chatID: chatID, text: nil, revision: 0) } putter: {
            chatID, command in
            await suspended.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "sent"))

        let save = Task { await store.persist(chatID) }
        await suspended.waitUntilStarted()
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "typed later"))
        await suspended.release()
        let accepted = await save.value
        XCTAssertTrue(accepted)

        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "sent")
        XCTAssertEqual(store.localDraft(for: chatID).text, "typed later")
        XCTAssertTrue(store.dirtyChatIDs.contains(chatID))
    }

    func testDebounceCoalescesEditsIntoOneLatestCommand() async throws {
        let chatID = chatID
        let putter = RecordingDraftPutter(chatID: chatID)
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in Self.state(chatID: chatID, text: nil, revision: 0) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)

        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "п"))
        store.schedulePersist(chatID, debounceNanoseconds: 30_000_000)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "последний"))
        store.schedulePersist(chatID, debounceNanoseconds: 30_000_000)
        try await Task.sleep(nanoseconds: 150_000_000)

        let commands = await putter.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands.first?.content.text, "последний")
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "последний")
    }

    func testEarlyTypingBeforeInitialGETReschedulesExactlyOnePutAfterLoad() async throws {
        let chatID = chatID
        let suspended = SuspendedDraftLoader(
            result: Self.state(chatID: chatID, text: nil, revision: 0)
        )
        let putter = RecordingDraftPutter(chatID: chatID)
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in await suspended.load() } putter: { receivedChatID, command in
            await putter.put(chatID: receivedChatID, command: command)
        }

        let load = Task { await store.refresh(chatID) }
        await suspended.waitUntilStarted()
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "typed before GET"))
        store.schedulePersist(chatID, debounceNanoseconds: 10_000_000)
        try await Task.sleep(nanoseconds: 40_000_000)
        let beforeLoadCount = await putter.commands.count
        XCTAssertEqual(beforeLoadCount, 0)
        XCTAssertEqual(store.mutationState(for: chatID), .idle)
        XCTAssertEqual(store.loadState(for: chatID), .loading)

        await suspended.release()
        _ = await load.value
        try await Task.sleep(nanoseconds: 550_000_000)

        let commands = await putter.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands[0].content.text, "typed before GET")
        XCTAssertEqual(commands[0].expectedRevision, 0)
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "typed before GET")
    }

    func testLogoutCancelsDebounceAndClearsEveryAccountScopedValue() async throws {
        let chatID = chatID
        let putter = RecordingDraftPutter(chatID: chatID)
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in Self.state(chatID: chatID, text: nil, revision: 0) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "must disappear"))
        store.schedulePersist(chatID, debounceNanoseconds: 80_000_000)

        configureReplacement(store) { _ in Self.state(chatID: chatID, text: nil, revision: 0) }
        try await Task.sleep(nanoseconds: 150_000_000)

        let commandCount = await putter.commands.count
        XCTAssertEqual(commandCount, 0)
        XCTAssertEqual(store.localDraft(for: chatID), .empty)
        XCTAssertTrue(store.confirmedStates.isEmpty)
        XCTAssertTrue(store.dirtyChatIDs.isEmpty)
    }

    func testEmptyLocalContentDeletesActiveDraftAndAcceptsTombstoneRevision() async {
        let chatID = chatID
        let deleter = RecordingDraftDeleter()
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in Self.state(chatID: chatID, text: "remove", revision: 3) } deleter: {
            chatID, command in
            await deleter.delete(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: ""))

        let accepted = await store.persist(chatID)
        XCTAssertTrue(accepted)

        let commands = await deleter.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands[0].expectedRevision, 3)
        XCTAssertNil(store.confirmedState(for: chatID)?.draft)
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 4)
        XCTAssertEqual(store.localDraft(for: chatID), .empty)
    }

    func testChatUnavailableErasesPrivateLocalProjection() async {
        let chatID = chatID
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in
            throw LuxoraAPIError.server(
                status: 404,
                code: "NOT_FOUND",
                message: "private server details"
            )
        }
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "private local details"))

        await store.refresh(chatID)

        XCTAssertEqual(store.localDraft(for: chatID), .empty)
        XCTAssertNil(store.confirmedState(for: chatID))
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
        guard case let .failed(message) = store.loadState(for: chatID) else {
            return XCTFail("Expected unavailable state")
        }
        XCTAssertFalse(message.contains("private"))
    }

    func testOverLimitLocalDraftNeverCallsRemoteMutation() async {
        let chatID = chatID
        let putter = RecordingDraftPutter(chatID: chatID)
        let store = SynchronizedChatDraftStore()
        configure(store) { _ in Self.state(chatID: chatID, text: nil, revision: 0) } putter: {
            chatID, command in
            await putter.put(chatID: chatID, command: command)
        }
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(
            for: chatID,
            text: String(repeating: "💎", count: 10_001)
        ))

        let accepted = await store.persist(chatID)
        let commandCount = await putter.commands.count
        XCTAssertFalse(accepted)
        XCTAssertEqual(commandCount, 0)
        XCTAssertTrue(store.dirtyChatIDs.contains(chatID))
    }

    func testAccountGlobalPacerCoalescesBurstToLatestAndSpacesChatMutations() async throws {
        let firstChatID = chatID
        let secondChatID = secondChatID
        let clock = DraftPacingTestClock()
        let recorder = TimedDraftPutter(clock: clock)
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(
                    minimumIntervalNanoseconds: 750_000_000,
                    now: { await clock.current() },
                    sleep: { try await clock.sleep($0) }
                )
            }
        )
        store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: { chatID in Self.state(chatID: chatID, text: nil, revision: 0) },
            putter: { chatID, command in
                try await recorder.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        await store.refresh(firstChatID)
        await store.refresh(secondChatID)

        XCTAssertTrue(store.setLocalDraft(for: firstChatID, text: "п"))
        store.schedulePersist(firstChatID, debounceNanoseconds: 30_000_000)
        XCTAssertTrue(store.setLocalDraft(for: firstChatID, text: "по"))
        store.schedulePersist(firstChatID, debounceNanoseconds: 30_000_000)
        XCTAssertTrue(store.setLocalDraft(for: firstChatID, text: "последний A"))
        store.schedulePersist(firstChatID, debounceNanoseconds: 30_000_000)
        XCTAssertTrue(store.setLocalDraft(for: secondChatID, text: "последний B"))
        store.schedulePersist(secondChatID, debounceNanoseconds: 30_000_000)
        try await Task.sleep(nanoseconds: 200_000_000)

        let calls = await recorder.calls.sorted { $0.startedAt < $1.startedAt }
        XCTAssertEqual(calls.count, 2, "There is no per-keystroke network queue")
        XCTAssertEqual(Set(calls.map(\.command.content.text)), ["последний A", "последний B"])
        XCTAssertGreaterThanOrEqual(
            calls[1].startedAt - calls[0].startedAt,
            ChatDraftMutationPacer.productionMinimumIntervalNanoseconds
        )
    }

    func testRateLimitGlobalFloorSurvivesEditAndSendsOnlyLatestAfterDeadline() async {
        let chatID = chatID
        let clock = DraftPacingTestClock()
        let putter = RateLimitedTimedDraftPutter(clock: clock, retryAfterSeconds: 10)
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(
                    minimumIntervalNanoseconds: 750_000_000,
                    now: { await clock.current() },
                    sleep: { try await clock.sleep($0) }
                )
            }
        )
        store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: { _ in Self.state(chatID: chatID, text: nil, revision: 0) },
            putter: { chatID, command in
                try await putter.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "before limit"))
        let firstAccepted = await store.persist(chatID)
        XCTAssertFalse(firstAccepted)

        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "latest after edit"))
        let latestAccepted = await store.persist(chatID)
        XCTAssertTrue(latestAccepted)

        let calls = await putter.calls
        XCTAssertEqual(calls.map(\.command.content.text), ["before limit", "latest after edit"])
        XCTAssertGreaterThanOrEqual(calls[1].startedAt, 10_000_000_000)
        XCTAssertNotEqual(calls[0].command.clientNonce, calls[1].command.clientNonce)
    }

    func testRateLimitedExactCommandRetriesWithStableNonceAfterGlobalFloor() async {
        let chatID = chatID
        let clock = DraftPacingTestClock()
        let putter = RateLimitedTimedDraftPutter(clock: clock, retryAfterSeconds: 4)
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(
                    now: { await clock.current() },
                    sleep: { try await clock.sleep($0) }
                )
            }
        )
        store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: { _ in Self.state(chatID: chatID, text: nil, revision: 0) },
            putter: { chatID, command in
                try await putter.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "same intent"))

        let firstAccepted = await store.persist(chatID)
        let retryAccepted = await store.persist(chatID)
        XCTAssertFalse(firstAccepted)
        XCTAssertTrue(retryAccepted)

        let calls = await putter.calls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].command, calls[1].command)
        XCTAssertGreaterThanOrEqual(calls[1].startedAt, 4_000_000_000)
    }

    func testSessionReplacementCancelsQueuedPacerWithoutCarryingDelayToNewAccount() async {
        let firstChatID = chatID
        let secondChatID = secondChatID
        let clock = SuspendedDraftPacingClock()
        let oldPutter = RecordingDraftPutter(chatID: firstChatID)
        let newPutter = RecordingDraftPutter(chatID: firstChatID)
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(
                    now: { await clock.current() },
                    sleep: { try await clock.sleep($0) }
                )
            }
        )
        configure(store) { chatID in
            Self.state(chatID: chatID, text: nil, revision: 0)
        } putter: { chatID, command in
            await oldPutter.put(chatID: chatID, command: command)
        }
        await store.refresh(firstChatID)
        await store.refresh(secondChatID)
        XCTAssertTrue(store.setLocalDraft(for: firstChatID, text: "first old"))
        let firstOldAccepted = await store.persist(firstChatID)
        XCTAssertTrue(firstOldAccepted)
        XCTAssertTrue(store.setLocalDraft(for: secondChatID, text: "queued old"))
        let queuedOld = Task { await store.persist(secondChatID) }
        await clock.waitUntilSleeping()

        store.configureRemote(
            accountID: replacementAccountID,
            sessionID: replacementSessionID,
            loader: { _ in Self.state(chatID: firstChatID, text: nil, revision: 0) },
            putter: { chatID, command in
                await newPutter.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        await store.refresh(firstChatID)
        XCTAssertTrue(store.setLocalDraft(for: firstChatID, text: "new account"))
        let newAccepted = await store.persist(firstChatID)
        let queuedOldAccepted = await queuedOld.value
        let oldCommands = await oldPutter.commands
        let newCommands = await newPutter.commands
        let currentTime = await clock.current()
        XCTAssertTrue(newAccepted)
        XCTAssertFalse(queuedOldAccepted)
        XCTAssertEqual(oldCommands.count, 1)
        XCTAssertEqual(newCommands.map(\.content.text), ["new account"])
        XCTAssertEqual(currentTime, 0, "New account received an immediate first permit")
    }

    func testGapRecoveryInvalidatesCleanPreservesDirtyAndRefreshesLazily() async {
        let firstChatID = chatID
        let secondChatID = secondChatID
        let loader = MutableDraftLoader(states: [
            firstChatID: Self.state(chatID: firstChatID, text: "stale clean", revision: 2),
            secondChatID: Self.state(chatID: secondChatID, text: "stale base", revision: 3),
        ])
        let store = SynchronizedChatDraftStore()
        configure(store) { chatID in try await loader.load(chatID) }
        await store.refresh(firstChatID)
        await store.refresh(secondChatID)
        XCTAssertTrue(store.setLocalDraft(for: secondChatID, text: "private dirty"))
        await loader.replace([
            firstChatID: Self.state(chatID: firstChatID, text: "fresh clean", revision: 4),
            secondChatID: Self.state(chatID: secondChatID, text: "remote moved", revision: 5),
        ])

        let plan = store.prepareForRecovery(retainedChatIDs: [firstChatID, secondChatID])

        XCTAssertEqual(plan.cleanInvalidatedChatIDs, [firstChatID])
        XCTAssertEqual(plan.dirtyPreservedChatIDs, [secondChatID])
        XCTAssertNil(store.confirmedState(for: firstChatID))
        XCTAssertEqual(store.localDraft(for: firstChatID), .empty)
        XCTAssertNil(store.confirmedState(for: secondChatID))
        XCTAssertEqual(store.localDraft(for: secondChatID).text, "private dirty")
        let prematurePersist = await store.persist(secondChatID)
        XCTAssertFalse(prematurePersist)
        XCTAssertEqual(store.mutationState(for: secondChatID), .idle)

        let firstRefreshed = await store.refresh(firstChatID, force: true)
        XCTAssertTrue(firstRefreshed)
        XCTAssertEqual(store.confirmedState(for: firstChatID)?.draft?.text, "fresh clean")
        XCTAssertNil(store.confirmedState(for: secondChatID))
        let secondRefreshed = await store.refresh(secondChatID, force: true)
        XCTAssertTrue(secondRefreshed)
        store.cancelScheduledPersist(for: secondChatID)
        XCTAssertEqual(store.confirmedState(for: secondChatID)?.revision, 5)
        XCTAssertEqual(store.localDraft(for: secondChatID).text, "private dirty")
        XCTAssertTrue(store.dirtyChatIDs.contains(secondChatID))
    }

    func testCompleted429InstallsGlobalFloorEvenWhenRecoveryFencedItsChatAttempt() async {
        let chatID = chatID
        let clock = DraftPacingTestClock()
        let putter = SuspendedRateLimitedDraftPutter(
            clock: clock,
            retryAfterSeconds: 12
        )
        let store = SynchronizedChatDraftStore(
            mutationPacerFactory: {
                ChatDraftMutationPacer(
                    now: { await clock.current() },
                    sleep: { try await clock.sleep($0) }
                )
            }
        )
        store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: { _ in Self.state(chatID: chatID, text: nil, revision: 0) },
            putter: { chatID, command in
                try await putter.put(chatID: chatID, command: command)
            },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        await store.refresh(chatID)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "dirty across recovery"))
        let firstSave = Task { await store.persist(chatID) }
        await putter.waitUntilStarted()

        _ = store.prepareForRecovery(retainedChatIDs: [chatID])
        await putter.releaseRateLimit()
        let firstAccepted = await firstSave.value
        XCTAssertFalse(firstAccepted)
        let refreshed = await store.refresh(chatID, force: true)
        store.cancelScheduledPersist(for: chatID)
        XCTAssertTrue(refreshed)

        let secondAccepted = await store.persist(chatID)
        let calls = await putter.calls
        XCTAssertTrue(secondAccepted)
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].command, calls[1].command)
        XCTAssertGreaterThanOrEqual(calls[1].startedAt, 12_000_000_000)
    }

    func testGapWith301RetainedChatsPerformsNoEagerGETAndOnlySelectedRefresh() async {
        let retained = Set((0..<301).map { _ in UUID() })
        let selected = retained.first!
        let loader = CountingDraftLoader()
        let store = SynchronizedChatDraftStore()
        configure(store) { chatID in await loader.load(chatID) }

        let plan = store.prepareForRecovery(retainedChatIDs: retained)

        XCTAssertEqual(plan.cleanInvalidatedChatIDs.count, 301)
        let eagerCount = await loader.count
        let selectedRefreshed = await store.refresh(selected, force: true)
        let selectedCount = await loader.count
        XCTAssertEqual(eagerCount, 0)
        XCTAssertTrue(selectedRefreshed)
        XCTAssertEqual(selectedCount, 1)
        XCTAssertEqual(store.loadState(for: retained.first { $0 != selected }!), .idle)
    }

    private func configure(
        _ store: SynchronizedChatDraftStore,
        loader: @escaping SynchronizedChatDraftStore.Loader,
        putter: @escaping SynchronizedChatDraftStore.Putter = { _, _ in
            throw LuxoraAPIError.invalidResponse
        },
        deleter: @escaping SynchronizedChatDraftStore.Deleter = { _, _ in
            throw LuxoraAPIError.invalidResponse
        }
    ) {
        store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: loader,
            putter: putter,
            deleter: deleter
        )
    }

    private func configureReplacement(
        _ store: SynchronizedChatDraftStore,
        loader: @escaping SynchronizedChatDraftStore.Loader
    ) {
        store.configureRemote(
            accountID: replacementAccountID,
            sessionID: replacementSessionID,
            loader: loader,
            putter: { _, _ in throw LuxoraAPIError.invalidResponse },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
    }

    private nonisolated static func state(
        chatID: UUID,
        text: String?,
        revision: Int
    ) -> SynchronizedChatDraftState {
        let draft = text.map {
            SynchronizedChatDraft(
                chatID: chatID,
                content: .init(text: $0),
                revision: revision,
                updatedAt: Date(timeIntervalSince1970: TimeInterval(revision + 1))
            )
        }
        return SynchronizedChatDraftState(draft: draft, revision: revision)
    }
}

private actor RetryDraftPutter {
    let chatID: UUID
    private(set) var commands: [ChatDraftPutCommand] = []
    private(set) var loadCount = 0
    private var committedState: SynchronizedChatDraftState?

    init(chatID: UUID) { self.chatID = chatID }

    func load(chatID: UUID) -> SynchronizedChatDraftState {
        loadCount += 1
        return committedState ?? SynchronizedChatDraftState(draft: nil, revision: 0)
    }

    func put(chatID: UUID, command: ChatDraftPutCommand) throws -> ChatDraftMutationResult {
        commands.append(command)
        let state = SynchronizedChatDraftState(
            draft: SynchronizedChatDraft(
                chatID: chatID,
                content: command.content,
                revision: command.expectedRevision + 1,
                updatedAt: Date(timeIntervalSince1970: 10)
            ),
            revision: command.expectedRevision + 1
        )
        committedState = state
        if commands.count == 1 {
            throw LuxoraAPIError.transport("response lost with private body")
        }
        return ChatDraftMutationResult(
            state: state,
            replayed: true
        )
    }
}

private actor ScriptedDraftLoader {
    private var results: [Result<SynchronizedChatDraftState, LuxoraAPIError>]
    private(set) var count = 0

    init(results: [Result<SynchronizedChatDraftState, LuxoraAPIError>]) {
        self.results = results
    }

    func load(_ chatID: UUID) throws -> SynchronizedChatDraftState {
        _ = chatID
        count += 1
        guard !results.isEmpty else { throw LuxoraAPIError.invalidResponse }
        return try results.removeFirst().get()
    }
}

private actor FixedReplayDraftPutter {
    private let result: ChatDraftMutationResult
    private(set) var commands: [ChatDraftPutCommand] = []

    init(result: ChatDraftMutationResult) { self.result = result }

    func put(chatID: UUID, command: ChatDraftPutCommand) -> ChatDraftMutationResult {
        _ = chatID
        commands.append(command)
        return result
    }
}

private actor FixedReplayDraftDeleter {
    private let result: ChatDraftMutationResult
    private(set) var commands: [ChatDraftDeleteCommand] = []

    init(result: ChatDraftMutationResult) { self.result = result }

    func delete(chatID: UUID, command: ChatDraftDeleteCommand) -> ChatDraftMutationResult {
        _ = chatID
        commands.append(command)
        return result
    }
}

private actor ReplayResolutionDraftLoader {
    private let initial: SynchronizedChatDraftState
    private let resolution: SynchronizedChatDraftState
    private var count = 0
    private var resolutionStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(initial: SynchronizedChatDraftState, resolution: SynchronizedChatDraftState) {
        self.initial = initial
        self.resolution = resolution
    }

    func load(_ chatID: UUID) async -> SynchronizedChatDraftState {
        _ = chatID
        count += 1
        guard count > 1 else { return initial }
        resolutionStarted = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return resolution
    }

    func waitUntilResolutionStarted() async {
        guard !resolutionStarted else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func releaseResolution() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor RecordingDraftPutter {
    let chatID: UUID
    private(set) var commands: [ChatDraftPutCommand] = []

    init(chatID: UUID) { self.chatID = chatID }

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

private actor RecordingDraftDeleter {
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

private actor SuspendedDraftLoader {
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

private actor SuspendedDraftPutter {
    private let chatID: UUID
    private var command: ChatDraftPutCommand?
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(chatID: UUID) { self.chatID = chatID }

    func put(chatID: UUID, command: ChatDraftPutCommand) async -> ChatDraftMutationResult {
        self.command = command
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        let revision = command.expectedRevision + 1
        return ChatDraftMutationResult(
            state: SynchronizedChatDraftState(
                draft: SynchronizedChatDraft(
                    chatID: chatID,
                    content: command.content,
                    revision: revision,
                    updatedAt: Date(timeIntervalSince1970: 20)
                ),
                revision: revision
            ),
            replayed: false
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

private actor DraftPacingTestClock {
    private var nowNanoseconds: UInt64 = 0
    private(set) var requestedSleeps: [UInt64] = []

    func current() -> UInt64 { nowNanoseconds }

    func sleep(_ nanoseconds: UInt64) throws {
        requestedSleeps.append(nanoseconds)
        nowNanoseconds = nowNanoseconds.addingReportingOverflow(nanoseconds).overflow
            ? UInt64.max
            : nowNanoseconds + nanoseconds
    }
}

private actor SuspendedDraftPacingClock {
    private var sleepWaiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    private var startWaiters: [CheckedContinuation<Void, Never>] = []

    func current() -> UInt64 { 0 }

    func sleep(_ nanoseconds: UInt64) async throws {
        _ = nanoseconds
        let waiterID = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                sleepWaiters[waiterID] = continuation
                startWaiters.forEach { $0.resume() }
                startWaiters.removeAll()
            }
        } onCancel: {
            Task { await self.cancel(waiterID) }
        }
    }

    func waitUntilSleeping() async {
        guard sleepWaiters.isEmpty else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    private func cancel(_ waiterID: UUID) {
        sleepWaiters.removeValue(forKey: waiterID)?.resume(throwing: CancellationError())
    }
}

private struct TimedDraftPutCall: Sendable {
    let chatID: UUID
    let command: ChatDraftPutCommand
    let startedAt: UInt64
}

private actor TimedDraftPutter {
    private let clock: DraftPacingTestClock
    private(set) var calls: [TimedDraftPutCall] = []

    init(clock: DraftPacingTestClock) { self.clock = clock }

    func put(
        chatID: UUID,
        command: ChatDraftPutCommand
    ) async throws -> ChatDraftMutationResult {
        calls.append(TimedDraftPutCall(
            chatID: chatID,
            command: command,
            startedAt: await clock.current()
        ))
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

private actor RateLimitedTimedDraftPutter {
    private let clock: DraftPacingTestClock
    private let retryAfterSeconds: Int
    private(set) var calls: [TimedDraftPutCall] = []

    init(clock: DraftPacingTestClock, retryAfterSeconds: Int) {
        self.clock = clock
        self.retryAfterSeconds = retryAfterSeconds
    }

    func put(
        chatID: UUID,
        command: ChatDraftPutCommand
    ) async throws -> ChatDraftMutationResult {
        calls.append(TimedDraftPutCall(
            chatID: chatID,
            command: command,
            startedAt: await clock.current()
        ))
        if calls.count == 1 {
            throw ChatDraftRateLimitError(retryAfterSeconds: retryAfterSeconds)
        }
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

private actor SuspendedRateLimitedDraftPutter {
    private let clock: DraftPacingTestClock
    private let retryAfterSeconds: Int
    private(set) var calls: [TimedDraftPutCall] = []
    private var firstStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(clock: DraftPacingTestClock, retryAfterSeconds: Int) {
        self.clock = clock
        self.retryAfterSeconds = retryAfterSeconds
    }

    func put(
        chatID: UUID,
        command: ChatDraftPutCommand
    ) async throws -> ChatDraftMutationResult {
        calls.append(TimedDraftPutCall(
            chatID: chatID,
            command: command,
            startedAt: await clock.current()
        ))
        if calls.count == 1 {
            firstStarted = true
            startWaiters.forEach { $0.resume() }
            startWaiters.removeAll()
            await withCheckedContinuation { releaseWaiters.append($0) }
            throw ChatDraftRateLimitError(retryAfterSeconds: retryAfterSeconds)
        }
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

    func waitUntilStarted() async {
        guard !firstStarted else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func releaseRateLimit() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor MutableDraftLoader {
    private var states: [UUID: SynchronizedChatDraftState]

    init(states: [UUID: SynchronizedChatDraftState]) { self.states = states }

    func load(_ chatID: UUID) throws -> SynchronizedChatDraftState {
        guard let state = states[chatID] else { throw LuxoraAPIError.invalidResponse }
        return state
    }

    func replace(_ states: [UUID: SynchronizedChatDraftState]) {
        self.states = states
    }
}

private actor CountingDraftLoader {
    private(set) var count = 0

    func load(_ chatID: UUID) -> SynchronizedChatDraftState {
        count += 1
        return SynchronizedChatDraftState(draft: nil, revision: 0)
    }
}
