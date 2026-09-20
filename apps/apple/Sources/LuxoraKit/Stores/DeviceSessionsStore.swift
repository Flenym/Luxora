import Foundation
import Observation

@MainActor
@Observable
public final class DeviceSessionsStore {
    public private(set) var sessions: [DeviceSession]
    public private(set) var loadState: RemoteContentState
    public private(set) var revocationStates: [UUID: RemoteContentState] = [:]
    public private(set) var terminateOthersState: RemoteContentState = .idle

    var remoteLoader: (@Sendable () async throws -> [DeviceSession])?
    var remoteRevoker: (@Sendable (UUID) async throws -> Void)?
    var remoteOthersTerminator: (@Sendable () async throws -> [UUID])?

    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var loadAttempt: UInt = 0
    @ObservationIgnored private var loadOperation: Task<[DeviceSession], Error>?
    @ObservationIgnored private var revokeOperations: [UUID: Task<Void, Error>] = [:]
    @ObservationIgnored private var terminateOthersOperation: Task<[UUID], Error>?

    public init(sessions: [DeviceSession] = [], loadState: RemoteContentState = .idle) {
        self.sessions = Self.sorted(sessions)
        self.loadState = loadState
    }

    public func refresh(force: Bool = false) async {
        guard let remoteLoader else {
            loadState = .failed("Серверный список устройств не настроен.")
            return
        }
        guard force || loadState != .loading else { return }

        let operationGeneration = generation
        loadAttempt &+= 1
        let operationAttempt = loadAttempt
        let operation = Task { try await remoteLoader() }
        loadOperation?.cancel()
        loadOperation = operation
        loadState = .loading

        do {
            let loaded = try await operation.value
            guard generation == operationGeneration,
                  loadAttempt == operationAttempt,
                  !operation.isCancelled,
                  !Task.isCancelled
            else { return }
            sessions = Self.sorted(loaded)
            loadState = .loaded
            loadOperation = nil
        } catch is CancellationError {
            guard generation == operationGeneration, loadAttempt == operationAttempt else { return }
            loadState = sessions.isEmpty ? .idle : .loaded
            loadOperation = nil
        } catch {
            guard generation == operationGeneration, loadAttempt == operationAttempt else { return }
            if Self.isUnauthorized(error) {
                sessions.removeAll()
                revocationStates.removeAll()
            }
            loadState = .failed(error.localizedDescription)
            loadOperation = nil
        }
    }

    @discardableResult
    public func revoke(_ sessionID: UUID) async -> Bool {
        guard let target = sessions.first(where: { $0.id == sessionID }), !target.isCurrent else {
            return false
        }
        guard let remoteRevoker, let remoteLoader else {
            revocationStates[sessionID] = .failed("Завершение удалённого сеанса не настроено.")
            return false
        }
        guard revocationStates[sessionID] != .loading else { return false }

        let operationGeneration = generation
        let operation = Task { try await remoteRevoker(sessionID) }
        revokeOperations[sessionID]?.cancel()
        revokeOperations[sessionID] = operation
        revocationStates[sessionID] = .loading

        do {
            try await operation.value
            guard accepts(operation, generation: operationGeneration) else { return false }
            acceptRevocation(sessionID)
            return true
        } catch is CancellationError {
            guard generation == operationGeneration else { return false }
            revocationStates[sessionID] = .idle
            revokeOperations[sessionID] = nil
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            if Self.isUnauthorized(error) {
                clearSessionsAfterAuthenticationFailure(error)
                return false
            }
            // DELETE may have committed before its response was lost. Re-read
            // the authoritative list: absence proves success; presence keeps an
            // exact retry available without inventing a local revocation.
            do {
                let reconciled = try await remoteLoader()
                guard accepts(operation, generation: operationGeneration) else { return false }
                if !reconciled.contains(where: { $0.id == sessionID }) {
                    acceptRevocation(sessionID)
                    return true
                }
            } catch is CancellationError {
                guard generation == operationGeneration else { return false }
                revocationStates[sessionID] = .idle
                revokeOperations[sessionID] = nil
                return false
            } catch {
                if Self.isUnauthorized(error) {
                    clearSessionsAfterAuthenticationFailure(error)
                    return false
                }
                // Preserve the original DELETE error below. A failed recovery
                // read cannot prove whether the command committed.
            }
            revocationStates[sessionID] = .failed(error.localizedDescription)
            revokeOperations[sessionID] = nil
            return false
        }
    }

    func configureRemote(
        loader: @escaping @Sendable () async throws -> [DeviceSession],
        revoker: @escaping @Sendable (UUID) async throws -> Void,
        othersTerminator: (@Sendable () async throws -> [UUID])? = nil
    ) {
        remoteLoader = loader
        remoteRevoker = revoker
        remoteOthersTerminator = othersTerminator
    }

    /// Terminates every session except the current one via the containment
    /// endpoint. Returns true when the server-confirmed revoked ids are gone
    /// locally; on transport failure reconciles against a fresh list, same
    /// as single-session revocation.
    @discardableResult
    public func terminateOtherSessions() async -> Bool {
        guard let remoteOthersTerminator, let remoteLoader else {
            terminateOthersState = .failed("Серверное завершение недоступно в этом сеансе.")
            return false
        }
        guard terminateOthersState != .loading else { return false }
        guard sessions.contains(where: { !$0.isCurrent }) else { return true }

        let operationGeneration = generation
        let operation = Task { try await remoteOthersTerminator() }
        terminateOthersOperation?.cancel()
        terminateOthersOperation = operation
        terminateOthersState = .loading

        do {
            let revoked = try await operation.value
            guard acceptsOthers(operation, generation: operationGeneration) else { return false }
            acceptOthersTermination(revoked)
            return true
        } catch is CancellationError {
            guard generation == operationGeneration else { return false }
            terminateOthersState = .idle
            terminateOthersOperation = nil
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            if Self.isUnauthorized(error) {
                clearSessionsAfterAuthenticationFailure(error)
                terminateOthersState = .failed(error.localizedDescription)
                terminateOthersOperation = nil
                return false
            }
            do {
                let reconciled = try await remoteLoader()
                guard acceptsOthers(operation, generation: operationGeneration) else { return false }
                if !reconciled.contains(where: { !$0.isCurrent }) {
                    sessions = Self.sorted(reconciled)
                    terminateOthersState = .loaded
                    terminateOthersOperation = nil
                    return true
                }
            } catch is CancellationError {
                guard generation == operationGeneration else { return false }
                terminateOthersState = .idle
                terminateOthersOperation = nil
                return false
            } catch {
                if Self.isUnauthorized(error) {
                    clearSessionsAfterAuthenticationFailure(error)
                    terminateOthersState = .failed(error.localizedDescription)
                    terminateOthersOperation = nil
                    return false
                }
            }
            terminateOthersState = .failed(error.localizedDescription)
            terminateOthersOperation = nil
            return false
        }
    }

    func cancelRemoteOperations() {
        generation &+= 1
        loadOperation?.cancel()
        loadOperation = nil
        revokeOperations.values.forEach { $0.cancel() }
        revokeOperations.removeAll()
        terminateOthersOperation?.cancel()
        terminateOthersOperation = nil
        if loadState == .loading { loadState = sessions.isEmpty ? .idle : .loaded }
        revocationStates = revocationStates.mapValues { state in
            state == .loading ? .idle : state
        }
        if terminateOthersState == .loading { terminateOthersState = .idle }
    }

    private func acceptsOthers(_ operation: Task<[UUID], Error>, generation operationGeneration: UInt) -> Bool {
        generation == operationGeneration && !operation.isCancelled && !Task.isCancelled
    }

    private func acceptOthersTermination(_ revoked: [UUID]) {
        let revokedIDs = Set(revoked)
        sessions.removeAll { revokedIDs.contains($0.id) }
        terminateOthersState = .loaded
        terminateOthersOperation = nil
    }

    private func accepts(_ operation: Task<Void, Error>, generation operationGeneration: UInt) -> Bool {
        generation == operationGeneration && !operation.isCancelled && !Task.isCancelled
    }

    private func acceptRevocation(_ sessionID: UUID) {
        sessions.removeAll { $0.id == sessionID }
        revocationStates[sessionID] = nil
        revokeOperations[sessionID] = nil
    }

    private func clearSessionsAfterAuthenticationFailure(_ error: Error) {
        sessions.removeAll()
        loadState = .failed(error.localizedDescription)
        revocationStates.removeAll()
        revokeOperations.removeAll()
    }

    private static func isUnauthorized(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return status == 401
    }

    private static func sorted(_ sessions: [DeviceSession]) -> [DeviceSession] {
        sessions.sorted { lhs, rhs in
            if lhs.isCurrent != rhs.isCurrent { return lhs.isCurrent }
            if lhs.lastSeenAt != rhs.lastSeenAt { return lhs.lastSeenAt > rhs.lastSeenAt }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }
}
