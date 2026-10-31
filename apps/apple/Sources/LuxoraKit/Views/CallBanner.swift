import SwiftUI

/// Incoming and active call controls shown above a conversation.
///
/// Only renders when the call store has something to show, so a conversation
/// without calls looks exactly as before. Every action goes through the store,
/// which re-reads the call from the server after each transition.
///
/// The ring state label and the media status text are derived from server call
/// state and the published `mediaState`; the banner never implies that audio is
/// connected before it is.
struct CallBanner: View {
    let store: CallsStore
    let title: String

    var body: some View {
        if let incoming = store.incomingCall {
            HStack(spacing: 12) {
                Image(systemName: incoming.mediaMode == "video" ? "video.fill" : "phone.fill")
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(CallHistoryDerivation.incomingRingLabel(state: incoming.state))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("call-incoming-state")
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
                    Text(CallHistoryDerivation.callStateTitle(active.state)).font(.headline)
                    Text(store.mediaStatusTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("call-media-status")
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
}
