import Foundation

public struct LuxoraClientConfiguration: Sendable {
    public let apiBaseURL: URL
    public let realtimeURL: URL

    public init(apiBaseURL: URL, realtimeURL: URL) {
        self.apiBaseURL = apiBaseURL
        self.realtimeURL = realtimeURL
    }

    public static var development: LuxoraClientConfiguration {
        let environment = ProcessInfo.processInfo.environment
        let apiURL = environment["LUXORA_API_URL"].flatMap(URL.init(string:))
            ?? URL(string: "http://127.0.0.1:8080")!
        let realtimeURL = environment["LUXORA_REALTIME_URL"].flatMap(URL.init(string:))
            ?? URL(string: "ws://127.0.0.1:8080/v1/realtime")!
        return LuxoraClientConfiguration(apiBaseURL: apiURL, realtimeURL: realtimeURL)
    }
}

public struct SessionCredentials: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let sessionID: UUID

    public init(accessToken: String, refreshToken: String, sessionID: UUID) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.sessionID = sessionID
    }
}

struct APIUser: Decodable, Sendable {
    let id: UUID
    let username: String
    let displayName: String
    let bio: String
    let avatarUrl: URL?
    let createdAt: Date
    let presence: String?
    let lastSeenAt: Date?

    var participant: Participant {
        Participant(
            id: id,
            displayName: displayName,
            username: username,
            initials: displayName.initials,
            accentHex: id.deterministicAccent,
            isOnline: presence == "online",
            status: bio.isEmpty ? "@\(username)" : bio
        )
    }
}

struct APITokens: Decodable, Sendable {
    let accessToken: String
    let refreshToken: String
    let tokenType: String
    let expiresIn: Int
    let sessionId: UUID

    var credentials: SessionCredentials {
        SessionCredentials(accessToken: accessToken, refreshToken: refreshToken, sessionID: sessionId)
    }
}

struct APIAuthResponse: Decodable, Sendable {
    let user: APIUser
    let tokens: APITokens
}

public struct PhoneCodeChallenge: Equatable, Sendable {
    public let challengeID: String
    public let maskedPhone: String
    public let expiresAt: Date
    public let retryAfterSeconds: Int

    init(response: APIPhoneCodeChallenge) {
        challengeID = response.challengeId
        maskedPhone = response.maskedPhone
        expiresAt = response.expiresAt
        retryAfterSeconds = response.retryAfterSeconds
    }

    #if DEBUG
    static let uiTestPreview = PhoneCodeChallenge(
        challengeID: "debug-ui-test-phone-challenge",
        maskedPhone: "+7 ••• •••-42-18",
        expiresAt: .distantFuture,
        retryAfterSeconds: 30
    )

    private init(challengeID: String, maskedPhone: String, expiresAt: Date, retryAfterSeconds: Int) {
        self.challengeID = challengeID
        self.maskedPhone = maskedPhone
        self.expiresAt = expiresAt
        self.retryAfterSeconds = retryAfterSeconds
    }
    #endif
}

public struct PhoneRegistrationChallenge: Equatable, Sendable {
    public let registrationToken: String
    public let maskedPhone: String
    public let expiresAt: Date

    init(response: APIPhoneRegistrationChallenge) {
        registrationToken = response.registrationToken
        maskedPhone = response.maskedPhone
        expiresAt = response.expiresAt
    }

    #if DEBUG
    static let uiTestPreview = PhoneRegistrationChallenge(
        registrationToken: "debug-ui-test-registration-token",
        maskedPhone: "+7 ••• •••-42-18",
        expiresAt: .distantFuture
    )

    private init(registrationToken: String, maskedPhone: String, expiresAt: Date) {
        self.registrationToken = registrationToken
        self.maskedPhone = maskedPhone
        self.expiresAt = expiresAt
    }
    #endif
}

public enum PhoneCodeVerificationResult: Equatable, Sendable {
    case authenticated
    case profileRequired(PhoneRegistrationChallenge)
}

public struct PhoneUsernameAvailability: Equatable, Sendable {
    public let username: String
    public let isAvailable: Bool
    public let suggestions: [String]

    init(response: APIPhoneUsernameAvailability) {
        username = response.username
        isAvailable = response.available
        suggestions = Array(response.suggestions.prefix(5))
    }
}

struct APIPhoneCodeChallenge: Decodable, Sendable {
    let challengeId: String
    let maskedPhone: String
    let expiresAt: Date
    let retryAfterSeconds: Int
}

struct APIPhoneRegistrationChallenge: Decodable, Sendable {
    let registrationToken: String
    let maskedPhone: String
    let expiresAt: Date
}

struct APIPhoneUsernameAvailability: Decodable, Sendable {
    let username: String
    let available: Bool
    let suggestions: [String]
}

enum APIPhoneCodeVerificationResult: Decodable, Sendable {
    case authenticated(APIAuthResponse)
    case profileRequired(APIPhoneRegistrationChallenge)

    private enum CodingKeys: String, CodingKey {
        case status
        case user
        case tokens
        case registrationToken
        case maskedPhone
        case expiresAt
    }

    private enum Status: String, Decodable {
        case authenticated
        case profileRequired = "profile_required"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Status.self, forKey: .status) {
        case .authenticated:
            self = .authenticated(
                APIAuthResponse(
                    user: try container.decode(APIUser.self, forKey: .user),
                    tokens: try container.decode(APITokens.self, forKey: .tokens)
                )
            )
        case .profileRequired:
            self = .profileRequired(
                APIPhoneRegistrationChallenge(
                    registrationToken: try container.decode(String.self, forKey: .registrationToken),
                    maskedPhone: try container.decode(String.self, forKey: .maskedPhone),
                    expiresAt: try container.decode(Date.self, forKey: .expiresAt)
                )
            )
        }
    }
}

struct APIMessage: Decodable, Sendable {
    let id: UUID
    let chatId: UUID
    let sender: APIUser
    let kind: String
    let body: String?
    let replyToMessageId: UUID?
    let clientNonce: UUID
    let revision: Int
    let createdAt: Date
    let updatedAt: Date
    let editedAt: Date?
    let deletedAt: Date?

    func message(currentUserID: UUID) -> ChatMessage {
        ChatMessage(
            id: id,
            clientID: clientNonce,
            conversationID: chatId,
            author: sender.participant,
            text: deletedAt == nil ? (body ?? "") : LuxoraL10n.text("model.message_deleted"),
            sentAt: createdAt,
            editedAt: editedAt,
            delivery: .sent,
            isOutgoing: sender.id == currentUserID
        )
    }
}

struct APIReactionSummary: Decodable, Sendable {
    let emoji: String
    let count: Int
    let reactedByMe: Bool

    var reaction: MessageReaction {
        MessageReaction(emoji: emoji, count: count, isMine: reactedByMe)
    }
}

struct APIChat: Decodable, Sendable {
    let id: UUID
    let kind: String
    let title: String
    let avatarUrl: URL?
    let role: String
    let memberCount: Int
    let lastMessage: APIMessage?
    let lastActivityAt: Date
    let createdAt: Date
    let unreadCount: Int

    func conversation(currentUserID: UUID) -> Conversation {
        let participant = Participant(
            id: id,
            displayName: title,
            username: title.lowercased().replacingOccurrences(of: " ", with: "-"),
            initials: title.initials,
            accentHex: id.deterministicAccent,
            isOnline: false,
            status: kind == "channel"
                ? LuxoraL10n.text("model.channel")
                : String(format: LuxoraL10n.text("model.members_count"), memberCount)
        )
        return Conversation(
            id: id,
            title: title,
            subtitle: lastMessage?.body ?? LuxoraL10n.text("model.no_messages"),
            kind: ConversationKind(rawValue: kind) ?? .group,
            avatar: participant,
            memberCount: memberCount,
            unreadCount: unreadCount,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: lastActivityAt,
            folder: kind == "direct" ? "personal" : "work"
        )
    }
}

struct APIList<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
    let nextCursor: String?
}

struct APICapabilities: Decodable, Sendable {
    struct Versions: Decodable, Sendable {
        struct Realtime: Decodable, Sendable {
            let supported: [Int]
            let preferred: Int
            let minimum: Int
        }

        let http: [Int]
        let reconciliation: [Int]
        let realtime: Realtime
    }

    struct Trust: Decodable, Sendable {
        let profile: String
        let contentReadableByServer: Bool
        let endToEndEncryption: Bool
    }

    struct Features: Decodable, Sendable {
        let phoneAuthentication: Bool
        let passwordAuthentication: Bool
        let deviceSessions: Bool
        let messaging: Bool
        let identityAccess: Bool
        let safetyReports: Bool
        let realtime: Bool
        let reconciliation: Bool
        let mediaUploads: Bool
        let serverSearchConfigured: Bool
        let calls: Bool
        let passkeys: Bool
        let push: Bool
    }

    struct Limits: Decodable, Sendable {
        let maxMessageCodePoints: Int
        let maxAttachmentsPerMessage: Int
        let maxAttachmentBytes: Int
    }

    struct Compatibility: Decodable, Sendable {
        let additiveResponseFields: String
        let unknownMutationFields: String
        let securityCriticalIncompatibility: String
        let realtimeBelowMinimum: String
    }

    let schemaVersion: Int
    let versions: Versions
    let identityContractVersion: Int
    let trust: Trust
    let features: Features
    let limits: Limits
    let compatibility: Compatibility

    func validated() throws -> ServerCapabilities {
        guard schemaVersion == 1,
              identityContractVersion == 1,
              versions.http.contains(1),
              versions.realtime.supported.contains(1),
              versions.realtime.minimum <= 1,
              compatibility.additiveResponseFields == "ignore",
              compatibility.unknownMutationFields == "reject",
              compatibility.securityCriticalIncompatibility == "required_upgrade",
              compatibility.realtimeBelowMinimum == "no_downgrade"
        else {
            throw LuxoraAPIError.incompatibleServer
        }

        return ServerCapabilities(
            trust: .init(
                profile: trust.profile,
                contentReadableByServer: trust.contentReadableByServer,
                endToEndEncryption: trust.endToEndEncryption
            ),
            features: .init(
                phoneAuthentication: features.phoneAuthentication,
                passwordAuthentication: features.passwordAuthentication,
                deviceSessions: features.deviceSessions,
                messaging: features.messaging,
                identityAccess: features.identityAccess,
                safetyReports: features.safetyReports,
                realtime: features.realtime,
                reconciliation: features.reconciliation,
                mediaUploads: features.mediaUploads,
                serverSearchConfigured: features.serverSearchConfigured,
                calls: features.calls,
                passkeys: features.passkeys,
                push: features.push
            ),
            limits: .init(
                maxMessageCodePoints: limits.maxMessageCodePoints,
                maxAttachmentsPerMessage: limits.maxAttachmentsPerMessage,
                maxAttachmentBytes: limits.maxAttachmentBytes
            )
        )
    }
}

struct APIErrorEnvelope: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        let code: String
        let message: String
        let requestId: String?
    }
    let error: Payload
}

enum LuxoraAPIError: LocalizedError, Sendable {
    case invalidResponse
    case incompatibleServer
    case server(status: Int, code: String, message: String)
    case transport(String)
    case missingSession

    var errorDescription: String? {
        switch self {
        case .invalidResponse: LuxoraL10n.text("error.invalid_response")
        case .incompatibleServer: LuxoraL10n.text("error.incompatible_server")
        case let .server(status, code, _):
            "\(LuxoraL10n.text("error.server_rejected")) \(code) (\(status))."
        case .transport: LuxoraL10n.text("error.transport")
        case .missingSession: LuxoraL10n.text("error.missing_session")
        }
    }
}

private extension String {
    var initials: String {
        split(separator: " ")
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
            .uppercased()
    }
}

private extension UUID {
    var deterministicAccent: String {
        let palette = ["2F1893", "373ABF", "5C3FB7", "7C48D4", "181FB2"]
        let index = uuidString.utf8.reduce(0) { ($0 + Int($1)) % palette.count }
        return palette[index]
    }
}
