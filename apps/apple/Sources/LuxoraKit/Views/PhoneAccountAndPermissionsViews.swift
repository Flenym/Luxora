#if os(iOS)
import AVFoundation
import Contacts
import CoreImage.CIFilterBuiltins
import Photos
import SwiftUI
import UIKit
import UserNotifications

struct PhoneOwnProfileView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Bindable var store: MessengerStore
    let identityGate: FeatureGate
    let openIdentity: () -> Void
    let openCode: () -> Void

    @State private var notice: PhoneProfileNotice?
    @State private var isEditing = false

    private var participant: Participant { store.currentUser }

    private var payload: PhoneProfileSharePayload {
        PhoneProfileSharePayload(participant: participant)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 10) {
                    AvatarView(participant: participant, size: 108)
                    Text(participant.displayName)
                        .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityHeading(.h1)
                    Text(
                        participant.isOnline
                            ? "в сети"
                            : store.currentUserBio.isEmpty ? "@\(participant.username)" : store.currentUserBio
                    )
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 2)

                profileActionLayout {
                    PhoneOwnProfileAction(
                        title: "копировать",
                        symbol: "doc.on.doc",
                        identifier: "own-profile-copy-username"
                    ) {
                        UIPasteboard.general.string = "@\(participant.username)"
                        notice = .copied(participant.username)
                    }

                    ShareLink(item: payload.shareText) {
                        PhoneOwnProfileActionLabel(title: "поделиться", symbol: "square.and.arrow.up")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("поделиться")
                    .accessibilityIdentifier("own-profile-share")

                    PhoneOwnProfileAction(
                        title: "QR",
                        symbol: "qrcode",
                        identifier: "own-profile-open-qr",
                        action: openCode
                    )
                }
                .padding(.horizontal, 16)

                VStack(alignment: .leading, spacing: 0) {
                    PhonePublicProfileLine(title: "имя", value: participant.displayName)
                    Divider().padding(.leading, 16)
                    PhonePublicProfileLine(title: "username", value: "@\(participant.username)")
                    if !store.currentUserBio.isEmpty {
                        Divider().padding(.leading, 16)
                        PhonePublicProfileLine(title: "о себе", value: store.currentUserBio)
                    }
                }
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 24, style: .continuous)
                )
                .padding(.horizontal, 16)

                VStack(alignment: .leading, spacing: 0) {
                    Button(action: openIdentity) {
                        HStack(spacing: 12) {
                            Image(systemName: identityGate.symbol)
                                .foregroundStyle(LuxoraTheme.iris)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Способы входа")
                                    .foregroundStyle(.primary)
                                Text(identityGate.state.label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(16)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("own-profile-identity")
                    Divider().padding(.leading, 56)
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "checkmark.icloud.fill")
                            .accessibilityHidden(true)
                        Text("Синхронизация: сервер Luxora")
                            .fixedSize(horizontal: false, vertical: true)
                    }
                        .font(.caption)
                        .foregroundStyle(.primary.opacity(0.72))
                        .padding(16)
                }
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 24, style: .continuous)
                )
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 28)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { isEditing = true } label: {
                    Image(systemName: "pencil")
                        .frame(minWidth: 44, minHeight: 44)
                }
                    .foregroundStyle(.primary)
                    .accessibilityLabel("Изменить профиль")
                    .accessibilityIdentifier("own-profile-edit")
            }
        }
        .sheet(isPresented: $isEditing) {
            PhoneProfileEditView(store: store)
        }
        .alert(item: $notice) { notice in
            Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .cancel(Text("ОК"))
            )
        }
        .accessibilityIdentifier("own-profile-screen")
    }

    private var profileActionLayout: AnyLayout {
        if dynamicTypeSize >= .xxLarge {
            AnyLayout(VStackLayout(spacing: 10))
        } else {
            AnyLayout(HStackLayout(spacing: 10))
        }
    }
}

private enum PhoneProfileNotice: Identifiable {
    case copied(String)

    var id: String {
        switch self {
        case .copied: "copied"
        }
    }

    var title: String {
        switch self {
        case .copied: "Username скопирован"
        }
    }

    var message: String {
        switch self {
        case let .copied(username): "@\(username) сохранён в буфере обмена этого iPhone."
        }
    }
}

private struct PhoneProfileEditView: View {
    @Bindable var store: MessengerStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var displayName: String
    @State private var bio: String
    @State private var avatarPNGData: Data?
    @State private var confirmsAvatarRemoval = false
    @FocusState private var focusedField: Field?

    private enum Field {
        case displayName
        case bio
    }

    init(store: MessengerStore) {
        self.store = store
        _displayName = State(initialValue: store.currentUser.displayName)
        _bio = State(initialValue: store.currentUserBio)
    }

    private var normalizedName: String {
        displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var normalizedBio: String {
        bio.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isSaving: Bool {
        store.profileUpdateState == .loading || store.avatarUpdateState == .loading
    }
    private var hasChanges: Bool {
        normalizedName != store.currentUser.displayName || normalizedBio != store.currentUserBio
    }
    private var canSave: Bool {
        (1...80).contains(normalizedName.count)
            && normalizedBio.count <= 500
            && hasChanges
            && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                if usesExpandedNavigation {
                    Section {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Изменить профиль")
                                .font(.title2.weight(.semibold))
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                                .accessibilityIdentifier("profile-edit-title")

                            HStack(spacing: 12) {
                                Button("Отмена") { dismiss() }
                                    .buttonStyle(.bordered)
                                    .tint(cancelColor)
                                    .disabled(isSaving)
                                    .accessibilityIdentifier("profile-edit-cancel")

                                Spacer(minLength: 0)

                                Button(action: save) {
                                    profileSaveLabel
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(!canSave)
                                .accessibilityLabel(isSaving ? "Сохраняем профиль" : "Готово")
                                .accessibilityValue(isSaving ? "Выполняется" : "")
                                .accessibilityIdentifier("profile-edit-save")
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                Section {
                    VStack(spacing: 10) {
                        ProfileAvatarEditor(
                            displayName: normalizedName.isEmpty ? store.currentUser.displayName : normalizedName,
                            avatarPNGData: $avatarPNGData,
                            identifierPrefix: "profile-avatar",
                            existingParticipant: store.currentUser
                        )
                        Text("Фото кадрируется в круг, загружается частями и перепроверяется сервером.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)

                        if let avatarPNGData {
                            Button {
                                uploadAvatar(avatarPNGData)
                            } label: {
                                Label("Загрузить фото", systemImage: "icloud.and.arrow.up")
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isSaving)
                            .accessibilityIdentifier("profile-avatar-upload")
                        }

                        if store.currentUser.avatarPath != nil {
                            Button("Удалить текущее фото", role: .destructive) {
                                confirmsAvatarRemoval = true
                            }
                            .disabled(isSaving)
                            .accessibilityIdentifier("profile-avatar-clear")
                        }

                        if store.avatarUpdateState == .loading {
                            ProgressView("Синхронизируем фото…")
                                .accessibilityIdentifier("profile-avatar-progress")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }

                Section {
                    TextField("Имя", text: $displayName)
                        .textContentType(.name)
                        .focused($focusedField, equals: .displayName)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .bio }
                        .accessibilityIdentifier("profile-edit-name")

                    TextField("О себе", text: $bio, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focusedField, equals: .bio)
                        .submitLabel(.done)
                        .accessibilityIdentifier("profile-edit-bio")

                    Text("Имя: \(normalizedName.count)/80 · О себе: \(normalizedBio.count)/500")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("profile-edit-counts")
                } header: {
                    Text("Профиль")
                        .font(.headline)
                        .textCase(nil)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if case let .failed(message) = store.profileUpdateState {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("profile-edit-error")
                    }
                }

                if case let .failed(message) = store.avatarUpdateState {
                    Section("Фото профиля") {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("profile-avatar-error")
                        if let avatarPNGData {
                            Button("Повторить загрузку") { uploadAvatar(avatarPNGData) }
                                .disabled(isSaving)
                                .accessibilityIdentifier("profile-avatar-retry")
                        } else if store.currentUser.avatarPath != nil {
                            Button("Повторить удаление", role: .destructive) {
                                clearAvatar()
                            }
                            .disabled(isSaving)
                            .accessibilityIdentifier("profile-avatar-retry-clear")
                        }
                    }
                }
            }
            // Form rows cache measurements aggressively. Recreating the
            // layout shell on a text-size change keeps @State input intact
            // while every label receives a fresh scalable height.
            .id(dynamicTypeSize)
            .navigationTitle(usesExpandedNavigation ? "" : "Изменить профиль")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !usesExpandedNavigation {
                        Button { dismiss() } label: {
                            Text("Отмена")
                                .font(.body)
                                .fixedSize(horizontal: true, vertical: true)
                        }
                        .tint(cancelColor)
                        .disabled(isSaving)
                        .accessibilityIdentifier("profile-edit-cancel")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !usesExpandedNavigation {
                        Button(action: save) {
                            profileSaveLabel
                        }
                        .disabled(!canSave)
                        .accessibilityLabel(isSaving ? "Сохраняем профиль" : "Готово")
                        .accessibilityValue(isSaving ? "Выполняется" : "")
                        .accessibilityIdentifier("profile-edit-save")
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Button("Назад") {
                        focusedField = .displayName
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(focusedField == .displayName)
                    .accessibilityIdentifier("profile-edit-keyboard-previous")

                    Button("Далее") {
                        focusedField = .bio
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(focusedField == .bio)
                    .accessibilityIdentifier("profile-edit-keyboard-next")

                    Spacer()

                    Button("Готово") {
                        focusedField = nil
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("profile-edit-keyboard-done")
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .confirmationDialog(
            "Удалить фото профиля?",
            isPresented: $confirmsAvatarRemoval,
            titleVisibility: .visible
        ) {
            Button("Удалить фото", role: .destructive) { clearAvatar() }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Вместо фото будет показана первая буква имени.")
        }
        .accessibilityIdentifier("profile-edit-screen")
    }

    @ViewBuilder
    private var profileSaveLabel: some View {
        if isSaving {
            ProgressView()
        } else {
            Text("Готово")
                .fixedSize(horizontal: true, vertical: true)
        }
    }

    private var usesExpandedNavigation: Bool {
        dynamicTypeSize >= .xxLarge
    }

    private var cancelColor: Color {
        colorScheme == .dark ? LuxoraTheme.frost : LuxoraTheme.deepViolet
    }

    private func save() {
        guard canSave else { return }
        focusedField = nil
        Task { @MainActor in
            if await store.updateCurrentUserProfile(displayName: normalizedName, bio: normalizedBio) {
                dismiss()
            }
        }
    }

    private func uploadAvatar(_ data: Data) {
        focusedField = nil
        Task { @MainActor in
            if await store.updateCurrentUserAvatar(pngData: data) {
                avatarPNGData = nil
            }
        }
    }

    private func clearAvatar() {
        focusedField = nil
        Task { @MainActor in
            if await store.clearCurrentUserAvatar() {
                avatarPNGData = nil
            }
        }
    }
}

private struct PhoneOwnProfileAction: View {
    let title: String
    let symbol: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            PhoneOwnProfileActionLabel(title: title, symbol: symbol)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

private struct PhoneOwnProfileActionLabel: View {
    let title: String
    let symbol: String

    var body: some View {
        VStack(spacing: 7) {
            Image(systemName: symbol)
                .font(.title3.weight(.semibold))
            Text(title)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 10)
        .foregroundStyle(LuxoraTheme.iris)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 66)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
    }
}

private struct PhonePublicProfileLine: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.callout)
            Text(value)
                .font(.body)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }
}

struct PhoneProfileCodeView: View {
    let participant: Participant

    private var payload: PhoneProfileSharePayload {
        PhoneProfileSharePayload(participant: participant)
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [LuxoraTheme.deepViolet, LuxoraTheme.violet, LuxoraTheme.electricBlue],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 22) {
                    VStack(spacing: 12) {
                        Group {
                            if let image = PhoneProfileQRCode.make(from: payload.qrText) {
                                Image(uiImage: image)
                                    .interpolation(.none)
                                    .resizable()
                                    .scaledToFit()
                            } else {
                                ContentUnavailableView("QR не создан", systemImage: "qrcode")
                            }
                        }
                        .frame(width: 246, height: 246)

                        Text("@\(participant.username.uppercased())")
                            .font(.title2.monospaced().weight(.bold))
                            .foregroundStyle(LuxoraTheme.deepViolet)
                    }
                    .padding(.top, 66)
                    .padding(.horizontal, 22)
                    .padding(.bottom, 28)
                    .frame(maxWidth: .infinity)
                    .background(.white, in: RoundedRectangle(cornerRadius: 34, style: .continuous))
                    .overlay(alignment: .top) {
                        AvatarView(participant: participant, size: 88)
                            .offset(y: -42)
                    }
                    .shadow(color: .black.opacity(0.12), radius: 18, y: 9)

                    VStack(spacing: 16) {
                        Text("QR профиля")
                            .font(.title3.weight(.semibold))
                        Text("QR содержит только имя, username и метку Beta-0.1. В нём нет токена входа, номера телефона или данных сеанса.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)

                        ShareLink(item: payload.shareText) {
                            Label("Поделиться QR", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("own-profile-qr-share")
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
                }
                .padding(.horizontal, 18)
                .padding(.top, 68)
                .padding(.bottom, 28)
            }
        }
        .navigationTitle("QR профиля")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .accessibilityIdentifier("own-profile-qr-screen")
    }
}

@MainActor
private enum PhoneProfileQRCode {
    static func make(from value: String) -> UIImage? {
        let generator = CIFilter.qrCodeGenerator()
        generator.message = Data(value.utf8)
        generator.correctionLevel = "M"
        guard let code = generator.outputImage else {
            return nil
        }
        let colors = CIFilter.falseColor()
        colors.inputImage = code
        colors.color0 = CIColor(color: UIColor(red: 0.20, green: 0.13, blue: 0.53, alpha: 1))
        colors.color1 = CIColor(color: .white)
        guard let output = colors.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else { return nil }
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let image = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}

struct PhoneLoadedMessageSearchView: View {
    let conversation: Conversation
    let messages: [ChatMessage]

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var results: [ChatMessage] {
        PhoneLoadedMessageSearch.results(in: messages, query: query)
    }

    var body: some View {
        let matchingMessages = results

        NavigationStack {
            List {
                if matchingMessages.isEmpty {
                    ContentUnavailableView.search(text: query)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(matchingMessages) { message in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(message.author.displayName)
                                    .font(.caption.weight(.semibold))
                                Spacer()
                                Text(message.sentAt, style: .date)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(message.text)
                                .font(.body)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 4)
                        .accessibilityIdentifier("contact-message-search-result-\(message.id.uuidString.lowercased())")
                    }
                }
            }
            .searchable(text: $query, prompt: "Поиск в переписке")
            .navigationTitle(conversation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("contact-message-search-screen")
    }
}

enum PhoneSystemPermissionState: Equatable, Sendable {
    case notRequested
    case allowed
    case limited
    case denied
    case restricted

    var label: String {
        switch self {
        case .notRequested: "Не запрошено"
        case .allowed: "Разрешено"
        case .limited: "Ограничено"
        case .denied: "Запрещено"
        case .restricted: "Недоступно"
        }
    }

    var symbol: String {
        switch self {
        case .allowed: "checkmark.circle.fill"
        case .limited: "circle.lefthalf.filled"
        case .notRequested: "questionmark.circle.fill"
        case .denied: "xmark.circle.fill"
        case .restricted: "lock.circle.fill"
        }
    }
}

struct PhoneSystemPermissionSnapshot: Equatable, Sendable {
    let notifications: PhoneSystemPermissionState
    let contacts: PhoneSystemPermissionState
    let camera: PhoneSystemPermissionState
    let microphone: PhoneSystemPermissionState
    let photos: PhoneSystemPermissionState

    static let loading = PhoneSystemPermissionSnapshot(
        notifications: .notRequested,
        contacts: .notRequested,
        camera: .notRequested,
        microphone: .notRequested,
        photos: .notRequested
    )

    static func current() async -> PhoneSystemPermissionSnapshot {
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        return PhoneSystemPermissionSnapshot(
            notifications: map(notificationSettings.authorizationStatus),
            contacts: map(CNContactStore.authorizationStatus(for: .contacts)),
            camera: map(AVCaptureDevice.authorizationStatus(for: .video)),
            microphone: map(AVCaptureDevice.authorizationStatus(for: .audio)),
            photos: map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        )
    }

    private static func map(_ status: UNAuthorizationStatus) -> PhoneSystemPermissionState {
        switch status {
        case .notDetermined: .notRequested
        case .denied: .denied
        case .authorized, .provisional, .ephemeral: .allowed
        @unknown default: .restricted
        }
    }

    private static func map(_ status: CNAuthorizationStatus) -> PhoneSystemPermissionState {
        switch status {
        case .notDetermined: .notRequested
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .allowed
        case .limited: .limited
        @unknown default: .restricted
        }
    }

    private static func map(_ status: AVAuthorizationStatus) -> PhoneSystemPermissionState {
        switch status {
        case .notDetermined: .notRequested
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .allowed
        @unknown default: .restricted
        }
    }

    private static func map(_ status: PHAuthorizationStatus) -> PhoneSystemPermissionState {
        switch status {
        case .notDetermined: .notRequested
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .allowed
        case .limited: .limited
        @unknown default: .restricted
        }
    }
}

enum PhoneSystemPermissionActions {
    static func requestNotifications() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        )
    }
}

struct PhoneSystemPermissionRow: View {
    let title: String
    let symbol: String
    let state: PhoneSystemPermissionState

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(LuxoraTheme.iris)
                .frame(width: 24)
            Text(title)
            Spacer()
            Label(state.label, systemImage: state.symbol)
                .font(.caption)
                .foregroundStyle(state == .allowed ? LuxoraTheme.success : .secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(state.label)")
    }
}

struct PhoneSystemSettingsButton: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            openURL(url)
        } label: {
            Label("Открыть настройки iPhone", systemImage: "gear")
        }
        .accessibilityIdentifier("open-ios-settings")
    }
}
#endif
