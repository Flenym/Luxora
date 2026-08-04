import SwiftUI

struct MessageRow: View {
    let message: ChatMessage
    let onReaction: (String) -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if message.isOutgoing { Spacer(minLength: 54) }

            if !message.isOutgoing {
                AvatarView(participant: message.author, size: 28, showsPresence: false)
            }

            VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 4) {
                messageBubble
                if !message.reactions.isEmpty {
                    reactionStrip
                }
            }

            if !message.isOutgoing { Spacer(minLength: 54) }
        }
        .frame(maxWidth: .infinity)
        .contextMenu {
            Button(LuxoraL10n.text("legacy.reply"), systemImage: "arrowshape.turn.up.left") {}
                .disabled(true)
            Button(LuxoraL10n.text("legacy.forward"), systemImage: "arrowshape.turn.up.right") {}
                .disabled(true)
            Menu(LuxoraL10n.text("legacy.react"), systemImage: "face.smiling") {
                ForEach(["💜", "✨", "👍", "😂"], id: \.self) { emoji in
                    Button(emoji) { onReaction(emoji) }
                }
            }
            if message.isOutgoing {
                Divider()
                Button(LuxoraL10n.text("legacy.edit"), systemImage: "pencil") {}
                    .disabled(true)
                Button(LuxoraL10n.text("legacy.delete"), systemImage: "trash", role: .destructive) {}
                    .disabled(true)
            }
        }
    }

    private var messageBubble: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let replyPreview = message.replyPreview {
                HStack(spacing: 7) {
                    Capsule()
                        .fill(LuxoraTheme.iris)
                        .frame(width: 3)
                    Text(replyPreview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Text(message.text)
                .font(.body)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 4) {
                if message.editedAt != nil {
                    Text(LuxoraL10n.text("conversation.edited"))
                }
                Text(message.sentAt, style: .time)
                if message.isOutgoing {
                    Image(systemName: message.delivery.symbol)
                        .foregroundStyle(message.delivery == .read ? LuxoraTheme.iris : .secondary)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        .foregroundStyle(message.isOutgoing ? Color.white : Color.primary)
        .background {
            if message.isOutgoing {
                LuxoraTheme.brandGradient
            } else {
                Rectangle().fill(.regularMaterial)
            }
        }
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: 18,
                bottomLeadingRadius: message.isOutgoing ? 18 : 5,
                bottomTrailingRadius: message.isOutgoing ? 5 : 18,
                topTrailingRadius: 18,
                style: .continuous
            )
        )
        .shadow(color: LuxoraTheme.deepViolet.opacity(message.isOutgoing ? 0.16 : 0.05), radius: 12, y: 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.author.displayName): \(message.text)")
    }

    private var reactionStrip: some View {
        HStack(spacing: 4) {
            ForEach(message.reactions) { reaction in
                Button {
                    onReaction(reaction.emoji)
                } label: {
                    HStack(spacing: 3) {
                        Text(reaction.emoji)
                        Text("\(reaction.count)")
                            .monospacedDigit()
                    }
                    .font(.caption)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(
                        reaction.isMine ? LuxoraTheme.accent.opacity(0.18) : Color.secondary.opacity(0.1),
                        in: Capsule()
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}
