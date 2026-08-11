import Foundation
@testable import LuxoraKit
import XCTest

final class ProfileAvatarAPIContractTests: XCTestCase {
    private let uploadID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let sourceAttachmentID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let derivativeAttachmentID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    private let userID = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!

    override func tearDown() {
        ProfileAvatarContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testResumableUploadSkipsReceivedChunkThenBindsDerivative() async throws {
        let bytes = Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4, 5, 6])
        let uploadID = uploadID
        let sourceAttachmentID = sourceAttachmentID
        let derivativeAttachmentID = derivativeAttachmentID
        let userID = userID
        let recorder = ProfileAvatarRequestRecorder()

        ProfileAvatarContractURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            recorder.record(path)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")

            switch (request.httpMethod, path) {
            case ("POST", "/v1/uploads"):
                let body = try request.avatarBodyData()
                let json = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                XCTAssertEqual(json["kind"] as? String, "image")
                XCTAssertEqual(json["mimeType"] as? String, "image/png")
                XCTAssertEqual(json["sizeBytes"] as? Int, bytes.count)
                XCTAssertEqual(json["sha256"] as? String, APIAvatarUploadContract.sha256Hex(bytes))
                XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(json["idempotencyKey"] as? String)))
                let metadata = try XCTUnwrap(json["metadata"] as? [String: Any])
                XCTAssertEqual((metadata["width"] as? NSNumber)?.intValue, 512)
                return Self.jsonResponse(
                    Self.uploadEnvelope(
                        id: uploadID,
                        status: "active",
                        sizeBytes: bytes.count,
                        receivedBytes: 4,
                        receivedChunkIndexes: [1]
                    )
                )

            case ("PUT", "/v1/uploads/\(uploadID.uuidString.lowercased())/chunks/0"):
                XCTAssertEqual(try request.avatarBodyData(), bytes.subdata(in: 0..<4))
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Range"), "bytes 0-3/10")
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "X-Chunk-SHA256"),
                    APIAvatarUploadContract.sha256Hex(bytes.subdata(in: 0..<4))
                )
                return Self.jsonResponse(
                    Self.uploadEnvelope(
                        id: uploadID,
                        status: "active",
                        sizeBytes: bytes.count,
                        receivedBytes: 8,
                        receivedChunkIndexes: [0, 1]
                    )
                )

            case ("PUT", "/v1/uploads/\(uploadID.uuidString.lowercased())/chunks/2"):
                XCTAssertEqual(try request.avatarBodyData(), bytes.subdata(in: 8..<10))
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Range"), "bytes 8-9/10")
                return Self.jsonResponse(
                    Self.uploadEnvelope(
                        id: uploadID,
                        status: "active",
                        sizeBytes: bytes.count,
                        receivedBytes: bytes.count,
                        receivedChunkIndexes: [0, 1, 2]
                    )
                )

            case ("POST", "/v1/uploads/\(uploadID.uuidString.lowercased())/complete"):
                return Self.jsonResponse(
                    Self.uploadEnvelope(
                        id: uploadID,
                        status: "completed",
                        sizeBytes: bytes.count,
                        receivedBytes: bytes.count,
                        receivedChunkIndexes: [0, 1, 2],
                        attachmentID: sourceAttachmentID
                    )
                )

            case ("PUT", "/v1/me/avatar"):
                let body = try request.avatarBodyData()
                let json = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: String]
                )
                XCTAssertEqual(json, ["attachmentId": sourceAttachmentID.uuidString.lowercased()])
                return Self.jsonResponse(
                    Self.userEnvelope(userID: userID, avatarAttachmentID: derivativeAttachmentID)
                )

            default:
                XCTFail("Unexpected avatar request: \(request.httpMethod ?? "nil") \(path)")
                return Self.jsonResponse(["error": ["code": "UNEXPECTED", "message": "unexpected"]], status: 500)
            }
        }

        let user = try await makeClient().uploadProfileAvatar(
            pngData: bytes,
            token: "access-token"
        )

        XCTAssertEqual(
            user.avatarPath,
            "/v1/attachments/\(derivativeAttachmentID.uuidString.lowercased())/content"
        )
        XCTAssertEqual(user.participant.avatarPath, user.avatarPath)
        XCTAssertEqual(recorder.paths, [
            "/v1/uploads",
            "/v1/uploads/\(uploadID.uuidString.lowercased())/chunks/0",
            "/v1/uploads/\(uploadID.uuidString.lowercased())/chunks/2",
            "/v1/uploads/\(uploadID.uuidString.lowercased())/complete",
            "/v1/me/avatar",
        ])
    }

    func testAuthenticatedAvatarDownloadAndClearUseExactContracts() async throws {
        let derivativeAttachmentID = derivativeAttachmentID
        let userID = userID
        let expectedImage = Data([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10])
        let recorder = ProfileAvatarRequestRecorder()
        let avatarPath = "/v1/attachments/\(derivativeAttachmentID.uuidString.lowercased())/content"

        ProfileAvatarContractURLProtocol.handler = { request in
            recorder.record(request.url?.path ?? "")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            if request.httpMethod == "GET" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "image/png")
                return (200, ["Content-Type": "image/png", "Cache-Control": "private, no-store"], expectedImage)
            }
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/v1/me/avatar")
            XCTAssertNil(request.httpBody)
            return Self.jsonResponse(Self.userEnvelope(userID: userID, avatarAttachmentID: nil))
        }

        let client = makeClient()
        let downloaded = try await client.avatarImageData(path: avatarPath, token: "access-token")
        XCTAssertEqual(downloaded, expectedImage)
        let cleared = try await client.clearProfileAvatar(token: "access-token")
        XCTAssertNil(cleared.avatarPath)
        XCTAssertEqual(recorder.paths, [avatarPath, "/v1/me/avatar"])
    }

    func testAvatarPathRejectsCrossOriginAndQueryBeforeNetwork() async {
        let recorder = ProfileAvatarRequestRecorder()
        ProfileAvatarContractURLProtocol.handler = { request in
            recorder.record(request.url?.absoluteString ?? "")
            return Self.jsonResponse([:])
        }
        for path in [
            "//attacker.invalid/v1/attachments/\(derivativeAttachmentID)/content",
            "/v1/attachments/\(derivativeAttachmentID)/content?token=leak",
            "/v1/attachments/not-a-uuid/content",
        ] {
            do {
                _ = try await makeClient().avatarImageData(path: path, token: "access-token")
                XCTFail("Hostile avatar path must be rejected")
            } catch {
                // Expected before URLSession receives a request.
            }
        }
        XCTAssertTrue(recorder.paths.isEmpty)
    }

    func testAvatarIdempotencyKeyIsStableAndUUIDv4() {
        let first = APIAvatarUploadContract.idempotencyKey(for: Data("avatar-a".utf8))
        let replay = APIAvatarUploadContract.idempotencyKey(for: Data("avatar-a".utf8))
        let changed = APIAvatarUploadContract.idempotencyKey(for: Data("avatar-b".utf8))

        XCTAssertEqual(first, replay)
        XCTAssertNotEqual(first, changed)
        let value = Array(first.uuidString.lowercased())
        XCTAssertEqual(value[14], "4")
        XCTAssertTrue("89ab".contains(value[19]))
    }

    private func makeClient() -> LuxoraAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfileAvatarContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://avatar.contract.invalid")!,
                realtimeURL: URL(string: "wss://avatar.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static func uploadEnvelope(
        id: UUID,
        status: String,
        sizeBytes: Int,
        receivedBytes: Int,
        receivedChunkIndexes: [Int],
        attachmentID: UUID? = nil
    ) -> [String: Any] {
        let attachment: Any
        if let attachmentID {
            attachment = ["id": attachmentID.uuidString.lowercased()]
        } else {
            attachment = NSNull()
        }
        return [
            "upload": [
                "id": id.uuidString.lowercased(),
                "status": status,
                "fileName": "profile-avatar.png",
                "sizeBytes": sizeBytes,
                "chunkSizeBytes": 4,
                "receivedBytes": receivedBytes,
                "receivedChunkIndexes": receivedChunkIndexes,
                "expiresAt": "2026-08-11T12:00:00Z",
                "attachment": attachment,
                "failureCode": NSNull(),
            ] as [String: Any],
        ]
    }

    private static func userEnvelope(userID: UUID, avatarAttachmentID: UUID?) -> [String: Any] {
        let avatarPath: Any
        if let avatarAttachmentID {
            avatarPath = "/v1/attachments/\(avatarAttachmentID.uuidString.lowercased())/content"
        } else {
            avatarPath = NSNull()
        }
        return [
            "user": [
                "id": userID.uuidString.lowercased(),
                "username": "flenym",
                "displayName": "Flenym",
                "bio": "Luxora",
                "avatarUrl": NSNull(),
                "avatarPath": avatarPath,
                "createdAt": "2026-08-11T09:00:00Z",
                "presence": "online",
                "lastSeenAt": NSNull(),
            ] as [String: Any],
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

private final class ProfileAvatarRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var paths: [String] {
        lock.withLock { storage }
    }

    func record(_ path: String) {
        lock.withLock { storage.append(path) }
    }
}

private final class ProfileAvatarContractURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw ProfileAvatarContractHarnessError.missingHandler
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

private enum ProfileAvatarContractHarnessError: Error {
    case missingHandler
}

private extension URLRequest {
    func avatarBodyData() throws -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw stream.streamError ?? ProfileAvatarContractHarnessError.missingHandler
            }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
