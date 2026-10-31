#if os(iOS)
import SwiftUI

// MARK: - Calls tab

/// The real recent-calls screen behind the calls tab.
///
/// Rows come from `CallsStore` only, which loads `GET /v1/calls?chatId=` per
/// conversation. There is no synthesized history: when the server has no calls
/// the screen says so. Tapping a row opens the conversation, the trailing
/// control starts an audio call back in that chat.
struct PhoneCallsHistoryView: View {
    @Bindable var store: MessengerStore
    @Bindable var callsStore: CallsStore
    let gate: FeatureGate
    let openConversation: (UUID) -> Void

    private var historyChatIDs: [UUID] {
        store.conversations
            .filter { $0.kind == .direct || $0.kind == .group }
            .sorted { $0.lastActivity > $1.lastActivity }
            .prefix(CallsStore.maximumHistoryChats)
            .map(\.id)
    }

    var body: some View {
        content
            .navigationTitle("Звонки")
            .task(id: historyChatIDs) {
                await callsStore.loadRecentHistory(chatIDs: historyChatIDs)
            }
            .accessibilityIdentifier("calls-screen")
    }

    @ViewBuilder
    private var content: some View {
        let recentCalls = callsStore.recentCalls
        if recentCalls.isEmpty {
            if callsStore.historyState == CallsStore.HistoryState.failed {
                failureState
            } else if callsStore.historyState == CallsStore.HistoryState.idle
                || callsStore.historyState == CallsStore.HistoryState.loading
                || store.conversationListState == RemoteContentState.loading
                || store.conversationListState == RemoteContentState.idle {
                loadingState
            } else if case .failed = store.conversationListState {
                conversationsFailureState
            } else {
                emptyState
            }
        } else {
            callsList(recentCalls)
        }
    }

    private var loadingState: some View {
        List {
            HStack(spacing: 10) {
                ProgressView()
                Text("Загружаем историю звонков…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 6)
        }
        .listStyle(.plain)
        .accessibilityIdentifier("calls-loading")
    }

    private var failureState: some View {
        ContentUnavailableView {
            Label("Не удалось загрузить звонки", systemImage: "wifi.exclamationmark")
        } description: {
            Text(callsStore.historyError ?? "Сервер не вернул историю звонков.")
        } actions: {
            Button("Повторить") {
                Task { await callsStore.refreshHistory(chatIDs: historyChatIDs) }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("calls-retry")
        }
        .accessibilityIdentifier("calls-error")
    }

    private var conversationsFailureState: some View {
        ContentUnavailableView {
            Label("Не удалось загрузить переписки", systemImage: "wifi.exclamationmark")
        } description: {
            Text("История звонков строится по перепискам, а сервер не вернул их список.")
        } actions: {
            Button("Повторить") {
                Task {
                    await store.refreshConversations()
                    await callsStore.refreshHistory(chatIDs: historyChatIDs)
                }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("calls-retry")
        }
        .accessibilityIdentifier("calls-error")
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Звонков пока нет", systemImage: "phone")
        } description: {
            Text("История звонков ваших переписок появится здесь, когда сервер вернёт записи о звонках.")
        }
        .accessibilityIdentifier("calls-empty")
    }

    private func callsList(_ recentCalls: [APICall]) -> some View {
        List {
            if gate.state != FeatureGateState.available {
                Section {
                    Text(gate.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } header: {
                    Text("Предварительный режим")
                }
                .accessibilityIdentifier("calls-preview-notice")
            }
            if let warning = callsStore.historyError, !warning.isEmpty {
                Section {
                    historyWarningRow(warning)
                }
            }
            Section {
                ForEach(recentCalls, id: \.callId) { call in
                    PhoneCallHistoryRow(
                        call: call,
                        conversation: conversation(for: call.chatId),
                        status: callsStore.status(of: call),
                        direction: callsStore.direction(of: call),
                        isMissed: callsStore.isMissed(call),
                        canStartCall: callsStore.canStartCall,
                        rowIdentifier: "call-history-row-\(call.callId.uuidString.lowercased())",
                        open: { openConversation(call.chatId) },
                        callBack: { Task { await callsStore.startCall(chatID: call.chatId) } }
                    )
                    .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                }
            }
        }
        .listStyle(.plain)
        .refreshable {
            await callsStore.refreshHistory(chatIDs: historyChatIDs)
        }
        .accessibilityIdentifier("calls-history-list")
    }

    private func conversation(for chatID: UUID) -> Conversation? {
        store.conversations.first { $0.id == chatID }
    }
}

// MARK: - One history row

struct PhoneCallHistoryRow: View {
    let call: APICall
    let conversation: Conversation?
    let status: CallHistoryStatus
    let direction: CallDirection
    let isMissed: Bool
    let canStartCall: Bool
    let rowIdentifier: String
    let open: () -> Void
    let callBack: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: open) {
                HStack(spacing: 12) {
                    directionIcon
                    avatar
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(conversation?.title ?? "Переписка недоступна")
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            Text(CallHistoryDerivation.dateLabel(updatedAtMs: call.updatedAtMs))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        HStack(spacing: 6) {
                            Text(status.title)
                                .font(.caption)
                                .foregroundStyle(statusColor)
                            if let duration = CallHistoryDerivation.durationSeconds(of: call),
                               status == CallHistoryStatus.completed {
                                Text(CallHistoryDerivation.formattedDuration(duration))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(rowAccessibilityLabel)
            .accessibilityHint("Открывает переписку")

            Button(action: callBack) {
                Image(systemName: "phone.arrow.up.right.fill")
                    .font(.footnote.weight(.semibold))
                    .frame(width: 36, height: 36)
                    .background(Color.green.opacity(0.12), in: Circle())
                    .foregroundStyle(.green)
            }
            .buttonStyle(.plain)
            .disabled(!canStartCall)
            .accessibilityLabel("Позвонить снова")
            .accessibilityValue(canStartCall ? "" : "Недоступно во время другого звонка")
            .accessibilityIdentifier("call-history-callback-\(call.callId.uuidString.lowercased())")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(rowIdentifier)
    }

    private var rowAccessibilityLabel: String {
        let title = conversation?.title ?? "Переписка недоступна"
        let directionTitle = direction == CallDirection.outgoing ? "Исходящий" : "Входящий"
        let duration = CallHistoryDerivation.durationSeconds(of: call)
            .map { ", \(CallHistoryDerivation.formattedDuration($0))" } ?? ""
        return "\(title), \(directionTitle), \(status.title)\(duration), \(CallHistoryDerivation.dateLabel(updatedAtMs: call.updatedAtMs))"
    }

    private var directionIcon: some View {
        Image(systemName: iconSymbol)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(isMissed ? Color.red : (direction == CallDirection.outgoing ? Color.green : Color.blue))
            .frame(width: 20)
            .accessibilityHidden(true)
    }

    private var iconSymbol: String {
        if isMissed { return "phone.down.fill" }
        return direction == CallDirection.outgoing ? "arrow.up.right" : "arrow.down.left"
    }

    @ViewBuilder
    private var avatar: some View {
        if let conversation {
            AvatarView(participant: conversation.avatar, size: 42, showsPresence: false)
        } else {
            Circle()
                .fill(Color.secondary.opacity(0.15))
                .frame(width: 42, height: 42)
                .overlay {
                    Image(systemName: "person.fill")
                        .foregroundStyle(.secondary)
                }
        }
    }

    private var statusColor: Color {
        switch status {
        case .missed: return .red
        case .declined: return .orange
        case .cancelled, .completed: return .secondary
        case .active, .incoming, .ringing: return .green
        }
    }
}

// MARK: - Per-chat history sheet

struct ChatCallHistoryView: View {
    @Bindable var store: MessengerStore
    @Bindable var callsStore: CallsStore
    let conversation: Conversation
    let gate: FeatureGate

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if callsUsable {
                    availableContent
                } else {
                    gatedContent
                }
            }
            .navigationTitle("История звонков")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                }
            }
            .task(id: "\(conversation.id.uuidString)-\(gate.state.rawValue)") {
                guard callsUsable else { return }
                await callsStore.loadHistory(chatID: conversation.id)
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("chat-calls-sheet")
    }

    /// The server advertises calls only when the media plane is configured,
    /// which the feature matrix projects as `.limited` (a preview). That is the
    /// only state in which a real call log may be shown.
    private var callsUsable: Bool {
        gate.state == FeatureGateState.available || gate.state == FeatureGateState.limited
    }

    @ViewBuilder
    private var availableContent: some View {
        let chatCalls = callsStore.calls(for: conversation.id)
        if chatCalls.isEmpty,
           callsStore.historyState(for: conversation.id) == CallsStore.HistoryState.failed {
            chatFailure
        } else if chatCalls.isEmpty,
                  callsStore.historyState(for: conversation.id) == CallsStore.HistoryState.idle
                  || callsStore.historyState(for: conversation.id) == CallsStore.HistoryState.loading {
            ProgressView("Загружаем историю звонков…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("chat-calls-loading")
        } else if chatCalls.isEmpty {
            ContentUnavailableView {
                Label("Звонков пока нет", systemImage: "phone")
            } description: {
                Text("История этой переписки появится здесь после первого звонка.")
            }
            .accessibilityIdentifier("chat-calls-empty")
        } else {
            chatList(chatCalls)
        }
    }

    private var chatFailure: some View {
        ContentUnavailableView {
            Label("Не удалось загрузить историю", systemImage: "wifi.exclamationmark")
        } description: {
            Text(callsStore.historyError(for: conversation.id) ?? "Сервер не вернул историю звонков.")
        } actions: {
            Button("Повторить") {
                Task { await callsStore.loadHistory(chatID: conversation.id, force: true) }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("chat-calls-retry")
        }
        .accessibilityIdentifier("chat-calls-error")
    }

    private func chatList(_ chatCalls: [APICall]) -> some View {
        List {
            if gate.state != FeatureGateState.available {
                Section {
                    Text(gate.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } header: {
                    Text("Предварительный режим")
                }
                .accessibilityIdentifier("chat-calls-preview-notice")
            }
            if let warning = callsStore.historyError(for: conversation.id), !warning.isEmpty {
                Section {
                    historyWarningRow(warning)
                }
            }
            Section {
                ForEach(chatCalls, id: \.callId) { call in
                    PhoneCallHistoryRow(
                        call: call,
                        conversation: conversation,
                        status: callsStore.status(of: call),
                        direction: callsStore.direction(of: call),
                        isMissed: callsStore.isMissed(call),
                        canStartCall: callsStore.canStartCall,
                        rowIdentifier: "call-history-row-\(call.callId.uuidString.lowercased())",
                        open: { dismiss() },
                        callBack: { Task { await callsStore.startCall(chatID: conversation.id) } }
                    )
                    .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                }
            }
        }
        .listStyle(.plain)
        .refreshable {
            await callsStore.loadHistory(chatID: conversation.id, force: true)
        }
        .accessibilityIdentifier("chat-calls-list")
    }

    private var gatedContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(LuxoraTheme.iris)
                Text("История звонков недоступна")
                    .font(.title3.weight(.semibold))
                FeatureGateRow(gate: gate)
                Text("Сервер не подтвердил включение звонков, поэтому Luxora не показывает историю и не создаёт фиктивные записи.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .accessibilityIdentifier("chat-calls-gated")
    }
}

private func historyWarningRow(_ warning: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
        Text(warning)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
    }
    .accessibilityIdentifier("calls-partial-warning")
}

// MARK: - Active call presentation

/// Presents the full-screen in-call experience globally, so an active call is
/// visible from any tab. The cover is data-driven by `CallsStore` and closes
/// when the server ends the call.
struct PhoneActiveCallModifier: ViewModifier {
    @Environment(\.callsStore) private var callsStore
    let store: MessengerStore

    func body(content: Content) -> some View {
        content.fullScreenCover(isPresented: presentation) {
            if let callsStore, let call = callsStore.presentedCall {
                PhoneActiveCallView(
                    callsStore: callsStore,
                    callID: call.callId,
                    conversation: store.conversations.first { $0.id == call.chatId }
                )
                .interactiveDismissDisabled()
            }
        }
    }

    private var presentation: Binding<Bool> {
        // The cover is data-driven: it presents while a call owns the in-call
        // UI and dismisses when the server ends it. There is no local "hide".
        Binding(
            get: { callsStore?.presentedCall != nil },
            set: { _ in }
        )
    }
}

extension View {
    /// Attaches the global in-call presentation. Kept in the calls view file so
    /// the host view only carries one calls-related modifier.
    func phoneActiveCallPresentation(store: MessengerStore) -> some View {
        modifier(PhoneActiveCallModifier(store: store))
    }
}

struct PhoneActiveCallView: View {
    let callsStore: CallsStore
    let callID: UUID
    let conversation: Conversation?

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.04, green: 0.04, blue: 0.09), LuxoraTheme.deepViolet],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            if let call = callsStore.presentedCall, call.callId == callID {
                content(for: call)
            } else {
                ProgressView()
                    .tint(.white)
            }
        }
        .preferredColorScheme(.dark)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("call-overlay")
    }

    private func content(for call: APICall) -> some View {
        VStack(spacing: 14) {
            Spacer(minLength: 24)
            avatarView
            Text(conversation?.title ?? "Звонок")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("call-chat-title")
            Text(CallHistoryDerivation.callStateTitle(call.state))
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.8))
                .accessibilityIdentifier("call-state-title")
            if showsTimer(call.state) {
                timerView(call)
            }
            Text(callsStore.mediaStatusTitle)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.75))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("call-media-status")
            if !callsStore.speakerControlAvailable {
                Text("Управление динамиком недоступно: аудиосессия iOS не настроена.")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.55))
                    .multilineTextAlignment(.center)
            }
            if let error = callsStore.errorMessage {
                errorBanner(error)
            }
            Spacer(minLength: 12)
            controls
            Spacer(minLength: 24)
        }
        .padding(.horizontal, 22)
    }

    @ViewBuilder
    private var avatarView: some View {
        if let conversation {
            AvatarView(participant: conversation.avatar, size: 92, showsPresence: false)
        } else {
            Image(systemName: "phone.fill")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 92, height: 92)
                .background(Color.white.opacity(0.12), in: Circle())
        }
    }

    private var controls: some View {
        HStack(spacing: 26) {
            control(
                symbol: callsStore.isMuted ? "mic.slash.fill" : "mic.fill",
                title: callsStore.isMuted ? "Включить микрофон" : "Выключить микрофон",
                identifier: "call-mute",
                isEnabled: callsStore.mediaState == CallsStore.MediaState.connected,
                action: { Task { await callsStore.toggleMute() } }
            )
            control(
                symbol: "speaker.wave.2.fill",
                title: "Динамик",
                identifier: "call-speaker",
                isEnabled: callsStore.speakerControlAvailable,
                accessibilityValue: "Недоступно",
                action: {}
            )
            control(
                symbol: "phone.down.fill",
                title: "Завершить",
                identifier: "call-hangup",
                isEnabled: true,
                tint: Color.red.opacity(0.85),
                action: { Task { await callsStore.hangUp() } }
            )
        }
    }

    private func control(
        symbol: String,
        title: String,
        identifier: String,
        isEnabled: Bool,
        accessibilityValue: String = "",
        tint: Color = Color.white.opacity(0.16),
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: symbol)
                    .font(.title3.weight(.semibold))
                    .frame(width: 62, height: 62)
                    .background(isEnabled ? tint : Color.white.opacity(0.07), in: Circle())
                Text(title)
                    .font(.caption2)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(isEnabled ? Color.white : Color.white.opacity(0.4))
            .frame(minWidth: 88, minHeight: 92)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityValue(accessibilityValue)
        .accessibilityIdentifier(identifier)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button {
                callsStore.clearError()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.7))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Скрыть сообщение")
        }
        .padding(10)
        .background(Color.orange.opacity(0.16), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityIdentifier("call-error")
    }

    private func showsTimer(_ state: CallStateValue) -> Bool {
        switch state {
        case .connecting, .active, .reconnecting, .ending:
            return true
        case .created, .inviting, .ringing, .ended:
            return false
        }
    }

    private func timerView(_ call: APICall) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(
                CallHistoryDerivation.formattedDuration(
                    CallHistoryDerivation.elapsedSeconds(
                        of: call,
                        nowMs: Int(context.date.timeIntervalSince1970 * 1_000)
                    )
                )
            )
            .font(.system(size: 34, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.white)
            .accessibilityIdentifier("call-timer")
        }
    }
}
#endif
