import Foundation

actor SessionCredentialCoordinator {
    typealias RefreshOperation = @Sendable (String) async throws -> SessionCredentials
    typealias PersistOperation = @Sendable (SessionCredentials) throws -> Void

    private var credentials: SessionCredentials
    private let refreshOperation: RefreshOperation
    private let persistOperation: PersistOperation
    private var refreshTask: Task<SessionCredentials, Error>?
    private var refreshGeneration: UInt = 0
    private var committedRefreshGeneration: UInt?
    private var isInvalidated = false

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

    func sessionID() -> UUID {
        credentials.sessionID
    }

    func realtimeV2Cursor() -> String? {
        credentials.realtimeV2Cursor
    }

    /// Commits the opaque cursor in the same Keychain record as the
    /// device-session credentials. Actor isolation serializes this write with
    /// token rotation and invalidation.
    func commitRealtimeV2Cursor(_ cursor: String) throws {
        try Task.checkCancellation()
        guard !isInvalidated else { throw CancellationError() }
        guard RealtimeCursorValidator.isValid(cursor) else {
            throw LuxoraAPIError.invalidResponse
        }
        let updated = credentials.replacingRealtimeV2Cursor(cursor)
        try persistOperation(updated)
        credentials = updated
    }

    /// Permanently fences this session before its Keychain record is cleared.
    /// Persistence runs synchronously on this actor, so once this method
    /// returns no late refresh can write credentials for the detached session.
    func invalidate() {
        isInvalidated = true
        refreshGeneration &+= 1
        committedRefreshGeneration = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    func withAccessToken<Value: Sendable>(
        _ operation: @escaping @Sendable (String) async throws -> Value
    ) async throws -> Value {
        try Task.checkCancellation()
        guard !isInvalidated else { throw CancellationError() }
        do {
            let value = try await operation(credentials.accessToken)
            try Task.checkCancellation()
            guard !isInvalidated else { throw CancellationError() }
            return value
        } catch let error as LuxoraAPIError {
            guard error.isUnauthorized else { throw error }
            try Task.checkCancellation()
            guard !isInvalidated else { throw CancellationError() }
            let refreshedToken = try await refreshAccessToken()
            try Task.checkCancellation()
            guard !isInvalidated else { throw CancellationError() }
            let value = try await operation(refreshedToken)
            try Task.checkCancellation()
            guard !isInvalidated else { throw CancellationError() }
            return value
        }
    }

    private func refreshAccessToken() async throws -> String {
        guard !isInvalidated else { throw CancellationError() }

        let task: Task<SessionCredentials, Error>
        let generation: UInt
        if let refreshTask {
            task = refreshTask
            generation = refreshGeneration
        } else {
            refreshGeneration &+= 1
            generation = refreshGeneration
            committedRefreshGeneration = nil
            let refreshToken = credentials.refreshToken
            let refreshOperation = self.refreshOperation
            task = Task<SessionCredentials, Error> {
                try await refreshOperation(refreshToken)
            }
            refreshTask = task
        }

        do {
            let refreshed = try await task.value
            guard !isInvalidated, refreshGeneration == generation else {
                throw CancellationError()
            }

            if committedRefreshGeneration != generation {
                // This check and the synchronous Keychain write are one actor
                // turn. `invalidate()` therefore cannot pass its fence between
                // them, while an ordinary cancelled waiter cannot kill the
                // single shared refresh required by another active request.
                guard refreshed.sessionID == credentials.sessionID else {
                    throw LuxoraAPIError.invalidResponse
                }
                let merged = SessionCredentials(
                    accessToken: refreshed.accessToken,
                    refreshToken: refreshed.refreshToken,
                    sessionID: refreshed.sessionID,
                    realtimeV2Cursor: credentials.realtimeV2Cursor
                )
                try persistOperation(merged)
                credentials = merged
                committedRefreshGeneration = generation
                refreshTask = nil
            }
            return credentials.accessToken
        } catch {
            if refreshGeneration == generation,
               committedRefreshGeneration != generation {
                refreshTask = nil
            }
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
