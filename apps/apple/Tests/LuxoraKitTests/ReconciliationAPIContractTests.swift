import Foundation
@testable import LuxoraKit
import XCTest

final class ReconciliationAPIContractTests: XCTestCase {
    override func tearDown() {
        ReconciliationContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testAuthoritativeSnapshotExhaustsEveryAccountCollectionAndPreservesOpaqueBoundary() async throws {
        let cursor = Self.validCursor(seed: "a")
        let closingCursor = Self.validCursor(seed: "f")
        let boundaryCursors = ReconciliationCursorProbe([cursor, closingCursor])
        let nextCursor = "opaque next/+ cursor"
        let recorder = ReconciliationRequestRecorder()
        ReconciliationContractURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            let path = request.url?.path ?? ""
            let query = request.url?.query ?? ""
            recorder.record(path: path, query: query)

            switch (path, query) {
            case ("/v2/sync/snapshot", ""):
                return Self.jsonResponse(Self.snapshot(cursor: boundaryCursors.next()))
            case ("/v1/me", ""):
                return Self.jsonResponse(Self.currentUserResponse())
            case ("/v1/message-requests", "direction=incoming&limit=100"):
                return Self.jsonResponse(["items": [], "nextCursor": nextCursor])
            case ("/v1/message-requests", "direction=incoming&limit=100&cursor=opaque%20next%2F%2B%20cursor"):
                return Self.jsonResponse(["items": [], "nextCursor": NSNull()])
            case ("/v1/message-requests", "direction=outgoing&limit=100"),
                 ("/v2/sync/blocks", "limit=100"),
                 ("/v2/sync/chats", "limit=100"),
                 ("/v1/attachments", "limit=100"),
                 ("/v1/safety/reports", "limit=100"):
                return Self.jsonResponse(["items": [], "nextCursor": NSNull()])
            case ("/v1/chat-folders", ""):
                return Self.jsonResponse(["items": [], "stateRevision": 0])
            default:
                XCTFail("Unexpected reconciliation request: \(path)?\(query)")
                return Self.jsonResponse([:], status: 500)
            }
        }

        let bundle = try await makeClient().reconciliationBundle(
            token: "access-token",
            expectedUserID: Self.expectedUserID
        )
        XCTAssertEqual(bundle.boundary.sequence, 42)
        XCTAssertEqual(
            bundle.boundary.cursor,
            closingCursor,
            "Equal sequences prove stability, but the resumable cursor must come from B2"
        )
        XCTAssertTrue(bundle.incomingRequests.isEmpty)
        XCTAssertEqual(bundle.currentUser.id, Self.expectedUserID)
        XCTAssertEqual(bundle.currentUser.displayName, "Профиль после синхронизации")
        XCTAssertEqual(bundle.currentUser.bio, "Обновлено на другом устройстве")
        XCTAssertEqual(bundle.currentUser.avatarPath, "/uploads/avatar-new.png")
        XCTAssertTrue(bundle.outgoingRequests.isEmpty)
        XCTAssertTrue(bundle.blocks.isEmpty)
        XCTAssertTrue(bundle.chats.isEmpty)
        XCTAssertTrue(bundle.attachments.isEmpty)
        XCTAssertTrue(bundle.safetyReports.isEmpty)
        XCTAssertTrue(bundle.chatFolders.folders.isEmpty)
        XCTAssertEqual(bundle.chatFolders.stateRevision, 0)
        XCTAssertEqual(
            recorder.paths,
            [
                "/v2/sync/snapshot",
                "/v1/me",
                "/v1/message-requests?direction=incoming&limit=100",
                "/v1/message-requests?direction=incoming&limit=100&cursor=opaque%20next%2F%2B%20cursor",
                "/v1/message-requests?direction=outgoing&limit=100",
                "/v2/sync/blocks?limit=100",
                "/v2/sync/chats?limit=100",
                "/v1/attachments?limit=100",
                "/v1/safety/reports?limit=100",
                "/v1/chat-folders",
                "/v2/sync/snapshot",
            ]
        )
    }

    func testMutationAcrossResourceReadDiscardsEverythingAndStableSecondPassWins() async throws {
        let recorder = ReconciliationRequestRecorder()
        let boundaries = ReconciliationBoundaryProbe([42, 43, 43, 43])
        ReconciliationContractURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let query = request.url?.query ?? ""
            recorder.record(path: path, query: query)
            if path == "/v2/sync/snapshot" {
                return Self.jsonResponse(Self.snapshot(
                    cursor: Self.validCursor(seed: "d"),
                    sequence: boundaries.next()
                ))
            }
            if path == "/v1/me" {
                return Self.jsonResponse(Self.currentUserResponse())
            }
            if path == "/v1/chat-folders" {
                return Self.jsonResponse(["items": [], "stateRevision": 0])
            }
            return Self.jsonResponse(["items": [], "nextCursor": NSNull()])
        }

        let bundle = try await makeClient().reconciliationBundle(
            token: "access-token",
            expectedUserID: Self.expectedUserID
        )

        XCTAssertEqual(bundle.boundary.sequence, 43)
        XCTAssertEqual(recorder.paths.filter { $0 == "/v2/sync/snapshot" }.count, 4)
        XCTAssertEqual(
            recorder.paths.filter { $0 == "/v2/sync/chats?limit=100" }.count,
            2,
            "Every page from the unstable first pass must be discarded and refetched"
        )
    }

    func testPerpetuallyChangingBoundaryFailsAfterThreeCompleteAttempts() async {
        let recorder = ReconciliationRequestRecorder()
        let boundaries = ReconciliationBoundaryProbe([1, 2, 3, 4, 5, 6])
        ReconciliationContractURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let query = request.url?.query ?? ""
            recorder.record(path: path, query: query)
            if path == "/v2/sync/snapshot" {
                return Self.jsonResponse(Self.snapshot(
                    cursor: Self.validCursor(seed: "e"),
                    sequence: boundaries.next()
                ))
            }
            if path == "/v1/me" {
                return Self.jsonResponse(Self.currentUserResponse())
            }
            if path == "/v1/chat-folders" {
                return Self.jsonResponse(["items": [], "stateRevision": 0])
            }
            return Self.jsonResponse(["items": [], "nextCursor": NSNull()])
        }

        do {
            _ = try await makeClient().reconciliationBundle(
                token: "access-token",
                expectedUserID: Self.expectedUserID
            )
            XCTFail("An unstable reset must never publish a mixed bundle")
        } catch LuxoraAPIError.syncUnstable {
            // Expected bounded failure with no returned partial state.
        } catch {
            XCTFail("Expected syncUnstable, received \(error)")
        }
        XCTAssertEqual(recorder.paths.filter { $0 == "/v2/sync/snapshot" }.count, 6)
        XCTAssertEqual(recorder.paths.filter { $0 == "/v2/sync/chats?limit=100" }.count, 3)
    }

    func testCancellationBeforeOpeningBoundaryPerformsNoRequests() async {
        let recorder = ReconciliationRequestRecorder()
        ReconciliationContractURLProtocol.handler = { request in
            recorder.record(path: request.url?.path ?? "", query: request.url?.query ?? "")
            return Self.jsonResponse([:], status: 500)
        }
        let client = makeClient()
        let expectedUserID = Self.expectedUserID
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await client.reconciliationBundle(
                token: "access-token",
                expectedUserID: expectedUserID
            )
        }

        do {
            _ = try await task.value
            XCTFail("A cancelled reconciliation must not start")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("Expected CancellationError, received \(error)")
        }
        XCTAssertEqual(recorder.count, 0)
    }

    func testRepeatedPaginationCursorFailsClosedInsteadOfLoopingOrPublishingPartialState() async {
        let cursor = Self.validCursor(seed: "b")
        let recorder = ReconciliationRequestRecorder()
        ReconciliationContractURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let query = request.url?.query ?? ""
            recorder.record(path: path, query: query)
            if path == "/v2/sync/snapshot" {
                return Self.jsonResponse(Self.snapshot(cursor: cursor))
            }
            if path == "/v1/me" {
                return Self.jsonResponse(Self.currentUserResponse())
            }
            if path == "/v1/message-requests" {
                return Self.jsonResponse(["items": [], "nextCursor": "same-cursor"])
            }
            XCTFail("Client must stop at the repeated cursor before other resources")
            return Self.jsonResponse([:], status: 500)
        }

        do {
            _ = try await makeClient().reconciliationBundle(
                token: "access-token",
                expectedUserID: Self.expectedUserID
            )
            XCTFail("A cursor cycle must fail the authoritative reset")
        } catch LuxoraAPIError.invalidResponse {
            // Expected: no partial bundle is returned to the store.
        } catch {
            XCTFail("Expected invalidResponse, received \(error)")
        }
        XCTAssertEqual(recorder.count, 4)
    }

    func testSnapshotWithWrongResetContractIsRejectedBeforeResourceFetch() async {
        let recorder = ReconciliationRequestRecorder()
        var snapshot = Self.snapshot(cursor: Self.validCursor(seed: "c"))
        snapshot["reset"] = ["required": true, "collections": ["chats"]]
        let snapshotData = try! JSONSerialization.data(withJSONObject: snapshot)
        ReconciliationContractURLProtocol.handler = { request in
            recorder.record(path: request.url?.path ?? "", query: request.url?.query ?? "")
            return (200, ["Content-Type": "application/json"], snapshotData)
        }

        do {
            _ = try await makeClient().reconciliationBundle(
                token: "access-token",
                expectedUserID: Self.expectedUserID
            )
            XCTFail("An incomplete authoritative reset contract must be rejected")
        } catch LuxoraAPIError.invalidResponse {
            // Expected.
        } catch {
            XCTFail("Expected invalidResponse, received \(error)")
        }
        XCTAssertEqual(recorder.paths, ["/v2/sync/snapshot"])
    }

    func testCurrentUserIdentityMismatchFailsBeforeAnyCollectionCanPublish() async {
        let recorder = ReconciliationRequestRecorder()
        ReconciliationContractURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            recorder.record(path: path, query: request.url?.query ?? "")
            switch path {
            case "/v2/sync/snapshot":
                return Self.jsonResponse(Self.snapshot(cursor: Self.validCursor(seed: "i")))
            case "/v1/me":
                return Self.jsonResponse(Self.currentUserResponse(id: UUID()))
            default:
                XCTFail("A mismatched /v1/me identity must stop before collection reads")
                return Self.jsonResponse([:], status: 500)
            }
        }

        do {
            _ = try await makeClient().reconciliationBundle(
                token: "access-token",
                expectedUserID: Self.expectedUserID
            )
            XCTFail("A reconciliation bundle must never cross account identities")
        } catch LuxoraAPIError.invalidResponse {
            // Expected: no candidate escapes the B1 -> resources -> B2 window.
        } catch {
            XCTFail("Expected invalidResponse, received \(error)")
        }
        XCTAssertEqual(recorder.paths, ["/v2/sync/snapshot", "/v1/me"])
    }

    private func makeClient() -> LuxoraAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReconciliationContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://reconciliation.invalid")!,
                realtimeURL: URL(string: "wss://reconciliation.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private static func validCursor(seed: Character) -> String {
        "luxora-rt1.\(String(repeating: seed, count: 40)).\(String(repeating: seed, count: 40))"
    }

    private static let expectedUserID = UUID(
        uuidString: "10000000-0000-4000-8000-000000000001"
    )!

    private static func currentUserResponse(id: UUID = expectedUserID) -> [String: Any] {
        [
            "user": [
                "id": id.uuidString.lowercased(),
                "username": "flenym",
                "displayName": "Профиль после синхронизации",
                "bio": "Обновлено на другом устройстве",
                "avatarUrl": "https://cdn.luxora.invalid/avatar-new.png",
                "avatarPath": "/uploads/avatar-new.png",
                "createdAt": "2026-08-11T09:00:00Z",
                "presence": "online",
                "lastSeenAt": "2026-08-11T09:00:00Z",
            ],
        ]
    }

    private static func snapshot(cursor: String, sequence: Int = 42) -> [String: Any] {
        [
            "contractVersion": 1,
            "scope": "account_session",
            "boundary": [
                "sequence": sequence,
                "cursor": cursor,
                "capturedAt": "2026-08-11T09:00:00Z",
                "cursorExpiresAt": "2026-08-18T09:00:00Z",
            ],
            "reset": [
                "required": true,
                "collections": [
                    "message_requests", "blocks", "chats", "members", "messages", "pins",
                    "topics", "reactions", "receipts", "attachments", "safety_reports",
                    "chat_folders",
                ],
            ],
            "resources": [
                "incomingMessageRequests": "/v1/message-requests?direction=incoming",
                "outgoingMessageRequests": "/v1/message-requests?direction=outgoing",
                "blocks": "/v2/sync/blocks",
                "chats": "/v2/sync/chats",
                "attachments": "/v1/attachments",
                "safetyReports": "/v1/safety/reports",
                "chatFolders": "/v1/chat-folders",
                "membersTemplate": "/v1/chats/{chatId}/members",
                "messagesTemplate": "/v1/chats/{chatId}/messages",
                "pinsTemplate": "/v1/chats/{chatId}/pins",
                "topicsTemplate": "/v1/chats/{chatId}/topics",
                "reactionsTemplate": "/v1/messages/{messageId}/reactions",
                "receiptsTemplate": "/v1/messages/{messageId}/receipts",
            ],
            "pagination": [
                "cursorParameter": "cursor",
                "limitParameter": "limit",
                "nextCursorField": "nextCursor",
                "maxPageSize": 100,
            ],
            "resume": [
                "websocketPath": "/v2/realtime",
                "authenticateField": "resumeCursor",
                "applyEventsIdempotently": true,
                "sequenceAdjacencyRequired": false,
            ],
        ]
    }

    private static func jsonResponse(
        _ object: Any,
        status: Int = 200
    ) -> (Int, [String: String], Data) {
        (
            status,
            ["Content-Type": "application/json"],
            (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        )
    }
}

private final class ReconciliationRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    var count: Int { lock.withLock { values.count } }
    var paths: [String] { lock.withLock { values } }

    func record(path: String, query: String) {
        lock.withLock {
            values.append(query.isEmpty ? path : "\(path)?\(query)")
        }
    }
}

private final class ReconciliationBoundaryProbe: @unchecked Sendable {
    private let lock = NSLock()
    private let sequences: [Int]
    private var index = 0

    init(_ sequences: [Int]) {
        self.sequences = sequences
    }

    func next() -> Int {
        lock.withLock {
            guard !sequences.isEmpty else { return 0 }
            let value = sequences[min(index, sequences.count - 1)]
            index += 1
            return value
        }
    }
}

private final class ReconciliationCursorProbe: @unchecked Sendable {
    private let lock = NSLock()
    private let cursors: [String]
    private var index = 0

    init(_ cursors: [String]) {
        self.cursors = cursors
    }

    func next() -> String {
        lock.withLock {
            guard !cursors.isEmpty else { return "" }
            let value = cursors[min(index, cursors.count - 1)]
            index += 1
            return value
        }
    }
}

private final class ReconciliationContractURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw ReconciliationContractHarnessError.missingHandler
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

private enum ReconciliationContractHarnessError: Error {
    case missingHandler
}
