import Foundation
import Observation

/// Target-device side of QR linking (IDENTITY_ACCESS §10, client slice 1).
/// Owns challenge lifecycle: create → poll → approved/denied/expired/closed.
/// The link secret lives here for QR rendering and polling only; it is never
/// logged (see request-logging guarantees) and is dropped on reset.
public enum DeviceLinkFlowState: Equatable, Sendable {
    case idle
    case creating
    case waitingApproval(expiresAt: Date)
    case approved(shortAuthenticationString: String)
    case denied
    case expired
    case closed
    case failed(String)
}

@MainActor
@Observable
public final class DeviceLinkStore {
    public private(set) var state: DeviceLinkFlowState = .idle
    public private(set) var linkID: UUID?
    public private(set) var expiresAt: Date?

    /// QR payload for rendering (version/origin/linkId/secret). Nil unless waiting.
    public var qrContent: String? {
        guard case .waitingApproval = state,
              let linkID,
              let linkSecret
        else { return nil }
        return "luxora://device-link?linkId=\(linkID.uuidString.lowercased())&linkSecret=\(linkSecret)"
    }

    @ObservationIgnored private var linkSecret: String?
    @ObservationIgnored private var pollIntervalNanoseconds: UInt64 = 2_000_000_000
    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var pollOperation: Task<Void, Error>?

    var remoteCreator: (@Sendable (String?) async throws -> APIDeviceLinkChallenge)?
    var remotePoller: (@Sendable (UUID, String) async throws -> APIDeviceLinkStatus)?
    var remoteCloser: (@Sendable (UUID, String) async throws -> APIDeviceLinkStatus)?

    public init() {}

    func configureRemote(
        creator: @escaping @Sendable (String?) async throws -> APIDeviceLinkChallenge,
        poller: @escaping @Sendable (UUID, String) async throws -> APIDeviceLinkStatus,
        closer: (@Sendable (UUID, String) async throws -> APIDeviceLinkStatus)? = nil
    ) {
        remoteCreator = creator
        remotePoller = poller
        remoteCloser = closer
    }

    public func createChallenge(targetLabel: String?) async {
        guard let remoteCreator else {
            state = .failed("Привязка недоступна на этом подключении.")
            return
        }
        generation &+= 1
        let requestedGeneration = generation
        state = .creating
        do {
            let created = try await remoteCreator(targetLabel)
            guard generation == requestedGeneration else { return }
            linkID = created.linkId
            linkSecret = created.linkSecret
            expiresAt = created.expiresAt
            pollIntervalNanoseconds = UInt64(max(created.pollIntervalMs, 1)) * 1_000_000
            state = .waitingApproval(expiresAt: created.expiresAt)
            startPolling(generation: requestedGeneration)
        } catch is CancellationError {
            guard generation == requestedGeneration else { return }
            state = .idle
        } catch {
            guard generation == requestedGeneration else { return }
            state = .failed(error.localizedDescription)
        }
    }

    public func close() async {
        guard let linkID, let linkSecret else {
            resetToIdle()
            return
        }
        generation &+= 1
        pollOperation?.cancel()
        pollOperation = nil
        guard let remoteCloser else {
            resetToIdle()
            return
        }
        do {
            let status = try await remoteCloser(linkID, linkSecret)
            applyClosed(status: status)
        } catch is CancellationError {
            resetToIdle()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    public func resetForSessionReplacement() {
        generation &+= 1
        pollOperation?.cancel()
        pollOperation = nil
        remoteCreator = nil
        remotePoller = nil
        remoteCloser = nil
        linkID = nil
        linkSecret = nil
        expiresAt = nil
        state = .idle
    }

    private func startPolling(generation requestedGeneration: UInt) {
        pollOperation?.cancel()
        pollOperation = Task {
            while generation == requestedGeneration, !Task.isCancelled {
                try await Task.sleep(nanoseconds: pollIntervalNanoseconds)
                guard generation == requestedGeneration, !Task.isCancelled else { return }
                guard let linkID = linkID, let linkSecret = linkSecret else { return }
                guard let remotePoller = remotePoller else {
                    state = .failed("Привязка недоступна на этом подключении.")
                    return
                }
                do {
                    let status = try await remotePoller(linkID, linkSecret)
                    guard generation == requestedGeneration else { return }
                    switch status.state {
                    case "pending":
                        continue
                    case "approved":
                        state = .approved(shortAuthenticationString: status.shortAuthenticationString ?? "")
                    case "denied":
                        state = .denied
                    case "expired":
                        state = .expired
                    case "closed", "consumed":
                        state = .closed
                    default:
                        state = .failed("Неизвестное состояние привязки.")
                    }
                    return
                } catch is CancellationError {
                    return
                } catch {
                    guard generation == requestedGeneration else { return }
                    state = .failed(error.localizedDescription)
                    return
                }
            }
        }
    }

    private func applyClosed(status: APIDeviceLinkStatus) {
        switch status.state {
        case "approved":
            state = .approved(shortAuthenticationString: status.shortAuthenticationString ?? "")
        case "denied":
            state = .denied
        case "expired":
            state = .expired
        default:
            state = .closed
        }
    }

    private func resetToIdle() {
        linkID = nil
        linkSecret = nil
        expiresAt = nil
        state = .idle
    }
}
