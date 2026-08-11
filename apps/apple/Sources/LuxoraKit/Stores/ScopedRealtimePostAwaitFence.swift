import Foundation

/// Revalidates the authenticated projection after an awaited durable write.
/// Session A may be replaced while its cursor persistence is suspended; in
/// that case no continuation from A may publish sequence or store state into B.
@MainActor
enum ScopedRealtimePostAwaitFence {
    @discardableResult
    static func run(
        operation: @escaping @Sendable () async throws -> Void,
        stillOwnsSession: () -> Bool,
        publish: () throws -> Void
    ) async throws -> Bool {
        try await operation()
        guard isActive(stillOwnsSession: stillOwnsSession) else { return false }
        try publish()
        return true
    }

    static func isActive(stillOwnsSession: () -> Bool) -> Bool {
        !Task.isCancelled && stillOwnsSession()
    }
}
