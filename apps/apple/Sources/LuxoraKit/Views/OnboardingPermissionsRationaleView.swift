#if os(iOS)
import Contacts
import SwiftUI
import UIKit
import UserNotifications

struct OnboardingPermissionsRationaleView: View {
    let isPreview: Bool
    let completion: () -> Void

    @State private var notificationState: PermissionState = .unknown
    @State private var contactsState: PermissionState = .unknown
    @State private var localMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                PhonePermissionHero()

                Text("Разрешения под вашим контролем")
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.top, 24)

                Text("Сначала объясняем пользу, затем показываем системный запрос — только после вашего нажатия.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .padding(.top, 10)

                VStack(spacing: 12) {
                    PermissionRationaleRow(
                        systemName: "bell.badge.fill",
                        title: "Уведомления",
                        detail: "Чтобы не пропускать новые сообщения и звонки.",
                        state: notificationState,
                        action: handleNotifications
                    )
                    .accessibilityIdentifier("auth-permission-notifications")

                    PermissionRationaleRow(
                        systemName: "person.crop.circle.badge.plus",
                        title: "Контакты",
                        detail: "Чтобы находить знакомых. Адресная книга не нужна для работы Luxora.",
                        state: contactsState,
                        action: handleContacts
                    )
                    .accessibilityIdentifier("auth-permission-contacts")
                }
                .padding(.top, 28)

                Text("Камеру, микрофон и доступ к фото Luxora запросит отдельно — только при первом использовании соответствующей функции.")
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.58))
                    .multilineTextAlignment(.center)
                    .padding(.top, 18)

                if let localMessage {
                    Text(localMessage)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                        .padding(.top, 12)
                        .accessibilityIdentifier("auth-permission-message")
                }

                Button("Продолжить", action: completion)
                    .buttonStyle(.borderedProminent)
                    .tint(LuxoraTheme.accent)
                    .controlSize(.large)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 30)
                    .accessibilityIdentifier("auth-permissions-continue")

                Button("Настроить позже", action: completion)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.white.opacity(0.72))
                    .padding(.top, 16)
                    .accessibilityIdentifier("auth-permissions-later")
            }
            .padding(.horizontal, 24)
            .padding(.top, 46)
            .padding(.bottom, 30)
        }
        .background(Color.black.ignoresSafeArea())
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("auth-permissions-screen")
        .task { await refreshStates() }
    }

    private func handleNotifications() {
        guard !isPreview else {
            localMessage = "DEBUG-предпросмотр не открывает системный запрос."
            return
        }
        if notificationState == .denied {
            openSettings()
            return
        }
        Task { @MainActor in
            do {
                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                await refreshStates()
            } catch {
                localMessage = "Не удалось запросить уведомления. Попробуйте в Настройках."
                notificationState = .denied
            }
        }
    }

    private func handleContacts() {
        guard !isPreview else {
            localMessage = "DEBUG-предпросмотр не открывает системный запрос."
            return
        }
        if contactsState == .denied {
            openSettings()
            return
        }
        Task { @MainActor in
            do {
                _ = try await CNContactStore().requestAccess(for: .contacts)
                await refreshStates()
            } catch {
                localMessage = "Не удалось запросить контакты. Попробуйте в Настройках."
                contactsState = .denied
            }
        }
    }

    @MainActor
    private func refreshStates() async {
        guard !isPreview else {
            notificationState = .unknown
            contactsState = .unknown
            return
        }

        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        switch notificationSettings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            notificationState = .allowed
        case .denied:
            notificationState = .denied
        case .notDetermined:
            notificationState = .unknown
        @unknown default:
            notificationState = .unknown
        }

        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited:
            contactsState = .allowed
        case .denied, .restricted:
            contactsState = .denied
        case .notDetermined:
            contactsState = .unknown
        @unknown default:
            contactsState = .unknown
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

private enum PermissionState: Equatable {
    case unknown
    case allowed
    case denied
}

private struct PhonePermissionHero: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(Color.white.opacity(0.08))
                .frame(width: 104, height: 104)
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 44, weight: .medium))
                .foregroundStyle(LuxoraTheme.iris)
        }
        .accessibilityHidden(true)
    }
}

private struct PermissionRationaleRow: View {
    let systemName: String
    let title: String
    let detail: String
    let state: PermissionState
    let action: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemName)
                .font(.title3.weight(.semibold))
                .foregroundStyle(LuxoraTheme.iris)
                .frame(width: 42, height: 42)
                .background(Color.white.opacity(0.08), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 6)

            Button(buttonTitle, action: action)
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .tint(buttonTint)
                .disabled(state == .allowed)
        }
        .padding(14)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    }

    private var buttonTitle: String {
        switch state {
        case .unknown: "Разрешить"
        case .allowed: "Готово"
        case .denied: "Настройки"
        }
    }

    private var buttonTint: Color {
        switch state {
        case .unknown: LuxoraTheme.iris
        case .allowed: LuxoraTheme.success
        case .denied: .orange
        }
    }
}
#endif
