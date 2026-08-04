import SwiftUI

struct MessageComposer: View {
    @Bindable var store: MessengerStore
    var onAttachment: (() -> Void)?
    @FocusState private var isFocused: Bool

    init(store: MessengerStore, onAttachment: (() -> Void)? = nil) {
        self.store = store
        self.onAttachment = onAttachment
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider().opacity(0.45)

            if store.connectionState != .online {
                Label(connectionHint, systemImage: "wifi.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 7)
                    .accessibilityIdentifier("message-composer-connection-state")
            }

            if #available(iOS 26.0, macOS 26.0, *) {
                GlassEffectContainer(spacing: 12) {
                    composerContent
                }
            } else {
                composerContent
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var composerContent: some View {
        HStack(alignment: .bottom, spacing: 9) {
            if let onAttachment {
                Button(action: onAttachment) {
                    ZStack(alignment: .bottomTrailing) {
                        Image(systemName: "paperclip")
                            .font(.system(size: 18, weight: .semibold))
                            .frame(width: 40, height: 40)
                        Image(systemName: "lock.fill")
                            .font(.system(size: 7, weight: .bold))
                            .padding(3)
                            .background(.thinMaterial, in: Circle())
                            .offset(x: 2, y: 1)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .background(Color.secondary.opacity(0.08), in: Circle())
                .accessibilityLabel(LuxoraL10n.text("conversation.attachment"))
                .accessibilityHint("Открывает честное объяснение статуса медиа")
                .accessibilityIdentifier("message-attachment")
            }

            TextField(LuxoraL10n.text("conversation.message"), text: $store.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .submitLabel(.send)
                .focused($isFocused)
                .onSubmit(store.sendDraft)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .modifier(ComposerFieldSurface())
                .accessibilityIdentifier("message-composer")

            Button {
                if store.canSend {
                    store.sendDraft()
                }
            } label: {
                Image(systemName: MessageComposerTruth.sendSymbol)
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .foregroundStyle(store.canSend ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
            .background {
                Circle().fill(
                    store.canSend
                        ? AnyShapeStyle(LuxoraTheme.brandGradient)
                        : AnyShapeStyle(Color.secondary.opacity(0.12))
                )
            }
            .shadow(
                color: store.canSend ? LuxoraTheme.violet.opacity(0.28) : .clear,
                radius: 12,
                y: 5
            )
            .disabled(!store.canSend)
            .accessibilityLabel(LuxoraL10n.text("conversation.send"))
            .accessibilityHint(
                store.canSend
                    ? "Отправляет текст через подключённый сервер Luxora"
                    : "Введите сообщение при активном подключении к серверу Luxora"
            )
            .accessibilityIdentifier("message-send")
            .keyboardShortcut(.return, modifiers: [.command])
        }
        .frame(maxWidth: 920)
        .frame(maxWidth: .infinity)
    }

    private var connectionHint: String {
        switch store.connectionState {
        case .online:
            "Сообщения отправляются через сервер Luxora"
        case .connecting:
            "Подключаемся к серверу — отправка скоро станет доступна"
        case .offline:
            "Нет подключения — черновик останется в поле ввода"
        case .degraded:
            "Связь прервана — дождитесь повторного подключения"
        }
    }
}

enum MessageComposerTruth {
    /// Voice notes are gated on server media support. The thin harness always
    /// renders text send semantics, including its neutral disabled state.
    static let sendSymbol = "arrow.up"
}

private struct ComposerFieldSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: .rect(cornerRadius: 21))
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 21, style: .continuous))
        }
    }
}
