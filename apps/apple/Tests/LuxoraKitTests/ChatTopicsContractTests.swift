import Foundation
@testable import LuxoraKit
import XCTest

final class ChatTopicsContractTests: XCTestCase {
    private let chatID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let userID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let topicID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    private let nonce = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!

    override func tearDown() {
        TopicsContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testSendBodyCarriesTopicOnlyWhenSelected() throws {
        let plain = APIChatBody.sendMessage(
            clientNonce: nonce,
            body: "Привет",
            replyToMessageID: nil,
            attachmentIDs: []
        )
        let plainJSON = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(plain)
        ) as? [String: Any]
        XCTAssertNil(plainJSON?["topicId"])

        let topical = APIChatBody.sendMessage(
            clientNonce: nonce,
            body: "Привет",
            replyToMessageID: nil,
            topicID: topicID,
            attachmentIDs: []
        )
        let topicalJSON = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(topical)
        ) as? [String: Any]
        XCTAssertEqual(topicalJSON?["topicId"] as? String, topicID.apiPathComponent)
    }

    func testTopicDecodingValidatesChatBindingTitleAndTimestamps() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let valid = try decoder.decode(
            APITopic.self,
            from: topicData(title: "Анонсы", chatID: chatID)
        )
        let topic = try valid.topic(expectedChatID: chatID)
        XCTAssertEqual(topic.title, "Анонсы")
        XCTAssertFalse(topic.isClosed)

        XCTAssertThrowsError(
            try valid.topic(expectedChatID: UUID(uuidString: "99999999-9999-4999-8999-999999999999")!)
        )
        let blank = try decoder.decode(
            APITopic.self,
            from: topicData(title: "   ", chatID: chatID)
        )
        XCTAssertThrowsError(try blank.topic(expectedChatID: chatID))
    }

    func testTopicsLifecycleUsesExactContract() async throws {
        let recorder = TopicsRequestRecorder()
        TopicsContractURLProtocol.handler = { [chatID, userID, topicID, nonce] request in
            recorder.record("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/chats/\(chatID.apiPathComponent)/topics"):
                XCTAssertNil(request.httpBody)
                return Self.jsonResponse(["items": [Self.topicJSON(
                    id: topicID,
                    chatID: chatID,
                    userID: userID,
                    title: "Анонсы"
                )]])
            case ("POST", "/v1/chats/\(chatID.apiPathComponent)/topics"):
                let json = try request.topicsJSONBody()
                XCTAssertEqual(Set(json.keys), ["title"])
                XCTAssertEqual(json["title"] as? String, "Релизы")
                return Self.jsonResponse(
                    ["topic": Self.topicJSON(id: topicID, chatID: chatID, userID: userID, title: "Релизы")],
                    status: 201
                )
            case ("PATCH", "/v1/topics/\(topicID.apiPathComponent)"):
                let json = try request.topicsJSONBody()
                XCTAssertEqual(Set(json.keys), ["closed"])
                XCTAssertEqual((json["closed"] as? NSNumber)?.boolValue, true)
                return Self.jsonResponse(["topic": Self.topicJSON(
                    id: topicID,
                    chatID: chatID,
                    userID: userID,
                    title: "Релизы",
                    closedAt: "2026-09-13T12:05:00Z"
                )])
            default:
                XCTFail("Unexpected topics request")
                return Self.jsonResponse([:], status: 500)
            }
        }

        let client = makeClient()
        let listed = try await client.chatTopics(chatID: chatID, token: "access-token")
        XCTAssertEqual(listed.map(\.id), [topicID])
        XCTAssertFalse(listed.first?.isClosed ?? true)

        let created = try await client.createChatTopic(
            chatID: chatID,
            title: "  Релизы  ",
            token: "access-token"
        )
        XCTAssertEqual(created.title, "Релизы")

        let closed = try await client.updateChatTopic(
            chatID: chatID,
            topicID: topicID,
            title: nil,
            closed: true,
            token: "access-token"
        )
        XCTAssertTrue(closed.isClosed)
        XCTAssertEqual(recorder.requests, [
            "GET /v1/chats/\(chatID.apiPathComponent)/topics",
            "POST /v1/chats/\(chatID.apiPathComponent)/topics",
            "PATCH /v1/topics/\(topicID.apiPathComponent)",
        ])
    }

    func testTopicStoreLoadsMutatesAndMapsForbiddenHonestly() async {
        let chatID = chatID
        let topic = ChatTopic(
            topicID: topicID,
            chatID: chatID,
            title: "Анонсы",
            createdBy: Participant(
                id: userID,
                displayName: "Flenym",
                username: "flenym",
                initials: "FL",
                accentHex: "7C48D4",
                isOnline: false,
                status: "@flenym"
            ),
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 1),
            closedAt: nil
        )
        let store = await ChatTopicsStore()
        await store.configureRemote(
            loader: { _ in [topic] },
            creator: { _, title in
                ChatTopic(
                    topicID: UUID(),
                    chatID: chatID,
                    title: title,
                    createdBy: topic.createdBy,
                    createdAt: Date(),
                    updatedAt: Date(),
                    closedAt: nil
                )
            },
            updater: { _, _, _, _ in
                throw LuxoraAPIError.server(status: 403, code: "FORBIDDEN", message: "denied")
            }
        )

        await store.refresh(chatID: chatID)
        let loaded = await store.topics(for: chatID)
        XCTAssertEqual(loaded.map(\.title), ["Анонсы"])
        let loadState = await store.loadState(for: chatID)
        XCTAssertEqual(loadState, .loaded)

        let didCreate = await store.create(chatID: chatID, title: "Релизы")
        XCTAssertTrue(didCreate)
        let afterCreate = await store.topics(for: chatID)
        XCTAssertEqual(afterCreate.count, 2)

        let invalidCreated = await store.create(chatID: chatID, title: "   ")
        XCTAssertFalse(invalidCreated)
        let afterInvalid = await store.topics(for: chatID)
        XCTAssertEqual(afterInvalid.count, 2)

        let closed = await store.setClosed(chatID: chatID, topicID: topicID, closed: true)
        XCTAssertFalse(closed)
        let mutationState = await store.mutationState
        guard case let .failed(message) = mutationState else {
            return XCTFail("Expected a visible failure")
        }
        XCTAssertTrue(message.contains("владельцы"))
    }

    private func makeClient() -> LuxoraAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TopicsContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://topics.contract.invalid")!,
                realtimeURL: URL(string: "wss://topics.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private func topicData(title: String, chatID: UUID) -> Data {
        let object: [String: Any] = [
            "id": topicID.apiPathComponent,
            "chatId": chatID.apiPathComponent,
            "title": title,
            "createdBy": Self.userJSON(id: userID),
            "createdAt": "2026-09-13T12:00:00Z",
            "updatedAt": "2026-09-13T12:00:00Z",
            "closedAt": NSNull(),
        ]
        return (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    private static func topicJSON(
        id: UUID,
        chatID: UUID,
        userID: UUID,
        title: String,
        closedAt: String? = nil
    ) -> [String: Any] {
        [
            "id": id.apiPathComponent,
            "chatId": chatID.apiPathComponent,
            "title": title,
            "createdBy": userJSON(id: userID),
            "createdAt": "2026-09-13T12:00:00Z",
            "updatedAt": "2026-09-13T12:00:00Z",
            "closedAt": closedAt.map { $0 as Any } ?? NSNull(),
        ]
    }

    private static func userJSON(id: UUID) -> [String: Any] {
        [
            "id": id.apiPathComponent,
            "username": "flenym",
            "displayName": "Flenym",
            "bio": "",
            "avatarUrl": NSNull(),
            "avatarPath": NSNull(),
            "createdAt": "2026-08-01T09:00:00Z",
        ]
    }

    private static func jsonResponse(
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

private final class TopicsRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var requests: [String] { lock.withLock { storage } }
    func record(_ request: String) { lock.withLock { storage.append(request) } }
}

private final class TopicsContractURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw TopicsContractHarnessError.missingHandler
            }
            let (status, headers, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private enum TopicsContractHarnessError: Error {
    case missingHandler
}

private extension URLRequest {
    func topicsJSONBody() throws -> [String: Any] {
        if let httpBody { return try JSONSerialization.jsonObject(with: httpBody) as? [String: Any] ?? [:] }
        guard let stream = httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw stream.streamError ?? TopicsContractHarnessError.missingHandler
            }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return try JSONSerialization.jsonObject(with: result) as? [String: Any] ?? [:]
    }
}
