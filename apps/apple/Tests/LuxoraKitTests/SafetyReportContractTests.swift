import Foundation
@testable import LuxoraKit
import XCTest

// MARK: - Client contract tests

final class SafetyReportContractTests: XCTestCase {
    private let subjectID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let messageID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let nonceID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    private let reportID = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!

    override func tearDown() {
        SafetyContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testSubmitUsesStrictContractAndDecodesAcknowledgement() async throws {
        let subjectID = subjectID
        let messageID = messageID
        let nonceID = nonceID
        let reportID = reportID
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/safety/reports")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try XCTUnwrap(safetyJSONBody(request))
            XCTAssertEqual(body["subjectAccountId"] as? String, subjectID.uuidString.lowercased())
            XCTAssertEqual(body["category"] as? String, "sexual_content")
            XCTAssertEqual(body["alsoBlock"] as? Bool, true)
            XCTAssertEqual(body["clientNonce"] as? String, nonceID.uuidString.lowercased())
            XCTAssertEqual(body["comment"] as? String, "Привет")
            let evidence = try XCTUnwrap(body["evidence"] as? [[String: String]])
            XCTAssertEqual(evidence, [["type": "message", "messageId": messageID.uuidString.lowercased()]])
            return (
                201,
                ["Content-Type": "application/json"],
                try safetyJSONData([
                    "report": [
                        "id": reportID.uuidString.lowercased(),
                        "subjectAccountId": subjectID.uuidString.lowercased(),
                        "category": "sexual_content",
                        "evidenceCount": 1,
                        "alsoBlocked": true,
                        "status": "submitted",
                        "submittedAt": "2026-10-31T15:55:03.604Z",
                    ],
                ])
            )
        }

        let summary = try await client.submitSafetyReport(
            subjectAccountID: subjectID,
            category: .sexualContent,
            evidenceMessageIDs: [messageID],
            comment: "  Привет  ",
            alsoBlock: true,
            clientNonce: nonceID,
            token: "access-token"
        )

        XCTAssertEqual(summary.id, reportID)
        XCTAssertEqual(summary.subjectAccountID, subjectID)
        XCTAssertEqual(summary.category, .sexualContent)
        XCTAssertEqual(summary.evidenceCount, 1)
        XCTAssertTrue(summary.alsoBlocked)
        XCTAssertEqual(summary.submittedAt, safetyDate("2026-10-31T15:55:03.604Z"))
    }

    func testSubmitOmitsEmptyCommentAndAllowsEvidenceFreeCategories() async throws {
        let subjectID = subjectID
        let client = makeClient { request in
            let body = try XCTUnwrap(safetyJSONBody(request))
            XCTAssertNil(body["comment"])
            XCTAssertEqual(body["category"] as? String, "impersonation")
            XCTAssertEqual((body["evidence"] as? [Any])?.count, 0)
            return (
                201,
                [:],
                try safetyJSONData([
                    "report": [
                        "id": "44444444-4444-4444-8444-444444444444",
                        "subjectAccountId": subjectID.uuidString.lowercased(),
                        "category": "impersonation",
                        "evidenceCount": 0,
                        "alsoBlocked": false,
                        "status": "submitted",
                        "submittedAt": "2026-10-31T15:55:03Z",
                    ],
                ])
            )
        }

        let summary = try await client.submitSafetyReport(
            subjectAccountID: subjectID,
            category: .impersonation,
            evidenceMessageIDs: [],
            comment: "   ",
            alsoBlock: false,
            clientNonce: nonceID,
            token: "access-token"
        )

        XCTAssertEqual(summary.evidenceCount, 0)
        XCTAssertEqual(summary.submittedAt, safetyDate("2026-10-31T15:55:03Z"))
    }

    func testSubmitRejectsInvalidLocalInputWithoutNetwork() async throws {
        let flag = SafetyRequestFlag()
        let client = makeClient { request in
            flag.record(request)
            throw SafetyContractHarnessError.unexpectedRequest
        }
        let subjectID = subjectID
        let messageID = messageID

        do {
            _ = try await client.submitSafetyReport(
                subjectAccountID: subjectID,
                category: .spam,
                evidenceMessageIDs: [],
                comment: nil,
                alsoBlock: false,
                clientNonce: nonceID,
                token: "access-token"
            )
            XCTFail("An evidence-backed category cannot be submitted without evidence")
        } catch LuxoraAPIError.invalidResponse {
            // Expected local rejection.
        }

        do {
            _ = try await client.submitSafetyReport(
                subjectAccountID: subjectID,
                category: .other,
                evidenceMessageIDs: [messageID],
                comment: String(repeating: "а", count: 2_001),
                alsoBlock: false,
                clientNonce: nonceID,
                token: "access-token"
            )
            XCTFail("An overlong comment cannot be submitted")
        } catch LuxoraAPIError.invalidResponse {
            // Expected local rejection.
        }

        do {
            _ = try await client.submitSafetyReport(
                subjectAccountID: subjectID,
                category: .other,
                evidenceMessageIDs: [messageID, messageID],
                comment: nil,
                alsoBlock: false,
                clientNonce: nonceID,
                token: "access-token"
            )
            XCTFail("Duplicate evidence must be rejected locally")
        } catch LuxoraAPIError.invalidResponse {
            // Expected local rejection.
        }

        XCTAssertEqual(flag.requestCount, 0)
    }

    func testListPassesLimitAndCursorAndDecodesPage() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/safety/reports")
            let query = safetyQueryItems(request)
            XCTAssertEqual(query["limit"], "2")
            XCTAssertEqual(query["cursor"], "cursor-1")
            return (
                200,
                ["Cache-Control": "private, no-store"],
                try safetyJSONData([
                    "items": [[
                        "id": "44444444-4444-4444-8444-444444444444",
                        "subjectAccountId": "11111111-1111-4111-8111-111111111111",
                        "category": "hate",
                        "evidenceCount": 2,
                        "alsoBlocked": false,
                        "status": "submitted",
                        "submittedAt": "2026-10-31T15:55:03.604Z",
                    ]],
                    "nextCursor": "cursor-2",
                ])
            )
        }

        let page = try await client.listSafetyReports(
            limit: 2,
            cursor: "cursor-1",
            token: "access-token"
        )

        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items.first?.category, .hate)
        XCTAssertEqual(page.items.first?.evidenceCount, 2)
        XCTAssertEqual(page.nextCursor, "cursor-2")
    }

    func testListRejectsInvalidPageWithoutNetwork() async throws {
        let flag = SafetyRequestFlag()
        let client = makeClient { request in
            flag.record(request)
            throw SafetyContractHarnessError.unexpectedRequest
        }

        do {
            _ = try await client.listSafetyReports(limit: 0, token: "access-token")
            XCTFail("A zero page size is not a valid request")
        } catch LuxoraAPIError.invalidResponse {
            // Expected local rejection.
        }
        XCTAssertEqual(flag.requestCount, 0)
    }

    func testErrorMappingNeverLeaksServerTextOrUnknownCodes() async throws {
        let firstClient = makeClient { _ in
            (
                409,
                [:],
                try safetyJSONData([
                    "error": [
                        "code": "CONFLICT",
                        "message": "secret server text",
                        "requestId": "00000000-0000-4000-8000-000000000000",
                    ],
                ])
            )
        }
        do {
            _ = try await firstClient.listSafetyReports(token: "access-token")
            XCTFail("A conflict must surface as a server error")
        } catch let LuxoraAPIError.server(status, code, message) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "CONFLICT")
            XCTAssertEqual(message, LuxoraL10n.text("error.server_request_failed"))
            XCTAssertFalse(message.contains("secret"))
        }

        let secondClient = makeClient { _ in
            (
                418,
                [:],
                try safetyJSONData(["error": ["code": "TEAPOT_REASON", "message": "teapot"]])
            )
        }
        do {
            _ = try await secondClient.listSafetyReports(token: "access-token")
            XCTFail("An unknown code must still surface as a sanitized server error")
        } catch let LuxoraAPIError.server(status, code, _) {
            XCTAssertEqual(status, 418)
            XCTAssertEqual(code, "HTTP_418")
        }
    }

    func testDecodeRejectsUnknownCategoryAndUnexpectedStatus() async throws {
        let unknownCategoryClient = makeClient { _ in
            (
                200,
                [:],
                try safetyJSONData([
                    "items": [[
                        "id": "44444444-4444-4444-8444-444444444444",
                        "subjectAccountId": "11111111-1111-4111-8111-111111111111",
                        "category": "unknown_reason",
                        "evidenceCount": 1,
                        "alsoBlocked": false,
                        "status": "submitted",
                        "submittedAt": "2026-10-31T15:55:03.604Z",
                    ]],
                    "nextCursor": NSNull(),
                ])
            )
        }
        do {
            _ = try await unknownCategoryClient.listSafetyReports(token: "access-token")
            XCTFail("Unknown categories must be rejected")
        } catch LuxoraAPIError.invalidResponse {
            // Expected.
        }

        let unexpectedStatusClient = makeClient { _ in
            (
                200,
                [:],
                try safetyJSONData([
                    "items": [[
                        "id": "44444444-4444-4444-8444-444444444444",
                        "subjectAccountId": "11111111-1111-4111-8111-111111111111",
                        "category": "spam",
                        "evidenceCount": 1,
                        "alsoBlocked": false,
                        "status": "under_review",
                        "submittedAt": "2026-10-31T15:55:03.604Z",
                    ]],
                    "nextCursor": NSNull(),
                ])
            )
        }
        do {
            _ = try await unexpectedStatusClient.listSafetyReports(token: "access-token")
            XCTFail("Only the submitted acknowledgement is valid")
        } catch LuxoraAPIError.invalidResponse {
            // Expected.
        }
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    ) -> LuxoraAPIClient {
        SafetyContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SafetyContractURLProtocol.self]
        return LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://safety.contract.invalid")!,
                realtimeURL: URL(string: "wss://safety.contract.invalid/v2/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }
}

// MARK: - Store tests

@MainActor
final class SafetyReportsStoreTests: XCTestCase {
    private let subjectID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let messageID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let reportID = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!
    private let otherReportID = UUID(uuidString: "55555555-5555-4555-8555-555555555555")!
    private let fixedDate = Date(timeIntervalSince1970: 1_790_000_000)

    func testSubmitRetainsSameNonceAcrossLostResponseRetry() async {
        let probe = SafetySubmitProbe(
            failures: [.transport("response lost")],
            summaryFactory: { command in
                SafetyReportSummary(
                    id: UUID(),
                    subjectAccountID: command.subjectAccountID,
                    category: command.category,
                    evidenceCount: command.evidenceMessageIDs.count,
                    alsoBlocked: command.alsoBlock,
                    submittedAt: Date(timeIntervalSince1970: 1_790_000_000)
                )
            }
        )
        let store = makeStore(submitter: probe)
        let messageID = messageID
        let subjectID = subjectID

        let first = await store.submitReport(
            subjectAccountID: subjectID,
            category: .harassment,
            evidenceMessageIDs: [messageID],
            comment: "  текст  ",
            alsoBlock: true
        )

        XCTAssertFalse(first)
        XCTAssertTrue(store.canRetrySubmission)
        guard case let .failed(detail) = store.submitState else {
            return XCTFail("A lost response must stay visible")
        }
        XCTAssertTrue(detail.contains("повтор безопасен"))
        XCTAssertNil(store.lastSubmittedReport)

        let retried = await store.retrySubmission()

        XCTAssertTrue(retried)
        XCTAssertEqual(store.submitState, .loaded)
        XCTAssertNotNil(store.lastSubmittedReport)
        XCTAssertEqual(store.reports.count, 1)
        let submissions = await probe.submissions
        XCTAssertEqual(submissions.count, 2)
        XCTAssertEqual(submissions.first?.clientNonce, submissions.last?.clientNonce)
        XCTAssertEqual(submissions.first?.comment, "текст")
        XCTAssertEqual(submissions.first?.alsoBlock, true)
    }

    func testSubmitValidatesLocallyWithoutNetwork() async {
        let probe = SafetySubmitProbe(failures: [], summaryFactory: { command in
            SafetyReportSummary(
                id: UUID(),
                subjectAccountID: command.subjectAccountID,
                category: command.category,
                evidenceCount: command.evidenceMessageIDs.count,
                alsoBlocked: command.alsoBlock,
                submittedAt: Date()
            )
        })
        let store = makeStore(submitter: probe)
        let subjectID = subjectID
        let messageID = messageID

        let missingEvidence = await store.submitReport(
            subjectAccountID: subjectID,
            category: .spam,
            evidenceMessageIDs: [],
            comment: nil,
            alsoBlock: false
        )
        XCTAssertFalse(missingEvidence)
        XCTAssertTrue(store.submitError?.contains("хотя бы одно сообщение") ?? false)

        let overlongComment = await store.submitReport(
            subjectAccountID: subjectID,
            category: .other,
            evidenceMessageIDs: [messageID],
            comment: String(repeating: "а", count: 2_001),
            alsoBlock: false
        )
        XCTAssertFalse(overlongComment)
        XCTAssertTrue(store.submitError?.contains("2 000") ?? false)

        let submissions = await probe.submissions
        XCTAssertEqual(submissions.count, 0)
    }

    func testSubmitDefinitiveRejectionClearsNonceRetry() async {
        let probe = SafetySubmitProbe(
            failures: [.server(status: 409, code: "CONFLICT", message: "rejected")],
            summaryFactory: { command in
                SafetyReportSummary(
                    id: UUID(),
                    subjectAccountID: command.subjectAccountID,
                    category: command.category,
                    evidenceCount: command.evidenceMessageIDs.count,
                    alsoBlocked: command.alsoBlock,
                    submittedAt: Date()
                )
            }
        )
        let store = makeStore(submitter: probe)
        let subjectID = subjectID
        let messageID = messageID

        let submitted = await store.submitReport(
            subjectAccountID: subjectID,
            category: .spam,
            evidenceMessageIDs: [messageID],
            comment: nil,
            alsoBlock: false
        )

        XCTAssertFalse(submitted)
        XCTAssertFalse(store.canRetrySubmission)
        let retry = await store.retrySubmission()
        XCTAssertFalse(retry)
    }

    func testRefreshLoadsFirstPageAndLoadMoreAppends() async {
        let firstPage = SafetyReportPage(
            items: [makeSummary(id: reportID, submittedAt: fixedDate)],
            nextCursor: "cursor-1"
        )
        let secondPage = SafetyReportPage(
            items: [makeSummary(id: otherReportID, submittedAt: fixedDate.addingTimeInterval(60))],
            nextCursor: nil
        )
        let probe = SafetyPageProbe(pages: [firstPage, secondPage])
        let store = makeStore(pageProbe: probe)

        await store.refresh()

        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.reports.map(\.id), [reportID])
        XCTAssertTrue(store.canLoadMore)

        await store.loadMore()

        XCTAssertEqual(store.reports.map(\.id), [otherReportID, reportID])
        XCTAssertFalse(store.canLoadMore)
        XCTAssertNil(store.paginationError)
        let cursors = await probe.requestedCursors
        XCTAssertEqual(cursors.count, 2)
        XCTAssertNil(cursors.first ?? nil)
        XCTAssertEqual(cursors.last ?? nil, "cursor-1")
    }

    func testRepeatedCursorIsRejectedHonestly() async {
        let page = SafetyReportPage(
            items: [makeSummary(id: reportID, submittedAt: fixedDate)],
            nextCursor: "cursor-1"
        )
        let loopPage = SafetyReportPage(
            items: [makeSummary(id: otherReportID, submittedAt: fixedDate)],
            nextCursor: "cursor-1"
        )
        let probe = SafetyPageProbe(pages: [page, loopPage])
        let store = makeStore(pageProbe: probe)

        await store.refresh()
        await store.loadMore()

        XCTAssertEqual(store.reports.count, 1)
        XCTAssertNotNil(store.paginationError)
    }

    func testUnavailableTransportIsReportedHonestly() async {
        let store = SafetyReportsStore()
        let subjectID = subjectID
        let messageID = messageID

        await store.refresh()
        guard case let .failed(detail) = store.loadState else {
            return XCTFail("An unwired store must fail visibly")
        }
        XCTAssertTrue(detail.contains("не подключена"))

        let submitted = await store.submitReport(
            subjectAccountID: subjectID,
            category: .spam,
            evidenceMessageIDs: [messageID],
            comment: nil,
            alsoBlock: false
        )
        XCTAssertFalse(submitted)
        XCTAssertTrue(store.submitError?.contains("не подключена") ?? false)
    }

    private func makeStore(submitter: SafetySubmitProbe) -> SafetyReportsStore {
        let store = SafetyReportsStore()
        store.configureRemote(
            submitter: { command in try await submitter.submit(command) },
            pageLoader: { _, _ in throw LuxoraAPIError.transport("page loader") }
        )
        return store
    }

    private func makeStore(pageProbe: SafetyPageProbe) -> SafetyReportsStore {
        let store = SafetyReportsStore()
        store.configureRemote(
            submitter: { _ in throw LuxoraAPIError.transport("submitter") },
            pageLoader: { _, cursor in try await pageProbe.page(cursor: cursor) }
        )
        return store
    }

    private func makeSummary(id: UUID, submittedAt: Date) -> SafetyReportSummary {
        SafetyReportSummary(
            id: id,
            subjectAccountID: subjectID,
            category: .spam,
            evidenceCount: 1,
            alsoBlocked: false,
            submittedAt: submittedAt
        )
    }
}

// MARK: - Harness

private final class SafetyContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, [String: String], Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw SafetyContractHarnessError.missingHandler }
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

private enum SafetyContractHarnessError: Error {
    case missingHandler
    case unexpectedRequest
}

private final class SafetyRequestFlag: @unchecked Sendable {
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

private func safetyJSONBody(_ request: URLRequest) throws -> [String: Any]? {
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

private func safetyJSONData(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
}

private func safetyQueryItems(_ request: URLRequest) -> [String: String] {
    guard let components = request.url.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }),
          let items = components.queryItems
    else { return [:] }
    return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
}

private func safetyDate(_ raw: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: raw) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: raw)!
}

// MARK: - Probes

private actor SafetySubmitProbe {
    private(set) var submissions: [SafetyReportSubmission] = []
    private var failures: [LuxoraAPIError]
    private let summaryFactory: @Sendable (SafetyReportSubmission) -> SafetyReportSummary

    init(
        failures: [LuxoraAPIError],
        summaryFactory: @escaping @Sendable (SafetyReportSubmission) -> SafetyReportSummary
    ) {
        self.failures = failures
        self.summaryFactory = summaryFactory
    }

    func submit(_ command: SafetyReportSubmission) throws -> SafetyReportSummary {
        submissions.append(command)
        if !failures.isEmpty {
            throw failures.removeFirst()
        }
        return summaryFactory(command)
    }
}

private actor SafetyPageProbe {
    private var pages: [SafetyReportPage]
    private(set) var requestedCursors: [String?] = []

    init(pages: [SafetyReportPage]) {
        self.pages = pages
    }

    func page(cursor: String?) throws -> SafetyReportPage {
        requestedCursors.append(cursor)
        guard !pages.isEmpty else { throw LuxoraAPIError.transport("no page") }
        return pages.removeFirst()
    }
}
