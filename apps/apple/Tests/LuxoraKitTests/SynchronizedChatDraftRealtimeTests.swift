import Foundation
@testable import LuxoraKit
import XCTest

final class SynchronizedChatDraftRealtimeDecoderTests: XCTestCase {
    private let accountID = UUID(uuidString: "B650E2AB-4185-493D-81A2-BD4F19B84F0C")!
    private let chatID = UUID(uuidString: "9EC9347C-9306-4108-AAB4-E7762B73B201")!
    private let replyID = UUID(uuidString: "A0DF9334-2EC0-422D-B5DE-11C775A42344")!

    func testExactV2ActiveDraftDecodesEveryPrivacyAndCausalFence() throws {
        let data = try frame(sequence: 71, revision: 4, text: "private", replyID: replyID)

        let dispatch = try XCTUnwrap(ChatDraftRealtimeFrameDecoder.decode(data))

        XCTAssertEqual(dispatch.accountID, accountID)
        XCTAssertEqual(dispatch.chatID, chatID)
        XCTAssertEqual(dispatch.state.revision, 4)
        XCTAssertEqual(dispatch.state.draft?.text, "private")
        XCTAssertEqual(dispatch.state.draft?.replyToMessageID, replyID)
        XCTAssertEqual(dispatch.sequence, 71)
        XCTAssertEqual(dispatch.cursor, Self.cursor)
        XCTAssertEqual(dispatch.state.draft?.updatedAt, dispatch.changedAt)
    }

    func testDeleteTombstoneDecodesWithPositiveRevision() throws {
        let dispatch = try XCTUnwrap(ChatDraftRealtimeFrameDecoder.decode(
            frame(sequence: 72, revision: 5, text: nil)
        ))

        XCTAssertNil(dispatch.state.draft)
        XCTAssertEqual(dispatch.state.revision, 5)
    }

    func testV1CursorlessTargetIsSkippedAndUnrelatedV2EventIsIgnored() throws {
        XCTAssertNil(try ChatDraftRealtimeFrameDecoder.decode(
            frame(sequence: 73, revision: 6, text: "v1", includesCursor: false)
        ))
        let unrelated = try JSONSerialization.data(withJSONObject: [
            "type": "dispatch",
            "sequence": 74,
            "cursor": Self.cursor,
            "event": ["type": "receipt.read", "chatId": chatID.apiPathComponent],
        ])
        XCTAssertNil(try ChatDraftRealtimeFrameDecoder.decode(unrelated))
    }

    func testMalformedAudienceCursorAndUnexpectedFieldsFailClosed() throws {
        XCTAssertThrowsError(try ChatDraftRealtimeFrameDecoder.decode(
            frame(sequence: 75, revision: 7, text: "x", audience: "all_members")
        ))
        XCTAssertThrowsError(try ChatDraftRealtimeFrameDecoder.decode(
            frame(
                sequence: 76,
                revision: 8,
                text: "x",
                cursor: "not-session-bound"
            )
        ))
        XCTAssertThrowsError(try ChatDraftRealtimeFrameDecoder.decode(
            frame(sequence: 77, revision: 9, text: "x", extraEventField: true)
        ))
        XCTAssertThrowsError(try ChatDraftRealtimeFrameDecoder.decode(
            frame(sequence: 78, revision: 10, text: "x", extraDraftField: true)
        ))
    }

    func testMismatchedChatRevisionAndTimestampFailClosed() throws {
        let otherChatID = UUID(uuidString: "FEC9347C-9306-4108-AAB4-E7762B73B202")!
        XCTAssertThrowsError(try ChatDraftRealtimeFrameDecoder.decode(
            frame(
                sequence: 79,
                revision: 11,
                text: "wrong chat",
                draftChatID: otherChatID
            )
        ))
        XCTAssertThrowsError(try ChatDraftRealtimeFrameDecoder.decode(
            frame(
                sequence: 80,
                revision: 12,
                text: "wrong revision",
                draftRevision: 13
            )
        ))
        XCTAssertThrowsError(try ChatDraftRealtimeFrameDecoder.decode(
            frame(
                sequence: 81,
                revision: 14,
                text: "wrong timestamp",
                draftUpdatedAt: "2026-08-15T09:00:01Z"
            )
        ))
    }

    private func frame(
        sequence: Int,
        revision: Int,
        text: String?,
        replyID: UUID? = nil,
        includesCursor: Bool = true,
        cursor: String = cursor,
        audience: String = "account_sessions",
        draftChatID: UUID? = nil,
        draftRevision: Int? = nil,
        draftUpdatedAt: String = "2026-08-15T09:00:00Z",
        extraEventField: Bool = false,
        extraDraftField: Bool = false
    ) throws -> Data {
        let draft: Any
        if let text {
            var object: [String: Any] = [
                "chatId": (draftChatID ?? chatID).apiPathComponent,
                "text": text,
                "replyToMessageId": replyID?.apiPathComponent ?? NSNull(),
                "revision": draftRevision ?? revision,
                "updatedAt": draftUpdatedAt,
            ]
            if extraDraftField { object["deviceId"] = accountID.apiPathComponent }
            draft = object
        } else {
            draft = NSNull()
        }
        var event: [String: Any] = [
            "type": "chat.draft.changed",
            "audience": audience,
            "accountId": accountID.apiPathComponent,
            "chatId": chatID.apiPathComponent,
            "draft": draft,
            "revision": revision,
            "changedAt": "2026-08-15T09:00:00Z",
        ]
        if extraEventField { event["actorUserId"] = accountID.apiPathComponent }
        var object: [String: Any] = [
            "type": "dispatch",
            "sequence": sequence,
            "event": event,
        ]
        if includesCursor { object["cursor"] = cursor }
        return try JSONSerialization.data(withJSONObject: object)
    }

    private static let cursor = "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
}

@MainActor
final class SynchronizedChatDraftRealtimeStoreTests: XCTestCase {
    private let accountID = UUID(uuidString: "B650E2AB-4185-493D-81A2-BD4F19B84F0C")!
    private let replacementAccountID = UUID(uuidString: "C650E2AB-4185-493D-81A2-BD4F19B84F0D")!
    private let sessionID = UUID(uuidString: "D650E2AB-4185-493D-81A2-BD4F19B84F0E")!
    private let replacementSessionID = UUID(uuidString: "E650E2AB-4185-493D-81A2-BD4F19B84F0F")!
    private let chatID = UUID(uuidString: "9EC9347C-9306-4108-AAB4-E7762B73B201")!

    func testStaleEqualAndNewerRevisionMergeRulesAreFailClosed() {
        let store = SynchronizedChatDraftStore()
        let binding = configure(store)
        let initial = dispatch(text: "r2", revision: 2, sequence: 20, changedAt: 20)

        XCTAssertEqual(store.applyRealtime(initial, binding: binding), .accepted)
        XCTAssertEqual(store.applyRealtime(initial, binding: binding), .exactReplay)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "equal conflict", revision: 2, sequence: 21, changedAt: 21),
            binding: binding
        ), .rejected)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "stale", revision: 1, sequence: 22, changedAt: 22),
            binding: binding
        ), .stale)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "r3", revision: 3, sequence: 23, changedAt: 23),
            binding: binding
        ), .accepted)
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "r3")
    }

    func testWrongAccountOrReplacedSessionCannotCrossProjection() {
        let store = SynchronizedChatDraftStore()
        let oldBinding = configure(store)
        XCTAssertEqual(store.applyRealtime(
            dispatch(
                accountID: replacementAccountID,
                text: "wrong account",
                revision: 1,
                sequence: 1,
                changedAt: 1
            ),
            binding: oldBinding
        ), .rejected)

        let newBinding = configureReplacement(store)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "late old", revision: 1, sequence: 2, changedAt: 2),
            binding: oldBinding
        ), .rejected)
        XCTAssertNil(store.confirmedState(for: chatID))
        XCTAssertEqual(store.applyRealtime(
            dispatch(
                accountID: replacementAccountID,
                text: "new session",
                revision: 1,
                sequence: 1,
                changedAt: 1
            ),
            binding: newBinding
        ), .accepted)
        XCTAssertEqual(store.localDraft(for: chatID).text, "new session")
    }

    func testOrdinaryTombstonePreservesAndRebasesDirtyLocalText() {
        let store = SynchronizedChatDraftStore()
        let binding = configure(store)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "server", revision: 4, sequence: 40, changedAt: 40),
            binding: binding
        ), .accepted)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "private unsaved"))
        XCTAssertTrue(store.dirtyChatIDs.contains(chatID))

        XCTAssertEqual(store.applyRealtime(
            dispatch(text: nil, revision: 5, sequence: 41, changedAt: 41),
            binding: binding
        ), .accepted)

        XCTAssertEqual(store.localDraft(for: chatID).text, "private unsaved")
        XCTAssertTrue(store.dirtyChatIDs.contains(chatID))
        XCTAssertNil(store.confirmedState(for: chatID)?.draft)
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 5)
    }

    func testCleanTombstoneClearsMirroredLocalProjection() {
        let store = SynchronizedChatDraftStore()
        let binding = configure(store)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "server", revision: 4, sequence: 40, changedAt: 40),
            binding: binding
        ), .accepted)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: nil, revision: 5, sequence: 41, changedAt: 41),
            binding: binding
        ), .accepted)
        XCTAssertEqual(store.localDraft(for: chatID), .empty)
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
    }

    func testExplicitMembershipRemovalPathScrubsDirtyLocalText() {
        let store = SynchronizedChatDraftStore()
        let binding = configure(store)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "server", revision: 4, sequence: 40, changedAt: 40),
            binding: binding
        ), .accepted)
        XCTAssertTrue(store.setLocalDraft(for: chatID, text: "private unsaved"))

        store.removeChat(chatID)

        XCTAssertEqual(store.localDraft(for: chatID), .empty)
        XCTAssertFalse(store.dirtyChatIDs.contains(chatID))
        XCTAssertNil(store.confirmedState(for: chatID))
    }

    func testHigherSequenceWithBackwardServerTimeIsRejected() {
        let store = SynchronizedChatDraftStore()
        let binding = configure(store)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "r6", revision: 6, sequence: 60, changedAt: 100),
            binding: binding
        ), .accepted)
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "r7", revision: 7, sequence: 61, changedAt: 99),
            binding: binding
        ), .rejected)
        XCTAssertEqual(store.confirmedState(for: chatID)?.revision, 6)
    }

    func testHTTPConfirmedRevisionThenIdenticalRealtimeEventIsCausalNoOp() async {
        let store = SynchronizedChatDraftStore()
        let event = dispatch(text: "HTTP won", revision: 8, sequence: 80, changedAt: 80)
        let binding = store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: { _ in event.state },
            putter: { _, _ in throw LuxoraAPIError.invalidResponse },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
        await store.refresh(chatID)

        XCTAssertEqual(store.applyRealtime(event, binding: binding), .causalNoOp)
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "HTTP won")
        XCTAssertEqual(store.applyRealtime(
            dispatch(text: "divergent", revision: 8, sequence: 81, changedAt: 80),
            binding: binding
        ), .rejected)
        XCTAssertEqual(store.confirmedState(for: chatID)?.draft?.text, "HTTP won")
    }

    private func configure(
        _ store: SynchronizedChatDraftStore
    ) -> SynchronizedChatDraftSessionBinding {
        store.configureRemote(
            accountID: accountID,
            sessionID: sessionID,
            loader: { _ in throw LuxoraAPIError.invalidResponse },
            putter: { _, _ in throw LuxoraAPIError.invalidResponse },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
    }

    private func configureReplacement(
        _ store: SynchronizedChatDraftStore
    ) -> SynchronizedChatDraftSessionBinding {
        store.configureRemote(
            accountID: replacementAccountID,
            sessionID: replacementSessionID,
            loader: { _ in throw LuxoraAPIError.invalidResponse },
            putter: { _, _ in throw LuxoraAPIError.invalidResponse },
            deleter: { _, _ in throw LuxoraAPIError.invalidResponse }
        )
    }

    private func dispatch(
        accountID: UUID? = nil,
        text: String?,
        revision: Int,
        sequence: Int,
        changedAt: TimeInterval
    ) -> ChatDraftRealtimeDispatch {
        let date = Date(timeIntervalSince1970: changedAt)
        let draft = text.map {
            SynchronizedChatDraft(
                chatID: chatID,
                content: .init(text: $0),
                revision: revision,
                updatedAt: date
            )
        }
        return ChatDraftRealtimeDispatch(
            accountID: accountID ?? self.accountID,
            chatID: chatID,
            state: SynchronizedChatDraftState(draft: draft, revision: revision),
            changedAt: date,
            sequence: sequence,
            cursor: "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
        )
    }
}
