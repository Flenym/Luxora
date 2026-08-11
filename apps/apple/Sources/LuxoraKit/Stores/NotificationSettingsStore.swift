import Foundation
import Observation

@MainActor
@Observable
public final class NotificationSettingsStore {
    public private(set) var settings: NotificationSettings?
    public private(set) var loadState: RemoteContentState = .idle
    public private(set) var mutationState: RemoteContentState = .idle

    var remoteLoader: (@Sendable () async throws -> NotificationSettings)?
    var remoteUpdater: (@Sendable (NotificationSettingsPatch) async throws -> NotificationSettings)?

    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var loadAttempt: UInt = 0
    @ObservationIgnored private var mutationAttempt: UInt = 0
    @ObservationIgnored private var loadOperation: Task<NotificationSettings, Error>?
    @ObservationIgnored private var mutationOperation: Task<NotificationSettings, Error>?

    public init(settings: NotificationSettings? = nil) {
        self.settings = settings
        if settings != nil { loadState = .loaded }
    }

    public func refresh(force: Bool = false) async {
        guard let remoteLoader else {
            loadState = .failed("Серверные настройки уведомлений не подключены.")
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
            guard generation == operationGeneration,
                  loadAttempt == attempt,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return }
            settings = loaded
            loadState = .loaded
            loadOperation = nil
        } catch is CancellationError {
            guard generation == operationGeneration, loadAttempt == attempt else { return }
            loadState = settings == nil ? .idle : .loaded
            loadOperation = nil
        } catch {
            guard generation == operationGeneration, loadAttempt == attempt else { return }
            if Self.isUnauthorized(error) { settings = nil }
            loadState = .failed(Self.russianMessage(for: error))
            loadOperation = nil
        }
    }

    @discardableResult
    public func update(_ patch: NotificationSettingsPatch) async -> Bool {
        guard patch.hasChanges else { return false }
        guard let remoteUpdater else {
            mutationState = .failed("Сохранение настроек уведомлений не подключено.")
            return false
        }
        guard mutationState != .loading else { return false }

        let operationGeneration = generation
        mutationAttempt &+= 1
        let attempt = mutationAttempt
        let operation = Task { try await remoteUpdater(patch) }
        mutationOperation?.cancel()
        mutationOperation = operation
        mutationState = .loading

        do {
            let updated = try await operation.value
            guard generation == operationGeneration,
                  mutationAttempt == attempt,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return false }
            settings = updated
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
            if Self.isUnauthorized(error) {
                settings = nil
                loadState = .failed(Self.russianMessage(for: error))
            }
            mutationState = .failed(Self.russianMessage(for: error))
            mutationOperation = nil
            return false
        }
    }

    public func clearMutationFailure() {
        if case .failed = mutationState { mutationState = .idle }
    }

    func configureRemote(
        loader: @escaping @Sendable () async throws -> NotificationSettings,
        updater: @escaping @Sendable (NotificationSettingsPatch) async throws -> NotificationSettings
    ) {
        remoteLoader = loader
        remoteUpdater = updater
    }

    func cancelRemoteOperations() {
        generation &+= 1
        loadOperation?.cancel()
        mutationOperation?.cancel()
        loadOperation = nil
        mutationOperation = nil
        if loadState == .loading { loadState = settings == nil ? .idle : .loaded }
        if mutationState == .loading { mutationState = .idle }
    }

    private static func isUnauthorized(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return status == 401
    }

    private static func russianMessage(for error: Error) -> String {
        guard case let LuxoraAPIError.server(status, _, _) = error else {
            if error is CancellationError { return "" }
            return "Нет связи с сервером. Проверьте сеть и повторите."
        }
        if status == 401 { return "Сеанс истёк. Войдите снова." }
        if status == 409 { return "Настройки изменились на другом устройстве. Обновите экран." }
        if status == 429 { return "Слишком много изменений. Подождите и повторите." }
        return "Сервер не сохранил настройки (код \(status))."
    }
}

@MainActor
@Observable
public final class PushRegistrationStore {
    public private(set) var registration: PushRegistration?
    public private(set) var state: RemoteContentState = .idle

    var remoteLoader: (@Sendable () async throws -> PushRegistration?)?
    var remoteRegistrar: (@Sendable (String, APNSPushEnvironment) async throws -> PushRegistration)?
    var remoteUnregistrar: (@Sendable () async throws -> Void)?

    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var attempt: UInt = 0
    @ObservationIgnored private var operation: Task<PushRegistration?, Error>?

    public init(registration: PushRegistration? = nil) {
        self.registration = registration
        if registration != nil { state = .loaded }
    }

    public func refresh(force: Bool = false) async {
        guard let remoteLoader else {
            state = .failed("Регистрация уведомлений не подключена.")
            return
        }
        guard force || state != .loading else { return }
        await perform { try await remoteLoader() }
    }

    @discardableResult
    public func register(
        deviceToken: Data,
        environment: APNSPushEnvironment
    ) async -> Bool {
        guard (16...512).contains(deviceToken.count) else {
            state = .failed("iPhone вернул некорректный токен уведомлений.")
            return false
        }
        guard let remoteRegistrar else {
            state = .failed("Регистрация уведомлений не подключена.")
            return false
        }
        let hexadecimalToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        return await perform {
            try await remoteRegistrar(hexadecimalToken, environment)
        }
    }

    @discardableResult
    public func unregister() async -> Bool {
        guard let remoteUnregistrar else {
            state = .failed("Отключение регистрации уведомлений не подключено.")
            return false
        }
        return await perform {
            try await remoteUnregistrar()
            return nil
        }
    }

    public func recordSystemRegistrationFailure() {
        generation &+= 1
        operation?.cancel()
        operation = nil
        state = .failed("iPhone не выдал токен уведомлений. Проверьте настройки и повторите.")
    }

    func configureRemote(
        loader: @escaping @Sendable () async throws -> PushRegistration?,
        registrar: @escaping @Sendable (String, APNSPushEnvironment) async throws -> PushRegistration,
        unregistrar: @escaping @Sendable () async throws -> Void
    ) {
        remoteLoader = loader
        remoteRegistrar = registrar
        remoteUnregistrar = unregistrar
    }

    func cancelRemoteOperations() {
        generation &+= 1
        operation?.cancel()
        operation = nil
        if state == .loading { state = registration == nil ? .idle : .loaded }
    }

    @discardableResult
    private func perform(
        _ remoteOperation: @escaping @Sendable () async throws -> PushRegistration?
    ) async -> Bool {
        generation &+= 1
        let operationGeneration = generation
        attempt &+= 1
        let operationAttempt = attempt
        let nextOperation = Task { try await remoteOperation() }
        operation?.cancel()
        operation = nextOperation
        state = .loading

        do {
            let loaded = try await nextOperation.value
            guard generation == operationGeneration,
                  attempt == operationAttempt,
                  !nextOperation.isCancelled,
                  !Task.isCancelled
            else { return false }
            registration = loaded
            state = .loaded
            operation = nil
            return true
        } catch is CancellationError {
            guard generation == operationGeneration, attempt == operationAttempt else { return false }
            state = registration == nil ? .idle : .loaded
            operation = nil
            return false
        } catch {
            guard generation == operationGeneration, attempt == operationAttempt else { return false }
            if Self.isUnauthorized(error) { registration = nil }
            state = .failed(Self.russianMessage(for: error))
            operation = nil
            return false
        }
    }

    private static func isUnauthorized(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return status == 401
    }

    private static func russianMessage(for error: Error) -> String {
        guard case let LuxoraAPIError.server(status, _, _) = error else {
            if error is CancellationError { return "" }
            return "Нет связи с сервером. Токен будет отправлен при следующей синхронизации."
        }
        if status == 401 { return "Сеанс истёк. Войдите снова." }
        if status == 429 { return "Слишком много обновлений токена. Повторим позже." }
        return "Сервер не принял регистрацию уведомлений (код \(status))."
    }
}
