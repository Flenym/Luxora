import Foundation
import LiveKit

/// Voice media for one call, over the LiveKit SDK.
///
/// The server issues a join grant (`serverUrl` + LiveKit token) that allows
/// publishing the microphone only. The token is used once to connect and is
/// never logged or stored by this type.
///
/// One session per call. A session is not reused after `stop()`.
@MainActor
final class CallMediaSession {
    enum Event: Sendable {
        case connected
        case remoteAudioSubscribed(count: Int)
        case disconnected(reason: String?)
    }

    private let room: Room
    private let relay: Relay
    private var remoteAudioTrackCount = 0

    init(onEvent: @escaping @MainActor (Event) -> Void) {
        let relay = Relay(onEvent: onEvent)
        self.relay = relay
        // The delegate is set at construction (the SDK exposes no add/remove
        // API for it). `Relay` forwards SDK callbacks to the main actor.
        room = Room(delegate: relay)
    }

    /// Connects and enables the microphone. Throws if the connection fails or
    /// the microphone cannot be published (permission denied, no input).
    func start(serverURL: String, token: String) async throws {
        try await room.connect(url: serverURL, token: token)
        try await room.localParticipant.setMicrophone(enabled: true)
        relay.emit(.connected)
    }

    /// Leaves the room and releases the microphone and remote audio.
    func stop() async {
        await room.disconnect()
    }

    /// Track-level accounting is done by the relay, so the UI sees the count of
    /// subscribed remote audio tracks, not the SDK's internal list.
    fileprivate func noteRemoteAudio(_ delta: Int) {
        remoteAudioTrackCount = max(0, remoteAudioTrackCount + delta)
        relay.emit(.remoteAudioSubscribed(count: remoteAudioTrackCount))
    }
}

/// Bridges SDK delegate callbacks (called on the SDK's internal thread) to the
/// main actor. It holds no reference back to the session, only the event sink.
private final class Relay: RoomDelegate, @unchecked Sendable {
    private let onEvent: @MainActor (CallMediaSession.Event) -> Void
    private var remoteAudio = 0

    init(onEvent: @escaping @MainActor (CallMediaSession.Event) -> Void) {
        self.onEvent = onEvent
    }

    func emit(_ event: CallMediaSession.Event) {
        Task { @MainActor in self.onEvent(event) }
    }

    func room(_: Room, participant _: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .audio else { return }
        remoteAudio += 1
        emit(.remoteAudioSubscribed(count: remoteAudio))
    }

    func room(_: Room, participant _: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .audio else { return }
        remoteAudio = max(0, remoteAudio - 1)
        emit(.remoteAudioSubscribed(count: remoteAudio))
    }

    func room(_: Room, didDisconnectWithError error: LiveKitError?) {
        remoteAudio = 0
        emit(.disconnected(reason: error.map { String(describing: $0) }))
    }
}
