import Foundation
@testable import LuxoraKit
import XCTest

final class GlobalSearchStoreTests: XCTestCase {
    @MainActor
    func testPeopleSearchLoadsPagesAndDeduplicatesBoundaryItems() async throws {
        let first = Self.participant(1)
        let second = Self.participant(2)
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, cursor in
                if cursor == nil {
                    return GlobalSearchPage(items: [first], nextCursor: "people-2")
                }
                return GlobalSearchPage(items: [first, second], nextCursor: nil)
            },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )

        await store.search(query: "егор", scope: .people)
        XCTAssertEqual(store.people.map(\.id), [first.id])
        XCTAssertTrue(store.canLoadMore)

        await store.loadMore()
        XCTAssertEqual(store.people.map(\.id), [first.id, second.id])
        XCTAssertFalse(store.canLoadMore)
        XCTAssertEqual(store.state, .loaded)
    }

    @MainActor
    func testLatePreviousQueryCannotReplaceNewResults() async throws {
        let old = Self.participant(1)
        let new = Self.participant(2)
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { query, _ in
                if query == "старый" {
                    try await Task.sleep(for: .milliseconds(100))
                    return GlobalSearchPage(items: [old], nextCursor: nil)
                }
                return GlobalSearchPage(items: [new], nextCursor: nil)
            },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )

        let oldTask = Task { await store.search(query: "старый", scope: .people) }
        try await Task.sleep(for: .milliseconds(10))
        await store.search(query: "новый", scope: .people)
        await oldTask.value

        XCTAssertEqual(store.activeQuery, "новый")
        XCTAssertEqual(store.people.map(\.id), [new.id])
        XCTAssertEqual(store.state, .loaded)
    }

    @MainActor
    func testRepeatedCursorFailsClosedWithoutRequestLoop() async {
        let counter = SearchLockedCounter()
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, _ in
                _ = counter.increment()
                return GlobalSearchPage(items: [Self.participant(1)], nextCursor: "repeat")
            },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )

        await store.search(query: "query", scope: .people)
        await store.loadMore()

        guard case .failed = store.state else {
            return XCTFail("Repeated cursors must fail closed")
        }
        XCTAssertEqual(counter.value, 2)
        XCTAssertFalse(store.canLoadMore)
    }

    @MainActor
    func testBlankServerCursorFailsClosedBeforeAnyLoadMoreLoop() async {
        let counter = SearchLockedCounter()
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, _ in
                _ = counter.increment()
                return GlobalSearchPage(items: [Self.participant(1)], nextCursor: " \n")
            },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )

        await store.search(query: "query", scope: .people)
        guard case .failed = store.state else {
            return XCTFail("A blank server cursor must fail closed")
        }
        XCTAssertEqual(counter.value, 1)
        XCTAssertFalse(store.canLoadMore)

        await store.loadMore()
        XCTAssertEqual(counter.value, 1)
    }

    @MainActor
    func testTransientPageFailureCanRetryTheSameUnconsumedCursor() async {
        let first = Self.participant(1)
        let second = Self.participant(2)
        let counter = SearchLockedCounter()
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, cursor in
                let call = counter.increment()
                if cursor == nil {
                    return GlobalSearchPage(items: [first], nextCursor: "page-2")
                }
                if call == 2 { throw URLError(.timedOut) }
                return GlobalSearchPage(items: [second], nextCursor: nil)
            },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )

        await store.search(query: "query", scope: .people)
        await store.loadMore()
        guard case .failed = store.state else {
            return XCTFail("The injected transient failure must remain retryable")
        }
        XCTAssertTrue(store.canLoadMore)

        await store.retry()
        XCTAssertEqual(counter.value, 3)
        XCTAssertEqual(store.people.map(\.id), [first.id, second.id])
        XCTAssertEqual(store.state, .loaded)
        XCTAssertFalse(store.canLoadMore)
    }

    @MainActor
    func testEmptyAndLocalQueriesNeverCallRemoteLoaders() async {
        let counter = SearchLockedCounter()
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, _ in
                _ = counter.increment()
                return GlobalSearchPage(items: [], nextCursor: nil)
            },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )

        await store.search(query: "   ", scope: .people)
        XCTAssertEqual(store.state, .idle)
        await store.search(query: "болталка", scope: .channels)
        guard case .failed = store.state else {
            return XCTFail("Channels without a loader must fail closed")
        }
        XCTAssertEqual(counter.value, 0)
    }

    @MainActor
    func testSessionReplacementClearsResultsAndRemoteCapability() async {
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, _ in GlobalSearchPage(items: [Self.participant(1)], nextCursor: nil) },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )
        await store.search(query: "user", scope: .people)

        store.resetForSessionReplacement()
        XCTAssertTrue(store.people.isEmpty)
        XCTAssertNil(store.activeScope)
        XCTAssertEqual(store.state, .idle)

        await store.search(query: "user", scope: .people)
        guard case .failed = store.state else {
            return XCTFail("A replaced session must not retain the old loader")
        }
    }

    private static func participant(_ index: Int) -> Participant {
        Participant(
            id: UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", index))!,
            displayName: "Участник \(index)",
            username: "participant-\(index)",
            initials: "У\(index)",
            accentHex: "7C48D4",
            isOnline: false,
            status: "@participant-\(index)"
        )
    }

    private static func chatResult(_ index: Int, kind: String = "group") -> GlobalChatSearchResult {
        GlobalChatSearchResult(
            id: UUID(uuidString: String(format: "60000000-0000-4000-8000-%012d", index))!,
            title: "Походный клуб \(index)",
            kind: kind
        )
    }

    @MainActor
    func testChatsScopeLoadsPagesAndDeduplicatesBoundaryItems() async throws {
        let first = Self.chatResult(1)
        let second = Self.chatResult(2)
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            chats: { _, cursor in
                if cursor == nil {
                    return GlobalSearchPage(items: [first], nextCursor: "chats-2")
                }
                return GlobalSearchPage(items: [first, second], nextCursor: nil)
            }
        )

        await store.search(query: "поход", scope: .chats)
        XCTAssertEqual(store.chats.map(\.id), [first.id])
        XCTAssertTrue(store.canLoadMore)

        await store.loadMore()
        XCTAssertEqual(store.chats.map(\.id), [first.id, second.id])
        XCTAssertFalse(store.canLoadMore)
        XCTAssertEqual(store.state, .loaded)
    }

    @MainActor
    func testChatsScopeWithoutLoaderFailsClosedAsUnavailable() async throws {
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )

        await store.search(query: "поход", scope: .chats)
        guard case .failed = store.state else {
            return XCTFail("Chats without a loader must fail closed")
        }
        XCTAssertTrue(store.chats.isEmpty)
        XCTAssertFalse(store.canLoadMore)
    }

    @MainActor
    func testSessionReplacementClearsChatLoaders() async throws {
        let store = GlobalSearchStore()
        store.configureRemote(
            people: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            messages: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) },
            chats: { _, _ in GlobalSearchPage(items: [Self.chatResult(1)], nextCursor: nil) }
        )

        await store.search(query: "поход", scope: .chats)
        XCTAssertEqual(store.chats.count, 1)

        store.resetForSessionReplacement()
        await store.search(query: "поход", scope: .chats)
        guard case .failed = store.state else {
            return XCTFail("A replaced session must not retain the old loader")
        }
    }
}

final class GlobalSearchAPIContractTests: XCTestCase {
    override func tearDown() {
        GlobalSearchURLProtocol.handler = nil
        super.tearDown()
    }

    func testPeopleMessageAndFilePagesUseAuthenticatedOpaquePagination() async throws {
        GlobalSearchURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token")
            let components = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
            let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(items["q"], "Люксора test")
            XCTAssertEqual(items["limit"], "30")
            XCTAssertEqual(items["cursor"], "next/+opaque")

            switch components.path {
            case "/v1/users/search":
                return Self.json(["items": [Self.user], "nextCursor": NSNull()])
            case "/v1/search/messages":
                return Self.json(["items": [Self.message], "nextCursor": NSNull()])
            case "/v1/search/files":
                return Self.json(["items": [Self.file], "nextCursor": NSNull()])
            case "/v1/search/chats":
                return Self.json(["items": [Self.chat], "nextCursor": NSNull()])
            default:
                return Self.json([:], status: 404)
            }
        }

        let client = makeClient()
        let people = try await client.searchUsersPage(
            query: "  Люксора test  ",
            cursor: "next/+opaque",
            token: "token"
        )
        let messages = try await client.searchMessagesPage(
            query: "Люксора test",
            cursor: "next/+opaque",
            token: "token"
        )
        let files = try await client.searchFilesPage(
            query: "Люксора test",
            cursor: "next/+opaque",
            token: "token"
        )
        let chats = try await client.searchChatsPage(
            query: "Люксора test",
            cursor: "next/+opaque",
            token: "token"
        )

        XCTAssertEqual(people.items.single?.username, "search-user")
        XCTAssertEqual(messages.items.single?.globalSearchResult.text, "Люксора test")
        XCTAssertEqual(files.items.single?.globalSearchResult.fileName, "Luxora.pdf")
        XCTAssertEqual(chats.items.single?.globalSearchResult.title, "Походный клуб")
        XCTAssertNil(people.nextCursor)
        XCTAssertNil(messages.nextCursor)
        XCTAssertNil(files.nextCursor)
        XCTAssertNil(chats.nextCursor)
    }

    func testSearchRejectsEmptyQueryInvalidLimitAndEmptyCursorBeforeTransport() async {
        GlobalSearchURLProtocol.handler = { _ in
            XCTFail("Invalid client input must not reach transport")
            return Self.json([:], status: 500)
        }
        let client = makeClient()

        for operation in [
            { try await client.searchUsersPage(query: " ", cursor: nil, token: "token") as Any },
            { try await client.searchMessagesPage(query: "q", cursor: nil, limit: 101, token: "token") as Any },
            { try await client.searchFilesPage(query: "q", cursor: "", token: "token") as Any },
            { try await client.searchChatsPage(query: " ", cursor: nil, token: "token") as Any },
        ] {
            do {
                _ = try await operation()
                XCTFail("Invalid search input must fail")
            } catch LuxoraAPIError.invalidResponse {
                continue
            } catch {
                XCTFail("Expected invalidResponse, got \(error)")
            }
        }
    }

    private func makeClient() -> LuxoraAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GlobalSearchURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://search.invalid")!,
                realtimeURL: URL(string: "wss://search.invalid/v2/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static var user: [String: Any] {
        [
            "id": "10000000-0000-4000-8000-000000000001",
            "username": "search-user",
            "displayName": "Search User",
            "bio": "",
            "avatarUrl": NSNull(),
            "avatarPath": NSNull(),
            "createdAt": "2026-08-15T10:00:00Z",
            "presence": NSNull(),
            "lastSeenAt": NSNull(),
        ]
    }

    private static var message: [String: Any] {
        [
            "id": "20000000-0000-4000-8000-000000000001",
            "chatId": "30000000-0000-4000-8000-000000000001",
            "sender": user,
            "kind": "text",
            "body": "Люксора test",
            "replyToMessageId": NSNull(),
            "topicId": NSNull(),
            "forwardedFrom": NSNull(),
            "attachments": [],
            "isPinned": false,
            "clientNonce": "40000000-0000-4000-8000-000000000001",
            "revision": 0,
            "createdAt": "2026-08-15T10:00:00Z",
            "updatedAt": "2026-08-15T10:00:00Z",
            "editedAt": NSNull(),
            "deletedAt": NSNull(),
        ]
    }

    private static var chat: [String: Any] {
        [
            "id": "60000000-0000-4000-8000-000000000001",
            "kind": "group",
            "title": "Походный клуб",
            "avatarUrl": NSNull(),
            "role": "member",
            "memberCount": 3,
            "lastMessage": NSNull(),
            "lastActivityAt": "2026-08-15T10:00:00Z",
            "createdAt": "2026-08-15T10:00:00Z",
            "unreadCount": 0,
            "archivedAt": NSNull(),
            "mutedUntil": NSNull(),
        ]
    }

    private static var file: [String: Any] {        [
            "id": "50000000-0000-4000-8000-000000000001",
            "kind": "file",
            "fileName": "Luxora.pdf",
            "mimeType": "application/pdf",
            "sizeBytes": 1234,
            "sha256": String(repeating: "a", count: 64),
            "downloadPath": "/v1/attachments/50000000-0000-4000-8000-000000000001/content",
            "safetyStatus": "unscanned",
            "metadataTrust": "server_verified",
            "metadata": [:] as [String: Any],
            "createdAt": "2026-08-15T10:00:00Z",
        ]
    }

    private static func json(
        _ object: [String: Any],
        status: Int = 200
    ) -> (Int, [String: String], Data) {
        (
            status,
            ["Content-Type": "application/json"],
            (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        )
    }
}

private final class SearchLockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() -> Int { lock.withLock { count += 1; return count } }
}

private final class GlobalSearchURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, headers, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}
