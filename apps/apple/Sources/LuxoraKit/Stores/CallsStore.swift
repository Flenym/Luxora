import Foundation
import Observation

/// Call control for one signed-in session. Owns the calls the user is
/// currently in or being rung for, and drives them through the REST API.
///
/// Realtime keeps the state fresh: a `call.state.changed` event is only a
/// trigger, the full call is re-read over REST. Media (LiveKit join) is not
/// part of this store yet; it reports `mediaState` so the UI never claims
/// audio that is not connected.
@MainActor
@Observable
final class CallsStore {
    enum MediaState: Equatable, Sendable {
        case idle
        case joining
        case connected
        case unavailable
    }

    private(set) var activeCall: APICall?
    private(set) var incomingCall: APICall?
    private(set) var mediaState: MediaState = .idle
    private(set) var remoteAudioCount = 0
    private(set) var errorMessage: String?

    @ObservationIgnored private let api: LuxoraAPIClient
    @ObservationIgnored private let accountID: UUID
    @ObservationIgnored private let tokenProvider: @Sendable () async throws -> String
    @ObservationIgnored private var media: CallMediaSession?
    @ObservationIgnored private var mediaCallID: UUID?

    init(
        api: LuxoraAPIClient,
        accountID: UUID,
        tokenProvider: @escaping @Sendable () async throws -> String
    ) {
        self.api = api
        self.accountID = accountID
        self.tokenProvider = tokenProvider
    }

    /// Joins the LiveKit room for the active call once the server has moved it
    /// to `connecting`/`active`. Only one media session exists at a time, and
    /// it is torn down when the call ends.
    private func syncMedia() async {
        guard let call = activeCall, Self.mediaStates.contains(call.state) else {
            await tearDownMedia()
            return
        }
        guard mediaCallID != call.callId else { return }
        await tearDownMedia()
        mediaCallID = call.callId
        mediaState = .joining
        do {
            let token = try await tokenProvider()
            let grant = try await api.joinGrant(callID: call.callId, requestedSources: ["microphone"], token: token)
            let session = CallMediaSession { [weak self] event in
                self?.handleMedia(event)
            }
            media = session
            try await session.start(serverURL: grant.serverUrl, token: grant.token)
        } catch {
            mediaState = .unavailable
            errorMessage = Self.message(for: error)
            mediaCallID = nil
            media = nil
        }
    }

    private func tearDownMedia() async {
        let session = media
        media = nil
        mediaCallID = nil
        remoteAudioCount = 0
        mediaState = .idle
        await session?.stop()
    }

    private func handleMedia(_ event: CallMediaSession.Event) {
        switch event {
        case .connected:
            mediaState = .connected
        case let .remoteAudioSubscribed(count):
            remoteAudioCount = count
        case let .disconnected(reason):
            remoteAudioCount = 0
            if mediaState != .idle {
                mediaState = reason == nil ? .idle : .unavailable
                errorMessage = reason == nil ? nil : LuxoraL10n.text("error.server_request_failed")
            }
        }
    }

    static let mediaStates: Set<CallStateValue> = [.connecting, .active, .reconnecting]

    /// Starts a call in a chat. The server rings the other participant; this
    /// call becomes `activeCall` in state `created`/`inviting`/`ringing`.
    func startCall(chatID: UUID, mediaMode: String = "audio") async {
        errorMessage = nil
        do {
            let token = try await tokenProvider()
            let created = try await api.createCall(
                chatID: chatID,
                mediaMode: mediaMode,
                clientNonce: UUID(),
                token: token
            )
            let ringing = try await api.ringCall(
                callID: created.callId,
                expectedRevision: created.revision,
                token: token
            )
            activeCall = ringing
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    /// Refreshes one call from the server. Called on realtime triggers and when
    /// the chat opens, so local state never outlives the server's view.
    func refresh(callID: UUID) async {
        do {
            let token = try await tokenProvider()
            let call = try await api.getCall(callID: callID, token: token)
            apply(call)
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func accept() async {
        guard let call = incomingCall else { return }
        await transition(call) { token in
            try await self.api.acceptCall(callID: call.callId, expectedRevision: call.revision, token: token)
        }
    }

    func decline() async {
        guard let call = incomingCall else { return }
        await transition(call) { token in
            try await self.api.declineCall(callID: call.callId, expectedRevision: call.revision, token: token)
        }
    }

    func hangUp() async {
        guard let call = activeCall else { return }
        await transition(call) { token in
            try await self.api.hangupCall(callID: call.callId, expectedRevision: call.revision, token: token)
        }
    }

    /// Applies a server call state. A call the current user is being rung for
    /// (not the creator, still `invited`/`ringing`) becomes the incoming call.
    func apply(_ call: APICall) {
        let mine = call.participants.first { $0.memberId == accountID }
        let isLive = Self.liveStates.contains(call.state)
        // Still ringing me: I am not the creator and my participant is not yet
        // accepted. Once I accept, or the call ends, it stops being incoming.
        let stillRingingMe = mine.map { $0.status == "invited" || $0.status == "ringing" } ?? false
        if isLive, call.creatorMemberId != accountID, stillRingingMe {
            incomingCall = call
        } else if incomingCall?.callId == call.callId {
            incomingCall = nil
        }
        if isLive {
            activeCall = call
        } else if activeCall?.callId == call.callId {
            activeCall = nil
        }
        if mediaEnabled {
            Task { await self.syncMedia() }
        }
    }

    /// Media joins are a side effect the state rules must not depend on, so
    /// tests construct the store with this off and assert the rules directly.
    @ObservationIgnored var mediaEnabled = true

    private func transition(
        _ call: APICall,
        _ action: @escaping @Sendable (String) async throws -> APICall
    ) async {
        errorMessage = nil
        do {
            let token = try await tokenProvider()
            apply(try await action(token))
        } catch {
            errorMessage = Self.message(for: error)
            // A stale revision is expected under races: re-read the call.
            await refresh(callID: call.callId)
        }
    }

    static let liveStates: Set<CallStateValue> = [
        .created, .inviting, .ringing, .connecting, .active, .reconnecting, .ending,
    ]

    private static func message(for error: Error) -> String {
        if let apiError = error as? LuxoraAPIError {
            return apiError.localizedDescription
        }
        return LuxoraL10n.text("error.server_request_failed")
    }
}
