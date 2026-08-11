import Foundation
@testable import LuxoraKit
import XCTest

final class PhonePasswordAPIContractTests: XCTestCase {
    override func tearDown() {
        PhonePasswordContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testCompletionUsesBodyOnlyExactContractAndDecodesAuthenticatedSession() async throws {
        let token = "luxpw_\(String(repeating: "a", count: 43))"
        let nonce = UUID.clientNonceV4()
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/auth/phone/password")
            XCTAssertNil(request.url?.query)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let object = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: request.phonePasswordBodyData()) as? [String: String]
            )
            XCTAssertEqual(Set(object.keys), ["passwordToken", "password", "deviceName", "clientNonce"])
            XCTAssertEqual(object["passwordToken"], token)
            XCTAssertEqual(object["password"], "correct horse battery staple")
            XCTAssertEqual(object["clientNonce"], nonce.apiPathComponent)
            return (200, Self.authenticatedResponse)
        }

        let response = try await client.completePhonePassword(
            passwordToken: token,
            password: "correct horse battery staple",
            deviceName: "iPhone 17e",
            clientNonce: nonce
        )

        XCTAssertEqual(response.user.username, "flenym")
        XCTAssertEqual(response.tokens.sessionId.uuidString.lowercased(), "abcdefab-cdef-4abc-8def-abcdefabcdef")
    }

    func testCompletionPreservesUnicodePasswordVerbatimInRequestBody() async throws {
        let password = "Пароль 🔐 для Luxora"
        let client = makeClient { request in
            let object = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: request.phonePasswordBodyData())
                    as? [String: String]
            )
            XCTAssertEqual(object["password"], password)
            return (200, Self.authenticatedResponse)
        }

        _ = try await client.completePhonePassword(
            passwordToken: "luxpw_\(String(repeating: "u", count: 43))",
            password: password,
            deviceName: "iPhone",
            clientNonce: .clientNonceV4()
        )
    }

    func testSettingsGetEnableChangeAndDisableUseBearerAndStrictBodies() async throws {
        let step = PhonePasswordRequestStep()
        let client = makeClient { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertEqual(request.url?.path, "/v1/me/phone-password")
            XCTAssertNil(request.url?.query)
            let index = step.next()
            switch index {
            case 0:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertNil(request.httpBody)
                return (200, Data(#"{"eligible":true,"enabled":false}"#.utf8))
            case 1:
                XCTAssertEqual(request.httpMethod, "PUT")
                let object = try Self.bodyObject(request)
                XCTAssertEqual(Set(object.keys), ["password"])
                XCTAssertEqual(object["password"] as? String, "first secure password")
                return (200, Data(#"{"eligible":true,"enabled":true}"#.utf8))
            case 2:
                XCTAssertEqual(request.httpMethod, "PUT")
                let object = try Self.bodyObject(request)
                XCTAssertEqual(Set(object.keys), ["password", "currentPassword"])
                XCTAssertEqual(object["currentPassword"] as? String, "first secure password")
                return (200, Data(#"{"eligible":true,"enabled":true}"#.utf8))
            case 3:
                XCTAssertEqual(request.httpMethod, "DELETE")
                let object = try Self.bodyObject(request)
                XCTAssertEqual(Set(object.keys), ["currentPassword"])
                return (200, Data(#"{"eligible":true,"enabled":false}"#.utf8))
            default:
                throw PhonePasswordContractError.unexpectedRequest
            }
        }

        let initial = try await client.phonePasswordStatus(token: "access-token")
        XCTAssertFalse(initial.enabled)
        let enabled = try await client.configurePhonePassword(
            password: "first secure password",
            currentPassword: nil,
            token: "access-token"
        )
        XCTAssertTrue(enabled.enabled)
        _ = try await client.configurePhonePassword(
            password: "second secure password",
            currentPassword: "first secure password",
            token: "access-token"
        )
        let disabled = try await client.disablePhonePassword(
            currentPassword: "second secure password",
            token: "access-token"
        )
        XCTAssertFalse(disabled.enabled)
        XCTAssertEqual(step.count, 4)
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> LuxoraAPIClient {
        PhonePasswordContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PhonePasswordContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://phone-password.contract.invalid")!,
                realtimeURL: URL(string: "wss://phone-password.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static func bodyObject(_ request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(
            try JSONSerialization.jsonObject(with: request.phonePasswordBodyData()) as? [String: Any]
        )
    }

    private static let authenticatedResponse = Data(
        #"{"status":"authenticated","user":{"id":"770ec1e2-2fdc-445c-a145-c83bf86c3b20","username":"flenym","displayName":"Егор Flenym","bio":"","avatarUrl":null,"createdAt":"2026-08-04T14:00:00Z","presence":"online","lastSeenAt":null},"tokens":{"accessToken":"access","refreshToken":"refresh","tokenType":"Bearer","expiresIn":900,"sessionId":"abcdefab-cdef-4abc-8def-abcdefabcdef"}}"#.utf8
    )
}

private final class PhonePasswordContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw PhonePasswordContractError.missingHandler }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
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

private final class PhonePasswordRequestStep: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var count: Int {
        lock.withLock { value }
    }

    func next() -> Int {
        lock.withLock {
            defer { value += 1 }
            return value
        }
    }
}

private enum PhonePasswordContractError: Error {
    case missingHandler
    case unexpectedRequest
}

private extension URLRequest {
    func phonePasswordBodyData() throws -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw stream.streamError ?? PhonePasswordContractError.unexpectedRequest
            }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
