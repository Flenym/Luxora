import SwiftUI

public enum PasskeyPresentationState: Equatable, Sendable {
    case checking
    case unavailable(String)
    case clientIntegrationPending

    var title: String {
        switch self {
        case .checking: LuxoraL10n.text("auth.passkey_checking")
        case .unavailable: LuxoraL10n.text("auth.passkey_unavailable")
        case .clientIntegrationPending: LuxoraL10n.text("auth.passkey_pending")
        }
    }

    var detail: String {
        switch self {
        case .checking:
            LuxoraL10n.text("auth.passkey_check_detail")
        case let .unavailable(message):
            message
        case .clientIntegrationPending:
            LuxoraL10n.text("auth.passkey_pending_detail")
        }
    }

    var symbol: String {
        switch self {
        case .checking: "ellipsis.circle"
        case .unavailable: "key.slash"
        case .clientIntegrationPending: "hammer"
        }
    }
}

public enum AuthenticationInitialMode: String, CaseIterable, Identifiable, Sendable {
    case login
    case register

    public var id: String { rawValue }

    var title: String {
        switch self {
        case .login: LuxoraL10n.text("auth.sign_in")
        case .register: LuxoraL10n.text("auth.create_account")
        }
    }
}

struct AuthenticationView: View {
    @Bindable var session: ApplicationSession

    var body: some View {
        #if os(iOS)
        phoneAuthentication
        #else
        passwordAuthentication
        #endif
    }

    #if os(iOS)
    private var phoneAuthentication: some View {
        let preview = PhoneAuthenticationPreviewConfiguration.current
        return LuxoraPhoneAuthenticationScreen(
            isWorking: session.isWorking,
            isSynchronizing: session.isAuthenticationSyncing,
            serverError: session.errorMessage,
            authenticationFailure: session.phoneAuthenticationFailure,
            initialStep: preview.initialStep,
            allowsPreviewProgression: preview.isEnabled,
            requestCode: { countryCode, nationalNumber in
                await session.requestPhoneCode(
                    countryCode: countryCode,
                    nationalNumber: nationalNumber
                )
            },
            verifyCode: { challengeID, code in
                await session.verifyPhoneCode(challengeID: challengeID, code: code)
            },
            completePassword: { passwordToken, password in
                await session.completePhonePassword(
                    passwordToken: passwordToken,
                    password: password
                )
            },
            startRecovery: { passwordToken in
                await session.startPhoneRecovery(passwordToken: passwordToken)
            },
            completeRecovery: { recoveryToken, newPassword in
                await session.completePhoneRecovery(
                    recoveryToken: recoveryToken,
                    newPassword: newPassword
                )
            },
            checkUsername: { registrationToken, username in
                await session.checkPhoneUsername(
                    registrationToken: registrationToken,
                    username: username
                )
            },
            completeRegistration: { registrationToken, displayName, username, bio in
                await session.completePhoneRegistration(
                    registrationToken: registrationToken,
                    displayName: displayName,
                    username: username,
                    bio: bio
                )
            },
            clearFailure: {
                session.clearPhoneAuthenticationFailure()
            }
        )
    }
    #endif

    private var passwordAuthentication: some View {
        LuxoraAuthenticationScreen(
            apiTarget: session.configuration.apiBaseURL.absoluteString,
            isWorking: session.isWorking,
            errorMessage: session.errorMessage,
            passkeyState: passkeyState,
            login: { username, password in
                Task { await session.login(username: username, password: password) }
            },
            register: { username, displayName, password in
                Task {
                    await session.register(
                        username: username,
                        displayName: displayName,
                        password: password
                    )
                }
            },
            retryCapabilities: {
                Task { await session.refreshCapabilities() }
            }
        )
    }

    private var passkeyState: PasskeyPresentationState {
        switch session.capabilityState {
        case .loading:
            .checking
        case let .unavailable(message):
            .unavailable(String(format: LuxoraL10n.text("auth.passkey_server_error"), message))
        case let .available(capabilities):
            capabilities.features.passkeys
                ? .clientIntegrationPending
                : .unavailable(LuxoraL10n.text("auth.passkey_server_disabled"))
        }
    }
}

public struct LuxoraAuthenticationScreen: View {
    private let apiTarget: String
    private let isWorking: Bool
    private let errorMessage: String?
    private let passkeyState: PasskeyPresentationState
    private let login: (String, String) -> Void
    private let register: (String, String, String) -> Void
    private let retryCapabilities: () -> Void

    @State private var mode: AuthenticationInitialMode
    @State private var username = ""
    @State private var displayName = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field {
        case username
        case displayName
        case password
    }

    public init(
        apiTarget: String,
        isWorking: Bool,
        errorMessage: String?,
        passkeyState: PasskeyPresentationState,
        initialMode: AuthenticationInitialMode = .login,
        login: @escaping (String, String) -> Void,
        register: @escaping (String, String, String) -> Void,
        retryCapabilities: @escaping () -> Void
    ) {
        self.apiTarget = apiTarget
        self.isWorking = isWorking
        self.errorMessage = errorMessage
        self.passkeyState = passkeyState
        _mode = State(initialValue: initialMode)
        self.login = login
        self.register = register
        self.retryCapabilities = retryCapabilities
    }

    public var body: some View {
        ZStack {
            LuxoraTheme.ink.ignoresSafeArea()
            LuxoraTheme.ambientGradient.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 22) {
                    brand
                    authenticationCard
                    buildIdentity
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 22)
                .padding(.top, 34)
                .padding(.bottom, 30)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .accessibilityIdentifier("auth-screen")
        .onChange(of: mode) { _, _ in
            password = ""
        }
    }

    private var brand: some View {
        VStack(spacing: 10) {
            LuxoraLogoView(size: 76)
            Text("Luxora")
                .font(.system(size: 38, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            Text(LuxoraL10n.text("auth.tagline"))
                .font(.callout)
                .foregroundStyle(.white.opacity(0.72))
                .multilineTextAlignment(.center)
        }
        .accessibilityElement(children: .combine)
    }

    private var authenticationCard: some View {
        GlassSurface(cornerRadius: 28) {
            VStack(spacing: 15) {
                Picker(LuxoraL10n.text("auth.authentication"), selection: $mode) {
                    ForEach(AuthenticationInitialMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("auth-mode")

                authTextField(
                    title: LuxoraL10n.text("auth.username"),
                    text: $username,
                    field: .username,
                    submitLabel: mode == .register ? .next : .continue
                ) {
                    focusedField = mode == .register ? .displayName : .password
                }
                .textContentType(.username)
                .accessibilityIdentifier("auth-username")

                if mode == .register {
                    authTextField(
                        title: LuxoraL10n.text("auth.display_name"),
                        text: $displayName,
                        field: .displayName,
                        submitLabel: .next
                    ) {
                        focusedField = .password
                    }
                    .textContentType(.name)
                    .accessibilityIdentifier("auth-display-name")
                }

                SecureField(
                    "",
                    text: $password,
                    prompt: Text(LuxoraL10n.text("auth.password"))
                        .foregroundStyle(.white.opacity(0.58))
                )
                .textContentType(mode == .login ? .password : .newPassword)
                .focused($focusedField, equals: .password)
                .submitLabel(.go)
                .onSubmit(authenticate)
                .modifier(AuthenticationFieldSurface())
                .accessibilityLabel(LuxoraL10n.text("auth.password_accessibility"))
                .accessibilityIdentifier("auth-password")

                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("auth-error")
                }

                Button(action: authenticate) {
                    HStack(spacing: 8) {
                        if isWorking {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        }
                        Text(mode.title)
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 48)
                }
                .buttonStyle(AuthenticationPrimaryButtonStyle(enabled: isValid && !isWorking))
                .disabled(!isValid || isWorking)
                .accessibilityIdentifier("auth-submit")

                Divider()
                    .overlay(.white.opacity(0.14))

                passkeyStatus
            }
            .padding(20)
        }
        .frame(maxWidth: 440)
    }

    private var passkeyStatus: some View {
        VStack(spacing: 8) {
            Button(action: {}) {
                Label(LuxoraL10n.text("auth.passkey_continue"), systemImage: "person.badge.key.fill")
                    .font(.callout.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 44)
            }
            .buttonStyle(AuthenticationUnavailableButtonStyle())
            .disabled(true)
            .accessibilityIdentifier("auth-passkey")

            HStack(alignment: .top, spacing: 8) {
                if passkeyState == .checking {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(LuxoraTheme.iris)
                } else {
                    Image(systemName: passkeyState.symbol)
                        .foregroundStyle(LuxoraTheme.iris)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(passkeyState.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.86))
                    Text(passkeyState.detail)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.58))
                }
                Spacer(minLength: 4)
                if case .unavailable = passkeyState {
                    Button(LuxoraL10n.text("common.retry"), action: retryCapabilities)
                        .font(.caption.weight(.semibold))
                        .accessibilityLabel(LuxoraL10n.text("auth.passkey_status_retry"))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("auth-passkey-status")
        }
    }

    private var buildIdentity: some View {
        VStack(spacing: 4) {
            Label(LuxoraL10n.text("auth.server"), systemImage: "server.rack")
            Text(apiTarget)
                .lineLimit(1)
                .truncationMode(.middle)
            Text("Beta-0.1 · Flenym")
        }
        .font(.caption2)
        .foregroundStyle(.white.opacity(0.54))
        .accessibilityElement(children: .combine)
    }

    private func authTextField(
        title: String,
        text: Binding<String>,
        field: Field,
        submitLabel: SubmitLabel,
        onSubmit: @escaping () -> Void
    ) -> some View {
        TextField(
            "",
            text: text,
            prompt: Text(title).foregroundStyle(.white.opacity(0.58))
        )
        .autocorrectionDisabled()
        .focused($focusedField, equals: field)
        .submitLabel(submitLabel)
        .onSubmit(onSubmit)
        .modifier(AuthenticationFieldSurface())
        .accessibilityLabel(title)
    }

    private var isValid: Bool {
        username.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3
            && password.count >= 12
            && (mode == .login
                || !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func authenticate() {
        guard isValid, !isWorking else { return }
        switch mode {
        case .login:
            login(username, password)
        case .register:
            register(username, displayName, password)
        }
    }
}

private struct AuthenticationFieldSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.body)
            .foregroundStyle(.white)
            .tint(.white)
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(Color.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 13))
            .overlay {
                RoundedRectangle(cornerRadius: 13)
                    .stroke(Color.white.opacity(0.16), lineWidth: 1)
            }
    }
}

private struct AuthenticationPrimaryButtonStyle: ButtonStyle {
    let enabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(enabled ? Color.white : Color.white.opacity(0.46))
            .background {
                RoundedRectangle(cornerRadius: 14)
                    .fill(
                        enabled
                            ? AnyShapeStyle(LuxoraTheme.brandGradient)
                            : AnyShapeStyle(Color.white.opacity(0.08))
                    )
            }
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Color.white.opacity(enabled ? 0.16 : 0.08), lineWidth: 1)
            }
            .scaleEffect(configuration.isPressed && enabled ? 0.985 : 1)
    }
}

private struct AuthenticationUnavailableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Color.white.opacity(0.64))
            .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 13))
            .overlay {
                RoundedRectangle(cornerRadius: 13)
                    .stroke(Color.white.opacity(0.16), lineWidth: 1)
            }
    }
}
