import SwiftUI

struct ConversationView: View {
    @Bindable var store: MessengerStore
    let conversation: Conversation

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    DateDivider(label: LuxoraL10n.text("conversation.today"))
                        .padding(.bottom, 8)

                    ForEach(store.selectedMessages) { message in
                        MessageRow(
                            message: message,
                            onReaction: { emoji in
                                withAnimation(.snappy(duration: store.reduceMotion ? 0 : 0.24)) {
                                    store.toggleReaction(emoji, messageID: message.id)
                                }
                            }
                        )
                        .id(message.id)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 10)
                .frame(maxWidth: 920)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MessageComposer(store: store)
            }
            .onChange(of: store.selectedMessages.count) { _, _ in
                guard let lastID = store.selectedMessages.last?.id else { return }
                withAnimation(.snappy(duration: store.reduceMotion ? 0 : 0.28)) {
                    proxy.scrollTo(lastID, anchor: .bottom)
                }
            }
        }
        .navigationTitle(conversation.title)
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                ConversationTitle(conversation: conversation)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button(LuxoraL10n.text("conversation.audio_call"), systemImage: "phone") {}
                    .disabled(true)
                    .accessibilityHint(LuxoraL10n.text("legacy.audio_call_hint"))
                Button(LuxoraL10n.text("conversation.video_call"), systemImage: "video") {}
                    .disabled(true)
                    .accessibilityHint(LuxoraL10n.text("legacy.video_call_hint"))
                Button(LuxoraL10n.text("legacy.details"), systemImage: "info.circle") {
                    store.isInspectorPresented.toggle()
                }
            }
        }
        .inspector(isPresented: $store.isInspectorPresented) {
            ConversationInspector(conversation: conversation)
                .inspectorColumnWidth(min: 260, ideal: 300, max: 360)
        }
    }
}

private struct ConversationTitle: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 9) {
            AvatarView(participant: conversation.avatar, size: 32)
            VStack(alignment: .leading, spacing: 0) {
                Text(conversation.title)
                    .font(.headline)
                Text(conversation.isTyping ? LuxoraL10n.text("chats.typing") : conversation.avatar.status)
                    .font(.caption2)
                    .foregroundStyle(conversation.isTyping ? LuxoraTheme.accent : .secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct DateDivider: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 11)
            .padding(.vertical, 5)
            .background(.thinMaterial, in: Capsule())
            .accessibilityAddTraits(.isHeader)
    }
}

private struct ConversationInspector: View {
    let conversation: Conversation

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                AvatarView(participant: conversation.avatar, size: 86)
                VStack(spacing: 4) {
                    Text(conversation.title)
                        .font(.title2.weight(.semibold))
                    Text("@\(conversation.avatar.username)")
                        .foregroundStyle(.secondary)
                    Text(conversation.avatar.status)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 10) {
                    InspectorMetric(value: "\(conversation.memberCount)", label: LuxoraL10n.text("legacy.members"))
                    InspectorMetric(value: "128", label: LuxoraL10n.text("legacy.media"))
                    InspectorMetric(value: "24", label: LuxoraL10n.text("legacy.files"))
                }

                VStack(alignment: .leading, spacing: 12) {
                    Label(LuxoraL10n.text("legacy.shared_media"), systemImage: "photo.on.rectangle")
                    Label(LuxoraL10n.text("legacy.pinned_messages"), systemImage: "pin")
                    Label(LuxoraL10n.text("settings.notifications"), systemImage: "bell")
                    Label(LuxoraL10n.text("legacy.encryption_privacy"), systemImage: "lock.shield")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .padding(20)
        }
    }
}

private struct InspectorMetric: View {
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.headline.monospacedDigit())
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}
