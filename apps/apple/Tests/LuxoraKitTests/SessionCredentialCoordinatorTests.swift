import Foundation
import XCTest
@testable import LuxoraKit

final class SessionCredentialCoordinatorTests: XCTestCase {
    func testScopedCursorPersistsAndSurvivesAccessTokenRotation() async throws {
        let persistProbe = CredentialPersistProbe()
        let sessionID = UUID()
        let cursor = "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "expired-access",
                refreshToken: "initial-refresh",
                sessionID: sessionID
            ),
            refreshOperation: { _ in
                SessionCredentials(
                    accessToken: "fresh-access",
                    refreshToken: "rotated-refresh",
                    sessionID: sessionID
                )
            },
            persistOperation: { persistProbe.record($0) }
        )

        try await coordinator.commitRealtimeV2Cursor(cursor)
        let committedCursor = await coordinator.realtimeV2Cursor()
        XCTAssertEqual(committedCursor, cursor)
        _ = try await coordinator.withAccessToken(Self.protectedOperation)
        let cursorAfterRefresh = await coordinator.realtimeV2Cursor()
        XCTAssertEqual(cursorAfterRefresh, cursor)
        XCTAssertEqual(persistProbe.last?.realtimeV2Cursor, cursor)
        XCTAssertEqual(persistProbe.last?.accessToken, "fresh-access")
    }

    func testInvalidatedSessionCannotCommitLateScopedCursor() async {
        let persistProbe = CredentialPersistProbe()
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "access",
                refreshToken: "refresh",
                sessionID: UUID()
            ),
            refreshOperation: { _ in throw CancellationError() },
            persistOperation: { persistProbe.record($0) }
        )
        await coordinator.invalidate()
        do {
            try await coordinator.commitRealtimeV2Cursor(
                "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
            )
            XCTFail("Invalidated session must fence cursor persistence")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("Expected CancellationError, received \(error)")
        }
        XCTAssertEqual(persistProbe.count, 0)
    }

    func testCancelledQueuedCursorCommitNeverPersistsOrMutatesCredentials() async {
        let persistProbe = CredentialPersistProbe()
        let callerGate = SuspendedCursorCommitCaller()
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "access",
                refreshToken: "refresh",
                sessionID: UUID()
            ),
            refreshOperation: { _ in throw CancellationError() },
            persistOperation: { persistProbe.record($0) }
        )
        let cursor = "luxora-rt1.\(String(repeating: "c", count: 40)).\(String(repeating: "d", count: 40))"
        let commit = Task {
            await callerGate.suspendBeforeCommit()
            try await coordinator.commitRealtimeV2Cursor(cursor)
        }
        await callerGate.waitUntilStarted()
        commit.cancel()
        await callerGate.release()

        do {
            try await commit.value
            XCTFail("A cancelled queued commit must not reach persistence")
        } catch is CancellationError {
            // Expected at the coordinator actor boundary.
        } catch {
            XCTFail("Expected CancellationError, received \(error)")
        }
        XCTAssertEqual(persistProbe.count, 0)
        let committedCursor = await coordinator.realtimeV2Cursor()
        XCTAssertNil(committedCursor)
    }

    func testConcurrentUnauthorizedRequestsShareOneRefreshRotation() async throws {
        let probe = RefreshProbe()
        let sessionID = UUID()
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "expired-access",
                refreshToken: "initial-refresh",
                sessionID: sessionID
            ),
            refreshOperation: { token in
                try await probe.refresh(token: token, sessionID: sessionID)
            },
            persistOperation: { credentials in
                Task { await probe.persist(credentials) }
            }
        )

        async let first = coordinator.withAccessToken(Self.protectedOperation)
        async let second = coordinator.withAccessToken(Self.protectedOperation)

        let values = try await [first, second]
        XCTAssertEqual(values, ["fresh-access", "fresh-access"])
        let refreshCount = await probe.refreshCount
        XCTAssertEqual(refreshCount, 1)
    }

    func testInvalidatedSessionCannotPersistCredentialsFromLateRefreshSuccess() async {
        let refreshProbe = SuspendedRefreshProbe()
        let persistProbe = CredentialPersistProbe()
        let sessionID = UUID()
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "expired-access",
                refreshToken: "initial-refresh",
                sessionID: sessionID
            ),
            refreshOperation: { token in
                await refreshProbe.refresh(token: token, sessionID: sessionID)
            },
            persistOperation: { credentials in
                persistProbe.record(credentials)
            }
        )

        let operation: @Sendable (String) async throws -> String = { token in
            if token == "expired-access" {
                throw LuxoraAPIError.server(status: 401, code: "UNAUTHORIZED", message: "Expired")
            }
            return token
        }
        let request = Task<String, Error> {
            try await coordinator.withAccessToken(operation)
        }
        await refreshProbe.waitUntilStarted()
        request.cancel()
        await coordinator.invalidate()
        await refreshProbe.release()

        do {
            _ = try await request.value
            XCTFail("A cancelled session operation must not accept a late refresh")
        } catch is CancellationError {
            // Expected: persistence is fenced before the rotated token is saved.
        } catch {
            XCTFail("Expected CancellationError, received \(error)")
        }
        XCTAssertEqual(persistProbe.count, 0)
    }

    func testCancellingOneWaiterDoesNotCancelSharedRefreshForAnotherWaiter() async throws {
        let refreshProbe = CancellationAwareRefreshProbe()
        let operationProbe = ProtectedOperationProbe()
        let persistProbe = CredentialPersistProbe()
        let sessionID = UUID()
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "expired-access",
                refreshToken: "initial-refresh",
                sessionID: sessionID
            ),
            refreshOperation: { token in
                try await refreshProbe.refresh(token: token, sessionID: sessionID)
            },
            persistOperation: { credentials in
                persistProbe.record(credentials)
            }
        )
        let operation: @Sendable (String) async throws -> String = { token in
            try await operationProbe.perform(token: token)
        }

        let first = Task<String, Error> {
            try await coordinator.withAccessToken(operation)
        }
        await refreshProbe.waitUntilStarted()
        let second = Task<String, Error> {
            try await coordinator.withAccessToken(operation)
        }
        await operationProbe.waitUntilExpiredAttempts(2)
        // Let the second actor call join the already-created refresh task.
        await Task.yield()
        await Task.yield()

        first.cancel()
        await refreshProbe.release()

        do {
            _ = try await first.value
            XCTFail("The explicitly cancelled waiter must not accept the refreshed token")
        } catch is CancellationError {
            // Expected; cancellation is local to this waiter.
        }
        let secondValue = try await second.value
        XCTAssertEqual(secondValue, "fresh-access")
        let refreshCount = await refreshProbe.refreshCount
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(persistProbe.count, 1)
    }

    private static let protectedOperation: @Sendable (String) async throws -> String = { token in
        if token == "expired-access" {
            throw LuxoraAPIError.server(status: 401, code: "UNAUTHORIZED", message: "Expired")
        }
        return token
    }
}

private actor RefreshProbe {
    private(set) var refreshCount = 0
    private(set) var persisted: SessionCredentials?

    func refresh(token: String, sessionID: UUID) async throws -> SessionCredentials {
        XCTAssertEqual(token, "initial-refresh")
        refreshCount += 1
        try await Task.sleep(for: .milliseconds(40))
        return SessionCredentials(
            accessToken: "fresh-access",
            refreshToken: "rotated-refresh",
            sessionID: sessionID
        )
    }

    func persist(_ credentials: SessionCredentials) {
        persisted = credentials
    }
}

private actor SuspendedRefreshProbe {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func refresh(token: String, sessionID: UUID) async -> SessionCredentials {
        XCTAssertEqual(token, "initial-refresh")
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { continuation in
            releaseContinuation = continuation
        }

        // Deliberately return despite cancellation, as some adapters can do
        // when a response wins the race with transport cancellation.
        return SessionCredentials(
            accessToken: "late-access",
            refreshToken: "late-refresh",
            sessionID: sessionID
        )
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

private actor CancellationAwareRefreshProbe {
    private(set) var refreshCount = 0
    private var started = false
    private var isReleased = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []

    func refresh(token: String, sessionID: UUID) async throws -> SessionCredentials {
        XCTAssertEqual(token, "initial-refresh")
        refreshCount += 1
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        while !isReleased {
            try await Task.sleep(for: .milliseconds(5))
        }
        return SessionCredentials(
            accessToken: "fresh-access",
            refreshToken: "rotated-refresh",
            sessionID: sessionID
        )
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        isReleased = true
    }
}

private actor SuspendedCursorCommitCaller {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func suspendBeforeCommit() async {
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

private actor ProtectedOperationProbe {
    private var expiredAttempts = 0
    private var attemptWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func perform(token: String) throws -> String {
        if token == "expired-access" {
            expiredAttempts += 1
            let ready = attemptWaiters.filter { expiredAttempts >= $0.0 }
            attemptWaiters.removeAll { expiredAttempts >= $0.0 }
            ready.forEach { $0.1.resume() }
            throw LuxoraAPIError.server(status: 401, code: "UNAUTHORIZED", message: "Expired")
        }
        return token
    }

    func waitUntilExpiredAttempts(_ count: Int) async {
        guard expiredAttempts < count else { return }
        await withCheckedContinuation { attemptWaiters.append((count, $0)) }
    }
}

private final class CredentialPersistProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var persistedCredentials: [SessionCredentials] = []

    var count: Int {
        lock.withLock { persistedCredentials.count }
    }

    var last: SessionCredentials? {
        lock.withLock { persistedCredentials.last }
    }

    func record(_ credentials: SessionCredentials) {
        lock.withLock { persistedCredentials.append(credentials) }
    }
}
