import LuxoraKit
import SwiftUI

@main
struct LuxoraMacApp: App {
    @State private var session = ApplicationSession(configuration: .development)

    var body: some Scene {
        WindowGroup("Luxora", id: "messenger") {
            LuxoraApplicationView(session: session)
                .tint(LuxoraTheme.accent)
                .frame(minWidth: 920, minHeight: 620)
        }
        .defaultSize(width: 1240, height: 800)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New message") {
                    session.messengerStore?.present(.newConversation)
                }
                .disabled(session.messengerStore == nil)
                .keyboardShortcut("n", modifiers: .command)
            }

            CommandMenu("Conversation") {
                Button("Search messages") {
                    session.messengerStore?.isSearchFocused = true
                }
                .disabled(session.messengerStore == nil)
                .keyboardShortcut("f", modifiers: .command)

                Button("Toggle details") {
                    session.messengerStore?.isInspectorPresented.toggle()
                }
                .disabled(session.messengerStore == nil)
                .keyboardShortcut("i", modifiers: [.command, .option])
            }
        }

        Settings {
            if let store = session.messengerStore {
                LuxoraSettingsView(store: store)
                    .frame(width: 520, height: 420)
            } else {
                ContentUnavailableView("Sign in first", systemImage: "person.crop.circle.badge.exclamationmark")
                    .frame(width: 520, height: 420)
            }
        }
    }
}
