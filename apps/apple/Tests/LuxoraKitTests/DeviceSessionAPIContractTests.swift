import Foundation
@testable import LuxoraKit
import XCTest

final class DeviceSessionAPIContractTests: XCTestCase {
    private let sessionID = UUID(uuidString: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")!

    override func tearDown() {
        DeviceSessionContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testListUsesBearerContractAndDecodesCurrentSession() async throws {
        let sessionID = sessionID
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/auth/sessions")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertNil(request.httpBody)
            return (200, try JSONSerialization.data(withJSONObject: [
                "items": [[
                    "id": sessionID.apiPathComponent,
                    "deviceName": "iPhone 17 Pro Max",
                    "createdAt": "2026-08-04T18:00:00Z",
                    "lastSeenAt": "2026-08-04T18:15:00Z",
                    "expiresAt": "2026-09-03T18:00:00Z",
                    "current": true,
                ]],
            ]))
        }

        let sessions = try await client.deviceSessions(token: "access-token")

        let session = try XCTUnwrap(sessions.first)
        XCTAssertEqual(session.id, sessionID)
        XCTAssertEqual(session.deviceName, "iPhone 17 Pro Max")
        XCTAssertTrue(session.current)
        XCTAssertTrue(session.deviceSession.isCurrent)
    }

    func testRevokeUsesExactLowercaseIdentifierAndEmptyDeleteBody() async throws {
        let sessionID = sessionID
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/v1/auth/sessions/abcdefab-cdef-4abc-8def-abcdefabcdef")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertNil(request.httpBody)
            return (204, Data())
        }

        try await client.revokeDeviceSession(id: sessionID, token: "access-token")
    }

    func testContainmentPostsScopeAndDecodesRevokedIdentifiers() async throws {
        let otherID = UUID(uuidString: "12345678-1234-4abc-8def-123456789012")!
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/security/containment")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            let rawBody: Data?
            if let httpBody = request.httpBody {
                rawBody = httpBody
            } else if let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var result = Data()
                var buffer = [UInt8](repeating: 0, count: 1_024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count < 0 { break }
                    result.append(buffer, count: count)
                }
                rawBody = result
            } else {
                rawBody = nil
            }
            let body = try XCTUnwrap(rawBody.map { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
            XCTAssertEqual(body, ["scope": "all_other_sessions"])
            return (200, try JSONSerialization.data(withJSONObject: [
                "scope": "all_other_sessions",
                "revokedSessionIds": [otherID.uuidString],
            ]))
        }

        let revoked = try await client.containOtherSessions(token: "access-token")
        XCTAssertEqual(revoked, [otherID])
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> LuxoraAPIClient {
        DeviceSessionContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeviceSessionContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://sessions.contract.invalid")!,
                realtimeURL: URL(string: "wss://sessions.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }
}

private final class DeviceSessionContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw DeviceSessionContractHarnessError.missingHandler }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: data.isEmpty ? nil : ["Content-Type": "application/json"]
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

private enum DeviceSessionContractHarnessError: Error {
    case missingHandler
}
