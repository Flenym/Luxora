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
        // The production Beta-0.1 tunnel is the default server for installed
        // builds; local Docker/loopback previews stay available through the
        // LUXORA_API_URL / LUXORA_REALTIME_URL overrides.
        let apiURL = environment["LUXORA_API_URL"].flatMap(URL.init(string:))
            ?? URL(string: "https://luxora.cloudpub.ru")!
        let realtimeURL = environment["LUXORA_REALTIME_URL"].flatMap(URL.init(string:))
            ?? URL(string: "wss://luxora.cloudpub.ru/v2/realtime")!
        return LuxoraClientConfiguration(apiBaseURL: apiURL, realtimeURL: realtimeURL)
    }

    func realtimeURL(for version: LuxoraRealtimeProtocolVersion) throws -> URL {
        guard var components = URLComponents(url: realtimeURL, resolvingAgainstBaseURL: false),
              components.scheme == "ws" || components.scheme == "wss",
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else { throw LuxoraAPIError.invalidResponse }

        var pathComponents = components.path.split(separator: "/").map(String.init)
        if pathComponents.count >= 2,
           pathComponents[pathComponents.count - 1] == "realtime",
           ["v1", "v2"].contains(pathComponents[pathComponents.count - 2]) {
            pathComponents[pathComponents.count - 2] = version == .scopedV2 ? "v2" : "v1"
            components.path = "/" + pathComponents.joined(separator: "/")
        } else {
            components.path = version == .scopedV2 ? "/v2/realtime" : "/v1/realtime"
        }
        guard let url = components.url else { throw LuxoraAPIError.invalidResponse }
        return url
    }
}

public struct SessionCredentials: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let sessionID: UUID
    public let realtimeV2Cursor: String?

    public init(
        accessToken: String,
        refreshToken: String,
        sessionID: UUID,
        realtimeV2Cursor: String? = nil
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.sessionID = sessionID
        self.realtimeV2Cursor = realtimeV2Cursor
    }

    func replacingRealtimeV2Cursor(_ cursor: String?) -> SessionCredentials {
        SessionCredentials(
            accessToken: accessToken,
            refreshToken: refreshToken,
            sessionID: sessionID,
            realtimeV2Cursor: cursor
        )
    }
}

struct APIUser: Decodable, Sendable {
    let id: UUID
    let username: String
    let displayName: String
    let bio: String
    let avatarUrl: URL?
    let avatarPath: String?
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
            status: bio.isEmpty ? "@\(username)" : bio,
            avatarPath: avatarPath
        )
    }
}

struct APIPublicProfile: Decodable, Sendable {
    let id: UUID
    let username: String
    let displayName: String
    let bio: String
    let avatarUrl: URL?
    let avatarPath: String?

    var participant: Participant {
        Participant(
            id: id,
            displayName: displayName,
            username: username,
            initials: displayName.initials,
            accentHex: id.deterministicAccent,
            isOnline: false,
            status: bio.isEmpty ? "@\(username)" : bio,
            avatarPath: avatarPath
        )
    }
}

struct APIBlockedEntry: Decodable, Sendable {
    let accountId: UUID
    let profileSnapshot: APIPublicProfile
    let blockedAt: Date
}

struct APIPrivacySettings: Decodable, Sendable {
    let usernameDiscoverable: Bool
    let messageRequests: MessageRequestPolicy
    let lastSeen: PrivacyVisibility?
    let profilePhoto: PrivacyVisibility?
    let forwards: PrivacyVisibility?
    let voiceMessages: PrivacyVisibility?
    let calls: PrivacyVisibility?

    var snapshot: PrivacySettingsSnapshot {
        PrivacySettingsSnapshot(
            usernameDiscoverable: usernameDiscoverable,
            messageRequests: messageRequests,
            lastSeen: lastSeen ?? .everyone,
            profilePhoto: profilePhoto ?? .everyone,
            forwards: forwards ?? .everyone,
            voiceMessages: voiceMessages ?? .everyone,
            calls: calls ?? .everyone
        )
    }
}

struct APIMessageRequest: Decodable, Sendable {
    let id: UUID
    let direction: MessageRequestDirection
    let state: MessageRequestState
    let body: String
    let sender: APIPublicProfile?
    let recipient: APIPublicProfile?
    let createdAt: Date
    let expiresAt: Date
    let acceptedAt: Date?

    func item() throws -> MessageRequestItem {
        let profile: APIPublicProfile
        switch direction {
        case .incoming:
            guard let sender else { throw LuxoraAPIError.invalidResponse }
            profile = sender
        case .outgoing:
            guard let recipient else { throw LuxoraAPIError.invalidResponse }
            profile = recipient
        }
        return MessageRequestItem(
            id: id,
            direction: direction,
            state: state,
            body: body,
            participant: profile.participant,
            createdAt: createdAt,
            expiresAt: expiresAt
        )
    }
}

struct APIAcceptMessageRequestResponse: Decodable, Sendable {
    let request: APIMessageRequest
    let chat: APIChat
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

struct APIDeviceSession: Decodable, Sendable {
    let id: UUID
    let deviceName: String
    let createdAt: Date
    let lastSeenAt: Date
    let expiresAt: Date
    let current: Bool

    var deviceSession: DeviceSession {
        DeviceSession(
            id: id,
            deviceName: deviceName,
            createdAt: createdAt,
            lastSeenAt: lastSeenAt,
            expiresAt: expiresAt,
            isCurrent: current
        )
    }
}

struct APIUploadAttachment: Decodable, Sendable {
    let id: UUID
    let kind: String?
    let fileName: String?
    let mimeType: String
    let sizeBytes: Int
    let downloadPath: String
    let createdAt: Date
    let metadataWidth: Int?
    let metadataHeight: Int?
    let metadataDurationMs: Int?
    let metadataWaveform: [Int]?

    private enum CodingKeys: String, CodingKey {
        case id
        case kind
        case fileName
        case mimeType
        case sizeBytes
        case downloadPath
        case createdAt
        case metadata
    }

    private struct APIMetadata: Decodable, Sendable {
        let width: Int?
        let height: Int?
        let durationMs: Int?
        let waveform: [Int]?
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        fileName = try container.decodeIfPresent(String.self, forKey: .fileName)
        mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType) ?? "application/octet-stream"
        sizeBytes = try container.decodeIfPresent(Int.self, forKey: .sizeBytes) ?? 0
        downloadPath = try container.decodeIfPresent(String.self, forKey: .downloadPath) ?? ""
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? .distantPast
        let metadata = try container.decodeIfPresent(APIMetadata.self, forKey: .metadata)
        metadataWidth = metadata?.width
        metadataHeight = metadata?.height
        metadataDurationMs = metadata?.durationMs
        metadataWaveform = metadata?.waveform
    }

    func attachment() -> MessageAttachment {
        MessageAttachment(
            id: id,
            kind: kind ?? "file",
            fileName: fileName ?? id.uuidString.lowercased(),
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            downloadPath: downloadPath,
            imageWidth: metadataWidth,
            imageHeight: metadataHeight,
            durationMs: metadataDurationMs,
            waveform: metadataWaveform
        )
    }
}

struct APISearchAttachment: Decodable, Sendable {
    let id: UUID
    let kind: String
    let fileName: String
    let mimeType: String
    let sizeBytes: Int
    let downloadPath: String
    let safetyStatus: String
    let createdAt: Date

    var globalSearchResult: GlobalFileSearchResult {
        GlobalFileSearchResult(
            id: id,
            kind: kind,
            fileName: fileName,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            downloadPath: downloadPath,
            safetyStatus: safetyStatus,
            createdAt: createdAt
        )
    }
}

struct APIUploadSession: Decodable, Sendable {
    enum Status: String, Decodable, Sendable {
        case active
        case completing
        case completed
        case failed
        case expired
    }

    let id: UUID
    let status: Status
    let fileName: String
    let sizeBytes: Int
    let chunkSizeBytes: Int
    let receivedBytes: Int
    let receivedChunkIndexes: [Int]
    let expiresAt: Date
    let attachment: APIUploadAttachment?
    let failureCode: String?
}

struct APIUploadResponse: Decodable, Sendable {
    let upload: APIUploadSession
}

struct APIUserResponse: Decodable, Sendable {
    let user: APIUser
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

public struct PhonePasswordChallenge: Equatable, Sendable {
    public let passwordToken: String
    public let maskedPhone: String
    public let expiresAt: Date

    init(response: APIPhonePasswordChallenge) {
        passwordToken = response.passwordToken
        maskedPhone = response.maskedPhone
        expiresAt = response.expiresAt
    }

    #if DEBUG
    static let uiTestPreview = PhonePasswordChallenge(
        passwordToken: "luxpw_\(String(repeating: "p", count: 43))",
        maskedPhone: "+7 ••• •••-42-18",
        expiresAt: .distantFuture
    )

    private init(passwordToken: String, maskedPhone: String, expiresAt: Date) {
        self.passwordToken = passwordToken
        self.maskedPhone = maskedPhone
        self.expiresAt = expiresAt
    }
    #endif
}

public enum PhoneCodeVerificationResult: Equatable, Sendable {
    case authenticated
    case profileRequired(PhoneRegistrationChallenge)
    case passwordRequired(PhonePasswordChallenge)
    case bindingRequired(PhoneBindingGrant)
}

public struct PhoneRecoveryIntent: Equatable, Sendable {
    public let recoveryToken: String
    public let maskedPhone: String
    public let confirmAt: Date
    public let expiresAt: Date

    init(response: APIPhoneRecoveryStarted) {
        recoveryToken = response.recoveryToken
        maskedPhone = response.maskedPhone
        confirmAt = response.confirmAt
        expiresAt = response.expiresAt
    }
}

public struct PhoneBindingGrant: Equatable, Sendable {
    public let bindingToken: String
    public let maskedPhone: String
    public let expiresAt: Date

    init(response: APIPhoneBindingVerified) {
        bindingToken = response.bindingToken
        maskedPhone = response.maskedPhone
        expiresAt = response.expiresAt
    }
}

public struct PhonePasswordStatus: Equatable, Sendable {
    public let eligible: Bool
    public let enabled: Bool

    init(response: APIPhonePasswordStatus) {
        eligible = response.eligible
        enabled = response.enabled
    }
}

public enum APNSPushEnvironment: String, Codable, Equatable, Sendable {
    case development
    case production

    /// Keeps the compile-time APNs endpoint choice identical in the app and in
    /// lifecycle tests. The signed entitlement is independently configured by
    /// `APS_ENVIRONMENT` in the Xcode project.
    public static var currentApplicationBuild: Self {
        #if DEBUG
        environment(forDebugBuild: true)
        #else
        environment(forDebugBuild: false)
        #endif
    }

    static func environment(forDebugBuild isDebugBuild: Bool) -> Self {
        isDebugBuild ? .development : .production
    }
}

public struct PushRegistration: Equatable, Sendable {
    public let id: UUID
    public let environment: APNSPushEnvironment
    public let topic: String
    public let createdAt: Date
    public let updatedAt: Date

    init(response: APIPushRegistration) {
        id = response.id
        environment = response.environment
        topic = response.topic
        createdAt = response.createdAt
        updatedAt = response.updatedAt
    }
}

public enum NotificationPreviewMode: String, Codable, CaseIterable, Equatable, Sendable {
    case hidden
    case sender
    case full

    public var title: String {
        switch self {
        case .hidden: "Скрыт"
        case .sender: "Только отправитель"
        case .full: "Полный текст"
        }
    }
}

public struct NotificationSettings: Equatable, Sendable {
    public let messageAlerts: Bool
    public let messageRequestAlerts: Bool
    public let mentionAlerts: Bool
    public let groupAlerts: Bool
    public let channelAlerts: Bool
    public let storyAlerts: Bool
    public let reactionAlerts: Bool
    public let sound: Bool
    public let badge: Bool
    public let previewMode: NotificationPreviewMode
    public let updatedAt: Date

    init(response: APINotificationSettings) {
        messageAlerts = response.messageAlerts
        messageRequestAlerts = response.messageRequestAlerts
        mentionAlerts = response.mentionAlerts
        groupAlerts = response.groupAlerts
        channelAlerts = response.channelAlerts
        storyAlerts = response.storyAlerts
        reactionAlerts = response.reactionAlerts
        sound = response.sound
        badge = response.badge
        previewMode = response.previewMode
        updatedAt = response.updatedAt
    }
}

public struct NotificationSettingsPatch: Encodable, Equatable, Sendable {
    public let messageAlerts: Bool?
    public let messageRequestAlerts: Bool?
    public let mentionAlerts: Bool?
    public let groupAlerts: Bool?
    public let channelAlerts: Bool?
    public let storyAlerts: Bool?
    public let reactionAlerts: Bool?
    public let sound: Bool?
    public let badge: Bool?
    public let previewMode: NotificationPreviewMode?

    public init(
        messageAlerts: Bool? = nil,
        messageRequestAlerts: Bool? = nil,
        mentionAlerts: Bool? = nil,
        groupAlerts: Bool? = nil,
        channelAlerts: Bool? = nil,
        storyAlerts: Bool? = nil,
        reactionAlerts: Bool? = nil,
        sound: Bool? = nil,
        badge: Bool? = nil,
        previewMode: NotificationPreviewMode? = nil
    ) {
        self.messageAlerts = messageAlerts
        self.messageRequestAlerts = messageRequestAlerts
        self.mentionAlerts = mentionAlerts
        self.groupAlerts = groupAlerts
        self.channelAlerts = channelAlerts
        self.storyAlerts = storyAlerts
        self.reactionAlerts = reactionAlerts
        self.sound = sound
        self.badge = badge
        self.previewMode = previewMode
    }

    var hasChanges: Bool {
        messageAlerts != nil
            || messageRequestAlerts != nil
            || mentionAlerts != nil
            || groupAlerts != nil
            || channelAlerts != nil
            || storyAlerts != nil
            || reactionAlerts != nil
            || sound != nil
            || badge != nil
            || previewMode != nil
    }
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

struct APIPhonePasswordChallenge: Decodable, Sendable {
    let passwordToken: String
    let maskedPhone: String
    let expiresAt: Date
}

struct APIPhonePasswordStatus: Decodable, Sendable {
    let eligible: Bool
    let enabled: Bool
}

struct APIPhoneRecoveryStarted: Decodable, Sendable {
    let recoveryToken: String
    let maskedPhone: String
    let confirmAt: Date
    let expiresAt: Date
}

struct APIPhoneBindingVerified: Decodable, Sendable {
    let bindingToken: String
    let maskedPhone: String
    let expiresAt: Date
}

struct APIPhoneBindingCompleted: Decodable, Sendable {    let phonePassword: APIPhonePasswordStatus
}

struct APIScheduledMessage: Decodable, Sendable {
    let id: UUID
    let chatId: UUID
    let body: String
    let replyToMessageId: UUID?
    let topicId: UUID?
    let sendAt: Date
    let state: String
    let failureCode: String?
    let createdAt: Date

    func scheduled() -> ScheduledMessage {
        ScheduledMessage(
            id: id,
            chatId: chatId,
            body: body,
            replyToMessageId: replyToMessageId,
            topicId: topicId,
            sendAt: sendAt,
            state: state,
            failureCode: failureCode,
            createdAt: createdAt
        )
    }
}

public struct ScheduledMessage: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let chatId: UUID
    public let body: String
    public let replyToMessageId: UUID?
    public let topicId: UUID?
    public let sendAt: Date
    public let state: String
    public let failureCode: String?
    public let createdAt: Date
}

struct APIPushRegistration: Decodable, Sendable {
    let id: UUID
    let platform: String
    let environment: APNSPushEnvironment
    let topic: String
    let createdAt: Date
    let updatedAt: Date
}

struct APINotificationSettings: Decodable, Sendable {
    let messageAlerts: Bool
    let messageRequestAlerts: Bool
    let mentionAlerts: Bool
    let groupAlerts: Bool
    let channelAlerts: Bool
    let storyAlerts: Bool
    let reactionAlerts: Bool
    let sound: Bool
    let badge: Bool
    let previewMode: NotificationPreviewMode
    let updatedAt: Date

    init(
        messageAlerts: Bool,
        messageRequestAlerts: Bool,
        mentionAlerts: Bool,
        groupAlerts: Bool = true,
        channelAlerts: Bool = true,
        storyAlerts: Bool = true,
        reactionAlerts: Bool = true,
        sound: Bool,
        badge: Bool,
        previewMode: NotificationPreviewMode,
        updatedAt: Date
    ) {
        self.messageAlerts = messageAlerts
        self.messageRequestAlerts = messageRequestAlerts
        self.mentionAlerts = mentionAlerts
        self.groupAlerts = groupAlerts
        self.channelAlerts = channelAlerts
        self.storyAlerts = storyAlerts
        self.reactionAlerts = reactionAlerts
        self.sound = sound
        self.badge = badge
        self.previewMode = previewMode
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case messageAlerts
        case messageRequestAlerts
        case mentionAlerts
        case groupAlerts
        case channelAlerts
        case storyAlerts
        case reactionAlerts
        case sound
        case badge
        case previewMode
        case updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageAlerts = try container.decode(Bool.self, forKey: .messageAlerts)
        messageRequestAlerts = try container.decode(Bool.self, forKey: .messageRequestAlerts)
        mentionAlerts = try container.decode(Bool.self, forKey: .mentionAlerts)
        // Pre-031 servers omit category toggles: default to true like the backend.
        groupAlerts = try container.decodeIfPresent(Bool.self, forKey: .groupAlerts) ?? true
        channelAlerts = try container.decodeIfPresent(Bool.self, forKey: .channelAlerts) ?? true
        storyAlerts = try container.decodeIfPresent(Bool.self, forKey: .storyAlerts) ?? true
        reactionAlerts = try container.decodeIfPresent(Bool.self, forKey: .reactionAlerts) ?? true
        sound = try container.decode(Bool.self, forKey: .sound)
        badge = try container.decode(Bool.self, forKey: .badge)
        previewMode = try container.decode(NotificationPreviewMode.self, forKey: .previewMode)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }
}

struct APIPhoneUsernameAvailability: Decodable, Sendable {
    let username: String
    let available: Bool
    let suggestions: [String]
}

enum APIPhoneCodeVerificationResult: Decodable, Sendable {
    case authenticated(APIAuthResponse)
    case profileRequired(APIPhoneRegistrationChallenge)
    case passwordRequired(APIPhonePasswordChallenge)
    case bindingVerified(APIPhoneBindingVerified)

    private enum CodingKeys: String, CodingKey {
        case status
        case user
        case tokens
        case registrationToken
        case passwordToken
        case bindingToken
        case maskedPhone
        case expiresAt
    }

    private enum Status: String, Decodable {
        case authenticated
        case profileRequired = "profile_required"
        case passwordRequired = "password_required"
        case bindingVerified = "binding_verified"
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
        case .passwordRequired:
            self = .passwordRequired(
                APIPhonePasswordChallenge(
                    passwordToken: try container.decode(String.self, forKey: .passwordToken),
                    maskedPhone: try container.decode(String.self, forKey: .maskedPhone),
                    expiresAt: try container.decode(Date.self, forKey: .expiresAt)
                )
            )
        case .bindingVerified:
            self = .bindingVerified(
                APIPhoneBindingVerified(
                    bindingToken: try container.decode(String.self, forKey: .bindingToken),
                    maskedPhone: try container.decode(String.self, forKey: .maskedPhone),
                    expiresAt: try container.decode(Date.self, forKey: .expiresAt)
                )
            )
        }
    }
}

struct APIAttachment: Decodable, Sendable {
    let id: UUID
    let kind: String
    let fileName: String
    let mimeType: String
    let sizeBytes: Int
    let downloadPath: String
    let width: Int?
    let height: Int?
    let durationMs: Int?
    let waveform: [Int]?

    private enum CodingKeys: String, CodingKey {
        case id
        case kind
        case fileName
        case mimeType
        case sizeBytes
        case downloadPath
        case metadata
    }

    private struct APIMediaMetadata: Decodable, Sendable {
        let width: Int?
        let height: Int?
        let durationMs: Int?
        let waveform: [Int]?
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        fileName = try container.decode(String.self, forKey: .fileName)
        mimeType = try container.decode(String.self, forKey: .mimeType)
        sizeBytes = try container.decode(Int.self, forKey: .sizeBytes)
        downloadPath = try container.decode(String.self, forKey: .downloadPath)
        let metadata = try container.decodeIfPresent(APIMediaMetadata.self, forKey: .metadata)
        width = metadata?.width
        height = metadata?.height
        durationMs = metadata?.durationMs
        waveform = metadata?.waveform
    }

    func attachment() -> MessageAttachment {
        MessageAttachment(
            id: id,
            kind: kind,
            fileName: fileName,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            downloadPath: downloadPath,
            imageWidth: width,
            imageHeight: height,
            durationMs: durationMs,
            waveform: waveform
        )
    }
}

struct APIForwardProvenance: Decodable, Sendable {
    let senderDisplayName: String
    let originalCreatedAt: Date

    var messageProvenance: MessageForwardProvenance {
        MessageForwardProvenance(
            senderDisplayName: senderDisplayName,
            originalCreatedAt: originalCreatedAt
        )
    }
}

struct APIMessage: Decodable, Sendable {
    let id: UUID
    let chatId: UUID
    let sender: APIUser
    let kind: String
    let body: String?
    let replyToMessageId: UUID?
    let topicId: UUID?
    let forwardedFrom: APIForwardProvenance?
    let isPinned: Bool
    let clientNonce: UUID
    let revision: Int
    let createdAt: Date
    let updatedAt: Date
    let editedAt: Date?
    let deletedAt: Date?
    let attachments: [APIAttachment]?
    let transcriptionAllowed: Bool
    let transcript: String?

    init(
        id: UUID,
        chatId: UUID,
        sender: APIUser,
        kind: String,
        body: String?,
        replyToMessageId: UUID?,
        topicId: UUID?,
        forwardedFrom: APIForwardProvenance?,
        isPinned: Bool,
        clientNonce: UUID,
        revision: Int,
        createdAt: Date,
        updatedAt: Date,
        editedAt: Date?,
        deletedAt: Date?,
        attachments: [APIAttachment]? = nil,
        transcriptionAllowed: Bool = false,
        transcript: String? = nil
    ) {
        self.id = id
        self.chatId = chatId
        self.sender = sender
        self.kind = kind
        self.body = body
        self.replyToMessageId = replyToMessageId
        self.topicId = topicId
        self.forwardedFrom = forwardedFrom
        self.isPinned = isPinned
        self.clientNonce = clientNonce
        self.revision = revision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.editedAt = editedAt
        self.deletedAt = deletedAt
        self.attachments = attachments
        self.transcriptionAllowed = transcriptionAllowed
        self.transcript = transcript
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case chatId
        case sender
        case kind
        case body
        case replyToMessageId
        case topicId
        case forwardedFrom
        case isPinned
        case clientNonce
        case revision
        case createdAt
        case updatedAt
        case editedAt
        case deletedAt
        case attachments
        case transcriptionAllowed
        case transcript
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        chatId = try container.decode(UUID.self, forKey: .chatId)
        sender = try container.decode(APIUser.self, forKey: .sender)
        kind = try container.decode(String.self, forKey: .kind)
        body = try container.decodeIfPresent(String.self, forKey: .body)
        replyToMessageId = try container.decodeIfPresent(UUID.self, forKey: .replyToMessageId)
        topicId = try container.decodeIfPresent(UUID.self, forKey: .topicId)
        forwardedFrom = try container.decodeIfPresent(APIForwardProvenance.self, forKey: .forwardedFrom)
        isPinned = try container.decode(Bool.self, forKey: .isPinned)
        clientNonce = try container.decode(UUID.self, forKey: .clientNonce)
        revision = try container.decode(Int.self, forKey: .revision)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        editedAt = try container.decodeIfPresent(Date.self, forKey: .editedAt)
        deletedAt = try container.decodeIfPresent(Date.self, forKey: .deletedAt)
        attachments = try container.decodeIfPresent([APIAttachment].self, forKey: .attachments)
        transcriptionAllowed = try container.decodeIfPresent(Bool.self, forKey: .transcriptionAllowed) ?? false
        transcript = try container.decodeIfPresent(String.self, forKey: .transcript)
    }

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
            isOutgoing: sender.id == currentUserID,
            attachments: (attachments ?? []).map { $0.attachment() },
            transcriptionAllowed: transcriptionAllowed,
            transcript: transcript
        )
    }

    func snapshot(currentUserID: UUID) -> RemoteMessageSnapshot {
        RemoteMessageSnapshot(
            message: message(currentUserID: currentUserID),
            metadata: MessageRemoteMetadata(
                revision: revision,
                replyToMessageID: replyToMessageId,
                forwardedFrom: forwardedFrom?.messageProvenance,
                isPinned: isPinned,
                isDeleted: deletedAt != nil
            )
        )
    }

    var globalSearchResult: GlobalMessageSearchResult {
        GlobalMessageSearchResult(
            id: id,
            conversationID: chatId,
            sender: sender.participant,
            text: deletedAt == nil ? (body ?? "") : LuxoraL10n.text("model.message_deleted"),
            createdAt: createdAt
        )
    }
}

struct APIMessagePin: Decodable, Sendable {
    let chatId: UUID
    let messageId: UUID
    let pinnedBy: APIUser
    let pinnedAt: Date
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
    let archivedAt: Date?
    let mutedUntil: Date?

    var preferences: ChatPreferences {
        ChatPreferences(archivedAt: archivedAt, mutedUntil: mutedUntil)
    }

    func conversation(currentUserID: UUID, now: Date = Date()) -> Conversation {
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
            isMuted: mutedUntil.map { $0 > now } ?? false,
            mutedUntil: mutedUntil,
            isPinned: false,
            isTyping: false,
            isArchived: archivedAt != nil,
            lastActivity: lastActivityAt,
            folder: kind == "direct" ? "personal" : "work",
            serverRole: role
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
        let chatFolders: Bool
        let mediaUploads: Bool
        let serverSearchConfigured: Bool
        let calls: Bool
        let passkeys: Bool
        let push: Bool
        let drafts: Bool?
    }

    struct Limits: Decodable, Sendable {
        let maxMessageCodePoints: Int
        let maxAttachmentsPerMessage: Int
        let maxAttachmentBytes: Int
        let maxChatFolders: Int
        let maxChatFolderTitleLength: Int
        let maxChatFolderOverrides: Int
        let chatFolderIdempotencyTtlSeconds: Int
        let maxChatFolderActiveCommandReceipts: Int
        let maxDraftCodePoints: Int?
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
        let advertisedRealtime = versions.realtime
        let supported = advertisedRealtime.supported
        guard schemaVersion == 1,
              identityContractVersion == 1,
              versions.http.contains(1),
              !versions.reconciliation.isEmpty,
              Set(versions.reconciliation).count == versions.reconciliation.count,
              versions.reconciliation.allSatisfy({ $0 > 0 }),
              !supported.isEmpty,
              Set(supported).count == supported.count,
              supported.allSatisfy({ $0 > 0 }),
              supported.contains(advertisedRealtime.preferred),
              supported.contains(advertisedRealtime.minimum),
              compatibility.additiveResponseFields == "ignore",
              compatibility.unknownMutationFields == "reject",
              compatibility.securityCriticalIncompatibility == "required_upgrade",
              compatibility.realtimeBelowMinimum == "no_downgrade",
              features.chatFolders,
              limits.maxChatFolders == ChatFolderContract.maximumFolders,
              limits.maxChatFolderTitleLength == ChatFolderContract.maximumTitleCodePoints,
              limits.maxChatFolderOverrides == ChatFolderContract.maximumOverrides,
              limits.chatFolderIdempotencyTtlSeconds == ChatFolderContract.idempotencyTTLSeconds,
              limits.maxChatFolderActiveCommandReceipts
                == ChatFolderContract.maximumActiveCommandReceipts,
              !((features.drafts ?? false)
                && limits.maxDraftCodePoints != SynchronizedChatDraft.maximumTextCodePoints)
        else {
            throw LuxoraAPIError.incompatibleServer
        }

        let clientSupported = Set([1, 2])
        let compatible = supported.filter {
            clientSupported.contains($0)
                && $0 >= advertisedRealtime.minimum
                && ($0 != 2 || (features.reconciliation && versions.reconciliation.contains(2)))
        }
        guard let selectedRaw = (
            compatible.contains(advertisedRealtime.preferred)
                ? advertisedRealtime.preferred
                : compatible.max()
        ),
              let selectedRealtime = LuxoraRealtimeProtocolVersion(rawValue: selectedRaw)
        else { throw LuxoraAPIError.incompatibleServer }
        if features.drafts ?? false {
            guard features.realtime,
                  features.reconciliation,
                  versions.reconciliation.contains(2),
                  selectedRealtime == .scopedV2
            else { throw LuxoraAPIError.incompatibleServer }
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
                chatFolders: features.chatFolders,
                mediaUploads: features.mediaUploads,
                serverSearchConfigured: features.serverSearchConfigured,
                calls: features.calls,
                passkeys: features.passkeys,
                push: features.push,
                drafts: features.drafts ?? false
            ),
            limits: .init(
                maxMessageCodePoints: limits.maxMessageCodePoints,
                maxAttachmentsPerMessage: limits.maxAttachmentsPerMessage,
                maxAttachmentBytes: limits.maxAttachmentBytes,
                maxChatFolders: limits.maxChatFolders,
                maxChatFolderTitleLength: limits.maxChatFolderTitleLength,
                maxChatFolderOverrides: limits.maxChatFolderOverrides,
                chatFolderIdempotencyTTLSeconds: limits.chatFolderIdempotencyTtlSeconds,
                maxChatFolderActiveCommandReceipts: limits.maxChatFolderActiveCommandReceipts,
                maxDraftCodePoints: (features.drafts ?? false) ? limits.maxDraftCodePoints : nil
            ),
            realtimeProtocolVersion: selectedRealtime
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
    case syncUnstable
    case server(status: Int, code: String, message: String)
    case transport(String)
    case missingSession

    var errorDescription: String? {
        switch self {
        case .invalidResponse: LuxoraL10n.text("error.invalid_response")
        case .incompatibleServer: LuxoraL10n.text("error.incompatible_server")
        case .syncUnstable: "Состояние менялось во время синхронизации. Повторите ещё раз."
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
