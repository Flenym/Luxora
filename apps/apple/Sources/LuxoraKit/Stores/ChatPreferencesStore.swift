import Foundation
import Observation

struct ChatPreferencesSessionBinding: Hashable, Sendable {
    let accountID: UUID
    fileprivate let nonce: UUID
}

enum ChatPreferencesRealtimeApplication: Equatable, Sendable {
    case accepted
    case exactReplay
    case rejected
}

@MainActor
@Observable
public final class ChatPreferencesStore {
    public private(set) var confirmed: [UUID: ChatPreferences] = [:]
    public private(set) var loadStates: [UUID: RemoteContentState] = [:]
    public private(set) var mutationStates: [UUID: RemoteContentState] = [:]

    var remoteLoader: (@Sendable (UUID) async throws -> ChatPreferences)?
    var remoteUpdater: (@Sendable (UUID, ChatPreferencesPatch) async throws -> ChatPreferences)?

    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var loadAttempts: [UUID: UInt] = [:]
    @ObservationIgnored private var mutationAttempts: [UUID: UInt] = [:]
    @ObservationIgnored private var loadOperations: [UUID: Task<ChatPreferences, Error>] = [:]
    @ObservationIgnored private var mutationOperations: [UUID: Task<ChatPreferences, Error>] = [:]
    @ObservationIgnored private var sessionBinding: ChatPreferencesSessionBinding?
    @ObservationIgnored private var lastRealtimeSequence: Int?
    @ObservationIgnored private var realtimeChangeDates: [UUID: Date] = [:]
    @ObservationIgnored private var lastRealtimeAcceptance: (
        binding: ChatPreferencesSessionBinding,
        dispatch: ChatPreferencesRealtimeDispatch
    )?

    public init() {}

    public func preferences(for chatID: UUID) -> ChatPreferences? {
        confirmed[chatID]
    }

    public func loadState(for chatID: UUID) -> RemoteContentState {
        loadStates[chatID] ?? .idle
    }

    public func mutationState(for chatID: UUID) -> RemoteContentState {
        mutationStates[chatID] ?? .idle
    }

    public func refresh(_ chatID: UUID, force: Bool = false) async {
        guard let remoteLoader else {
            loadStates[chatID] = .failed("Серверные настройки чата не подключены.")
            return
        }
        guard mutationState(for: chatID) != .loading else { return }
        guard force || loadState(for: chatID) != .loading else { return }

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
            ) else { return }
            guard !Task.isCancelled else {
                operation.cancel()
                settleCancelledLoad(chatID, generation: operationGeneration, attempt: attempt)
                return
            }
            confirmed[chatID] = loaded
            loadStates[chatID] = .loaded
            loadOperations[chatID] = nil
        } catch is CancellationError {
            settleCancelledLoad(chatID, generation: operationGeneration, attempt: attempt)
        } catch {
            guard generation == operationGeneration, loadAttempts[chatID] == attempt else { return }
            guard !Task.isCancelled else {
                operation.cancel()
                settleCancelledLoad(chatID, generation: operationGeneration, attempt: attempt)
                return
            }
            if Self.isUnauthorized(error) {
                invalidateAfterUnauthorized(error, chatID: chatID, mutation: false)
                return
            }
            loadStates[chatID] = .failed(Self.russianMessage(for: error))
            loadOperations[chatID] = nil
        }
    }

    /// Updates only after the server returns the authoritative projection. No
    /// optimistic archive/mute state is published, including on ambiguous
    /// transport failures.
    @discardableResult
    public func update(_ chatID: UUID, patch: ChatPreferencesPatch) async -> Bool {
        guard patch.hasChanges else { return false }
        guard let remoteUpdater else {
            mutationStates[chatID] = .failed("Сохранение настроек чата не подключено.")
            return false
        }
        guard loadState(for: chatID) != .loading,
              mutationState(for: chatID) != .loading
        else { return false }

        let operationGeneration = generation
        let attempt = nextMutationAttempt(for: chatID)
        let operation = Task { try await remoteUpdater(chatID, patch) }
        mutationOperations[chatID]?.cancel()
        mutationOperations[chatID] = operation
        mutationStates[chatID] = .loading

        do {
            let updated = try await operation.value
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
            confirmed[chatID] = updated
            loadStates[chatID] = .loaded
            mutationStates[chatID] = .loaded
            mutationOperations[chatID] = nil
            return true
        } catch is CancellationError {
            settleCancelledMutation(chatID, generation: operationGeneration, attempt: attempt)
            return false
        } catch {
            guard generation == operationGeneration, mutationAttempts[chatID] == attempt else {
                return false
            }
            guard !Task.isCancelled else {
                operation.cancel()
                settleCancelledMutation(chatID, generation: operationGeneration, attempt: attempt)
                return false
            }
            if Self.isUnauthorized(error) {
                invalidateAfterUnauthorized(error, chatID: chatID, mutation: true)
                return false
            }
            mutationStates[chatID] = .failed(Self.russianMessage(for: error))
            mutationOperations[chatID] = nil
            return false
        }
    }

    public func clearMutationFailure(for chatID: UUID) {
        if case .failed = mutationState(for: chatID) {
            mutationStates[chatID] = .idle
        }
    }

    /// Every configuration belongs to one authenticated session. Replacing it
    /// cancels old work and removes old account projections before new closures
    /// become reachable.
    @discardableResult
    func configureRemote(
        accountID: UUID,
        loader: @escaping @Sendable (UUID) async throws -> ChatPreferences,
        updater: @escaping @Sendable (UUID, ChatPreferencesPatch) async throws -> ChatPreferences
    ) -> ChatPreferencesSessionBinding {
        resetForSessionReplacement()
        let binding = ChatPreferencesSessionBinding(accountID: accountID, nonce: UUID())
        sessionBinding = binding
        remoteLoader = loader
        remoteUpdater = updater
        return binding
    }

    /// Seeds an authenticated chat-list or reconciliation projection. The
    /// caller must establish the session binding first; replacing the seed
    /// never carries values from the previous account forward.
    func replaceConfirmed(_ preferences: [UUID: ChatPreferences]) {
        guard sessionBinding != nil else { return }
        confirmed = preferences
        loadStates = Dictionary(
            uniqueKeysWithValues: preferences.keys.map { ($0, RemoteContentState.loaded) }
        )
        mutationStates = mutationStates.filter { preferences[$0.key] != nil }
    }

    func mergeConfirmedProjection(_ preferences: ChatPreferences, chatID: UUID) {
        guard sessionBinding != nil else { return }
        confirmed[chatID] = preferences
        loadStates[chatID] = .loaded
    }

    func removeConfirmedProjection(chatID: UUID) {
        guard sessionBinding != nil else { return }
        fenceOperations(for: chatID)
        confirmed[chatID] = nil
        loadStates[chatID] = nil
        mutationStates[chatID] = nil
        realtimeChangeDates[chatID] = nil
    }

    /// Applies only an exact v2 account-scoped event from the currently bound
    /// authenticated session. The monotonically increasing durable sequence is
    /// the primary late-event fence; `changedAt` additionally rejects a
    /// higher-sequence payload that would move one chat backwards in server
    /// time. An accepted event cancels older HTTP work for that chat.
    func applyRealtime(
        _ dispatch: ChatPreferencesRealtimeDispatch,
        binding: ChatPreferencesSessionBinding
    ) -> ChatPreferencesRealtimeApplication {
        guard sessionBinding == binding,
              dispatch.accountID == binding.accountID
        else { return .rejected }

        if dispatch.sequence == lastRealtimeSequence {
            guard let lastRealtimeAcceptance,
                  lastRealtimeAcceptance.binding == binding,
                  lastRealtimeAcceptance.dispatch == dispatch
            else { return .rejected }
            // Cursor persistence may have failed after the first application.
            // An exact replay retries only that persistence in the session;
            // it must not cancel operations or publish the projection twice.
            return .exactReplay
        }
        guard dispatch.sequence > (lastRealtimeSequence ?? 0) else {
            return .rejected
        }
        if let lastChange = realtimeChangeDates[dispatch.chatID],
           dispatch.changedAt < lastChange {
            return .rejected
        }

        fenceOperations(for: dispatch.chatID)
        confirmed[dispatch.chatID] = dispatch.preferences
        loadStates[dispatch.chatID] = .loaded
        mutationStates[dispatch.chatID] = .loaded
        lastRealtimeSequence = dispatch.sequence
        realtimeChangeDates[dispatch.chatID] = dispatch.changedAt
        lastRealtimeAcceptance = (binding, dispatch)
        return .accepted
    }

    func cancelRemoteOperations() {
        generation &+= 1
        loadOperations.values.forEach { $0.cancel() }
        mutationOperations.values.forEach { $0.cancel() }
        loadOperations.removeAll()
        mutationOperations.removeAll()
        loadStates = loadStates.mapValues { state in
            state == .loading ? .idle : state
        }
        for chatID in confirmed.keys where loadStates[chatID] == .idle {
            loadStates[chatID] = .loaded
        }
        mutationStates = mutationStates.mapValues { state in
            state == .loading ? .idle : state
        }
    }

    func resetForSessionReplacement() {
        cancelRemoteOperations()
        confirmed.removeAll()
        loadStates.removeAll()
        mutationStates.removeAll()
        loadAttempts.removeAll()
        mutationAttempts.removeAll()
        sessionBinding = nil
        lastRealtimeSequence = nil
        realtimeChangeDates.removeAll()
        lastRealtimeAcceptance = nil
        remoteLoader = nil
        remoteUpdater = nil
    }

    private func fenceOperations(for chatID: UUID) {
        loadOperations[chatID]?.cancel()
        mutationOperations[chatID]?.cancel()
        loadOperations[chatID] = nil
        mutationOperations[chatID] = nil
        loadAttempts[chatID] = (loadAttempts[chatID] ?? 0) &+ 1
        mutationAttempts[chatID] = (mutationAttempts[chatID] ?? 0) &+ 1
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
        _ operation: Task<ChatPreferences, Error>,
        chatID: UUID,
        generation operationGeneration: UInt,
        attempt: UInt
    ) -> Bool {
        generation == operationGeneration
            && loadAttempts[chatID] == attempt
            && !operation.isCancelled
    }

    private func acceptsMutation(
        _ operation: Task<ChatPreferences, Error>,
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
        loadStates[chatID] = confirmed[chatID] == nil ? .idle : .loaded
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

    private func invalidateAfterUnauthorized(
        _ error: Error,
        chatID: UUID,
        mutation: Bool
    ) {
        generation &+= 1
        loadOperations.values.forEach { $0.cancel() }
        mutationOperations.values.forEach { $0.cancel() }
        loadOperations.removeAll()
        mutationOperations.removeAll()
        confirmed.removeAll()
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

    private static func russianMessage(for error: Error) -> String {
        guard case let LuxoraAPIError.server(status, _, _) = error else {
            if error is CancellationError { return "" }
            return "Нет связи с сервером. Подтвердите состояние чата повторной загрузкой."
        }
        switch status {
        case 401: return "Сеанс истёк. Войдите снова."
        case 403: return "У вас больше нет доступа к этому чату."
        case 404: return "Чат больше не найден."
        case 409: return "Настройка изменилась на другом устройстве. Обновите чат."
        case 429: return "Слишком много изменений. Подождите и повторите."
        default: return "Сервер не сохранил настройку чата (код \(status))."
        }
    }
}
