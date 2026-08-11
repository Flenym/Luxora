import XCTest
@testable import LuxoraKit

@MainActor
final class DeviceSessionsStoreTests: XCTestCase {
    func testRefreshSortsCurrentSessionFirstThenByRecentActivity() async {
        let current = makeSession(name: "Этот iPhone", lastSeenOffset: -300, isCurrent: true)
        let older = makeSession(name: "MacBook", lastSeenOffset: -200)
        let newer = makeSession(name: "Windows 11", lastSeenOffset: -20)
        let store = DeviceSessionsStore()
        store.configureRemote(loader: { [older, current, newer] }, revoker: { _ in })

        await store.refresh()

        XCTAssertEqual(store.sessions.map(\.id), [current.id, newer.id, older.id])
        XCTAssertEqual(store.loadState, .loaded)
    }

    func testAmbiguousRevokeAcceptsAuthoritativeAbsence() async {
        let current = makeSession(name: "Этот iPhone", isCurrent: true)
        let other = makeSession(name: "Windows 11")
        let store = DeviceSessionsStore(sessions: [current, other], loadState: .loaded)
        store.configureRemote(
            loader: { [current] },
            revoker: { _ in throw DeviceSessionTestError.responseLost }
        )

        let accepted = await store.revoke(other.id)

        XCTAssertTrue(accepted)
        XCTAssertEqual(store.sessions.map(\.id), [current.id])
        XCTAssertNil(store.revocationStates[other.id])
    }

    func testFailedRevokeKeepsSessionAndRetriesExactIdentifier() async {
        let current = makeSession(name: "Этот iPhone", isCurrent: true)
        let other = makeSession(name: "MacBook Pro")
        let probe = DeviceRevocationProbe(sessions: [current, other])
        let store = DeviceSessionsStore(sessions: [current, other], loadState: .loaded)
        store.configureRemote(
            loader: { await probe.load() },
            revoker: { try await probe.revoke($0) }
        )

        let firstAccepted = await store.revoke(other.id)
        XCTAssertFalse(firstAccepted)
        XCTAssertTrue(store.sessions.contains(where: { $0.id == other.id }))
        guard case .failed = store.revocationStates[other.id] else {
            return XCTFail("A failed authoritative revoke must expose a retry state")
        }

        let retryAccepted = await store.revoke(other.id)
        XCTAssertTrue(retryAccepted)
        XCTAssertFalse(store.sessions.contains(where: { $0.id == other.id }))
        let revokedIDs = await probe.revokedIDs
        XCTAssertEqual(revokedIDs, [other.id, other.id])
    }

    func testCancellationFencesNonCooperativeLateLoad() async {
        let existing = makeSession(name: "Этот iPhone", isCurrent: true)
        let late = makeSession(name: "Late Windows")
        let probe = SuspendedDeviceLoader(result: [late])
        let store = DeviceSessionsStore(sessions: [existing], loadState: .loaded)
        store.configureRemote(loader: { await probe.load() }, revoker: { _ in })

        let refresh = Task { await store.refresh(force: true) }
        await probe.waitUntilStarted()
        store.cancelRemoteOperations()
        await probe.release()
        await refresh.value

        XCTAssertEqual(store.sessions, [existing])
        XCTAssertEqual(store.loadState, .loaded)
    }

    func testCurrentSessionCannotBeRevokedThroughRemoteControl() async {
        let current = makeSession(name: "Этот iPhone", isCurrent: true)
        let other = makeSession(name: "Windows 11")
        let probe = DeviceRevocationCountProbe()
        let store = DeviceSessionsStore(sessions: [current, other], loadState: .loaded)
        store.configureRemote(
            loader: { [current, other] },
            revoker: { id in await probe.record(id) }
        )

        let accepted = await store.revoke(current.id)

        XCTAssertFalse(accepted)
        XCTAssertEqual(store.sessions.map(\.id), [current.id, other.id])
        let revokedIDs = await probe.ids
        XCTAssertTrue(revokedIDs.isEmpty)
    }

    func testUnauthorizedRefreshClearsPreviouslyVisibleSessionList() async {
        let current = makeSession(name: "Этот iPhone", isCurrent: true)
        let other = makeSession(name: "MacBook")
        let authenticationError = LuxoraAPIError.server(
            status: 401,
            code: "UNAUTHORIZED",
            message: "Сеанс истёк"
        )
        let store = DeviceSessionsStore(sessions: [current, other], loadState: .loaded)
        store.configureRemote(
            loader: { throw authenticationError },
            revoker: { _ in }
        )

        await store.refresh(force: true)

        XCTAssertTrue(store.sessions.isEmpty)
        guard case let .failed(message) = store.loadState else {
            return XCTFail("Expired credentials must leave an explicit load failure")
        }
        XCTAssertEqual(message, authenticationError.localizedDescription)
    }

    private func makeSession(
        name: String,
        lastSeenOffset: TimeInterval = 0,
        isCurrent: Bool = false
    ) -> DeviceSession {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        return DeviceSession(
            id: UUID(),
            deviceName: name,
            createdAt: now.addingTimeInterval(-3_600),
            lastSeenAt: now.addingTimeInterval(lastSeenOffset),
            expiresAt: now.addingTimeInterval(86_400),
            isCurrent: isCurrent
        )
    }
}

private enum DeviceSessionTestError: LocalizedError {
    case responseLost

    var errorDescription: String? { "Ответ сервера потерян" }
}

private actor DeviceRevocationProbe {
    private let sessions: [DeviceSession]
    private(set) var revokedIDs: [UUID] = []

    init(sessions: [DeviceSession]) {
        self.sessions = sessions
    }

    func load() -> [DeviceSession] {
        sessions
    }

    func revoke(_ id: UUID) throws {
        revokedIDs.append(id)
        if revokedIDs.count == 1 {
            throw DeviceSessionTestError.responseLost
        }
    }
}

private actor DeviceRevocationCountProbe {
    private(set) var ids: [UUID] = []

    func record(_ id: UUID) {
        ids.append(id)
    }
}

private actor SuspendedDeviceLoader {
    private let result: [DeviceSession]
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(result: [DeviceSession]) {
        self.result = result
    }

    func load() async -> [DeviceSession] {
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
