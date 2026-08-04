#if os(iOS)
import AVFoundation
import Contacts
import CoreImage.CIFilterBuiltins
import Photos
import SwiftUI
import UIKit
import UserNotifications

struct PhoneOwnProfileView: View {
    let participant: Participant
    let identityGate: FeatureGate
    let openIdentity: () -> Void
    let openCode: () -> Void

    @State private var notice: PhoneProfileNotice?

    private var payload: PhoneProfileSharePayload {
        PhoneProfileSharePayload(participant: participant)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 10) {
                    AvatarView(participant: participant, size: 108)
                    Text(participant.displayName)
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Text(participant.isOnline ? "в сети" : participant.status)
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 2)

                HStack(spacing: 10) {
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
                    if !participant.status.isEmpty {
                        Divider().padding(.leading, 16)
                        PhonePublicProfileLine(title: "о себе", value: participant.status)
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
                    Label("Изменение имени, описания и аватара ожидает серверный API профиля.", systemImage: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
                Button("Изм.") { notice = .editingUnavailable }
                    .accessibilityIdentifier("own-profile-edit-gated")
            }
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
}

private enum PhoneProfileNotice: Identifiable {
    case copied(String)
    case editingUnavailable

    var id: String {
        switch self {
        case .copied: "copied"
        case .editingUnavailable: "editing-unavailable"
        }
    }

    var title: String {
        switch self {
        case .copied: "Username скопирован"
        case .editingUnavailable: "Редактирование пока недоступно"
        }
    }

    var message: String {
        switch self {
        case let .copied(username): "@\(username) сохранён в буфере обмена этого iPhone."
        case .editingUnavailable: "Luxora откроет редактирование после появления серверного API профиля."
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
                .font(.caption2)
                .lineLimit(1)
        }
        .foregroundStyle(LuxoraTheme.iris)
        .frame(maxWidth: .infinity)
        .frame(height: 66)
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
        NavigationStack {
            List {
                if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(results) { message in
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
