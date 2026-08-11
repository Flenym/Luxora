import Foundation
@testable import LuxoraKit
import XCTest

final class ChatFoldersAPIContractTests: XCTestCase {
    private let folderID = UUID(uuidString: "F1000000-0000-4000-8000-000000000001")!
    private let secondFolderID = UUID(uuidString: "F2000000-0000-4000-8000-000000000002")!
    private let includeChatID = UUID(uuidString: "C1000000-0000-4000-8000-000000000001")!
    private let pinnedChatID = UUID(uuidString: "C2000000-0000-4000-8000-000000000002")!
    private let nonce = UUID(uuidString: "A1000000-0000-4000-8000-000000000001")!

    override func tearDown() {
        ChatFoldersContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testGetUsesExactRouteBearerAndNoBody() async throws {
        ChatFoldersContractURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/chat-folders")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token")
            XCTAssertNil(request.httpBody)
            return Self.json(["items": [], "stateRevision": 0])
        }

        let snapshot = try await makeClient().folders(token: "token")
        XCTAssertTrue(snapshot.folders.isEmpty)
        XCTAssertEqual(snapshot.stateRevision, 0)
    }

    func testCreateEncodesCanonicalRulesAndRequiredNullablePinKeys() async throws {
        let folderID = folderID
        let includeChatID = includeChatID
        let pinnedChatID = pinnedChatID
        let nonce = nonce
        ChatFoldersContractURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/chat-folders")
            let body = try request.folderBodyObject()
            XCTAssertEqual(Set(body.keys), ["title", "rules", "overrides", "clientNonce"])
            XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
            let rules = try XCTUnwrap(body["rules"] as? [String: Any])
            XCTAssertEqual(Set(rules.keys), ["includeKinds", "unreadOnly", "excludeMuted", "includeArchived"])
            XCTAssertEqual(rules["includeKinds"] as? [String], ["direct", "channel"])
            let overrides = try XCTUnwrap(body["overrides"] as? [[String: Any]])
            XCTAssertEqual(overrides.count, 2)
            XCTAssertEqual(overrides[0]["chatId"] as? String, pinnedChatID.apiPathComponent)
            XCTAssertEqual(overrides[0]["pinnedPosition"] as? Int, 0)
            XCTAssertEqual(overrides[1]["chatId"] as? String, includeChatID.apiPathComponent)
            XCTAssertTrue(overrides[1].keys.contains("pinnedPosition"))
            XCTAssertTrue(overrides[1]["pinnedPosition"] is NSNull)
            return Self.json([
                "folder": Self.folderJSON(
                    id: folderID,
                    title: "Работа",
                    position: 0,
                    revision: 1,
                    includeKinds: ["direct", "channel"],
                    overrides: overrides
                ),
                "stateRevision": 1,
                "replayed": false,
            ])
        }

        let receipt = try await makeClient().create(
            ChatFolderCreateCommand(
                draft: ChatFolderDraft(
                    title: "  Работа  ",
                    rules: ChatFolderRules(
                        includeKinds: [.channel, .direct],
                        unreadOnly: false,
                        excludeMuted: false,
                        includeArchived: false
                    ),
                    overrides: [
                        ChatFolderOverride(
                            chatID: includeChatID,
                            mode: .include,
                            pinnedPosition: nil
                        ),
                        ChatFolderOverride(
                            chatID: pinnedChatID,
                            mode: .include,
                            pinnedPosition: 0
                        ),
                    ]
                ),
                clientNonce: nonce
            ),
            token: "token"
        )
        XCTAssertEqual(receipt.folder.id, folderID)
        XCTAssertEqual(receipt.folder.title, "Работа")
    }

    func testPatchDeleteAndOrderUseExactCASFieldsAndRoutes() async throws {
        let folderID = folderID
        let secondFolderID = secondFolderID
        let nonce = nonce
        let recorder = FolderRequestRecorder()
        ChatFoldersContractURLProtocol.handler = { request in
            recorder.record(request)
            let body = try request.folderBodyObject()
            switch (request.httpMethod, request.url?.path) {
            case ("PATCH", "/v1/chat-folders/\(folderID.apiPathComponent)"):
                XCTAssertEqual(
                    Set(body.keys),
                    ["title", "rules", "overrides", "expectedRevision", "clientNonce"]
                )
                XCTAssertEqual(body["expectedRevision"] as? Int, 7)
                XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
                return Self.json([
                    "folder": Self.folderJSON(
                        id: folderID,
                        title: "Изменено",
                        position: 0,
                        revision: 8
                    ),
                    "stateRevision": 11,
                    "replayed": false,
                ])
            case ("DELETE", "/v1/chat-folders/\(folderID.apiPathComponent)"):
                XCTAssertEqual(Set(body.keys), ["expectedRevision", "clientNonce"])
                XCTAssertEqual(body["expectedRevision"] as? Int, 8)
                return Self.json([
                    "folderId": folderID.apiPathComponent,
                    "stateRevision": 12,
                    "replayed": false,
                ])
            case ("PUT", "/v1/chat-folders/order"):
                XCTAssertEqual(Set(body.keys), ["folderIds", "expectedStateRevision", "clientNonce"])
                XCTAssertEqual(
                    body["folderIds"] as? [String],
                    [secondFolderID.apiPathComponent, folderID.apiPathComponent]
                )
                XCTAssertEqual(body["expectedStateRevision"] as? Int, 12)
                return Self.json([
                    "items": [
                        Self.folderJSON(id: secondFolderID, title: "B", position: 0, revision: 2),
                        Self.folderJSON(id: folderID, title: "A", position: 1, revision: 9),
                    ],
                    "stateRevision": 13,
                    "replayed": false,
                ])
            default:
                XCTFail("Unexpected folder request \(request.httpMethod ?? "nil") \(request.url?.path ?? "nil")")
                return Self.json([:], status: 500)
            }
        }

        let client = makeClient()
        _ = try await client.patch(
            folderID: folderID,
            command: ChatFolderPatchCommand(
                title: "Изменено",
                rules: .allUnarchived,
                overrides: [],
                expectedRevision: 7,
                clientNonce: nonce
            ),
            token: "token"
        )
        _ = try await client.delete(
            folderID: folderID,
            command: ChatFolderDeleteCommand(expectedRevision: 8, clientNonce: nonce),
            token: "token"
        )
        _ = try await client.reorder(
            ChatFolderReorderCommand(
                folderIDs: [secondFolderID, folderID],
                expectedStateRevision: 12,
                clientNonce: nonce
            ),
            token: "token"
        )
        XCTAssertEqual(recorder.methods, ["PATCH", "DELETE", "PUT"])
    }

    func testResponseMissingRequiredNullablePinKeyFailsClosed() async {
        let malformedOverride: [String: Any] = [
            "chatId": includeChatID.apiPathComponent,
            "mode": "include",
        ]
        let malformedResponse = Self.json([
            "items": [Self.folderJSON(
                id: folderID,
                title: "Malformed",
                position: 0,
                revision: 1,
                overrides: [malformedOverride]
            )],
            "stateRevision": 1,
        ])
        ChatFoldersContractURLProtocol.handler = { _ in
            malformedResponse
        }

        do {
            _ = try await makeClient().folders(token: "token")
            XCTFail("Missing pinnedPosition must be rejected")
        } catch LuxoraAPIError.invalidResponse {
            // Expected.
        } catch {
            XCTFail("Expected invalidResponse, got \(error)")
        }
    }

    func testRateLimitClampsHostileRetryAfterAndTrustsOnlyExactReceiptLimits() async {
        ChatFoldersContractURLProtocol.handler = { _ in
            Self.json(
                [
                    "error": [
                        "code": "RATE_LIMITED",
                        "message": "later",
                        "details": [
                            "retryAfterSeconds": -5,
                            "idempotencyTtlSeconds": 1,
                            "maxActiveReceipts": 999,
                        ],
                    ],
                ],
                status: 429,
                headers: ["Retry-After": "999999999"]
            )
        }

        do {
            _ = try await makeClient().folders(token: "token")
            XCTFail("429 must throw a typed limit error")
        } catch let error as ChatFolderRateLimitError {
            XCTAssertEqual(error.retryAfterSeconds, ChatFolderContract.idempotencyTTLSeconds)
            XCTAssertNil(error.idempotencyTTLSeconds)
            XCTAssertNil(error.maximumActiveReceipts)
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }

    private func makeClient() -> LuxoraChatFoldersAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ChatFoldersContractURLProtocol.self]
        return LuxoraChatFoldersAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://folders.invalid")!,
                realtimeURL: URL(string: "wss://folders.invalid/v2/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static func folderJSON(
        id: UUID,
        title: String,
        position: Int,
        revision: Int,
        includeKinds: [String] = ["direct", "group", "channel"],
        overrides: [[String: Any]] = []
    ) -> [String: Any] {
        [
            "id": id.apiPathComponent,
            "title": title,
            "position": position,
            "revision": revision,
            "rules": [
                "includeKinds": includeKinds,
                "unreadOnly": false,
                "excludeMuted": false,
                "includeArchived": false,
            ],
            "overrides": overrides,
            "createdAt": "2026-08-11T09:00:00Z",
            "updatedAt": "2026-08-11T09:00:00Z",
        ]
    }

    private static func json(
        _ object: [String: Any],
        status: Int = 200,
        headers: [String: String] = [:]
    ) -> (Int, [String: String], Data) {
        (
            status,
            ["Content-Type": "application/json"].merging(headers) { _, right in right },
            (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        )
    }
}

private final class FolderRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    var methods: [String] { lock.withLock { values } }
    func record(_ request: URLRequest) {
        lock.withLock { values.append(request.httpMethod ?? "") }
    }
}

private final class ChatFoldersContractURLProtocol: URLProtocol, @unchecked Sendable {
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

private extension URLRequest {
    func folderBodyObject() throws -> [String: Any] {
        let data: Data
        if let httpBody {
            data = httpBody
        } else if let stream = httpBodyStream {
            stream.open()
            defer { stream.close() }
            var result = Data()
            var buffer = [UInt8](repeating: 0, count: 2_048)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                result.append(buffer, count: count)
            }
            data = result
        } else {
            data = Data()
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
