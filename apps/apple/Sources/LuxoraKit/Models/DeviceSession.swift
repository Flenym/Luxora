import Foundation

public struct DeviceSession: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let deviceName: String
    public let createdAt: Date
    public let lastSeenAt: Date
    public let expiresAt: Date
    public let isCurrent: Bool

    public init(
        id: UUID,
        deviceName: String,
        createdAt: Date,
        lastSeenAt: Date,
        expiresAt: Date,
        isCurrent: Bool
    ) {
        self.id = id
        self.deviceName = deviceName
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.expiresAt = expiresAt
        self.isCurrent = isCurrent
    }
}
