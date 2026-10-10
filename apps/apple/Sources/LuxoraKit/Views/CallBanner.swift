import SwiftUI

/// Incoming and active call controls shown above a conversation.
///
/// Only renders when the call store has something to show, so a conversation
/// without calls looks exactly as before. Every action goes through the store,
/// which re-reads the call from the server after each transition.
struct CallBanner: View {
    @Bindable var store: CallsStore
    let title: String

    var body: some View {
        if let incoming = store.incomingCall {
            HStack(spacing: 12) {
                Image(systemName: incoming.mediaMode == "video" ? "video.fill" : "phone.fill")
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text("Входящий звонок")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Отклонить", role: .destructive) {
                    Task { await store.decline() }
                }
                .accessibilityIdentifier("call-decline")
                Button("Принять") {
                    Task { await store.accept() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .accessibilityIdentifier("call-accept")
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("call-incoming-banner")
        } else if let active = store.activeCall {
            HStack(spacing: 12) {
                Image(systemName: "waveform")
                    .foregroundStyle(.green)
                    .symbolEffect(.variableColor.iterative, isActive: store.mediaState == .connected)
                VStack(alignment: .leading, spacing: 2) {
                    Text(stateTitle(active.state)).font(.headline)
                    Text(mediaDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Завершить", role: .destructive) {
                    Task { await store.hangUp() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("call-hangup")
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("call-active-banner")
        }
    }

    private var mediaDetail: String {
        switch store.mediaState {
        case .idle: return "Ожидание собеседника"
        case .joining: return "Подключение микрофона…"
        case .connected:
            return store.remoteAudioCount > 0 ? "Голос собеседника слышен" : "Вы в звонке, ждём собеседника"
        case .unavailable: return "Голос недоступен"
        }
    }

    private func stateTitle(_ state: CallStateValue) -> String {
        switch state {
        case .created, .inviting: return "Вызов…"
        case .ringing: return "Звонит"
        case .connecting: return "Подключение…"
        case .active: return "Разговор"
        case .reconnecting: return "Переподключение…"
        case .ending: return "Завершение…"
        case .ended: return "Звонок завершён"
        }
    }
}
