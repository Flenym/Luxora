import Foundation
import Observation

public enum ApplicationPhase: Equatable, Sendable {
    case restoring
    case restorationFailed
    case unauthenticated
    case authenticated
}

public enum ApplicationPresentationState: Equatable, Sendable {
    case restoring
    case unauthenticated
    case connecting
    case connected
    case offline
    case error(String)

    init(
        phase: ApplicationPhase,
        connectionState: ConnectionState?,
        errorMessage: String?
    ) {
        switch phase {
        case .restoring:
            self = .restoring
        case .restorationFailed:
            self = .error(errorMessage ?? LuxoraL10n.text("error.saved_session_restore"))
        case .unauthenticated:
            self = .unauthenticated
        case .authenticated:
            switch connectionState {
            case .connecting:
                self = .connecting
            case .online:
                self = .connected
            case .offline:
                self = .offline
            case let .degraded(message):
                self = .error(message)
            case nil:
                self = .error(LuxoraL10n.text("error.authenticated_state_missing"))
            }
        }
    }
}

@MainActor
@Observable
public final class ApplicationSession {
    public private(set) var phase: ApplicationPhase = .restoring
    public private(set) var messengerStore: MessengerStore?
    public private(set) var capabilityState: CapabilityLoadState = .loading
    public private(set) var isWorking = false
    public private(set) var isAuthenticationSyncing = false
    public var errorMessage: String?

    public let configuration: LuxoraClientConfiguration

    public var presentationState: ApplicationPresentationState {
        ApplicationPresentationState(
            phase: phase,
            connectionState: messengerStore?.connectionState,
            errorMessage: errorMessage
        )
    }

    public var featureMatrix: LuxoraFeatureMatrix {
        LuxoraFeatureMatrix(capabilityState: capabilityState)
    }

    private let api: LuxoraAPIClient
    private let realtime: LuxoraRealtimeClient
    private let keychain: KeychainSessionStore
    private var credentialCoordinator: SessionCredentialCoordinator?
    private var currentUserID: UUID?
    private var realtimeSequence: Int?
    private var realtimeTask: Task<Void, Never>?

    public init(configuration: LuxoraClientConfiguration = .development) {
        self.configuration = configuration
        api = LuxoraAPIClient(configuration: configuration)
        realtime = LuxoraRealtimeClient(configuration: configuration)
        keychain = KeychainSessionStore()
    }

    public func restore() async {
        guard phase == .restoring else {
            // Debug UI evidence may explicitly clear the Keychain before this
            // SwiftUI task starts. Authentication must still resolve the real
            // server capability contract instead of remaining in `.loading`.
            if phase == .unauthenticated, capabilityState == .loading {
                await refreshCapabilities()
            }
            return
        }
        await refreshCapabilities()
        do {
            guard let stored = try keychain.load() else {
                phase = .unauthenticated
                return
            }
            try await bootstrap(credentials: stored)
        } catch is CancellationError {
            // SwiftUI owns the restoration task. If its view disappears, leave
            // the phase restartable and never discard a valid saved session.
            return
        } catch let error as LuxoraAPIError {
            if case let .server(status, _, _) = error, status == 401 {
                try? keychain.clear()
                errorMessage = LuxoraL10n.text("error.saved_session_expired")
                phase = .unauthenticated
                return
            }
            errorMessage = String(
                format: LuxoraL10n.text("error.session_restore_failed"),
                error.localizedDescription
            )
            phase = .restorationFailed
        } catch {
            // A local Keychain/credential decoding failure cannot recover by
            // retrying the same bytes. Network and server failures above keep
            // the refresh token so a later retry does not silently sign out.
            try? keychain.clear()
            errorMessage = String(
                format: LuxoraL10n.text("error.session_restore_failed"),
                error.localizedDescription
            )
            phase = .unauthenticated
        }
    }

    public func retryRestoration() async {
        guard phase == .restorationFailed else { return }
        errorMessage = nil
        phase = .restoring
        await restore()
    }

    public func discardRestoredSession() {
        messengerStore?.cancelRemoteOperations()
        cancelRealtime(resetSequence: true)
        try? keychain.clear()
        credentialCoordinator = nil
        currentUserID = nil
        messengerStore = nil
        errorMessage = nil
        phase = .unauthenticated
    }

    public func login(username: String, password: String) async {
        await authenticate {
            try await self.api.login(
                username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password,
                deviceName: ProcessInfo.processInfo.hostName
            )
        }
    }

    public func register(username: String, displayName: String, password: String) async {
        await authenticate {
            try await self.api.register(
                username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password,
                deviceName: ProcessInfo.processInfo.hostName
            )
        }
    }

    public func requestPhoneCode(countryCode: String, nationalNumber: String) async -> PhoneCodeChallenge? {
        guard phase == .unauthenticated, !isWorking else { return nil }
        // The UI renders a familiar `+7`, while the strict server contract
        // deliberately accepts only the country-calling digits (`7`).
        let normalizedCountryCode = countryCode.filter(\.isNumber)
        let normalizedNationalNumber = nationalNumber.filter(\.isNumber)
        guard (1...3).contains(normalizedCountryCode.count),
              (4...14).contains(normalizedNationalNumber.count),
              (7...15).contains(normalizedCountryCode.count + normalizedNationalNumber.count)
        else {
            errorMessage = LuxoraL10n.text("auth.phone_invalid")
            return nil
        }

        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let response = try await api.requestPhoneCode(
                countryCode: normalizedCountryCode,
                nationalNumber: normalizedNationalNumber,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: .clientNonceV4()
            )
            return PhoneCodeChallenge(response: response)
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = error.localizedDescription
            phase = .unauthenticated
            return nil
        }
    }

    public func verifyPhoneCode(challengeID: String, code: String) async -> PhoneCodeVerificationResult? {
        guard phase == .unauthenticated, !isWorking else { return nil }
        let normalizedCode = code.filter(\.isNumber)
        guard !challengeID.isEmpty, normalizedCode.count == 6 else {
            errorMessage = LuxoraL10n.text("auth.code_invalid")
            return nil
        }

        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            switch try await api.verifyPhoneCode(
                challengeID: challengeID,
                code: normalizedCode,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: .clientNonceV4()
            ) {
            case let .authenticated(response):
                return await finishAuthentication(response) ? .authenticated : nil
            case let .profileRequired(response):
                return .profileRequired(PhoneRegistrationChallenge(response: response))
            }
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = error.localizedDescription
            phase = .unauthenticated
            return nil
        }
    }

    public func completePhoneRegistration(
        registrationToken: String,
        displayName: String,
        username: String,
        bio: String
    ) async -> Bool {
        guard phase == .unauthenticated, !isWorking else { return false }
        let normalizedDisplayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedBio = String(bio.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        guard !registrationToken.isEmpty,
              (1...80).contains(normalizedDisplayName.count),
              Self.isValidUsername(normalizedUsername)
        else {
            errorMessage = LuxoraL10n.text("auth.display_name_invalid")
            return false
        }

        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let response = try await api.completePhoneRegistration(
                registrationToken: registrationToken,
                displayName: normalizedDisplayName,
                username: normalizedUsername,
                bio: normalizedBio,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: .clientNonceV4()
            )
            return await finishAuthentication(response)
        } catch is CancellationError {
            return false
        } catch {
            errorMessage = error.localizedDescription
            phase = .unauthenticated
            return false
        }
    }

    public func checkPhoneUsername(
        registrationToken: String,
        username: String
    ) async -> PhoneUsernameAvailability? {
        guard phase == .unauthenticated, !registrationToken.isEmpty else { return nil }
        let normalizedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.isValidUsername(normalizedUsername) else { return nil }

        do {
            let response = try await api.checkPhoneUsername(
                registrationToken: registrationToken,
                username: normalizedUsername
            )
            return PhoneUsernameAvailability(response: response)
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private static func isValidUsername(_ username: String) -> Bool {
        guard (3...32).contains(username.count),
              username.first?.isLetter == true,
              username.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") })
        else { return false }
        return true
    }

    public func signOut() async {
        messengerStore?.cancelRemoteOperations()
        cancelRealtime(resetSequence: true)
        if let credentialCoordinator {
            try? await credentialCoordinator.withAccessToken { [api] token in
                try await api.revokeCurrentSession(token: token)
            }
        }
        try? keychain.clear()
        credentialCoordinator = nil
        currentUserID = nil
        messengerStore = nil
        errorMessage = nil
        phase = .unauthenticated
    }

    private func authenticate(operation: () async throws -> APIAuthResponse) async {
        guard phase == .unauthenticated, !isWorking else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        if capabilityState.capabilities == nil {
            await refreshCapabilities()
        }
        do {
            let response = try await operation()
            _ = await finishAuthentication(response)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
            phase = .unauthenticated
        }
    }

    private func finishAuthentication(_ response: APIAuthResponse) async -> Bool {
        isAuthenticationSyncing = true
        defer { isAuthenticationSyncing = false }
        do {
            try keychain.save(response.tokens.credentials)
            do {
                try await bootstrap(
                    credentials: response.tokens.credentials,
                    authenticatedUser: response.user
                )
                return true
            } catch is CancellationError {
                return false
            } catch let error as LuxoraAPIError {
                if case let .server(status, _, _) = error, status == 401 {
                    try? keychain.clear()
                    errorMessage = LuxoraL10n.text("error.new_session_rejected")
                    phase = .unauthenticated
                } else {
                    errorMessage = String(
                        format: LuxoraL10n.text("error.initial_sync_failed"),
                        error.localizedDescription
                    )
                    phase = .restorationFailed
                }
            } catch {
                errorMessage = String(
                    format: LuxoraL10n.text("error.initial_sync_failed"),
                    error.localizedDescription
                )
                phase = .restorationFailed
            }
        } catch {
            try? keychain.clear()
            errorMessage = error.localizedDescription
            phase = .unauthenticated
        }
        return false
    }

    private func bootstrap(credentials: SessionCredentials, authenticatedUser: APIUser? = nil) async throws {
        let api = self.api
        let keychain = self.keychain
        let coordinator = SessionCredentialCoordinator(
            credentials: credentials,
            refreshOperation: { refreshToken in
                try await api.refresh(refreshToken: refreshToken).credentials
            },
            persistOperation: { refreshed in
                try keychain.save(refreshed)
            }
        )

        let user: APIUser
        if let authenticatedUser {
            user = authenticatedUser
        } else {
            user = try await coordinator.withAccessToken { token in
                try await api.currentUser(token: token)
            }
        }
        let remoteChats = try await coordinator.withAccessToken { token in
            try await api.chats(token: token)
        }
        let conversations = remoteChats.map { $0.conversation(currentUserID: user.id) }
        let selectedID = conversations.first?.id
        var initialMessages: [UUID: [ChatMessage]] = [:]
        var loadedIDs: Set<UUID> = []
        if let selectedID {
            let messages = try await coordinator.withAccessToken { token in
                try await api.messages(chatID: selectedID, token: token)
            }
            initialMessages[selectedID] = messages.map { $0.message(currentUserID: user.id) }
            loadedIDs.insert(selectedID)
        }

        let store = MessengerStore(
            conversations: conversations,
            messagesByConversation: initialMessages,
            currentUser: user.participant,
            selectedConversationID: selectedID,
            loadedConversationIDs: loadedIDs
        )
        let userID = user.id
        store.configureRemote(
            sender: { conversationID, clientID, body in
                let message = try await coordinator.withAccessToken { token in
                    try await api.sendMessage(
                        chatID: conversationID,
                        clientNonce: clientID,
                        body: body,
                        token: token
                    )
                }
                return message.message(currentUserID: userID)
            },
            loader: { conversationID in
                try await coordinator.withAccessToken { token in
                    try await api.messages(chatID: conversationID, token: token)
                }.map { $0.message(currentUserID: userID) }
            },
            conversationsLoader: {
                try await coordinator.withAccessToken { token in
                    try await api.chats(token: token)
                }.map { $0.conversation(currentUserID: userID) }
            },
            peopleSearcher: { query in
                try await coordinator.withAccessToken { token in
                    try await api.searchUsers(query: query, token: token)
                }.map(\.participant)
            },
            directConversationCreator: { participantID in
                try await coordinator.withAccessToken { token in
                    try await api.createDirectChat(userID: participantID, token: token)
                }.conversation(currentUserID: userID)
            },
            readMarker: { conversationID, messageID in
                try await coordinator.withAccessToken { token in
                    try await api.markRead(chatID: conversationID, messageID: messageID, token: token)
                }
            },
            reactionSetter: { messageID, emoji, active in
                try await coordinator.withAccessToken { token in
                    try await api.setReaction(messageID: messageID, emoji: emoji, active: active, token: token)
                }.map(\.reaction)
            }
        )

        messengerStore?.cancelRemoteOperations()
        credentialCoordinator = coordinator
        currentUserID = user.id
        messengerStore = store
        store.connectionState = .connecting
        phase = .authenticated
        startRealtime(userID: user.id, store: store)
    }

    public func refreshCapabilities() async {
        capabilityState = .loading
        do {
            capabilityState = .available(try await api.capabilities())
        } catch is CancellationError {
            return
        } catch {
            capabilityState = .unavailable(error.localizedDescription)
        }
    }

    public func retryRealtime() {
        guard phase == .authenticated, let currentUserID, let messengerStore else { return }
        errorMessage = nil
        messengerStore.connectionState = .connecting
        startRealtime(userID: currentUserID, store: messengerStore)
    }

    #if DEBUG
    /// Installs an in-memory, deterministic server-shaped state exclusively for
    /// XCTest and Simulator screenshot review of the production SwiftUI shell.
    /// Release builds do not contain this method or its data.
    public func installDebugUITestMessengerScenario() {
        messengerStore?.cancelRemoteOperations()
        cancelRealtime(resetSequence: true)
        let scenario = DebugMobileScenario.make()
        credentialCoordinator = nil
        currentUserID = scenario.store.currentUser.id
        messengerStore = scenario.store
        capabilityState = .available(scenario.capabilities)
        errorMessage = nil
        phase = .authenticated
    }
    #endif

    private func startRealtime(userID: UUID, store: MessengerStore) {
        realtimeTask?.cancel()
        let realtime = self.realtime
        let resumeFrom = realtimeSequence
        let coordinator = credentialCoordinator
        realtimeTask = Task { [weak self] in
            do {
                guard let coordinator else { throw LuxoraAPIError.missingSession }
                let token = await coordinator.accessToken()
                for try await signal in realtime.signals(token: token, resumeFrom: resumeFrom) {
                    guard !Task.isCancelled,
                          let self,
                          ownsRealtime(store: store, userID: userID)
                    else { return }
                    switch signal {
                    case let .ready(sequence):
                        advanceRealtimeSequence(sequence)
                        store.connectionState = .online
                    case let .message(message, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessage(message.message(currentUserID: userID))
                    case let .cursor(sequence):
                        advanceRealtimeSequence(sequence)
                    case let .typing(conversationID, isTyping):
                        store.setTyping(isTyping, conversationID: conversationID)
                    case .syncRequired:
                        // A stale cursor cannot succeed on another retry. The
                        // thin harness deliberately starts a fresh stream and
                        // remains honest that durable reconciliation is a later gate.
                        realtimeSequence = nil
                        let message = LuxoraL10n.text("error.realtime_history_expired")
                        errorMessage = message
                        store.connectionState = .degraded(message)
                    }
                }
                guard !Task.isCancelled,
                      let self,
                      ownsRealtime(store: store, userID: userID)
                else { return }
                store.connectionState = .offline
            } catch {
                guard !Task.isCancelled else { return }
                guard let self, ownsRealtime(store: store, userID: userID) else { return }
                let message = error.localizedDescription
                store.connectionState = Self.isOffline(error) ? .offline : .degraded(message)
                errorMessage = String(format: LuxoraL10n.text("error.realtime_disconnected"), message)
            }
        }
    }

    private func ownsRealtime(store: MessengerStore, userID: UUID) -> Bool {
        phase == .authenticated
            && currentUserID == userID
            && messengerStore === store
    }

    private func cancelRealtime(resetSequence: Bool) {
        realtimeTask?.cancel()
        realtimeTask = nil
        if resetSequence {
            realtimeSequence = nil
        }
    }

    private static func isOffline(_ error: Error) -> Bool {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        return [
            NSURLErrorNotConnectedToInternet,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorInternationalRoamingOff,
            NSURLErrorDataNotAllowed,
        ].contains(error.code)
    }

    private func advanceRealtimeSequence(_ sequence: Int) {
        realtimeSequence = max(realtimeSequence ?? 0, sequence)
    }
}
