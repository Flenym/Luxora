import SwiftUI

public struct LuxoraRootView: View {
    @Bindable private var store: MessengerStore

    public init(store: MessengerStore) {
        self.store = store
    }

    public var body: some View {
        NavigationSplitView {
            ConversationListView(store: store)
                .navigationSplitViewColumnWidth(min: 290, ideal: 340, max: 410)
        } detail: {
            ZStack {
                LuxoraTheme.ambientGradient
                    .ignoresSafeArea()

                if let conversation = store.selectedConversation {
                    ConversationView(store: store, conversation: conversation)
                } else {
                    EmptyConversationView {
                        store.present(.newConversation)
                    }
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .searchable(
            text: $store.searchQuery,
            isPresented: $store.isSearchFocused,
            placement: .automatic,
            prompt: Text(LuxoraL10n.text("legacy.search_all"))
        )
        .sheet(item: $store.presentedSheet) { destination in
            switch destination {
            case .newConversation:
                NewConversationView(store: store)
            case .profile:
                ProfileView(participant: store.currentUser)
            case .settings:
                LuxoraSettingsView(store: store)
            }
        }
        .preferredColorScheme(colorScheme)
    }

    private var colorScheme: ColorScheme? {
        switch store.preferredAppearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
}

private struct EmptyConversationView: View {
    let create: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(LuxoraL10n.text("legacy.your_conversations"), systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text(LuxoraL10n.text("legacy.choose_conversation"))
        } actions: {
            Button(LuxoraL10n.text("chats.new"), action: create)
                .buttonStyle(.borderedProminent)
        }
    }
}
