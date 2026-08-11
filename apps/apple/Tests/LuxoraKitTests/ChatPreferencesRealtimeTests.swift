import Foundation
@testable import LuxoraKit
import XCTest

final class ChatPreferencesRealtimeDecoderTests: XCTestCase {
    private let accountID = UUID(uuidString: "D1000000-0000-4000-8000-000000000001")!
    private let chatID = UUID(uuidString: "D2000000-0000-4000-8000-000000000002")!

    func testExactV2AccountScopedEventDecodesEveryFenceField() throws {
        let data = try frame(sequence: 71)
        let dispatch = try XCTUnwrap(ChatPreferencesRealtimeFrameDecoder.decode(data))

        XCTAssertEqual(dispatch.accountID, accountID)
        XCTAssertEqual(dispatch.chatID, chatID)
        XCTAssertEqual(dispatch.sequence, 71)
        XCTAssertEqual(dispatch.cursor, Self.cursor)
        XCTAssertNotNil(dispatch.preferences.archivedAt)
        XCTAssertNil(dispatch.preferences.mutedUntil)
        XCTAssertEqual(
            dispatch.changedAt,
            ISO8601DateFormatter().date(from: "2026-08-11T09:00:00Z")
        )
    }

    func testV1CursorlessTargetEventIsDefensivelySkipped() throws {
        let data = try frame(sequence: 72, includesCursor: false)
        XCTAssertNil(try ChatPreferencesRealtimeFrameDecoder.decode(data))
    }

    func testExplicitNullCursorIsRejectedInsteadOfMasqueradingAsV1() throws {
        let object: [String: Any] = [
            "type": "dispatch",
            "sequence": 72,
            "cursor": NSNull(),
            "event": [
                "type": "chat.preferences.updated",
                "audience": "member_account",
                "accountId": accountID.uuidString.lowercased(),
                "chatId": chatID.uuidString.lowercased(),
                "preferences": ["archivedAt": NSNull(), "mutedUntil": NSNull()],
                "changedAt": "2026-08-11T09:00:00Z",
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try ChatPreferencesRealtimeFrameDecoder.decode(data))
    }

    func testUnrelatedV2EventIsIgnoredWithoutClaimingPreferenceState() throws {
        let object: [String: Any] = [
            "type": "dispatch",
            "sequence": 73,
            "cursor": Self.cursor,
            "event": [
                "type": "receipt.read",
                "chatId": chatID.uuidString.lowercased(),
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertNil(try ChatPreferencesRealtimeFrameDecoder.decode(data))
    }

    func testWrongAudienceAndUnexpectedFieldsAreRejected() throws {
        XCTAssertThrowsError(try ChatPreferencesRealtimeFrameDecoder.decode(
            frame(sequence: 74, audience: "all_members")
        ))
        XCTAssertThrowsError(try ChatPreferencesRealtimeFrameDecoder.decode(
            frame(sequence: 75, extraEventField: true)
        ))
        XCTAssertThrowsError(try ChatPreferencesRealtimeFrameDecoder.decode(
            frame(sequence: 76, extraPreferenceField: true)
        ))
    }

    func testMalformedV2CursorAndNonpositiveSequenceAreRejected() throws {
        XCTAssertThrowsError(try ChatPreferencesRealtimeFrameDecoder.decode(
            frame(sequence: 77, cursorOverride: "not-session-bound")
        ))
        XCTAssertThrowsError(try ChatPreferencesRealtimeFrameDecoder.decode(
            frame(sequence: 0)
        ))
    }

    private func frame(
        sequence: Int,
        includesCursor: Bool = true,
        cursorOverride: String? = nil,
        audience: String = "member_account",
        extraEventField: Bool = false,
        extraPreferenceField: Bool = false
    ) throws -> Data {
        var preferences: [String: Any] = [
            "archivedAt": "2026-08-11T09:00:00Z",
            "mutedUntil": NSNull(),
        ]
        if extraPreferenceField { preferences["userId"] = accountID.uuidString.lowercased() }
        var event: [String: Any] = [
            "type": "chat.preferences.updated",
            "audience": audience,
            "accountId": accountID.uuidString.lowercased(),
            "chatId": chatID.uuidString.lowercased(),
            "preferences": preferences,
            "changedAt": "2026-08-11T09:00:00Z",
        ]
        if extraEventField { event["actorUserId"] = accountID.uuidString.lowercased() }
        var object: [String: Any] = [
            "type": "dispatch",
            "sequence": sequence,
            "event": event,
        ]
        if includesCursor { object["cursor"] = cursorOverride ?? Self.cursor }
        return try JSONSerialization.data(withJSONObject: object)
    }

    private static let cursor = "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
}

@MainActor
final class ChatPreferencesRealtimeStoreTests: XCTestCase {
    private let accountID = UUID(uuidString: "E1000000-0000-4000-8000-000000000001")!
    private let replacementAccountID = UUID(uuidString: "E2000000-0000-4000-8000-000000000002")!
    private let chatID = UUID(uuidString: "E3000000-0000-4000-8000-000000000003")!

    func testMatchingAccountAndSessionBindingAppliesServerProjection() {
        let store = ChatPreferencesStore()
        let binding = configure(store, accountID: accountID)
        let expected = Self.preferences(archived: true, mutedUntil: nil)

        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: expected, sequence: 80, changedAt: 100),
            binding: binding
        ), .accepted)
        XCTAssertEqual(store.preferences(for: chatID), expected)
        XCTAssertEqual(store.loadState(for: chatID), .loaded)
        XCTAssertEqual(store.mutationState(for: chatID), .loaded)
    }

    func testWrongAccountAndReplacedSessionBindingsCannotCrossState() {
        let store = ChatPreferencesStore()
        let oldBinding = configure(store, accountID: accountID)
        let expected = Self.preferences(archived: true, mutedUntil: nil)
        XCTAssertEqual(store.applyRealtime(
            dispatch(
                accountID: replacementAccountID,
                preferences: expected,
                sequence: 81,
                changedAt: 101
            ),
            binding: oldBinding
        ), .rejected)

        let newBinding = configure(store, accountID: replacementAccountID)
        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: expected, sequence: 82, changedAt: 102),
            binding: oldBinding
        ), .rejected)
        XCTAssertNil(store.preferences(for: chatID))

        XCTAssertEqual(store.applyRealtime(
            dispatch(
                accountID: replacementAccountID,
                preferences: expected,
                sequence: 1,
                changedAt: 1
            ),
            binding: newBinding
        ), .accepted)
        XCTAssertEqual(store.preferences(for: chatID), expected)
    }

    func testDuplicateLowerSequenceAndBackwardServerTimeAreRejected() {
        let store = ChatPreferencesStore()
        let binding = configure(store, accountID: accountID)
        let initial = Self.preferences(archived: false, mutedUntil: nil)
        let changed = Self.preferences(archived: true, mutedUntil: nil)

        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: initial, sequence: 90, changedAt: 200),
            binding: binding
        ), .accepted)
        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: changed, sequence: 90, changedAt: 201),
            binding: binding
        ), .rejected)
        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: changed, sequence: 91, changedAt: 199),
            binding: binding
        ), .rejected)
        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: changed, sequence: 92, changedAt: 200),
            binding: binding
        ), .accepted)
        XCTAssertEqual(store.preferences(for: chatID), changed)
    }

    func testExactReplayIsDistinguishedFromDifferentPayloadAtSameSequence() {
        let store = ChatPreferencesStore()
        let binding = configure(store, accountID: accountID)
        let initial = Self.preferences(archived: true, mutedUntil: nil)
        let exact = dispatch(
            accountID: accountID,
            preferences: initial,
            sequence: 95,
            changedAt: 250
        )

        XCTAssertEqual(store.applyRealtime(exact, binding: binding), .accepted)
        XCTAssertEqual(store.applyRealtime(exact, binding: binding), .exactReplay)

        let conflicting = dispatch(
            accountID: accountID,
            preferences: Self.preferences(archived: false, mutedUntil: nil),
            sequence: 95,
            changedAt: 250
        )
        XCTAssertEqual(store.applyRealtime(conflicting, binding: binding), .rejected)
        XCTAssertEqual(store.preferences(for: chatID), initial)
    }

    func testCursorCommitFailureThenExactReplayCommitsWithoutRepublishingState() async throws {
        let store = ChatPreferencesStore()
        let binding = configure(store, accountID: accountID)
        let expected = Self.preferences(
            archived: true,
            mutedUntil: Date(timeIntervalSince1970: 15_000)
        )
        let replayedDispatch = dispatch(
            accountID: accountID,
            preferences: expected,
            sequence: 96,
            changedAt: 260
        )
        let persistence = FailOnceRealtimeCursorPersistence()
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "access",
                refreshToken: "refresh",
                sessionID: UUID()
            ),
            refreshOperation: { _ in throw RealtimePreferenceHarnessError.unexpectedCall },
            persistOperation: { try persistence.persist($0) }
        )
        var projectionPublicationCount = 0

        switch store.applyRealtime(replayedDispatch, binding: binding) {
        case .accepted:
            projectionPublicationCount += 1
        case .exactReplay, .rejected:
            XCTFail("The first delivery must publish exactly once")
        }
        do {
            try await coordinator.commitRealtimeV2Cursor(replayedDispatch.cursor)
            XCTFail("The harness must fail the first durable cursor write")
        } catch RealtimePreferenceHarnessError.firstPersistenceFailure {
            // Expected transport/storage failure after the projection won.
        }
        let cursorAfterFailure = await coordinator.realtimeV2Cursor()
        XCTAssertNil(cursorAfterFailure)

        switch store.applyRealtime(replayedDispatch, binding: binding) {
        case .exactReplay:
            break // Retry cursor persistence only; no second UI publication.
        case .accepted, .rejected:
            XCTFail("The reconnect delivery must be recognized as an exact replay")
        }
        try await coordinator.commitRealtimeV2Cursor(replayedDispatch.cursor)

        XCTAssertEqual(projectionPublicationCount, 1)
        XCTAssertEqual(store.preferences(for: chatID), expected)
        XCTAssertEqual(persistence.attemptCount, 2)
        let committedCursor = await coordinator.realtimeV2Cursor()
        XCTAssertEqual(committedCursor, replayedDispatch.cursor)
    }

    func testAcceptedEventFencesLateNonCooperativeHTTPLoad() async {
        let lateHTTP = Self.preferences(archived: false, mutedUntil: nil)
        let realtime = Self.preferences(archived: true, mutedUntil: Date(timeIntervalSince1970: 9_000))
        let loader = SuspendedRealtimeChatPreferencesLoad(result: lateHTTP)
        let store = ChatPreferencesStore()
        let binding = store.configureRemote(
            accountID: accountID,
            loader: { _ in await loader.load() },
            updater: { _, _ in lateHTTP }
        )

        let task = Task { await store.refresh(chatID) }
        await loader.waitUntilStarted()
        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: realtime, sequence: 100, changedAt: 300),
            binding: binding
        ), .accepted)
        await loader.release()
        await task.value

        XCTAssertEqual(store.preferences(for: chatID), realtime)
        XCTAssertEqual(store.loadState(for: chatID), .loaded)
    }

    func testAcceptedEventFencesLateNonCooperativeHTTPMutation() async {
        let initial = Self.preferences(archived: false, mutedUntil: nil)
        let lateHTTP = Self.preferences(archived: true, mutedUntil: nil)
        let realtime = Self.preferences(archived: false, mutedUntil: Date(timeIntervalSince1970: 12_000))
        let updater = SuspendedRealtimeChatPreferencesUpdate(result: lateHTTP)
        let store = ChatPreferencesStore()
        let binding = store.configureRemote(
            accountID: accountID,
            loader: { _ in initial },
            updater: { _, _ in await updater.update() }
        )
        await store.refresh(chatID)

        let task = Task { await store.update(chatID, patch: .init(archived: true)) }
        await updater.waitUntilStarted()
        XCTAssertEqual(store.applyRealtime(
            dispatch(accountID: accountID, preferences: realtime, sequence: 110, changedAt: 400),
            binding: binding
        ), .accepted)
        await updater.release()
        let acceptedHTTP = await task.value

        XCTAssertFalse(acceptedHTTP)
        XCTAssertEqual(store.preferences(for: chatID), realtime)
        XCTAssertEqual(store.mutationState(for: chatID), .loaded)
    }

    private func configure(
        _ store: ChatPreferencesStore,
        accountID: UUID
    ) -> ChatPreferencesSessionBinding {
        store.configureRemote(
            accountID: accountID,
            loader: { _ in Self.preferences(archived: false, mutedUntil: nil) },
            updater: { _, _ in Self.preferences(archived: false, mutedUntil: nil) }
        )
    }

    private func dispatch(
        accountID: UUID,
        preferences: ChatPreferences,
        sequence: Int,
        changedAt: TimeInterval
    ) -> ChatPreferencesRealtimeDispatch {
        ChatPreferencesRealtimeDispatch(
            accountID: accountID,
            chatID: chatID,
            preferences: preferences,
            changedAt: Date(timeIntervalSince1970: changedAt),
            sequence: sequence,
            cursor: "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
        )
    }

    private nonisolated static func preferences(
        archived: Bool,
        mutedUntil: Date?
    ) -> ChatPreferences {
        ChatPreferences(
            archivedAt: archived ? Date(timeIntervalSince1970: 10) : nil,
            mutedUntil: mutedUntil
        )
    }
}

private actor SuspendedRealtimeChatPreferencesLoad {
    private let result: ChatPreferences
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(result: ChatPreferences) { self.result = result }

    func load() async -> ChatPreferences {
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

private final class FailOnceRealtimeCursorPersistence: @unchecked Sendable {
    private let lock = NSLock()
    private var attempts = 0

    var attemptCount: Int { lock.withLock { attempts } }

    func persist(_ credentials: SessionCredentials) throws {
        _ = credentials
        try lock.withLock {
            attempts += 1
            if attempts == 1 {
                throw RealtimePreferenceHarnessError.firstPersistenceFailure
            }
        }
    }
}

private enum RealtimePreferenceHarnessError: Error {
    case firstPersistenceFailure
    case unexpectedCall
}

private actor SuspendedRealtimeChatPreferencesUpdate {
    private let result: ChatPreferences
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(result: ChatPreferences) { self.result = result }

    func update() async -> ChatPreferences {
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
