import SwiftUI

public struct LuxoraApplicationView: View {
    @Bindable private var session: ApplicationSession
    @AppStorage("luxora.phoneAuth.needsPermissions") private var needsPostRegistrationPermissions = false
    @AppStorage("luxora.onboarding.didCompletePermissionsPrimer") private var didCompletePermissionsPrimer = false

    public init(session: ApplicationSession) {
        self.session = session
    }

    public var body: some View {
        Group {
            switch session.presentationState {
            case .restoring:
                SessionRestoringView()
            case .unauthenticated:
                AuthenticationView(session: session)
            case .connecting:
                authenticatedContent(banner: .connecting)
            case .connected:
                authenticatedContent(banner: nil)
            case .offline:
                authenticatedContent(banner: .offline)
            case let .error(message):
                if session.messengerStore == nil {
                    SessionRestorationErrorView(
                        message: message,
                        retry: { Task { await session.retryRestoration() } },
                        signInAgain: { Task { await session.discardRestoredSession() } }
                    )
                } else {
                    authenticatedContent(banner: .error(message))
                }
            }
        }
        .environment(\.authenticatedAvatarImageCache, session.avatarImageCache)
        .task { await restoreSession() }
    }

    private func restoreSession() async {
        #if DEBUG
        if let rawDelay = ProcessInfo.processInfo.environment["LUXORA_UI_TEST_RESTORE_HOLD_MS"],
           let requestedDelay = Int(rawDelay),
           requestedDelay > 0
        {
            do {
                try await Task.sleep(for: .milliseconds(min(requestedDelay, 8_000)))
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
        #endif

        await session.restore()
    }

    @ViewBuilder
    private func authenticatedContent(banner: SessionBanner?) -> some View {
        #if os(iOS)
        if shouldPresentPermissionsPrimer {
            OnboardingPermissionsRationaleView(isPreview: false) {
                needsPostRegistrationPermissions = false
                didCompletePermissionsPrimer = true
            }
        } else if let store = session.messengerStore {
            messengerRoot(store: store)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let banner {
                        SessionStatusBanner(
                            banner: banner,
                            retry: { session.retryRealtime() }
                        )
                    }
                }
        } else {
            SessionRestorationErrorView(
                message: "В авторизованном сеансе отсутствует состояние мессенджера.",
                retry: { Task { await session.retryRestoration() } },
                signInAgain: { Task { await session.discardRestoredSession() } }
            )
        }
        #else
        if let store = session.messengerStore {
            messengerRoot(store: store)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let banner {
                        SessionStatusBanner(
                            banner: banner,
                            retry: { session.retryRealtime() }
                        )
                    }
                }
        } else {
            SessionRestorationErrorView(
                message: "В авторизованном сеансе отсутствует состояние мессенджера.",
                retry: { Task { await session.retryRestoration() } },
                signInAgain: { Task { await session.discardRestoredSession() } }
            )
        }
        #endif
    }

    private var shouldPresentPermissionsPrimer: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["LUXORA_UI_TEST_SCENARIO"] == "messenger" {
            return false
        }
        #endif
        return needsPostRegistrationPermissions || !didCompletePermissionsPrimer
    }

    @ViewBuilder
    private func messengerRoot(store: MessengerStore) -> some View {
        #if os(iOS)
        LuxoraPhoneRootView(
            store: store,
            featureMatrix: session.featureMatrix,
            initialDestination: initialPhoneDestination,
            deviceSessionsStore: session.deviceSessionsStore,
            phonePasswordSettingsStore: session.phonePasswordSettingsStore,
            phoneBindingStore: session.phoneBindingStore,
            notificationSettingsStore: session.notificationSettingsStore,
            pushRegistrationStore: session.pushRegistrationStore,
            chatFoldersStore: session.chatFoldersStore,
            communityStore: session.communityStore,
            globalSearchStore: session.globalSearchStore,
            updateChatPreferences: { chatID, patch in
                await session.updateChatPreferences(chatID: chatID, patch: patch)
            },
            synchronizePushAuthorization: { isAuthorized in
                Task { await session.synchronizePushAuthorization(isAuthorized: isAuthorized) }
            },
            signOut: { Task { await session.signOut() } }
        )
        #else
        LuxoraRootView(store: store)
        #endif
    }

    #if os(iOS)
    private var initialPhoneDestination: LuxoraPhoneInitialDestination {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["LUXORA_UI_TEST_DESTINATION"]?.lowercased() {
        case "contacts", "contact-profile": .contacts
        case "spaces": .spaces
        case "calls": .calls
        case "search": .search
        case "you", "settings", "you-folders", "you-profile", "you-profile-qr", "you-identity", "you-devices", "you-phone-password", "you-notifications",
             "you-privacy", "you-data", "you-appearance", "you-power", "you-language", "you-plus",
             "you-help", "you-faq", "you-features", "you-about": .you
        default: .inbox
        }
        #else
        .inbox
        #endif
    }
    #endif
}

private enum SessionBanner {
    case connecting
    case offline
    case error(String)
}

private struct SessionRestoringView: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            surface.ignoresSafeArea()

            VStack(spacing: 14) {
                LuxoraContourLoaderView(
                    size: 96,
                    accessibilityLabel: "Восстановление сеанса Luxora"
                )
                Text(LuxoraL10n.text("auth.restore"))
                    .font(.headline)
                    .foregroundStyle(foreground)
                Text(LuxoraL10n.text("auth.restore_detail"))
                    .font(.caption)
                    .foregroundStyle(foreground.opacity(0.62))
                    .multilineTextAlignment(.center)
                Text("Beta-0.1 · Flenym")
                    .font(.caption2)
                    .foregroundStyle(foreground.opacity(0.44))
            }
            .padding(32)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Восстановление сеанса Luxora")
        .accessibilityValue(LuxoraL10n.text("auth.restore_detail"))
        .accessibilityIdentifier("session-restoring-screen")
    }

    private var surface: Color {
        colorScheme == .dark ? .black : .white
    }

    private var foreground: Color {
        colorScheme == .dark ? .white : .black
    }
}

private struct SessionRestorationErrorView: View {
    let message: String
    let retry: () -> Void
    let signInAgain: () -> Void

    var body: some View {
        ZStack {
            LuxoraTheme.ink.ignoresSafeArea()
            LuxoraTheme.ambientGradient.ignoresSafeArea()

            ContentUnavailableView {
                Label(LuxoraL10n.text("auth.restore_failed"), systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .foregroundStyle(.white)
            } description: {
                Text(detailMessage)
                    .foregroundStyle(.white.opacity(0.68))
            } actions: {
                ViewThatFits(in: .horizontal) {
                    HStack {
                        restorationActions
                    }
                    VStack {
                        restorationActions
                    }
                }
            }
            .padding(24)
        }
    }

    @ViewBuilder
    private var restorationActions: some View {
        Button(LuxoraL10n.text("common.retry"), action: retry)
            .buttonStyle(.borderedProminent)
        Button(LuxoraL10n.text("auth.sign_in_again"), action: signInAgain)
            .buttonStyle(.bordered)
            .tint(.white)
    }

    private var detailMessage: String {
        let duplicatedHeading = LuxoraL10n.text("auth.restore_failed") + ": "
        guard message.hasPrefix(duplicatedHeading) else { return message }
        return String(message.dropFirst(duplicatedHeading.count))
    }
}

private struct SessionStatusBanner: View {
    let banner: SessionBanner
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            statusIcon
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption.weight(.semibold))
                if let detail {
                    Text(detail)
                        .font(.caption2)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            action
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(backgroundColor)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch banner {
        case .connecting:
            ProgressView()
                .controlSize(.small)
                .tint(.white)
        case .offline:
            Image(systemName: "wifi.slash")
        case .error:
            Image(systemName: "exclamationmark.triangle.fill")
        }
    }

    @ViewBuilder
    private var action: some View {
        switch banner {
        case .offline, .error:
            Button(LuxoraL10n.text("common.retry"), action: retry)
                .font(.caption.weight(.semibold))
        case .connecting:
            EmptyView()
        }
    }

    private var title: String {
        switch banner {
        case .connecting: LuxoraL10n.text("connection.connecting")
        case .offline: LuxoraL10n.text("connection.offline")
        case .error: LuxoraL10n.text("connection.interrupted")
        }
    }

    private var detail: String? {
        switch banner {
        case .connecting:
            LuxoraL10n.text("connection.waiting")
        case .offline:
            LuxoraL10n.text("connection.actions_paused")
        case let .error(message):
            message
        }
    }

    private var backgroundColor: Color {
        switch banner {
        case .connecting: LuxoraTheme.electricBlue
        case .offline: Color.secondary
        case .error: Color.orange
        }
    }
}
