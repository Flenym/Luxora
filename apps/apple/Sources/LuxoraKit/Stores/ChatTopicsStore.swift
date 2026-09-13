import Foundation
import Observation

/// Server-backed topic (thread) management for group/channel chats.
///
/// The store owns loading plus create/rename/close mutations per chat and
/// surfaces honest loading/error states. Composer topic selection and history
/// filtering build on top of this state in a follow-up slice.
@MainActor
@Observable
public final class ChatTopicsStore {
    public private(set) var topicsByChat: [UUID: [ChatTopic]] = [:]
    public private(set) var loadStates: [UUID: RemoteContentState] = [:]
    public private(set) var mutationState: RemoteContentState = .idle
    public private(set) var mutationError: String?

    var remoteLoader: (@Sendable (UUID) async throws -> [ChatTopic])?
    var remoteCreator: (@Sendable (UUID, String) async throws -> ChatTopic)?
    var remoteUpdater: (@Sendable (UUID, UUID, String?, Bool?) async throws -> ChatTopic)?

    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var loadOperations: [UUID: Task<[ChatTopic], Error>] = [:]
    @ObservationIgnored private var mutationOperation: Task<ChatTopic, Error>?

    public init() {}

    public func topics(for chatID: UUID) -> [ChatTopic] {
        topicsByChat[chatID, default: []]
    }

    public func loadState(for chatID: UUID) -> RemoteContentState {
        loadStates[chatID] ?? .idle
    }

    public func refresh(chatID: UUID, force: Bool = false) async {
        guard let remoteLoader else {
            loadStates[chatID] = .failed("Загрузка тем не подключена.")
            return
        }
        if !force, let current = loadStates[chatID], current == .loading {
            return
        }
        let operationGeneration = generation
        let operation = Task { try await remoteLoader(chatID) }
        loadOperations[chatID]?.cancel()
        loadOperations[chatID] = operation
        loadStates[chatID] = .loading
        do {
            let loaded = try await operation.value
            guard generation == operationGeneration,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return }
            topicsByChat[chatID] = loaded.sorted { $0.createdAt < $1.createdAt }
            loadStates[chatID] = .loaded
            loadOperations[chatID] = nil
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            if loadStates[chatID] == .loading {
                loadStates[chatID] = topicsByChat[chatID] == nil ? .idle : .loaded
            }
            loadOperations[chatID] = nil
        } catch {
            guard generation == operationGeneration else { return }
            loadStates[chatID] = .failed(Self.russianMessage(for: error))
            loadOperations[chatID] = nil
        }
    }

    @discardableResult
    public func create(chatID: UUID, title: String) async -> Bool {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty, normalizedTitle.count <= 120 else {
            mutationError = "Название темы — от 1 до 120 символов."
            return false
        }
        guard let remoteCreator else {
            mutationError = "Создание тем не подключено."
            return false
        }
        return await mutate {
            let created = try await remoteCreator(chatID, normalizedTitle)
            guard created.chatID == chatID else {
                throw LuxoraAPIError.invalidResponse
            }
            return created
        }
    }

    @discardableResult
    public func rename(chatID: UUID, topicID: UUID, title: String) async -> Bool {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty, normalizedTitle.count <= 120 else {
            mutationError = "Название темы — от 1 до 120 символов."
            return false
        }
        guard let remoteUpdater else {
            mutationError = "Изменение тем не подключено."
            return false
        }
        return await mutate {
            let updated = try await remoteUpdater(chatID, topicID, normalizedTitle, nil)
            guard updated.id == topicID, updated.chatID == chatID else {
                throw LuxoraAPIError.invalidResponse
            }
            return updated
        }
    }

    @discardableResult
    public func setClosed(chatID: UUID, topicID: UUID, closed: Bool) async -> Bool {
        guard let remoteUpdater else {
            mutationError = "Изменение тем не подключено."
            return false
        }
        return await mutate {
            let updated = try await remoteUpdater(chatID, topicID, nil, closed)
            guard updated.id == topicID, updated.chatID == chatID else {
                throw LuxoraAPIError.invalidResponse
            }
            return updated
        }
    }

    public func clearMutationError() {
        mutationError = nil
        if case .failed = mutationState { mutationState = .idle }
    }

    func configureRemote(
        loader: @escaping @Sendable (UUID) async throws -> [ChatTopic],
        creator: @escaping @Sendable (UUID, String) async throws -> ChatTopic,
        updater: @escaping @Sendable (UUID, UUID, String?, Bool?) async throws -> ChatTopic
    ) {
        remoteLoader = loader
        remoteCreator = creator
        remoteUpdater = updater
    }

    func cancelRemoteOperations() {
        generation &+= 1
        for operation in loadOperations.values { operation.cancel() }
        mutationOperation?.cancel()
        loadOperations.removeAll()
        mutationOperation = nil
        for (chatID, state) in loadStates where state == .loading {
            loadStates[chatID] = topicsByChat[chatID] == nil ? .idle : .loaded
        }
        if mutationState == .loading { mutationState = .idle }
    }

    @discardableResult
    private func mutate(_ remote: @escaping @Sendable () async throws -> ChatTopic) async -> Bool {
        guard mutationState != .loading else { return false }
        let operationGeneration = generation
        let operation = Task { try await remote() }
        mutationOperation?.cancel()
        mutationOperation = operation
        mutationState = .loading
        mutationError = nil
        do {
            let updated = try await operation.value
            guard generation == operationGeneration,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return false }
            var items = topicsByChat[updated.chatID, default: []]
            if let index = items.firstIndex(where: { $0.id == updated.id }) {
                items[index] = updated
            } else {
                items.append(updated)
            }
            topicsByChat[updated.chatID] = items.sorted { $0.createdAt < $1.createdAt }
            mutationState = .loaded
            mutationOperation = nil
            return true
        } catch is CancellationError {
            guard generation == operationGeneration else { return false }
            mutationState = .idle
            mutationOperation = nil
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            mutationState = .failed(Self.russianMessage(for: error))
            mutationError = Self.russianMessage(for: error)
            mutationOperation = nil
            return false
        }
    }

    private static func russianMessage(for error: Error) -> String {
        guard case let LuxoraAPIError.server(status, _, _) = error else {
            if error is CancellationError { return "" }
            if error is LuxoraAPIError { return "Сервер вернул неожиданные темы." }
            return "Нет связи с сервером. Проверьте сеть и повторите."
        }
        if status == 401 { return "Сеанс истёк. Войдите снова." }
        if status == 403 { return "Управлять темами могут владельцы и администраторы." }
        if status == 404 { return "Чат или тема не найдены." }
        if status == 409 { return "Темы изменились. Обновите список." }
        if status == 429 { return "Слишком много изменений. Подождите и повторите." }
        return "Сервер не сохранил тему (код \(status))."
    }
}
