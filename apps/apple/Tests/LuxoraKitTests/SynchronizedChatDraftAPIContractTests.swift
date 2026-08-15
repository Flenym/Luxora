import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class SynchronizedChatDraftAPIContractTests: XCTestCase {
    private let chatID = UUID(uuidString: "9EC9347C-9306-4108-AAB4-E7762B73B201")!
    private let replyID = UUID(uuidString: "A0DF9334-2EC0-422D-B5DE-11C775A42344")!
    private let nonce = UUID(uuidString: "9E7A3010-8291-4E0F-8557-AADD419FFBC4")!

    override func tearDown() {
        DraftContractURLProtocol.handler = nil
        DraftContractURLProtocol.responseHeaders = [:]
        super.tearDown()
    }

    func testGETUsesPrivateAuthenticatedChatPathAndAcceptsRevisionZero() async throws {
        let chatID = chatID
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/draft")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-secret")
            XCTAssertNil(request.httpBody)
            return (200, Self.json(["draft": NSNull(), "revision": 0]))
        }

        let state = try await client.chatDraft(chatID: chatID, token: "access-secret")

        XCTAssertNil(state.draft)
        XCTAssertEqual(state.revision, 0)
    }

    func testPUTPreservesUnicodeTextReplyCASAndCanonicalNonce() async throws {
        let chatID = chatID
        let replyID = replyID
        let nonce = nonce
        let text = "💎 Черновик\nбез нормализации"
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/draft")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-secret")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try request.jsonObject()
            XCTAssertEqual(Set(body.keys), ["text", "replyToMessageId", "expectedRevision", "clientNonce"])
            XCTAssertEqual(body["text"] as? String, text)
            XCTAssertEqual(body["replyToMessageId"] as? String, replyID.apiPathComponent)
            XCTAssertEqual((body["expectedRevision"] as? NSNumber)?.intValue, 4)
            XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
            return (200, Self.activeEnvelope(
                chatID: chatID,
                text: text,
                replyID: replyID,
                revision: 5,
                replayed: false
            ))
        }

        let result = try await client.putChatDraft(
            chatID: chatID,
            command: ChatDraftPutCommand(
                content: .init(text: text, replyToMessageID: replyID),
                expectedRevision: 4,
                clientNonce: nonce
            ),
            token: "access-secret"
        )

        XCTAssertEqual(result.state.draft?.text, text)
        XCTAssertEqual(result.state.draft?.replyToMessageID, replyID)
        XCTAssertEqual(result.state.revision, 5)
        XCTAssertFalse(result.replayed)
    }

    func testDELETECarriesPositiveCASAndStableNonceInJSONBody() async throws {
        let chatID = chatID
        let nonce = nonce
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/draft")
            let body = try request.jsonObject()
            XCTAssertEqual(Set(body.keys), ["expectedRevision", "clientNonce"])
            XCTAssertEqual((body["expectedRevision"] as? NSNumber)?.intValue, 8)
            XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
            return (200, Self.json([
                "draft": NSNull(),
                "revision": 9,
                "replayed": false,
            ]))
        }

        let result = try await client.deleteChatDraft(
            chatID: chatID,
            command: ChatDraftDeleteCommand(expectedRevision: 8, clientNonce: nonce),
            token: "access-secret"
        )

        XCTAssertNil(result.state.draft)
        XCTAssertEqual(result.state.revision, 9)
    }

    func testUnicodeCodePointLimitAcceptsTenThousandAndRejectsNextWithoutNetwork() async throws {
        let calls = LockedDraftContractCounter()
        let chatID = chatID
        let nonce = nonce
        let boundary = String(repeating: "💎", count: 10_000)
        let client = makeClient { _ in
            _ = calls.increment()
            return (200, Self.activeEnvelope(
                chatID: chatID,
                text: boundary,
                replyID: nil,
                revision: 1,
                replayed: false
            ))
        }

        _ = try await client.putChatDraft(
            chatID: chatID,
            command: .init(
                content: .init(text: boundary),
                expectedRevision: 0,
                clientNonce: nonce
            ),
            token: "token"
        )
        XCTAssertEqual(calls.current, 1)

        do {
            _ = try await client.putChatDraft(
                chatID: chatID,
                command: .init(
                    content: .init(text: boundary + "💎"),
                    expectedRevision: 1,
                    clientNonce: nonce
                ),
                token: "token"
            )
            XCTFail("Expected over-limit input rejection")
        } catch LuxoraAPIError.invalidResponse {
            // Expected before URLSession receives the private text.
        }
        XCTAssertEqual(calls.current, 1)
    }

    func testMismatchedChatAndRevisionResponsesFailClosed() async throws {
        let chatID = chatID
        let otherChatID = UUID(uuidString: "FEC9347C-9306-4108-AAB4-E7762B73B202")!
        let counter = LockedDraftContractCounter()
        let client = makeClient { _ in
            let call = counter.increment()
            if call == 1 {
                return (200, Self.activeEnvelope(
                    chatID: otherChatID,
                    text: "wrong chat",
                    replyID: nil,
                    revision: 1,
                    replayed: nil
                ))
            }
            var draft = Self.activeDraft(
                chatID: chatID,
                text: "wrong revision",
                replyID: nil,
                revision: 2
            )
            draft["revision"] = 3
            return (200, Self.json(["draft": draft, "revision": 2]))
        }

        do {
            _ = try await client.chatDraft(chatID: chatID, token: "token")
            XCTFail("Expected cross-chat rejection")
        } catch LuxoraAPIError.invalidResponse {}
        do {
            _ = try await client.chatDraft(chatID: chatID, token: "token")
            XCTFail("Expected revision mismatch rejection")
        } catch LuxoraAPIError.invalidResponse {}
    }

    func testRequiredNullableDraftAndReplyKeysFailClosedWhenMissing() async throws {
        let chatID = chatID
        let counter = LockedDraftContractCounter()
        let client = makeClient { request in
            switch counter.increment() {
            case 1:
                XCTAssertEqual(request.httpMethod, "GET")
                return (200, Self.json(["revision": 0]))
            case 2:
                var draft = Self.activeDraft(
                    chatID: chatID,
                    text: "missing nullable reply key",
                    replyID: nil,
                    revision: 1
                )
                draft.removeValue(forKey: "replyToMessageId")
                return (200, Self.json(["draft": draft, "revision": 1]))
            case 3:
                XCTAssertEqual(request.httpMethod, "PUT")
                return (200, Self.json(["revision": 1, "replayed": false]))
            default:
                var draft = Self.activeDraft(
                    chatID: chatID,
                    text: "missing nullable reply key",
                    replyID: nil,
                    revision: 1
                )
                draft.removeValue(forKey: "replyToMessageId")
                return (200, Self.json([
                    "draft": draft,
                    "revision": 1,
                    "replayed": false,
                ]))
            }
        }

        for _ in 0..<2 {
            do {
                _ = try await client.chatDraft(chatID: chatID, token: "token")
                XCTFail("Expected missing required nullable GET key rejection")
            } catch LuxoraAPIError.invalidResponse {}
        }
        for _ in 0..<2 {
            do {
                _ = try await client.putChatDraft(
                    chatID: chatID,
                    command: .init(
                        content: .init(text: "missing nullable key"),
                        expectedRevision: 0,
                        clientNonce: nonce
                    ),
                    token: "token"
                )
                XCTFail("Expected missing required nullable mutation key rejection")
            } catch LuxoraAPIError.invalidResponse {}
        }
        XCTAssertEqual(counter.current, 4)
    }

    func testDraftDecodersContinueAcceptingUnknownAdditiveFields() async throws {
        let chatID = chatID
        let client = makeClient { _ in
            var draft = Self.activeDraft(
                chatID: chatID,
                text: "future-compatible",
                replyID: nil,
                revision: 1
            )
            draft["futureDraftField"] = ["nested": true]
            return (200, Self.json([
                "draft": draft,
                "revision": 1,
                "futureEnvelopeField": "ignored",
            ]))
        }

        let state = try await client.chatDraft(chatID: chatID, token: "token")

        XCTAssertEqual(state.draft?.text, "future-compatible")
        XCTAssertNil(state.draft?.replyToMessageID)
        XCTAssertEqual(state.revision, 1)
    }

    func testCAS409MapsStatusWithoutLeakingTokenOrDraftThroughLocalizedError() async throws {
        let privateText = "СЕКРЕТНЫЙ ЧЕРНОВИК"
        let token = "VERY-SECRET-ACCESS-TOKEN"
        let userID = "F650E2AB-4185-493D-81A2-BD4F19B84F10"
        let canaries = [privateText, token, chatID.apiPathComponent, userID, nonce.apiPathComponent]
        let client = makeClient { _ in
            (409, Self.json([
                "error": [
                    "code": "CONFLICT",
                    "message": canaries.joined(separator: " "),
                    "requestId": "request-1",
                ],
            ]))
        }

        do {
            _ = try await client.putChatDraft(
                chatID: chatID,
                command: .init(
                    content: .init(text: privateText),
                    expectedRevision: 7,
                    clientNonce: nonce
                ),
                token: token
            )
            XCTFail("Expected CAS conflict")
        } catch let error as LuxoraAPIError {
            guard case let .server(status, code, _) = error else {
                return XCTFail("Expected server error")
            }
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "CONFLICT")
            for canary in canaries {
                XCTAssertFalse(error.localizedDescription.contains(canary))
                XCTAssertFalse(String(reflecting: error).contains(canary))
            }
        }
    }

    func testGETSanitizesHostile404And409ServerEnvelopes() async throws {
        let token = "GET-PRIVATE-BEARER-TOKEN"
        let userID = "F650E2AB-4185-493D-81A2-BD4F19B84F10"
        let canaries = [
            "GET-PRIVATE-DRAFT-TEXT",
            token,
            chatID.apiPathComponent,
            userID,
            nonce.apiPathComponent,
        ]
        let counter = LockedDraftContractCounter()
        let client = makeClient { _ in
            let call = counter.increment()
            return (
                call == 1 ? 404 : 409,
                Self.json([
                    "error": [
                        "code": call == 1 ? "HOSTILE_\(canaries.last!)" : "CONFLICT",
                        "message": canaries.joined(separator: " "),
                        "requestId": "request-private",
                    ],
                ])
            )
        }

        for (expectedStatus, expectedCode) in [(404, "HTTP_404"), (409, "CONFLICT")] {
            do {
                _ = try await client.chatDraft(chatID: chatID, token: token)
                XCTFail("Expected sanitized draft GET rejection")
            } catch let error as LuxoraAPIError {
                guard case let .server(status, code, _) = error else {
                    return XCTFail("Expected server error")
                }
                XCTAssertEqual(status, expectedStatus)
                XCTAssertEqual(code, expectedCode)
                for canary in canaries {
                    XCTAssertFalse(error.localizedDescription.contains(canary))
                    XCTAssertFalse(String(reflecting: error).contains(canary))
                }
            }
        }
    }

    func testRateLimitPrefersHeaderAndNeverExposesResponseBodyTokenOrDraft() async throws {
        let privateText = "ПРИВАТНЫЙ ЧЕРНОВИК"
        let token = "PRIVATE-BEARER-TOKEN"
        DraftContractURLProtocol.responseHeaders = ["Retry-After": "7"]
        let client = makeClient { _ in
            (429, Self.json([
                "error": [
                    "code": "RATE_LIMITED",
                    "message": "\(privateText) \(token)",
                    "requestId": "request-private",
                    "details": ["retryAfterSeconds": 19],
                ],
            ]))
        }

        do {
            _ = try await client.putChatDraft(
                chatID: chatID,
                command: .init(
                    content: .init(text: privateText),
                    expectedRevision: 4,
                    clientNonce: nonce
                ),
                token: token
            )
            XCTFail("Expected typed rate limit")
        } catch let error as ChatDraftRateLimitError {
            XCTAssertEqual(error.retryAfterSeconds, 7)
            XCTAssertFalse(error.localizedDescription.contains(privateText))
            XCTAssertFalse(error.localizedDescription.contains(token))
            XCTAssertFalse(String(reflecting: error).contains(privateText))
            XCTAssertFalse(String(reflecting: error).contains(token))
        }
    }

    func testRateLimitUsesDetailsWithoutHeaderAndClampsEveryDelay() async throws {
        let client = makeClient { _ in
            (429, Self.json([
                "error": [
                    "code": "RATE_LIMITED",
                    "message": "later",
                    "requestId": "request-1",
                    "details": ["retryAfterSeconds": 999_999_999],
                ],
            ]))
        }

        do {
            _ = try await client.deleteChatDraft(
                chatID: chatID,
                command: .init(expectedRevision: 1, clientNonce: nonce),
                token: "token"
            )
            XCTFail("Expected typed rate limit")
        } catch let error as ChatDraftRateLimitError {
            XCTAssertEqual(error.retryAfterSeconds, 86_400)
        }

        XCTAssertEqual(ChatDraftRateLimitError(retryAfterSeconds: -99).retryAfterSeconds, 1)
        XCTAssertEqual(
            ChatDraftRateLimitError(
                headerValue: "0",
                detailValue: 30
            ).retryAfterSeconds,
            1,
            "A parseable header is authoritative and bounded"
        )
    }

    private func makeClient(
        _ handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> LuxoraAPIClient {
        DraftContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DraftContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://drafts.contract.invalid")!,
                realtimeURL: URL(string: "wss://drafts.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private nonisolated static func activeEnvelope(
        chatID: UUID,
        text: String,
        replyID: UUID?,
        revision: Int,
        replayed: Bool?
    ) -> Data {
        var envelope: [String: Any] = [
            "draft": activeDraft(
                chatID: chatID,
                text: text,
                replyID: replyID,
                revision: revision
            ),
            "revision": revision,
        ]
        if let replayed { envelope["replayed"] = replayed }
        return json(envelope)
    }

    private nonisolated static func activeDraft(
        chatID: UUID,
        text: String,
        replyID: UUID?,
        revision: Int
    ) -> [String: Any] {
        [
            "chatId": chatID.apiPathComponent,
            "text": text,
            "replyToMessageId": replyID?.apiPathComponent ?? NSNull(),
            "revision": revision,
            "updatedAt": "2026-08-15T09:00:00Z",
        ]
    }

    private nonisolated static func json(_ object: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }
}

private final class DraftContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    nonisolated(unsafe) static var responseHeaders: [String: String] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw DraftContractHarnessError.missingHandler }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"].merging(
                    Self.responseHeaders,
                    uniquingKeysWith: { _, new in new }
                )
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

private enum DraftContractHarnessError: Error {
    case missingHandler
}

private final class LockedDraftContractCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private extension URLRequest {
    func jsonObject() throws -> [String: Any] {
        let data = try bodyData()
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func bodyData() throws -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? DraftContractHarnessError.missingHandler }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
