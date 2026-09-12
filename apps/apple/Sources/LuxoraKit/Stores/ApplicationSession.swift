import Foundation
import Observation

#if DEBUG
private actor DebugChatPreferencesBackend {
    private var confirmed: [UUID: ChatPreferences]

    init(confirmed: [UUID: ChatPreferences]) {
        self.confirmed = confirmed
    }

    func load(chatID: UUID) -> ChatPreferences {
        confirmed[chatID] ?? ChatPreferences(archivedAt: nil, mutedUntil: nil)
    }

    func update(chatID: UUID, patch: ChatPreferencesPatch) -> ChatPreferences {
        let current = load(chatID: chatID)
        let archivedAt: Date?
        if let archived = patch.archived {
            archivedAt = archived ? Date() : nil
        } else {
            archivedAt = current.archivedAt
        }

        let mutedUntil: Date?
        switch patch.mutedUntil {
        case .unchanged:
            mutedUntil = current.mutedUntil
        case let .until(date):
            mutedUntil = date
        case .unmuted:
            mutedUntil = nil
        }

        let updated = ChatPreferences(archivedAt: archivedAt, mutedUntil: mutedUntil)
        confirmed[chatID] = updated
        return updated
    }
}
#endif

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

public enum PhoneAuthenticationFailure: Equatable, Sendable {
    case invalidCode
    case attemptsExhausted
    case invalidPassword
    case passwordAttemptsExhausted
    case passwordTokenExpired
    case challengeExpired
    case challengeInvalid
    case resendCooldown(seconds: Int)
    case networkUnavailable
    case deliveryUnavailable
    case credentialPersistenceFailed
    case registrationExpired
    case temporarilyUnavailable
    case recoveryTokenExpired
    case recoveryNotConfirmable(seconds: Int)
    case unexpected(String)

    public var message: String {
        switch self {
        case .invalidCode:
            "Неверный код. Проверьте шесть цифр и попробуйте ещё раз."
        case .attemptsExhausted:
            "Попытки закончились. Дождитесь повторной отправки и получите новый код."
        case .invalidPassword:
            "Неверный пароль. Проверьте ввод и попробуйте ещё раз."
        case .passwordAttemptsExhausted:
            "Попытки ввода пароля закончились. Подтвердите номер новым кодом."
        case .passwordTokenExpired:
            "Срок проверки пароля истёк. Подтвердите номер новым кодом."
        case .challengeExpired:
            "Срок действия кода истёк. Получите новый код."
        case .challengeInvalid:
            "Этот код уже недействителен. Получите новый код."
        case let .resendCooldown(seconds):
            "Новый код можно запросить через \(seconds) с."
        case .networkUnavailable:
            "Нет связи с сервером. Проверьте сеть и нажмите «Повторить»."
        case .deliveryUnavailable:
            "Не удалось доставить код. Повторите запрос: Luxora безопасно повторит ту же команду."
        case .credentialPersistenceFailed:
            "Не удалось безопасно сохранить сеанс на iPhone. Нажмите «Повторить»."
        case .registrationExpired:
            "Время регистрации истекло. Подтвердите номер заново."
        case .recoveryTokenExpired:
            "Заявка на сброс пароля недействительна или истекла. Начните восстановление заново."
        case let .recoveryNotConfirmable(seconds):
            "Сброс можно подтвердить через \(seconds) с. Это защита аккаунта."
        case .temporarilyUnavailable:
            "Сервис входа временно недоступен. Нажмите «Повторить»."
        case let .unexpected(message):
            message
        }
    }

    var retainsIdempotencyCommand: Bool {
        switch self {
        case .resendCooldown, .networkUnavailable, .deliveryUnavailable,
             .credentialPersistenceFailed, .temporarilyUnavailable:
            true
        case .invalidPassword:
            // The server durably records this exact password attempt by nonce.
            // Retain it until the user changes the password, so a response-loss
            // retry replays rather than consuming another bounded attempt.
            true
        case .recoveryNotConfirmable:
            // The confirmation window is time-based: a response-loss retry must
            // re-evaluate the clock instead of replaying the early rejection.
            false
        case .invalidCode, .attemptsExhausted, .passwordAttemptsExhausted,
             .passwordTokenExpired, .challengeExpired, .challengeInvalid,
             .registrationExpired, .recoveryTokenExpired, .unexpected:
            false
        }
    }

    var blocksCodeVerification: Bool {
        switch self {
        case .attemptsExhausted, .passwordAttemptsExhausted, .passwordTokenExpired,
             .challengeExpired, .challengeInvalid, .registrationExpired,
             .recoveryTokenExpired:
            true
        case .invalidCode, .invalidPassword, .resendCooldown, .networkUnavailable, .deliveryUnavailable,
             .credentialPersistenceFailed, .temporarilyUnavailable, .recoveryNotConfirmable,
             .unexpected:
            false
        }
    }

    var blocksPasswordVerification: Bool {
        switch self {
        case .passwordAttemptsExhausted, .passwordTokenExpired, .recoveryTokenExpired:
            true
        case .invalidCode, .attemptsExhausted, .invalidPassword, .challengeExpired,
             .challengeInvalid, .resendCooldown, .networkUnavailable, .deliveryUnavailable,
             .credentialPersistenceFailed, .registrationExpired, .temporarilyUnavailable,
             .recoveryNotConfirmable, .unexpected:
            false
        }
    }

    var isRetryable: Bool {
        switch self {
        case .networkUnavailable, .deliveryUnavailable, .credentialPersistenceFailed,
             .temporarilyUnavailable:
            true
        case .invalidCode, .attemptsExhausted, .invalidPassword, .passwordAttemptsExhausted,
             .passwordTokenExpired, .challengeExpired, .challengeInvalid,
             .resendCooldown, .registrationExpired, .recoveryTokenExpired,
             .recoveryNotConfirmable, .unexpected:
            false
        }
    }

    static func classify(_ error: Error) -> PhoneAuthenticationFailure {
        guard let apiError = error as? LuxoraAPIError else {
            return .unexpected(error.localizedDescription)
        }
        switch apiError {
        case .transport:
            return .networkUnavailable
        case .invalidResponse, .syncUnstable:
            return .temporarilyUnavailable
        case let .server(status, code, message):
            switch code {
            case "PHONE_AUTH_CODE_INVALID":
                return .invalidCode
            case "PHONE_AUTH_ATTEMPTS_EXHAUSTED":
                return .attemptsExhausted
            case "PHONE_AUTH_PASSWORD_INVALID":
                return .invalidPassword
            case "PHONE_AUTH_PASSWORD_ATTEMPTS_EXHAUSTED":
                return .passwordAttemptsExhausted
            case "PHONE_AUTH_PASSWORD_TOKEN_INVALID", "PHONE_AUTH_PASSWORD_TOKEN_EXPIRED":
                return .passwordTokenExpired
            case "PHONE_AUTH_RECOVERY_TOKEN_INVALID":
                return .recoveryTokenExpired
            case "PHONE_AUTH_RECOVERY_NOT_CONFIRMABLE":
                return .recoveryNotConfirmable(seconds: Self.retrySeconds(from: message) ?? 60)
            case "PHONE_AUTH_CHALLENGE_EXPIRED":
                return .challengeExpired
            case "PHONE_AUTH_CHALLENGE_INVALID":
                return .challengeInvalid
            case "PHONE_AUTH_RESEND_COOLDOWN", "RATE_LIMITED":
                return .resendCooldown(seconds: Self.retrySeconds(from: message) ?? 60)
            case "PHONE_AUTH_DELIVERY_UNAVAILABLE":
                return .deliveryUnavailable
            case "PHONE_AUTH_TEMPORARILY_UNAVAILABLE", "SERVICE_UNAVAILABLE":
                return .temporarilyUnavailable
            case "PHONE_AUTH_REGISTRATION_EXPIRED":
                return .registrationExpired
            default:
                return .unexpected("\(LuxoraL10n.text("error.server_rejected")) \(code) (\(status)).")
            }
        case .incompatibleServer, .missingSession:
            return .unexpected(apiError.localizedDescription)
        }
    }

    private static func retrySeconds(from message: String) -> Int? {
        let digits = message.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
        return digits.first(where: { (1...3_600).contains($0) })
    }
}

struct PhoneAuthenticationCommandNonce<Key: Equatable> {
    private(set) var key: Key?
    private(set) var nonce: UUID?

    mutating func acquire(for key: Key) -> UUID {
        if self.key == key, let nonce {
            return nonce
        }
        let nonce = UUID.clientNonceV4()
        self.key = key
        self.nonce = nonce
        return nonce
    }

    mutating func finish() {
        key = nil
        nonce = nil
    }

    mutating func fail(retainingCommand: Bool) {
        if !retainingCommand {
            finish()
        }
    }

    mutating func settleAfterClientAcceptance(_ accepted: Bool) {
        if accepted {
            finish()
        }
    }
}

@MainActor
@Observable
public final class ApplicationSession {
    public private(set) var phase: ApplicationPhase = .restoring
    public private(set) var messengerStore: MessengerStore?
    public private(set) var deviceSessionsStore: DeviceSessionsStore?
    public private(set) var phonePasswordSettingsStore: PhonePasswordSettingsStore?
    public private(set) var phoneBindingStore: PhoneBindingStore?
    public private(set) var notificationSettingsStore: NotificationSettingsStore?
    public private(set) var pushRegistrationStore: PushRegistrationStore?
    public private(set) var chatPreferencesStore: ChatPreferencesStore?
    public private(set) var chatFoldersStore: ChatFoldersStore?
    public private(set) var communityStore: CommunityStore?
    public private(set) var globalSearchStore: GlobalSearchStore?
    public private(set) var synchronizedDraftStore: SynchronizedChatDraftStore?
    public let avatarImageCache = AuthenticatedAvatarImageCache()
    public let attachmentImageCache = AuthenticatedAvatarImageCache(byteLimit: 128 * 1_024 * 1_024)
    public private(set) var capabilityState: CapabilityLoadState = .loading
    public private(set) var isWorking = false
    public private(set) var isAuthenticationSyncing = false
    public private(set) var phoneAuthenticationFailure: PhoneAuthenticationFailure?
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
    private let communityAPI: LuxoraCommunityAPIClient
    private let chatFoldersAPI: LuxoraChatFoldersAPIClient
    private let realtime: LuxoraRealtimeClient
    private let keychain: KeychainSessionStore
    private let durableMessaging: ScopedMessengerPersistence
    private var credentialCoordinator: SessionCredentialCoordinator?
    private var currentUserID: UUID?
    private var durableMessagingScope: DurableMessagingScope?
    private let pushNotificationLifecycle = PushNotificationSessionLifecycle()
    private var chatPreferencesBinding: ChatPreferencesSessionBinding?
    private var chatFoldersBinding: ChatFoldersSessionBinding?
    private var synchronizedDraftBinding: SynchronizedChatDraftSessionBinding?
    private var realtimeSequence: Int?
    private var realtimeV2Sequence: Int?
    private var realtimeTask: Task<Void, Never>?
    private struct PhoneBeginKey: Equatable {
        let countryCode: String
        let nationalNumber: String
    }
    private struct PhoneVerificationKey: Equatable {
        let challengeID: String
        let code: String
    }
    private struct PhoneRegistrationKey: Equatable {
        let registrationToken: String
        let displayName: String
        let username: String
        let bio: String
    }
    private struct PhonePasswordKey: Equatable {
        let passwordToken: String
        let password: String
    }

    private struct PhoneRecoveryStartKey: Equatable {
        let passwordToken: String
    }

    private struct PhoneRecoveryCompleteKey: Equatable {
        let recoveryToken: String
        let newPassword: String
    }
    private var phoneBeginCommand = PhoneAuthenticationCommandNonce<PhoneBeginKey>()
    private var phoneVerificationCommand = PhoneAuthenticationCommandNonce<PhoneVerificationKey>()
    private var phoneRegistrationCommand = PhoneAuthenticationCommandNonce<PhoneRegistrationKey>()
    private var phonePasswordCommand = PhoneAuthenticationCommandNonce<PhonePasswordKey>()
    private var phoneRecoveryStartCommand = PhoneAuthenticationCommandNonce<PhoneRecoveryStartKey>()
    private var phoneRecoveryCompleteCommand = PhoneAuthenticationCommandNonce<PhoneRecoveryCompleteKey>()

    public convenience init(configuration: LuxoraClientConfiguration = .development) {
        self.init(
            configuration: configuration,
            durableMessaging: ScopedMessengerPersistence()
        )
    }

    init(
        configuration: LuxoraClientConfiguration,
        durableMessaging: ScopedMessengerPersistence
    ) {
        self.configuration = configuration
        self.durableMessaging = durableMessaging
        api = LuxoraAPIClient(configuration: configuration)
        communityAPI = LuxoraCommunityAPIClient(configuration: configuration)
        chatFoldersAPI = LuxoraChatFoldersAPIClient(configuration: configuration)
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
        var restoringSessionID: UUID?
        do {
            guard let stored = try keychain.load() else {
                phase = .unauthenticated
                return
            }
            restoringSessionID = stored.sessionID
            try await bootstrap(credentials: stored)
            resetPhoneAuthenticationCommands()
        } catch is CancellationError {
            // SwiftUI owns the restoration task. If its view disappears, leave
            // the phase restartable and never discard a valid saved session.
            return
        } catch let error as LuxoraAPIError {
            if case let .server(status, _, _) = error, status == 401 {
                await purgeDurableMessagingScope(
                    fallbackSessionID: restoringSessionID,
                    purgeAllIfUnresolved: true
                )
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
            await purgeDurableMessagingScope(
                fallbackSessionID: restoringSessionID,
                purgeAllIfUnresolved: true
            )
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

    public func discardRestoredSession() async {
        let fallbackSessionID = storedSessionIDForDurablePurge()
        messengerStore?.cancelRemoteOperations()
        deviceSessionsStore?.cancelRemoteOperations()
        phonePasswordSettingsStore?.cancelRemoteOperations()
        notificationSettingsStore?.cancelRemoteOperations()
        chatPreferencesStore?.resetForSessionReplacement()
        chatFoldersStore?.resetForSessionReplacement()
        communityStore?.cancelRemoteOperations()
        globalSearchStore?.resetForSessionReplacement()
        synchronizedDraftStore?.resetForSessionReplacement()
        pushNotificationLifecycle.detach()
        cancelRealtime(resetSequence: true)
        await purgeDurableMessagingScope(
            fallbackSessionID: fallbackSessionID,
            purgeAllIfUnresolved: true
        )
        await avatarImageCache.clear()
        await attachmentImageCache.clear()
        if let credentialCoordinator {
            await credentialCoordinator.invalidate()
        }
        try? keychain.clear()
        credentialCoordinator = nil
        currentUserID = nil
        messengerStore = nil
        deviceSessionsStore = nil
        phonePasswordSettingsStore = nil
        phoneBindingStore = nil
        notificationSettingsStore = nil
        pushRegistrationStore = nil
        chatPreferencesStore = nil
        chatPreferencesBinding = nil
        chatFoldersStore = nil
        chatFoldersBinding = nil
        communityStore = nil
        globalSearchStore = nil
        synchronizedDraftStore = nil
        synchronizedDraftBinding = nil
        resetPhoneAuthenticationCommands()
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

        let commandKey = PhoneBeginKey(
            countryCode: normalizedCountryCode,
            nationalNumber: normalizedNationalNumber
        )
        let clientNonce = phoneBeginCommand.acquire(for: commandKey)
        isWorking = true
        phoneAuthenticationFailure = nil
        errorMessage = nil
        defer { isWorking = false }
        do {
            let response = try await api.requestPhoneCode(
                countryCode: normalizedCountryCode,
                nationalNumber: normalizedNationalNumber,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: clientNonce
            )
            phoneBeginCommand.finish()
            phonePasswordCommand.finish()
            return PhoneCodeChallenge(response: response)
        } catch is CancellationError {
            return nil
        } catch {
            let failure = PhoneAuthenticationFailure.classify(error)
            phoneBeginCommand.fail(retainingCommand: failure.retainsIdempotencyCommand)
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
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

        let commandKey = PhoneVerificationKey(challengeID: challengeID, code: normalizedCode)
        let clientNonce = phoneVerificationCommand.acquire(for: commandKey)
        isWorking = true
        phoneAuthenticationFailure = nil
        errorMessage = nil
        defer { isWorking = false }
        do {
            let result = try await api.verifyPhoneCode(
                challengeID: challengeID,
                code: normalizedCode,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: clientNonce
            )
            switch result {
            case let .authenticated(response):
                let accepted = await finishAuthentication(response)
                phoneVerificationCommand.settleAfterClientAcceptance(accepted)
                if accepted { return .authenticated }
                // The server may already have committed and returned the token
                // response. Until Keychain persistence plus bootstrap succeeds,
                // retain the nonce so retry replays that exact durable outcome.
                return nil
            case let .profileRequired(response):
                // The registration grant is now held by the live UI state. A
                // process-death grant restoration mechanism is a separate gate.
                phoneVerificationCommand.finish()
                return .profileRequired(PhoneRegistrationChallenge(response: response))
            case let .passwordRequired(response):
                // The short-lived continuation grant is now held by the live
                // password screen. Replaying the OTP command is unnecessary;
                // its own password command below owns exact retry semantics.
                phoneVerificationCommand.finish()
                return .passwordRequired(PhonePasswordChallenge(response: response))
            case .bindingVerified:
                // Binding challenges only exist for authenticated /me flows.
                // Onboarding never creates one, so treat this status as an
                // unexpected server answer for the unauthenticated flow while
                // still decoding the additive contract exactly.
                phoneVerificationCommand.finish()
                phoneAuthenticationFailure = .unexpected(
                    LuxoraL10n.text("auth.recovery_unexpected_binding")
                )
                return nil
            }
        } catch is CancellationError {
            return nil
        } catch {
            let failure = PhoneAuthenticationFailure.classify(error)
            phoneVerificationCommand.fail(retainingCommand: failure.retainsIdempotencyCommand)
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
            phase = .unauthenticated
            return nil
        }
    }

    public func completePhonePassword(passwordToken: String, password: String) async -> Bool {
        guard phase == .unauthenticated, !isWorking else { return false }
        guard !passwordToken.isEmpty, (1...128).contains(password.count) else {
            errorMessage = "Введите пароль учётной записи."
            return false
        }

        let commandKey = PhonePasswordKey(passwordToken: passwordToken, password: password)
        let clientNonce = phonePasswordCommand.acquire(for: commandKey)
        isWorking = true
        phoneAuthenticationFailure = nil
        errorMessage = nil
        defer { isWorking = false }

        do {
            let response = try await api.completePhonePassword(
                passwordToken: passwordToken,
                password: password,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: clientNonce
            )
            let accepted = await finishAuthentication(response)
            phonePasswordCommand.settleAfterClientAcceptance(accepted)
            return accepted
        } catch is CancellationError {
            return false
        } catch {
            let failure = PhoneAuthenticationFailure.classify(error)
            phonePasswordCommand.fail(retainingCommand: failure.retainsIdempotencyCommand)
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
            phase = .unauthenticated
            return false
        }
    }

    public func startPhoneRecovery(passwordToken: String) async -> PhoneRecoveryIntent? {
        guard phase == .unauthenticated, !isWorking else { return nil }
        guard !passwordToken.isEmpty else {
            errorMessage = LuxoraL10n.text("auth.recovery_invalid_grant")
            return nil
        }

        let commandKey = PhoneRecoveryStartKey(passwordToken: passwordToken)
        let clientNonce = phoneRecoveryStartCommand.acquire(for: commandKey)
        isWorking = true
        phoneAuthenticationFailure = nil
        errorMessage = nil
        defer { isWorking = false }

        do {
            let response = try await api.startPhoneRecovery(
                passwordToken: passwordToken,
                clientNonce: clientNonce
            )
            phoneRecoveryStartCommand.finish()
            return PhoneRecoveryIntent(response: response)
        } catch is CancellationError {
            return nil
        } catch {
            let failure = PhoneAuthenticationFailure.classify(error)
            phoneRecoveryStartCommand.fail(retainingCommand: failure.retainsIdempotencyCommand)
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
            return nil
        }
    }

    public func completePhoneRecovery(recoveryToken: String, newPassword: String) async -> Bool {
        guard phase == .unauthenticated, !isWorking else { return false }
        let normalized = newPassword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !recoveryToken.isEmpty, normalized.count >= 12 else {
            errorMessage = LuxoraL10n.text("auth.recovery_password_invalid")
            return false
        }

        let commandKey = PhoneRecoveryCompleteKey(recoveryToken: recoveryToken, newPassword: normalized)
        let clientNonce = phoneRecoveryCompleteCommand.acquire(for: commandKey)
        isWorking = true
        phoneAuthenticationFailure = nil
        errorMessage = nil
        defer { isWorking = false }

        do {
            let response = try await api.completePhoneRecovery(
                recoveryToken: recoveryToken,
                newPassword: normalized,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: clientNonce
            )
            let accepted = await finishAuthentication(response)
            phoneRecoveryCompleteCommand.settleAfterClientAcceptance(accepted)
            return accepted
        } catch is CancellationError {
            return false
        } catch {
            let failure = PhoneAuthenticationFailure.classify(error)
            phoneRecoveryCompleteCommand.fail(retainingCommand: failure.retainsIdempotencyCommand)
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
            phase = .unauthenticated
            return false
        }
    }

    public func completePhoneRegistration(
        registrationToken: String,
        displayName: String,
        username: String,
        bio: String
    ) async -> Bool {        guard phase == .unauthenticated, !isWorking else { return false }
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

        let commandKey = PhoneRegistrationKey(
            registrationToken: registrationToken,
            displayName: normalizedDisplayName,
            username: normalizedUsername,
            bio: normalizedBio
        )
        let clientNonce = phoneRegistrationCommand.acquire(for: commandKey)
        isWorking = true
        phoneAuthenticationFailure = nil
        errorMessage = nil
        defer { isWorking = false }
        do {
            let response = try await api.completePhoneRegistration(
                registrationToken: registrationToken,
                displayName: normalizedDisplayName,
                username: normalizedUsername,
                bio: normalizedBio,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: clientNonce
            )
            let accepted = await finishAuthentication(response)
            // Registration may already be consumed server-side. On a failed
            // Keychain/bootstrap acceptance the unchanged nonce is the only
            // safe way to recover that committed response.
            phoneRegistrationCommand.settleAfterClientAcceptance(accepted)
            return accepted
        } catch is CancellationError {
            return false
        } catch {
            let failure = PhoneAuthenticationFailure.classify(error)
            phoneRegistrationCommand.fail(retainingCommand: failure.retainsIdempotencyCommand)
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
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
            let failure = PhoneAuthenticationFailure.classify(error)
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
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
        deviceSessionsStore?.cancelRemoteOperations()
        phonePasswordSettingsStore?.cancelRemoteOperations()
        notificationSettingsStore?.cancelRemoteOperations()
        chatPreferencesStore?.resetForSessionReplacement()
        chatFoldersStore?.resetForSessionReplacement()
        communityStore?.cancelRemoteOperations()
        globalSearchStore?.resetForSessionReplacement()
        synchronizedDraftStore?.resetForSessionReplacement()
        pushNotificationLifecycle.detach()
        cancelRealtime(resetSequence: true)
        await purgeDurableMessagingScope()
        await avatarImageCache.clear()
        await attachmentImageCache.clear()
        if let credentialCoordinator {
            try? await credentialCoordinator.withAccessToken { [api] token in
                try await api.revokeCurrentSession(token: token)
            }
            // The server revoke is best-effort, but local teardown is an exact
            // fence: after invalidate returns no late refresh may repopulate
            // Keychain after the clear below.
            await credentialCoordinator.invalidate()
        }
        try? keychain.clear()
        credentialCoordinator = nil
        currentUserID = nil
        messengerStore = nil
        deviceSessionsStore = nil
        phonePasswordSettingsStore = nil
        phoneBindingStore = nil
        notificationSettingsStore = nil
        pushRegistrationStore = nil
        chatPreferencesStore = nil
        chatPreferencesBinding = nil
        chatFoldersStore = nil
        chatFoldersBinding = nil
        communityStore = nil
        globalSearchStore = nil
        synchronizedDraftStore = nil
        synchronizedDraftBinding = nil
        resetPhoneAuthenticationCommands()
        errorMessage = nil
        phase = .unauthenticated
    }

    /// Receives Apple's opaque token bytes without logging or persisting them
    /// locally. If authentication is still being restored, the bytes remain
    /// only in this process and are transferred to the session-bound server
    /// registration immediately after bootstrap succeeds.
    public func receiveAPNSDeviceToken(
        _ deviceToken: Data,
        environment: APNSPushEnvironment
    ) async {
        await pushNotificationLifecycle.receive(
            deviceToken: deviceToken,
            environment: environment
        )
    }

    /// Keeps the server registration aligned with the current iOS permission.
    /// Revocation is idempotent and scoped to the authenticated session.
    public func synchronizePushAuthorization(isAuthorized: Bool) async {
        await pushNotificationLifecycle.synchronizeAuthorization(isAuthorized: isAuthorized)
    }

    public func recordAPNSRegistrationFailure() {
        pushNotificationLifecycle.recordSystemRegistrationFailure()
    }

    public func clearPhoneAuthenticationFailure() {
        phoneAuthenticationFailure = nil
        errorMessage = nil
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
        phoneAuthenticationFailure = nil
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
            let failure = PhoneAuthenticationFailure.credentialPersistenceFailed
            phoneAuthenticationFailure = failure
            errorMessage = failure.message
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

        let initialUser: APIUser
        if let authenticatedUser {
            initialUser = authenticatedUser
        } else {
            initialUser = try await coordinator.withAccessToken { token in
                try await api.currentUser(token: token)
            }
        }
        let chatFoldersAPI = self.chatFoldersAPI
        let user: APIUser
        let bootstrapReconciliation: LuxoraReconciliationBundle?
        let remoteChats: [APIChat]
        let remoteChatFolders: ChatFolderListSnapshot
        if capabilityState.capabilities?.realtimeProtocolVersion == .scopedV2 {
            let bundle = try await coordinator.withAccessToken { token in
                try await api.reconciliationBundle(
                    token: token,
                    expectedUserID: initialUser.id
                )
            }
            user = bundle.currentUser
            bootstrapReconciliation = bundle
            remoteChats = bundle.chats.map(\.chat)
            remoteChatFolders = bundle.chatFolders
        } else {
            user = initialUser
            bootstrapReconciliation = nil
            remoteChats = try await coordinator.withAccessToken { token in
                try await api.chats(token: token)
            }
            remoteChatFolders = try await coordinator.withAccessToken { token in
                try await chatFoldersAPI.folders(token: token)
            }
        }
        let conversations = remoteChats.map { $0.conversation(currentUserID: user.id) }
        let selectedID = conversations.first?.id
        var initialMessages: [UUID: [ChatMessage]] = [:]
        var loadedIDs: Set<UUID> = []
        if bootstrapReconciliation == nil, let selectedID {
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
            currentUserBio: user.bio,
            selectedConversationID: bootstrapReconciliation == nil ? selectedID : nil,
            loadedConversationIDs: loadedIDs
        )
        let userID = user.id
        let durableScope = DurableMessagingScope(
            accountID: userID,
            sessionID: credentials.sessionID
        )
        let durableMessaging = self.durableMessaging
        // Corruption recovery is fail-closed inside the actor. Cache I/O must
        // not prevent a valid server session from bootstrapping.
        _ = try? await durableMessaging.load(scope: durableScope)
        let initialDurableProjection = store.durableConfirmedProjection()
        try? await durableMessaging.replaceConfirmedProjection(
            scope: durableScope,
            conversations: initialDurableProjection.conversations,
            messages: initialDurableProjection.messages
        )
        let durableRemoteSender: ScopedMessengerPersistence.MessageSender = { pending in
            let snapshot = try await coordinator.withAccessToken { token in
                try await api.sendMessage(
                    chatID: pending.conversationID,
                    clientNonce: pending.clientNonce,
                    body: pending.body,
                    replyToMessageID: pending.replyToMessageID,
                    token: token
                )
            }.snapshot(currentUserID: userID)
            return DurableConfirmedMessageSnapshot(snapshot)
        }
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
            mediaAttachmentUploader: { item in
                try await coordinator.withAccessToken { token in
                    try await api.uploadAttachment(
                        kind: item.kind,
                        fileName: item.fileName,
                        mimeType: item.mimeType,
                        data: item.data,
                        imageWidth: item.imageWidth,
                        imageHeight: item.imageHeight,
                        durationMs: item.durationMs,
                        waveform: item.waveform,
                        token: token
                    )
                }
            },
            mediaMessageSender: { conversationID, clientID, body, replyToMessageID, attachmentIDs, transcriptionConsent in
                let message = try await coordinator.withAccessToken { token in
                    try await api.sendMessage(
                        chatID: conversationID,
                        clientNonce: clientID,
                        body: body,
                        replyToMessageID: replyToMessageID,
                        attachmentIDs: attachmentIDs,
                        transcriptionConsent: transcriptionConsent,
                        token: token
                    )
                }
                return message.message(currentUserID: userID)
            },
            transcriptPutter: { messageID, text in
                let message = try await coordinator.withAccessToken { token in
                    try await api.putMessageTranscript(
                        messageID: messageID,
                        text: text,
                        clientNonce: UUID.clientNonceV4(),
                        token: token
                    )
                }
                return message.message(currentUserID: userID)
            },
            scheduleMessage: { conversationID, body, replyToMessageID, sendAt in
                let scheduled = try await coordinator.withAccessToken { token in
                    try await api.scheduleMessage(
                        chatID: conversationID,
                        body: body,
                        replyToMessageID: replyToMessageID,
                        topicId: nil,
                        sendAt: sendAt,
                        clientNonce: UUID.clientNonceV4(),
                        token: token
                    )
                }
                return scheduled.scheduled()
            },
            scheduledListLoader: { conversationID in
                var items: [ScheduledMessage] = []
                var cursor: String? = nil
                repeat {
                    let page = try await coordinator.withAccessToken { token in
                        try await api.scheduledMessagesPage(
                            chatID: conversationID,
                            limit: 50,
                            cursor: cursor,
                            token: token
                        )
                    }
                    items.append(contentsOf: page.items)
                    cursor = page.nextCursor
                } while cursor != nil && items.count < 200
                return items.sorted { $0.sendAt < $1.sendAt }
            },
            scheduledCanceller: { id in
                try await coordinator.withAccessToken { token in
                    try await api.cancelScheduledMessage(id: id, token: token)
                }
            },
            loader: { conversationID in
                try await coordinator.withAccessToken { token in
                    try await api.messages(chatID: conversationID, token: token)
                }.map { $0.message(currentUserID: userID) }
            },
            conversationsLoader: {
                let conversations = try await coordinator.withAccessToken { token in
                    try await api.chats(token: token)
                }.map { $0.conversation(currentUserID: userID) }
                try? await durableMessaging.replaceConfirmedConversations(
                    scope: durableScope,
                    conversations: conversations
                )
                return conversations
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
            },
            messageSender: { conversationID, clientID, body, replyToMessageID in
                try await durableMessaging.sendText(
                    scope: durableScope,
                    conversationID: conversationID,
                    clientNonce: clientID,
                    body: body,
                    replyToMessageID: replyToMessageID,
                    sender: durableRemoteSender
                ).remoteSnapshot
            },
            messageSnapshotLoader: { conversationID in
                let snapshots = try await coordinator.withAccessToken { token in
                    try await api.messages(chatID: conversationID, token: token)
                }.map { $0.snapshot(currentUserID: userID) }
                try? await durableMessaging.replaceConfirmedMessages(
                    scope: durableScope,
                    conversationID: conversationID,
                    snapshots: snapshots.map(DurableConfirmedMessageSnapshot.init)
                )
                return snapshots
            },
            messageEditor: { messageID, body, expectedRevision in
                try await coordinator.withAccessToken { token in
                    try await api.editMessage(
                        messageID: messageID,
                        body: body,
                        expectedRevision: expectedRevision,
                        token: token
                    )
                }.snapshot(currentUserID: userID)
            },
            messageDeleter: { messageID in
                try await coordinator.withAccessToken { token in
                    try await api.deleteMessage(messageID: messageID, token: token)
                }.snapshot(currentUserID: userID)
            },
            messageForwarder: { messageID, targetConversationID, clientNonce in
                try await coordinator.withAccessToken { token in
                    try await api.forwardMessage(
                        messageID: messageID,
                        to: targetConversationID,
                        clientNonce: clientNonce,
                        token: token
                    )
                }.snapshot(currentUserID: userID)
            },
            messagePinSetter: { conversationID, messageID, active in
                try await coordinator.withAccessToken { token in
                    try await api.setMessagePinned(
                        chatID: conversationID,
                        messageID: messageID,
                        active: active,
                        token: token
                    )
                }
            },
            profileUpdater: { displayName, bio in
                let updated = try await coordinator.withAccessToken { token in
                    try await api.updateCurrentUser(
                        displayName: displayName,
                        bio: bio,
                        token: token
                    )
                }
                return CurrentUserProfileSnapshot(
                    participant: updated.participant,
                    bio: updated.bio
                )
            },
            avatarUploader: { pngData in
                let updated = try await coordinator.withAccessToken { token in
                    try await api.uploadProfileAvatar(pngData: pngData, token: token)
                }
                return CurrentUserProfileSnapshot(
                    participant: updated.participant,
                    bio: updated.bio
                )
            },
            avatarClearer: {
                let updated = try await coordinator.withAccessToken { token in
                    try await api.clearProfileAvatar(token: token)
                }
                return CurrentUserProfileSnapshot(
                    participant: updated.participant,
                    bio: updated.bio
                )
            },
            messageRequestLoader: { direction in
                let requests = try await coordinator.withAccessToken { token in
                    try await api.allMessageRequests(direction: direction, token: token)
                }
                return try requests.map { try $0.item() }
            },
            exactUserLookup: { username in
                try await coordinator.withAccessToken { token in
                    try await api.lookupUser(username: username, token: token)
                }?.participant
            },
            messageRequestCreator: { recipientID, body, clientNonce in
                let request = try await coordinator.withAccessToken { token in
                    try await api.createMessageRequest(
                        recipientUserID: recipientID,
                        body: body,
                        clientNonce: clientNonce,
                        token: token
                    )
                }
                return try request.item()
            },
            messageRequestAccepter: { requestID in
                let response = try await coordinator.withAccessToken { token in
                    try await api.acceptMessageRequest(id: requestID, token: token)
                }
                guard let firstMessage = response.chat.lastMessage else {
                    throw LuxoraAPIError.invalidResponse
                }
                return MessageRequestAcceptResult(
                    request: try response.request.item(),
                    conversation: response.chat.conversation(currentUserID: userID),
                    firstMessage: firstMessage.snapshot(currentUserID: userID)
                )
            },
            messageRequestDismisser: { requestID in
                try await coordinator.withAccessToken { token in
                    try await api.dismissMessageRequest(id: requestID, token: token)
                }
            },
            privacySettingsLoader: {
                try await coordinator.withAccessToken { token in
                    try await api.privacySettings(token: token)
                }.snapshot
            },
            privacySettingsUpdater: { usernameDiscoverable, messageRequests in
                try await coordinator.withAccessToken { token in
                    try await api.updatePrivacySettings(
                        usernameDiscoverable: usernameDiscoverable,
                        messageRequests: messageRequests,
                        token: token
                    )
                }.snapshot
            }
        )

        let searchStore = GlobalSearchStore()
        searchStore.configureRemote(
            people: { query, cursor in
                let page = try await coordinator.withAccessToken { token in
                    try await api.searchUsersPage(query: query, cursor: cursor, token: token)
                }
                return GlobalSearchPage(
                    items: page.items.map(\.participant).filter { $0.id != userID },
                    nextCursor: page.nextCursor
                )
            },
            messages: { query, cursor in
                let page = try await coordinator.withAccessToken { token in
                    try await api.searchMessagesPage(query: query, cursor: cursor, token: token)
                }
                return GlobalSearchPage(
                    items: page.items.map(\.globalSearchResult),
                    nextCursor: page.nextCursor
                )
            },
            files: { query, cursor in
                let page = try await coordinator.withAccessToken { token in
                    try await api.searchFilesPage(query: query, cursor: cursor, token: token)
                }
                return GlobalSearchPage(
                    items: page.items.map(\.globalSearchResult),
                    nextCursor: page.nextCursor
                )
            }
        )
        let sessionsStore = DeviceSessionsStore()
        sessionsStore.configureRemote(
            loader: {
                try await coordinator.withAccessToken { token in
                    try await api.deviceSessions(token: token)
                }.map(\.deviceSession)
            },
            revoker: { sessionID in
                try await coordinator.withAccessToken { token in
                    try await api.revokeDeviceSession(id: sessionID, token: token)
                }
            }
        )

        let passwordSettingsStore = PhonePasswordSettingsStore()
        passwordSettingsStore.configureRemote(
            loader: {
                let response = try await coordinator.withAccessToken { token in
                    try await api.phonePasswordStatus(token: token)
                }
                return PhonePasswordStatus(response: response)
            },
            configurator: { newPassword, currentPassword in
                let response = try await coordinator.withAccessToken { token in
                    try await api.configurePhonePassword(
                        password: newPassword,
                        currentPassword: currentPassword,
                        token: token
                    )
                }
                return PhonePasswordStatus(response: response)
            },
            disabler: { currentPassword in
                let response = try await coordinator.withAccessToken { token in
                    try await api.disablePhonePassword(
                        currentPassword: currentPassword,
                        token: token
                    )
                }
                return PhonePasswordStatus(response: response)
            }
        )

        let bindingStore = PhoneBindingStore()
        bindingStore.remoteBegin = { countryCode, nationalNumber in
            try await coordinator.withAccessToken { token in
                try await api.beginPhoneBinding(
                    countryCode: countryCode,
                    nationalNumber: nationalNumber,
                    deviceName: ProcessInfo.processInfo.hostName,
                    clientNonce: UUID.clientNonceV4(),
                    token: token
                )
            }
        }
        bindingStore.remoteVerify = { challengeID, code in
            try await api.verifyPhoneCode(
                challengeID: challengeID,
                code: code,
                deviceName: ProcessInfo.processInfo.hostName,
                clientNonce: UUID.clientNonceV4()
            )
        }
        bindingStore.remoteComplete = { bindingToken in
            try await coordinator.withAccessToken { token in
                try await api.completePhoneBinding(
                    bindingToken: bindingToken,
                    clientNonce: UUID.clientNonceV4(),
                    token: token
                )
            }
        }

        let notificationStore = NotificationSettingsStore()
        notificationStore.configureRemote(
            loader: {
                let response = try await coordinator.withAccessToken { token in
                    try await api.notificationSettings(token: token)
                }
                return NotificationSettings(response: response)
            },
            updater: { patch in
                let response = try await coordinator.withAccessToken { token in
                    try await api.updateNotificationSettings(patch, token: token)
                }
                return NotificationSettings(response: response)
            }
        )

        let pushStore = PushRegistrationStore()
        pushStore.configureRemote(
            loader: {
                let response = try await coordinator.withAccessToken { token in
                    try await api.currentPushRegistration(token: token)
                }
                return response.map { PushRegistration(response: $0) }
            },
            registrar: { deviceTokenHex, environment in
                let response = try await coordinator.withAccessToken { token in
                    try await api.upsertPushRegistration(
                        deviceTokenHex: deviceTokenHex,
                        environment: environment,
                        token: token
                    )
                }
                return PushRegistration(response: response)
            },
            unregistrar: {
                try await coordinator.withAccessToken { token in
                    try await api.unregisterCurrentPushRegistration(token: token)
                }
            }
        )

        let preferencesStore = ChatPreferencesStore()
        let preferencesBinding = preferencesStore.configureRemote(
            accountID: userID,
            loader: { chatID in
                let response = try await coordinator.withAccessToken { token in
                    try await api.chatPreferences(chatID: chatID, token: token)
                }
                return ChatPreferences(response: response)
            },
            updater: { chatID, patch in
                let response = try await coordinator.withAccessToken { token in
                    try await api.updateChatPreferences(chatID: chatID, patch: patch, token: token)
                }
                return ChatPreferences(response: response)
            }
        )
        preferencesStore.replaceConfirmed(
            Dictionary(uniqueKeysWithValues: remoteChats.map { ($0.id, $0.preferences) })
        )

        let draftsStore: SynchronizedChatDraftStore?
        let draftsBinding: SynchronizedChatDraftSessionBinding?
        if capabilityState.capabilities?.supportsSynchronizedDrafts == true {
            let configuredDrafts = SynchronizedChatDraftStore()
            draftsBinding = configuredDrafts.configureRemote(
                accountID: userID,
                sessionID: credentials.sessionID,
                loader: { chatID in
                    try await coordinator.withAccessToken { token in
                        try await api.chatDraft(chatID: chatID, token: token)
                    }
                },
                putter: { chatID, command in
                    try await coordinator.withAccessToken { token in
                        try await api.putChatDraft(
                            chatID: chatID,
                            command: command,
                            token: token
                        )
                    }
                },
                deleter: { chatID, command in
                    try await coordinator.withAccessToken { token in
                        try await api.deleteChatDraft(
                            chatID: chatID,
                            command: command,
                            token: token
                        )
                    }
                }
            )
            draftsStore = configuredDrafts
        } else {
            draftsStore = nil
            draftsBinding = nil
        }
        store.configureSynchronizedDrafts(draftsStore)

        let foldersStore = ChatFoldersStore()
        let foldersBinding = foldersStore.configureRemote(
            accountID: userID,
            loader: {
                try await coordinator.withAccessToken { token in
                    try await chatFoldersAPI.folders(token: token)
                }
            },
            creator: { command in
                try await coordinator.withAccessToken { token in
                    try await chatFoldersAPI.create(command, token: token)
                }
            },
            updater: { folderID, command in
                try await coordinator.withAccessToken { token in
                    try await chatFoldersAPI.patch(
                        folderID: folderID,
                        command: command,
                        token: token
                    )
                }
            },
            deleter: { folderID, command in
                try await coordinator.withAccessToken { token in
                    try await chatFoldersAPI.delete(
                        folderID: folderID,
                        command: command,
                        token: token
                    )
                }
            },
            reorderer: { command in
                try await coordinator.withAccessToken { token in
                    try await chatFoldersAPI.reorder(command, token: token)
                }
            }
        )
        try foldersStore.replaceConfirmed(remoteChatFolders, binding: foldersBinding)

        let communityAPI = self.communityAPI
        let communitiesStore = CommunityStore(
            currentUserID: userID,
            communities: store.conversations
        )
        communitiesStore.configureRemote(
            creator: { kind, title, memberIDs in
                try await coordinator.withAccessToken { token in
                    try await communityAPI.createCommunity(
                        kind: kind,
                        title: title,
                        memberIDs: memberIDs,
                        token: token
                    )
                }.conversation(currentUserID: userID)
            },
            communityLoader: { chatID in
                try await coordinator.withAccessToken { token in
                    try await communityAPI.community(chatID: chatID, token: token)
                }.conversation(currentUserID: userID)
            },
            memberLoader: { chatID in
                try await coordinator.withAccessToken { token in
                    try await communityAPI.communityMembers(chatID: chatID, token: token)
                }
            },
            exactUserLookup: { username in
                try await coordinator.withAccessToken { token in
                    try await api.lookupUser(username: username, token: token)
                }?.participant
            },
            memberAdder: { chatID, memberID, role, nonce in
                try await coordinator.withAccessToken { token in
                    try await communityAPI.addCommunityMember(
                        chatID: chatID,
                        userID: memberID,
                        role: role,
                        clientNonce: nonce,
                        token: token
                    )
                }
            },
            memberRoleUpdater: { chatID, memberID, role, revision, nonce in
                try await coordinator.withAccessToken { token in
                    try await communityAPI.updateCommunityMemberRole(
                        chatID: chatID,
                        userID: memberID,
                        role: role,
                        expectedRevision: revision,
                        clientNonce: nonce,
                        token: token
                    )
                }
            },
            memberRemover: { chatID, memberID, revision, nonce in
                try await coordinator.withAccessToken { token in
                    try await communityAPI.removeCommunityMember(
                        chatID: chatID,
                        userID: memberID,
                        expectedRevision: revision,
                        clientNonce: nonce,
                        token: token
                    )
                }
            }
        )
        communitiesStore.configureProjectionObservers(
            communityUpdated: { [weak store] conversation in
                store?.applyConfirmedCommunityIdentity(conversation)
            },
            communityRemoved: { [weak store] chatID in
                store?.applyConfirmedConversationRemoval(chatID)
            },
            communityMetadataUpdated: { [weak store] chatID, memberCount, serverRole in
                store?.applyConfirmedCommunityMetadata(
                    chatID: chatID,
                    memberCount: memberCount,
                    serverRole: serverRole
                )
            }
        )
        if let bootstrapReconciliation {
            try ScopedReconciliationPublisher.publish(
                bootstrapReconciliation,
                currentUserID: userID,
                messengerStore: store,
                communityStore: communitiesStore,
                preferencesStore: preferencesStore,
                foldersStore: foldersStore,
                foldersBinding: foldersBinding
            )
        }
        let finalDurableProjection = store.durableConfirmedProjection()
        if let bootstrapReconciliation {
            try? await durableMessaging.replaceConfirmedProjectionAndCheckpoint(
                scope: durableScope,
                conversations: finalDurableProjection.conversations,
                messages: finalDurableProjection.messages,
                checkpoint: DurableRealtimeCheckpoint(
                    sequence: bootstrapReconciliation.boundary.sequence,
                    cursor: bootstrapReconciliation.boundary.cursor,
                    capturedAt: bootstrapReconciliation.boundary.capturedAt,
                    expiresAt: bootstrapReconciliation.boundary.cursorExpiresAt
                )
            )
        } else {
            try? await durableMessaging.replaceConfirmedProjection(
                scope: durableScope,
                conversations: finalDurableProjection.conversations,
                messages: finalDurableProjection.messages
            )
        }
        if let durableState = try? await durableMessaging.state(scope: durableScope) {
            store.restoreDurablePendingTextOutbox(durableState.pendingTextOutbox)
        }

        messengerStore?.cancelRemoteOperations()
        deviceSessionsStore?.cancelRemoteOperations()
        phonePasswordSettingsStore?.cancelRemoteOperations()
        notificationSettingsStore?.cancelRemoteOperations()
        chatPreferencesStore?.resetForSessionReplacement()
        chatFoldersStore?.resetForSessionReplacement()
        communityStore?.cancelRemoteOperations()
        globalSearchStore?.resetForSessionReplacement()
        synchronizedDraftStore?.resetForSessionReplacement()
        pushNotificationLifecycle.detach()
        if let previousCoordinator = credentialCoordinator {
            await previousCoordinator.invalidate()
        }
        if let previousDurableScope = durableMessagingScope,
           previousDurableScope != durableScope {
            try? await durableMessaging.remove(scope: previousDurableScope)
        }
        let avatarCacheNamespace = [
            configuration.apiBaseURL.absoluteURL.absoluteString,
            credentials.sessionID.uuidString.lowercased()
        ].joined(separator: "|")
        await avatarImageCache.configure(namespace: avatarCacheNamespace) { path in
            try await coordinator.withAccessToken { token in
                try await api.avatarImageData(path: path, token: token)
            }
        }
        await attachmentImageCache.configure(namespace: avatarCacheNamespace) { path in
            try await coordinator.withAccessToken { token in
                try await api.attachmentData(path: path, token: token)
            }
        }
        if let bootstrapReconciliation {
            try await coordinator.commitRealtimeV2Cursor(
                bootstrapReconciliation.boundary.cursor
            )
            realtimeV2Sequence = bootstrapReconciliation.boundary.sequence
        } else {
            realtimeV2Sequence = nil
        }
        credentialCoordinator = coordinator
        currentUserID = user.id
        durableMessagingScope = durableScope
        messengerStore = store
        deviceSessionsStore = sessionsStore
        phonePasswordSettingsStore = passwordSettingsStore
        phoneBindingStore = bindingStore
        notificationSettingsStore = notificationStore
        pushRegistrationStore = pushStore
        chatPreferencesStore = preferencesStore
        chatPreferencesBinding = preferencesBinding
        chatFoldersStore = foldersStore
        chatFoldersBinding = foldersBinding
        communityStore = communitiesStore
        globalSearchStore = searchStore
        synchronizedDraftStore = draftsStore
        synchronizedDraftBinding = draftsBinding
        pushNotificationLifecycle.attach(pushStore)
        store.connectionState = .connecting
        phase = .authenticated
        startRealtime(userID: user.id, store: store)

        Task { @MainActor [weak self, weak store] in
            let result = await durableMessaging.replayPending(
                scope: durableScope,
                sender: durableRemoteSender
            )
            guard let self,
                  let store,
                  self.durableMessagingScope == durableScope,
                  self.messengerStore === store
            else { return }
            result.confirmed.forEach(store.applyDurableOutboxConfirmation)
            if let failedNonce = result.stoppedAtNonce {
                store.applyDurableOutboxFailure(
                    clientNonce: failedNonce,
                    detail: result.errorDescription
                )
            }
        }

        Task { @MainActor [weak self] in
            await self?.synchronizeNotificationFoundation(
                notificationStore: notificationStore,
                pushStore: pushStore
            )
        }

        #if os(iOS)
        if let pendingAvatar = try? PendingProfileAvatarStore.load(username: user.username) {
            Task { @MainActor [weak store] in
                guard let store else { return }
                if await store.updateCurrentUserAvatar(pngData: pendingAvatar) {
                    try? PendingProfileAvatarStore.remove(username: user.username)
                }
            }
        }
        #endif
    }

    private func synchronizeNotificationFoundation(
        notificationStore: NotificationSettingsStore,
        pushStore: PushRegistrationStore
    ) async {
        guard phase == .authenticated,
              notificationSettingsStore === notificationStore,
              pushRegistrationStore === pushStore
        else { return }

        await notificationStore.refresh()
        guard phase == .authenticated,
              notificationSettingsStore === notificationStore,
              pushRegistrationStore === pushStore
        else { return }

        await pushNotificationLifecycle.synchronizeAttachedStore()
    }

    /// Applies archive/mute only from the server-confirmed account projection.
    /// A failed or cancelled request leaves the inbox unchanged.
    @discardableResult
    public func updateChatPreferences(
        chatID: UUID,
        patch: ChatPreferencesPatch
    ) async -> Bool {
        guard phase == .authenticated,
              let preferencesStore = chatPreferencesStore,
              let store = messengerStore
        else { return false }
        let updated = await preferencesStore.update(chatID, patch: patch)
        guard updated,
              phase == .authenticated,
              chatPreferencesStore === preferencesStore,
              messengerStore === store,
              let confirmed = preferencesStore.preferences(for: chatID)
        else { return false }
        store.applyConfirmedChatPreferences(confirmed, chatID: chatID)
        return true
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

    private func purgeDurableMessagingScope(
        fallbackSessionID: UUID? = nil,
        purgeAllIfUnresolved: Bool = false
    ) async {
        if let scope = durableMessagingScope {
            // Clear ownership before awaiting disk I/O. A late network
            // completion is fenced by the persistence epoch and cannot
            // recreate this session directory after logout.
            durableMessagingScope = nil
            try? await durableMessaging.remove(scope: scope)
            return
        }
        if let fallbackSessionID {
            try? await durableMessaging.removeSession(fallbackSessionID)
            return
        }
        if purgeAllIfUnresolved {
            try? await durableMessaging.removeAll()
        }
    }

    private func storedSessionIDForDurablePurge() -> UUID? {
        do {
            return try keychain.load()?.sessionID
        } catch {
            return nil
        }
    }

    private func persistDurableRealtimeCheckpoint(
        sequence: Int,
        cursor: String,
        capturedAt: Date = .now,
        expiresAt: Date? = nil,
        store: MessengerStore
    ) async {
        guard let scope = durableMessagingScope, messengerStore === store else { return }
        let projection = store.durableConfirmedProjection()
        try? await durableMessaging.replaceConfirmedProjectionAndCheckpoint(
            scope: scope,
            conversations: projection.conversations,
            messages: projection.messages,
            checkpoint: DurableRealtimeCheckpoint(
                sequence: sequence,
                cursor: cursor,
                capturedAt: capturedAt,
                expiresAt: expiresAt ?? capturedAt.addingTimeInterval(604_800)
            )
        )
    }

    #if DEBUG
    /// Clears persisted UI-test state before SwiftUI starts its restoration
    /// task. A newly-created ApplicationSession has no credential coordinator,
    /// so this synchronous launch hook cannot race an in-flight refresh.
    public func resetPersistedSessionForUITestLaunch() {
        precondition(credentialCoordinator == nil)
        messengerStore?.cancelRemoteOperations()
        deviceSessionsStore?.cancelRemoteOperations()
        phonePasswordSettingsStore?.cancelRemoteOperations()
        notificationSettingsStore?.cancelRemoteOperations()
        chatPreferencesStore?.resetForSessionReplacement()
        chatFoldersStore?.resetForSessionReplacement()
        communityStore?.cancelRemoteOperations()
        globalSearchStore?.resetForSessionReplacement()
        synchronizedDraftStore?.resetForSessionReplacement()
        pushNotificationLifecycle.detach()
        cancelRealtime(resetSequence: true)
        try? keychain.clear()
        currentUserID = nil
        messengerStore = nil
        deviceSessionsStore = nil
        phonePasswordSettingsStore = nil
        phoneBindingStore = nil
        notificationSettingsStore = nil
        pushRegistrationStore = nil
        chatPreferencesStore = nil
        chatPreferencesBinding = nil
        chatFoldersStore = nil
        chatFoldersBinding = nil
        communityStore = nil
        globalSearchStore = nil
        synchronizedDraftStore = nil
        synchronizedDraftBinding = nil
        resetPhoneAuthenticationCommands()
        errorMessage = nil
        phase = .unauthenticated
    }

    /// Installs an in-memory, deterministic server-shaped state exclusively for
    /// XCTest and Simulator screenshot review of the production SwiftUI shell.
    /// Release builds do not contain this method or its data.
    public func installDebugUITestMessengerScenario() {
        messengerStore?.cancelRemoteOperations()
        deviceSessionsStore?.cancelRemoteOperations()
        phonePasswordSettingsStore?.cancelRemoteOperations()
        notificationSettingsStore?.cancelRemoteOperations()
        chatPreferencesStore?.resetForSessionReplacement()
        chatFoldersStore?.resetForSessionReplacement()
        communityStore?.cancelRemoteOperations()
        synchronizedDraftStore?.resetForSessionReplacement()
        pushNotificationLifecycle.detach()
        cancelRealtime(resetSequence: true)
        let environment = ProcessInfo.processInfo.environment
        let scenario = DebugMobileScenario.make(
            accessibilityMessageIndex: environment[
                "LUXORA_UI_TEST_ACCESSIBILITY_MESSAGE_INDEX"
            ].flatMap(Int.init),
            accessibilityConversationLimit: environment[
                "LUXORA_UI_TEST_ACCESSIBILITY_CONVERSATION_LIMIT"
            ].flatMap(Int.init),
            synchronizedDraftScenario: DebugSynchronizedDraftScenario(
                environment: environment
            )
        )
        credentialCoordinator = nil
        currentUserID = scenario.store.currentUser.id
        messengerStore = scenario.store
        synchronizedDraftStore = scenario.synchronizedDraftStore
        synchronizedDraftBinding = scenario.synchronizedDraftBinding
        scenario.store.configureSynchronizedDrafts(scenario.synchronizedDraftStore)
        let debugCommunityStore = DebugCommunityScenario.make(messengerStore: scenario.store)
        debugCommunityStore.configureProjectionObservers(
            communityUpdated: { [weak store = scenario.store] conversation in
                store?.applyRealtimeConversation(conversation)
            },
            communityRemoved: { [weak store = scenario.store] chatID in
                store?.applyConfirmedConversationRemoval(chatID)
            },
            communityMetadataUpdated: { [weak store = scenario.store] chatID, memberCount, serverRole in
                store?.applyConfirmedCommunityMetadata(
                    chatID: chatID,
                    memberCount: memberCount,
                    serverRole: serverRole
                )
            }
        )
        for conversation in debugCommunityStore.communities {
            scenario.store.applyRealtimeConversation(conversation)
        }
        communityStore = debugCommunityStore
        let debugSearchCurrentUser = scenario.store.currentUser
        let debugSearchConversations = scenario.store.conversations
        let debugSearchMessages = scenario.store.messagesByConversation
        let debugSearchStore = GlobalSearchStore()
        debugSearchStore.configureRemote(
            people: { query, _ in
                let normalized = query.folding(
                    options: [.caseInsensitive, .diacriticInsensitive],
                    locale: .current
                )
                var seen = Set<UUID>()
                let people = debugSearchConversations
                    .map(\.avatar)
                    .filter { participant in
                        participant.id != debugSearchCurrentUser.id
                            && seen.insert(participant.id).inserted
                            && (participant.displayName.folding(
                                options: [.caseInsensitive, .diacriticInsensitive],
                                locale: .current
                            ).contains(normalized)
                                || participant.username.localizedCaseInsensitiveContains(query))
                    }
                return GlobalSearchPage(items: people, nextCursor: nil)
            },
            messages: { query, _ in
                let results = debugSearchMessages.values
                    .flatMap { $0 }
                    .filter { $0.text.localizedCaseInsensitiveContains(query) }
                    .sorted { $0.sentAt > $1.sentAt }
                    .map {
                        GlobalMessageSearchResult(
                            id: $0.id,
                            conversationID: $0.conversationID,
                            sender: $0.author,
                            text: $0.text,
                            createdAt: $0.sentAt
                        )
                    }
                return GlobalSearchPage(items: results, nextCursor: nil)
            },
            files: { _, _ in GlobalSearchPage(items: [], nextCursor: nil) }
        )
        globalSearchStore = debugSearchStore
        let debugChatFoldersStore = DebugChatFoldersScenario.make(
            conversations: scenario.store.conversations,
            accountID: scenario.store.currentUser.id
        )
        DebugChatFoldersScenario.selectInitialFolder(
            environment["LUXORA_UI_TEST_INITIAL_FOLDER"],
            in: debugChatFoldersStore
        )
        chatFoldersStore = debugChatFoldersStore
        chatFoldersBinding = nil
        let initialPreferences = Dictionary(uniqueKeysWithValues: scenario.store.conversations.map {
            conversation in
            (
                conversation.id,
                ChatPreferences(
                    archivedAt: conversation.isArchived ? Date() : nil,
                    mutedUntil: conversation.isMuted ? .distantFuture : nil
                )
            )
        })
        let debugPreferencesBackend = DebugChatPreferencesBackend(confirmed: initialPreferences)
        let debugPreferencesStore = ChatPreferencesStore()
        chatPreferencesBinding = debugPreferencesStore.configureRemote(
            accountID: scenario.store.currentUser.id,
            loader: { chatID in
                await debugPreferencesBackend.load(chatID: chatID)
            },
            updater: { chatID, patch in
                await debugPreferencesBackend.update(chatID: chatID, patch: patch)
            }
        )
        debugPreferencesStore.replaceConfirmed(initialPreferences)
        chatPreferencesStore = debugPreferencesStore
        deviceSessionsStore = nil
        phonePasswordSettingsStore = nil
        phoneBindingStore = nil
        notificationSettingsStore = nil
        pushRegistrationStore = nil
        resetPhoneAuthenticationCommands()
        capabilityState = .available(scenario.capabilities)
        errorMessage = nil
        phase = .authenticated
    }
    #endif

    private func resetPhoneAuthenticationCommands() {
        phoneBeginCommand.finish()
        phoneVerificationCommand.finish()
        phoneRegistrationCommand.finish()
        phonePasswordCommand.finish()
        phoneAuthenticationFailure = nil
    }

    private func startRealtime(userID: UUID, store: MessengerStore) {
        realtimeTask?.cancel()
        guard let capabilities = capabilityState.capabilities,
              capabilities.features.realtime
        else {
            let message = "Сервер не подтвердил совместимый realtime-контракт."
            store.connectionState = .degraded(message)
            errorMessage = message
            return
        }
        switch capabilities.realtimeProtocolVersion {
        case .legacyV1:
            startLegacyRealtime(userID: userID, store: store)
        case .scopedV2:
            startScopedRealtime(userID: userID, store: store)
        }
    }

    private func startLegacyRealtime(userID: UUID, store: MessengerStore) {
        let realtime = self.realtime
        let resumeFrom = realtimeSequence
        let coordinator = credentialCoordinator
        let expectedCommunityStore = communityStore
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
                    case let .chat(chat, sequence):
                        let conversation = chat.conversation(currentUserID: userID)
                        if conversation.kind == .group || conversation.kind == .channel {
                            try expectedCommunityStore?.validateConfirmedCommunity(conversation)
                        }
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeConversation(conversation)
                        if conversation.kind == .group || conversation.kind == .channel {
                            try expectedCommunityStore?.acceptConfirmedCommunity(conversation)
                        }
                    case let .message(message, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessageSnapshot(message.snapshot(currentUserID: userID))
                    case let .messagePin(chatID, messageID, active, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimePin(chatID: chatID, messageID: messageID, active: active)
                    case let .messageReceipt(chatID, messageID, isRead, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessageReceipt(
                            chatID: chatID,
                            messageID: messageID,
                            isRead: isRead
                        )
                    case let .messageReactions(chatID, messageID, reactions, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessageReactions(
                            chatID: chatID,
                            messageID: messageID,
                            reactions: reactions.map(\.reaction)
                        )
                    case let .chatMembership(event, sequence):
                        let communityProjection = try communityMembershipProjection(event)
                        try expectedCommunityStore?.validateConfirmedMembershipSignal(
                            communityProjection.membership,
                            change: communityProjection.change,
                            causalSequence: sequence
                        )
                        advanceRealtimeSequence(sequence)
                        let requiresReconciliation = store.applyRealtimeMembership(
                            event,
                            currentUserID: userID,
                            causalSequence: sequence
                        )
                        try expectedCommunityStore?.acceptConfirmedMembershipSignal(
                            communityProjection.membership,
                            change: communityProjection.change,
                            causalSequence: sequence
                        )
                        if requiresReconciliation {
                            Task { @MainActor [weak self, weak store, weak expectedCommunityStore] in
                                guard let self,
                                      let store,
                                      let expectedCommunityStore,
                                      ownsRealtime(store: store, userID: userID),
                                      communityStore === expectedCommunityStore
                                else { return }
                                await store.refreshConversations()
                                guard ownsRealtime(store: store, userID: userID),
                                      communityStore === expectedCommunityStore
                                else { return }
                                try? expectedCommunityStore.synchronizeConfirmedCommunities(
                                    store.conversations
                                )
                            }
                        }
                    case let .messageRequestCreated(request, sequence):
                        let item = try request.item()
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessageRequestCreated(item)
                    case let .messageRequestRemoved(requestID, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessageRequestRemoved(requestID)
                    case let .messageRequestAccepted(requestID, chat, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessageRequestAccepted(
                            requestID,
                            conversation: chat.conversation(currentUserID: userID)
                        )
                    case let .messageRequestExpired(requestID, sequence):
                        advanceRealtimeSequence(sequence)
                        store.applyRealtimeMessageRequestExpired(requestID)
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

    private func startScopedRealtime(userID: UUID, store: MessengerStore) {
        guard let coordinator = credentialCoordinator,
              let preferencesStore = chatPreferencesStore,
              let preferencesBinding = chatPreferencesBinding,
              let foldersStore = chatFoldersStore,
              let foldersBinding = chatFoldersBinding,
              let expectedCommunityStore = communityStore
        else {
            store.connectionState = .degraded(LuxoraAPIError.missingSession.localizedDescription)
            return
        }
        let realtime = self.realtime
        let api = self.api
        let expectedDraftStore = synchronizedDraftStore
        let expectedDraftBinding = synchronizedDraftBinding
        realtimeTask = Task { [weak self] in
            guard let self else { return }
            var retryDelaySeconds = 1

            while !Task.isCancelled, ownsRealtime(store: store, userID: userID) {
                do {
                    let token = await coordinator.accessToken()
                    let resumeCursor = await coordinator.realtimeV2Cursor()
                    let expectedSessionID = await coordinator.sessionID()
                    var requiresReconciliation = false

                    stream: for try await signal in realtime.scopedSignals(
                        token: token,
                        resumeCursor: resumeCursor
                    ) {
                        guard !Task.isCancelled,
                              ownsRealtime(store: store, userID: userID),
                              chatPreferencesStore === preferencesStore,
                              chatPreferencesBinding == preferencesBinding,
                              chatFoldersStore === foldersStore,
                              chatFoldersBinding == foldersBinding,
                              communityStore === expectedCommunityStore,
                              synchronizedDraftStore === expectedDraftStore,
                              synchronizedDraftBinding == expectedDraftBinding
                        else { return }

                        switch signal {
                        case let .ready(readyUserID, readySessionID, sequence, _, _, _):
                            guard readyUserID == userID,
                                  readySessionID == expectedSessionID
                            else { throw LuxoraAPIError.invalidResponse }
                            realtimeV2Sequence = max(realtimeV2Sequence ?? 0, sequence)
                            store.connectionState = .connecting

                        case let .dispatch(durable, sequence, cursor):
                            guard sequence > (realtimeV2Sequence ?? 0) else { continue }
                            let durableRequiresReconciliation = try applyScopedDurable(
                                durable,
                                expectedSequence: sequence,
                                userID: userID,
                                store: store,
                                communityStore: expectedCommunityStore
                            )
                            if durableRequiresReconciliation {
                                requiresReconciliation = true
                                break stream
                            }
                            realtimeV2Sequence = sequence
                            try await coordinator.commitRealtimeV2Cursor(cursor)

                        case let .chatPreferences(dispatch):
                            guard dispatch.sequence > (realtimeV2Sequence ?? 0) else {
                                continue
                            }
                            switch preferencesStore.applyRealtime(
                                dispatch,
                                binding: preferencesBinding
                            ) {
                            case .accepted:
                                store.applyConfirmedChatPreferences(
                                    dispatch.preferences,
                                    chatID: dispatch.chatID
                                )
                            case .exactReplay:
                                // The projection already won before cursor
                                // persistence failed. Retry persistence only.
                                break
                            case .rejected:
                                throw LuxoraAPIError.invalidResponse
                            }
                            let preferencesStillOwned = try await ScopedRealtimePostAwaitFence.run {
                                try await coordinator.commitRealtimeV2Cursor(dispatch.cursor)
                            } stillOwnsSession: {
                                self.ownsScopedRealtime(
                                    coordinator: coordinator,
                                    store: store,
                                    userID: userID,
                                    preferencesStore: preferencesStore,
                                    preferencesBinding: preferencesBinding,
                                    foldersStore: foldersStore,
                                    foldersBinding: foldersBinding,
                                    communityStore: expectedCommunityStore
                                )
                            } publish: {
                                self.realtimeV2Sequence = dispatch.sequence
                            }
                            guard preferencesStillOwned else { return }

                        case let .chatFolders(dispatch):
                            guard dispatch.sequence > (realtimeV2Sequence ?? 0),
                                  dispatch.accountID == userID
                            else {
                                if dispatch.sequence <= (realtimeV2Sequence ?? 0) { continue }
                                throw LuxoraAPIError.invalidResponse
                            }
                            let requiresFolderRefresh = foldersStore.applyRealtime(
                                dispatch,
                                binding: foldersBinding
                            )
                            if dispatch.stateRevision > foldersStore.stateRevision {
                                guard requiresFolderRefresh else {
                                    throw LuxoraAPIError.invalidResponse
                                }
                                let refreshed = await foldersStore.refreshForRealtime(
                                    minimumStateRevision: dispatch.stateRevision
                                )
                                guard refreshed else {
                                    requiresReconciliation = true
                                    break stream
                                }
                            }
                            guard ownsScopedRealtime(
                                coordinator: coordinator,
                                store: store,
                                userID: userID,
                                preferencesStore: preferencesStore,
                                preferencesBinding: preferencesBinding,
                                foldersStore: foldersStore,
                                foldersBinding: foldersBinding,
                                communityStore: expectedCommunityStore
                            ) else { return }
                            let foldersStillOwned = try await ScopedRealtimePostAwaitFence.run {
                                try await coordinator.commitRealtimeV2Cursor(dispatch.cursor)
                            } stillOwnsSession: {
                                self.ownsScopedRealtime(
                                    coordinator: coordinator,
                                    store: store,
                                    userID: userID,
                                    preferencesStore: preferencesStore,
                                    preferencesBinding: preferencesBinding,
                                    foldersStore: foldersStore,
                                    foldersBinding: foldersBinding,
                                    communityStore: expectedCommunityStore
                                )
                            } publish: {
                                try foldersStore.commitRealtime(
                                    dispatch,
                                    binding: foldersBinding
                                )
                                self.realtimeV2Sequence = dispatch.sequence
                            }
                            guard foldersStillOwned else { return }

                        case let .chatDraft(dispatch):
                            guard dispatch.sequence > (realtimeV2Sequence ?? 0),
                                  dispatch.accountID == userID,
                                  let expectedDraftStore,
                                  let expectedDraftBinding,
                                  synchronizedDraftStore === expectedDraftStore,
                                  synchronizedDraftBinding == expectedDraftBinding
                            else {
                                if dispatch.sequence <= (realtimeV2Sequence ?? 0) { continue }
                                throw LuxoraAPIError.invalidResponse
                            }
                            if store.conversations.contains(where: { $0.id == dispatch.chatID }) {
                                switch expectedDraftStore.applyRealtime(
                                    dispatch,
                                    binding: expectedDraftBinding
                                ) {
                                case .accepted:
                                    store.applySynchronizedDraftProjection(for: dispatch.chatID)
                                case .exactReplay, .causalNoOp, .stale:
                                    // The HTTP projection or the first delivery
                                    // is already at least as new. Advance only
                                    // the account cursor.
                                    break
                                case .rejected:
                                    throw LuxoraAPIError.invalidResponse
                                }
                            } else {
                                // Membership removal is authoritative. A later
                                // same-account draft frame (including its normal
                                // tombstone) is cursor-safe but must not recreate
                                // an orphan per-chat projection.
                                expectedDraftStore.removeChat(dispatch.chatID)
                            }
                            let draftStillOwned = try await ScopedRealtimePostAwaitFence.run {
                                try await coordinator.commitRealtimeV2Cursor(dispatch.cursor)
                            } stillOwnsSession: {
                                self.ownsScopedRealtime(
                                    coordinator: coordinator,
                                    store: store,
                                    userID: userID,
                                    preferencesStore: preferencesStore,
                                    preferencesBinding: preferencesBinding,
                                    foldersStore: foldersStore,
                                    foldersBinding: foldersBinding,
                                    communityStore: expectedCommunityStore
                                )
                                    && self.synchronizedDraftStore === expectedDraftStore
                                    && self.synchronizedDraftBinding == expectedDraftBinding
                            } publish: {
                                self.realtimeV2Sequence = dispatch.sequence
                            }
                            guard draftStillOwned else { return }

                        case let .syncInvalidated(dispatch):
                            guard dispatch.sequence > (realtimeV2Sequence ?? 0),
                                  dispatch.accountID == userID
                            else {
                                if dispatch.sequence <= (realtimeV2Sequence ?? 0) { continue }
                                throw LuxoraAPIError.invalidResponse
                            }
                            // The payload is an account-scoped invalidation,
                            // never a local patch. Do not commit its cursor: the
                            // bounded B1/resources/B2 reset below commits only
                            // the closing stable boundary.
                            _ = dispatch.reason
                            _ = dispatch.changedAt
                            _ = dispatch.cursor
                            requiresReconciliation = true
                            break stream

                        case let .checkpoint(sequence, cursor):
                            guard sequence >= (realtimeV2Sequence ?? 0) else {
                                throw LuxoraAPIError.invalidResponse
                            }
                            realtimeV2Sequence = sequence
                            let checkpointStillOwned = try await ScopedRealtimePostAwaitFence.run {
                                try await coordinator.commitRealtimeV2Cursor(cursor)
                            } stillOwnsSession: {
                                self.ownsScopedRealtime(
                                    coordinator: coordinator,
                                    store: store,
                                    userID: userID,
                                    preferencesStore: preferencesStore,
                                    preferencesBinding: preferencesBinding,
                                    foldersStore: foldersStore,
                                    foldersBinding: foldersBinding,
                                    communityStore: expectedCommunityStore
                                )
                            } publish: {
                                retryDelaySeconds = 1
                                self.errorMessage = nil
                                store.connectionState = .online
                            }
                            guard checkpointStillOwned else { return }
                            await persistDurableRealtimeCheckpoint(
                                sequence: sequence,
                                cursor: cursor,
                                store: store
                            )

                        case let .typing(conversationID, isTyping):
                            store.setTyping(isTyping, conversationID: conversationID)

                        case .syncRequired:
                            requiresReconciliation = true
                            break stream

                        case let .serverError(code, message):
                            throw LuxoraAPIError.server(
                                status: code == "UNAUTHENTICATED" ? 401 : 503,
                                code: code,
                                message: message
                            )
                        }
                    }

                    guard !Task.isCancelled,
                          ownsRealtime(store: store, userID: userID),
                          communityStore === expectedCommunityStore
                    else {
                        return
                    }
                    if requiresReconciliation {
                        store.connectionState = .connecting
                        let bundle = try await coordinator.withAccessToken { token in
                            try await api.reconciliationBundle(
                                token: token,
                                expectedUserID: userID
                            )
                        }
                        guard ownsRealtime(store: store, userID: userID),
                              chatPreferencesStore === preferencesStore,
                              chatPreferencesBinding == preferencesBinding,
                              chatFoldersStore === foldersStore,
                              chatFoldersBinding == foldersBinding,
                              communityStore === expectedCommunityStore,
                              synchronizedDraftStore === expectedDraftStore,
                              synchronizedDraftBinding == expectedDraftBinding
                        else { return }
                        var draftRecoveryPlan: SynchronizedChatDraftRecoveryPlan?
                        var draftLifecycleResetChatIDs: Set<UUID> = []
                        try ScopedReconciliationPublisher.publish(
                            bundle,
                            currentUserID: userID,
                            messengerStore: store,
                            communityStore: expectedCommunityStore,
                            preferencesStore: preferencesStore,
                            foldersStore: foldersStore,
                            foldersBinding: foldersBinding,
                            beforeCommit: {
                                let retainedChatIDs = Set(bundle.chats.map { $0.chat.id })
                                draftLifecycleResetChatIDs = store
                                    .synchronizedDraftLifecycleResetChatIDs(
                                        in: bundle,
                                        currentUserID: userID
                                    )
                                draftRecoveryPlan = expectedDraftStore?.prepareForRecovery(
                                    retainedChatIDs: retainedChatIDs,
                                    lifecycleResetChatIDs: draftLifecycleResetChatIDs
                                )
                            }
                        )
                        if let draftRecoveryPlan {
                            store.applySynchronizedDraftRecoveryInvalidation(draftRecoveryPlan)
                        } else {
                            // Composer drafts are local even when the optional
                            // server feature is disabled. A membership lifetime
                            // reset is still a privacy boundary for that RAM.
                            store.applyComposerLifecycleReset(
                                chatIDs: draftLifecycleResetChatIDs
                            )
                        }
                        if let expectedDraftStore, let expectedDraftBinding,
                           let selectedChatID = store.selectedConversationID {
                            guard synchronizedDraftStore === expectedDraftStore,
                                  synchronizedDraftBinding == expectedDraftBinding
                            else { return }
                            // Drafts are intentionally outside the current
                            // twelve-collection reconciliation bundle. A gap
                            // invalidates every confirmed draft projection,
                            // then performs at most one eager GET. Background
                            // chats refresh lazily when opened, avoiding an
                            // unbounded 301+ request pass and IP-rate livelock.
                            _ = await expectedDraftStore.refresh(selectedChatID, force: true)
                            guard ownsScopedRealtime(
                                coordinator: coordinator,
                                store: store,
                                userID: userID,
                                preferencesStore: preferencesStore,
                                preferencesBinding: preferencesBinding,
                                foldersStore: foldersStore,
                                foldersBinding: foldersBinding,
                                communityStore: expectedCommunityStore
                            ),
                                  synchronizedDraftStore === expectedDraftStore,
                                  synchronizedDraftBinding == expectedDraftBinding
                            else { return }
                            store.applySynchronizedDraftProjection(for: selectedChatID)
                        }
                        realtimeV2Sequence = bundle.boundary.sequence
                        try await coordinator.commitRealtimeV2Cursor(bundle.boundary.cursor)
                        await persistDurableRealtimeCheckpoint(
                            sequence: bundle.boundary.sequence,
                            cursor: bundle.boundary.cursor,
                            capturedAt: bundle.boundary.capturedAt,
                            expiresAt: bundle.boundary.cursorExpiresAt,
                            store: store
                        )
                        retryDelaySeconds = 1
                        continue
                    }

                    store.connectionState = .offline
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled,
                          ownsRealtime(store: store, userID: userID),
                          communityStore === expectedCommunityStore
                    else {
                        return
                    }
                    let message = error.localizedDescription
                    store.connectionState = Self.isOffline(error) ? .offline : .degraded(message)
                    errorMessage = String(
                        format: LuxoraL10n.text("error.realtime_disconnected"),
                        message
                    )
                    if case LuxoraAPIError.invalidResponse = error { return }
                    if case let LuxoraAPIError.server(status, _, _) = error,
                       status == 401 {
                        // WebSockets cannot participate directly in the HTTP
                        // single-flight refresh path. Probe one authenticated
                        // endpoint so all concurrent stores share the same
                        // rotation before the next socket is opened.
                        _ = try? await coordinator.withAccessToken { token in
                            try await api.currentUser(token: token)
                        }
                    }
                    do {
                        try await Task.sleep(for: .seconds(retryDelaySeconds))
                    } catch {
                        return
                    }
                    retryDelaySeconds = min(retryDelaySeconds * 2, 30)
                }
            }
        }
    }

    func applyScopedDurable(
        _ signal: RealtimeSignal,
        expectedSequence: Int,
        userID: UUID,
        store: MessengerStore,
        communityStore expectedCommunityStore: CommunityStore
    ) throws -> Bool {
        switch signal {
        case let .chat(chat, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            let conversation = chat.conversation(currentUserID: userID)
            if conversation.kind == .group || conversation.kind == .channel {
                try expectedCommunityStore.validateConfirmedCommunity(conversation)
            }
            store.applyRealtimeConversation(conversation)
            if conversation.kind == .group || conversation.kind == .channel {
                try expectedCommunityStore.acceptConfirmedCommunity(conversation)
            }
            chatPreferencesStore?.mergeConfirmedProjection(chat.preferences, chatID: chat.id)
        case let .message(message, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimeMessageSnapshot(message.snapshot(currentUserID: userID))
        case let .messagePin(chatID, messageID, active, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimePin(chatID: chatID, messageID: messageID, active: active)
        case let .messageReceipt(chatID, messageID, isRead, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimeMessageReceipt(chatID: chatID, messageID: messageID, isRead: isRead)
        case let .messageReactions(chatID, messageID, reactions, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimeMessageReactions(
                chatID: chatID,
                messageID: messageID,
                reactions: reactions.map(\.reaction)
            )
        case let .chatMembership(event, sequence):
            guard sequence == expectedSequence,
                  event.audience != .removedAccount || event.membership.userId == userID
            else { throw LuxoraAPIError.invalidResponse }
            let communityProjection = try communityMembershipProjection(event)
            try expectedCommunityStore.validateConfirmedMembershipSignal(
                communityProjection.membership,
                change: communityProjection.change,
                causalSequence: sequence
            )
            let requiresReconciliation = store.applyRealtimeMembership(
                event,
                currentUserID: userID,
                causalSequence: sequence
            )
            try expectedCommunityStore.acceptConfirmedMembershipSignal(
                communityProjection.membership,
                change: communityProjection.change,
                causalSequence: sequence,
            )
            if event.membership.userId == userID, event.change == .removed {
                chatPreferencesStore?.removeConfirmedProjection(chatID: event.membership.chatId)
            }
            return requiresReconciliation
        case let .messageRequestCreated(request, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimeMessageRequestCreated(try request.item())
        case let .messageRequestRemoved(requestID, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimeMessageRequestRemoved(requestID)
        case let .messageRequestAccepted(requestID, chat, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimeMessageRequestAccepted(
                requestID,
                conversation: chat.conversation(currentUserID: userID)
            )
        case let .messageRequestExpired(requestID, sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
            store.applyRealtimeMessageRequestExpired(requestID)
        case let .cursor(sequence):
            guard sequence == expectedSequence else { throw LuxoraAPIError.invalidResponse }
        case .ready, .typing, .syncRequired:
            throw LuxoraAPIError.invalidResponse
        }
        return false
    }

    private func communityMembershipProjection(
        _ event: RealtimeChatMembershipEvent
    ) throws -> (membership: ChatMembership, change: CommunityMembershipSignalChange) {
        guard let role = ChatMembershipRole(rawValue: event.membership.role) else {
            throw LuxoraAPIError.invalidResponse
        }
        let change: CommunityMembershipSignalChange
        switch event.change {
        case .added: change = .added
        case .roleUpdated: change = .roleUpdated
        case .removed: change = .removed
        }
        return (
            ChatMembership(
                chatID: event.membership.chatId,
                userID: event.membership.userId,
                role: role,
                revision: event.membership.revision,
                joinedAt: event.membership.joinedAt,
                updatedAt: event.membership.updatedAt
            ),
            change
        )
    }

    private func ownsRealtime(store: MessengerStore, userID: UUID) -> Bool {
        phase == .authenticated
            && currentUserID == userID
            && messengerStore === store
    }

    private func ownsScopedRealtime(
        coordinator: SessionCredentialCoordinator,
        store: MessengerStore,
        userID: UUID,
        preferencesStore: ChatPreferencesStore,
        preferencesBinding: ChatPreferencesSessionBinding,
        foldersStore: ChatFoldersStore,
        foldersBinding: ChatFoldersSessionBinding,
        communityStore: CommunityStore
    ) -> Bool {
        !Task.isCancelled
            && ownsRealtime(store: store, userID: userID)
            && credentialCoordinator === coordinator
            && chatPreferencesStore === preferencesStore
            && chatPreferencesBinding == preferencesBinding
            && chatFoldersStore === foldersStore
            && chatFoldersBinding == foldersBinding
            && self.communityStore === communityStore
    }

    private func cancelRealtime(resetSequence: Bool) {
        realtimeTask?.cancel()
        realtimeTask = nil
        if resetSequence {
            realtimeSequence = nil
            realtimeV2Sequence = nil
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
