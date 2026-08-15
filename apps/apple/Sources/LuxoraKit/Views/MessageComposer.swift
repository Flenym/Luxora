import SwiftUI

struct MessageComposer: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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

            if let target = store.composerMode.target {
                composerContext(target)
                    .padding(.bottom, 8)
            }

            if store.connectionState != .online {
                Label(connectionHint, systemImage: "wifi.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 7)
                    .accessibilityIdentifier("message-composer-connection-state")
            }

            if store.synchronizedDraftsEnabled {
                draftSynchronizationStatus
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
        .onChange(of: store.composerMode) { _, mode in
            if mode != .new { isFocused = true }
        }
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
                .frame(minWidth: 44, minHeight: 44)
                .foregroundStyle(.secondary)
                .background(Color.secondary.opacity(0.08), in: Circle())
                .accessibilityLabel(LuxoraL10n.text("conversation.attachment"))
                .accessibilityHint("Открывает честное объяснение статуса медиа")
                .accessibilityIdentifier("message-attachment")
            }

            TextField(composerPlaceholder, text: $store.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 1...4 : 1...6)
                .submitLabel(.send)
                .focused($isFocused)
                .onSubmit(store.sendDraft)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .modifier(ComposerFieldSurface())
                .accessibilityLabel(LuxoraL10n.text("conversation.message"))
                .accessibilityIdentifier("message-composer")

            if isFocused {
                Button {
                    isFocused = false
                } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Скрыть клавиатуру")
                .accessibilityIdentifier("message-composer-keyboard-dismiss")
            }

            Button {
                if store.canSend {
                    store.sendDraft()
                }
            } label: {
                if isEditingMessage {
                    if isEditLoading {
                        ProgressView()
                            .tint(.white)
                            .frame(width: 40, height: 40)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 16, weight: .bold))
                            .frame(width: 40, height: 40)
                    }
                } else {
                    Image(systemName: MessageComposerTruth.sendSymbol)
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 40, height: 40)
                }
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
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
            .accessibilityLabel(sendAccessibilityLabel)
            .accessibilityValue(isEditLoading ? "Выполняется" : "")
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

    @ViewBuilder
    private var draftSynchronizationStatus: some View {
        if store.isSelectedDraftReplyResolving {
            Label("Загружаем сообщение для ответа…", systemImage: "text.bubble")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .padding(.bottom, 7)
                .accessibilityIdentifier("message-draft-reply-resolving")
        } else {
            switch store.selectedDraftSynchronizationState {
        case .loading:
            Label("Синхронизируем черновик…", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .padding(.bottom, 7)
                .accessibilityIdentifier("message-draft-sync-loading")
        case let .failed(message):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if let chatID = store.selectedConversationID {
                    Button("Повторить") {
                        Task { await store.retrySynchronizedDraft(for: chatID) }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(LuxoraTheme.iris)
                    .accessibilityIdentifier("message-draft-sync-retry")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.bottom, 7)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("message-draft-sync-failure")
        case .idle, .loaded:
            EmptyView()
            }
        }
    }

    private func composerContext(_ target: MessageComposerTarget) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(LuxoraTheme.iris)
                .frame(width: 3, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(isEditingMessage ? "Редактирование" : "Ответ для \(target.authorName)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(LuxoraTheme.iris)
                Text(target.preview)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button {
                store.cancelComposerMode()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(.secondary)
            .disabled(isEditLoading)
            .accessibilityLabel("Отменить")
            .accessibilityIdentifier("message-composer-cancel-mode")
        }
        .frame(maxWidth: 920)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message-composer-mode")
    }

    private var isEditingMessage: Bool {
        if case .edit = store.composerMode { return true }
        return false
    }

    private var isEditLoading: Bool {
        guard case let .edit(target) = store.composerMode else { return false }
        return store.messageMutationState(messageID: target.id, kind: .edit) == .loading
    }

    private var sendAccessibilityLabel: String {
        if isEditLoading { return "Сохраняем изменения" }
        if isEditingMessage { return "Сохранить изменения" }
        return LuxoraL10n.text("conversation.send")
    }

    private var composerPlaceholder: String {
        dynamicTypeSize.isAccessibilitySize
            ? "Текст"
            : LuxoraL10n.text("conversation.message")
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
