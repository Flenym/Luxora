import Foundation
@testable import LuxoraKit
import XCTest

final class DeviceLinkAPIContractTests: XCTestCase {
    private let linkID = UUID(uuidString: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")!
    private let linkSecret = String(repeating: "a", count: 64)

    override func tearDown() {
        DeviceLinkContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testCreatePostsLabelAndDecodesChallenge() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/device-links/challenges")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let body = try XCTUnwrap(Self.decodedBody(request))
            XCTAssertEqual(body, ["targetLabel": "MacBook Pro"])
            return (201, try Self.json([
                "linkId": self.linkID.uuidString,
                "linkSecret": self.linkSecret,
                "expiresAt": "2026-09-20T12:00:00Z",
                "pollIntervalMs": 2000,
            ]))
        }

        let created = try await client.createDeviceLinkChallenge(targetLabel: "MacBook Pro")
        XCTAssertEqual(created.linkId, linkID)
        XCTAssertEqual(created.linkSecret, linkSecret)
        XCTAssertEqual(created.pollIntervalMs, 2000)
    }

    func testPollSendsSecretWithoutBearer() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/device-links/challenges/\(self.linkID.uuidString.lowercased())/poll")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let body = try XCTUnwrap(Self.decodedBody(request))
            XCTAssertEqual(body, ["linkSecret": self.linkSecret])
            return (200, try Self.json([
                "challenge": [
                    "linkId": self.linkID.uuidString,
                    "state": "approved",
                    "expiresAt": "2026-09-20T12:02:00Z",
                    "retryAfterMs": 0,
                    "sasWords": ["amber", "anchor", "angel", "apple"],
                ],
            ]))
        }

        let status = try await client.pollDeviceLinkChallenge(linkID: linkID, linkSecret: linkSecret)
        XCTAssertEqual(status.state, "approved")
        XCTAssertEqual(status.shortAuthenticationString, "amber anchor angel apple")
    }

    func testApproveSendsSecretPlusPasswordWithBearer() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/device-links/challenges/\(self.linkID.uuidString.lowercased())/approve")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            let body = try XCTUnwrap(Self.decodedBody(request))
            XCTAssertEqual(body["password"], "secret-password")
            XCTAssertEqual(body["linkSecret"], self.linkSecret)
            return (200, try Self.json([
                "challenge": [
                    "linkId": self.linkID.uuidString,
                    "state": "approved",
                    "expiresAt": "2026-09-20T12:02:00Z",
                    "retryAfterMs": 0,
                    "sasWords": NSNull(),
                ],
            ]))
        }

        let status = try await client.approveDeviceLinkChallenge(
            linkID: linkID, linkSecret: linkSecret, password: "secret-password", token: "access-token"
        )
        XCTAssertEqual(status.state, "approved")
        XCTAssertNil(status.shortAuthenticationString)
    }

    func testDenyAndCloseUseSecretOnlyShapes() async throws {
        let denyClient = makeClient { request in
            XCTAssertEqual(request.url?.path, "/v1/device-links/challenges/\(self.linkID.uuidString.lowercased())/deny")
            let body = try XCTUnwrap(Self.decodedBody(request))
            XCTAssertEqual(body, ["linkSecret": self.linkSecret])
            return (200, try Self.json([
                "challenge": [
                    "linkId": self.linkID.uuidString,
                    "state": "denied",
                    "expiresAt": "2026-09-20T12:02:00Z",
                    "retryAfterMs": 0,
                    "sasWords": NSNull(),
                ],
            ]))
        }
        let denied = try await denyClient.denyDeviceLinkChallenge(linkID: linkID, linkSecret: linkSecret, token: "access-token")
        XCTAssertEqual(denied.state, "denied")

        let redeemClient = makeClient { request in
            XCTAssertEqual(request.url?.path, "/v1/device-links/challenges/\(self.linkID.uuidString.lowercased())/redeem")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let body = try XCTUnwrap(Self.decodedBody(request))
            XCTAssertEqual(body["proofSignature"]?.count, 86)
            return (201, try Self.json([
                "tokens": [
                    "accessToken": "access",
                    "refreshToken": "refresh",
                    "tokenType": "Bearer",
                    "expiresIn": 900,
                    "sessionId": self.linkID.uuidString,
                ],
            ]))
        }
        let tokens = try await redeemClient.redeemDeviceLinkChallenge(
            linkID: linkID, linkSecret: linkSecret, proofSignature: String(repeating: "A", count: 86)
        )
        XCTAssertEqual(tokens.sessionId, linkID)
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> LuxoraAPIClient {
        DeviceLinkContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeviceLinkContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://devicelink.contract.invalid")!,
                realtimeURL: URL(string: "wss://devicelink.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static func decodedBody(_ request: URLRequest) throws -> [String: String]? {
        if let httpBody = request.httpBody {
            return try JSONSerialization.jsonObject(with: httpBody) as? [String: String]
        }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { break }
            result.append(buffer, count: count)
        }
        return try JSONSerialization.jsonObject(with: result) as? [String: String]
    }

    private static func json(_ object: [String: Any]) throws -> (Int, Data) {
        (200, try JSONSerialization.data(withJSONObject: object))
    }
}

private final class DeviceLinkContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw DeviceLinkContractHarnessError.missingHandler }
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

private enum DeviceLinkContractHarnessError: Error {
    case missingHandler
}
