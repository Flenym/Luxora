import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class ScopedRealtimePostAwaitFenceTests: XCTestCase {
    func testSuspendedAccountACursorCommitCannotPublishIntoReplacementAccountB() async throws {
        let suspendedCommit = SuspendedScopedCursorCommit()
        var activeAccount = "A"
        var visibleSequence = 4
        var visibleCursor = "account-b-cursor"
        var visibleState = "account-b-state"

        let accountATask = Task {
            try await ScopedRealtimePostAwaitFence.run {
                await suspendedCommit.commit("account-a-cursor")
            } stillOwnsSession: {
                activeAccount == "A"
            } publish: {
                visibleSequence = 99
                visibleCursor = "account-a-cursor"
                visibleState = "account-a-state"
            }
        }
        await suspendedCommit.waitUntilStarted()

        // ApplicationSession installs B while A is awaiting its coordinator.
        activeAccount = "B"
        visibleSequence = 12
        visibleCursor = "account-b-cursor"
        visibleState = "account-b-state"
        await suspendedCommit.release()

        let accountAStillOwned = try await accountATask.value
        XCTAssertFalse(accountAStillOwned)
        XCTAssertEqual(visibleSequence, 12)
        XCTAssertEqual(visibleCursor, "account-b-cursor")
        XCTAssertEqual(visibleState, "account-b-state")
        let committedCursor = await suspendedCommit.committedCursor
        XCTAssertEqual(committedCursor, "account-a-cursor")
    }

    func testCancelledSameSessionFolderRefreshCannotReachCursorCommit() async throws {
        let refresh = SuspendedSameSessionFolderRefresh()
        let cursorCommit = SameSessionCursorCommitProbe()

        let oldRealtimeTask = Task {
            await refresh.loadIgnoringCancellation()
            guard ScopedRealtimePostAwaitFence.isActive(stillOwnsSession: { true }) else {
                return false
            }
            cursorCommit.commit()
            return true
        }
        await refresh.waitUntilStarted()

        // `retryRealtime()` cancels A but intentionally reuses the same
        // coordinator/stores/bindings for B. Identity-only checks stay true.
        oldRealtimeTask.cancel()
        await refresh.release()

        let oldTaskCommitted = await oldRealtimeTask.value
        XCTAssertFalse(oldTaskCommitted)
        XCTAssertEqual(cursorCommit.callCount, 0)
    }
}

private actor SuspendedScopedCursorCommit {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var committedCursor: String?

    func commit(_ cursor: String) async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        committedCursor = cursor
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

private actor SuspendedSameSessionFolderRefresh {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func loadIgnoringCancellation() async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
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

@MainActor
private final class SameSessionCursorCommitProbe {
    private(set) var callCount = 0

    func commit() { callCount += 1 }
}
