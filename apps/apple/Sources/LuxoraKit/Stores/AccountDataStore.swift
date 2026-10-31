import CryptoKit
import Foundation
import Observation

/// Account data-export and account-deletion state.
///
/// The store only exposes server-confirmed state: an export is "ready" when a
/// record says so, the downloaded archive becomes shareable only after its
/// SHA-256 verified against that record, and a deletion is never described as
/// immediate — the server enforces a real seven-day grace window.
@MainActor
@Observable
public final class AccountDataStore {
    public private(set) var exportRecord: DataExportRecord?
    public private(set) var exportState: RemoteContentState = .idle
    public private(set) var exportError: String?
    public private(set) var exportPollAttempts = 0
    public private(set) var downloadState: RemoteContentState = .idle
    public private(set) var downloadError: String?
    public private(set) var downloadedExportFileURL: URL?
    public private(set) var downloadedExportBytes: Int?
    public private(set) var verifiedExportSHA256: String?

    public private(set) var deletion: AccountDeletionRecord?
    public private(set) var deletionState: RemoteContentState = .idle
    public private(set) var deletionError: String?
    public private(set) var deletionActionState: RemoteContentState = .idle
    public private(set) var deletionActionError: String?
    public private(set) var lastCanceledDeletion: AccountDeletionRecord?

    var remoteExportRequester: (@Sendable () async throws -> DataExportRecord)?
    var remoteExportStatusLoader: (@Sendable (UUID) async throws -> DataExportRecord)?
    var remoteExportDownloader: (@Sendable (UUID) async throws -> Data)?
    var remoteDeletionStatusLoader: (@Sendable () async throws -> AccountDeletionRecord)?
    var remoteDeletionScheduler: (@Sendable () async throws -> AccountDeletionRecord)?
    var remoteDeletionCanceller: (@Sendable () async throws -> AccountDeletionRecord)?
    var sleep: @Sendable () async throws -> Void = {
        try await Task.sleep(for: .seconds(2))
    }
    var now: @Sendable () -> Date = { Date() }
    var maxExportPollAttempts: Int = 15

    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var exportOperation: Task<DataExportRecord, Error>?
    @ObservationIgnored private var downloadOperation: Task<Data, Error>?
    @ObservationIgnored private var deletionOperation: Task<AccountDeletionRecord, Error>?

    public init() {}

    func configureRemote(
        exportRequester: @escaping @Sendable () async throws -> DataExportRecord,
        exportStatusLoader: @escaping @Sendable (UUID) async throws -> DataExportRecord,
        exportDownloader: @escaping @Sendable (UUID) async throws -> Data,
        deletionStatusLoader: @escaping @Sendable () async throws -> AccountDeletionRecord,
        deletionScheduler: @escaping @Sendable () async throws -> AccountDeletionRecord,
        deletionCanceller: @escaping @Sendable () async throws -> AccountDeletionRecord
    ) {
        remoteExportRequester = exportRequester
        remoteExportStatusLoader = exportStatusLoader
        remoteExportDownloader = exportDownloader
        remoteDeletionStatusLoader = deletionStatusLoader
        remoteDeletionScheduler = deletionScheduler
        remoteDeletionCanceller = deletionCanceller
    }

    // MARK: Derived state

    public var exportIsPending: Bool { exportRecord?.state == .pending }
    public var exportIsReady: Bool { exportRecord?.state == .ready }
    public var exportIsExpired: Bool { exportRecord?.state == .expired }
    public var canRetryExportCheck: Bool {
        exportState != .loading && (exportIsPending || exportState.isFailure)
    }
    public var isDeletionScheduled: Bool { deletion?.state == .scheduled }
    public var isDeletionActionInFlight: Bool { deletionActionState == .loading }

    public func canCancelDeletion() -> Bool {
        guard let record = deletion, record.state == .scheduled else { return false }
        guard let deadline = record.graceDeadlineAt else { return false }
        return now() < deadline
    }

    // MARK: Data export

    /// Requests an export (idempotent server-side) and, if the record is still
    /// pending, polls its status a bounded number of times.
    public func requestExport() async {
        guard let remoteExportRequester else {
            failExport("Запрос экспорта не подключен.")
            return
        }
        guard exportState != .loading else { return }
        let operationGeneration = generation
        exportState = .loading
        exportError = nil
        exportPollAttempts = 0
        let operation = Task { try await remoteExportRequester() }
        exportOperation?.cancel()
        exportOperation = operation
        do {
            let record = try await operation.value
            guard generation == operationGeneration,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return }
            exportOperation = nil
            acceptExportRecord(record)
            if record.state == .pending {
                await pollExport(
                    requestedID: record.id,
                    operationGeneration: operationGeneration
                )
                // A cancelled poll (view dismissed, session reset) may leave
                // the loading state behind; settle it against confirmed state.
                if exportState == .loading {
                    exportState = exportRecord == nil ? .idle : .loaded
                }
            } else {
                exportState = .loaded
            }
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            exportOperation = nil
            exportState = exportRecord == nil ? .idle : .loaded
        } catch {
            guard generation == operationGeneration else { return }
            exportOperation = nil
            failExport(Self.russianMessage(for: error, context: .exportRequest))
        }
    }

    /// Re-reads the current export status without rebuilding an archive.
    public func refreshExportStatus() async {
        guard let record = exportRecord, let remoteExportStatusLoader else { return }
        guard exportState != .loading else { return }
        let operationGeneration = generation
        exportState = .loading
        exportError = nil
        do {
            let updated = try await remoteExportStatusLoader(record.id)
            guard generation == operationGeneration, !Task.isCancelled else { return }
            guard updated.id == record.id else { throw LuxoraAPIError.invalidResponse }
            acceptExportRecord(updated)
            exportState = .loaded
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            exportState = exportRecord == nil ? .idle : .loaded
        } catch {
            guard generation == operationGeneration else { return }
            failExport(Self.russianMessage(for: error, context: .exportPoll))
        }
    }

    /// Downloads the ready archive, verifies its size and SHA-256 against the
    /// server record, then writes it to a temporary file suitable for sharing.
    public func downloadExport() async {
        guard let record = exportRecord else {
            failDownload("Сначала запросите экспорт.")
            return
        }
        guard record.state == .ready else {
            failDownload(
                record.state == .expired
                    ? "Экспорт истёк — запросите новый архив."
                    : "Экспорт ещё не готов."
            )
            return
        }
        guard let expectedSHA = record.sha256, let expectedSize = record.sizeBytes else {
            failDownload("Сервер не сообщил размер и контрольную сумму архива. Запросите экспорт заново.")
            return
        }
        guard let remoteExportDownloader else {
            failDownload("Скачивание архива не подключено.")
            return
        }
        guard downloadState != .loading else { return }
        let operationGeneration = generation
        downloadState = .loading
        downloadError = nil
        removeDownloadedExportFile()
        let operation = Task { try await remoteExportDownloader(record.id) }
        downloadOperation?.cancel()
        downloadOperation = operation
        do {
            let data = try await operation.value
            guard generation == operationGeneration,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return }
            downloadOperation = nil
            guard data.count == expectedSize else {
                failDownload("Размер архива не совпал с заявленным сервером. Архив не сохранён.")
                return
            }
            let actualSHA = Self.sha256Hex(data)
            guard actualSHA.caseInsensitiveCompare(expectedSHA) == .orderedSame else {
                failDownload("Контрольная сумма архива не совпала. Архив не сохранён.")
                return
            }
            do {
                let fileURL = try Self.writeTemporaryExport(data, exportID: record.id)
                downloadedExportFileURL = fileURL
                downloadedExportBytes = data.count
                verifiedExportSHA256 = actualSHA
                downloadState = .loaded
            } catch {
                failDownload("Не удалось сохранить архив на устройстве. Повторите.")
            }
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            downloadOperation = nil
            downloadState = .idle
        } catch {
            guard generation == operationGeneration else { return }
            downloadOperation = nil
            failDownload(Self.russianMessage(for: error, context: .exportDownload))
        }
    }

    public func clearDownloadedExport() {
        guard downloadState != .loading else { return }
        removeDownloadedExportFile()
        downloadState = .idle
        downloadError = nil
    }

    public func clearExportError() {
        guard exportState != .loading else { return }
        exportState = exportRecord == nil ? .idle : .loaded
        exportError = nil
    }

    public func clearDownloadError() {
        guard downloadState != .loading else { return }
        downloadState = .idle
        downloadError = nil
    }

    // MARK: Account deletion

    public func loadDeletionStatus(force: Bool = false) async {
        guard let remoteDeletionStatusLoader else {
            deletionState = .failed("Загрузка состояния удаления не подключена.")
            return
        }
        guard force || deletionState != .loading else { return }
        let operationGeneration = generation
        deletionState = .loading
        deletionError = nil
        let operation = Task { try await remoteDeletionStatusLoader() }
        deletionOperation?.cancel()
        deletionOperation = operation
        do {
            let record = try await operation.value
            guard generation == operationGeneration,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return }
            deletionOperation = nil
            deletion = record
            deletionState = .loaded
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            deletionOperation = nil
            deletionState = deletion == nil ? .idle : .loaded
        } catch {
            guard generation == operationGeneration else { return }
            deletionOperation = nil
            let message = Self.russianMessage(for: error, context: .deletionLoad)
            deletionState = .failed(message)
            deletionError = message
        }
    }

    /// Schedules the seven-day deletion grace window. The server reuses an
    /// existing scheduled record, so a repeated tap is safe.
    @discardableResult
    public func scheduleDeletion() async -> Bool {
        guard let remoteDeletionScheduler else {
            failDeletionAction("Планирование удаления не подключено.")
            return false
        }
        guard deletionActionState != .loading else { return false }
        if let record = deletion {
            switch record.state {
            case .scheduled, .deletionPending, .executing, .completed:
                failDeletionAction("Удаление уже запланировано или выполняется.")
                return false
            case .none, .failedRetryable:
                break
            }
        }
        let operationGeneration = generation
        deletionActionState = .loading
        deletionActionError = nil
        let operation = Task { try await remoteDeletionScheduler() }
        deletionOperation?.cancel()
        deletionOperation = operation
        do {
            let record = try await operation.value
            guard generation == operationGeneration,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return false }
            deletionOperation = nil
            guard record.state == .scheduled || record.state == .deletionPending else {
                throw LuxoraAPIError.invalidResponse
            }
            deletion = record
            deletionState = .loaded
            deletionError = nil
            deletionActionState = .loaded
            lastCanceledDeletion = nil
            return true
        } catch is CancellationError {
            guard generation == operationGeneration else { return false }
            deletionOperation = nil
            deletionActionState = .idle
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            deletionOperation = nil
            failDeletionAction(Self.russianMessage(for: error, context: .deletionSchedule))
            return false
        }
    }

    /// Cancels a scheduled deletion while the seven-day grace window is open.
    @discardableResult
    public func cancelDeletion() async -> Bool {
        guard let record = deletion else {
            failDeletionAction("Запланированного удаления нет.")
            return false
        }
        guard record.state == .scheduled else {
            failDeletionAction(Self.nonCancellableDeletionMessage(for: record.state))
            return false
        }
        if let deadline = record.graceDeadlineAt, now() >= deadline {
            failDeletionAction("Срок отмены истёк: сервер уже выполняет удаление.")
            return false
        }
        guard let remoteDeletionCanceller else {
            failDeletionAction("Отмена удаления не подключена.")
            return false
        }
        guard deletionActionState != .loading else { return false }
        let operationGeneration = generation
        deletionActionState = .loading
        deletionActionError = nil
        let operation = Task { try await remoteDeletionCanceller() }
        deletionOperation?.cancel()
        deletionOperation = operation
        do {
            let updated = try await operation.value
            guard generation == operationGeneration,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return false }
            deletionOperation = nil
            guard updated.accountID == record.accountID, updated.state == .none else {
                throw LuxoraAPIError.invalidResponse
            }
            deletion = updated
            deletionState = .loaded
            deletionError = nil
            deletionActionState = .loaded
            lastCanceledDeletion = updated
            return true
        } catch is CancellationError {
            guard generation == operationGeneration else { return false }
            deletionOperation = nil
            deletionActionState = .idle
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            deletionOperation = nil
            failDeletionAction(Self.russianMessage(for: error, context: .deletionCancel))
            return false
        }
    }

    public func clearDeletionActionError() {
        guard deletionActionState != .loading else { return }
        deletionActionState = .idle
        deletionActionError = nil
    }

    // MARK: Lifecycle

    func cancelRemoteOperations() {
        generation &+= 1
        exportOperation?.cancel()
        exportOperation = nil
        downloadOperation?.cancel()
        downloadOperation = nil
        deletionOperation?.cancel()
        deletionOperation = nil
        if exportState == .loading { exportState = exportRecord == nil ? .idle : .loaded }
        if downloadState == .loading { downloadState = .idle }
        if deletionState == .loading { deletionState = deletion == nil ? .idle : .loaded }
        if deletionActionState == .loading { deletionActionState = .idle }
    }

    func resetForSessionReplacement() {
        cancelRemoteOperations()
        generation &+= 1
        exportRecord = nil
        exportState = .idle
        exportError = nil
        exportPollAttempts = 0
        downloadState = .idle
        downloadError = nil
        removeDownloadedExportFile()
        downloadedExportBytes = nil
        verifiedExportSHA256 = nil
        deletion = nil
        deletionState = .idle
        deletionError = nil
        deletionActionState = .idle
        deletionActionError = nil
        lastCanceledDeletion = nil
    }

    // MARK: Internals

    private func acceptExportRecord(_ record: DataExportRecord) {
        if let existing = exportRecord, existing.id != record.id {
            clearDownloadedExport()
        }
        exportRecord = record
        exportError = nil
    }

    private func pollExport(requestedID: UUID, operationGeneration: UInt) async {
        var attempt = 0
        while exportRecord?.state == .pending {
            guard generation == operationGeneration, !Task.isCancelled else { return }
            guard attempt < maxExportPollAttempts else {
                failExport("Экспорт всё ещё собирается на сервере. Повторите проверку позже.")
                return
            }
            guard let remoteExportStatusLoader else {
                failExport("Проверка экспорта не подключена.")
                return
            }
            attempt += 1
            exportPollAttempts = attempt
            do {
                try await sleep()
            } catch is CancellationError {
                return
            } catch {
                return
            }
            guard generation == operationGeneration, !Task.isCancelled else { return }
            do {
                let updated = try await remoteExportStatusLoader(requestedID)
                guard generation == operationGeneration, !Task.isCancelled else { return }
                guard updated.id == requestedID else { throw LuxoraAPIError.invalidResponse }
                acceptExportRecord(updated)
            } catch is CancellationError {
                return
            } catch {
                guard generation == operationGeneration else { return }
                failExport(Self.russianMessage(for: error, context: .exportPoll))
                return
            }
        }
        exportState = .loaded
    }

    private func failExport(_ message: String) {
        exportState = .failed(message)
        exportError = message
    }

    private func failDownload(_ message: String) {
        downloadState = .failed(message)
        downloadError = message
    }

    private func failDeletionAction(_ message: String) {
        deletionActionState = .failed(message)
        deletionActionError = message
    }

    private func removeDownloadedExportFile() {
        if let fileURL = downloadedExportFileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        downloadedExportFileURL = nil
    }

    private static func writeTemporaryExport(_ data: Data, exportID: UUID) throws -> URL {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("luxora-account-exports", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory
            .appendingPathComponent("luxora-export-\(exportID.uuidString.lowercased()).tar.gz")
        if fileManager.fileExists(atPath: fileURL.path) {
            try? fileManager.removeItem(at: fileURL)
        }
        try data.write(to: fileURL, options: .atomic)
        return fileURL
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func nonCancellableDeletionMessage(for state: AccountDeletionState) -> String {
        switch state {
        case .none:
            "Запланированного удаления нет."
        case .scheduled:
            "Удаление уже запланировано."
        case .deletionPending, .executing:
            "Сервер уже выполняет удаление: отменить его нельзя."
        case .completed:
            "Удаление уже завершено."
        case .failedRetryable:
            "Удаление ждёт повторной попытки на сервере; отмена недоступна."
        }
    }

    // MARK: Mapping

    private enum ErrorContext {
        case exportRequest
        case exportPoll
        case exportDownload
        case deletionLoad
        case deletionSchedule
        case deletionCancel
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
            switch context {
            case .exportRequest, .deletionSchedule, .deletionCancel:
                return "Нет связи с сервером. Проверьте сеть и повторите — повтор безопасен."
            case .exportPoll, .exportDownload, .deletionLoad:
                return "Нет связи с сервером. Проверьте сеть и повторите."
            }
        case .incompatibleServer:
            return "Сервер Luxora не поддерживает экспорт и удаление аккаунта в этой версии."
        case .missingSession:
            return "Сеанс недоступен. Войдите снова."
        case .syncUnstable:
            return "Состояние менялось во время запроса. Повторите."
        case let .server(status, code, _):
            return serverMessage(status: status, code: code, context: context)
        }
    }

    private static func serverMessage(status: Int, code: String?, context: ErrorContext) -> String {
        if status == 401 { return "Сеанс истёк. Войдите снова." }
        if status == 429 {
            return "Слишком много запросов. Подождите и повторите позже."
        }
        switch context {
        case .exportRequest:
            if status == 403 { return "Сервер не разрешил запросить экспорт данных." }
            if status == 503 { return "Сервер не смог собрать архив. Повторите позже." }
        case .exportPoll:
            if status == 404 { return "Экспорт не найден на сервере. Запросите новый архив." }
        case .exportDownload:
            if status == 404 { return "Экспорт не найден на сервере. Запросите новый архив." }
            if status == 409 { return "Архив ещё не готов или уже истёк. Обновите состояние экспорта." }
            if status == 416 { return "Сервер отклонил диапазон скачивания. Повторите без указания диапазона." }
        case .deletionLoad:
            if status == 403 { return "Сервер не разрешил просмотреть состояние удаления." }
        case .deletionSchedule:
            if status == 409 { return "Удаление уже запланировано или выполняется на сервере." }
        case .deletionCancel:
            if status == 404 { return "Запланированного удаления не было." }
            if status == 409 { return "Сейчас удаление нельзя отменить: срок истёк или оно уже выполняется." }
        }
        if code == "VALIDATION_FAILED" {
            return "Сервер отклонил параметры запроса."
        }
        return "Сервер не выполнил запрос (код \(status))."
    }
}

private extension RemoteContentState {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}
