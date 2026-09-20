import Foundation
@testable import LuxoraKit
import XCTest

final class DeviceLinkStoreTests: XCTestCase {
    private static let linkID = UUID(uuidString: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")!
    private static let linkSecret = String(repeating: "b", count: 64)

    private static func created() -> APIDeviceLinkChallenge {
        APIDeviceLinkChallenge(
            linkId: linkID,
            linkSecret: linkSecret,
            expiresAt: Date(timeIntervalSince1970: 1_800_003_600),
            pollIntervalMs: 1
        )
    }

    private static func status(
        _ state: String,
        sasWords: [String]? = nil
    ) -> APIDeviceLinkStatus {
        APIDeviceLinkStatus(
            linkId: linkID,
            state: state,
            expiresAt: Date(timeIntervalSince1970: 1_800_003_600),
            retryAfterMs: 0,
            sasWords: sasWords
        )
    }

    @MainActor
    func testCreateExposesQRContentAndPollsToApproved() async throws {
        let store = DeviceLinkStore()
        store.configureRemote(
            creator: { _ in Self.created() },
            poller: { _, _ in Self.status("approved", sasWords: ["amber", "anchor", "angel", "apple"]) }
        )

        await store.createChallenge(targetLabel: "MacBook Pro")
        XCTAssertNotNil(store.qrContent)
        XCTAssertEqual(store.linkID, Self.linkID)

        let terminal = await Self.awaitTerminal(store)
        guard case .approved(let sas) = terminal else {
            return XCTFail("Polling must converge to approved, got \(terminal)")
        }
        XCTAssertEqual(sas, "amber anchor angel apple")
    }

    @MainActor
    func testPendingPollsUntilTerminalState() async throws {
        let counter = PollCounter()
        let store = DeviceLinkStore()
        store.configureRemote(
            creator: { _ in Self.created() },
            poller: { _, _ in
                let calls = await counter.increment()
                return calls < 3 ? Self.status("pending") : Self.status("denied")
            }
        )

        await store.createChallenge(targetLabel: nil)
        let terminal = await Self.awaitTerminal(store)
        XCTAssertEqual(terminal, .denied)
        let pollCount = await counter.value
        XCTAssertGreaterThanOrEqual(pollCount, 3)
    }

    @MainActor
    func testCloseStopsPollingAndReportsClosed() async throws {
        let store = DeviceLinkStore()
        store.configureRemote(
            creator: { _ in Self.created() },
            poller: { _, _ in Self.status("pending") },
            closer: { _, _ in Self.status("closed") }
        )

        await store.createChallenge(targetLabel: nil)
        await store.close()
        XCTAssertEqual(store.state, .closed)
    }

    @MainActor
    func testMissingRemotesFailsClosed() async throws {
        let store = DeviceLinkStore()

        await store.createChallenge(targetLabel: nil)
        guard case .failed = store.state else {
            return XCTFail("Missing remotes must fail closed")
        }
    }

    @MainActor
    func testSessionReplacementClearsSecretAndState() async throws {
        let store = DeviceLinkStore()
        store.configureRemote(
            creator: { _ in Self.created() },
            poller: { _, _ in Self.status("approved", sasWords: ["a", "b", "c", "d"]) }
        )

        await store.createChallenge(targetLabel: nil)
        XCTAssertNotNil(store.qrContent)

        store.resetForSessionReplacement()
        XCTAssertEqual(store.state, .idle)
        XCTAssertNil(store.linkID)
        XCTAssertNil(store.qrContent)

        await store.createChallenge(targetLabel: nil)
        guard case .failed = store.state else {
            return XCTFail("A replaced session must not retain remotes")
        }
    }

    @MainActor
    private static func awaitTerminal(
        _ store: DeviceLinkStore,
        timeout: TimeInterval = 5
    ) async -> DeviceLinkFlowState {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            switch store.state {
            case .approved, .denied, .expired, .closed, .failed:
                return store.state
            default:
                break
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return store.state
    }
}

private actor PollCounter {
    private(set) var value = 0

    func increment() -> Int {
        value += 1
        return value
    }
}
