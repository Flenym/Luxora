import LuxoraDesignFixtures
import LuxoraKit
import SwiftUI

@main
@MainActor
struct LuxoraDesignLabApp: App {
    @State private var store: MessengerStore
    private let scenario: DesignLabScenario

    init() {
        let store = LuxoraDesignFixtures.makeStore()
        store.connectionState = .online
        _store = State(initialValue: store)
        scenario = DesignLabScenario(arguments: ProcessInfo.processInfo.arguments)
    }

    var body: some Scene {
        WindowGroup {
            DesignLabScenarioView(store: store, scenario: scenario)
                .tint(LuxoraTheme.accent)
        }
    }
}

enum DesignLabScenario: String {
    case loginChecking = "login-checking"
    case loginPasskeyUnavailable = "login-passkey-unavailable"
    case registration
    case chatList = "chat-list"
    case conversation
    case conceptConversationMedia = "concept-conversation-media"
    case conceptCall = "concept-call"
    case conceptContacts = "concept-contacts-search"
    case conceptSettings = "concept-profile-settings"
    case conceptLoading = "concept-loading"
    case conceptComponents = "concept-component-board"

    init(arguments: [String]) {
        let rawValue = arguments
            .first(where: { $0.hasPrefix("--scenario=") })?
            .replacingOccurrences(of: "--scenario=", with: "")
        self = rawValue.flatMap(Self.init(rawValue:)) ?? .chatList
    }
}

private struct DesignLabScenarioView: View {
    @Bindable var store: MessengerStore
    let scenario: DesignLabScenario

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                designLabBanner
                    .frame(height: 34)
                    .zIndex(1)
                content
                    .frame(
                        width: geometry.size.width,
                        height: max(0, geometry.size.height - 34)
                    )
                    .zIndex(0)
            }
            .frame(
                width: geometry.size.width,
                height: geometry.size.height,
                alignment: .top
            )
        }
        .background(LuxoraTheme.deepViolet.ignoresSafeArea(edges: .top))
    }

    private var designLabBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: scenario.isConcept ? "paintbrush.pointed.fill" : "hammer.fill")
            Text(scenario.isConcept ? "CONCEPT · NOT IMPLEMENTED" : "IMPLEMENTED · FIXTURE")
                .fontWeight(.semibold)
            Text("Design Lab · no server")
                .foregroundStyle(.white.opacity(0.72))
            Spacer(minLength: 0)
        }
        .font(.caption2)
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .frame(minHeight: 34)
        .background(LuxoraTheme.deepViolet)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("design-lab-banner")
    }

    @ViewBuilder
    private var content: some View {
        switch scenario {
        case .loginChecking:
            authentication(passkeyState: .checking)
        case .loginPasskeyUnavailable:
            authentication(
                passkeyState: .unavailable(
                    "Public passkey sign-in is not enabled by the Beta-0.1 server contract."
                )
            )
        case .registration:
            authentication(
                passkeyState: .unavailable(
                    "Public passkey sign-in is not enabled by the Beta-0.1 server contract."
                ),
                initialMode: .register
            )
        case .chatList:
            LuxoraPhoneRootView(
                store: store,
                featureMatrix: LuxoraDesignFixtures.featureMatrix
            )
        case .conversation:
            LuxoraPhoneRootView(
                store: store,
                featureMatrix: LuxoraDesignFixtures.featureMatrix,
                initialDestination: .conversation(
                    LuxoraDesignFixtures.primaryConversationID
                )
            )
        case .conceptConversationMedia:
            ConceptConversationMediaView()
        case .conceptCall:
            ConceptCallView()
        case .conceptContacts:
            ConceptContactsSearchView()
        case .conceptSettings:
            ConceptProfileSettingsView()
        case .conceptLoading:
            ConceptLoadingView()
        case .conceptComponents:
            ConceptComponentBoardView()
        }
    }

    private func authentication(
        passkeyState: PasskeyPresentationState,
        initialMode: AuthenticationInitialMode = .login
    ) -> some View {
        LuxoraAuthenticationScreen(
            apiTarget: "DesignLab fixture · network disabled",
            isWorking: false,
            errorMessage: nil,
            passkeyState: passkeyState,
            initialMode: initialMode,
            login: { _, _ in },
            register: { _, _, _ in },
            retryCapabilities: {}
        )
    }
}

private extension DesignLabScenario {
    var isConcept: Bool {
        switch self {
        case .conceptConversationMedia,
             .conceptCall,
             .conceptContacts,
             .conceptSettings,
             .conceptLoading,
             .conceptComponents:
            true
        case .loginChecking,
             .loginPasskeyUnavailable,
             .registration,
             .chatList,
             .conversation:
            false
        }
    }
}
