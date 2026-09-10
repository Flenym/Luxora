import Foundation
@testable import LuxoraKit
import XCTest

final class ChatFolderModelTests: XCTestCase {
    func testDraftEnforcesUnicodeScalarTitleAndOverrideLimits() throws {
        let exact = String(repeating: "🧪", count: ChatFolderContract.maximumTitleCodePoints)
        XCTAssertEqual(try draft(title: exact).validated().title, exact)
        XCTAssertThrowsError(try draft(title: exact + "x").validated())

        let maximum = (0..<ChatFolderContract.maximumOverrides).map { index in
            ChatFolderOverride(chatID: id(index), mode: .include, pinnedPosition: nil)
        }
        XCTAssertNoThrow(try draft(title: "Сто", overrides: maximum).validated())
        XCTAssertThrowsError(try draft(
            title: "Сто один",
            overrides: maximum + [
                ChatFolderOverride(chatID: id(101), mode: .exclude, pinnedPosition: nil),
            ]
        ).validated())
    }

    func testExplicitOverridesBeatRulesAndCustomPinsBeatGlobalActivityAndPin() {
        var oldIncluded = conversation(1, kind: .direct, unread: 0, archived: true, date: 1)
        oldIncluded.isPinned = false
        var newerGlobalPin = conversation(2, kind: .direct, unread: 3, archived: false, date: 30)
        newerGlobalPin.isPinned = true
        let newestExcluded = conversation(3, kind: .direct, unread: 4, archived: false, date: 40)
        let folder = ChatFolder(
            id: id(500),
            title: "Точный порядок",
            position: 0,
            revision: 1,
            rules: ChatFolderRules(
                includeKinds: [.direct],
                unreadOnly: true,
                excludeMuted: false,
                includeArchived: false
            ),
            overrides: [
                ChatFolderOverride(chatID: oldIncluded.id, mode: .include, pinnedPosition: 0),
                ChatFolderOverride(chatID: newestExcluded.id, mode: .exclude, pinnedPosition: nil),
            ],
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 1)
        )

        XCTAssertEqual(
            folder.projectedConversations([newestExcluded, newerGlobalPin, oldIncluded]).map(\.id),
            [oldIncluded.id, newerGlobalPin.id]
        )
    }

    func testPinnedPositionsMustBeUniqueAndOnlyBelongToIncludes() {
        let duplicatePins = [
            ChatFolderOverride(chatID: id(1), mode: .include, pinnedPosition: 0),
            ChatFolderOverride(chatID: id(2), mode: .include, pinnedPosition: 0),
        ]
        XCTAssertThrowsError(try draft(title: "Дубли", overrides: duplicatePins).validated())
        XCTAssertThrowsError(try draft(
            title: "Исключение",
            overrides: [ChatFolderOverride(chatID: id(3), mode: .exclude, pinnedPosition: 1)]
        ).validated())
    }

    private func draft(
        title: String,
        overrides: [ChatFolderOverride] = []
    ) -> ChatFolderDraft {
        ChatFolderDraft(title: title, rules: .allUnarchived, overrides: overrides)
    }

    private func conversation(
        _ index: Int,
        kind: ConversationKind,
        unread: Int,
        archived: Bool,
        date: TimeInterval
    ) -> Conversation {
        Conversation(
            id: id(index),
            title: "Чат \(index)",
            subtitle: "",
            kind: kind,
            avatar: Participant(
                id: id(1_000 + index),
                displayName: "Чат \(index)",
                username: "chat\(index)",
                initials: "Ч\(index)",
                accentHex: "#5B5FF0",
                isOnline: false,
                status: ""
            ),
            memberCount: 2,
            unreadCount: unread,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: archived,
            lastActivity: Date(timeIntervalSince1970: date),
            folder: "personal"
        )
    }

    private func id(_ index: Int) -> UUID {
        UUID(uuidString: String(format: "10000000-0000-4000-8000-%012d", index))!
    }
}

final class ChatFoldersRealtimeDecoderTests: XCTestCase {
    func testStrictAccountPrivateV2EventDecodes() throws {
        let dispatch = try XCTUnwrap(ChatFoldersRealtimeFrameDecoder.decode(frame()))
        XCTAssertEqual(dispatch.accountID, Self.accountID)
        XCTAssertEqual(dispatch.stateRevision, 17)
        XCTAssertEqual(dispatch.sequence, 51)
        XCTAssertEqual(dispatch.cursor, Self.cursor)
    }

    func testCursorlessV1IsSkippedButNullCursorAndExtraFieldsFailClosed() throws {
        var cursorless = object()
        cursorless["cursor"] = nil
        XCTAssertNil(try ChatFoldersRealtimeFrameDecoder.decode(data(cursorless)))

        var nullCursor = object()
        nullCursor["cursor"] = NSNull()
        XCTAssertThrowsError(try ChatFoldersRealtimeFrameDecoder.decode(data(nullCursor)))

        var extra = object()
        var event = extra["event"] as! [String: Any]
        event["folders"] = []
        extra["event"] = event
        XCTAssertThrowsError(try ChatFoldersRealtimeFrameDecoder.decode(data(extra)))
    }

    func testWrongAudienceNegativeRevisionAndMalformedCursorFailClosed() throws {
        for mutation in ["audience", "revision", "cursor"] {
            var value = object()
            if mutation == "cursor" {
                value["cursor"] = "unsafe"
            } else {
                var event = value["event"] as! [String: Any]
                if mutation == "audience" { event["audience"] = "member_account" }
                if mutation == "revision" { event["stateRevision"] = -1 }
                value["event"] = event
            }
            XCTAssertThrowsError(try ChatFoldersRealtimeFrameDecoder.decode(data(value)))
        }
    }

    private func frame() throws -> Data { data(object()) }

    private func object() -> [String: Any] {
        [
            "type": "dispatch",
            "sequence": 51,
            "cursor": Self.cursor,
            "event": [
                "type": "chat.folders.updated",
                "audience": "actor_account",
                "accountId": Self.accountID.uuidString.lowercased(),
                "stateRevision": 17,
                "changedAt": "2026-08-11T09:00:00Z",
            ],
        ]
    }

    private func data(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    private static let accountID = UUID(uuidString: "D1000000-0000-4000-8000-000000000001")!
    private static let cursor = "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
}

@MainActor
final class ChatFolderMuteExpiryTests: XCTestCase {
    func testFiniteMuteReprojectsFolderAtDeadlineWithoutServerEvent() async throws {
        let chatID = UUID(uuidString: "E1000000-0000-4000-8000-000000000001")!
        let conversation = Conversation(
            id: chatID,
            title: "Временно без звука",
            subtitle: "",
            kind: .direct,
            avatar: Participant(
                id: chatID,
                displayName: "Временно без звука",
                username: "muted",
                initials: "В",
                accentHex: "#5B5FF0",
                isOnline: false,
                status: ""
            ),
            memberCount: 2,
            unreadCount: 1,
            isMuted: true,
            mutedUntil: Date().addingTimeInterval(0.05),
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: Date(),
            folder: "personal"
        )
        let messenger = MessengerStore(
            conversations: [conversation],
            messagesByConversation: [:],
            currentUser: conversation.avatar
        )
        let folder = ChatFolder(
            id: UUID(uuidString: "E2000000-0000-4000-8000-000000000002")!,
            title: "Со звуком",
            position: 0,
            revision: 1,
            rules: ChatFolderRules(
                includeKinds: [.direct],
                unreadOnly: false,
                excludeMuted: true,
                includeArchived: false
            ),
            overrides: [],
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 1)
        )

        XCTAssertTrue(folder.projectedConversations(messenger.conversations).isEmpty)
        // The local mute-expiry re-projection is wall-clock driven; poll instead
        // of a fixed sleep so slow CI simulators cannot flake the deadline.
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if !(try XCTUnwrap(messenger.conversations.first)).isMuted { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(try XCTUnwrap(messenger.conversations.first).isMuted)
        XCTAssertEqual(folder.projectedConversations(messenger.conversations).map(\.id), [chatID])
    }
}
