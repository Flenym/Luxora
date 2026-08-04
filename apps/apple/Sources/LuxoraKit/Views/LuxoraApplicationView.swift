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
                        signInAgain: { session.discardRestoredSession() }
                    )
                } else {
                    authenticatedContent(banner: .error(message))
                }
            }
        }
        .task { await session.restore() }
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
                signInAgain: { session.discardRestoredSession() }
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
                signInAgain: { session.discardRestoredSession() }
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
        case "you", "settings", "you-folders", "you-profile", "you-profile-qr", "you-identity", "you-devices", "you-notifications",
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
    var body: some View {
        ZStack {
            LuxoraTheme.ink.ignoresSafeArea()
            LuxoraTheme.ambientGradient.ignoresSafeArea()

            VStack(spacing: 14) {
                ProgressView()
                    .controlSize(.large)
                    .tint(LuxoraTheme.iris)
                Text(LuxoraL10n.text("auth.restore"))
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(LuxoraL10n.text("auth.restore_detail"))
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.62))
                    .multilineTextAlignment(.center)
                Text("Beta-0.1 · Flenym")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.44))
            }
            .padding(32)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Восстановление сеанса Luxora")
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
                Text(message)
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
