import Foundation
import Observation

struct ChatFoldersSessionBinding: Hashable, Sendable {
    let accountID: UUID
    fileprivate let nonce: UUID
}

public enum ChatFolderMutationKind: String, Sendable {
    case create
    case update
    case delete
    case reorder

    public var russianTitle: String {
        switch self {
        case .create: "Создание папки"
        case .update: "Сохранение папки"
        case .delete: "Удаление папки"
        case .reorder: "Изменение порядка"
        }
    }
}

public struct ChatFolderMutationFailure: Equatable, Sendable {
    public let kind: ChatFolderMutationKind
    public let detail: String
    public let supportsExactRetry: Bool
    public let requiresReviewAfterRefresh: Bool
}

@MainActor
@Observable
public final class ChatFoldersStore {
    public private(set) var folders: [ChatFolder] = []
    public private(set) var stateRevision = 0
    public private(set) var loadState: RemoteContentState = .idle
    public private(set) var mutationState: RemoteContentState = .idle
    public private(set) var mutationFailure: ChatFolderMutationFailure?
    public private(set) var isRealtimeStale = false
    public var selectedFolderID: UUID?
    public private(set) var isArchiveSelected = false

    typealias Loader = @Sendable () async throws -> ChatFolderListSnapshot
    typealias Creator = @Sendable (ChatFolderCreateCommand) async throws -> ChatFolderMutationReceipt
    typealias Updater = @Sendable (UUID, ChatFolderPatchCommand) async throws -> ChatFolderMutationReceipt
    typealias Deleter = @Sendable (UUID, ChatFolderDeleteCommand) async throws -> ChatFolderDeleteReceipt
    typealias Reorderer = @Sendable (ChatFolderReorderCommand) async throws -> ChatFolderReorderReceipt

    @ObservationIgnored private var remoteLoader: Loader?
    @ObservationIgnored private var remoteCreator: Creator?
    @ObservationIgnored private var remoteUpdater: Updater?
    @ObservationIgnored private var remoteDeleter: Deleter?
    @ObservationIgnored private var remoteReorderer: Reorderer?
    @ObservationIgnored private var sessionBinding: ChatFoldersSessionBinding?
    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var loadAttempt: UInt = 0
    @ObservationIgnored private var mutationAttempt: UInt = 0
    @ObservationIgnored private var loadOperation: Task<ChatFolderListSnapshot, Error>?
    @ObservationIgnored private var mutationOperation: Task<Void, Never>?
    @ObservationIgnored private var pendingMutation: PendingMutation?
    @ObservationIgnored private var conflictAwaitingRefresh = false
    @ObservationIgnored private var lastRealtimeSequence: Int?

    public init(snapshot: ChatFolderListSnapshot? = nil) {
        if let snapshot, let validated = try? snapshot.validated() {
            folders = validated.folders
            stateRevision = validated.stateRevision
            loadState = .loaded
        }
    }

    public var selectedFolder: ChatFolder? {
        selectedFolderID.flatMap { folder(id: $0) }
    }

    public func folder(id: UUID) -> ChatFolder? {
        folders.first(where: { $0.id == id })
    }

    public func select(_ folderID: UUID?) {
        if let folderID, folder(id: folderID) == nil { return }
        isArchiveSelected = false
        selectedFolderID = folderID
    }

    public func selectArchive() {
        selectedFolderID = nil
        isArchiveSelected = true
    }

    public func visibleConversations(from conversations: [Conversation]) -> [Conversation] {
        if isArchiveSelected {
            return conversations
                .filter(\.isArchived)
                .sorted { $0.lastActivity > $1.lastActivity }
        }
        if let selectedFolder {
            return selectedFolder.projectedConversations(conversations)
        }
        return conversations
            .filter { !$0.isArchived }
            .sorted { lhs, rhs in
                if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
                return lhs.lastActivity > rhs.lastActivity
            }
    }

    @discardableResult
    func configureRemote(
        accountID: UUID,
        loader: @escaping Loader,
        creator: @escaping Creator,
        updater: @escaping Updater,
        deleter: @escaping Deleter,
        reorderer: @escaping Reorderer
    ) -> ChatFoldersSessionBinding {
        resetForSessionReplacement()
        let binding = ChatFoldersSessionBinding(accountID: accountID, nonce: UUID())
        sessionBinding = binding
        remoteLoader = loader
        remoteCreator = creator
        remoteUpdater = updater
        remoteDeleter = deleter
        remoteReorderer = reorderer
        return binding
    }

    func replaceConfirmed(
        _ snapshot: ChatFolderListSnapshot,
        binding: ChatFoldersSessionBinding? = nil
    ) throws {
        try validateReplacement(snapshot, binding: binding)
        guard sessionBinding != nil else { return }
        let validated = try snapshot.validated()
        guard validated.stateRevision >= stateRevision else {
            // A replay receipt or a raced snapshot may be historical. It can
            // confirm the command, but it must never roll account state back.
            return
        }
        generation &+= 1
        loadOperation?.cancel()
        mutationOperation?.cancel()
        loadOperation = nil
        mutationOperation = nil
        folders = validated.folders
        stateRevision = validated.stateRevision
        loadState = .loaded
        settleInterruptedMutationAfterAuthoritativeRefresh()
        isRealtimeStale = false
        if let selectedFolderID, folder(id: selectedFolderID) == nil {
            self.selectedFolderID = nil
        }
    }

    func validateReplacement(
        _ snapshot: ChatFolderListSnapshot,
        binding: ChatFoldersSessionBinding? = nil
    ) throws {
        if let binding, sessionBinding != binding { throw CancellationError() }
        _ = try snapshot.validated()
    }

    @discardableResult
    public func refresh(force: Bool = false) async -> Bool {
        await refresh(force: force, minimumStateRevision: nil, interruptsMutation: false)
    }

    @discardableResult
    func refreshForRealtime(minimumStateRevision: Int) async -> Bool {
        await refresh(
            force: true,
            minimumStateRevision: minimumStateRevision,
            interruptsMutation: true
        )
    }

    public func create(_ draft: ChatFolderDraft) {
        guard folders.count < ChatFolderContract.maximumFolders else {
            mutationFailure = ChatFolderMutationFailure(
                kind: .create,
                detail: "Можно создать не больше \(ChatFolderContract.maximumFolders) папок.",
                supportsExactRetry: false,
                requiresReviewAfterRefresh: false
            )
            mutationState = .failed(mutationFailure!.detail)
            return
        }
        do {
            let draft = try draft.validated()
            execute(.create(
                draft: draft,
                command: ChatFolderCreateCommand(draft: draft, clientNonce: .clientNonceV4()),
                issuedAt: Date()
            ))
        } catch {
            publishLocalValidationFailure(kind: .create)
        }
    }

    public func update(
        folderID: UUID,
        draft: ChatFolderDraft,
        expectedRevision: Int
    ) {
        guard folder(id: folderID) != nil, expectedRevision > 0 else {
            publishMissingFolderFailure(kind: .update)
            return
        }
        do {
            let draft = try draft.validated()
            execute(.update(
                folderID: folderID,
                draft: draft,
                command: ChatFolderPatchCommand(
                    title: draft.title,
                    rules: draft.rules,
                    overrides: draft.overrides,
                    expectedRevision: expectedRevision,
                    clientNonce: .clientNonceV4()
                ),
                issuedAt: Date()
            ))
        } catch {
            publishLocalValidationFailure(kind: .update)
        }
    }

    public func delete(folderID: UUID, expectedRevision: Int) {
        guard folder(id: folderID) != nil, expectedRevision > 0 else {
            publishMissingFolderFailure(kind: .delete)
            return
        }
        execute(.delete(
            folderID: folderID,
            command: ChatFolderDeleteCommand(
                expectedRevision: expectedRevision,
                clientNonce: .clientNonceV4()
            ),
            issuedAt: Date()
        ))
    }

    public func reorder(folderIDs: [UUID]) {
        guard folderIDs.map({ $0 }) != folders.map(\.id),
              folderIDs.count == folders.count,
              Set(folderIDs) == Set(folders.map(\.id)),
              !folderIDs.isEmpty
        else { return }
        execute(.reorder(
            desiredIDs: folderIDs,
            command: ChatFolderReorderCommand(
                folderIDs: folderIDs,
                expectedStateRevision: stateRevision,
                clientNonce: .clientNonceV4()
            ),
            issuedAt: Date()
        ))
    }

    public func retryLastMutation() {
        guard let pendingMutation,
              mutationFailure?.supportsExactRetry == true
                || mutationFailure?.requiresReviewAfterRefresh == true
        else { return }
        let age = Date().timeIntervalSince(pendingMutation.issuedAt)
        if mutationFailure?.requiresReviewAfterRefresh == true {
            mutationFailure = ChatFolderMutationFailure(
                kind: pendingMutation.kind,
                detail: "Папки изменились. Закройте редактор и повторите действие вручную по актуальной версии.",
                supportsExactRetry: false,
                requiresReviewAfterRefresh: false
            )
            self.pendingMutation = nil
            mutationState = .failed(mutationFailure!.detail)
        } else if age <= TimeInterval(ChatFolderContract.idempotencyTTLSeconds) {
            execute(pendingMutation)
        } else {
            mutationFailure = ChatFolderMutationFailure(
                kind: pendingMutation.kind,
                detail: "Окно точного повтора истекло. Обновите папки и повторите действие.",
                supportsExactRetry: false,
                requiresReviewAfterRefresh: true
            )
            mutationState = .failed(mutationFailure!.detail)
        }
    }

    public func dismissMutationFailure() {
        mutationFailure = nil
        pendingMutation = nil
        if case .failed = mutationState { mutationState = .idle }
    }

    @discardableResult
    func applyRealtime(
        _ dispatch: ChatFoldersRealtimeDispatch,
        binding: ChatFoldersSessionBinding
    ) -> Bool {
        guard sessionBinding == binding,
              dispatch.accountID == binding.accountID,
              dispatch.sequence > (lastRealtimeSequence ?? 0),
              dispatch.stateRevision >= 0
        else { return false }

        guard dispatch.stateRevision > stateRevision else { return false }

        generation &+= 1
        mutationOperation?.cancel()
        mutationOperation = nil
        loadOperation?.cancel()
        loadOperation = nil
        isRealtimeStale = true
        loadState = .loading
        return true
    }

    /// Advances the store-local watermark only after the opaque V2 cursor has
    /// been durably committed. Until then an exact reconnect replay must stay
    /// eligible to retry a failed authoritative refresh.
    func commitRealtime(
        _ dispatch: ChatFoldersRealtimeDispatch,
        binding: ChatFoldersSessionBinding
    ) throws {
        guard sessionBinding == binding,
              dispatch.accountID == binding.accountID,
              dispatch.sequence > (lastRealtimeSequence ?? 0),
              dispatch.stateRevision <= stateRevision
        else { throw LuxoraAPIError.invalidResponse }
        lastRealtimeSequence = dispatch.sequence
    }

    func cancelRemoteOperations() {
        generation &+= 1
        loadOperation?.cancel()
        mutationOperation?.cancel()
        loadOperation = nil
        mutationOperation = nil
        if loadState == .loading { loadState = folders.isEmpty ? .idle : .loaded }
        if mutationState == .loading { mutationState = .idle }
    }

    func resetForSessionReplacement() {
        cancelRemoteOperations()
        folders.removeAll()
        stateRevision = 0
        selectedFolderID = nil
        isArchiveSelected = false
        loadState = .idle
        mutationState = .idle
        mutationFailure = nil
        isRealtimeStale = false
        pendingMutation = nil
        conflictAwaitingRefresh = false
        lastRealtimeSequence = nil
        sessionBinding = nil
        remoteLoader = nil
        remoteCreator = nil
        remoteUpdater = nil
        remoteDeleter = nil
        remoteReorderer = nil
    }

    private func refresh(
        force: Bool,
        minimumStateRevision: Int?,
        interruptsMutation: Bool
    ) async -> Bool {
        guard let remoteLoader else {
            loadState = .failed("Синхронизация папок с сервером не подключена.")
            return false
        }
        guard force || loadState != .loading else { return false }

        let operationGeneration = generation
        loadAttempt &+= 1
        let attempt = loadAttempt
        let operation = Task { try await remoteLoader() }
        loadOperation?.cancel()
        loadOperation = operation
        loadState = .loading
        do {
            let snapshot = try await operation.value.validated()
            guard generation == operationGeneration,
                  loadAttempt == attempt,
                  !operation.isCancelled
            else { return false }
            if let minimumStateRevision, snapshot.stateRevision < minimumStateRevision {
                throw LuxoraAPIError.invalidResponse
            }
            guard snapshot.stateRevision >= stateRevision else {
                throw LuxoraAPIError.invalidResponse
            }
            folders = snapshot.folders
            stateRevision = snapshot.stateRevision
            loadState = .loaded
            loadOperation = nil
            isRealtimeStale = false
            if let selectedFolderID, folder(id: selectedFolderID) == nil {
                self.selectedFolderID = nil
            }
            if interruptsMutation {
                mutationOperation?.cancel()
                mutationOperation = nil
                settleInterruptedMutationAfterAuthoritativeRefresh()
            } else if conflictAwaitingRefresh, let pendingMutation {
                mutationFailure = ChatFolderMutationFailure(
                    kind: pendingMutation.kind,
                    detail: "Актуальный список загружен. Закройте редактор, снова откройте папку и примените нужные изменения к новой версии.",
                    supportsExactRetry: false,
                    requiresReviewAfterRefresh: false
                )
                mutationState = .failed(mutationFailure!.detail)
                self.pendingMutation = nil
                conflictAwaitingRefresh = false
            }
            return true
        } catch is CancellationError {
            settleCancelledLoad(generation: operationGeneration, attempt: attempt)
            return false
        } catch {
            guard generation == operationGeneration, loadAttempt == attempt else { return false }
            loadState = .failed(Self.russianMessage(for: error))
            loadOperation = nil
            return false
        }
    }

    private func execute(_ mutation: PendingMutation) {
        guard mutationState != .loading else { return }
        guard remoteCreator != nil, remoteUpdater != nil, remoteDeleter != nil,
              remoteReorderer != nil, remoteLoader != nil
        else {
            mutationFailure = ChatFolderMutationFailure(
                kind: mutation.kind,
                detail: "Серверные папки не подключены.",
                supportsExactRetry: false,
                requiresReviewAfterRefresh: false
            )
            mutationState = .failed(mutationFailure!.detail)
            return
        }

        pendingMutation = mutation
        mutationFailure = nil
        mutationState = .loading
        mutationAttempt &+= 1
        let attempt = mutationAttempt
        let operationGeneration = generation
        mutationOperation = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await perform(mutation, generation: operationGeneration, attempt: attempt)
            } catch is CancellationError {
                settleCancelledMutation(generation: operationGeneration, attempt: attempt)
            } catch {
                await settleMutationFailure(
                    error,
                    mutation: mutation,
                    generation: operationGeneration,
                    attempt: attempt
                )
            }
        }
    }

    private func perform(
        _ mutation: PendingMutation,
        generation operationGeneration: UInt,
        attempt: UInt
    ) async throws {
        switch mutation {
        case let .create(_, command, _):
            guard let remoteCreator else { throw LuxoraAPIError.missingSession }
            let receipt = try await remoteCreator(command)
            try accept(
                receipt,
                expectedMinimumStateRevision: stateRevision,
                generation: operationGeneration,
                attempt: attempt
            )

        case let .update(folderID, _, command, _):
            guard let remoteUpdater else { throw LuxoraAPIError.missingSession }
            let receipt = try await remoteUpdater(folderID, command)
            try accept(
                receipt,
                expectedMinimumStateRevision: stateRevision,
                generation: operationGeneration,
                attempt: attempt
            )

        case let .delete(folderID, _, _):
            guard let remoteDeleter, let remoteLoader else { throw LuxoraAPIError.missingSession }
            let command = mutation.deleteCommand!
            let receipt = try await remoteDeleter(folderID, command)
            // Delete compacts remaining positions and can bump every shifted
            // folder revision. The delete receipt intentionally omits them.
            let snapshot = try await remoteLoader().validated()
            guard snapshot.stateRevision >= max(stateRevision, receipt.stateRevision),
                  !snapshot.folders.contains(where: { $0.id == receipt.folderID })
            else { throw LuxoraAPIError.invalidResponse }
            try publish(snapshot, generation: operationGeneration, attempt: attempt)

        case let .reorder(_, command, _):
            guard let remoteReorderer else { throw LuxoraAPIError.missingSession }
            let receipt = try await remoteReorderer(command)
            let snapshot = try ChatFolderListSnapshot(
                folders: receipt.folders,
                stateRevision: receipt.stateRevision
            ).validated()
            try publish(snapshot, generation: operationGeneration, attempt: attempt)
        }

        guard generation == operationGeneration, mutationAttempt == attempt else {
            throw CancellationError()
        }
        pendingMutation = nil
        mutationFailure = nil
        mutationState = .loaded
        mutationOperation = nil
    }

    private func accept(
        _ receipt: ChatFolderMutationReceipt,
        expectedMinimumStateRevision: Int,
        generation operationGeneration: UInt,
        attempt: UInt
    ) throws {
        guard generation == operationGeneration, mutationAttempt == attempt else {
            throw CancellationError()
        }
        guard receipt.stateRevision >= expectedMinimumStateRevision else {
            // Historical replay: it confirms receipt identity but cannot be
            // allowed to overwrite a newer local projection.
            return
        }
        var next = folders
        if let index = next.firstIndex(where: { $0.id == receipt.folder.id }) {
            guard receipt.folder.revision >= next[index].revision else { return }
            next[index] = receipt.folder
        } else {
            next.append(receipt.folder)
        }
        let snapshot = ChatFolderListSnapshot(
            folders: next.sorted { $0.position < $1.position },
            stateRevision: receipt.stateRevision
        )
        _ = try snapshot.validated()
        folders = snapshot.folders
        stateRevision = snapshot.stateRevision
        loadState = .loaded
    }

    private func publish(
        _ snapshot: ChatFolderListSnapshot,
        generation operationGeneration: UInt,
        attempt: UInt
    ) throws {
        guard generation == operationGeneration, mutationAttempt == attempt else {
            throw CancellationError()
        }
        guard snapshot.stateRevision >= stateRevision else { return }
        folders = snapshot.folders
        stateRevision = snapshot.stateRevision
        loadState = .loaded
        if let selectedFolderID, folder(id: selectedFolderID) == nil {
            self.selectedFolderID = nil
        }
    }

    private func settleMutationFailure(
        _ error: Error,
        mutation: PendingMutation,
        generation operationGeneration: UInt,
        attempt: UInt
    ) async {
        guard generation == operationGeneration, mutationAttempt == attempt else { return }
        if Self.isUnauthorized(error) {
            folders.removeAll()
            selectedFolderID = nil
        }

        let conflict = Self.isConflict(error)
        var conflictRefreshSucceeded = false
        if conflict {
            conflictRefreshSucceeded = await refresh(
                force: true,
                minimumStateRevision: nil,
                interruptsMutation: false
            )
            guard generation == operationGeneration, mutationAttempt == attempt else { return }
        }
        let detail: String
        if conflict, conflictRefreshSucceeded {
            detail = "Папки изменились на другом устройстве. Список обновлён; закройте редактор и примените правку заново к актуальной версии."
        } else if conflict {
            detail = "Папки изменились на другом устройстве, но актуальный список загрузить не удалось. Обновите экран перед повтором."
        } else {
            detail = Self.russianMessage(for: error)
        }
        let exactRetry = !conflict
            && Date().timeIntervalSince(mutation.issuedAt)
                <= TimeInterval(ChatFolderContract.idempotencyTTLSeconds)
        mutationFailure = ChatFolderMutationFailure(
            kind: mutation.kind,
            detail: detail,
            supportsExactRetry: exactRetry,
            requiresReviewAfterRefresh: false
        )
        conflictAwaitingRefresh = conflict && !conflictRefreshSucceeded
        if conflictRefreshSucceeded {
            pendingMutation = nil
        }
        mutationState = .failed(detail)
        mutationOperation = nil
    }

    private func settleInterruptedMutationAfterAuthoritativeRefresh() {
        conflictAwaitingRefresh = false
        guard let pendingMutation else {
            mutationFailure = nil
            mutationState = .loaded
            return
        }
        let exactRetry = Date().timeIntervalSince(pendingMutation.issuedAt)
            <= TimeInterval(ChatFolderContract.idempotencyTTLSeconds)
        let detail = exactRetry
            ? "Список папок изменился во время команды. Сервер не сообщил, была ли она применена; безопасно повторите точно ту же команду."
            : "Список папок изменился во время команды, а окно точного повтора уже истекло. Проверьте актуальное состояние вручную."
        mutationFailure = ChatFolderMutationFailure(
            kind: pendingMutation.kind,
            detail: detail,
            supportsExactRetry: exactRetry,
            requiresReviewAfterRefresh: false
        )
        mutationState = .failed(detail)
    }

    private func settleCancelledLoad(generation operationGeneration: UInt, attempt: UInt) {
        guard generation == operationGeneration, loadAttempt == attempt else { return }
        loadState = folders.isEmpty ? .idle : .loaded
        loadOperation = nil
    }

    private func settleCancelledMutation(generation operationGeneration: UInt, attempt: UInt) {
        guard generation == operationGeneration, mutationAttempt == attempt else { return }
        mutationState = .idle
        mutationOperation = nil
    }

    private func publishLocalValidationFailure(kind: ChatFolderMutationKind) {
        let detail = "Проверьте название, правила и выбранные чаты. Название — не больше 48 символов."
        mutationFailure = ChatFolderMutationFailure(
            kind: kind,
            detail: detail,
            supportsExactRetry: false,
            requiresReviewAfterRefresh: false
        )
        mutationState = .failed(detail)
    }

    private func publishMissingFolderFailure(kind: ChatFolderMutationKind) {
        let detail = "Папка больше не найдена. Обновите список."
        mutationFailure = ChatFolderMutationFailure(
            kind: kind,
            detail: detail,
            supportsExactRetry: false,
            requiresReviewAfterRefresh: true
        )
        mutationState = .failed(detail)
    }

    private static func isUnauthorized(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return status == 401
    }

    private static func isConflict(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return status == 409
    }

    private static func russianMessage(for error: Error) -> String {
        if let rateLimit = error as? ChatFolderRateLimitError {
            return rateLimit.localizedDescription
        }
        guard case let LuxoraAPIError.server(status, _, _) = error else {
            if error is CancellationError { return "" }
            return "Нет связи с сервером. Можно безопасно повторить ту же команду."
        }
        switch status {
        case 400: return "Сервер отклонил правила папки или недоступный чат. Проверьте выбор."
        case 401: return "Сеанс истёк. Войдите снова."
        case 404: return "Папка больше не найдена."
        case 409: return "Папки изменились на другом устройстве. Обновите список."
        case 429: return "Слишком много изменений. Подождите и повторите ту же команду."
        default: return "Сервер не подтвердил изменение папки (код \(status))."
        }
    }
}

private enum PendingMutation: Equatable, Sendable {
    case create(draft: ChatFolderDraft, command: ChatFolderCreateCommand, issuedAt: Date)
    case update(
        folderID: UUID,
        draft: ChatFolderDraft,
        command: ChatFolderPatchCommand,
        issuedAt: Date
    )
    case delete(folderID: UUID, command: ChatFolderDeleteCommand, issuedAt: Date)
    case reorder(desiredIDs: [UUID], command: ChatFolderReorderCommand, issuedAt: Date)

    var kind: ChatFolderMutationKind {
        switch self {
        case .create: .create
        case .update: .update
        case .delete: .delete
        case .reorder: .reorder
        }
    }

    var issuedAt: Date {
        switch self {
        case let .create(_, _, issuedAt), let .update(_, _, _, issuedAt),
             let .delete(_, _, issuedAt), let .reorder(_, _, issuedAt): issuedAt
        }
    }

    var deleteCommand: ChatFolderDeleteCommand? {
        guard case let .delete(_, command, _) = self else { return nil }
        return command
    }
}
