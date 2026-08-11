import Foundation
@testable import LuxoraKit
import XCTest

final class CursorPaginationAPIContractTests: XCTestCase {
    override func tearDown() {
        CursorPaginationURLProtocol.handler = nil
        super.tearDown()
    }

    func testChatsExhaustSecondPageAndFolderCanProjectExplicitPageTwoChat() async throws {
        let pageOne = (1...100).map(Self.chat)
        let pageTwoChat = Self.chat(101)
        let firstResponse = Self.json(["items": pageOne, "nextCursor": "page two/+opaque"])
        let secondResponse = Self.json(["items": [pageTwoChat], "nextCursor": NSNull()])
        CursorPaginationURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token")
            switch request.url?.query {
            case "limit=100":
                return firstResponse
            case "limit=100&cursor=page%20two/%2Bopaque":
                return secondResponse
            default:
                XCTFail("Unexpected query \(request.url?.query ?? "nil")")
                return Self.json([:], status: 500)
            }
        }

        let chats = try await makeClient().chats(token: "token")
        XCTAssertEqual(chats.count, 101)
        let conversations = chats.map { $0.conversation(currentUserID: Self.userID) }
        let pageTwoID = try XCTUnwrap(UUID(uuidString: pageTwoChat["id"] as! String))
        let folder = Self.folder(
            overrides: [ChatFolderOverride(
                chatID: pageTwoID,
                mode: .include,
                pinnedPosition: 0
            )]
        )
        XCTAssertEqual(folder.projectedConversations(conversations).map(\.id), [pageTwoID])
    }

    func testMessagesExhaustThreePagesAndReturnOneChronologicalHistory() async throws {
        let chatID = Self.chatID
        let newestFirst = (1...201).reversed().map { Self.message($0, chatID: chatID) }
        let firstResponse = Self.json([
            "items": Array(newestFirst[0..<100]),
            "nextCursor": "messages-2",
        ])
        let secondResponse = Self.json([
            "items": Array(newestFirst[100..<200]),
            "nextCursor": "messages-3",
        ])
        let thirdResponse = Self.json([
            "items": Array(newestFirst[200..<201]),
            "nextCursor": NSNull(),
        ])
        CursorPaginationURLProtocol.handler = { request in
            switch request.url?.query {
            case "limit=100":
                return firstResponse
            case "limit=100&cursor=messages-2":
                return secondResponse
            case "limit=100&cursor=messages-3":
                return thirdResponse
            default:
                return Self.json([:], status: 500)
            }
        }

        let messages = try await makeClient().messages(chatID: chatID, token: "token")
        XCTAssertEqual(messages.count, 201)
        XCTAssertEqual(messages.first?.body, "message-1")
        XCTAssertEqual(messages.last?.body, "message-201")
    }

    func testRepeatedCursorAndDuplicateResourceFailClosed() async {
        let callCounter = LockedCounter()
        CursorPaginationURLProtocol.handler = { _ in
            let call = callCounter.increment()
            return Self.json([
                "items": call == 1 ? [Self.chat(1)] : [Self.chat(1)],
                "nextCursor": call == 1 ? "repeat" : "repeat",
            ])
        }

        do {
            _ = try await makeClient().chats(token: "token")
            XCTFail("Duplicate page resources/cursors must be rejected")
        } catch LuxoraAPIError.invalidResponse {
            XCTAssertEqual(callCounter.value, 2)
        } catch {
            XCTFail("Expected invalidResponse, got \(error)")
        }
    }

    func testEndlessUniqueCursorsStopAtBoundedPageLimit() async {
        let callCounter = LockedCounter()
        CursorPaginationURLProtocol.handler = { _ in
            let call = callCounter.increment()
            return Self.json(["items": [], "nextCursor": "unique-\(call)"])
        }

        do {
            _ = try await makeClient().chats(token: "token")
            XCTFail("An endless unique cursor stream must be bounded")
        } catch LuxoraAPIError.invalidResponse {
            XCTAssertEqual(callCounter.value, LuxoraAPIClient.maximumCursorPages)
        } catch {
            XCTFail("Expected invalidResponse, got \(error)")
        }
    }

    private func makeClient() -> LuxoraAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CursorPaginationURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://pagination.invalid")!,
                realtimeURL: URL(string: "wss://pagination.invalid/v2/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static func folder(overrides: [ChatFolderOverride]) -> ChatFolder {
        ChatFolder(
            id: UUID(uuidString: "F1000000-0000-4000-8000-000000000001")!,
            title: "Только вручную",
            position: 0,
            revision: 1,
            rules: ChatFolderRules(
                includeKinds: [],
                unreadOnly: false,
                excludeMuted: false,
                includeArchived: false
            ),
            overrides: overrides,
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 1)
        )
    }

    private static func chat(_ index: Int) -> [String: Any] {
        [
            "id": uuid(index),
            "kind": "direct",
            "title": "Чат \(index)",
            "avatarUrl": NSNull(),
            "role": "member",
            "memberCount": 2,
            "lastMessage": NSNull(),
            "lastActivityAt": "2026-08-11T09:00:00Z",
            "createdAt": "2026-08-11T08:00:00Z",
            "unreadCount": 0,
            "archivedAt": NSNull(),
            "mutedUntil": NSNull(),
        ]
    }

    private static func message(_ index: Int, chatID: UUID) -> [String: Any] {
        [
            "id": uuid(10_000 + index),
            "chatId": chatID.uuidString.lowercased(),
            "sender": user,
            "kind": "text",
            "body": "message-\(index)",
            "replyToMessageId": NSNull(),
            "topicId": NSNull(),
            "forwardedFrom": NSNull(),
            "isPinned": false,
            "clientNonce": uuid(20_000 + index),
            "revision": 0,
            "createdAt": String(format: "2026-08-11T09:%02d:%02dZ", (index / 60) % 60, index % 60),
            "updatedAt": String(format: "2026-08-11T09:%02d:%02dZ", (index / 60) % 60, index % 60),
            "editedAt": NSNull(),
            "deletedAt": NSNull(),
        ]
    }

    private static var user: [String: Any] {
        [
            "id": userID.uuidString.lowercased(),
            "username": "pagination-user",
            "displayName": "Pagination User",
            "bio": "",
            "avatarUrl": NSNull(),
            "avatarPath": NSNull(),
            "createdAt": "2026-08-11T08:00:00Z",
            "presence": "offline",
            "lastSeenAt": NSNull(),
        ]
    }

    private static func uuid(_ index: Int) -> String {
        String(format: "00000000-0000-4000-8000-%012d", index)
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

    private static let userID = UUID(uuidString: "A0000000-0000-4000-8000-000000000001")!
    private static let chatID = UUID(uuidString: "B0000000-0000-4000-8000-000000000001")!
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() -> Int { lock.withLock { count += 1; return count } }
}

private final class CursorPaginationURLProtocol: URLProtocol, @unchecked Sendable {
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
