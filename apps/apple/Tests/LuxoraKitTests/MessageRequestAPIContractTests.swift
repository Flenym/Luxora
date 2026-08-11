import Foundation
@testable import LuxoraKit
import XCTest

final class MessageRequestAPIContractTests: XCTestCase {
    private let requestID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let peerID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let chatID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    private let nonce = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!

    override func tearDown() {
        MessageRequestContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testPrivacyGetAndPatchUseTypedServerOwnedFields() async throws {
        let counter = MessageRequestLockedCounter()
        let client = makeClient { request in
            let call = counter.increment()
            XCTAssertEqual(request.url?.path, "/v1/privacy")
            if call == 1 {
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertNil(request.httpBody)
                return (200, json(["settings": [
                    "usernameDiscoverable": true,
                    "messageRequests": "everyone",
                ]]))
            }
            XCTAssertEqual(request.httpMethod, "PATCH")
            let body = try request.messageRequestJSONBody()
            XCTAssertEqual(Set(body.keys), ["usernameDiscoverable", "messageRequests"])
            XCTAssertEqual((body["usernameDiscoverable"] as? NSNumber)?.boolValue, false)
            XCTAssertEqual(body["messageRequests"] as? String, "nobody")
            return (200, json(["settings": [
                "usernameDiscoverable": false,
                "messageRequests": "nobody",
            ]]))
        }

        let initial = try await client.privacySettings(token: "token")
        let updated = try await client.updatePrivacySettings(
            usernameDiscoverable: false,
            messageRequests: .nobody,
            token: "token"
        )

        XCTAssertTrue(initial.usernameDiscoverable)
        XCTAssertEqual(initial.messageRequests, .everyone)
        XCTAssertFalse(updated.snapshot.usernameDiscoverable)
        XCTAssertEqual(updated.snapshot.messageRequests, .nobody)
    }

    func testExactLookupEncodesUsernameAndDecodesPublicProjection() async throws {
        let client = makeClient { [peerID] request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/users/lookup")
            XCTAssertEqual(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "username" })?.value, "egor test")
            return (200, json(["profile": publicProfile(id: peerID)]))
        }

        let profile = try await client.lookupUser(username: "egor test", token: "token")

        XCTAssertEqual(profile?.id, peerID)
        XCTAssertEqual(profile?.participant.displayName, "Егор")
    }

    func testIncomingAndOutgoingListsPreservePrivacySpecificProjection() async throws {
        let counter = MessageRequestLockedCounter()
        let client = makeClient { [requestID, peerID] request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/message-requests")
            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let direction = components?.queryItems?.first(where: { $0.name == "direction" })?.value
            if counter.increment() == 1 {
                XCTAssertEqual(direction, "incoming")
                return (200, json([
                    "items": [messageRequestJSON(
                        id: requestID,
                        direction: "incoming",
                        state: "pending",
                        profileKey: "sender",
                        profileID: peerID
                    )],
                    "nextCursor": "next page",
                ]))
            }
            XCTAssertEqual(direction, "outgoing")
            XCTAssertEqual(components?.queryItems?.first(where: { $0.name == "cursor" })?.value, "next page")
            return (200, json([
                "items": [messageRequestJSON(
                    id: requestID,
                    direction: "outgoing",
                    state: "pending",
                    profileKey: "recipient",
                    profileID: peerID
                )],
                "nextCursor": NSNull(),
            ]))
        }

        let incoming = try await client.messageRequests(direction: .incoming, token: "token")
        let outgoing = try await client.messageRequests(
            direction: .outgoing,
            cursor: incoming.nextCursor,
            token: "token"
        )

        XCTAssertEqual(try incoming.items.first?.item().direction, .incoming)
        XCTAssertEqual(try outgoing.items.first?.item().direction, .outgoing)
        XCTAssertEqual(incoming.nextCursor, "next page")
    }

    func testCreateUsesBoundedIdempotentContractAndDecodesOutboxItem() async throws {
        let client = makeClient { [requestID, peerID, nonce] request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/message-requests")
            let body = try request.messageRequestJSONBody()
            XCTAssertEqual(body["recipientUserId"] as? String, peerID.apiPathComponent)
            XCTAssertEqual(body["body"] as? String, "Здравствуйте")
            XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
            XCTAssertEqual(Set(body.keys), ["recipientUserId", "body", "clientNonce"])
            return (201, json(["request": messageRequestJSON(
                id: requestID,
                direction: "outgoing",
                state: "pending",
                profileKey: "recipient",
                profileID: peerID
            )]))
        }

        let response = try await client.createMessageRequest(
            recipientUserID: peerID,
            body: "Здравствуйте",
            clientNonce: nonce,
            token: "token"
        )

        XCTAssertEqual(try response.item().id, requestID)
        XCTAssertEqual(try response.item().direction, .outgoing)
    }

    func testAcceptAndDismissUseExactRecipientOnlyRoutes() async throws {
        let counter = MessageRequestLockedCounter()
        let client = makeClient { [requestID, peerID, chatID] request in
            XCTAssertEqual(request.url?.path, "/v1/message-requests/\(requestID.apiPathComponent)" + (request.httpMethod == "POST" ? "/accept" : ""))
            XCTAssertNil(request.httpBody)
            if counter.increment() == 1 {
                XCTAssertEqual(request.httpMethod, "POST")
                var accepted = messageRequestJSON(
                    id: requestID,
                    direction: "incoming",
                    state: "accepted",
                    profileKey: "sender",
                    profileID: peerID
                )
                accepted["acceptedAt"] = "2026-08-04T18:05:00Z"
                return (200, json([
                    "request": accepted,
                    "chat": chatJSON(id: chatID),
                ]))
            }
            XCTAssertEqual(request.httpMethod, "DELETE")
            return (204, Data())
        }

        let accepted = try await client.acceptMessageRequest(id: requestID, token: "token")
        try await client.dismissMessageRequest(id: requestID, token: "token")

        XCTAssertEqual(accepted.request.acceptedAt, isoDate("2026-08-04T18:05:00Z"))
        XCTAssertEqual(accepted.chat.id, chatID)
        XCTAssertEqual(counter.current, 2)
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> LuxoraAPIClient {
        MessageRequestContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MessageRequestContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://requests.contract.invalid")!,
                realtimeURL: URL(string: "wss://requests.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }
}

private final class MessageRequestContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw MessageRequestContractError.missingHandler }
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

private enum MessageRequestContractError: Error { case missingHandler }

private final class MessageRequestLockedCounter: @unchecked Sendable {
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
    func messageRequestJSONBody() throws -> [String: Any] {
        let data: Data
        if let httpBody {
            data = httpBody
        } else if let stream = httpBodyStream {
            stream.open()
            defer { stream.close() }
            var result = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count < 0 { throw stream.streamError ?? MessageRequestContractError.missingHandler }
                if count == 0 { break }
                result.append(buffer, count: count)
            }
            data = result
        } else {
            data = Data()
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private func publicProfile(id: UUID) -> [String: Any] {
    [
        "id": id.apiPathComponent,
        "username": "egor",
        "displayName": "Егор",
        "bio": "Продукт",
        "avatarUrl": NSNull(),
    ]
}

private func messageRequestJSON(
    id: UUID,
    direction: String,
    state: String,
    profileKey: String,
    profileID: UUID
) -> [String: Any] {
    [
        "id": id.apiPathComponent,
        "direction": direction,
        "state": state,
        "body": "Здравствуйте",
        profileKey: publicProfile(id: profileID),
        "createdAt": "2026-08-04T18:00:00Z",
        "expiresAt": "2026-09-03T18:00:00Z",
    ]
}

private func chatJSON(id: UUID) -> [String: Any] {
    [
        "id": id.apiPathComponent,
        "kind": "direct",
        "title": "Егор",
        "avatarUrl": NSNull(),
        "role": "member",
        "memberCount": 2,
        "lastMessage": NSNull(),
        "lastActivityAt": "2026-08-04T18:05:00Z",
        "createdAt": "2026-08-04T18:05:00Z",
        "unreadCount": 1,
    ]
}

private func json(_ object: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: object)
}

private func isoDate(_ value: String) -> Date {
    ISO8601DateFormatter().date(from: value)!
}
