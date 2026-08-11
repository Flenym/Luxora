import Foundation
@testable import LuxoraKit
import XCTest

final class MessageMutationAPIContractTests: XCTestCase {
    private let chatID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let messageID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let replyID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    private let nonce = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!

    override func tearDown() {
        MutationContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testReplyUsesStrictSendContractAndDecodesReplyMetadata() async throws {
        let client = makeClient { [chatID, messageID, replyID, nonce] request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/messages")
            XCTAssertEqual(try request.jsonBody(), [
                "body": "Ответ",
                "clientNonce": nonce.apiPathComponent,
                "kind": "text",
                "replyToMessageId": replyID.apiPathComponent,
            ])
            return (201, messageEnvelope(
                messageID: messageID,
                chatID: chatID,
                nonce: nonce,
                body: "Ответ",
                replyToID: replyID
            ))
        }

        let response = try await client.sendMessage(
            chatID: chatID,
            clientNonce: nonce,
            body: "Ответ",
            replyToMessageID: replyID,
            token: "token"
        )

        XCTAssertEqual(response.replyToMessageId, replyID)
        XCTAssertEqual(response.snapshot(currentUserID: response.sender.id).metadata.replyToMessageID, replyID)
    }

    func testEditUsesIntegerExpectedRevisionAndDecodesNewRevision() async throws {
        let client = makeClient { [messageID, chatID, nonce] request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.url?.path, "/v1/messages/\(messageID.apiPathComponent)")
            let body = try request.jsonObject()
            XCTAssertEqual(Set(body.keys), ["body", "expectedRevision"])
            XCTAssertEqual(body["body"] as? String, "Исправлено")
            XCTAssertEqual((body["expectedRevision"] as? NSNumber)?.intValue, 7)
            return (200, messageEnvelope(
                messageID: messageID,
                chatID: chatID,
                nonce: nonce,
                body: "Исправлено",
                revision: 8,
                editedAt: "2026-08-04T18:01:00Z"
            ))
        }

        let response = try await client.editMessage(
            messageID: messageID,
            body: "Исправлено",
            expectedRevision: 7,
            token: "token"
        )

        XCTAssertEqual(response.body, "Исправлено")
        XCTAssertEqual(response.revision, 8)
        XCTAssertNotNil(response.editedAt)
    }

    func testDeleteHasNoInventedBodyAndDecodesTombstone() async throws {
        let client = makeClient { [messageID, chatID, nonce] request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/v1/messages/\(messageID.apiPathComponent)")
            XCTAssertNil(request.httpBody)
            return (200, messageEnvelope(
                messageID: messageID,
                chatID: chatID,
                nonce: nonce,
                body: nil,
                revision: 2,
                deletedAt: "2026-08-04T18:02:00Z"
            ))
        }

        let response = try await client.deleteMessage(messageID: messageID, token: "token")

        XCTAssertNotNil(response.deletedAt)
        XCTAssertTrue(response.snapshot(currentUserID: response.sender.id).metadata.isDeleted)
    }

    func testForwardUsesStrictIdempotentContractAndDecodesProvenance() async throws {
        let targetID = UUID(uuidString: "55555555-5555-4555-8555-555555555555")!
        let client = makeClient { [messageID, targetID, nonce] request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/messages/\(messageID.apiPathComponent)/forward")
            XCTAssertEqual(try request.jsonBody(), [
                "chatId": targetID.apiPathComponent,
                "clientNonce": nonce.apiPathComponent,
            ])
            return (201, messageEnvelope(
                messageID: messageID,
                chatID: targetID,
                nonce: nonce,
                body: "Переслано",
                forwardedSender: "Егор"
            ))
        }

        let response = try await client.forwardMessage(
            messageID: messageID,
            to: targetID,
            clientNonce: nonce,
            token: "token"
        )

        XCTAssertEqual(response.chatId, targetID)
        XCTAssertEqual(response.forwardedFrom?.senderDisplayName, "Егор")
    }

    func testPinAndUnpinUseExactRoutesAndResponseSemantics() async throws {
        let calls = LockedContractCounter()
        let client = makeClient { [chatID, messageID] request in
            let call = calls.increment()
            XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/pins/\(messageID.apiPathComponent)")
            XCTAssertNil(request.httpBody)
            if call == 1 {
                XCTAssertEqual(request.httpMethod, "PUT")
                return (200, pinEnvelope(chatID: chatID, messageID: messageID))
            }
            XCTAssertEqual(request.httpMethod, "DELETE")
            return (204, Data())
        }

        let pinned = try await client.setMessagePinned(
            chatID: chatID,
            messageID: messageID,
            active: true,
            token: "token"
        )
        let unpinned = try await client.setMessagePinned(
            chatID: chatID,
            messageID: messageID,
            active: false,
            token: "token"
        )
        XCTAssertTrue(pinned)
        XCTAssertFalse(unpinned)
        XCTAssertEqual(calls.current, 2)
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> LuxoraAPIClient {
        MutationContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MutationContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://luxora.contract.invalid")!,
                realtimeURL: URL(string: "wss://luxora.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }
}

private final class MutationContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw ContractHarnessError.missingHandler }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
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

private enum ContractHarnessError: Error { case missingHandler }

private final class LockedContractCounter: @unchecked Sendable {
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
        guard !data.isEmpty else { return [:] }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func jsonBody() throws -> [String: String] {
        try jsonObject().reduce(into: [:]) { result, item in
            result[item.key] = try XCTUnwrap(item.value as? String)
        }
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
            if count < 0 { throw stream.streamError ?? ContractHarnessError.missingHandler }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}

private func messageEnvelope(
    messageID: UUID,
    chatID: UUID,
    nonce: UUID,
    body: String?,
    replyToID: UUID? = nil,
    revision: Int = 0,
    editedAt: String? = nil,
    deletedAt: String? = nil,
    forwardedSender: String? = nil
) -> Data {
    var message: [String: Any] = [
        "id": messageID.apiPathComponent,
        "chatId": chatID.apiPathComponent,
        "sender": [
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "username": "flenym",
            "displayName": "Flenym",
            "bio": "",
            "createdAt": "2026-08-04T18:00:00Z",
        ],
        "kind": "text",
        "topicId": NSNull(),
        "attachments": [],
        "isPinned": false,
        "clientNonce": nonce.apiPathComponent,
        "revision": revision,
        "createdAt": "2026-08-04T18:00:00Z",
        "updatedAt": "2026-08-04T18:00:00Z",
    ]
    message["body"] = body ?? NSNull()
    message["replyToMessageId"] = replyToID?.apiPathComponent ?? NSNull()
    message["editedAt"] = editedAt ?? NSNull()
    message["deletedAt"] = deletedAt ?? NSNull()
    if let forwardedSender {
        message["forwardedFrom"] = [
            "senderDisplayName": forwardedSender,
            "originalCreatedAt": "2026-08-03T18:00:00Z",
        ]
    } else {
        message["forwardedFrom"] = NSNull()
    }
    return try! JSONSerialization.data(withJSONObject: ["message": message])
}

private func pinEnvelope(chatID: UUID, messageID: UUID) -> Data {
    try! JSONSerialization.data(withJSONObject: [
        "pin": [
            "chatId": chatID.apiPathComponent,
            "messageId": messageID.apiPathComponent,
            "pinnedBy": [
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "username": "flenym",
                "displayName": "Flenym",
                "bio": "",
                "createdAt": "2026-08-04T18:00:00Z",
            ],
            "pinnedAt": "2026-08-04T18:03:00Z",
        ],
    ])
}
