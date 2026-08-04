import SwiftUI

struct NewConversationView: View {
    @Bindable var store: MessengerStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var results: [Conversation] {
        store.conversations.filter {
            query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section(LuxoraL10n.text("legacy.start_something")) {
                    Label(LuxoraL10n.text("legacy.new_group"), systemImage: "person.3.fill")
                    Label(LuxoraL10n.text("legacy.new_channel"), systemImage: "megaphone.fill")
                    Label(LuxoraL10n.text("legacy.scan_qr"), systemImage: "qrcode.viewfinder")
                }

                Section(LuxoraL10n.text("legacy.people_spaces")) {
                    ForEach(results) { conversation in
                        Button {
                            store.selectConversation(conversation.id)
                            dismiss()
                        } label: {
                            HStack(spacing: 12) {
                                AvatarView(participant: conversation.avatar)
                                VStack(alignment: .leading) {
                                    Text(conversation.title)
                                    Text("@\(conversation.avatar.username)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .searchable(text: $query, prompt: Text(LuxoraL10n.text("legacy.name_username")))
            .navigationTitle(LuxoraL10n.text("chats.new"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(LuxoraL10n.text("common.cancel")) { dismiss() }
                }
            }
        }
        .frame(minWidth: 420, minHeight: 520)
    }
}
