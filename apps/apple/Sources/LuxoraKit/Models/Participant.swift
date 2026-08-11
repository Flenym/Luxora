import Foundation

public struct Participant: Identifiable, Hashable, Codable, Sendable {
    public let id: UUID
    public var displayName: String
    public var username: String
    public var initials: String
    public var accentHex: String
    public var isOnline: Bool
    public var status: String
    /// Authenticated, server-relative attachment endpoint. The client never
    /// treats it as a public URL and always fetches it with session credentials.
    public var avatarPath: String?

    public init(
        id: UUID,
        displayName: String,
        username: String,
        initials: String,
        accentHex: String,
        isOnline: Bool,
        status: String,
        avatarPath: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.username = username
        self.initials = initials
        self.accentHex = accentHex
        self.isOnline = isOnline
        self.status = status
        self.avatarPath = avatarPath
    }
}
