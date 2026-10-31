import CryptoKit
import Foundation
@testable import LuxoraKit
import XCTest

// MARK: - Client contract tests

final class AccountDataAPIContractTests: XCTestCase {
    private let exportID = UUID(uuidString: "66666666-6666-4666-8666-666666666666")!
    private let accountID = UUID(uuidString: "77777777-7777-4777-8777-777777777777")!
    private let createdAt = "2026-10-31T15:55:03.626Z"
    private let readyAt = "2026-10-31T15:55:03.659Z"
    private let expiresAt = "2026-11-07T15:55:03.626Z"

    override func tearDown() {
        AccountDataURLProtocol.handler = nil
        super.tearDown()
    }

    func testRequestExportUsesStrictContractAndDecodesRecord() async throws {
        let exportID = exportID
        let digest = accountDataSHA256(Data("export-bytes".utf8))
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/data-exports")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try XCTUnwrap(accountDataJSONBody(request))
            XCTAssertTrue(body.isEmpty)
            return (
                201,
                [:],
                try accountDataJSONData([
                    "dataExport": [
                        "id": exportID.uuidString.lowercased(),
                        "state": "ready",
                        "sizeBytes": 12,
                        "sha256": digest,
                        "createdAt": "2026-10-31T15:55:03.626Z",
                        "readyAt": "2026-10-31T15:55:03.659Z",
                        "expiresAt": "2026-11-07T15:55:03.626Z",
                    ],
                ])
            )
        }

        let record = try await client.requestDataExport(token: "access-token")

        XCTAssertEqual(record.id, exportID)
        XCTAssertEqual(record.state, .ready)
        XCTAssertEqual(record.sizeBytes, 12)
        XCTAssertEqual(record.sha256, digest)
        XCTAssertEqual(record.createdAt, accountDataDate("2026-10-31T15:55:03.626Z"))
        XCTAssertEqual(record.readyAt, accountDataDate("2026-10-31T15:55:03.659Z"))
        XCTAssertEqual(record.expiresAt, accountDataDate("2026-11-07T15:55:03.626Z"))
    }

    func testExportStatusAndMissingRecordMapping() async throws {
        let exportID = exportID
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/data-exports/\(exportID.uuidString.lowercased())")
            return (
                200,
                [:],
                try accountDataJSONData([
                    "dataExport": [
                        "id": exportID.uuidString.lowercased(),
                        "state": "pending",
                        "sizeBytes": NSNull(),
                        "sha256": NSNull(),
                        "createdAt": "2026-10-31T15:55:03.626Z",
                        "readyAt": NSNull(),
                        "expiresAt": NSNull(),
                    ],
                ])
            )
        }
        let pending = try await client.dataExportStatus(id: exportID, token: "access-token")
        XCTAssertEqual(pending.state, .pending)
        XCTAssertNil(pending.sizeBytes)
        XCTAssertNil(pending.sha256)

        let missingClient = makeClient { _ in
            (
                404,
                [:],
                try accountDataJSONData(["error": ["code": "NOT_FOUND", "message": "Data export not found"]])
            )
        }
        do {
            _ = try await missingClient.dataExportStatus(id: exportID, token: "access-token")
            XCTFail("A missing export must surface as a server error")
        } catch let LuxoraAPIError.server(status, code, _) {
            XCTAssertEqual(status, 404)
            XCTAssertEqual(code, "NOT_FOUND")
        }
    }

    func testDownloadSendsRangeAndValidatesGzipContract() async throws {
        let exportID = exportID
        let partialPayload = Data("0123456789abcdef".utf8)
        let rangeClient = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/data-exports/\(exportID.uuidString.lowercased())/download")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=0-15")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            return (
                206,
                [
                    "Content-Type": "application/gzip",
                    "Content-Range": "bytes 0-15/1405",
                    "Content-Length": String(partialPayload.count),
                    "ETag": "\"digest-for-range-test\"",
                ],
                partialPayload
            )
        }

        let partial = try await rangeClient.downloadDataExport(
            id: exportID,
            range: 0..<16,
            token: "access-token"
        )

        XCTAssertTrue(partial.isPartial)
        XCTAssertEqual(partial.data, partialPayload)
        XCTAssertEqual(partial.etag, "\"digest-for-range-test\"")
        XCTAssertEqual(partial.contentRange, "bytes 0-15/1405")
        XCTAssertEqual(partial.contentType, "application/gzip")

        let fullPayload = Data("archive-bytes".utf8)
        let fullClient = makeClient { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Range"))
            return (
                200,
                [
                    "Content-Type": "application/gzip",
                    "Content-Length": String(fullPayload.count),
                ],
                fullPayload
            )
        }
        let full = try await fullClient.downloadDataExport(id: exportID, token: "access-token")
        XCTAssertFalse(full.isPartial)
        XCTAssertEqual(full.data, fullPayload)
    }

    func testDownloadRejectsUnexpectedContentTypeAndLength() async throws {
        let exportID = exportID
        let htmlClient = makeClient { _ in
            (200, ["Content-Type": "text/html"], Data("<html></html>".utf8))
        }
        do {
            _ = try await htmlClient.downloadDataExport(id: exportID, token: "access-token")
            XCTFail("Only gzip archive bytes are accepted")
        } catch LuxoraAPIError.invalidResponse {
            // Expected.
        }

        let inconsistentClient = makeClient { _ in
            (
                200,
                ["Content-Type": "application/gzip", "Content-Length": "999"],
                Data("short".utf8)
            )
        }
        do {
            _ = try await inconsistentClient.downloadDataExport(id: exportID, token: "access-token")
            XCTFail("A truncated archive must not be accepted silently")
        } catch LuxoraAPIError.invalidResponse {
            // Expected.
        }

        let flag = AccountDataRequestFlag()
        let offlineClient = makeClient { request in
            flag.record(request)
            throw AccountDataHarnessError.unexpectedRequest
        }
        do {
            _ = try await offlineClient.downloadDataExport(id: exportID, range: 5..<5, token: "access-token")
            XCTFail("An empty range is invalid")
        } catch LuxoraAPIError.invalidResponse {
            // Expected local rejection.
        }
        XCTAssertEqual(flag.requestCount, 0)
    }

    func testDeletionScheduleStatusAndCancelContracts() async throws {
        let accountID = accountID
        let flag = AccountDataRequestFlag()
        let client = makeClient { request in
            flag.record(request)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            let path = request.url?.path ?? ""
            switch request.httpMethod ?? "" {
            case "POST":
                XCTAssertEqual(path, "/v1/account/deletion")
                let body = try XCTUnwrap(accountDataJSONBody(request))
                XCTAssertTrue(body.isEmpty)
                return (
                    201,
                    [:],
                    try accountDataJSONData([
                        "deletion": accountDataScheduledDeletion(accountID: accountID),
                    ])
                )
            case "GET":
                XCTAssertEqual(path, "/v1/account/deletion")
                return (
                    200,
                    [:],
                    try accountDataJSONData([
                        "deletion": accountDataScheduledDeletion(accountID: accountID),
                    ])
                )
            case "DELETE":
                XCTAssertEqual(path, "/v1/account/deletion")
                return (
                    200,
                    [:],
                    try accountDataJSONData([
                        "deletion": [
                            "accountId": accountID.uuidString.lowercased(),
                            "state": "none",
                            "scheduledAt": "2026-10-31T15:55:03.682Z",
                            "graceDeadlineAt": "2026-11-07T15:55:03.682Z",
                            "scheduledBySessionId": "88888888-8888-4888-8888-888888888888",
                            "canceledAt": "2026-10-31T16:01:00.000Z",
                            "executedAt": NSNull(),
                            "completedAt": NSNull(),
                        ],
                    ])
                )
            default:
                throw AccountDataHarnessError.unexpectedRequest
            }
        }

        let scheduled = try await client.scheduleAccountDeletion(token: "access-token")
        XCTAssertEqual(scheduled.state, .scheduled)
        XCTAssertNotNil(scheduled.scheduledAt)
        XCTAssertNotNil(scheduled.graceDeadlineAt)

        let status = try await client.accountDeletionStatus(token: "access-token")
        XCTAssertEqual(status.state, .scheduled)

        let canceled = try await client.cancelAccountDeletion(token: "access-token")
        XCTAssertEqual(canceled.state, .none)
        XCTAssertNotNil(canceled.canceledAt)
        XCTAssertEqual(flag.requestCount, 3)
    }

    func testCancelWhenNothingScheduledMapsNotFound() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            return (
                404,
                [:],
                try accountDataJSONData(["error": ["code": "NOT_FOUND", "message": "No scheduled account deletion"]])
            )
        }
        do {
            _ = try await client.cancelAccountDeletion(token: "access-token")
            XCTFail("Cancelling nothing must surface as a server error")
        } catch let LuxoraAPIError.server(status, code, _) {
            XCTAssertEqual(status, 404)
            XCTAssertEqual(code, "NOT_FOUND")
        }
    }

    func testDeletionDecodeRejectsScheduledRecordWithoutGraceWindow() async throws {
        let client = makeClient { _ in
            (
                200,
                [:],
                try accountDataJSONData([
                    "deletion": [
                        "accountId": "77777777-7777-4777-8777-777777777777",
                        "state": "scheduled",
                        "scheduledAt": "2026-10-31T15:55:03.682Z",
                        "graceDeadlineAt": NSNull(),
                        "scheduledBySessionId": NSNull(),
                        "canceledAt": NSNull(),
                        "executedAt": NSNull(),
                        "completedAt": NSNull(),
                    ],
                ])
            )
        }
        do {
            _ = try await client.accountDeletionStatus(token: "access-token")
            XCTFail("A scheduled deletion must carry its grace deadline")
        } catch LuxoraAPIError.invalidResponse {
            // Expected.
        }
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    ) -> LuxoraAPIClient {
        AccountDataURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountDataURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://account-data.contract.invalid")!,
                realtimeURL: URL(string: "wss://account-data.contract.invalid/v2/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }
}

// MARK: - Store tests

@MainActor
final class AccountDataStoreTests: XCTestCase {
    private let exportID = UUID(uuidString: "66666666-6666-4666-8666-666666666666")!
    private let accountID = UUID(uuidString: "77777777-7777-4777-8777-777777777777")!
    private let fixedDate = Date(timeIntervalSince1970: 1_790_000_000)
    private let payload = Data("luxora-export-archive-bytes".utf8)

    func testExportPollingSettlesWhenReady() async {
        let pending = exportRecord(state: .pending)
        let ready = exportRecord(
            state: .ready,
            sizeBytes: payload.count,
            sha256: accountDataSHA256(payload)
        )
        let requester = ExportRequesterProbe(record: pending)
        let status = ExportStatusProbe(records: [pending, ready])
        let store = makeStore(requester: requester, statusProbe: status)

        await store.requestExport()

        XCTAssertEqual(store.exportState, .loaded)
        XCTAssertEqual(store.exportRecord?.state, .ready)
        XCTAssertEqual(store.exportPollAttempts, 2)
        XCTAssertTrue(store.exportIsReady)
        let statusCalls = await status.callCount
        XCTAssertEqual(statusCalls, 2)
        let requestCalls = await requester.callCount
        XCTAssertEqual(requestCalls, 1)
    }

    func testExportPollingIsBoundedAndHonest() async {
        let pending = exportRecord(state: .pending)
        let requester = ExportRequesterProbe(record: pending)
        let status = ExportStatusProbe(records: Array(repeating: pending, count: 10))
        let store = makeStore(requester: requester, statusProbe: status)
        store.maxExportPollAttempts = 2

        await store.requestExport()

        guard case let .failed(detail) = store.exportState else {
            return XCTFail("A never-ready export must surface honestly")
        }
        XCTAssertTrue(detail.contains("всё ещё собирается"))
        XCTAssertTrue(store.canRetryExportCheck)
        XCTAssertEqual(store.exportPollAttempts, 2)
        let statusCalls = await status.callCount
        XCTAssertEqual(statusCalls, 2)
    }

    func testDownloadVerifiesDigestAndWritesShareableFile() async throws {
        let digest = accountDataSHA256(payload)
        let ready = exportRecord(state: .ready, sizeBytes: payload.count, sha256: digest)
        let downloader = ExportDownloadProbe(data: payload)
        let store = makeStore(
            requester: ExportRequesterProbe(record: ready),
            statusProbe: ExportStatusProbe(records: []),
            downloader: downloader
        )
        await store.requestExport()
        XCTAssertTrue(store.exportIsReady)

        await store.downloadExport()

        XCTAssertEqual(store.downloadState, .loaded)
        XCTAssertEqual(store.downloadedExportBytes, payload.count)
        XCTAssertEqual(store.verifiedExportSHA256, digest)
        let fileURL = try XCTUnwrap(store.downloadedExportFileURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        let writtenData = try Data(contentsOf: fileURL)
        XCTAssertEqual(writtenData, payload)
        store.clearDownloadedExport()
        XCTAssertNil(store.downloadedExportFileURL)

        // Same length as the expected archive so the size check passes and the
        // digest comparison is what rejects it.
        let corrupted = Data(repeating: 0x41, count: payload.count)
        let corruptedStore = makeStore(
            requester: ExportRequesterProbe(record: ready),
            statusProbe: ExportStatusProbe(records: []),
            downloader: ExportDownloadProbe(data: corrupted)
        )
        await corruptedStore.requestExport()
        await corruptedStore.downloadExport()

        guard case let .failed(detail) = corruptedStore.downloadState else {
            return XCTFail("A digest mismatch must not produce a shareable archive")
        }
        XCTAssertTrue(detail.contains("Контрольная сумма"))
        XCTAssertNil(corruptedStore.downloadedExportFileURL)
    }

    func testDeletionScheduleAndCancelRespectGraceWindow() async {
        let none = deletionRecord(state: .none)
        let scheduled = deletionRecord(
            state: .scheduled,
            scheduledAt: fixedDate,
            graceDeadlineAt: fixedDate.addingTimeInterval(7 * 24 * 3_600)
        )
        let canceled = deletionRecord(state: .none, canceledAt: fixedDate.addingTimeInterval(60))
        let probe = DeletionProbe(
            statusRecord: none,
            scheduleRecord: scheduled,
            cancelRecord: canceled
        )
        let store = makeStore(deletionProbe: probe)
        let frozenNow = fixedDate
        store.now = { frozenNow }

        await store.loadDeletionStatus()
        XCTAssertEqual(store.deletionState, .loaded)
        XCTAssertFalse(store.isDeletionScheduled)
        XCTAssertFalse(store.canCancelDeletion())

        let scheduledResult = await store.scheduleDeletion()
        XCTAssertTrue(scheduledResult)
        XCTAssertTrue(store.isDeletionScheduled)
        XCTAssertTrue(store.canCancelDeletion())

        let cancelResult = await store.cancelDeletion()
        XCTAssertTrue(cancelResult)
        XCTAssertFalse(store.isDeletionScheduled)
        XCTAssertEqual(store.deletion?.state, AccountDeletionState.none)
        XCTAssertNotNil(store.lastCanceledDeletion)
        let scheduleCalls = await probe.scheduleCallCount
        let cancelCalls = await probe.cancelCallCount
        XCTAssertEqual(scheduleCalls, 1)
        XCTAssertEqual(cancelCalls, 1)
    }

    func testCancelDeletionIsGatedAfterDeadlineWithoutNetwork() async {
        let scheduled = deletionRecord(
            state: .scheduled,
            scheduledAt: fixedDate.addingTimeInterval(-7 * 24 * 3_600),
            graceDeadlineAt: fixedDate.addingTimeInterval(-60)
        )
        let probe = DeletionProbe(
            statusRecord: scheduled,
            scheduleRecord: scheduled,
            cancelRecord: scheduled
        )
        let store = makeStore(deletionProbe: probe)
        let frozenNow = fixedDate
        store.now = { frozenNow }

        await store.loadDeletionStatus()
        XCTAssertFalse(store.canCancelDeletion())

        let canceled = await store.cancelDeletion()
        XCTAssertFalse(canceled)
        XCTAssertTrue(store.deletionActionError?.contains("Срок отмены истёк") ?? false)
        let cancelCalls = await probe.cancelCallCount
        XCTAssertEqual(cancelCalls, 0)
    }

    func testUnavailableTransportIsReportedHonestly() async {
        let store = AccountDataStore()

        await store.requestExport()
        guard case let .failed(exportDetail) = store.exportState else {
            return XCTFail("An unwired export request must fail visibly")
        }
        XCTAssertTrue(exportDetail.contains("не подключен"))

        await store.loadDeletionStatus()
        guard case let .failed(deletionDetail) = store.deletionState else {
            return XCTFail("An unwired deletion status must fail visibly")
        }
        XCTAssertTrue(deletionDetail.contains("не подключена"))

        await store.downloadExport()
        XCTAssertTrue(store.downloadError?.contains("Сначала запросите экспорт") ?? false)

        let canceled = await store.cancelDeletion()
        XCTAssertFalse(canceled)
        XCTAssertTrue(store.deletionActionError?.contains("Запланированного удаления нет") ?? false)
    }

    private func makeStore(
        requester: ExportRequesterProbe,
        statusProbe: ExportStatusProbe,
        downloader: ExportDownloadProbe? = nil
    ) -> AccountDataStore {
        let store = AccountDataStore()
        store.sleep = { await Task.yield() }
        store.configureRemote(
            exportRequester: { try await requester.request() },
            exportStatusLoader: { id in try await statusProbe.status(for: id) },
            exportDownloader: { id in
                guard let downloader else { throw LuxoraAPIError.transport("downloader") }
                return try await downloader.download(for: id)
            },
            deletionStatusLoader: { throw LuxoraAPIError.transport("deletion status") },
            deletionScheduler: { throw LuxoraAPIError.transport("deletion scheduler") },
            deletionCanceller: { throw LuxoraAPIError.transport("deletion canceller") }
        )
        return store
    }

    private func makeStore(deletionProbe: DeletionProbe) -> AccountDataStore {
        let store = AccountDataStore()
        store.sleep = { await Task.yield() }
        store.configureRemote(
            exportRequester: { throw LuxoraAPIError.transport("export requester") },
            exportStatusLoader: { _ in throw LuxoraAPIError.transport("export status") },
            exportDownloader: { _ in throw LuxoraAPIError.transport("export downloader") },
            deletionStatusLoader: { try await deletionProbe.status() },
            deletionScheduler: { try await deletionProbe.schedule() },
            deletionCanceller: { try await deletionProbe.cancel() }
        )
        return store
    }

    private func exportRecord(
        state: DataExportState,
        sizeBytes: Int? = nil,
        sha256: String? = nil
    ) -> DataExportRecord {
        DataExportRecord(
            id: exportID,
            state: state,
            sizeBytes: sizeBytes,
            sha256: sha256,
            createdAt: fixedDate,
            readyAt: state == .ready ? fixedDate : nil,
            expiresAt: state == .ready ? fixedDate.addingTimeInterval(7 * 24 * 3_600) : nil
        )
    }

    private func deletionRecord(
        state: AccountDeletionState,
        scheduledAt: Date? = nil,
        graceDeadlineAt: Date? = nil,
        canceledAt: Date? = nil
    ) -> AccountDeletionRecord {
        AccountDeletionRecord(
            accountID: accountID,
            state: state,
            scheduledAt: scheduledAt,
            graceDeadlineAt: graceDeadlineAt,
            scheduledBySessionID: nil,
            canceledAt: canceledAt,
            executedAt: nil,
            completedAt: nil
        )
    }
}

// MARK: - Helpers and probes

private func accountDataSHA256(_ data: Data) -> String {
    SHA256.hash(data: data)
        .map { String(format: "%02x", $0) }
        .joined()
}

private func accountDataScheduledDeletion(accountID: UUID) -> [String: Any] {
    [
        "accountId": accountID.uuidString.lowercased(),
        "state": "scheduled",
        "scheduledAt": "2026-10-31T15:55:03.682Z",
        "graceDeadlineAt": "2026-11-07T15:55:03.682Z",
        "scheduledBySessionId": "88888888-8888-4888-8888-888888888888",
        "canceledAt": NSNull(),
        "executedAt": NSNull(),
        "completedAt": NSNull(),
    ]
}

private actor ExportRequesterProbe {
    private let record: DataExportRecord
    private(set) var callCount = 0

    init(record: DataExportRecord) {
        self.record = record
    }

    func request() throws -> DataExportRecord {
        callCount += 1
        return record
    }
}

private actor ExportStatusProbe {
    private var records: [DataExportRecord]
    private(set) var callCount = 0

    init(records: [DataExportRecord]) {
        self.records = records
    }

    func status(for id: UUID) throws -> DataExportRecord {
        callCount += 1
        guard let record = records.first else {
            throw LuxoraAPIError.transport("no status")
        }
        if records.count > 1 {
            records.removeFirst()
        }
        guard record.id == id else { throw LuxoraAPIError.invalidResponse }
        return record
    }
}

private actor ExportDownloadProbe {
    private let data: Data
    private(set) var callCount = 0

    init(data: Data) {
        self.data = data
    }

    func download(for id: UUID) throws -> Data {
        callCount += 1
        return data
    }
}

private actor DeletionProbe {
    private let statusRecord: AccountDeletionRecord
    private let scheduleRecord: AccountDeletionRecord
    private let cancelRecord: AccountDeletionRecord
    private(set) var statusCallCount = 0
    private(set) var scheduleCallCount = 0
    private(set) var cancelCallCount = 0

    init(
        statusRecord: AccountDeletionRecord,
        scheduleRecord: AccountDeletionRecord,
        cancelRecord: AccountDeletionRecord
    ) {
        self.statusRecord = statusRecord
        self.scheduleRecord = scheduleRecord
        self.cancelRecord = cancelRecord
    }

    func status() throws -> AccountDeletionRecord {
        statusCallCount += 1
        return statusRecord
    }

    func schedule() throws -> AccountDeletionRecord {
        scheduleCallCount += 1
        return scheduleRecord
    }

    func cancel() throws -> AccountDeletionRecord {
        cancelCallCount += 1
        return cancelRecord
    }
}

// MARK: - Contract harness

private final class AccountDataURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, [String: String], Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw AccountDataHarnessError.missingHandler }
            let (status, headers, data) = try handler(request)
            var responseHeaders = headers
            if responseHeaders["Content-Type"] == nil {
                responseHeaders["Content-Type"] = "application/json; charset=utf-8"
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: responseHeaders
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

private enum AccountDataHarnessError: Error {
    case missingHandler
    case unexpectedRequest
}

private final class AccountDataRequestFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return requests.count
    }

    func record(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }
}

private func accountDataJSONBody(_ request: URLRequest) throws -> [String: Any]? {
    let data: Data?
    if let body = request.httpBody {
        data = body
    } else if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            result.append(buffer, count: count)
        }
        data = result
    } else {
        data = nil
    }
    guard let data, !data.isEmpty else { return nil }
    return try JSONSerialization.jsonObject(with: data) as? [String: Any]
}

private func accountDataJSONData(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
}

private func accountDataDate(_ raw: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: raw) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: raw)!
}
