import Foundation
@testable import LuxoraKit
import XCTest

final class PushNotificationAPIContractTests: XCTestCase {
    private let registrationID = UUID(uuidString: "A1111111-1111-4111-8111-111111111111")!

    override func tearDown() {
        PushNotificationContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testPushRegistrationLifecycleUsesExactSessionBoundContract() async throws {
        let registrationID = registrationID
        let expectedToken = String(repeating: "ab", count: 32)
        let recorder = PushNotificationRequestRecorder()
        PushNotificationContractURLProtocol.handler = { request in
            recorder.record("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")

            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/push/registrations/current"):
                return Self.jsonResponse(["registration": NSNull()])
            case ("PUT", "/v1/push/registrations/current"):
                let body = try request.pushBodyData()
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
                XCTAssertEqual(json, [
                    "platform": "apns",
                    "environment": "development",
                    "token": expectedToken,
                ])
                return Self.jsonResponse([
                    "registration": Self.registrationJSON(id: registrationID),
                ])
            case ("DELETE", "/v1/push/registrations/current"):
                XCTAssertNil(request.httpBody)
                return (204, [:], Data())
            default:
                XCTFail("Unexpected push request")
                return Self.jsonResponse([:], status: 500)
            }
        }

        let client = makeClient()
        let absent = try await client.currentPushRegistration(token: "access-token")
        XCTAssertNil(absent)
        let registered = try await client.upsertPushRegistration(
            deviceTokenHex: expectedToken.uppercased(),
            environment: .development,
            token: "access-token"
        )
        XCTAssertEqual(registered.id, registrationID)
        XCTAssertEqual(registered.platform, "apns")
        XCTAssertEqual(registered.topic, "app.luxora.mobile")
        try await client.unregisterCurrentPushRegistration(token: "access-token")

        XCTAssertEqual(recorder.requests, [
            "GET /v1/push/registrations/current",
            "PUT /v1/push/registrations/current",
            "DELETE /v1/push/registrations/current",
        ])
    }

    func testInvalidAPNSTokenIsRejectedBeforeNetwork() async {
        let recorder = PushNotificationRequestRecorder()
        PushNotificationContractURLProtocol.handler = { request in
            recorder.record(request.url?.path ?? "")
            return Self.jsonResponse([:])
        }

        do {
            _ = try await makeClient().upsertPushRegistration(
                deviceTokenHex: "not-a-device-token",
                environment: .development,
                token: "access-token"
            )
            XCTFail("Malformed APNs bytes must be rejected")
        } catch {
            // Expected before URLSession receives a request.
        }
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    func testNotificationSettingsLoadAndPartialUpdate() async throws {
        let recorder = PushNotificationRequestRecorder()
        PushNotificationContractURLProtocol.handler = { request in
            recorder.record("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            if request.httpMethod == "GET" {
                return Self.jsonResponse([
                    "settings": Self.settingsJSON(sound: true, previewMode: "hidden"),
                ])
            }

            XCTAssertEqual(request.httpMethod, "PATCH")
            let body = try request.pushBodyData()
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json.count, 2)
            XCTAssertEqual((json["sound"] as? NSNumber)?.boolValue, false)
            XCTAssertEqual(json["previewMode"] as? String, "sender")
            return Self.jsonResponse([
                "settings": Self.settingsJSON(sound: false, previewMode: "sender"),
            ])
        }

        let client = makeClient()
        let loaded = try await client.notificationSettings(token: "access-token")
        XCTAssertTrue(loaded.sound)
        XCTAssertEqual(loaded.previewMode, .hidden)
        let updated = try await client.updateNotificationSettings(
            .init(sound: false, previewMode: .sender),
            token: "access-token"
        )
        XCTAssertFalse(updated.sound)
        XCTAssertEqual(updated.previewMode, .sender)
        XCTAssertEqual(recorder.requests, [
            "GET /v1/notifications/settings",
            "PATCH /v1/notifications/settings",
        ])
    }

    private func makeClient() -> LuxoraAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushNotificationContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://push.contract.invalid")!,
                realtimeURL: URL(string: "wss://push.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static func registrationJSON(id: UUID) -> [String: Any] {
        [
            "id": id.uuidString.lowercased(),
            "platform": "apns",
            "environment": "development",
            "topic": "app.luxora.mobile",
            "createdAt": "2026-08-11T09:00:00Z",
            "updatedAt": "2026-08-11T09:01:00Z",
        ]
    }

    private static func settingsJSON(sound: Bool, previewMode: String) -> [String: Any] {
        [
            "messageAlerts": true,
            "messageRequestAlerts": true,
            "mentionAlerts": true,
            "sound": sound,
            "badge": true,
            "previewMode": previewMode,
            "updatedAt": "2026-08-11T09:02:00Z",
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

private final class PushNotificationRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var requests: [String] { lock.withLock { storage } }
    func record(_ request: String) { lock.withLock { storage.append(request) } }
}

private final class PushNotificationContractURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw PushNotificationContractHarnessError.missingHandler
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

private enum PushNotificationContractHarnessError: Error {
    case missingHandler
}

private extension URLRequest {
    func pushBodyData() throws -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw stream.streamError ?? PushNotificationContractHarnessError.missingHandler
            }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
