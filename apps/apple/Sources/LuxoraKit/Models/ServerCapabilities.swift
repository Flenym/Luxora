import Foundation

public struct ServerCapabilities: Equatable, Sendable {
    public struct Trust: Equatable, Sendable {
        public let profile: String
        public let contentReadableByServer: Bool
        public let endToEndEncryption: Bool

        public init(
            profile: String,
            contentReadableByServer: Bool,
            endToEndEncryption: Bool
        ) {
            self.profile = profile
            self.contentReadableByServer = contentReadableByServer
            self.endToEndEncryption = endToEndEncryption
        }
    }

    public struct Features: Equatable, Sendable {
        public let phoneAuthentication: Bool
        public let passwordAuthentication: Bool
        public let deviceSessions: Bool
        public let messaging: Bool
        public let identityAccess: Bool
        public let safetyReports: Bool
        public let realtime: Bool
        public let reconciliation: Bool
        public let mediaUploads: Bool
        public let serverSearchConfigured: Bool
        public let calls: Bool
        public let passkeys: Bool
        public let push: Bool

        public init(
            phoneAuthentication: Bool,
            passwordAuthentication: Bool,
            deviceSessions: Bool,
            messaging: Bool,
            identityAccess: Bool,
            safetyReports: Bool,
            realtime: Bool,
            reconciliation: Bool,
            mediaUploads: Bool,
            serverSearchConfigured: Bool,
            calls: Bool,
            passkeys: Bool,
            push: Bool
        ) {
            self.phoneAuthentication = phoneAuthentication
            self.passwordAuthentication = passwordAuthentication
            self.deviceSessions = deviceSessions
            self.messaging = messaging
            self.identityAccess = identityAccess
            self.safetyReports = safetyReports
            self.realtime = realtime
            self.reconciliation = reconciliation
            self.mediaUploads = mediaUploads
            self.serverSearchConfigured = serverSearchConfigured
            self.calls = calls
            self.passkeys = passkeys
            self.push = push
        }
    }

    public struct Limits: Equatable, Sendable {
        public let maxMessageCodePoints: Int
        public let maxAttachmentsPerMessage: Int
        public let maxAttachmentBytes: Int

        public init(
            maxMessageCodePoints: Int,
            maxAttachmentsPerMessage: Int,
            maxAttachmentBytes: Int
        ) {
            self.maxMessageCodePoints = maxMessageCodePoints
            self.maxAttachmentsPerMessage = maxAttachmentsPerMessage
            self.maxAttachmentBytes = maxAttachmentBytes
        }
    }

    public let trust: Trust
    public let features: Features
    public let limits: Limits

    public init(trust: Trust, features: Features, limits: Limits) {
        self.trust = trust
        self.features = features
        self.limits = limits
    }
}

public enum CapabilityLoadState: Equatable, Sendable {
    case loading
    case available(ServerCapabilities)
    case unavailable(String)

    public var capabilities: ServerCapabilities? {
        guard case let .available(capabilities) = self else { return nil }
        return capabilities
    }
}

public enum FeatureGateState: String, Equatable, Sendable {
    case available
    case limited
    case unavailable
    case checking

    public var label: String {
        switch self {
        case .available: LuxoraL10n.text("common.available")
        case .limited: LuxoraL10n.text("common.limited")
        case .unavailable: LuxoraL10n.text("common.unavailable")
        case .checking: LuxoraL10n.text("common.checking")
        }
    }
}

public struct FeatureGate: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let symbol: String
    public let state: FeatureGateState
    public let detail: String

    public init(
        id: String,
        title: String,
        symbol: String,
        state: FeatureGateState,
        detail: String
    ) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.state = state
        self.detail = detail
    }
}

public struct LuxoraFeatureMatrix: Equatable, Sendable {
    public let identityAccess: FeatureGate
    public let chats: FeatureGate
    public let communities: FeatureGate
    public let stories: FeatureGate
    public let mediaFiles: FeatureGate
    public let search: FeatureGate
    public let realtime: FeatureGate
    public let pushJobs: FeatureGate
    public let calls: FeatureGate
    public let securityE2EE: FeatureGate
    public let devices: FeatureGate
    public let settings: FeatureGate

    public var allSections: [FeatureGate] {
        [
            identityAccess,
            chats,
            communities,
            stories,
            mediaFiles,
            search,
            realtime,
            pushJobs,
            calls,
            securityE2EE,
            devices,
            settings,
        ]
    }

    public init(capabilityState: CapabilityLoadState) {
        guard case let .available(capabilities) = capabilityState else {
            let detail: String
            if case let .unavailable(message) = capabilityState {
                detail = String(
                    format: LuxoraL10n.text("feature.contract_unavailable"),
                    message
                )
            } else {
                detail = LuxoraL10n.text("feature.contract_loading")
            }
            let unknownState: FeatureGateState = capabilityState == .loading ? .checking : .unavailable
            identityAccess = FeatureGate(
                id: "identity-access",
                title: LuxoraL10n.text("feature.identity.title"),
                symbol: "person.badge.key",
                state: unknownState,
                detail: detail
            )
            chats = FeatureGate(
                id: "chats",
                title: LuxoraL10n.text("feature.chats.title"),
                symbol: "bubble.left.and.bubble.right",
                state: unknownState,
                detail: detail
            )
            communities = FeatureGate(
                id: "communities",
                title: LuxoraL10n.text("feature.communities.title"),
                symbol: "person.3",
                state: .unavailable,
                detail: LuxoraL10n.text("feature.communities.unavailable")
            )
            stories = FeatureGate(
                id: "stories",
                title: LuxoraL10n.text("feature.stories.title"),
                symbol: "circle.dashed.inset.filled",
                state: .unavailable,
                detail: LuxoraL10n.text("feature.stories.unavailable")
            )
            mediaFiles = FeatureGate(
                id: "media-files",
                title: LuxoraL10n.text("feature.media.title"),
                symbol: "paperclip",
                state: unknownState,
                detail: detail
            )
            search = FeatureGate(
                id: "search",
                title: LuxoraL10n.text("feature.search.title"),
                symbol: "magnifyingglass",
                state: unknownState,
                detail: detail
            )
            realtime = FeatureGate(
                id: "realtime",
                title: LuxoraL10n.text("feature.realtime.title"),
                symbol: "bolt.horizontal.circle",
                state: unknownState,
                detail: detail
            )
            pushJobs = FeatureGate(
                id: "push-jobs",
                title: LuxoraL10n.text("feature.push.title"),
                symbol: "bell.badge",
                state: .unavailable,
                detail: LuxoraL10n.text("feature.push.unavailable")
            )
            calls = FeatureGate(
                id: "calls",
                title: LuxoraL10n.text("feature.calls.title"),
                symbol: "phone",
                state: .unavailable,
                detail: LuxoraL10n.text("feature.calls.unavailable")
            )
            securityE2EE = FeatureGate(
                id: "security-e2ee",
                title: LuxoraL10n.text("feature.security.title"),
                symbol: "lock.shield",
                state: .unavailable,
                detail: LuxoraL10n.text("feature.security.unavailable")
            )
            devices = FeatureGate(
                id: "devices",
                title: LuxoraL10n.text("feature.devices.title"),
                symbol: "laptopcomputer.and.iphone",
                state: unknownState,
                detail: detail
            )
            settings = Self.settingsGate
            return
        }

        let features = capabilities.features
        identityAccess = FeatureGate(
            id: "identity-access",
            title: LuxoraL10n.text("feature.identity.title"),
            symbol: "person.badge.key",
            state: features.identityAccess ? .limited : .unavailable,
            detail: features.passkeys
                ? LuxoraL10n.text("feature.identity.passkey_pending")
                : LuxoraL10n.text("feature.identity.password_only")
        )
        chats = FeatureGate(
            id: "chats",
            title: LuxoraL10n.text("feature.chats.title"),
            symbol: "bubble.left.and.bubble.right",
            state: features.messaging ? .available : .unavailable,
            detail: features.messaging
                ? LuxoraL10n.text("feature.chats.available")
                : LuxoraL10n.text("feature.chats.unavailable")
        )
        communities = FeatureGate(
            id: "communities",
            title: LuxoraL10n.text("feature.communities.title"),
            symbol: "person.3",
            state: .unavailable,
            detail: LuxoraL10n.text("feature.communities.unavailable")
        )
        stories = FeatureGate(
            id: "stories",
            title: LuxoraL10n.text("feature.stories.title"),
            symbol: "circle.dashed.inset.filled",
            state: .unavailable,
            detail: LuxoraL10n.text("feature.stories.unavailable")
        )
        mediaFiles = FeatureGate(
            id: "media-files",
            title: LuxoraL10n.text("feature.media.title"),
            symbol: "paperclip",
            state: features.mediaUploads ? .limited : .unavailable,
            detail: features.mediaUploads
                ? LuxoraL10n.text("feature.media.limited")
                : LuxoraL10n.text("feature.media.unavailable")
        )
        search = FeatureGate(
            id: "search",
            title: LuxoraL10n.text("feature.search.title"),
            symbol: "magnifyingglass",
            state: features.serverSearchConfigured ? .limited : .limited,
            detail: features.serverSearchConfigured
                ? LuxoraL10n.text("feature.search.server")
                : LuxoraL10n.text("feature.search.loaded")
        )
        realtime = FeatureGate(
            id: "realtime",
            title: LuxoraL10n.text("feature.realtime.title"),
            symbol: "bolt.horizontal.circle",
            state: features.realtime ? .limited : .unavailable,
            detail: features.realtime
                ? LuxoraL10n.text("feature.realtime.limited")
                : LuxoraL10n.text("feature.realtime.unavailable")
        )
        pushJobs = FeatureGate(
            id: "push-jobs",
            title: LuxoraL10n.text("feature.push.title"),
            symbol: "bell.badge",
            state: features.push ? .limited : .unavailable,
            detail: features.push
                ? LuxoraL10n.text("feature.push.limited")
                : LuxoraL10n.text("feature.push.unavailable")
        )
        calls = FeatureGate(
            id: "calls",
            title: LuxoraL10n.text("feature.calls.title"),
            symbol: "phone",
            state: features.calls ? .limited : .unavailable,
            detail: features.calls
                ? LuxoraL10n.text("feature.calls.limited")
                : LuxoraL10n.text("feature.calls.unavailable")
        )
        securityE2EE = FeatureGate(
            id: "security-e2ee",
            title: LuxoraL10n.text("feature.security.title"),
            symbol: "lock.shield",
            state: capabilities.trust.endToEndEncryption ? .limited : .unavailable,
            detail: capabilities.trust.endToEndEncryption
                ? LuxoraL10n.text("feature.security.limited")
                : LuxoraL10n.text("feature.security.cloud")
        )
        devices = FeatureGate(
            id: "devices",
            title: LuxoraL10n.text("feature.devices.title"),
            symbol: "laptopcomputer.and.iphone",
            state: features.deviceSessions ? .limited : .unavailable,
            detail: features.deviceSessions
                ? LuxoraL10n.text("feature.devices.limited")
                : LuxoraL10n.text("feature.devices.unavailable")
        )
        settings = Self.settingsGate
    }

    private static var settingsGate: FeatureGate {
        FeatureGate(
            id: "settings",
            title: LuxoraL10n.text("feature.settings.title"),
            symbol: "gearshape",
            state: .limited,
            detail: LuxoraL10n.text("feature.settings.limited")
        )
    }
}
