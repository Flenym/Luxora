import Foundation
import Observation

/// Call control for one signed-in session. Owns the calls the user is
/// currently in or being rung for, and drives them through the REST API.
///
/// Realtime keeps the state fresh: a `call.state.changed` event is only a
/// trigger, the full call is re-read over REST. Media (LiveKit join) reports
/// `mediaState` so the UI never claims audio that is not connected.
///
/// History is server truth only: `loadHistory(chatID:)` fetches
/// `GET /v1/calls?chatId=` and nothing is ever synthesized locally. Derived
/// presentation values (direction, missed flag, status, duration) are pure
/// functions in `CallHistoryDerivation` so they are testable without transport.
@MainActor
@Observable
final class CallsStore {
    enum MediaState: Equatable, Sendable {
        case idle
        case joining
        case connected
        case unavailable
    }

    enum HistoryState: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed
    }

    private(set) var activeCall: APICall?
    private(set) var incomingCall: APICall?
    private(set) var mediaState: MediaState = .idle
    private(set) var remoteAudioCount = 0
    private(set) var errorMessage: String?
    /// Mirrors the published microphone state of the current media session.
    /// False until the session actually connected and enabled the microphone.
    private(set) var isMuted = false

    /// Aggregate state of the recent-calls tab.
    private(set) var historyState: HistoryState = .idle
    /// Non-nil when the recent list is failed or partially stale. The rows that
    /// are present are still real server rows.
    private(set) var historyError: String?
    /// Per-chat history, newest server revision only, sorted newest first.
    private(set) var historyByChat: [UUID: [APICall]] = [:]
    private(set) var historyStatesByChat: [UUID: HistoryState] = [:]
    private(set) var historyErrorsByChat: [UUID: String] = [:]

    /// Loading strategy cap: the calls tab discovers history per conversation,
    /// so it only asks for the most recent conversations.
    static let maximumHistoryChats = 20

    @ObservationIgnored private let api: LuxoraAPIClient
    @ObservationIgnored private let accountID: UUID
    @ObservationIgnored private let tokenProvider: @Sendable () async throws -> String
    @ObservationIgnored private var media: CallMediaSession?
    @ObservationIgnored private var mediaCallID: UUID?
    @ObservationIgnored private var historyLoadingChats: Set<UUID> = []

    init(
        api: LuxoraAPIClient,
        accountID: UUID,
        tokenProvider: @escaping @Sendable () async throws -> String
    ) {
        self.api = api
        self.accountID = accountID
        self.tokenProvider = tokenProvider
    }

    /// The call the full-screen in-call UI owns. A call that is still ringing
    /// the current user stays in the accept/decline banner instead, so the
    /// incoming ring is never hidden behind a cover.
    var presentedCall: APICall? {
        guard let call = activeCall else { return nil }
        if let incomingCall, incomingCall.callId == call.callId { return nil }
        return call
    }

    /// A second call cannot be started while one is live; the UI disables the
    /// call-back control instead of letting the store overwrite a live call.
    var canStartCall: Bool {
        activeCall == nil && incomingCall == nil
    }

    /// Speaker routing is not implemented: no verified AVAudioSession route
    /// control exists yet, so the control stays visibly unavailable instead of
    /// pretending to work.
    var speakerControlAvailable: Bool { false }

    /// Honest one-line media status. Only `connected` may claim that audio is
    /// up, and only a subscribed remote track may claim the peer is audible.
    var mediaStatusTitle: String {
        switch mediaState {
        case .idle:
            return "Голос не подключён"
        case .joining:
            return "Подключаем звук…"
        case .connected:
            return remoteAudioCount > 0 ? "Звук подключён" : "Звук подключён, ждём собеседника"
        case .unavailable:
            return "Голос недоступен"
        }
    }

    func clearError() {
        errorMessage = nil
    }

    /// Toggles the published microphone. Never flips the local flag when the
    /// media session is not connected: the UI must show an honest error rather
    /// than a mute state that does not exist.
    func toggleMute() async {
        guard mediaState == .connected, let session = media else {
            errorMessage = "Микрофон доступен только при подключённом звуке."
            return
        }
        let targetMuted = !isMuted
        do {
            try await session.setMicrophone(enabled: !targetMuted)
            isMuted = !session.isMicrophoneEnabled
            errorMessage = nil
        } catch {
            isMuted = !session.isMicrophoneEnabled
            errorMessage = "Не удалось переключить микрофон."
        }
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
            isMuted = !session.isMicrophoneEnabled
        } catch {
            mediaState = .unavailable
            errorMessage = Self.message(for: error)
            mediaCallID = nil
            media = nil
            isMuted = false
        }
    }

    private func tearDownMedia() async {
        let session = media
        media = nil
        mediaCallID = nil
        remoteAudioCount = 0
        mediaState = .idle
        isMuted = false
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
            isMuted = false
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

    // MARK: - History

    /// Fetches one chat's call log from the server. Returns whether the server
    /// answered. A previously loaded truthful snapshot is kept on failure and
    /// exposed as a warning instead of being replaced by an error screen.
    @discardableResult
    func loadHistory(chatID: UUID, force: Bool = false) async -> Bool {
        if !force,
           historyStatesByChat[chatID] == HistoryState.loaded,
           historyByChat[chatID] != nil {
            return true
        }
        guard !historyLoadingChats.contains(chatID) else { return false }
        historyLoadingChats.insert(chatID)
        historyStatesByChat[chatID] = .loading
        historyErrorsByChat[chatID] = nil
        defer { historyLoadingChats.remove(chatID) }

        do {
            let token = try await tokenProvider()
            let calls = try await api.listCalls(chatID: chatID, token: token)
            historyByChat[chatID] = Self.normalizedHistory(calls)
            historyStatesByChat[chatID] = .loaded
            historyErrorsByChat[chatID] = nil
            return true
        } catch {
            let message = Self.message(for: error)
            historyErrorsByChat[chatID] = message
            historyStatesByChat[chatID] = historyByChat[chatID] == nil ? .failed : .loaded
            return false
        }
    }

    /// Loads the recent-calls list for the most recent conversations, capped at
    /// `maximumHistoryChats`. Requests run one at a time so the store stays
    /// conservative about ordering and cancellation.
    func loadRecentHistory(chatIDs: [UUID], force: Bool = false) async {
        let ordered = Array(chatIDs.prefix(Self.maximumHistoryChats))
        guard !ordered.isEmpty else {
            historyState = .loaded
            historyError = nil
            return
        }
        if !force,
           historyState == HistoryState.loaded,
           ordered.allSatisfy({
               historyStatesByChat[$0] == HistoryState.loaded && historyByChat[$0] != nil
           }) {
            return
        }
        historyState = .loading
        historyError = nil

        var loadedCount = 0
        var firstFailure: String?
        for chatID in ordered {
            if Task.isCancelled {
                historyState = historyByChat.isEmpty ? .idle : .loaded
                return
            }
            let loaded = await loadHistory(chatID: chatID, force: force)
            if loaded {
                loadedCount += 1
            } else if firstFailure == nil {
                firstFailure = historyErrorsByChat[chatID]
            }
        }

        let hasAnyRows = ordered.contains { historyByChat[$0] != nil }
        if loadedCount == ordered.count {
            historyState = .loaded
            historyError = nil
        } else if loadedCount > 0 || hasAnyRows {
            historyState = .loaded
            historyError = firstFailure == nil ? nil : "Не удалось обновить часть истории звонков."
        } else {
            historyState = .failed
            historyError = firstFailure
        }
    }

    /// Pull-to-refresh and retry entry point for the tab. Always re-reads the
    /// server instead of trusting a cached list.
    func refreshHistory(chatIDs: [UUID]) async {
        await loadRecentHistory(chatIDs: chatIDs, force: true)
    }

    func calls(for chatID: UUID) -> [APICall] {
        historyByChat[chatID] ?? []
    }

    func historyState(for chatID: UUID) -> HistoryState {
        historyStatesByChat[chatID] ?? .idle
    }

    func historyError(for chatID: UUID) -> String? {
        historyErrorsByChat[chatID]
    }

    /// Merged view of every loaded conversation, deduplicated by callId and
    /// sorted by server `updatedAtMs` descending.
    var recentCalls: [APICall] {
        Self.normalizedHistory(historyByChat.values.flatMap { $0 })
    }

    func direction(of call: APICall) -> CallDirection {
        CallHistoryDerivation.direction(of: call, accountID: accountID)
    }

    func isMissed(_ call: APICall) -> Bool {
        CallHistoryDerivation.isMissed(call, accountID: accountID)
    }

    func status(of call: APICall) -> CallHistoryStatus {
        CallHistoryDerivation.status(of: call, accountID: accountID)
    }

    /// Re-reads a chat's log after one of its calls reached a terminal state.
    /// Only fires when that log is already part of the visible store, so a
    /// background call never causes network traffic the user did not open.
    private func scheduleHistoryRefresh(chatID: UUID) {
        guard historyByChat[chatID] != nil else { return }
        Task { [weak self] in
            await self?.loadHistory(chatID: chatID, force: true)
        }
    }

    static func normalizedHistory(_ calls: [APICall]) -> [APICall] {
        var byCallID: [UUID: APICall] = [:]
        for call in calls {
            if let existing = byCallID[call.callId], existing.revision >= call.revision {
                continue
            }
            byCallID[call.callId] = call
        }
        return byCallID.values.sorted { lhs, rhs in
            if lhs.updatedAtMs != rhs.updatedAtMs { return lhs.updatedAtMs > rhs.updatedAtMs }
            if lhs.createdAtMs != rhs.createdAtMs { return lhs.createdAtMs > rhs.createdAtMs }
            return lhs.callId.uuidString < rhs.callId.uuidString
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
        // Was this call already visible as live in this store? Captured before
        // mutation so a terminal transition can trigger an honest history
        // re-read for the chat.
        let wasLiveHere = activeCall?.callId == call.callId || incomingCall?.callId == call.callId
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
        if wasLiveHere, !isLive {
            scheduleHistoryRefresh(chatID: call.chatId)
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

enum CallDirection: Equatable, Sendable {
    case incoming
    case outgoing
}

/// Presentation status of one call in the current user's log.
enum CallHistoryStatus: Equatable, Sendable {
    case incoming
    case ringing
    case active
    case missed
    case declined
    case cancelled
    case completed

    var title: String {
        switch self {
        case .incoming: return "Входящий"
        case .ringing: return "Звонит"
        case .active: return "Идёт звонок"
        case .missed: return "Пропущенный"
        case .declined: return "Отклонён"
        case .cancelled: return "Отменён"
        case .completed: return "Завершён"
        }
    }
}

/// Pure derivations over server call records. Everything here is a function of
/// the projected call response (creator, participants, state, end reason and
/// server timestamps) — no local clock guess is presented as a server fact.
enum CallHistoryDerivation {
    static let missedEndReasons: Set<String> = [
        "no-answer",
        "cancelled",
        "busy",
        "declined",
        "membership-revoked",
        "network-timeout",
        "server-failure",
    ]

    static func participant(in call: APICall, memberID: UUID) -> APICallParticipant? {
        call.participants.first { $0.memberId == memberID }
    }

    /// Outgoing iff the current member created the call; the server projects
    /// `creatorMemberId`, so this is authoritative for 1:1 and group calls.
    static func direction(of call: APICall, accountID: UUID) -> CallDirection {
        call.creatorMemberId == accountID ? .outgoing : .incoming
    }

    /// A missed call is an incoming call that ended with an unanswered terminal
    /// reason. A call the user declined or answered is never labeled missed.
    static func isMissed(_ call: APICall, accountID: UUID) -> Bool {
        guard direction(of: call, accountID: accountID) == .incoming,
              call.state == .ended
        else { return false }
        let mine = participant(in: call, memberID: accountID)
        if mine?.status == "declined" { return false }
        if mine?.acceptedAtMs != nil { return false }
        guard let endReason = call.endReason, missedEndReasons.contains(endReason) else {
            return false
        }
        return true
    }

    static func status(of call: APICall, accountID: UUID) -> CallHistoryStatus {
        let mine = participant(in: call, memberID: accountID)
        let direction = direction(of: call, accountID: accountID)
        if isMissed(call, accountID: accountID) { return .missed }
        if mine?.status == "declined" { return .declined }

        switch call.state {
        case .created, .inviting, .ringing:
            return direction == .outgoing ? .ringing : .incoming
        case .connecting, .active, .reconnecting, .ending:
            return .active
        case .ended:
            if mine?.acceptedAtMs != nil { return .completed }
            if call.endReason == "completed" { return .completed }
            if direction == .outgoing {
                if call.endReason == "declined" { return .declined }
                return .cancelled
            }
            return .completed
        }
    }

    /// Earliest server acceptance among participants: the moment the call was
    /// actually answered. Nil while nobody has accepted yet.
    static func answeredAtMs(_ call: APICall) -> Int? {
        call.participants.compactMap(\.acceptedAtMs).min()
    }

    /// Answered duration in seconds. Requires a terminal call with a server
    /// `endedAtMs` and an acceptance timestamp; never derived from a timer.
    static func durationSeconds(of call: APICall) -> Int? {
        guard call.state == .ended, let endedAtMs = call.endedAtMs else { return nil }
        guard let answeredAtMs = answeredAtMs(call), endedAtMs >= answeredAtMs else {
            return nil
        }
        return (endedAtMs - answeredAtMs) / 1_000
    }

    /// Elapsed seconds of a live call for the in-call timer, anchored to the
    /// server acceptance time when available.
    static func elapsedSeconds(of call: APICall, nowMs: Int) -> Int {
        let startMs = answeredAtMs(call) ?? call.updatedAtMs
        return max(0, (nowMs - startMs) / 1_000)
    }

    static func formattedDuration(_ seconds: Int) -> String {
        let clamped = max(0, seconds)
        let hours = clamped / 3_600
        let minutes = (clamped % 3_600) / 60
        let secondsPart = clamped % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secondsPart)
        }
        return String(format: "%d:%02d", minutes, secondsPart)
    }

    /// Relative label for a history row, computed from server `updatedAtMs`.
    /// The calendar and "now" are injected so the result is deterministic in
    /// tests.
    static func dateLabel(updatedAtMs: Int, nowMs: Int, calendar: Calendar) -> String {
        let date = Date(timeIntervalSince1970: Double(updatedAtMs) / 1_000)
        let now = Date(timeIntervalSince1970: Double(nowMs) / 1_000)
        if calendar.isDate(date, inSameDayAs: now) {
            let components = calendar.dateComponents([.hour, .minute], from: date)
            return String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Вчера"
        }
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: date),
            to: calendar.startOfDay(for: now)
        ).day ?? 0
        if days >= 2, days < 7 {
            let weekday = calendar.component(.weekday, from: date)
            let names = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]
            return names[(weekday - 1) % names.count]
        }
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%02d.%02d.%04d",
            components.day ?? 0,
            components.month ?? 0,
            components.year ?? 0
        )
    }

    static func dateLabel(updatedAtMs: Int) -> String {
        dateLabel(
            updatedAtMs: updatedAtMs,
            nowMs: Int(Date().timeIntervalSince1970 * 1_000),
            calendar: .current
        )
    }

    static func callStateTitle(_ state: CallStateValue) -> String {
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

    static func incomingRingLabel(state: CallStateValue) -> String {
        switch state {
        case .created, .inviting: return "Входящий звонок · Вызов…"
        case .ringing: return "Входящий звонок · Звонит…"
        case .connecting: return "Входящий звонок · Подключение…"
        default: return "Входящий звонок"
        }
    }
}
