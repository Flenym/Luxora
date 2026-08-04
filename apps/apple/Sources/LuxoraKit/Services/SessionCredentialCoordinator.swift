import Foundation

actor SessionCredentialCoordinator {
    typealias RefreshOperation = @Sendable (String) async throws -> SessionCredentials
    typealias PersistOperation = @Sendable (SessionCredentials) throws -> Void

    private var credentials: SessionCredentials
    private let refreshOperation: RefreshOperation
    private let persistOperation: PersistOperation
    private var refreshTask: Task<SessionCredentials, Error>?

    init(
        credentials: SessionCredentials,
        refreshOperation: @escaping RefreshOperation,
        persistOperation: @escaping PersistOperation
    ) {
        self.credentials = credentials
        self.refreshOperation = refreshOperation
        self.persistOperation = persistOperation
    }

    func accessToken() -> String {
        credentials.accessToken
    }

    func withAccessToken<Value: Sendable>(
        _ operation: @escaping @Sendable (String) async throws -> Value
    ) async throws -> Value {
        do {
            return try await operation(credentials.accessToken)
        } catch let error as LuxoraAPIError {
            guard error.isUnauthorized else { throw error }
            let refreshedToken = try await refreshAccessToken()
            return try await operation(refreshedToken)
        }
    }

    private func refreshAccessToken() async throws -> String {
        if let refreshTask {
            return try await refreshTask.value.accessToken
        }

        let refreshToken = credentials.refreshToken
        let refreshOperation = self.refreshOperation
        let persistOperation = self.persistOperation
        let task = Task<SessionCredentials, Error> {
            let refreshed = try await refreshOperation(refreshToken)
            try persistOperation(refreshed)
            return refreshed
        }
        refreshTask = task

        do {
            let refreshed = try await task.value
            credentials = refreshed
            refreshTask = nil
            return refreshed.accessToken
        } catch {
            refreshTask = nil
            throw error
        }
    }
}

private extension LuxoraAPIError {
    var isUnauthorized: Bool {
        if case let .server(status, _, _) = self {
            return status == 401
        }
        return false
    }
}

