import SwiftUI

struct ConversationListView: View {
    @Bindable var store: MessengerStore

    var body: some View {
        VStack(spacing: 0) {
            brandHeader
            FolderPicker(selection: $store.selectedFolder)

            List(selection: $store.selectedConversationID) {
                Section {
                    ForEach(store.filteredConversations) { conversation in
                        ConversationRow(conversation: conversation)
                            .tag(conversation.id)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                withAnimation(.snappy(duration: store.reduceMotion ? 0 : 0.32)) {
                                    store.selectConversation(conversation.id)
                                }
                            }
                            .contextMenu {
                                Button(
                                    LuxoraL10n.text(conversation.isPinned ? "legacy.unpin" : "legacy.pin"),
                                    systemImage: "pin"
                                ) {}
                                    .disabled(true)
                                Button(
                                    LuxoraL10n.text(conversation.isMuted ? "legacy.unmute" : "legacy.mute"),
                                    systemImage: "speaker.slash"
                                ) {}
                                    .disabled(true)
                                Divider()
                                Button(LuxoraL10n.text("legacy.archive"), systemImage: "archivebox") {
                                    store.selectConversation(conversation.id)
                                    store.archiveSelectedConversation()
                                }
                            }
                    }
                } header: {
                    HStack {
                        Text(LuxoraL10n.text("legacy.recent"))
                        Spacer()
                        Text("\(store.filteredConversations.count)")
                            .monospacedDigit()
                    }
                }
            }
            .listStyle(.sidebar)
            .overlay {
                if store.filteredConversations.isEmpty {
                    ContentUnavailableView.search(text: store.searchQuery)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(LuxoraL10n.text("chats.new"), systemImage: "square.and.pencil") {
                    store.present(.newConversation)
                }
                .keyboardShortcut("n", modifiers: .command)
            }
        }
    }

    private var brandHeader: some View {
        HStack(spacing: 12) {
            LuxoraLogoView(size: 42)

            VStack(alignment: .leading, spacing: 1) {
                Text("Luxora")
                    .font(.title2.weight(.semibold))
                Label(store.connectionState.label, systemImage: "checkmark.icloud")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button {
                store.present(.profile)
            } label: {
                AvatarView(participant: store.currentUser, size: 34, showsPresence: false)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(LuxoraL10n.text("legacy.open_profile"))
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }
}

private struct FolderPicker: View {
    @Binding var selection: ConversationFolder

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(ConversationFolder.allCases) { folder in
                    Button {
                        withAnimation(.snappy(duration: 0.28)) {
                            selection = folder
                        }
                    } label: {
                        Text(folder.title)
                            .font(.callout.weight(selection == folder ? .semibold : .regular))
                            .padding(.horizontal, 13)
                            .padding(.vertical, 7)
                    }
                    .buttonStyle(.plain)
                    .background(
                        selection == folder ? LuxoraTheme.accent.opacity(0.16) : Color.clear,
                        in: Capsule()
                    )
                    .foregroundStyle(selection == folder ? LuxoraTheme.accent : .secondary)
                    .accessibilityAddTraits(selection == folder ? .isSelected : [])
                }
            }
            .padding(.horizontal, 14)
        }
        .padding(.bottom, 6)
    }
}

private struct ConversationRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 11) {
            AvatarView(participant: conversation.avatar, size: 46)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Text(conversation.title)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    if conversation.kind != .direct {
                        Image(systemName: conversation.kind.symbol)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Text(conversation.lastActivity, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                HStack(spacing: 6) {
                    Text(conversation.isTyping ? LuxoraL10n.text("chats.typing") : conversation.subtitle)
                        .font(.callout)
                        .foregroundStyle(conversation.isTyping ? LuxoraTheme.accent : .secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if conversation.isMuted {
                        Image(systemName: "speaker.slash.fill")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if conversation.unreadCount > 0 {
                        Text("\(conversation.unreadCount)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(LuxoraTheme.accent, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(conversation.title), \(String(format: LuxoraL10n.text("legacy.unread_count"), conversation.unreadCount))"
        )
    }
}
