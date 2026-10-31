import Foundation
import Observation

/// A report intent captured before dispatch. Reusing the same `clientNonce` on
/// retry is what makes a lost-response report idempotent on the server.
struct SafetyReportSubmission: Equatable, Sendable {
    let subjectAccountID: UUID
    let category: SafetyReportCategory
    let evidenceMessageIDs: [UUID]
    let comment: String?
    let alsoBlock: Bool
    let clientNonce: UUID

    func hasSameIntent(as other: SafetyReportSubmission) -> Bool {
        subjectAccountID == other.subjectAccountID
            && category == other.category
            && evidenceMessageIDs == other.evidenceMessageIDs
            && comment == other.comment
            && alsoBlock == other.alsoBlock
    }
}

/// Own safety-report summaries plus the single-message report submission flow.
///
/// The store never shows a report as delivered before the server returns its
/// acknowledgement summary; a lost response keeps an exact retry available and
/// reuses the same nonce so the server can replay the first result.
@MainActor
@Observable
public final class SafetyReportsStore {
    public private(set) var reports: [SafetyReportSummary] = []
    public private(set) var loadState: RemoteContentState = .idle
    public private(set) var isLoadingPage = false
    public private(set) var canLoadMore = false
    public private(set) var paginationError: String?
    public private(set) var submitState: RemoteContentState = .idle
    public private(set) var submitError: String?
    public private(set) var lastSubmittedReport: SafetyReportSummary?

    var remoteSubmitter: (@Sendable (SafetyReportSubmission) async throws -> SafetyReportSummary)?
    var remotePageLoader: (@Sendable (Int, String?) async throws -> SafetyReportPage)?
    var pageSize: Int = SafetyReportLimits.defaultPageSize

    @ObservationIgnored private var nextCursor: String?
    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var loadOperation: Task<SafetyReportPage, Error>?
    @ObservationIgnored private var submitOperation: Task<SafetyReportSummary, Error>?
    @ObservationIgnored private var submissionRetry: SafetyReportSubmission?

    public init() {}

    public var isSubmitting: Bool {
        submitState == .loading
    }

    public var canRetrySubmission: Bool {
        submissionRetry != nil && submitState != .loading
    }

    /// Starts a new submission. If the previous attempt failed with an unknown
    /// outcome and the caller repeats the exact same intent, the original
    /// nonce is reused so the server replays the first report instead of
    /// storing a duplicate.
    @discardableResult
    public func submitReport(
        subjectAccountID: UUID,
        category: SafetyReportCategory,
        evidenceMessageIDs: [UUID],
        comment: String?,
        alsoBlock: Bool
    ) async -> Bool {
        guard let remoteSubmitter else {
            failSubmission("Отправка жалоб не подключена.")
            return false
        }
        guard submitState != .loading else { return false }
        let normalizedComment: String?
        do {
            normalizedComment = try Self.validatedComment(comment)
            try Self.validateEvidence(evidenceMessageIDs, category: category)
        } catch let error as SafetyReportValidationError {
            failSubmission(error.russianMessage)
            return false
        } catch {
            failSubmission("Проверьте параметры жалобы и повторите.")
            return false
        }

        let candidate = SafetyReportSubmission(
            subjectAccountID: subjectAccountID,
            category: category,
            evidenceMessageIDs: evidenceMessageIDs,
            comment: normalizedComment,
            alsoBlock: alsoBlock,
            clientNonce: UUID()
        )
        let command: SafetyReportSubmission
        if let retry = submissionRetry, retry.hasSameIntent(as: candidate) {
            command = retry
        } else {
            command = candidate
        }
        return await performSubmission(command, submitter: remoteSubmitter)
    }

    /// Replays the retained report intent with its original nonce.
    @discardableResult
    public func retrySubmission() async -> Bool {
        guard let command = submissionRetry else { return false }
        guard let remoteSubmitter else {
            failSubmission("Отправка жалоб не подключена.")
            return false
        }
        return await performSubmission(command, submitter: remoteSubmitter)
    }

    public func clearSubmissionResult() {
        guard submitState != .loading else { return }
        submitState = .idle
        submitError = nil
        lastSubmittedReport = nil
        submissionRetry = nil
    }

    /// Replaces the list with a fresh first page.
    public func refresh(force: Bool = false) async {
        await loadPage(cursor: nil, replacement: true, force: force)
    }

    /// Appends the next page. A repeated cursor or overlapping page is rejected
    /// instead of being rendered twice.
    public func loadMore() async {
        guard let cursor = nextCursor, !isLoadingPage else { return }
        await loadPage(cursor: cursor, replacement: false, force: false)
    }

    func configureRemote(
        submitter: @escaping @Sendable (SafetyReportSubmission) async throws -> SafetyReportSummary,
        pageLoader: @escaping @Sendable (Int, String?) async throws -> SafetyReportPage
    ) {
        remoteSubmitter = submitter
        remotePageLoader = pageLoader
    }

    func cancelRemoteOperations() {
        generation &+= 1
        loadOperation?.cancel()
        loadOperation = nil
        submitOperation?.cancel()
        submitOperation = nil
        if loadState == .loading { loadState = reports.isEmpty ? .idle : .loaded }
        if submitState == .loading { submitState = .idle }
        isLoadingPage = false
    }

    func resetForSessionReplacement() {
        cancelRemoteOperations()
        generation &+= 1
        reports = []
        loadState = .idle
        canLoadMore = false
        nextCursor = nil
        paginationError = nil
        submitState = .idle
        submitError = nil
        lastSubmittedReport = nil
        submissionRetry = nil
    }

    // MARK: Submission

    private func performSubmission(
        _ command: SafetyReportSubmission,
        submitter: @escaping @Sendable (SafetyReportSubmission) async throws -> SafetyReportSummary
    ) async -> Bool {
        guard submitState != .loading else { return false }
        let operationGeneration = generation
        submissionRetry = command
        submitState = .loading
        submitError = nil
        let operation = Task { try await submitter(command) }
        submitOperation?.cancel()
        submitOperation = operation
        do {
            let summary = try await operation.value
            guard generation == operationGeneration, !operation.isCancelled, !Task.isCancelled else {
                return false
            }
            guard summary.subjectAccountID == command.subjectAccountID,
                  summary.category == command.category,
                  summary.evidenceCount == command.evidenceMessageIDs.count,
                  summary.alsoBlocked == command.alsoBlock
            else { throw LuxoraAPIError.invalidResponse }
            submissionRetry = nil
            submitState = .loaded
            submitError = nil
            submitOperation = nil
            lastSubmittedReport = summary
            merge(summary)
            return true
        } catch is CancellationError {
            guard generation == operationGeneration else { return false }
            submitState = .idle
            submitOperation = nil
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            // A definite 4xx means the server rejected this exact command, so
            // replaying the same nonce cannot succeed; keep an unknown-outcome
            // transport/5xx/invalid-response retry available instead.
            if Self.isDefinitiveRejection(error) {
                submissionRetry = nil
            }
            let message = Self.russianMessage(for: error, context: .submit)
            submitState = .failed(message)
            submitError = message
            submitOperation = nil
            return false
        }
    }

    private func failSubmission(_ message: String) {
        submitState = .failed(message)
        submitError = message
    }

    private func merge(_ summary: SafetyReportSummary) {
        if let index = reports.firstIndex(where: { $0.id == summary.id }) {
            reports[index] = summary
        } else {
            reports.insert(summary, at: 0)
        }
        reports = Self.sorted(reports)
    }

    // MARK: Paging

    private func loadPage(cursor: String?, replacement: Bool, force: Bool) async {
        guard let remotePageLoader else {
            loadState = .failed("Загрузка жалоб не подключена.")
            return
        }
        if replacement {
            guard force || loadState != .loading else { return }
        } else {
            guard !isLoadingPage else { return }
        }
        let operationGeneration = generation
        let operation = Task { try await remotePageLoader(pageSize, cursor) }
        loadOperation?.cancel()
        loadOperation = operation
        if replacement {
            loadState = .loading
        } else {
            isLoadingPage = true
        }
        paginationError = nil
        do {
            let page = try await operation.value
            guard generation == operationGeneration, !operation.isCancelled, !Task.isCancelled else {
                return
            }
            if let cursor, page.nextCursor == cursor {
                throw LuxoraAPIError.invalidResponse
            }
            let existingIDs = Set(reports.map(\.id))
            guard page.items.allSatisfy({ !existingIDs.contains($0.id) })
                || replacement
            else { throw LuxoraAPIError.invalidResponse }
            if replacement {
                reports = Self.sorted(page.items)
                nextCursor = page.nextCursor
            } else {
                reports = Self.sorted(reports + page.items)
                nextCursor = page.nextCursor
            }
            canLoadMore = page.nextCursor != nil
            loadState = .loaded
            isLoadingPage = false
            loadOperation = nil
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            if replacement {
                loadState = reports.isEmpty ? .idle : .loaded
            }
            isLoadingPage = false
            loadOperation = nil
        } catch {
            guard generation == operationGeneration else { return }
            let message = Self.russianMessage(for: error, context: .load)
            if replacement {
                loadState = .failed(message)
            } else {
                paginationError = message
            }
            isLoadingPage = false
            loadOperation = nil
        }
    }

    // MARK: Validation

    private enum SafetyReportValidationError: Error {
        case commentTooLong
        case tooMuchEvidence
        case duplicateEvidence
        case missingEvidence

        var russianMessage: String {
            switch self {
            case .commentTooLong:
                "Комментарий — не более 2 000 символов."
            case .tooMuchEvidence:
                "В жалобу можно приложить не более 20 сообщений."
            case .duplicateEvidence:
                "Одно и то же сообщение приложено несколько раз."
            case .missingEvidence:
                "Для этой категории нужно выбрать хотя бы одно сообщение."
            }
        }
    }

    private static func validatedComment(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.unicodeScalars.count <= SafetyReportLimits.maxCommentCodePoints else {
            throw SafetyReportValidationError.commentTooLong
        }
        return trimmed
    }

    private static func validateEvidence(
        _ evidence: [UUID],
        category: SafetyReportCategory
    ) throws {
        guard evidence.count <= SafetyReportLimits.maxEvidence else {
            throw SafetyReportValidationError.tooMuchEvidence
        }
        guard Set(evidence).count == evidence.count else {
            throw SafetyReportValidationError.duplicateEvidence
        }
        if category.requiresMessageEvidence, evidence.isEmpty {
            throw SafetyReportValidationError.missingEvidence
        }
    }

    // MARK: Mapping

    private enum ErrorContext {
        case submit
        case load
    }

    private static func isDefinitiveRejection(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return 400..<500 ~= status
    }

    private static func russianMessage(for error: Error, context: ErrorContext) -> String {
        if error is CancellationError { return "Запрос отменён." }
        guard let apiError = error as? LuxoraAPIError else {
            return "Нет связи с сервером. Проверьте сеть и повторите."
        }
        switch apiError {
        case .invalidResponse:
            return "Сервер вернул несогласованные данные. Повторите запрос."
        case .transport:
            return context == .submit
                ? "Нет связи с сервером. Проверьте сеть и повторите — повтор безопасен."
                : "Нет связи с сервером. Проверьте сеть и повторите."
        case .incompatibleServer:
            return "Сервер Luxora не поддерживает жалобы в этой версии."
        case .missingSession:
            return "Сеанс недоступен. Войдите снова."
        case .syncUnstable:
            return "Состояние менялось во время запроса. Повторите."
        case let .server(status, code, _):
            return serverMessage(status: status, code: code, context: context)
        }
    }

    private static func serverMessage(
        status: Int,
        code: String?,
        context: ErrorContext
    ) -> String {
        if status == 401 { return "Сеанс истёк. Войдите снова." }
        if status == 429 {
            return "Слишком много жалоб. Подождите и повторите позже."
        }
        switch context {
        case .submit:
            if status == 403 { return "Сервер запретил отправить жалобу на этот аккаунт." }
            if status == 404 {
                return "Выбранные сообщения больше недоступны — возможно, они удалены. Обновите чат и выберите другие."
            }
            if status == 409 { return "Сервер отклонил жалобу как повторную. Обновите список." }
            if status == 400 || code == "VALIDATION_FAILED" {
                return "Сервер отклонил параметры жалобы. Проверьте категорию, сообщения и комментарий."
            }
        case .load:
            if status == 403 { return "Сервер не разрешил просмотреть ваши жалобы." }
        }
        return "Сервер не выполнил запрос (код \(status))."
    }

    private static func sorted(_ items: [SafetyReportSummary]) -> [SafetyReportSummary] {
        items.sorted { lhs, rhs in
            if lhs.submittedAt != rhs.submittedAt { return lhs.submittedAt > rhs.submittedAt }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }
}
