import Foundation
@testable import LuxoraKit
import XCTest

final class ChatPreferencesAPIContractTests: XCTestCase {
    private let chatID = UUID(uuidString: "A1000000-0000-4000-8000-000000000001")!

    override func tearDown() {
        ChatPreferencesContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testGetUsesCanonicalChatPathBearerAndTokenFreeProjection() async throws {
        let chatID = chatID
        ChatPreferencesContractURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(
                request.url?.path,
                "/v1/chats/\(chatID.uuidString.lowercased())/preferences"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertNil(request.httpBody)
            return Self.jsonResponse([
                "preferences": [
                    "archivedAt": "2026-08-11T09:00:00Z",
                    "mutedUntil": "2027-08-12T09:00:00Z",
                ],
            ])
        }

        let response = try await makeClient().chatPreferences(
            chatID: chatID,
            token: "access-token"
        )
        let projection = ChatPreferences(response: response)
        XCTAssertTrue(projection.isArchived)
        XCTAssertTrue(projection.isMuted(at: Date(timeIntervalSince1970: 0)))
        XCTAssertEqual(
            Set(Mirror(reflecting: projection).children.compactMap(\.label)),
            ["archivedAt", "mutedUntil"]
        )
    }

    func testPatchEncodesExactStrictPartialArchiveAndMuteDate() async throws {
        let chatID = chatID
        let mutedUntil = try XCTUnwrap(ISO8601DateFormatter().date(from: "2027-08-12T09:00:00Z"))
        ChatPreferencesContractURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(
                request.url?.path,
                "/v1/chats/\(chatID.uuidString.lowercased())/preferences"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try request.chatPreferencesBodyData()
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(Set(json.keys), ["archived", "mutedUntil"])
            XCTAssertEqual((json["archived"] as? NSNumber)?.boolValue, true)
            XCTAssertEqual(json["mutedUntil"] as? String, "2027-08-12T09:00:00Z")
            return Self.jsonResponse([
                "preferences": [
                    "archivedAt": "2026-08-11T09:00:00Z",
                    "mutedUntil": "2027-08-12T09:00:00Z",
                ],
            ])
        }

        let response = try await makeClient().updateChatPreferences(
            chatID: chatID,
            patch: .init(archived: true, mutedUntil: .until(mutedUntil)),
            token: "access-token"
        )
        XCTAssertNotNil(response.archivedAt)
        XCTAssertEqual(response.mutedUntil, mutedUntil)
    }

    func testExplicitUnmuteEncodesNullWithoutArchiveField() async throws {
        ChatPreferencesContractURLProtocol.handler = { request in
            let body = try request.chatPreferencesBodyData()
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(Set(json.keys), ["mutedUntil"])
            XCTAssertTrue(json["mutedUntil"] is NSNull)
            return Self.jsonResponse([
                "preferences": ["archivedAt": NSNull(), "mutedUntil": NSNull()],
            ])
        }

        let response = try await makeClient().updateChatPreferences(
            chatID: chatID,
            patch: .init(mutedUntil: .unmuted),
            token: "access-token"
        )
        XCTAssertNil(response.archivedAt)
        XCTAssertNil(response.mutedUntil)
    }

    func testEmptyPatchIsRejectedBeforeNetwork() async {
        let recorder = ChatPreferencesRequestRecorder()
        ChatPreferencesContractURLProtocol.handler = { request in
            recorder.record(request)
            return Self.jsonResponse([:])
        }

        do {
            _ = try await makeClient().updateChatPreferences(
                chatID: chatID,
                patch: .init(),
                token: "access-token"
            )
            XCTFail("Empty strict patch must be rejected before URLSession")
        } catch {
            // Expected locally.
        }
        XCTAssertEqual(recorder.count, 0)
    }

    private func makeClient() -> LuxoraAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ChatPreferencesContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://chat-preferences.invalid")!,
                realtimeURL: URL(string: "wss://chat-preferences.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
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

private final class ChatPreferencesRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests = 0

    var count: Int { lock.withLock { requests } }
    func record(_ request: URLRequest) { lock.withLock { requests += 1 } }
}

private final class ChatPreferencesContractURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw ChatPreferencesContractHarnessError.missingHandler
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

private enum ChatPreferencesContractHarnessError: Error {
    case missingHandler
}

private extension URLRequest {
    func chatPreferencesBodyData() throws -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw stream.streamError ?? ChatPreferencesContractHarnessError.missingHandler
            }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
