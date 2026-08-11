import Foundation

public struct ChatPreferences: Equatable, Sendable {
    public let archivedAt: Date?
    public let mutedUntil: Date?

    public init(archivedAt: Date?, mutedUntil: Date?) {
        self.archivedAt = archivedAt
        self.mutedUntil = mutedUntil
    }

    public var isArchived: Bool { archivedAt != nil }

    public func isMuted(at date: Date = Date()) -> Bool {
        guard let mutedUntil else { return false }
        return mutedUntil > date
    }

    init(response: APIChatPreferences) {
        archivedAt = response.archivedAt
        mutedUntil = response.mutedUntil
    }
}

/// Three states are required because JSON omission and an explicit `null`
/// have different server meanings for a strict partial preference patch.
public enum ChatMutedUntilPatch: Equatable, Sendable {
    case unchanged
    case until(Date)
    case unmuted
}

public struct ChatPreferencesPatch: Encodable, Equatable, Sendable {
    public let archived: Bool?
    public let mutedUntil: ChatMutedUntilPatch

    public init(
        archived: Bool? = nil,
        mutedUntil: ChatMutedUntilPatch = .unchanged
    ) {
        self.archived = archived
        self.mutedUntil = mutedUntil
    }

    var hasChanges: Bool {
        archived != nil || mutedUntil != .unchanged
    }

    private enum CodingKeys: String, CodingKey {
        case archived
        case mutedUntil
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(archived, forKey: .archived)
        switch mutedUntil {
        case .unchanged:
            break
        case let .until(date):
            try container.encode(date, forKey: .mutedUntil)
        case .unmuted:
            try container.encodeNil(forKey: .mutedUntil)
        }
    }
}

struct APIChatPreferences: Decodable, Sendable {
    let archivedAt: Date?
    let mutedUntil: Date?
}
