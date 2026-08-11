import Foundation
import Observation

@MainActor
@Observable
public final class PhonePasswordSettingsStore {
    public private(set) var status: PhonePasswordStatus?
    public private(set) var loadState: RemoteContentState = .idle
    public private(set) var mutationState: RemoteContentState = .idle

    var remoteLoader: (@Sendable () async throws -> PhonePasswordStatus)?
    var remoteConfigurator: (@Sendable (String, String?) async throws -> PhonePasswordStatus)?
    var remoteDisabler: (@Sendable (String) async throws -> PhonePasswordStatus)?

    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var loadAttempt: UInt = 0
    @ObservationIgnored private var mutationAttempt: UInt = 0
    @ObservationIgnored private var loadOperation: Task<PhonePasswordStatus, Error>?
    @ObservationIgnored private var mutationOperation: Task<PhonePasswordStatus, Error>?

    public init(status: PhonePasswordStatus? = nil) {
        self.status = status
        if status != nil { loadState = .loaded }
    }

    public func refresh(force: Bool = false) async {
        guard let remoteLoader else {
            loadState = .failed("Серверная настройка пароля не подключена.")
            return
        }
        guard force || loadState != .loading else { return }

        let operationGeneration = generation
        loadAttempt &+= 1
        let attempt = loadAttempt
        let operation = Task { try await remoteLoader() }
        loadOperation?.cancel()
        loadOperation = operation
        loadState = .loading

        do {
            let loaded = try await operation.value
            guard accepts(operation, generation: operationGeneration, attempt: attempt) else { return }
            status = loaded
            loadState = .loaded
            loadOperation = nil
        } catch is CancellationError {
            guard generation == operationGeneration, loadAttempt == attempt else { return }
            loadState = status == nil ? .idle : .loaded
            loadOperation = nil
        } catch {
            guard generation == operationGeneration, loadAttempt == attempt else { return }
            loadState = .failed(Self.russianMessage(for: error))
            loadOperation = nil
        }
    }

    @discardableResult
    public func configure(newPassword: String, currentPassword: String?) async -> Bool {
        guard let remoteConfigurator else {
            mutationState = .failed("Изменение пароля на сервере не подключено.")
            return false
        }
        guard mutationState != .loading else { return false }

        let operationGeneration = generation
        mutationAttempt &+= 1
        let attempt = mutationAttempt
        let operation = Task { try await remoteConfigurator(newPassword, currentPassword) }
        mutationOperation?.cancel()
        mutationOperation = operation
        mutationState = .loading

        return await settleMutation(operation, generation: operationGeneration, attempt: attempt)
    }

    @discardableResult
    public func disable(currentPassword: String) async -> Bool {
        guard let remoteDisabler else {
            mutationState = .failed("Отключение пароля на сервере не подключено.")
            return false
        }
        guard mutationState != .loading else { return false }

        let operationGeneration = generation
        mutationAttempt &+= 1
        let attempt = mutationAttempt
        let operation = Task { try await remoteDisabler(currentPassword) }
        mutationOperation?.cancel()
        mutationOperation = operation
        mutationState = .loading

        return await settleMutation(operation, generation: operationGeneration, attempt: attempt)
    }

    public func clearMutationFailure() {
        if case .failed = mutationState { mutationState = .idle }
    }

    func configureRemote(
        loader: @escaping @Sendable () async throws -> PhonePasswordStatus,
        configurator: @escaping @Sendable (String, String?) async throws -> PhonePasswordStatus,
        disabler: @escaping @Sendable (String) async throws -> PhonePasswordStatus
    ) {
        remoteLoader = loader
        remoteConfigurator = configurator
        remoteDisabler = disabler
    }

    func cancelRemoteOperations() {
        generation &+= 1
        loadOperation?.cancel()
        mutationOperation?.cancel()
        loadOperation = nil
        mutationOperation = nil
        if loadState == .loading { loadState = status == nil ? .idle : .loaded }
        if mutationState == .loading { mutationState = .idle }
    }

    private func settleMutation(
        _ operation: Task<PhonePasswordStatus, Error>,
        generation operationGeneration: UInt,
        attempt: UInt
    ) async -> Bool {
        do {
            let updated = try await operation.value
            guard acceptsMutation(operation, generation: operationGeneration, attempt: attempt) else {
                return false
            }
            status = updated
            loadState = .loaded
            mutationState = .loaded
            mutationOperation = nil
            return true
        } catch is CancellationError {
            guard generation == operationGeneration, mutationAttempt == attempt else { return false }
            mutationState = .idle
            mutationOperation = nil
            return false
        } catch {
            guard generation == operationGeneration, mutationAttempt == attempt else { return false }
            mutationState = .failed(Self.russianMessage(for: error))
            mutationOperation = nil
            return false
        }
    }

    private func accepts(
        _ operation: Task<PhonePasswordStatus, Error>,
        generation operationGeneration: UInt,
        attempt: UInt
    ) -> Bool {
        generation == operationGeneration
            && loadAttempt == attempt
            && !operation.isCancelled
            && !Task.isCancelled
    }

    private func acceptsMutation(
        _ operation: Task<PhonePasswordStatus, Error>,
        generation operationGeneration: UInt,
        attempt: UInt
    ) -> Bool {
        generation == operationGeneration
            && mutationAttempt == attempt
            && !operation.isCancelled
            && !Task.isCancelled
    }

    private static func russianMessage(for error: Error) -> String {
        guard case let LuxoraAPIError.server(status, _, message) = error else {
            if error is CancellationError { return "" }
            return "Нет связи с сервером. Проверьте сеть и повторите."
        }
        if status == 401, message.localizedCaseInsensitiveContains("current password") {
            return "Текущий пароль неверен."
        }
        if status == 401 { return "Сеанс истёк. Войдите снова." }
        if status == 409 { return "Настройка изменилась на другом устройстве. Обновите экран и повторите." }
        if status == 429 { return "Слишком много попыток. Подождите и повторите." }
        return "Сервер не сохранил настройку (код \(status))."
    }
}
