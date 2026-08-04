import XCTest
@testable import LuxoraKit

final class PhoneNavigationSupportTests: XCTestCase {
    private let me = Participant(
        id: UUID(uuidString: "10000000-0000-0000-0000-000000000001")!,
        displayName: "Егор",
        username: "egor_1",
        initials: "Е",
        accentHex: "#6D5DFB",
        isOnline: true,
        status: "в сети"
    )

    func testProfilePayloadContainsOnlyPublicProfileFields() {
        let payload = PhoneProfileSharePayload(participant: me)

        XCTAssertEqual(payload.shareText, "Егор в Luxora — @egor_1")
        XCTAssertEqual(
            payload.qrText,
            "Luxora Beta-0.1\nИмя: Егор\nUsername: @egor_1"
        )
        XCTAssertFalse(payload.qrText.localizedCaseInsensitiveContains("token"))
        XCTAssertFalse(payload.qrText.contains("+7"))
    }

    func testFolderSummaryCountsServerLoadedConversationsWithoutInventingFolders() {
        let direct = conversation(
            id: "20000000-0000-0000-0000-000000000001",
            kind: .direct,
            unread: 2,
            folder: "personal"
        )
        let group = conversation(
            id: "20000000-0000-0000-0000-000000000002",
            kind: .group,
            unread: 0,
            folder: "work"
        )
        let saved = conversation(
            id: "20000000-0000-0000-0000-000000000003",
            kind: .saved,
            unread: 0,
            folder: "personal"
        )

        let result = Dictionary(
            uniqueKeysWithValues: PhoneFolderSummary.make(from: [direct, group, saved])
                .map { ($0.folder, $0.conversationCount) }
        )

        XCTAssertEqual(result[.all], 3)
        XCTAssertEqual(result[.unread], 1)
        XCTAssertEqual(result[.personal], 2)
        XCTAssertEqual(result[.work], 1)
        XCTAssertEqual(result[.groups], 1)
        XCTAssertEqual(result[.channels], 0)
        XCTAssertEqual(result[.saved], 1)
    }

    func testLoadedMessageSearchMatchesBodyAuthorAndUsernameAndSortsNewestFirst() {
        let conversationID = UUID(uuidString: "30000000-0000-0000-0000-000000000001")!
        var mira = me
        mira.displayName = "Мира"
        mira.username = "mira"
        let older = message(
            id: "40000000-0000-0000-0000-000000000001",
            conversationID: conversationID,
            author: mira,
            text: "Обсудим макет",
            seconds: 1
        )
        let newer = message(
            id: "40000000-0000-0000-0000-000000000002",
            conversationID: conversationID,
            author: me,
            text: "Макет готов",
            seconds: 2
        )

        XCTAssertEqual(
            PhoneLoadedMessageSearch.results(in: [older, newer], query: "  МАКЕТ ").map(\.id),
            [newer.id, older.id]
        )
        XCTAssertEqual(
            PhoneLoadedMessageSearch.results(in: [older, newer], query: "mira").map(\.id),
            [older.id]
        )
        XCTAssertTrue(PhoneLoadedMessageSearch.results(in: [older, newer], query: "нет").isEmpty)
    }

    private func conversation(
        id: String,
        kind: ConversationKind,
        unread: Int,
        folder: String
    ) -> Conversation {
        Conversation(
            id: UUID(uuidString: id)!,
            title: "Чат",
            subtitle: "",
            kind: kind,
            avatar: me,
            memberCount: 2,
            unreadCount: unread,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: .init(timeIntervalSince1970: 1),
            folder: folder
        )
    }

    private func message(
        id: String,
        conversationID: UUID,
        author: Participant,
        text: String,
        seconds: TimeInterval
    ) -> ChatMessage {
        ChatMessage(
            id: UUID(uuidString: id)!,
            conversationID: conversationID,
            author: author,
            text: text,
            sentAt: .init(timeIntervalSince1970: seconds),
            delivery: .read,
            isOutgoing: author.id == me.id
        )
    }
}
