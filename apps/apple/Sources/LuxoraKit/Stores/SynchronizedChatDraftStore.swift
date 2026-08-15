import Foundation
import Observation

struct SynchronizedChatDraftSessionBinding: Hashable, Sendable {
    let accountID: UUID
    let sessionID: UUID
    fileprivate let nonce: UUID
}

enum ChatDraftRealtimeApplication: Equatable, Sendable {
    case accepted
    case exactReplay
    case causalNoOp
    case stale
    case rejected
}

struct SynchronizedChatDraftRecoveryPlan: Equatable, Sendable {
    let cleanInvalidatedChatIDs: Set<UUID>
    let dirtyPreservedChatIDs: Set<UUID>
    let lifecycleResetChatIDs: Set<UUID>
    let removedChatIDs: Set<UUID>
}

private struct ChatDraftMutationResolution: Sendable {
    let acknowledgement: ChatDraftMutationResult
    let authoritativeState: SynchronizedChatDraftState
}

actor ChatDraftMutationPacer {
    static let productionMinimumIntervalNanoseconds: UInt64 = 750_000_000

    typealias Now = @Sendable () async -> UInt64
    typealias Sleeper = @Sendable (UInt64) async throws -> Void

    private let minimumIntervalNanoseconds: UInt64
    private let now: Now
    private let sleep: Sleeper
    private var nextPermitNanoseconds: UInt64 = 0

    init(
        minimumIntervalNanoseconds: UInt64 = productionMinimumIntervalNanoseconds,
        now: @escaping Now = { DispatchTime.now().uptimeNanoseconds },
        sleep: @escaping Sleeper = { try await Task.sleep(nanoseconds: $0) }
    ) {
        self.minimumIntervalNanoseconds = minimumIntervalNanoseconds
        self.now = now
        self.sleep = sleep
    }

    func waitForPermit() async throws {
        while true {
            try Task.checkCancellation()
            let observedNow = await now()
            if observedNow >= nextPermitNanoseconds {
                nextPermitNanoseconds = observedNow
                    .addingReportingOverflow(minimumIntervalNanoseconds).overflow
                    ? UInt64.max
                    : observedNow + minimumIntervalNanoseconds
                return
            }
            // Do not reserve a future slot before sleeping. Cancelled queued
            // callers therefore leave no pacing holes; contenders re-check the
            // actor-owned deadline when they wake.
            try await sleep(nextPermitNanoseconds - observedNow)
        }
    }

    func deferFor(_ nanoseconds: UInt64) async {
        let observedNow = await now()
        let floor = observedNow.addingReportingOverflow(nanoseconds).overflow
            ? UInt64.max
            : observedNow + nanoseconds
        nextPermitNanoseconds = max(nextPermitNanoseconds, floor)
    }
}

@MainActor
@Observable
public final class SynchronizedChatDraftStore {
    public private(set) var confirmedStates: [UUID: SynchronizedChatDraftState] = [:]
    public private(set) var localDrafts: [UUID: SynchronizedChatDraftContent] = [:]
    public private(set) var dirtyChatIDs: Set<UUID> = []
    public private(set) var loadStates: [UUID: RemoteContentState] = [:]
    public private(set) var mutationStates: [UUID: RemoteContentState] = [:]

    typealias Loader = @Sendable (UUID) async throws -> SynchronizedChatDraftState
    typealias Putter = @Sendable (UUID, ChatDraftPutCommand) async throws -> ChatDraftMutationResult
    typealias Deleter = @Sendable (UUID, ChatDraftDeleteCommand) async throws -> ChatDraftMutationResult
    typealias Sleeper = @Sendable (UInt64) async throws -> Void

    @ObservationIgnored private var remoteLoader: Loader?
    @ObservationIgnored private var remotePutter: Putter?
    @ObservationIgnored private var remoteDeleter: Deleter?
    @ObservationIgnored private var chatUnavailableHandler: (@MainActor (UUID) -> Void)?
    @ObservationIgnored private var mutationPacer: ChatDraftMutationPacer
    @ObservationIgnored private let mutationPacerFactory: @Sendable () -> ChatDraftMutationPacer
    @ObservationIgnored private let sleep: Sleeper
    @ObservationIgnored private var sessionBinding: SynchronizedChatDraftSessionBinding?
    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var editVersions: [UUID: UInt] = [:]
    @ObservationIgnored private var loadAttempts: [UUID: UInt] = [:]
    @ObservationIgnored private var mutationAttempts: [UUID: UInt] = [:]
    @ObservationIgnored private var debounceAttempts: [UUID: UInt] = [:]
    @ObservationIgnored private var loadOperations: [UUID: Task<SynchronizedChatDraftState, Error>] = [:]
    @ObservationIgnored private var mutationOperations: [UUID: Task<ChatDraftMutationResolution, Error>] = [:]
    @ObservationIgnored private var debounceOperations: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var pendingCommands: [UUID: PendingCommand] = [:]
    @ObservationIgnored private var rateLimitedRetriedNonces: Set<UUID> = []
    @ObservationIgnored private var unavailableChatIDs: Set<UUID> = []
    @ObservationIgnored private var recoveryPendingChatIDs: Set<UUID> = []
    @ObservationIgnored private var lastRealtimeSequence: Int?
    @ObservationIgnored private var realtimeChangeDates: [UUID: Date] = [:]
    @ObservationIgnored private var lastRealtimeAcceptance: (
        binding: SynchronizedChatDraftSessionBinding,
        dispatch: ChatDraftRealtimeDispatch
    )?

    public init() {
        let factory: @Sendable () -> ChatDraftMutationPacer = { ChatDraftMutationPacer() }
        mutationPacerFactory = factory
        mutationPacer = factory()
        sleep = { try await Task.sleep(nanoseconds: $0) }
    }

    init(
        mutationPacerFactory: @escaping @Sendable () -> ChatDraftMutationPacer,
        sleep: @escaping Sleeper = { try await Task.sleep(nanoseconds: $0) }
    ) {
        self.mutationPacerFactory = mutationPacerFactory
        mutationPacer = mutationPacerFactory()
        self.sleep = sleep
    }

    public func confirmedState(for chatID: UUID) -> SynchronizedChatDraftState? {
        confirmedStates[chatID]
    }

    public func localDraft(for chatID: UUID) -> SynchronizedChatDraftContent {
        localDrafts[chatID] ?? .empty
    }

    public func loadState(for chatID: UUID) -> RemoteContentState {
        loadStates[chatID] ?? .idle
    }

    public func mutationState(for chatID: UUID) -> RemoteContentState {
        mutationStates[chatID] ?? .idle
    }

    @discardableResult
    public func setLocalDraft(
        for chatID: UUID,
        text: String,
        replyToMessageID: UUID? = nil
    ) -> Bool {
        guard sessionBinding != nil,
              SynchronizedChatDraftContract.isRFCUUID(chatID),
              replyToMessageID.map(SynchronizedChatDraftContract.isRFCUUID) ?? true
        else { return false }

        let content = SynchronizedChatDraftContent(
            text: text,
            replyToMessageID: replyToMessageID
        )
        guard localDraft(for: chatID) != content else { return true }
        replaceLocal(content, for: chatID)
        editVersions[chatID] = (editVersions[chatID] ?? 0) &+ 1
        recalculateDirtyState(for: chatID)
        if pendingCommands[chatID]?.desiredContent != content {
            clearPendingCommand(for: chatID)
        }
        return true
    }

    public func discardLocalChanges(for chatID: UUID) {
        guard sessionBinding != nil else { return }
        fenceMutation(for: chatID)
        editVersions[chatID] = (editVersions[chatID] ?? 0) &+ 1
        clearPendingCommand(for: chatID)
        replaceLocal(confirmedStates[chatID]?.content ?? .empty, for: chatID)
        dirtyChatIDs.remove(chatID)
        mutationStates[chatID] = .idle
    }

    @discardableResult
    public func refresh(_ chatID: UUID, force: Bool = false) async -> Bool {
        guard SynchronizedChatDraftContract.isRFCUUID(chatID) else { return false }
        guard let remoteLoader, sessionBinding != nil else {
            loadStates[chatID] = .failed("Синхронизация черновиков не подключена.")
            return false
        }
        guard mutationState(for: chatID) != .loading else { return false }
        guard force || loadState(for: chatID) != .loading else { return false }

        let operationGeneration = generation
        let attempt = nextLoadAttempt(for: chatID)
        let operation = Task { try await remoteLoader(chatID) }
        loadOperations[chatID]?.cancel()
        loadOperations[chatID] = operation
        loadStates[chatID] = .loading

        do {
            let loaded = try await operation.value
            guard acceptsLoad(
                operation,
                chatID: chatID,
                generation: operationGeneration,
                attempt: attempt
            ) else { return false }
            guard !Task.isCancelled else {
                operation.cancel()
                settleCancelledLoad(chatID, generation: operationGeneration, attempt: attempt)
                return false
            }
            try validate(loaded, for: chatID)
            unavailableChatIDs.remove(chatID)
            recoveryPendingChatIDs.remove(chatID)
            publishConfirmed(loaded, for: chatID, preservingDirtyLocal: true)
            loadOperations[chatID] = nil
            if dirtyChatIDs.contains(chatID) {
                schedulePersist(chatID)
            }
            return true
        } catch is CancellationError {
            settleCancelledLoad(chatID, generation: operationGeneration, attempt: attempt)
            return false
        } catch {
            guard generation == operationGeneration, loadAttempts[chatID] == attempt else {
                return false
            }
            guard !Task.isCancelled else {
                operation.cancel()
                settleCancelledLoad(chatID, generation: operationGeneration, attempt: attempt)
                return false
            }
            handleFailure(error, chatID: chatID, mutation: false)
            loadOperations[chatID] = nil
            return false
        }
    }

    /// Persists the current in-memory draft with CAS. A failed exact command
    /// retains its nonce for an idempotent retry, but is never written to disk.
    @discardableResult
    public func persist(_ chatID: UUID) async -> Bool {
        cancelScheduledPersist(for: chatID)
        return await persistCurrentDraft(chatID)
    }

    public func schedulePersist(
        _ chatID: UUID,
        debounceNanoseconds: UInt64 = 400_000_000
    ) {
        guard sessionBinding != nil,
              SynchronizedChatDraftContract.isRFCUUID(chatID)
        else { return }

        debounceOperations[chatID]?.cancel()
        let operationGeneration = generation
        let editVersion = editVersions[chatID] ?? 0
        let attempt = (debounceAttempts[chatID] ?? 0) &+ 1
        debounceAttempts[chatID] = attempt
        debounceOperations[chatID] = Task { [weak self] in
            do {
                try await self?.sleep(debounceNanoseconds)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await self?.runScheduledPersist(
                chatID,
                generation: operationGeneration,
                editVersion: editVersion,
                attempt: attempt
            )
        }
    }

    public func cancelScheduledPersist(for chatID: UUID) {
        debounceOperations[chatID]?.cancel()
        debounceOperations[chatID] = nil
        debounceAttempts[chatID] = (debounceAttempts[chatID] ?? 0) &+ 1
    }

    @discardableResult
    func configureRemote(
        accountID: UUID,
        sessionID: UUID,
        loader: @escaping Loader,
        putter: @escaping Putter,
        deleter: @escaping Deleter
    ) -> SynchronizedChatDraftSessionBinding {
        resetForSessionReplacement()
        let binding = SynchronizedChatDraftSessionBinding(
            accountID: accountID,
            sessionID: sessionID,
            nonce: .clientNonceV4()
        )
        sessionBinding = binding
        remoteLoader = loader
        remotePutter = putter
        remoteDeleter = deleter
        return binding
    }

    func setChatUnavailableHandler(_ handler: (@MainActor (UUID) -> Void)?) {
        chatUnavailableHandler = handler
    }

    func isChatUnavailable(_ chatID: UUID) -> Bool {
        unavailableChatIDs.contains(chatID)
    }

    func knownChatIDs() -> Set<UUID> {
        Set(confirmedStates.keys)
            .union(localDrafts.keys)
            .union(dirtyChatIDs)
            .union(loadStates.keys)
            .union(mutationStates.keys)
            .union(loadOperations.keys)
            .union(mutationOperations.keys)
            .union(debounceOperations.keys)
            .union(pendingCommands.keys)
            .union(recoveryPendingChatIDs)
            .union(unavailableChatIDs)
    }

    func applyRealtime(
        _ dispatch: ChatDraftRealtimeDispatch,
        binding: SynchronizedChatDraftSessionBinding
    ) -> ChatDraftRealtimeApplication {
        guard sessionBinding == binding,
              dispatch.accountID == binding.accountID
        else { return .rejected }

        if dispatch.sequence == lastRealtimeSequence {
            guard let lastRealtimeAcceptance,
                  lastRealtimeAcceptance.binding == binding,
                  lastRealtimeAcceptance.dispatch == dispatch
            else { return .rejected }
            return .exactReplay
        }
        guard dispatch.sequence > (lastRealtimeSequence ?? 0) else { return .stale }
        do {
            try validate(dispatch.state, for: dispatch.chatID)
        } catch {
            return .rejected
        }
        guard dispatch.state.revision > 0 else { return .rejected }
        if let current = confirmedStates[dispatch.chatID] {
            if dispatch.state.revision == current.revision {
                guard dispatch.state == current else { return .rejected }
                if let lastChange = realtimeChangeDates[dispatch.chatID],
                   dispatch.changedAt < lastChange {
                    return .rejected
                }
                lastRealtimeSequence = dispatch.sequence
                realtimeChangeDates[dispatch.chatID] = dispatch.changedAt
                lastRealtimeAcceptance = (binding, dispatch)
                return .causalNoOp
            }
            if dispatch.state.revision < current.revision {
                return .stale
            }
        }
        if let lastChange = realtimeChangeDates[dispatch.chatID],
           dispatch.changedAt <= lastChange {
            return .rejected
        }
        fenceLoadAndMutation(for: dispatch.chatID)
        clearPendingCommand(for: dispatch.chatID)
        confirmedStates[dispatch.chatID] = dispatch.state
        recoveryPendingChatIDs.remove(dispatch.chatID)
        loadStates[dispatch.chatID] = .loaded
        mutationStates[dispatch.chatID] = .loaded
        if dispatch.state.draft == nil {
            if dirtyChatIDs.contains(dispatch.chatID) {
                // The event has no removal reason: an ordinary delete from a
                // second device must not destroy newer local typing. Rebase it
                // on the tombstone revision. Explicit membership removal and
                // 403/404 paths call `removeChat` and scrub private text.
                recalculateDirtyState(for: dispatch.chatID)
                schedulePersist(dispatch.chatID)
            } else {
                replaceLocal(.empty, for: dispatch.chatID)
                dirtyChatIDs.remove(dispatch.chatID)
                editVersions[dispatch.chatID] = (editVersions[dispatch.chatID] ?? 0) &+ 1
            }
        } else {
            publishLocalAfterConfirmedChange(for: dispatch.chatID)
            if dirtyChatIDs.contains(dispatch.chatID) {
                schedulePersist(dispatch.chatID)
            }
        }
        lastRealtimeSequence = dispatch.sequence
        realtimeChangeDates[dispatch.chatID] = dispatch.changedAt
        lastRealtimeAcceptance = (binding, dispatch)
        return .accepted
    }

    func cancelRemoteOperations() {
        generation &+= 1
        loadOperations.values.forEach { $0.cancel() }
        mutationOperations.values.forEach { $0.cancel() }
        debounceOperations.values.forEach { $0.cancel() }
        loadOperations.removeAll()
        mutationOperations.removeAll()
        debounceOperations.removeAll()
        loadStates = loadStates.mapValues { $0 == .loading ? .idle : $0 }
        for chatID in confirmedStates.keys where loadStates[chatID] == .idle {
            loadStates[chatID] = .loaded
        }
        mutationStates = mutationStates.mapValues { $0 == .loading ? .idle : $0 }
    }

    func resetForSessionReplacement() {
        cancelRemoteOperations()
        mutationPacer = mutationPacerFactory()
        confirmedStates.removeAll()
        localDrafts.removeAll()
        dirtyChatIDs.removeAll()
        loadStates.removeAll()
        mutationStates.removeAll()
        editVersions.removeAll()
        loadAttempts.removeAll()
        mutationAttempts.removeAll()
        debounceAttempts.removeAll()
        pendingCommands.removeAll()
        rateLimitedRetriedNonces.removeAll()
        unavailableChatIDs.removeAll()
        recoveryPendingChatIDs.removeAll()
        lastRealtimeSequence = nil
        realtimeChangeDates.removeAll()
        lastRealtimeAcceptance = nil
        sessionBinding = nil
        remoteLoader = nil
        remotePutter = nil
        remoteDeleter = nil
        chatUnavailableHandler = nil
    }

    /// The current twelve-collection reconciliation snapshot intentionally has
    /// no drafts. A gap therefore invalidates every confirmed projection and
    /// lets selected/background chats establish a new fence through eager/lazy
    /// GETs without an unbounded account-wide request pass.
    func resetRealtimeFenceForRecovery() {
        lastRealtimeSequence = nil
        realtimeChangeDates.removeAll()
        lastRealtimeAcceptance = nil
    }

    /// Cancels stale loads/mutations before a forced V2 gap recovery while
    /// retaining the latest account-scoped local intent. The following GET is
    /// authoritative for the new reconciliation boundary and rebases that
    /// intent through CAS.
    @discardableResult
    func prepareForRecovery(
        retainedChatIDs: Set<UUID>,
        lifecycleResetChatIDs: Set<UUID> = []
    ) -> SynchronizedChatDraftRecoveryPlan {
        resetRealtimeFenceForRecovery()
        let lifecycleResetChatIDs = retainedChatIDs.intersection(lifecycleResetChatIDs)
        let chatIDs = retainedChatIDs
            .union(confirmedStates.keys)
            .union(localDrafts.keys)
            .union(loadStates.keys)
            .union(mutationStates.keys)
            .union(loadOperations.keys)
            .union(mutationOperations.keys)
            .union(debounceOperations.keys)
            .union(pendingCommands.keys)
            .union(dirtyChatIDs)
        // A membership remove+re-add is a new privacy lifecycle even when the
        // chat ID survives the reconciliation bundle. Never carry text or an
        // idempotency nonce across that boundary.
        let dirtyPreserved = retainedChatIDs
            .intersection(dirtyChatIDs)
            .subtracting(lifecycleResetChatIDs)
        let cleanInvalidated = retainedChatIDs
            .subtracting(dirtyPreserved)
            .subtracting(lifecycleResetChatIDs)
        for chatID in chatIDs {
            fenceLoadAndMutation(for: chatID)
            confirmedStates[chatID] = nil
            if !dirtyPreserved.contains(chatID) {
                localDrafts[chatID] = nil
                dirtyChatIDs.remove(chatID)
                clearPendingCommand(for: chatID)
            }
            if retainedChatIDs.contains(chatID) {
                loadStates[chatID] = .idle
                mutationStates[chatID] = .idle
                unavailableChatIDs.remove(chatID)
            } else {
                loadStates[chatID] = nil
                mutationStates[chatID] = nil
                editVersions[chatID] = nil
                unavailableChatIDs.remove(chatID)
            }
        }
        recoveryPendingChatIDs = retainedChatIDs
        return SynchronizedChatDraftRecoveryPlan(
            cleanInvalidatedChatIDs: cleanInvalidated,
            dirtyPreservedChatIDs: dirtyPreserved,
            lifecycleResetChatIDs: lifecycleResetChatIDs,
            removedChatIDs: chatIDs.subtracting(retainedChatIDs)
        )
    }

    func removeChat(_ chatID: UUID) {
        fenceLoadAndMutation(for: chatID)
        confirmedStates[chatID] = nil
        localDrafts[chatID] = nil
        dirtyChatIDs.remove(chatID)
        loadStates[chatID] = nil
        mutationStates[chatID] = nil
        editVersions[chatID] = nil
        pendingCommands[chatID] = nil
        unavailableChatIDs.remove(chatID)
        recoveryPendingChatIDs.remove(chatID)
        realtimeChangeDates[chatID] = nil
    }

    private func persistCurrentDraft(_ chatID: UUID) async -> Bool {
        guard SynchronizedChatDraftContract.isRFCUUID(chatID) else { return false }
        guard sessionBinding != nil else { return false }
        guard let confirmed = confirmedStates[chatID] else {
            // Initial and post-gap GETs establish the only valid CAS base.
            // Local typing remains responsive, but a debounce that fires first
            // is a silent defer; the successful GET reschedules the dirty
            // content. The load state owns any visible transport failure.
            mutationStates[chatID] = .idle
            return false
        }
        guard loadState(for: chatID) != .loading,
              mutationState(for: chatID) != .loading
        else { return false }

        let desired = localDraft(for: chatID)
        if desired == confirmed.content {
            dirtyChatIDs.remove(chatID)
            clearPendingCommand(for: chatID)
            mutationStates[chatID] = .loaded
            return true
        }

        guard let remoteLoader else {
            mutationStates[chatID] = .failed("Синхронизация черновиков не подключена.")
            return false
        }

        let operationGeneration = generation
        let editVersion = editVersions[chatID] ?? 0
        let attempt = nextMutationAttempt(for: chatID)
        let operation: Task<ChatDraftMutationResolution, Error>
        let pending: PendingCommand

        if desired.isEmpty {
            guard confirmed.draft != nil, confirmed.revision > 0, let remoteDeleter else {
                mutationStates[chatID] = .failed("Удаление серверного черновика не подключено.")
                return false
            }
            let command = deleteCommand(
                for: chatID,
                expectedRevision: confirmed.revision,
                editVersion: editVersion
            )
            pending = .delete(command: command, editVersion: editVersion)
            let mutationPacer = mutationPacer
            operation = Task {
                try await mutationPacer.waitForPermit()
                let acknowledgement = try await remoteDeleter(chatID, command)
                try Task.checkCancellation()
                let authoritativeState = acknowledgement.replayed
                    ? try await remoteLoader(chatID)
                    : acknowledgement.state
                return ChatDraftMutationResolution(
                    acknowledgement: acknowledgement,
                    authoritativeState: authoritativeState
                )
            }
        } else {
            guard desired.isServerValid else {
                mutationStates[chatID] = .failed("Черновик должен быть не длиннее 10 000 символов Unicode.")
                return false
            }
            guard let remotePutter else {
                mutationStates[chatID] = .failed("Сохранение серверного черновика не подключено.")
                return false
            }
            let command = putCommand(
                for: chatID,
                content: desired,
                expectedRevision: confirmed.revision,
                editVersion: editVersion
            )
            pending = .put(command: command, editVersion: editVersion)
            let mutationPacer = mutationPacer
            operation = Task {
                try await mutationPacer.waitForPermit()
                let acknowledgement = try await remotePutter(chatID, command)
                try Task.checkCancellation()
                let authoritativeState = acknowledgement.replayed
                    ? try await remoteLoader(chatID)
                    : acknowledgement.state
                return ChatDraftMutationResolution(
                    acknowledgement: acknowledgement,
                    authoritativeState: authoritativeState
                )
            }
        }

        replacePendingCommand(pending, for: chatID)
        mutationOperations[chatID]?.cancel()
        mutationOperations[chatID] = operation
        mutationStates[chatID] = .loading

        do {
            let resolution = try await operation.value
            guard acceptsMutation(
                operation,
                chatID: chatID,
                generation: operationGeneration,
                attempt: attempt
            ) else { return false }
            guard !Task.isCancelled else {
                operation.cancel()
                settleCancelledMutation(chatID, generation: operationGeneration, attempt: attempt)
                return false
            }
            try validate(resolution.acknowledgement, for: chatID, pending: pending)
            try validate(resolution.authoritativeState, for: chatID)
            confirmedStates[chatID] = resolution.authoritativeState
            loadStates[chatID] = .loaded
            mutationStates[chatID] = .loaded
            mutationOperations[chatID] = nil
            if pendingCommands[chatID] == pending {
                clearPendingCommand(for: chatID)
            }
            if editVersions[chatID] == editVersion,
               localDraft(for: chatID) == pending.desiredContent {
                replaceLocal(resolution.authoritativeState.content, for: chatID)
                dirtyChatIDs.remove(chatID)
            } else {
                recalculateDirtyState(for: chatID)
                if dirtyChatIDs.contains(chatID) {
                    schedulePersist(chatID)
                }
            }
            return true
        } catch is CancellationError {
            settleCancelledMutation(chatID, generation: operationGeneration, attempt: attempt)
            return false
        } catch {
            let rateLimit = error as? ChatDraftRateLimitError
            if let rateLimit, generation == operationGeneration {
                // A same-session recovery may already have fenced this chat's
                // attempt when the completed HTTP 429 is delivered. The
                // account/session bucket deadline still applies globally, so
                // install it before the narrower attempt/cancellation guards.
                await mutationPacer.deferFor(
                    UInt64(rateLimit.retryAfterSeconds) * 1_000_000_000
                )
            }
            guard generation == operationGeneration, mutationAttempts[chatID] == attempt else {
                return false
            }
            guard !Task.isCancelled else {
                operation.cancel()
                settleCancelledMutation(chatID, generation: operationGeneration, attempt: attempt)
                return false
            }
            mutationOperations[chatID] = nil
            if let rateLimit {
                handleRateLimit(
                    rateLimit,
                    chatID: chatID,
                    pending: pending,
                    generation: operationGeneration,
                    editVersion: editVersion
                )
                return false
            }
            handleFailure(error, chatID: chatID, mutation: true)
            return false
        }
    }

    private func runScheduledPersist(
        _ chatID: UUID,
        generation operationGeneration: UInt,
        editVersion: UInt,
        attempt: UInt
    ) async {
        guard generation == operationGeneration,
              editVersions[chatID] == editVersion,
              debounceAttempts[chatID] == attempt
        else { return }
        debounceOperations[chatID] = nil
        _ = await persistCurrentDraft(chatID)
    }

    private func putCommand(
        for chatID: UUID,
        content: SynchronizedChatDraftContent,
        expectedRevision: Int,
        editVersion: UInt
    ) -> ChatDraftPutCommand {
        if case let .put(command, pendingEditVersion) = pendingCommands[chatID],
           command.content == content,
           command.expectedRevision == expectedRevision,
           pendingEditVersion == editVersion {
            return command
        }
        return ChatDraftPutCommand(
            content: content,
            expectedRevision: expectedRevision,
            clientNonce: .clientNonceV4()
        )
    }

    private func deleteCommand(
        for chatID: UUID,
        expectedRevision: Int,
        editVersion: UInt
    ) -> ChatDraftDeleteCommand {
        if case let .delete(command, pendingEditVersion) = pendingCommands[chatID],
           command.expectedRevision == expectedRevision,
           pendingEditVersion == editVersion {
            return command
        }
        return ChatDraftDeleteCommand(
            expectedRevision: expectedRevision,
            clientNonce: .clientNonceV4()
        )
    }

    private func publishConfirmed(
        _ state: SynchronizedChatDraftState,
        for chatID: UUID,
        preservingDirtyLocal: Bool
    ) {
        confirmedStates[chatID] = state
        loadStates[chatID] = .loaded
        if preservingDirtyLocal, dirtyChatIDs.contains(chatID) {
            recalculateDirtyState(for: chatID)
        } else {
            replaceLocal(state.content, for: chatID)
            dirtyChatIDs.remove(chatID)
        }
    }

    private func publishLocalAfterConfirmedChange(for chatID: UUID) {
        if dirtyChatIDs.contains(chatID) {
            recalculateDirtyState(for: chatID)
        } else {
            replaceLocal(confirmedStates[chatID]?.content ?? .empty, for: chatID)
        }
    }

    private func replaceLocal(_ content: SynchronizedChatDraftContent, for chatID: UUID) {
        if content.isEmpty {
            localDrafts[chatID] = nil
        } else {
            localDrafts[chatID] = content
        }
    }

    private func recalculateDirtyState(for chatID: UUID) {
        if localDraft(for: chatID) == confirmedStates[chatID]?.content {
            dirtyChatIDs.remove(chatID)
        } else {
            dirtyChatIDs.insert(chatID)
        }
    }

    private func validate(_ state: SynchronizedChatDraftState, for chatID: UUID) throws {
        guard state.revision >= 0,
              state.revision <= SynchronizedChatDraftContract.maximumSafeInteger,
              state.draft?.chatID == chatID || state.draft == nil,
              state.draft?.revision == state.revision || state.draft == nil,
              state.draft?.content.isServerValid ?? true
        else { throw LuxoraAPIError.invalidResponse }
    }

    private func validate(
        _ result: ChatDraftMutationResult,
        for chatID: UUID,
        pending: PendingCommand
    ) throws {
        try validate(result.state, for: chatID)
        switch pending {
        case let .put(command, _):
            guard result.state.draft?.content == command.content,
                  result.state.revision == command.expectedRevision
                    || result.state.revision == command.expectedRevision + 1
            else { throw LuxoraAPIError.invalidResponse }
        case let .delete(command, _):
            guard result.state.draft == nil,
                  result.state.revision == command.expectedRevision + 1
            else { throw LuxoraAPIError.invalidResponse }
        }
    }

    private func nextLoadAttempt(for chatID: UUID) -> UInt {
        let attempt = (loadAttempts[chatID] ?? 0) &+ 1
        loadAttempts[chatID] = attempt
        return attempt
    }

    private func nextMutationAttempt(for chatID: UUID) -> UInt {
        let attempt = (mutationAttempts[chatID] ?? 0) &+ 1
        mutationAttempts[chatID] = attempt
        return attempt
    }

    private func acceptsLoad(
        _ operation: Task<SynchronizedChatDraftState, Error>,
        chatID: UUID,
        generation operationGeneration: UInt,
        attempt: UInt
    ) -> Bool {
        generation == operationGeneration
            && loadAttempts[chatID] == attempt
            && !operation.isCancelled
    }

    private func acceptsMutation(
        _ operation: Task<ChatDraftMutationResolution, Error>,
        chatID: UUID,
        generation operationGeneration: UInt,
        attempt: UInt
    ) -> Bool {
        generation == operationGeneration
            && mutationAttempts[chatID] == attempt
            && !operation.isCancelled
    }

    private func settleCancelledLoad(
        _ chatID: UUID,
        generation operationGeneration: UInt,
        attempt: UInt
    ) {
        guard generation == operationGeneration, loadAttempts[chatID] == attempt else { return }
        loadStates[chatID] = confirmedStates[chatID] == nil ? .idle : .loaded
        loadOperations[chatID] = nil
    }

    private func settleCancelledMutation(
        _ chatID: UUID,
        generation operationGeneration: UInt,
        attempt: UInt
    ) {
        guard generation == operationGeneration, mutationAttempts[chatID] == attempt else { return }
        mutationStates[chatID] = .idle
        mutationOperations[chatID] = nil
    }

    private func fenceMutation(for chatID: UUID) {
        mutationOperations[chatID]?.cancel()
        debounceOperations[chatID]?.cancel()
        mutationOperations[chatID] = nil
        debounceOperations[chatID] = nil
        mutationAttempts[chatID] = (mutationAttempts[chatID] ?? 0) &+ 1
        debounceAttempts[chatID] = (debounceAttempts[chatID] ?? 0) &+ 1
    }

    private func fenceLoadAndMutation(for chatID: UUID) {
        loadOperations[chatID]?.cancel()
        loadOperations[chatID] = nil
        loadAttempts[chatID] = (loadAttempts[chatID] ?? 0) &+ 1
        fenceMutation(for: chatID)
    }

    private func clearPendingCommand(for chatID: UUID) {
        if let nonce = pendingCommands[chatID]?.clientNonce {
            rateLimitedRetriedNonces.remove(nonce)
        }
        pendingCommands[chatID] = nil
    }

    private func replacePendingCommand(_ pending: PendingCommand, for chatID: UUID) {
        if let previous = pendingCommands[chatID], previous != pending {
            rateLimitedRetriedNonces.remove(previous.clientNonce)
        }
        pendingCommands[chatID] = pending
    }

    private func handleRateLimit(
        _ error: ChatDraftRateLimitError,
        chatID: UUID,
        pending: PendingCommand,
        generation operationGeneration: UInt,
        editVersion: UInt
    ) {
        mutationStates[chatID] = .failed(error.localizedDescription)
        guard generation == operationGeneration,
              editVersions[chatID] == editVersion,
              pendingCommands[chatID] == pending,
              rateLimitedRetriedNonces.insert(pending.clientNonce).inserted
        else { return }
        schedulePersist(
            chatID,
            debounceNanoseconds: UInt64(error.retryAfterSeconds) * 1_000_000_000
        )
    }

    private func handleFailure(_ error: Error, chatID: UUID, mutation: Bool) {
        if Self.isUnauthorized(error) {
            invalidateAfterUnauthorized(error, chatID: chatID, mutation: mutation)
            return
        }
        if Self.isChatUnavailable(error) {
            fenceLoadAndMutation(for: chatID)
            confirmedStates[chatID] = nil
            localDrafts[chatID] = nil
            dirtyChatIDs.remove(chatID)
            clearPendingCommand(for: chatID)
            unavailableChatIDs.insert(chatID)
            recoveryPendingChatIDs.remove(chatID)
            chatUnavailableHandler?(chatID)
        }
        let failure = RemoteContentState.failed(Self.russianMessage(for: error))
        if mutation {
            mutationStates[chatID] = failure
        } else {
            loadStates[chatID] = failure
        }
    }

    private func invalidateAfterUnauthorized(
        _ error: Error,
        chatID: UUID,
        mutation: Bool
    ) {
        generation &+= 1
        loadOperations.values.forEach { $0.cancel() }
        mutationOperations.values.forEach { $0.cancel() }
        debounceOperations.values.forEach { $0.cancel() }
        loadOperations.removeAll()
        mutationOperations.removeAll()
        debounceOperations.removeAll()
        confirmedStates.removeAll()
        localDrafts.removeAll()
        dirtyChatIDs.removeAll()
        pendingCommands.removeAll()
        rateLimitedRetriedNonces.removeAll()
        unavailableChatIDs.removeAll()
        recoveryPendingChatIDs.removeAll()
        loadStates.removeAll()
        mutationStates.removeAll()
        let failure = RemoteContentState.failed(Self.russianMessage(for: error))
        loadStates[chatID] = failure
        if mutation { mutationStates[chatID] = failure }
    }

    private static func isUnauthorized(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return status == 401
    }

    private static func isChatUnavailable(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return status == 403 || status == 404
    }

    private static func russianMessage(for error: Error) -> String {
        guard case let LuxoraAPIError.server(status, _, _) = error else {
            if error is CancellationError { return "" }
            return "Нет связи с сервером. Повторите синхронизацию черновика."
        }
        switch status {
        case 400: return "Черновик или сообщение для ответа больше недоступны."
        case 401: return "Сеанс истёк. Войдите снова."
        case 403, 404: return "Чат больше недоступен. Локальный черновик удалён."
        case 409: return "Черновик изменился на другом устройстве. Обновите чат и повторите."
        case 429: return "Слишком много сохранений. Подождите и повторите."
        default: return "Сервер не сохранил черновик (код \(status))."
        }
    }
}

private enum PendingCommand: Equatable {
    case put(command: ChatDraftPutCommand, editVersion: UInt)
    case delete(command: ChatDraftDeleteCommand, editVersion: UInt)

    var desiredContent: SynchronizedChatDraftContent {
        switch self {
        case let .put(command, _): command.content
        case .delete: .empty
        }
    }

    var clientNonce: UUID {
        switch self {
        case let .put(command, _): command.clientNonce
        case let .delete(command, _): command.clientNonce
        }
    }
}
