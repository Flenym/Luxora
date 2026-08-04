import Foundation

public enum AppSheet: String, Identifiable, Sendable {
    case newConversation
    case profile
    case settings

    public var id: String { rawValue }
}

public enum ConnectionState: Equatable, Sendable {
    case offline
    case connecting
    case online
    case degraded(String)

    public var label: String {
        switch self {
        case .offline: LuxoraL10n.text("connection.offline")
        case .connecting: LuxoraL10n.text("connection.connecting")
        case .online: LuxoraL10n.text("connection.online")
        case .degraded: LuxoraL10n.text("connection.reconnecting")
        }
    }
}
