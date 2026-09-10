#if os(iOS)
import SwiftUI
import UIKit

struct PhonePasswordSettingsView: View {
    let store: PhonePasswordSettingsStore?
    var bindingStore: PhoneBindingStore?

    var body: some View {
        Group {
            if let store {
                LoadedPhonePasswordSettingsView(store: store, bindingStore: bindingStore)
            } else {
                ContentUnavailableView(
                    "Настройка недоступна",
                    systemImage: "key.slash.fill",
                    description: Text("Откройте этот экран в настоящем серверном сеансе Luxora.")
                )
            }
        }
        .navigationTitle("Пароль входа")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("phone-password-settings-screen")
    }
}

private struct LoadedPhonePasswordSettingsView: View {
    private enum RetryAction {
        case configure
        case disable
    }

    @Bindable var store: PhonePasswordSettingsStore
    let bindingStore: PhoneBindingStore?

    @State private var bindingCountryCode = "7"
    @State private var bindingNationalNumber = ""
    @State private var bindingCode = ""

    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var revealsCurrent = false
    @State private var revealsNew = false
    @State private var confirmsDisable = false
    @State private var retryAction: RetryAction?
    @FocusState private var focusedField: Field?

    private enum Field {
        case current
        case new
        case confirmation
    }

    var body: some View {
        Form {
            statusSection

            if let status = store.status, status.eligible {
                configureSection(status: status)
                if status.enabled { disableSection }
            } else if let bindingStore {
                bindingSection(store: bindingStore)
            }

            if case let .failed(message) = store.mutationState {
                Section("Не сохранено") {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("phone-password-settings-error")
                    if retryAction != nil {
                        Button("Повторить", action: retryLastMutation)
                            .accessibilityIdentifier("phone-password-settings-retry")
                    }
                }
            } else if store.mutationState == .loaded {
                Section {
                    Label("Настройка подтверждена сервером", systemImage: "checkmark.shield.fill")
                        .foregroundStyle(LuxoraTheme.success)
                        .accessibilityIdentifier("phone-password-settings-saved")
                }
            }

            Section {
                Text("После правильного одноразового кода Luxora запросит этот пароль до создания нового сеанса. Пароль не заменяет код и не показывается в OTP-консоли.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .task {
            guard store.loadState == .idle else { return }
            await store.refresh()
        }
        .onAppear { prepareUITestPasswordsIfNeeded() }
        .refreshable { await store.refresh(force: true) }
        .scrollDismissesKeyboard(.interactively)
        .confirmationDialog(
            "Отключить пароль входа?",
            isPresented: $confirmsDisable,
            titleVisibility: .visible
        ) {
            Button("Отключить пароль", role: .destructive) {
                retryAction = .disable
                Task { await disablePassword() }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("На новых устройствах после кода больше не будет дополнительной проверки паролем.")
        }
    }

    @ViewBuilder
    private var statusSection: some View {
        Section("Состояние") {
            switch store.loadState {
            case .idle:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Проверяем настройку на сервере…")
                }
                .accessibilityIdentifier("phone-password-settings-loading")
            case .loading where store.status == nil:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Проверяем настройку на сервере…")
                }
                .accessibilityIdentifier("phone-password-settings-loading")
            case let .failed(message) where store.status == nil:
                Label(message, systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.orange)
                Button("Повторить загрузку") { Task { await store.refresh(force: true) } }
                    .accessibilityIdentifier("phone-password-settings-load-retry")
            default:
                if let status = store.status {
                    Label(
                        status.enabled ? "Пароль включён" : "Пароль не настроен",
                        systemImage: status.enabled ? "lock.shield.fill" : "lock.open.fill"
                    )
                    .foregroundStyle(status.enabled ? LuxoraTheme.success : .primary)
                    .accessibilityIdentifier("phone-password-settings-status")

                    if !status.eligible {
                        Text("Сначала подтвердите номер телефона в Luxora.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("phone-password-settings-ineligible")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func bindingSection(store: PhoneBindingStore) -> some View {
        Section("Подтвердить номер телефона") {
            Text("Номер нужен для входа по телефону и секретного пароля. Код придёт в SMS на указанный номер.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("phone-binding-intro")

            switch store.phase {
            case .idle:
                bindingNumberFields(store: store)
            case .challengeSent:
                bindingCodeFields(store: store)
            case .verified:
                Label(
                    "Номер подтверждён кодом. Осталось завершить привязку.",
                    systemImage: "checkmark.circle.fill"
                )
                .accessibilityIdentifier("phone-binding-verified")
                Button("Привязать номер") {
                    Task { await completeBinding(store: store) }
                }
                .accessibilityIdentifier("phone-binding-complete")
            case .bound:
                Label(
                    "Номер привязан. Теперь можно включить секретный пароль.",
                    systemImage: "checkmark.shield.fill"
                )
                .foregroundStyle(LuxoraTheme.success)
                .accessibilityIdentifier("phone-binding-done")
            }

            if let failure = store.failureMessage, !failure.isEmpty {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("phone-binding-error")
            }
        }
    }

    @ViewBuilder
    private func bindingNumberFields(store: PhoneBindingStore) -> some View {
        HStack(spacing: 10) {
            TextField("Код", text: $bindingCountryCode)
                .keyboardType(.numberPad)
                .frame(maxWidth: 64)
                .accessibilityIdentifier("phone-binding-country")

            TextField("Номер без кода страны", text: $bindingNationalNumber)
                .keyboardType(.phonePad)
                .accessibilityIdentifier("phone-binding-number")
        }
        .autocorrectionDisabled()

        Button("Получить код") {
            Task {
                let started = await store.begin(
                    countryCode: bindingCountryCode,
                    nationalNumber: bindingNationalNumber
                )
                if started { bindingCode = "" }
            }
        }
        .disabled(
            bindingNationalNumber.filter(\.isNumber).count < 4
                || bindingCountryCode.filter(\.isNumber).isEmpty
        )
        .accessibilityIdentifier("phone-binding-begin")
    }

    @ViewBuilder
    private func bindingCodeFields(store: PhoneBindingStore) -> some View {
        if let challenge = store.challenge {
            Text("Код отправлен на \(challenge.maskedPhone).")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        TextField("Шесть цифр из SMS", text: $bindingCode)
            .keyboardType(.numberPad)
            .accessibilityIdentifier("phone-binding-code")
            .onChange(of: bindingCode) { _, value in
                if value.count > 6 { bindingCode = String(value.prefix(6)) }
            }

        Button("Подтвердить код") {
            Task { await store.verify(code: bindingCode) }
        }
        .disabled(bindingCode.count != 6)
        .accessibilityIdentifier("phone-binding-verify")

        Button("Изменить номер", role: .destructive) {
            store.reset()
            bindingNationalNumber = ""
            bindingCode = ""
        }
        .accessibilityIdentifier("phone-binding-restart")
    }

    private func completeBinding(store: PhoneBindingStore) async {
        let bound = await store.complete()
        if bound {
            await self.store.refresh(force: true)
        }
    }

    @ViewBuilder
    private func configureSection(status: PhonePasswordStatus) -> some View {        Section(status.enabled ? "Изменить пароль" : "Включить пароль") {
            if status.enabled {
                passwordField(
                    title: "Текущий пароль",
                    text: $currentPassword,
                    reveals: $revealsCurrent,
                    contentType: .password,
                    focus: .current,
                    identifier: "phone-password-current"
                )
            }

            passwordField(
                title: "Новый пароль",
                text: $newPassword,
                reveals: $revealsNew,
                contentType: .newPassword,
                focus: .new,
                identifier: "phone-password-new"
            )

            SecureField("Повторите новый пароль", text: $confirmation)
                .textContentType(.newPassword)
                .focused($focusedField, equals: .confirmation)
                .accessibilityIdentifier("phone-password-confirmation")

            Text("Минимум 15 символов; вставка из менеджера паролей разрешена.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if !confirmation.isEmpty, confirmation != newPassword {
                Label("Пароли не совпадают", systemImage: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("phone-password-mismatch")
            }

            Button(store.mutationState == .loading ? "Сохраняем…" : "Сохранить пароль") {
                retryAction = .configure
                Task { await configurePassword(status: status) }
            }
            .disabled(!canConfigure(status: status) || store.mutationState == .loading)
            .accessibilityIdentifier("phone-password-save")
        }
        .onChange(of: currentPassword) { _, value in
            currentPassword = truncatedPassword(value)
            store.clearMutationFailure()
        }
        .onChange(of: newPassword) { _, value in
            newPassword = truncatedPassword(value)
            store.clearMutationFailure()
        }
        .onChange(of: confirmation) { _, value in
            confirmation = truncatedPassword(value)
            store.clearMutationFailure()
        }
    }

    private var disableSection: some View {
        Section("Отключение") {
            Text("Введите текущий пароль выше, затем подтвердите отключение.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Отключить пароль", role: .destructive) {
                confirmsDisable = true
            }
            .disabled(currentPassword.isEmpty || store.mutationState == .loading)
            .accessibilityIdentifier("phone-password-disable")
        }
    }

    @ViewBuilder
    private func passwordField(
        title: String,
        text: Binding<String>,
        reveals: Binding<Bool>,
        contentType: UITextContentType,
        focus: Field,
        identifier: String
    ) -> some View {
        HStack {
            Group {
                if reveals.wrappedValue {
                    TextField(title, text: text)
                } else {
                    SecureField(title, text: text)
                }
            }
            .textContentType(contentType)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($focusedField, equals: focus)
            .accessibilityIdentifier(identifier)

            Button {
                reveals.wrappedValue.toggle()
            } label: {
                Image(systemName: reveals.wrappedValue ? "eye.slash.fill" : "eye.fill")
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(reveals.wrappedValue ? "Скрыть пароль" : "Показать пароль")
            .accessibilityIdentifier("\(identifier)-reveal")
        }
    }

    private func canConfigure(status: PhonePasswordStatus) -> Bool {
        let count = newPassword.unicodeScalars.count
        return (15...128).contains(count)
            && newPassword.utf8.count <= 1_024
            && newPassword == confirmation
            && (!status.enabled || !currentPassword.isEmpty)
    }

    private func configurePassword(status: PhonePasswordStatus) async {
        guard canConfigure(status: status) else { return }
        focusedField = nil
        let accepted = await store.configure(
            newPassword: newPassword,
            currentPassword: status.enabled ? currentPassword : nil
        )
        guard accepted else { return }
        #if DEBUG
        currentPassword = uiTestFragmentedPassword(
            prefixKey: "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_PREFIX",
            suffixKey: "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_SUFFIX"
        ) ?? ""
        #else
        currentPassword = ""
        #endif
        newPassword = ""
        confirmation = ""
        retryAction = nil
    }

    private func disablePassword() async {
        focusedField = nil
        let accepted = await store.disable(currentPassword: currentPassword)
        guard accepted else { return }
        currentPassword = ""
        newPassword = ""
        confirmation = ""
        retryAction = nil
    }

    private func retryLastMutation() {
        guard let status = store.status else { return }
        switch retryAction {
        case .configure:
            Task { await configurePassword(status: status) }
        case .disable:
            Task { await disablePassword() }
        case nil:
            break
        }
    }

    private func truncatedPassword(_ value: String) -> String {
        guard value.unicodeScalars.count > 128 else { return value }
        return String(value.unicodeScalars.prefix(128))
    }

    private func prepareUITestPasswordsIfNeeded() {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["LUXORA_UI_TEST_SECURE_AUTOFILL"] == "1"
        else { return }
        currentPassword = uiTestFragmentedPassword(
            prefixKey: "LUXORA_LIVE_PHONE_PASSWORD_PREFIX",
            suffixKey: "LUXORA_LIVE_PHONE_PASSWORD_SUFFIX"
        ) ?? ""
        let replacement = uiTestFragmentedPassword(
            prefixKey: "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_PREFIX",
            suffixKey: "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_SUFFIX"
        ) ?? ""
        newPassword = replacement
        confirmation = replacement
        #endif
    }

    #if DEBUG
    private func uiTestFragmentedPassword(prefixKey: String, suffixKey: String) -> String? {
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_UI_TEST_SECURE_AUTOFILL"] == "1",
              let prefix = environment[prefixKey], !prefix.isEmpty,
              let suffix = environment[suffixKey], !suffix.isEmpty
        else { return nil }
        return prefix + suffix
    }
    #endif
}
#endif
