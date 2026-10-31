import Foundation

// MARK: - Safety report models

/// The exact server enum for a safety report category. `rawValue` is the
/// wire value from the protocol contract; the Russian title is only for UI.
public enum SafetyReportCategory: String, CaseIterable, Codable, Identifiable, Sendable {
    case spam
    case scam
    case harassment
    case hate
    case sexualContent = "sexual_content"
    case violence
    case impersonation
    case selfHarm = "self_harm"
    case other

    public var id: String { rawValue }

    public var russianTitle: String {
        switch self {
        case .spam: "Спам"
        case .scam: "Мошенничество"
        case .harassment: "Преследование"
        case .hate: "Ненависть"
        case .sexualContent: "Сексуальный контент"
        case .violence: "Насилие"
        case .impersonation: "Выдаёт себя за другого"
        case .selfHarm: "Самоповреждение"
        case .other: "Другое"
        }
    }

    /// Server rule: every category except `impersonation` and `other` must
    /// carry at least one selected message as evidence.
    public var requiresMessageEvidence: Bool {
        self != .impersonation && self != .other
    }
}

/// One selected message attached to a report. The server only accepts the
/// `message` evidence type and never returns evidence references back.
public struct SafetyReportEvidence: Equatable, Sendable {
    public let messageID: UUID

    public init(messageID: UUID) {
        self.messageID = messageID
    }
}

/// Acknowledgement summary returned by the server. It deliberately contains
/// no plaintext comment and no evidence references.
public struct SafetyReportSummary: Decodable, Equatable, Sendable {
    public let id: UUID
    public let subjectAccountID: UUID
    public let category: SafetyReportCategory
    public let evidenceCount: Int
    public let alsoBlocked: Bool
    public let submittedAt: Date

    public init(
        id: UUID,
        subjectAccountID: UUID,
        category: SafetyReportCategory,
        evidenceCount: Int,
        alsoBlocked: Bool,
        submittedAt: Date
    ) {
        self.id = id
        self.subjectAccountID = subjectAccountID
        self.category = category
        self.evidenceCount = evidenceCount
        self.alsoBlocked = alsoBlocked
        self.submittedAt = submittedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case subjectAccountId
        case category
        case evidenceCount
        case alsoBlocked
        case status
        case submittedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        subjectAccountID = try container.decode(UUID.self, forKey: .subjectAccountId)
        category = try container.decode(SafetyReportCategory.self, forKey: .category)
        evidenceCount = try container.decode(Int.self, forKey: .evidenceCount)
        alsoBlocked = try container.decode(Bool.self, forKey: .alsoBlocked)
        let status = try container.decode(String.self, forKey: .status)
        guard status == "submitted",
              (0...SafetyReportLimits.maxEvidence).contains(evidenceCount)
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .status,
                in: container,
                debugDescription: "Unsupported safety report acknowledgement"
            )
        }
        submittedAt = try container.decode(Date.self, forKey: .submittedAt)
    }
}

public struct SafetyReportPage: Equatable, Sendable {
    public let items: [SafetyReportSummary]
    public let nextCursor: String?

    public init(items: [SafetyReportSummary], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

public enum SafetyReportLimits {
    public static let maxCommentCodePoints = 2_000
    public static let maxEvidence = 20
    public static let defaultPageSize = 30
    public static let maxPageSize = 100
    public static let maxCursorLength = 512
}

// MARK: - Account data models

public enum DataExportState: String, Decodable, Equatable, Sendable {
    case pending
    case ready
    case expired
}

/// Server-side export artifact. The raw archive is downloaded separately,
/// bound to the current session; the record only carries delivery metadata.
public struct DataExportRecord: Decodable, Equatable, Sendable {
    public let id: UUID
    public let state: DataExportState
    public let sizeBytes: Int?
    public let sha256: String?
    public let createdAt: Date
    public let readyAt: Date?
    public let expiresAt: Date?

    public init(
        id: UUID,
        state: DataExportState,
        sizeBytes: Int?,
        sha256: String?,
        createdAt: Date,
        readyAt: Date?,
        expiresAt: Date?
    ) {
        self.id = id
        self.state = state
        self.sizeBytes = sizeBytes
        self.sha256 = sha256
        self.createdAt = createdAt
        self.readyAt = readyAt
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case state
        case sizeBytes
        case sha256
        case createdAt
        case readyAt
        case expiresAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        state = try container.decode(DataExportState.self, forKey: .state)
        sizeBytes = try container.decodeIfPresent(Int.self, forKey: .sizeBytes)
        sha256 = try container.decodeIfPresent(String.self, forKey: .sha256)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        readyAt = try container.decodeIfPresent(Date.self, forKey: .readyAt)
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
        if let sizeBytes, sizeBytes < 0 {
            throw DecodingError.dataCorruptedError(
                forKey: .sizeBytes,
                in: container,
                debugDescription: "Export size cannot be negative"
            )
        }
        if let sha256, !Self.isValidSHA256(sha256) {
            throw DecodingError.dataCorruptedError(
                forKey: .sha256,
                in: container,
                debugDescription: "Export digest is malformed"
            )
        }
        if let readyAt, readyAt < createdAt {
            throw DecodingError.dataCorruptedError(
                forKey: .readyAt,
                in: container,
                debugDescription: "Export became ready before it was created"
            )
        }
        if let readyAt, let expiresAt, expiresAt < readyAt {
            throw DecodingError.dataCorruptedError(
                forKey: .expiresAt,
                in: container,
                debugDescription: "Export expires before it becomes ready"
            )
        }
    }

    static func isValidSHA256(_ value: String) -> Bool {
        guard value.count == 64 else { return false }
        return value.allSatisfy { character in
            character.isASCII && character.isHexDigit
        }
    }
}

/// Authorized archive bytes plus the delivery metadata the server attached.
/// The client never logs or persists the archive; callers verify the digest
/// before offering it to the user.
public struct DataExportDownload: Sendable {
    public let data: Data
    public let etag: String?
    public let contentRange: String?
    public let contentType: String?
    public let isPartial: Bool

    public init(
        data: Data,
        etag: String?,
        contentRange: String?,
        contentType: String?,
        isPartial: Bool
    ) {
        self.data = data
        self.etag = etag
        self.contentRange = contentRange
        self.contentType = contentType
        self.isPartial = isPartial
    }
}

public enum AccountDeletionState: String, Decodable, Equatable, Sendable {
    case none
    case scheduled
    case deletionPending = "deletion_pending"
    case executing
    case completed
    case failedRetryable = "failed_retryable"
}

/// Current account-deletion record. A scheduled deletion has a real seven-day
/// grace window (`graceDeadlineAt`) before it executes server-side.
public struct AccountDeletionRecord: Decodable, Equatable, Sendable {
    public let accountID: UUID
    public let state: AccountDeletionState
    public let scheduledAt: Date?
    public let graceDeadlineAt: Date?
    public let scheduledBySessionID: String?
    public let canceledAt: Date?
    public let executedAt: Date?
    public let completedAt: Date?

    public init(
        accountID: UUID,
        state: AccountDeletionState,
        scheduledAt: Date?,
        graceDeadlineAt: Date?,
        scheduledBySessionID: String?,
        canceledAt: Date?,
        executedAt: Date?,
        completedAt: Date?
    ) {
        self.accountID = accountID
        self.state = state
        self.scheduledAt = scheduledAt
        self.graceDeadlineAt = graceDeadlineAt
        self.scheduledBySessionID = scheduledBySessionID
        self.canceledAt = canceledAt
        self.executedAt = executedAt
        self.completedAt = completedAt
    }

    private enum CodingKeys: String, CodingKey {
        case accountId
        case state
        case scheduledAt
        case graceDeadlineAt
        case scheduledBySessionId
        case canceledAt
        case executedAt
        case completedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accountID = try container.decode(UUID.self, forKey: .accountId)
        state = try container.decode(AccountDeletionState.self, forKey: .state)
        scheduledAt = try container.decodeIfPresent(Date.self, forKey: .scheduledAt)
        graceDeadlineAt = try container.decodeIfPresent(Date.self, forKey: .graceDeadlineAt)
        scheduledBySessionID = try container.decodeIfPresent(String.self, forKey: .scheduledBySessionId)
        canceledAt = try container.decodeIfPresent(Date.self, forKey: .canceledAt)
        executedAt = try container.decodeIfPresent(Date.self, forKey: .executedAt)
        completedAt = try container.decodeIfPresent(Date.self, forKey: .completedAt)

        switch state {
        case .scheduled:
            guard let scheduledAt, let graceDeadlineAt, graceDeadlineAt > scheduledAt else {
                throw DecodingError.dataCorruptedError(
                    forKey: .state,
                    in: container,
                    debugDescription: "Scheduled deletion is missing its grace window"
                )
            }
        case .deletionPending, .executing:
            guard scheduledAt != nil, graceDeadlineAt != nil else {
                throw DecodingError.dataCorruptedError(
                    forKey: .state,
                    in: container,
                    debugDescription: "Deletion in progress is missing its schedule"
                )
            }
        case .completed:
            guard completedAt != nil else {
                throw DecodingError.dataCorruptedError(
                    forKey: .state,
                    in: container,
                    debugDescription: "Completed deletion has no completion timestamp"
                )
            }
        case .none, .failedRetryable:
            break
        }
    }
}

// MARK: - Client

extension LuxoraAPIClient {
    /// Submits a report about one account. The subject is always the author of
    /// the selected evidence; the app never lets the reporter choose an
    /// arbitrary account id for an evidence-backed category.
    func submitSafetyReport(
        subjectAccountID: UUID,
        category: SafetyReportCategory,
        evidenceMessageIDs: [UUID],
        comment: String?,
        alsoBlock: Bool,
        clientNonce: UUID,
        token: String
    ) async throws -> SafetyReportSummary {
        guard evidenceMessageIDs.count <= SafetyReportLimits.maxEvidence,
              Set(evidenceMessageIDs).count == evidenceMessageIDs.count
        else { throw LuxoraAPIError.invalidResponse }
        if category.requiresMessageEvidence, evidenceMessageIDs.isEmpty {
            throw LuxoraAPIError.invalidResponse
        }
        let normalizedComment = Self.normalizedSafetyComment(comment)
        if comment?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
           normalizedComment == nil {
            throw LuxoraAPIError.invalidResponse
        }
        let response: SafetyReportEnvelope = try await safetyRequest(
            path: "/v1/safety/reports",
            method: "POST",
            body: SafetyReportSubmitBody(
                subjectAccountId: subjectAccountID.apiPathComponent,
                category: category.rawValue,
                evidence: evidenceMessageIDs.map {
                    SafetyReportSubmitBody.Evidence(type: "message", messageId: $0.apiPathComponent)
                },
                comment: normalizedComment,
                alsoBlock: alsoBlock,
                clientNonce: clientNonce.apiPathComponent
            ),
            token: token
        )
        return response.report
    }

    /// Own immutable report summaries, newest first, cursor paginated.
    func listSafetyReports(
        limit: Int = SafetyReportLimits.defaultPageSize,
        cursor: String? = nil,
        token: String
    ) async throws -> SafetyReportPage {
        guard (1...SafetyReportLimits.maxPageSize).contains(limit) else {
            throw LuxoraAPIError.invalidResponse
        }
        var queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor {
            guard !cursor.isEmpty, cursor.count <= SafetyReportLimits.maxCursorLength else {
                throw LuxoraAPIError.invalidResponse
            }
            queryItems.append(URLQueryItem(name: "cursor", value: cursor))
        }
        var components = URLComponents()
        components.path = "/v1/safety/reports"
        components.queryItems = queryItems
        guard let path = components.string else { throw LuxoraAPIError.invalidResponse }
        let response: SafetyReportPageEnvelope = try await safetyRequest(
            path: path,
            method: "GET",
            body: Optional<SafetyEmptyBody>.none,
            token: token
        )
        guard response.items.count <= limit,
              Set(response.items.map(\.id)).count == response.items.count,
              response.nextCursor.map({ !$0.isEmpty && $0.count <= SafetyReportLimits.maxCursorLength }) ?? true
        else { throw LuxoraAPIError.invalidResponse }
        return SafetyReportPage(items: response.items, nextCursor: response.nextCursor)
    }

    /// Requests the account data export. The server reuses the newest live
    /// ready archive while it is still valid and returns the same record, so
    /// repeated taps are safe.
    func requestDataExport(token: String) async throws -> DataExportRecord {
        let response: DataExportEnvelope = try await safetyRequest(
            path: "/v1/data-exports",
            method: "POST",
            body: SafetyEmptyBody(),
            token: token
        )
        return response.dataExport
    }

    func dataExportStatus(id: UUID, token: String) async throws -> DataExportRecord {
        let response: DataExportEnvelope = try await safetyRequest(
            path: "/v1/data-exports/\(id.apiPathComponent)",
            method: "GET",
            body: Optional<SafetyEmptyBody>.none,
            token: token
        )
        return response.dataExport
    }

    /// Downloads the archive over the authorized session. Only gzip bytes with
    /// a consistent size are accepted; the caller verifies the record digest.
    func downloadDataExport(
        id: UUID,
        range: Range<Int>? = nil,
        token: String
    ) async throws -> DataExportDownload {
        if let range {
            guard range.lowerBound >= 0, range.upperBound > range.lowerBound else {
                throw LuxoraAPIError.invalidResponse
            }
        }
        var headers: [String: String] = [:]
        if let range {
            headers["Range"] = "bytes=\(range.lowerBound)-\(range.upperBound - 1)"
        }
        let (data, http) = try await safetyRawRequest(
            path: "/v1/data-exports/\(id.apiPathComponent)/download",
            method: "GET",
            headers: headers,
            token: token
        )
        guard let contentType = http.value(forHTTPHeaderField: "Content-Type"),
              contentType.lowercased().hasPrefix("application/gzip")
        else { throw LuxoraAPIError.invalidResponse }
        guard !data.isEmpty else { throw LuxoraAPIError.invalidResponse }
        if let declaredLength = http.value(forHTTPHeaderField: "Content-Length").flatMap(Int.init),
           declaredLength != data.count {
            throw LuxoraAPIError.invalidResponse
        }
        let isPartial = http.statusCode == 206
        if range != nil {
            guard isPartial, http.value(forHTTPHeaderField: "Content-Range") != nil else {
                throw LuxoraAPIError.invalidResponse
            }
        } else {
            guard http.statusCode == 200 else { throw LuxoraAPIError.invalidResponse }
        }
        return DataExportDownload(
            data: data,
            etag: http.value(forHTTPHeaderField: "ETag"),
            contentRange: http.value(forHTTPHeaderField: "Content-Range"),
            contentType: contentType,
            isPartial: isPartial
        )
    }

    func accountDeletionStatus(token: String) async throws -> AccountDeletionRecord {
        let response: AccountDeletionEnvelope = try await safetyRequest(
            path: "/v1/account/deletion",
            method: "GET",
            body: Optional<SafetyEmptyBody>.none,
            token: token
        )
        return response.deletion
    }

    /// Schedules the current account for deletion; the server enforces a real
    /// seven-day grace window before anything is removed.
    func scheduleAccountDeletion(token: String) async throws -> AccountDeletionRecord {
        let response: AccountDeletionEnvelope = try await safetyRequest(
            path: "/v1/account/deletion",
            method: "POST",
            body: SafetyEmptyBody(),
            token: token
        )
        return response.deletion
    }

    /// Cancels a scheduled deletion while its grace window is still open.
    func cancelAccountDeletion(token: String) async throws -> AccountDeletionRecord {
        let response: AccountDeletionEnvelope = try await safetyRequest(
            path: "/v1/account/deletion",
            method: "DELETE",
            body: Optional<SafetyEmptyBody>.none,
            token: token
        )
        return response.deletion
    }

    // MARK: Transport

    private func safetyRequest<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        path: String,
        method: String,
        body: Body?,
        token: String
    ) async throws -> Response {
        let encodedBody: Data?
        if let body {
            encodedBody = try encoder.encode(body)
        } else {
            encodedBody = nil
        }
        let (data, _) = try await safetyRawRequest(
            path: path,
            method: method,
            body: encodedBody,
            headers: [:],
            token: token
        )
        do {
            return try Self.safetyDecoder().decode(Response.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
    }

    private func safetyRawRequest(
        path: String,
        method: String,
        body: Data? = nil,
        headers: [String: String] = [:],
        token: String
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL)?.absoluteURL else {
            throw LuxoraAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse,
              Self.sameOrigin(http.url, configuration.apiBaseURL)
        else { throw LuxoraAPIError.invalidResponse }
        guard 200..<300 ~= http.statusCode else {
            let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data)
            throw Self.sanitizedSafetyError(
                status: http.statusCode,
                proposedCode: envelope?.error.code
            )
        }
        return (data, http)
    }

    /// Safety responses carry server timestamps with milliseconds while older
    /// fixtures use plain ISO-8601. Accept both instead of rejecting a valid
    /// projection.
    private static func safetyDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            guard let date = safetyTimestamp(from: raw) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Invalid ISO-8601 timestamp"
                )
            }
            return date
        }
        return decoder
    }

    private static func safetyTimestamp(from raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    private static func normalizedSafetyComment(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.unicodeScalars.count <= SafetyReportLimits.maxCommentCodePoints else {
            return nil
        }
        return trimmed
    }

    /// Reduces every rejection to a known-safe status/code. Server-supplied
    /// bodies, comments and tokens never become part of the error.
    private static func sanitizedSafetyError(status: Int, proposedCode: String?) -> LuxoraAPIError {
        let safeCode: String
        switch proposedCode {
        case "BAD_REQUEST",
             "UNAUTHENTICATED",
             "FORBIDDEN",
             "NOT_FOUND",
             "CONFLICT",
             "RATE_LIMITED",
             "VALIDATION_FAILED",
             "INTERNAL_ERROR",
             "SERVICE_UNAVAILABLE":
            safeCode = proposedCode ?? "HTTP_\(status)"
        default:
            safeCode = "HTTP_\(status)"
        }
        return LuxoraAPIError.server(
            status: status,
            code: safeCode,
            message: LuxoraL10n.text("error.server_request_failed")
        )
    }
}

// MARK: - Wire envelopes

private struct SafetyReportEnvelope: Decodable, Sendable {
    let report: SafetyReportSummary
}

private struct SafetyReportPageEnvelope: Decodable, Sendable {
    let items: [SafetyReportSummary]
    let nextCursor: String?
}

private struct DataExportEnvelope: Decodable, Sendable {
    let dataExport: DataExportRecord
}

private struct AccountDeletionEnvelope: Decodable, Sendable {
    let deletion: AccountDeletionRecord
}

private struct SafetyEmptyBody: Encodable, Sendable {}

private struct SafetyReportSubmitBody: Encodable, Sendable {
    struct Evidence: Encodable, Sendable {
        let type: String
        let messageId: String
    }

    let subjectAccountId: String
    let category: String
    let evidence: [Evidence]
    let comment: String?
    let alsoBlock: Bool
    let clientNonce: String
}
