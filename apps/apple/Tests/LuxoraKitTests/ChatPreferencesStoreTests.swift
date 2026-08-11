import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class ChatPreferencesStoreTests: XCTestCase {
    private let accountID = UUID(uuidString: "C1000000-0000-4000-8000-000000000001")!
    private let replacementAccountID = UUID(uuidString: "C2000000-0000-4000-8000-000000000002")!
    private let primaryChatID = UUID(uuidString: "B1000000-0000-4000-8000-000000000001")!
    private let secondaryChatID = UUID(uuidString: "B2000000-0000-4000-8000-000000000002")!

    func testRefreshPublishesOnlyServerProjectionForRequestedChat() async {
        let expected = Self.preferences(archived: true, muteOffset: 7_200)
        let primaryChatID = primaryChatID
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { chatID in
                XCTAssertEqual(chatID, primaryChatID)
                return expected
            },
            updater: { _, _ in expected }
        )

        await store.refresh(primaryChatID)

        XCTAssertEqual(store.preferences(for: primaryChatID), expected)
        XCTAssertEqual(store.loadState(for: primaryChatID), .loaded)
        XCTAssertNil(store.preferences(for: secondaryChatID))
    }

    func testMutationKeepsConfirmedStateUntilServerResponds() async {
        let initial = Self.preferences(archived: false, muteOffset: nil)
        let updated = Self.preferences(archived: true, muteOffset: 3_600)
        let suspension = SuspendedChatPreferenceUpdate(result: updated)
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in initial },
            updater: { chatID, patch in
                try await suspension.update(chatID: chatID, patch: patch)
            }
        )
        await store.refresh(primaryChatID)

        let patch = ChatPreferencesPatch(
            archived: true,
            mutedUntil: .until(Date(timeIntervalSince1970: 3_600))
        )
        let task = Task { await store.update(primaryChatID, patch: patch) }
        await suspension.waitUntilStarted()

        XCTAssertEqual(store.preferences(for: primaryChatID), initial)
        XCTAssertEqual(store.mutationState(for: primaryChatID), .loading)

        await suspension.release()
        let accepted = await task.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.preferences(for: primaryChatID), updated)
        XCTAssertEqual(store.mutationState(for: primaryChatID), .loaded)
        let captured = await suspension.captured
        XCTAssertEqual(captured.chatID, primaryChatID)
        XCTAssertEqual(captured.patch, patch)
    }

    func testFailedPatchKeepsConfirmedStateAndExactRetryCanRecover() async {
        let initial = Self.preferences(archived: false, muteOffset: nil)
        let recovered = Self.preferences(archived: true, muteOffset: nil)
        let updater = RetryChatPreferenceUpdater(recovered: recovered)
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in initial },
            updater: { chatID, patch in
                try await updater.update(chatID: chatID, patch: patch)
            }
        )
        await store.refresh(primaryChatID)
        let patch = ChatPreferencesPatch(archived: true)

        let rejected = await store.update(primaryChatID, patch: patch)
        XCTAssertFalse(rejected)
        XCTAssertEqual(store.preferences(for: primaryChatID), initial)
        guard case let .failed(message) = store.mutationState(for: primaryChatID) else {
            return XCTFail("Expected visible mutation failure")
        }
        XCTAssertTrue(message.contains("сервером") || message.contains("Сервер"))

        let accepted = await store.update(primaryChatID, patch: patch)
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.preferences(for: primaryChatID), recovered)
        let patches = await updater.patches
        XCTAssertEqual(patches, [patch, patch])
    }

    func testCancelRemoteOperationsFencesNonCooperativeLateLoad() async {
        let initial = Self.preferences(archived: false, muteOffset: nil)
        let late = Self.preferences(archived: true, muteOffset: 9_000)
        let loader = SequencedChatPreferencesLoader(first: initial, suspended: late)
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in await loader.load() },
            updater: { _, _ in late }
        )
        await store.refresh(primaryChatID)

        let task = Task { await store.refresh(primaryChatID, force: true) }
        await loader.waitUntilSuspendedStarted()
        store.cancelRemoteOperations()
        await loader.releaseSuspended()
        await task.value

        XCTAssertEqual(store.preferences(for: primaryChatID), initial)
        XCTAssertEqual(store.loadState(for: primaryChatID), .loaded)
    }

    func testSessionReplacementClearsOldProjectionAndFencesLateResponse() async {
        let initial = Self.preferences(archived: false, muteOffset: nil)
        let lateOldSession = Self.preferences(archived: true, muteOffset: 10_000)
        let newSession = Self.preferences(archived: false, muteOffset: 20_000)
        let oldLoader = SequencedChatPreferencesLoader(first: initial, suspended: lateOldSession)
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in await oldLoader.load() },
            updater: { _, _ in lateOldSession }
        )
        await store.refresh(primaryChatID)

        let oldTask = Task { await store.refresh(primaryChatID, force: true) }
        await oldLoader.waitUntilSuspendedStarted()
        store.configureRemote(
            accountID: replacementAccountID,
            loader: { _ in newSession },
            updater: { _, _ in newSession }
        )
        XCTAssertNil(store.preferences(for: primaryChatID))

        await oldLoader.releaseSuspended()
        await oldTask.value
        XCTAssertNil(store.preferences(for: primaryChatID))

        await store.refresh(primaryChatID)
        XCTAssertEqual(store.preferences(for: primaryChatID), newSession)
    }

    func testUnauthorizedMutationClearsEveryConfirmedAccountProjection() async {
        let initial = Self.preferences(archived: false, muteOffset: nil)
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in initial },
            updater: { _, _ in
                throw LuxoraAPIError.server(
                    status: 401,
                    code: "UNAUTHORIZED",
                    message: "expired"
                )
            }
        )
        await store.refresh(primaryChatID)
        await store.refresh(secondaryChatID)

        let accepted = await store.update(
            primaryChatID,
            patch: .init(mutedUntil: .unmuted)
        )
        XCTAssertFalse(accepted)
        XCTAssertTrue(store.confirmed.isEmpty)
        guard case let .failed(message) = store.mutationState(for: primaryChatID) else {
            return XCTFail("Expected expired-session mutation state")
        }
        XCTAssertTrue(message.contains("Сеанс истёк"))
        XCTAssertEqual(store.loadState(for: primaryChatID), .failed(message))
        XCTAssertEqual(store.loadState(for: secondaryChatID), .idle)
    }

    func testLateUnauthorizedFromReplacedSessionCannotClearNewSessionProjection() async {
        let oldLoader = SuspendedUnauthorizedChatPreferencesLoader()
        let newSession = Self.preferences(archived: true, muteOffset: 30_000)
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in try await oldLoader.load() },
            updater: { _, _ in newSession }
        )

        let oldTask = Task { await store.refresh(primaryChatID) }
        await oldLoader.waitUntilStarted()
        store.configureRemote(
            accountID: replacementAccountID,
            loader: { _ in newSession },
            updater: { _, _ in newSession }
        )
        await store.refresh(primaryChatID)
        XCTAssertEqual(store.preferences(for: primaryChatID), newSession)

        await oldLoader.release()
        await oldTask.value
        XCTAssertEqual(store.preferences(for: primaryChatID), newSession)
        XCTAssertEqual(store.loadState(for: primaryChatID), .loaded)
    }

    func testCancellingCallerFencesNonCooperativeUnauthorizedResponse() async {
        let loader = SuspendedUnauthorizedChatPreferencesLoader()
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in try await loader.load() },
            updater: { _, _ in Self.preferences(archived: false, muteOffset: nil) }
        )

        let request = Task { await store.refresh(primaryChatID) }
        await loader.waitUntilStarted()
        request.cancel()
        await loader.release()
        await request.value

        XCTAssertTrue(store.confirmed.isEmpty)
        XCTAssertEqual(store.loadState(for: primaryChatID), .idle)
    }

    func testEmptyPatchNeverCallsRemoteUpdater() async {
        let probe = ChatPreferenceCallProbe()
        let store = ChatPreferencesStore()
        store.configureRemote(
            accountID: accountID,
            loader: { _ in Self.preferences(archived: false, muteOffset: nil) },
            updater: { _, _ in
                await probe.record()
                return Self.preferences(archived: true, muteOffset: nil)
            }
        )

        let accepted = await store.update(primaryChatID, patch: .init())
        XCTAssertFalse(accepted)
        let updateCount = await probe.count
        XCTAssertEqual(updateCount, 0)
        XCTAssertNil(store.preferences(for: primaryChatID))
    }

    func testMuteAndArchiveDerivedStateUsesExplicitReferenceTime() {
        let archivedAndMuted = ChatPreferences(
            archivedAt: Date(timeIntervalSince1970: 10),
            mutedUntil: Date(timeIntervalSince1970: 20)
        )
        XCTAssertTrue(archivedAndMuted.isArchived)
        XCTAssertTrue(archivedAndMuted.isMuted(at: Date(timeIntervalSince1970: 19)))
        XCTAssertFalse(archivedAndMuted.isMuted(at: Date(timeIntervalSince1970: 20)))

        let active = ChatPreferences(archivedAt: nil, mutedUntil: nil)
        XCTAssertFalse(active.isArchived)
        XCTAssertFalse(active.isMuted(at: Date(timeIntervalSince1970: 0)))
    }

    private nonisolated static func preferences(
        archived: Bool,
        muteOffset: TimeInterval?
    ) -> ChatPreferences {
        ChatPreferences(
            archivedAt: archived ? Date(timeIntervalSince1970: 1_000) : nil,
            mutedUntil: muteOffset.map { Date(timeIntervalSince1970: $0) }
        )
    }
}

private actor SuspendedChatPreferenceUpdate {
    struct Captured: Sendable {
        let chatID: UUID?
        let patch: ChatPreferencesPatch?
    }

    private let result: ChatPreferences
    private var chatID: UUID?
    private var patch: ChatPreferencesPatch?
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(result: ChatPreferences) { self.result = result }

    func update(chatID: UUID, patch: ChatPreferencesPatch) async throws -> ChatPreferences {
        self.chatID = chatID
        self.patch = patch
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

    var captured: Captured { Captured(chatID: chatID, patch: patch) }
}

private actor RetryChatPreferenceUpdater {
    private let recovered: ChatPreferences
    private var shouldFail = true
    private(set) var patches: [ChatPreferencesPatch] = []

    init(recovered: ChatPreferences) { self.recovered = recovered }

    func update(chatID: UUID, patch: ChatPreferencesPatch) throws -> ChatPreferences {
        patches.append(patch)
        if shouldFail {
            shouldFail = false
            throw LuxoraAPIError.server(status: 503, code: "UNAVAILABLE", message: "unavailable")
        }
        return recovered
    }
}

private actor SequencedChatPreferencesLoader {
    private let first: ChatPreferences
    private let suspended: ChatPreferences
    private var loadCount = 0
    private var suspendedStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(first: ChatPreferences, suspended: ChatPreferences) {
        self.first = first
        self.suspended = suspended
    }

    func load() async -> ChatPreferences {
        loadCount += 1
        guard loadCount > 1 else { return first }
        suspendedStarted = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return suspended
    }

    func waitUntilSuspendedStarted() async {
        guard !suspendedStarted else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func releaseSuspended() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor ChatPreferenceCallProbe {
    private(set) var count = 0
    func record() { count += 1 }
}

private actor SuspendedUnauthorizedChatPreferencesLoader {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func load() async throws -> ChatPreferences {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        throw LuxoraAPIError.server(
            status: 401,
            code: "UNAUTHORIZED",
            message: "expired old session"
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
