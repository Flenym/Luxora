#if os(iOS)
import SwiftUI

enum PhoneAuthenticationStep: String, Sendable {
    case welcome
    case phone
    case code
    case password
    case recovery
    case profile
    case username
    case permissions
    case sync
    case completed
    case transition
}

private enum PhoneUsernameStatus: Equatable {
    case idle
    case invalid
    case checking
    case available
    case taken([String])
    case unavailable(String)
}

struct PhoneAuthenticationPreviewConfiguration: Sendable {
    let isEnabled: Bool
    let initialStep: PhoneAuthenticationStep

    static var current: PhoneAuthenticationPreviewConfiguration {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_UI_TEST_AUTH_PREVIEW"] == "1" else {
            return .init(isEnabled: false, initialStep: .welcome)
        }
        let requested = environment["LUXORA_UI_TEST_AUTH_STEP"]
            .flatMap(PhoneAuthenticationStep.init(rawValue:))
        return .init(isEnabled: true, initialStep: requested ?? .welcome)
        #else
        return .init(isEnabled: false, initialStep: .welcome)
        #endif
    }
}

public struct LuxoraPhoneAuthenticationScreen: View {
    private let isWorking: Bool
    private let isSynchronizing: Bool
    private let serverError: String?
    private let authenticationFailure: PhoneAuthenticationFailure?
    private let allowsPreviewProgression: Bool
    private let requestCode: @MainActor (String, String) async -> PhoneCodeChallenge?
    private let verifyCode: @MainActor (String, String) async -> PhoneCodeVerificationResult?
    private let completePassword: @MainActor (String, String) async -> Bool
    private let startRecovery: @MainActor (String) async -> PhoneRecoveryIntent?
    private let completeRecovery: @MainActor (String, String) async -> Bool
    private let checkUsername: @MainActor (String, String) async -> PhoneUsernameAvailability?
    private let completeRegistration: @MainActor (String, String, String, String) async -> Bool
    private let clearFailure: @MainActor () -> Void

    @State private var step: PhoneAuthenticationStep
    @State private var transitionTarget: PhoneAuthenticationStep?
    @State private var transitionSequence = 0
    @State private var isCountryPickerPresented = false
    @State private var selectedCountry = PhoneCountry.russia
    @State private var nationalNumber = ""
    @State private var code = ""
    @State private var password = ""
    @State private var passwordChallenge: PhonePasswordChallenge?
    @State private var revealsPassword = false
    @State private var recoveryIntent: PhoneRecoveryIntent?
    @State private var newPassword = ""
    @State private var revealsNewPassword = false
    @State private var displayName = ""
    @State private var bio = ""
    @State private var username = ""
    @State private var usernameStatus: PhoneUsernameStatus = .idle
    @State private var avatarPNGData: Data?
    @State private var introLogoIsVisible = false
    @State private var introCopyIsVisible = false
    @State private var challenge: PhoneCodeChallenge?
    @State private var registration: PhoneRegistrationChallenge?
    @State private var retryAvailableAt: Date?
    @State private var beginRetryAvailableAt: Date?
    @State private var localMessage: String?
    @FocusState private var focusedField: FocusField?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage("luxora.phoneAuth.didCompleteIntro") private var didCompleteIntro = false
    @AppStorage("luxora.phoneAuth.needsPermissions") private var needsPostRegistrationPermissions = false

    private enum FocusField {
        case phone
        case code
        case password
        case newPassword
        case displayName
        case bio
        case username
    }

    init(
        isWorking: Bool,
        isSynchronizing: Bool,
        serverError: String?,
        authenticationFailure: PhoneAuthenticationFailure?,
        initialStep: PhoneAuthenticationStep = .welcome,
        allowsPreviewProgression: Bool = false,
        requestCode: @escaping @MainActor (String, String) async -> PhoneCodeChallenge?,
        verifyCode: @escaping @MainActor (String, String) async -> PhoneCodeVerificationResult?,
        completePassword: @escaping @MainActor (String, String) async -> Bool,
        startRecovery: @escaping @MainActor (String) async -> PhoneRecoveryIntent?,
        completeRecovery: @escaping @MainActor (String, String) async -> Bool,
        checkUsername: @escaping @MainActor (String, String) async -> PhoneUsernameAvailability?,
        completeRegistration: @escaping @MainActor (String, String, String, String) async -> Bool,
        clearFailure: @escaping @MainActor () -> Void
    ) {
        self.isWorking = isWorking
        self.isSynchronizing = isSynchronizing
        self.serverError = serverError
        self.authenticationFailure = authenticationFailure
        self.allowsPreviewProgression = allowsPreviewProgression
        self.requestCode = requestCode
        self.verifyCode = verifyCode
        self.completePassword = completePassword
        self.startRecovery = startRecovery
        self.completeRecovery = completeRecovery
        self.checkUsername = checkUsername
        self.completeRegistration = completeRegistration
        self.clearFailure = clearFailure
        _step = State(initialValue: initialStep)

        #if DEBUG
        _challenge = State(initialValue: initialStep == .code ? .uiTestPreview : nil)
        _passwordChallenge = State(initialValue: initialStep == .password ? .uiTestPreview : nil)
        _registration = State(
            initialValue: [.profile, .username, .permissions, .sync].contains(initialStep)
                ? .uiTestPreview
                : nil
        )
        _displayName = State(
            initialValue: [.username, .permissions, .sync].contains(initialStep) ? "Егор Flenym" : ""
        )
        _bio = State(
            initialValue: [.username, .permissions, .sync].contains(initialStep)
                ? "Разработчик Luxora"
                : ""
        )
        _username = State(initialValue: initialStep == .username ? "flenym" : "")
        _retryAvailableAt = State(
            initialValue: initialStep == .code ? Date().addingTimeInterval(30) : nil
        )
        #endif
    }

    public var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if isCountryPickerPresented {
                PhoneCountryPicker(selection: $selectedCountry) {
                    isCountryPickerPresented = false
                }
                .transition(.opacity)
                .zIndex(2)
            } else {
                switch step {
                case .welcome:
                    welcomeScreen
                case .phone:
                    phoneScreen
                case .code:
                    codeScreen
                case .password:
                    passwordScreen
                case .recovery:
                    recoveryScreen
                case .profile:
                    profileScreen
                case .username:
                    usernameScreen
                case .permissions:
                    permissionsPreviewScreen
                case .sync:
                    authenticationSyncScreen
                case .completed:
                    completedScreen
                case .transition:
                    PhoneContourTransitionView()
                        .transition(.opacity)
                }
            }
        }
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .onChange(of: selectedCountry) { _, _ in
            nationalNumber = String(nationalNumber.filter(\.isNumber).prefix(maxNationalDigits))
            localMessage = nil
            beginRetryAvailableAt = nil
            clearFailure()
        }
        .onChange(of: authenticationFailure) { _, failure in
            guard let failure else { return }
            localMessage = nil
            if case let .resendCooldown(seconds) = failure {
                let availableAt = Date().addingTimeInterval(TimeInterval(seconds))
                if step == .code {
                    retryAvailableAt = availableAt
                } else {
                    beginRetryAvailableAt = availableAt
                }
            }
            if failure == .invalidCode {
                focusedField = .code
            }
            if failure == .invalidPassword {
                #if DEBUG
                if let livePassword = uiTestFragmentedValue(
                    prefixKey: "LUXORA_LIVE_PHONE_PASSWORD_PREFIX",
                    suffixKey: "LUXORA_LIVE_PHONE_PASSWORD_SUFFIX"
                ) {
                    password = livePassword
                }
                #endif
                focusedField = .password
            }
            if step == .sync, failure.isRetryable {
                transition(to: registration == nil ? .code : .username)
            }
        }
        .onChange(of: isSynchronizing) { _, syncing in
            if syncing, step == .code || step == .password || step == .username {
                focusedField = nil
                step = .sync
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                if focusedField == .bio {
                    Button("Назад") { focusedField = .displayName }
                        .accessibilityIdentifier("auth-keyboard-previous")
                }
                if focusedField == .displayName {
                    Button("Далее") { focusedField = .bio }
                        .accessibilityIdentifier("auth-keyboard-next")
                }
                Spacer()
                Button("Готово") { focusedField = nil }
                    .accessibilityIdentifier("auth-keyboard-done")
            }
        }
        .onAppear {
            #if DEBUG
            if allowsPreviewProgression,
               step == .phone,
               ProcessInfo.processInfo.environment["LUXORA_UI_TEST_AUTH_COUNTRY_PICKER"] == "1"
            {
                isCountryPickerPresented = true
            }
            #endif
        }
    }

    private var welcomeScreen: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 72)

                    ZStack {
                        // The route itself stays invisible: exactly two runners move
                        // in the same direction and half a lap apart, then dissolve
                        // into the solid mark for the first-launch reveal.
                        PhoneContourTransitionView()
                            .scaleEffect(0.72)
                            .opacity(introLogoIsVisible ? 0 : 1)

                        LuxoraLogoView(size: 112)
                            .shadow(color: LuxoraTheme.violet.opacity(0.28), radius: 24)
                            .scaleEffect(introLogoIsVisible ? 1 : 0.82)
                            .offset(y: introLogoIsVisible ? 0 : -14)
                            .opacity(introLogoIsVisible ? 1 : 0)
                    }
                    .frame(height: 150)
                    .accessibilityHidden(true)

                    Text("Luxora")
                        .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                        .padding(.top, 24)
                        .opacity(introCopyIsVisible ? 1 : 0)
                        .accessibilityHeading(.h1)
                        .accessibilityIdentifier("auth-welcome-screen")

                    Text("Быстрые и спокойные разговоры\nна ваших устройствах")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)
                        .opacity(introCopyIsVisible ? 1 : 0)

                    Spacer(minLength: 52)

                    PhoneAuthPrimaryButton(title: "Продолжить", isWorking: false, enabled: true) {
                        didCompleteIntro = true
                        transition(to: .phone)
                    }
                    .accessibilityIdentifier("auth-start")
                    .opacity(introCopyIsVisible ? 1 : 0)

                    Text("Beta-0.1 · Flenym")
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.58))
                        .padding(.top, 14)
                        .padding(.bottom, 10)
                        .opacity(introCopyIsVisible ? 1 : 0)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: geometry.size.height, alignment: .top)
                .padding(.horizontal, 24)
            }
            .scrollIndicators(.hidden)
        }
        .task { await playWelcomeMotion() }
    }

    private var phoneScreen: some View {
        PhoneAuthScrollableScreen(identifier: "auth-phone-screen") {
            PhoneAuthBackButton { transition(to: .welcome) }

            PhoneAuthStageSymbol(systemName: "iphone")
                .padding(.top, 22)

            PhoneAuthHeading(
                title: "Ваш номер телефона",
                detail: "Выберите страну и введите номер. Код подтверждения отправит сервер Luxora."
            )

            VStack(spacing: 0) {
                Button {
                    isCountryPickerPresented = true
                } label: {
                    Group {
                        if dynamicTypeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(spacing: 10) {
                                    countryFlag
                                    Text(selectedCountry.name)
                                        .foregroundStyle(.white)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Text(selectedCountry.dialCode)
                                    .foregroundStyle(Color.white.opacity(0.78))
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            HStack(spacing: 10) {
                                countryFlag
                                Text(selectedCountry.name)
                                    .foregroundStyle(.white)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer()
                                Text(selectedCountry.dialCode)
                                    .foregroundStyle(Color.white.opacity(0.78))
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(Color.white.opacity(0.78))
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Страна, \(selectedCountry.name), \(selectedCountry.dialCode)")
                .accessibilityHint("Открывает список стран")
                .accessibilityIdentifier("auth-country")

                Divider().padding(.leading, 16)

                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(selectedCountry.dialCode)
                                .foregroundStyle(Color.white.opacity(0.78))
                            phoneNumberField
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        HStack(spacing: 10) {
                            Text(selectedCountry.dialCode)
                                .foregroundStyle(Color.white.opacity(0.78))
                            phoneNumberField
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 52)
            }
            .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
            .padding(.top, 28)

            PhoneAuthMessage(message: visibleMessage, failure: authenticationFailure)

            Spacer(minLength: 30)

            phoneSubmitControl

            Text("Luxora не имитирует отправку SMS или вход без ответа сервера.")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.58))
                .multilineTextAlignment(.center)
                .padding(.top, 12)
        }
    }

    private var countryFlag: some View {
        Canvas { context, size in
            let flag = context.resolve(
                Text(selectedCountry.flag)
                    .font(.system(size: 20))
            )
            context.draw(flag, at: CGPoint(x: size.width / 2, y: size.height / 2))
        }
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)
    }

    private var phoneNumberField: some View {
        TextField("Номер телефона", text: $nationalNumber)
            .keyboardType(.phonePad)
            .textContentType(.telephoneNumber)
            .focused($focusedField, equals: .phone)
            .foregroundStyle(.white)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Номер телефона без кода страны")
            .accessibilityIdentifier("auth-phone")
            .onAppear {
                // Match the native phone-auth flow: once the phone step is
                // visible the number field is immediately ready for input.
                // This also avoids a short transition window where a real tap
                // can land before SwiftUI has installed the focus bridge.
                focusedField = .phone
                #if DEBUG
                if uiTestSecureAutofillEnabled,
                   let value = ProcessInfo.processInfo.environment["LUXORA_LIVE_PHONE_NATIONAL_NUMBER"]
                {
                    nationalNumber = String(value.filter(\.isNumber).prefix(maxNationalDigits))
                }
                #endif
            }
            .onChange(of: nationalNumber) { _, value in
                nationalNumber = String(value.filter(\.isNumber).prefix(maxNationalDigits))
                localMessage = nil
                beginRetryAvailableAt = nil
                // The submit command clears any remote failure. Mutating the
                // parent session on each keystroke can replace this focused
                // field while iOS is still delivering the same input event.
            }
    }

    private var codeScreen: some View {
        PhoneAuthScrollableScreen(identifier: "auth-code-screen") {
            PhoneAuthBackButton { returnToPhone() }

            PhoneAuthStageSymbol(systemName: "message.fill")
                .padding(.top, 22)

            PhoneAuthHeading(
                title: "Введите код",
                detail: "Мы ожидаем шестизначный код для \(challenge?.maskedPhone ?? selectedCountry.dialCode)."
            )

            TextField("000000", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .multilineTextAlignment(.center)
                .font(.system(.title, design: .monospaced, weight: .semibold))
                .tracking(8)
                .focused($focusedField, equals: .code)
                .padding(.horizontal, 18)
                .frame(minHeight: 60)
                .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Код подтверждения")
                .accessibilityIdentifier("auth-code")
                .onAppear {
                    focusedField = .code
                    #if DEBUG
                    if let value = uiTestFragmentedValue(
                        prefixKey: "LUXORA_LIVE_PHONE_CODE_PREFIX",
                        suffixKey: "LUXORA_LIVE_PHONE_CODE_SUFFIX"
                    ) {
                        code = String(value.filter(\.isNumber).prefix(6))
                    }
                    #endif
                }
                .onChange(of: code) { _, value in
                    code = String(value.filter(\.isNumber).prefix(6))
                    localMessage = nil
                    // `verifyPhoneCode` clears the remote failure when the
                    // next command starts. Keep the local field/root stable
                    // while a six-digit AutoFill or paste event is arriving.
                }
                .padding(.top, 28)

            resendControl

            PhoneAuthMessage(message: visibleMessage, failure: authenticationFailure)

            Spacer(minLength: 30)

            PhoneAuthPrimaryButton(
                title: authenticationFailure?.isRetryable == true ? "Повторить" : "Продолжить",
                isWorking: isWorking,
                enabled: code.count == 6
                    && !isWorking
                    && authenticationFailure?.blocksCodeVerification != true,
                action: submitCode
            )
            .accessibilityIdentifier("auth-code-submit")
        }
    }

    private var passwordScreen: some View {
        PhoneAuthScrollableScreen(identifier: "auth-phone-password-screen") {
            PhoneAuthBackButton { restartAfterPasswordChallenge() }

            PhoneAuthStageSymbol(systemName: "lock.shield.fill")
                .padding(.top, 22)

            PhoneAuthHeading(
                title: "Пароль учётной записи",
                detail: "Код для \(passwordChallenge?.maskedPhone ?? "подтверждённого номера") принят. Теперь введите секретный пароль Luxora."
            )

            HStack(spacing: 10) {
                Group {
                    if revealsPassword {
                        TextField("Пароль", text: $password)
                    } else {
                        SecureField("Пароль", text: $password)
                    }
                }
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focusedField, equals: .password)
                .onSubmit(submitPassword)
                .accessibilityLabel("Секретный пароль Luxora")
                .accessibilityIdentifier("auth-phone-password")

                Button {
                    revealsPassword.toggle()
                } label: {
                    Image(systemName: revealsPassword ? "eye.slash.fill" : "eye.fill")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(revealsPassword ? "Скрыть пароль" : "Показать пароль")
                .accessibilityIdentifier("auth-phone-password-reveal")
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .frame(minHeight: 60)
            .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
            .padding(.top, 28)
            .onChange(of: password) { _, value in
                if value.count > 128 { password = String(value.prefix(128)) }
                localMessage = nil
                // Keep the parent session stable while the secure field is
                // editing. Clearing the remote failure here invalidates the
                // authentication root on the first character and can replace
                // the focused UITextField before the remaining characters
                // arrive. `completePhonePassword` clears the failure at the
                // start of the next submission.
            }

            if let expiresAt = passwordChallenge?.expiresAt, expiresAt != .distantFuture {
                Text("Проверку нужно завершить до \(expiresAt.formatted(date: .omitted, time: .shortened)).")
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.58))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.top, 10)
            }

            PhoneAuthMessage(message: visibleMessage, failure: authenticationFailure)

            Spacer(minLength: 30)

            if authenticationFailure?.blocksPasswordVerification == true {
                PhoneAuthPrimaryButton(
                    title: "Получить новый код",
                    isWorking: false,
                    enabled: true,
                    action: restartAfterPasswordChallenge
                )
                .accessibilityIdentifier("auth-phone-password-restart")
            } else {
                PhoneAuthPrimaryButton(
                    title: authenticationFailure?.isRetryable == true ? "Повторить" : "Продолжить",
                    isWorking: isWorking,
                    enabled: !password.isEmpty && !isWorking,
                    action: submitPassword
                )
                .accessibilityIdentifier("auth-phone-password-submit")

                Button {
                    transition(to: .recovery)
                } label: {
                    Text("Забыли пароль?")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Color.white.opacity(0.78))
                }
                .buttonStyle(.plain)
                .disabled(isWorking)
                .padding(.top, 8)
                .accessibilityIdentifier("auth-phone-password-recovery")
            }

            Text("Пароль передаётся только в теле защищённого запроса и не заменяет одноразовый код.")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.58))
                .multilineTextAlignment(.center)
                .padding(.top, 12)
        }
    }

    private var recoveryScreen: some View {
        PhoneAuthScrollableScreen(identifier: "auth-phone-recovery-screen") {
            PhoneAuthBackButton { cancelRecovery() }

            PhoneAuthStageSymbol(systemName: "key.horizontal.fill")
                .padding(.top, 22)

            if let intent = recoveryIntent {
                PhoneAuthHeading(
                    title: "Сброс пароля запущен",
                    detail: "Заявка для \(intent.maskedPhone) создана. Это защита аккаунта: новый пароль можно задать после окна подтверждения."
                )

                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if context.date >= intent.confirmAt {
                        newPasswordFields
                    } else {
                        recoveryWaitingInfo(intent: intent)
                    }
                }

                PhoneAuthMessage(message: visibleMessage, failure: authenticationFailure)

                Spacer(minLength: 30)
            } else {
                PhoneAuthHeading(
                    title: "Восстановление пароля",
                    detail: "Luxora создаст заявку на сброс секретного пароля для \(passwordChallenge?.maskedPhone ?? "подтверждённого номера"). После окна подтверждения вы зададите новый пароль, а все другие сеансы выйдут из аккаунта."
                )

                PhoneAuthMessage(message: visibleMessage, failure: authenticationFailure)

                Spacer(minLength: 30)

                PhoneAuthPrimaryButton(
                    title: authenticationFailure?.isRetryable == true ? "Повторить" : "Создать заявку на сброс",
                    isWorking: isWorking,
                    enabled: !isWorking,
                    action: submitRecoveryStart
                )
                .accessibilityIdentifier("auth-phone-recovery-start")
            }

            Text("Сброс не отменяет проверку номера: заявка действует ограниченное время и срабатывает один раз.")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.58))
                .multilineTextAlignment(.center)
                .padding(.top, 12)
        }
    }

    private func recoveryWaitingInfo(intent: PhoneRecoveryIntent) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "hourglass")
                .font(.title2)
                .foregroundStyle(Color.white.opacity(0.72))
            Text("Окно подтверждения до \(intent.confirmAt.formatted(date: .abbreviated, time: .shortened)).")
                .font(.callout)
                .multilineTextAlignment(.center)
            Text("Оставьте этот экран открытым или вернитесь позже — заявка сохранена на сервере.")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.58))
                .multilineTextAlignment(.center)
        }
        .padding(.top, 18)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("auth-phone-recovery-waiting")
    }

    private var newPasswordFields: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Group {
                    if revealsNewPassword {
                        TextField("Новый пароль", text: $newPassword)
                    } else {
                        SecureField("Новый пароль", text: $newPassword)
                    }
                }
                .textContentType(.newPassword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focusedField, equals: .newPassword)
                .onSubmit(submitRecoveryCompletion)
                .accessibilityLabel("Новый секретный пароль Luxora")
                .accessibilityIdentifier("auth-phone-recovery-password")

                Button {
                    revealsNewPassword.toggle()
                } label: {
                    Image(systemName: revealsNewPassword ? "eye.slash.fill" : "eye.fill")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(revealsNewPassword ? "Скрыть пароль" : "Показать пароль")
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .frame(minHeight: 60)
            .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))

            PhoneAuthPrimaryButton(
                title: "Сохранить пароль и войти",
                isWorking: isWorking,
                enabled: newPassword.count >= 12 && !isWorking,
                action: submitRecoveryCompletion
            )
            .accessibilityIdentifier("auth-phone-recovery-complete")
        }
        .padding(.top, 18)
        .onChange(of: newPassword) { _, value in
            if value.count > 128 { newPassword = String(value.prefix(128)) }
            localMessage = nil
        }
    }

    private var profileScreen: some View {
        PhoneAuthScrollableScreen(identifier: "auth-profile-screen") {
            PhoneAuthBackButton { transition(to: .code) }

            ProfileAvatarEditor(displayName: displayName, avatarPNGData: $avatarPNGData)
            .padding(.top, 22)

            Text("Фото необязательно")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.58))
                .padding(.top, 8)

            PhoneAuthHeading(
                title: "Имя и профиль",
                detail: "Так вас будут видеть люди в Luxora. Имя можно изменить позже."
            )

            TextField("Ваше имя", text: $displayName)
                .textContentType(.name)
                .submitLabel(.next)
                .focused($focusedField, equals: .displayName)
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
                .fixedSize(horizontal: false, vertical: true)
                .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("auth-display-name")
                .onSubmit { focusedField = .bio }
                .onChange(of: displayName) { _, value in
                    displayName = String(value.prefix(80))
                    localMessage = nil
                }
                .padding(.top, 28)

            TextField("О себе (необязательно)", text: $bio, axis: .vertical)
                .focused($focusedField, equals: .bio)
                .lineLimit(3...5)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("auth-bio")
                .onChange(of: bio) { _, value in
                    bio = String(value.prefix(500))
                    localMessage = nil
                }
                .padding(.top, 12)

            Text("\(bio.count)/500")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(Color.white.opacity(0.58))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.top, 5)

            Text("Номер: \(registration?.maskedPhone ?? challenge?.maskedPhone ?? selectedCountry.dialCode)")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.58))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .padding(.top, 8)

            PhoneAuthMessage(message: visibleMessage)

            Spacer(minLength: 30)

            PhoneAuthPrimaryButton(
                title: "Далее",
                isWorking: false,
                enabled: isDisplayNameValid,
                action: submitProfile
            )
            .accessibilityIdentifier("auth-profile-submit")
        }
    }

    private var usernameScreen: some View {
        PhoneAuthScrollableScreen(identifier: "auth-username-screen") {
            PhoneAuthBackButton { transition(to: .profile) }

            PhoneAuthStageSymbol(systemName: "at")
                .padding(.top, 22)

            PhoneAuthHeading(
                title: "Имя пользователя",
                detail: "По нему вас смогут найти в Luxora. Используйте латинские буквы, цифры и подчёркивание."
            )

            HStack(spacing: 0) {
                Text("@")
                    .foregroundStyle(.secondary)
                TextField("username", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .focused($focusedField, equals: .username)
                    .submitLabel(.done)
                    .accessibilityIdentifier("auth-username")
                    .onChange(of: username) { _, value in
                        username = String(
                            value.lowercased()
                                .filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
                                .prefix(32)
                        )
                        usernameStatus = .idle
                        localMessage = nil
                    }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .fixedSize(horizontal: false, vertical: true)
            .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
            .padding(.top, 28)

            usernameAvailabilityView

            PhoneAuthMessage(message: visibleMessage)

            Spacer(minLength: 30)

            PhoneAuthPrimaryButton(
                title: "Создать аккаунт",
                isWorking: isWorking || isSynchronizing,
                enabled: usernameStatus == .available && !isWorking && !isSynchronizing,
                action: submitUsername
            )
            .accessibilityIdentifier("auth-username-submit")

            if avatarPNGData != nil {
                Text("Фото сохранено локально. Luxora загрузит его только после выдачи серверных токенов.")
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.58))
                    .multilineTextAlignment(.center)
                    .padding(.top, 12)
            }
        }
        .task(id: username) {
            await refreshUsernameAvailability()
        }
    }

    @ViewBuilder
    private var usernameAvailabilityView: some View {
        switch usernameStatus {
        case .idle:
            Text("Минимум 3 символа, первый символ — буква.")
                .foregroundStyle(Color.white.opacity(0.58))
                .usernameStatusStyle()
        case .invalid:
            Label("Проверьте формат имени пользователя.", systemImage: "exclamationmark.circle.fill")
                .foregroundStyle(.orange)
                .usernameStatusStyle()
        case .checking:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Проверяем доступность…")
            }
            .foregroundStyle(Color.white.opacity(0.72))
            .usernameStatusStyle()
            .accessibilityIdentifier("auth-username-checking")
        case .available:
            Label("Имя свободно", systemImage: "checkmark.circle.fill")
                .foregroundStyle(LuxoraTheme.success)
                .usernameStatusStyle()
                .accessibilityIdentifier("auth-username-available")
        case let .taken(suggestions):
            VStack(alignment: .leading, spacing: 10) {
                Label("Имя уже занято", systemImage: "xmark.circle.fill")
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("auth-username-taken")

                if !suggestions.isEmpty {
                    Text("Свободные варианты")
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.58))
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], alignment: .leading, spacing: 8) {
                        ForEach(suggestions, id: \.self) { suggestion in
                            Button("@\(suggestion)") {
                                username = suggestion
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered)
                            .tint(LuxoraTheme.iris)
                            .accessibilityIdentifier("auth-username-suggestion-\(suggestion)")
                        }
                    }
                }
            }
            .usernameStatusStyle()
        case let .unavailable(message):
            Label(message, systemImage: "wifi.exclamationmark")
                .foregroundStyle(.orange)
                .usernameStatusStyle()
                .accessibilityIdentifier("auth-username-unavailable")
        }
    }

    private var permissionsPreviewScreen: some View {
        OnboardingPermissionsRationaleView(isPreview: true) {
            transition(to: .sync)
        }
    }

    private var authenticationSyncScreen: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
                .controlSize(.large)
                .tint(LuxoraTheme.iris)
            Text("Синхронизируем Luxora")
                .font(.title2.weight(.semibold))
                .accessibilityIdentifier("auth-sync-screen")
            Text("Загружаем профиль, список чатов и первое состояние сообщений.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()

            #if DEBUG
            if allowsPreviewProgression {
                Button("Завершить DEBUG-предпросмотр") {
                    transition(to: .completed)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("auth-sync-continue")
            }
            #endif
        }
        .padding(24)
    }

    private var completedScreen: some View {
        VStack(spacing: 18) {
            Spacer()
            PhoneAuthStageSymbol(systemName: "checkmark")
            Text("Проверка интерфейса завершена")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("auth-completed-screen")
            Text("Код не отправлялся и аккаунт не создавался. Это DEBUG-only сценарий для Xcode и скриншотов.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Вернуться к началу") {
                resetPreview()
                transition(to: .welcome)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("auth-preview-reset")
        }
        .padding(24)
    }

    private var phoneSubmitControl: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(
                0,
                Int((beginRetryAvailableAt ?? context.date)
                    .timeIntervalSince(context.date)
                    .rounded(.up))
            )
            PhoneAuthPrimaryButton(
                title: seconds > 0
                    ? "Повторить через \(seconds) с"
                    : authenticationFailure?.isRetryable == true ? "Повторить" : "Продолжить",
                isWorking: isWorking,
                enabled: isPhoneValid && !isWorking && seconds == 0,
                action: submitPhone
            )
            .accessibilityIdentifier("auth-phone-submit")
        }
    }

    private var resendControl: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int((retryAvailableAt ?? context.date).timeIntervalSince(context.date).rounded(.up)))
            Button(seconds > 0 ? "Отправить снова через \(seconds) с" : "Отправить код снова") {
                resendCode()
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(seconds > 0 ? Color.secondary : LuxoraTheme.iris)
            .disabled(seconds > 0 || isWorking)
            .accessibilityIdentifier("auth-resend")
            .padding(.top, 14)
        }
    }

    private var visibleMessage: String? {
        localMessage ?? serverError
    }

    private var isPhoneValid: Bool {
        let nationalDigits = nationalNumber.filter(\.isNumber).count
        let countryDigits = selectedCountry.dialCode.filter(\.isNumber).count
        return (4...maxNationalDigits).contains(nationalDigits)
            && (7...15).contains(countryDigits + nationalDigits)
    }

    private var maxNationalDigits: Int {
        max(4, min(14, 15 - selectedCountry.dialCode.filter(\.isNumber).count))
    }

    private var isDisplayNameValid: Bool {
        (1...80).contains(displayName.trimmingCharacters(in: .whitespacesAndNewlines).count)
    }

    private var normalizedUsername: String {
        username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var isUsernameValid: Bool {
        let candidate = normalizedUsername
        return (3...32).contains(candidate.count)
            && candidate.first?.isLetter == true
            && candidate.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }

    private func submitPhone() {
        guard isPhoneValid, !isWorking else {
            localMessage = "Введите номер телефона полностью."
            return
        }
        focusedField = nil
        localMessage = nil

        #if DEBUG
        if allowsPreviewProgression {
            challenge = .uiTestPreview
            retryAvailableAt = Date().addingTimeInterval(30)
            transition(to: .code)
            return
        }
        #endif

        Task { @MainActor in
            guard let response = await requestCode(selectedCountry.dialCode, nationalNumber) else { return }
            challenge = response
            retryAvailableAt = Date().addingTimeInterval(TimeInterval(response.retryAfterSeconds))
            transition(to: .code)
        }
    }

    private func submitCode() {
        guard code.count == 6, let challenge, !isWorking else {
            localMessage = "Введите шестизначный код."
            return
        }
        focusedField = nil
        localMessage = nil

        #if DEBUG
        if allowsPreviewProgression {
            registration = .uiTestPreview
            transition(to: .profile)
            return
        }
        #endif

        Task { @MainActor in
            guard let result = await verifyCode(challenge.challengeID, code) else { return }
            switch result {
            case .authenticated:
                transition(to: .sync)
            case let .profileRequired(nextRegistration):
                registration = nextRegistration
                transition(to: .profile)
            case let .passwordRequired(nextPasswordChallenge):
                passwordChallenge = nextPasswordChallenge
                password = ""
                revealsPassword = false
                transition(to: .password)
            case .bindingRequired:
                // Binding challenges only originate from authenticated
                // settings flows; onboarding surfaces a truthful error.
                localMessage = LuxoraL10n.text("auth.recovery_unexpected_binding")
            }
        }
    }

    private func submitPassword() {
        guard let passwordChallenge, !password.isEmpty, !isWorking else {
            localMessage = "Введите пароль учётной записи."
            return
        }
        guard authenticationFailure?.blocksPasswordVerification != true else { return }
        focusedField = nil
        localMessage = nil

        #if DEBUG
        if allowsPreviewProgression {
            transition(to: .sync)
            return
        }
        #endif

        Task { @MainActor in
            let success = await completePassword(passwordChallenge.passwordToken, password)
            if success { transition(to: .sync) }
        }
    }

    private func restartAfterPasswordChallenge() {
        clearFailure()
        password = ""
        passwordChallenge = nil
        recoveryIntent = nil
        newPassword = ""
        code = ""
        challenge = nil
        retryAvailableAt = nil
        transition(to: .phone)
    }

    private func cancelRecovery() {
        clearFailure()
        localMessage = nil
        recoveryIntent = nil
        newPassword = ""
        focusedField = nil
        transition(to: .password)
    }

    private func submitRecoveryStart() {
        guard let passwordChallenge, !isWorking else { return }
        focusedField = nil
        localMessage = nil
        Task { @MainActor in
            recoveryIntent = await startRecovery(passwordChallenge.passwordToken)
            if recoveryIntent == nil && authenticationFailure == nil {
                localMessage = "Не удалось создать заявку. Нажмите «Повторить»."
            }
        }
    }

    private func submitRecoveryCompletion() {
        guard let intent = recoveryIntent, !isWorking else { return }
        guard Date() >= intent.confirmAt else {
            localMessage = "Окно подтверждения ещё не закончилось."
            return
        }
        guard newPassword.count >= 12 else {
            localMessage = "Новый пароль должен содержать минимум 12 символов."
            return
        }
        focusedField = nil
        localMessage = nil
        Task { @MainActor in
            let success = await completeRecovery(intent.recoveryToken, newPassword)
            if success {
                transition(to: .sync)
            }
        }
    }

    private func submitProfile() {
        guard isDisplayNameValid, registration != nil, !isWorking else {
            localMessage = "Введите имя длиной от 1 до 80 символов."
            return
        }
        focusedField = nil
        localMessage = nil
        transition(to: .username)
    }

    private func refreshUsernameAvailability() async {
        guard step == .username else { return }
        guard !normalizedUsername.isEmpty else {
            usernameStatus = .idle
            return
        }
        guard isUsernameValid else {
            usernameStatus = .invalid
            return
        }

        usernameStatus = .checking
        do {
            try await Task.sleep(for: .milliseconds(450))
        } catch {
            return
        }
        guard !Task.isCancelled, step == .username else { return }

        #if DEBUG
        if allowsPreviewProgression {
            if normalizedUsername == "flenym" {
                usernameStatus = .taken(["flenym_1", "flenym_app", "flenym_ru"])
            } else {
                usernameStatus = .available
            }
            return
        }
        #endif

        guard let registration else {
            usernameStatus = .unavailable("Сервер не выдал токен регистрации.")
            return
        }
        guard let response = await checkUsername(registration.registrationToken, normalizedUsername) else {
            if !Task.isCancelled {
                usernameStatus = .unavailable("Не удалось проверить имя на сервере.")
            }
            return
        }
        guard response.username.caseInsensitiveCompare(normalizedUsername) == .orderedSame else { return }
        usernameStatus = response.isAvailable
            ? .available
            : .taken(response.suggestions.filter(Self.isSuggestedUsernameValid))
    }

    private func submitUsername() {
        guard usernameStatus == .available,
              isUsernameValid,
              let registration,
              !isWorking,
              !isSynchronizing
        else {
            localMessage = "Выберите свободное имя пользователя."
            return
        }
        focusedField = nil
        localMessage = nil

        #if DEBUG
        if allowsPreviewProgression {
            transition(to: .permissions)
            return
        }
        #endif

        needsPostRegistrationPermissions = true
        Task { @MainActor in
            let stagedAvatar: Bool
            if let avatarPNGData {
                do {
                    try PendingProfileAvatarStore.save(avatarPNGData, username: normalizedUsername)
                    stagedAvatar = true
                } catch {
                    stagedAvatar = false
                }
            } else {
                stagedAvatar = false
            }
            let success = await completeRegistration(
                registration.registrationToken,
                displayName,
                normalizedUsername,
                bio
            )
            guard success else {
                needsPostRegistrationPermissions = false
                if stagedAvatar { try? PendingProfileAvatarStore.remove(username: normalizedUsername) }
                return
            }
        }
    }

    private func resendCode() {
        guard !isWorking else { return }
        localMessage = nil

        #if DEBUG
        if allowsPreviewProgression {
            retryAvailableAt = Date().addingTimeInterval(30)
            code = ""
            return
        }
        #endif

        Task { @MainActor in
            guard let response = await requestCode(selectedCountry.dialCode, nationalNumber) else { return }
            challenge = response
            retryAvailableAt = Date().addingTimeInterval(TimeInterval(response.retryAfterSeconds))
            code = ""
        }
    }

    private func returnToPhone() {
        clearFailure()
        code = ""
        password = ""
        passwordChallenge = nil
        revealsPassword = false
        transition(to: .phone)
    }

    private func transition(to target: PhoneAuthenticationStep) {
        focusedField = nil
        localMessage = nil
        transitionSequence += 1
        let sequence = transitionSequence
        transitionTarget = target
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
            step = .transition
        }
        // Keep navigation independent from the lifetime of the outgoing screen's
        // `.task`. The welcome view owns its intro task and SwiftUI cancels that
        // task when the view fades out; a main-queue deadline guarantees that the
        // route itself cannot be stranded on the transition frame.
        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0 : 0.72)) {
            guard sequence == transitionSequence, transitionTarget == target else { return }
            withAnimation(reduceMotion ? nil : .easeIn(duration: 0.18)) {
                step = target
            }
        }
    }

    @MainActor
    private func playWelcomeMotion() async {
        #if DEBUG
        let forcesIntro = ProcessInfo.processInfo.environment["LUXORA_UI_TEST_RESET_SESSION"] == "1"
        #else
        let forcesIntro = false
        #endif
        guard !didCompleteIntro || forcesIntro || allowsPreviewProgression else {
            step = .phone
            return
        }

        if reduceMotion {
            introLogoIsVisible = true
            introCopyIsVisible = true
            return
        }

        introLogoIsVisible = false
        introCopyIsVisible = false
        do {
            try await Task.sleep(for: .milliseconds(900))
        } catch {
            return
        }
        guard !Task.isCancelled, step == .welcome else { return }
        withAnimation(.spring(response: 0.68, dampingFraction: 0.82)) {
            introLogoIsVisible = true
        }
        do {
            try await Task.sleep(for: .milliseconds(280))
        } catch {
            return
        }
        guard !Task.isCancelled, step == .welcome else { return }
        withAnimation(.easeOut(duration: 0.42)) {
            introCopyIsVisible = true
        }
    }

    private func resetPreview() {
        selectedCountry = .russia
        nationalNumber = ""
        code = ""
        password = ""
        passwordChallenge = nil
        revealsPassword = false
        displayName = ""
        bio = ""
        username = ""
        usernameStatus = .idle
        avatarPNGData = nil
        challenge = nil
        registration = nil
        retryAvailableAt = nil
        beginRetryAvailableAt = nil
        localMessage = nil
        clearFailure()
    }

    private static func isSuggestedUsernameValid(_ candidate: String) -> Bool {
        (3...32).contains(candidate.count)
            && candidate.first?.isLetter == true
            && candidate.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }

    #if DEBUG
    private var uiTestSecureAutofillEnabled: Bool {
        ProcessInfo.processInfo.environment["LUXORA_UI_TEST_SECURE_AUTOFILL"] == "1"
    }

    private func uiTestFragmentedValue(prefixKey: String, suffixKey: String) -> String? {
        guard uiTestSecureAutofillEnabled,
              let prefix = ProcessInfo.processInfo.environment[prefixKey], !prefix.isEmpty,
              let suffix = ProcessInfo.processInfo.environment[suffixKey], !suffix.isEmpty
        else { return nil }
        return prefix + suffix
    }
    #endif
}

private struct PhoneAuthScrollableScreen<Content: View>: View {
    let identifier: String
    @ViewBuilder let content: Content

    init(identifier: String, @ViewBuilder content: () -> Content) {
        self.identifier = identifier
        self.content = content()
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    content
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: geometry.size.height, alignment: .top)
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .padding(.bottom, 18)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier(identifier)
        }
    }
}

private struct PhoneAuthHeading: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 10) {
            Text(title)
                .font(.title2.weight(.semibold))
                .accessibilityHeading(.h1)
            Text(detail)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 22)
    }
}

private struct PhoneAuthStageSymbol: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 40, weight: .medium))
            .foregroundStyle(LuxoraTheme.iris)
            .frame(width: 94, height: 94)
            .background(Color.white.opacity(0.08), in: Circle())
            .overlay(Circle().stroke(Color.white.opacity(0.10), lineWidth: 1))
            .accessibilityHidden(true)
    }
}

private struct PhoneAuthBackButton: View {
    let action: () -> Void

    var body: some View {
        HStack {
            Button(action: action) {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .background(Color.white.opacity(0.08), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Назад")
            .accessibilityIdentifier("auth-back")
            Spacer()
        }
    }
}

private struct PhoneAuthMessage: View {
    let message: String?
    let failure: PhoneAuthenticationFailure?

    init(message: String?, failure: PhoneAuthenticationFailure? = nil) {
        self.message = message
        self.failure = failure
    }

    var body: some View {
        if let message, !message.isEmpty {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .padding(.top, 12)
                .accessibilityIdentifier(failure?.accessibilityIdentifier ?? "auth-error")
        }
    }
}

private extension PhoneAuthenticationFailure {
    var accessibilityIdentifier: String {
        switch self {
        case .invalidCode:
            "auth-error-invalid-code"
        case .attemptsExhausted:
            "auth-error-attempts-exhausted"
        case .invalidPassword:
            "auth-error-password-invalid"
        case .passwordAttemptsExhausted:
            "auth-error-password-attempts-exhausted"
        case .passwordTokenExpired:
            "auth-error-password-token-expired"
        case .challengeExpired:
            "auth-error-challenge-expired"
        case .challengeInvalid:
            "auth-error-challenge-invalid"
        case .resendCooldown:
            "auth-error-resend-cooldown"
        case .networkUnavailable:
            "auth-error-network"
        case .deliveryUnavailable:
            "auth-error-delivery"
        case .credentialPersistenceFailed:
            "auth-error-keychain"
        case .registrationExpired:
            "auth-error-registration-expired"
        case .recoveryTokenExpired:
            "auth-error-recovery-token-expired"
        case .recoveryNotConfirmable:
            "auth-error-recovery-not-confirmable"
        case .temporarilyUnavailable:
            "auth-error-temporary"
        case .unexpected:
            "auth-error"
        }
    }
}

private struct PhoneAuthPrimaryButton: View {
    let title: String
    let isWorking: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isWorking {
                    ProgressView().tint(.white)
                }
                Text(title).fontWeight(.semibold)
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
        }
        .buttonStyle(PhoneAuthPrimaryButtonStyle(enabled: enabled))
        .disabled(!enabled)
        .accessibilityLabel(isWorking ? "\(title), выполняется" : title)
        .accessibilityValue(isWorking ? "Выполняется" : "")
    }
}

private struct PhoneAuthPrimaryButtonStyle: ButtonStyle {
    let enabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(enabled ? Color.white : Color.white.opacity(0.52))
            .background(
                enabled ? LuxoraTheme.accent : Color.white.opacity(0.08),
                in: RoundedRectangle(cornerRadius: 12)
            )
            .scaleEffect(configuration.isPressed && enabled ? 0.985 : 1)
    }
}

private extension View {
    func usernameStatusStyle() -> some View {
        self
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.top, 12)
    }
}

private struct PhoneContourTransitionView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion)) { timeline in
            let elapsed = timeline.date.timeIntervalSinceReferenceDate
            let progress = reduceMotion ? 0.18 : elapsed.truncatingRemainder(dividingBy: 1.8) / 1.8

            Canvas { context, size in
                let route = LuxoraLoaderRoute.path(
                    in: CGRect(origin: .zero, size: size).insetBy(dx: 8, dy: 8)
                )
                let runnerColor = colorScheme == .dark ? Color.white : Color.black
                for offset in [0.0, 0.5] {
                    drawRunner(
                        route: route,
                        phase: progress + offset,
                        coreColor: runnerColor,
                        context: &context
                    )
                }
            }
        }
        .frame(width: 188, height: 188)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Переход Luxora")
        .accessibilityIdentifier("auth-transition")
    }

    private func drawRunner(
        route: Path,
        phase: Double,
        coreColor: Color,
        context: inout GraphicsContext
    ) {
        for sampleIndex in stride(from: 13, through: 0, by: -1) {
            let age = Double(sampleIndex) / 13
            let samplePhase = phase - 0.09 * age
            guard let point = LuxoraLoaderRoute.point(on: route, at: samplePhase) else { continue }
            let strength = pow(1 - age, 1.65)
            let radius = 1.15 + 2.85 * strength
            let core = CGRect(
                x: point.x - radius,
                y: point.y - radius,
                width: radius * 2,
                height: radius * 2
            )

            if !reduceTransparency, contrast == .standard {
                let glow = core.insetBy(dx: -3.5, dy: -3.5)
                context.fill(
                    Path(ellipseIn: glow),
                    with: .color(LuxoraTheme.violet.opacity(0.02 + 0.13 * strength))
                )
            }
            let trailColor = colorScheme == .dark ? LuxoraTheme.frost : Color.black
            context.fill(
                Path(ellipseIn: core),
                with: .color(trailColor.opacity(0.08 + 0.78 * strength))
            )
        }

        guard let head = LuxoraLoaderRoute.point(on: route, at: phase) else { return }
        context.fill(
            Path(ellipseIn: CGRect(x: head.x - 4, y: head.y - 4, width: 8, height: 8)),
            with: .color(coreColor)
        )
    }
}

private enum LuxoraLoaderRoute {
    /// Native copy of `assets/brand/luxora-loader-route.svg`. The coordinates
    /// and cubic control points intentionally remain in the reviewed 1254-unit
    /// source space; only a uniform display transform is applied.
    static func path(in rect: CGRect) -> Path {
        let sourceBounds = CGRect(x: 350, y: 264, width: 620, height: 676)
        let scale = min(rect.width / sourceBounds.width, rect.height / sourceBounds.height)

        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(
                x: rect.midX + (x - sourceBounds.midX) * scale,
                y: rect.midY + (y - sourceBounds.midY) * scale
            )
        }

        var path = Path()
        path.move(to: point(584, 264))
        path.addCurve(
            to: point(375, 775),
            control1: point(535, 292),
            control2: point(420, 592)
        )
        path.addCurve(
            to: point(439, 940),
            control1: point(350, 875),
            control2: point(390, 932)
        )
        path.addCurve(
            to: point(537, 799),
            control1: point(454, 890),
            control2: point(493, 825)
        )
        path.addCurve(
            to: point(947, 768),
            control1: point(646, 748),
            control2: point(866, 724)
        )
        path.addCurve(
            to: point(809, 874),
            control1: point(970, 788),
            control2: point(866, 858)
        )
        path.addCurve(
            to: point(537, 799),
            control1: point(704, 892),
            control2: point(607, 835)
        )
        path.addCurve(
            to: point(525, 611),
            control1: point(493, 760),
            control2: point(514, 682)
        )
        path.addCurve(
            to: point(584, 264),
            control1: point(539, 501),
            control2: point(571, 327)
        )
        path.closeSubpath()
        return path
    }

    static func point(on route: Path, at rawPhase: Double) -> CGPoint? {
        let wrapped = rawPhase - floor(rawPhase)
        let end = min(1, max(0.000_01, wrapped))
        return route.trimmedPath(from: 0, to: end).currentPoint
    }
}

private struct PhoneCountryPicker: View {
    @Binding var selection: PhoneCountry
    let close: () -> Void
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List(filteredCountries) { country in
                Button {
                    selection = country
                    close()
                } label: {
                    HStack(spacing: 12) {
                        Text(country.flag)
                            .font(.title3)
                            .frame(width: 30)

                        Text(country.name)
                            .foregroundStyle(.primary)

                        Spacer(minLength: 12)

                        Text(country.dialCode)
                            .foregroundStyle(.secondary)

                        if country == selection {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(LuxoraTheme.iris)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(country.name), \(country.dialCode)")
                .accessibilityIdentifier("auth-country-\(country.id)")
            }
            .accessibilityIdentifier("auth-country-picker")
            .navigationTitle("Страна")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Поиск страны или кода"
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", action: close)
                        .accessibilityIdentifier("auth-country-cancel")
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var filteredCountries: [PhoneCountry] {
        let countries = PhoneCountry.supported.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return countries }

        let dialNeedle = needle.filter(\.isNumber)
        return countries.filter { country in
            country.name.localizedCaseInsensitiveContains(needle)
                || country.id.localizedCaseInsensitiveContains(needle)
                || (!dialNeedle.isEmpty && country.dialCode.filter(\.isNumber).contains(dialNeedle))
        }
    }
}

private struct PhoneCountry: Identifiable, Equatable, Sendable {
    let id: String
    let dialCode: String

    var name: String {
        Locale(identifier: "ru_RU").localizedString(forRegionCode: id) ?? id
    }

    var flag: String {
        id.uppercased().unicodeScalars
            .compactMap { UnicodeScalar(127_397 + $0.value) }
            .map(String.init)
            .joined()
    }

    static let russia = PhoneCountry(id: "RU", dialCode: "+7")

    /// Generated from the backend's pinned libphonenumber metadata so the
    /// native client and API accept the same complete region set.
    static let supported: [PhoneCountry] = [
        .init(id: "AC", dialCode: "+247"),
        .init(id: "AD", dialCode: "+376"),
        .init(id: "AE", dialCode: "+971"),
        .init(id: "AF", dialCode: "+93"),
        .init(id: "AG", dialCode: "+1"),
        .init(id: "AI", dialCode: "+1"),
        .init(id: "AL", dialCode: "+355"),
        .init(id: "AM", dialCode: "+374"),
        .init(id: "AO", dialCode: "+244"),
        .init(id: "AR", dialCode: "+54"),
        .init(id: "AS", dialCode: "+1"),
        .init(id: "AT", dialCode: "+43"),
        .init(id: "AU", dialCode: "+61"),
        .init(id: "AW", dialCode: "+297"),
        .init(id: "AX", dialCode: "+358"),
        .init(id: "AZ", dialCode: "+994"),
        .init(id: "BA", dialCode: "+387"),
        .init(id: "BB", dialCode: "+1"),
        .init(id: "BD", dialCode: "+880"),
        .init(id: "BE", dialCode: "+32"),
        .init(id: "BF", dialCode: "+226"),
        .init(id: "BG", dialCode: "+359"),
        .init(id: "BH", dialCode: "+973"),
        .init(id: "BI", dialCode: "+257"),
        .init(id: "BJ", dialCode: "+229"),
        .init(id: "BL", dialCode: "+590"),
        .init(id: "BM", dialCode: "+1"),
        .init(id: "BN", dialCode: "+673"),
        .init(id: "BO", dialCode: "+591"),
        .init(id: "BQ", dialCode: "+599"),
        .init(id: "BR", dialCode: "+55"),
        .init(id: "BS", dialCode: "+1"),
        .init(id: "BT", dialCode: "+975"),
        .init(id: "BW", dialCode: "+267"),
        .init(id: "BY", dialCode: "+375"),
        .init(id: "BZ", dialCode: "+501"),
        .init(id: "CA", dialCode: "+1"),
        .init(id: "CC", dialCode: "+61"),
        .init(id: "CD", dialCode: "+243"),
        .init(id: "CF", dialCode: "+236"),
        .init(id: "CG", dialCode: "+242"),
        .init(id: "CH", dialCode: "+41"),
        .init(id: "CI", dialCode: "+225"),
        .init(id: "CK", dialCode: "+682"),
        .init(id: "CL", dialCode: "+56"),
        .init(id: "CM", dialCode: "+237"),
        .init(id: "CN", dialCode: "+86"),
        .init(id: "CO", dialCode: "+57"),
        .init(id: "CR", dialCode: "+506"),
        .init(id: "CU", dialCode: "+53"),
        .init(id: "CV", dialCode: "+238"),
        .init(id: "CW", dialCode: "+599"),
        .init(id: "CX", dialCode: "+61"),
        .init(id: "CY", dialCode: "+357"),
        .init(id: "CZ", dialCode: "+420"),
        .init(id: "DE", dialCode: "+49"),
        .init(id: "DJ", dialCode: "+253"),
        .init(id: "DK", dialCode: "+45"),
        .init(id: "DM", dialCode: "+1"),
        .init(id: "DO", dialCode: "+1"),
        .init(id: "DZ", dialCode: "+213"),
        .init(id: "EC", dialCode: "+593"),
        .init(id: "EE", dialCode: "+372"),
        .init(id: "EG", dialCode: "+20"),
        .init(id: "EH", dialCode: "+212"),
        .init(id: "ER", dialCode: "+291"),
        .init(id: "ES", dialCode: "+34"),
        .init(id: "ET", dialCode: "+251"),
        .init(id: "FI", dialCode: "+358"),
        .init(id: "FJ", dialCode: "+679"),
        .init(id: "FK", dialCode: "+500"),
        .init(id: "FM", dialCode: "+691"),
        .init(id: "FO", dialCode: "+298"),
        .init(id: "FR", dialCode: "+33"),
        .init(id: "GA", dialCode: "+241"),
        .init(id: "GB", dialCode: "+44"),
        .init(id: "GD", dialCode: "+1"),
        .init(id: "GE", dialCode: "+995"),
        .init(id: "GF", dialCode: "+594"),
        .init(id: "GG", dialCode: "+44"),
        .init(id: "GH", dialCode: "+233"),
        .init(id: "GI", dialCode: "+350"),
        .init(id: "GL", dialCode: "+299"),
        .init(id: "GM", dialCode: "+220"),
        .init(id: "GN", dialCode: "+224"),
        .init(id: "GP", dialCode: "+590"),
        .init(id: "GQ", dialCode: "+240"),
        .init(id: "GR", dialCode: "+30"),
        .init(id: "GT", dialCode: "+502"),
        .init(id: "GU", dialCode: "+1"),
        .init(id: "GW", dialCode: "+245"),
        .init(id: "GY", dialCode: "+592"),
        .init(id: "HK", dialCode: "+852"),
        .init(id: "HN", dialCode: "+504"),
        .init(id: "HR", dialCode: "+385"),
        .init(id: "HT", dialCode: "+509"),
        .init(id: "HU", dialCode: "+36"),
        .init(id: "ID", dialCode: "+62"),
        .init(id: "IE", dialCode: "+353"),
        .init(id: "IL", dialCode: "+972"),
        .init(id: "IM", dialCode: "+44"),
        .init(id: "IN", dialCode: "+91"),
        .init(id: "IO", dialCode: "+246"),
        .init(id: "IQ", dialCode: "+964"),
        .init(id: "IR", dialCode: "+98"),
        .init(id: "IS", dialCode: "+354"),
        .init(id: "IT", dialCode: "+39"),
        .init(id: "JE", dialCode: "+44"),
        .init(id: "JM", dialCode: "+1"),
        .init(id: "JO", dialCode: "+962"),
        .init(id: "JP", dialCode: "+81"),
        .init(id: "KE", dialCode: "+254"),
        .init(id: "KG", dialCode: "+996"),
        .init(id: "KH", dialCode: "+855"),
        .init(id: "KI", dialCode: "+686"),
        .init(id: "KM", dialCode: "+269"),
        .init(id: "KN", dialCode: "+1"),
        .init(id: "KP", dialCode: "+850"),
        .init(id: "KR", dialCode: "+82"),
        .init(id: "KW", dialCode: "+965"),
        .init(id: "KY", dialCode: "+1"),
        .init(id: "KZ", dialCode: "+7"),
        .init(id: "LA", dialCode: "+856"),
        .init(id: "LB", dialCode: "+961"),
        .init(id: "LC", dialCode: "+1"),
        .init(id: "LI", dialCode: "+423"),
        .init(id: "LK", dialCode: "+94"),
        .init(id: "LR", dialCode: "+231"),
        .init(id: "LS", dialCode: "+266"),
        .init(id: "LT", dialCode: "+370"),
        .init(id: "LU", dialCode: "+352"),
        .init(id: "LV", dialCode: "+371"),
        .init(id: "LY", dialCode: "+218"),
        .init(id: "MA", dialCode: "+212"),
        .init(id: "MC", dialCode: "+377"),
        .init(id: "MD", dialCode: "+373"),
        .init(id: "ME", dialCode: "+382"),
        .init(id: "MF", dialCode: "+590"),
        .init(id: "MG", dialCode: "+261"),
        .init(id: "MH", dialCode: "+692"),
        .init(id: "MK", dialCode: "+389"),
        .init(id: "ML", dialCode: "+223"),
        .init(id: "MM", dialCode: "+95"),
        .init(id: "MN", dialCode: "+976"),
        .init(id: "MO", dialCode: "+853"),
        .init(id: "MP", dialCode: "+1"),
        .init(id: "MQ", dialCode: "+596"),
        .init(id: "MR", dialCode: "+222"),
        .init(id: "MS", dialCode: "+1"),
        .init(id: "MT", dialCode: "+356"),
        .init(id: "MU", dialCode: "+230"),
        .init(id: "MV", dialCode: "+960"),
        .init(id: "MW", dialCode: "+265"),
        .init(id: "MX", dialCode: "+52"),
        .init(id: "MY", dialCode: "+60"),
        .init(id: "MZ", dialCode: "+258"),
        .init(id: "NA", dialCode: "+264"),
        .init(id: "NC", dialCode: "+687"),
        .init(id: "NE", dialCode: "+227"),
        .init(id: "NF", dialCode: "+672"),
        .init(id: "NG", dialCode: "+234"),
        .init(id: "NI", dialCode: "+505"),
        .init(id: "NL", dialCode: "+31"),
        .init(id: "NO", dialCode: "+47"),
        .init(id: "NP", dialCode: "+977"),
        .init(id: "NR", dialCode: "+674"),
        .init(id: "NU", dialCode: "+683"),
        .init(id: "NZ", dialCode: "+64"),
        .init(id: "OM", dialCode: "+968"),
        .init(id: "PA", dialCode: "+507"),
        .init(id: "PE", dialCode: "+51"),
        .init(id: "PF", dialCode: "+689"),
        .init(id: "PG", dialCode: "+675"),
        .init(id: "PH", dialCode: "+63"),
        .init(id: "PK", dialCode: "+92"),
        .init(id: "PL", dialCode: "+48"),
        .init(id: "PM", dialCode: "+508"),
        .init(id: "PR", dialCode: "+1"),
        .init(id: "PS", dialCode: "+970"),
        .init(id: "PT", dialCode: "+351"),
        .init(id: "PW", dialCode: "+680"),
        .init(id: "PY", dialCode: "+595"),
        .init(id: "QA", dialCode: "+974"),
        .init(id: "RE", dialCode: "+262"),
        .init(id: "RO", dialCode: "+40"),
        .init(id: "RS", dialCode: "+381"),
        .init(id: "RU", dialCode: "+7"),
        .init(id: "RW", dialCode: "+250"),
        .init(id: "SA", dialCode: "+966"),
        .init(id: "SB", dialCode: "+677"),
        .init(id: "SC", dialCode: "+248"),
        .init(id: "SD", dialCode: "+249"),
        .init(id: "SE", dialCode: "+46"),
        .init(id: "SG", dialCode: "+65"),
        .init(id: "SH", dialCode: "+290"),
        .init(id: "SI", dialCode: "+386"),
        .init(id: "SJ", dialCode: "+47"),
        .init(id: "SK", dialCode: "+421"),
        .init(id: "SL", dialCode: "+232"),
        .init(id: "SM", dialCode: "+378"),
        .init(id: "SN", dialCode: "+221"),
        .init(id: "SO", dialCode: "+252"),
        .init(id: "SR", dialCode: "+597"),
        .init(id: "SS", dialCode: "+211"),
        .init(id: "ST", dialCode: "+239"),
        .init(id: "SV", dialCode: "+503"),
        .init(id: "SX", dialCode: "+1"),
        .init(id: "SY", dialCode: "+963"),
        .init(id: "SZ", dialCode: "+268"),
        .init(id: "TA", dialCode: "+290"),
        .init(id: "TC", dialCode: "+1"),
        .init(id: "TD", dialCode: "+235"),
        .init(id: "TG", dialCode: "+228"),
        .init(id: "TH", dialCode: "+66"),
        .init(id: "TJ", dialCode: "+992"),
        .init(id: "TK", dialCode: "+690"),
        .init(id: "TL", dialCode: "+670"),
        .init(id: "TM", dialCode: "+993"),
        .init(id: "TN", dialCode: "+216"),
        .init(id: "TO", dialCode: "+676"),
        .init(id: "TR", dialCode: "+90"),
        .init(id: "TT", dialCode: "+1"),
        .init(id: "TV", dialCode: "+688"),
        .init(id: "TW", dialCode: "+886"),
        .init(id: "TZ", dialCode: "+255"),
        .init(id: "UA", dialCode: "+380"),
        .init(id: "UG", dialCode: "+256"),
        .init(id: "US", dialCode: "+1"),
        .init(id: "UY", dialCode: "+598"),
        .init(id: "UZ", dialCode: "+998"),
        .init(id: "VA", dialCode: "+39"),
        .init(id: "VC", dialCode: "+1"),
        .init(id: "VE", dialCode: "+58"),
        .init(id: "VG", dialCode: "+1"),
        .init(id: "VI", dialCode: "+1"),
        .init(id: "VN", dialCode: "+84"),
        .init(id: "VU", dialCode: "+678"),
        .init(id: "WF", dialCode: "+681"),
        .init(id: "WS", dialCode: "+685"),
        .init(id: "XK", dialCode: "+383"),
        .init(id: "YE", dialCode: "+967"),
        .init(id: "YT", dialCode: "+262"),
        .init(id: "ZA", dialCode: "+27"),
        .init(id: "ZM", dialCode: "+260"),
        .init(id: "ZW", dialCode: "+263"),
    ]
}
#endif
