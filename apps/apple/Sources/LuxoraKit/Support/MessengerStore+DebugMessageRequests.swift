#if DEBUG
import Foundation

@MainActor
extension MessengerStore {
    func installDebugMessageRequestFixture() {
        let backend = DebugMessageRequestFixtureBackend(
            failureMode: ProcessInfo.processInfo.environment["LUXORA_UI_TEST_MESSAGE_REQUEST_FAILURE"]
        )
        configureMessageRequestRemote(
            loader: { direction in try await backend.list(direction) },
            exactUserLookup: { username in await backend.lookup(username) },
            creator: { recipientID, body, nonce in
                try await backend.create(recipientID: recipientID, body: body, nonce: nonce)
            },
            accepter: { requestID in try await backend.accept(requestID) },
            dismisser: { requestID in try await backend.dismiss(requestID) },
            privacyLoader: { await backend.loadPrivacy() },
            privacyUpdater: { discoverable, requests in
                try await backend.updatePrivacy(discoverable: discoverable, requests: requests)
            }
        )
    }
}

private actor DebugMessageRequestFixtureBackend {
    private let failureMode: String?
    private var didFailList = false
    private var didFailCreate = false
    private var didFailAccept = false
    private var didFailDismiss = false
    private var didFailPrivacyUpdate = false
    private let incomingSender = Participant(
        id: UUID(uuidString: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")!,
        displayName: "Мария Лебедева",
        username: "maria_lebedeva",
        initials: "МЛ",
        accentHex: "7C48D4",
        isOnline: false,
        status: "Дизайн и иллюстрация"
    )
    private let secondSender = Participant(
        id: UUID(uuidString: "ffffffff-ffff-4fff-8fff-ffffffffffff")!,
        displayName: "Илья Морозов",
        username: "ilya_morozov",
        initials: "ИМ",
        accentHex: "373ABF",
        isOnline: false,
        status: "Продуктовая команда"
    )
    private let outgoingRecipient = Participant(
        id: UUID(uuidString: "99999999-9999-4999-8999-999999999999")!,
        displayName: "Алексей Романов",
        username: "alexey_romanov",
        initials: "АР",
        accentHex: "2F1893",
        isOnline: false,
        status: "@alexey_romanov"
    )
    private var incoming: [MessageRequestItem] = []
    private var outgoing: [MessageRequestItem] = []
    private var privacy = PrivacySettingsSnapshot(
        usernameDiscoverable: true,
        messageRequests: .everyone
    )

    init(failureMode: String?) {
        self.failureMode = failureMode
        let now = Date()
        incoming = [
            MessageRequestItem(
                id: UUID(uuidString: "12121212-1212-4212-8212-121212121212")!,
                direction: .incoming,
                state: .pending,
                body: "Здравствуйте! Видела ваш проект Luxora и хочу обсудить иллюстрации для запуска.",
                participant: incomingSender,
                createdAt: now.addingTimeInterval(-480),
                expiresAt: now.addingTimeInterval(2_591_520)
            ),
            MessageRequestItem(
                id: UUID(uuidString: "13131313-1313-4313-8313-131313131313")!,
                direction: .incoming,
                state: .pending,
                body: "Добрый вечер. Можно задать вопрос о Beta-0.1?",
                participant: secondSender,
                createdAt: now.addingTimeInterval(-3_600),
                expiresAt: now.addingTimeInterval(2_588_400)
            ),
        ]
        outgoing = [
            MessageRequestItem(
                id: UUID(uuidString: "14141414-1414-4414-8414-141414141414")!,
                direction: .outgoing,
                state: .pending,
                body: "Привет! Хочу пригласить вас обсудить тестирование Luxora.",
                participant: outgoingRecipient,
                createdAt: now.addingTimeInterval(-7_200),
                expiresAt: now.addingTimeInterval(2_584_800)
            ),
        ]
    }

    func list(_ direction: MessageRequestDirection) async throws -> [MessageRequestItem] {
        if failureMode == "loading" {
            try await Task.sleep(for: .seconds(6))
        }
        if failureMode == "list-once", direction == .incoming, !didFailList {
            didFailList = true
            throw DebugMessageRequestError.transient
        }
        if failureMode == "empty" { return [] }
        return direction == .incoming ? incoming : outgoing
    }

    func lookup(_ username: String) -> Participant? {
        let normalized = username.lowercased()
        if normalized == outgoingRecipient.username { return outgoingRecipient }
        if normalized == incomingSender.username { return incomingSender }
        return nil
    }

    func create(recipientID: UUID, body: String, nonce: UUID) throws -> MessageRequestItem {
        if failureMode == "create-once", !didFailCreate {
            didFailCreate = true
            throw DebugMessageRequestError.transient
        }
        guard let participant = [outgoingRecipient, incomingSender, secondSender]
            .first(where: { $0.id == recipientID })
        else { throw DebugMessageRequestError.unavailable }
        if let existing = outgoing.first(where: { $0.id == nonce }) { return existing }
        let request = MessageRequestItem(
            id: nonce,
            direction: .outgoing,
            state: .pending,
            body: body,
            participant: participant,
            createdAt: .now,
            expiresAt: .now.addingTimeInterval(2_592_000)
        )
        outgoing.insert(request, at: 0)
        return request
    }

    func accept(_ requestID: UUID) throws -> MessageRequestAcceptResult {
        if failureMode == "accept-once", !didFailAccept {
            didFailAccept = true
            throw DebugMessageRequestError.transient
        }
        guard let index = incoming.firstIndex(where: { $0.id == requestID }) else {
            throw DebugMessageRequestError.unavailable
        }
        var request = incoming.remove(at: index)
        request.state = .accepted
        let conversation = Conversation(
            id: UUID(uuidString: "15151515-1515-4515-8515-151515151515")!,
            title: request.participant.displayName,
            subtitle: request.body,
            kind: .direct,
            avatar: request.participant,
            memberCount: 2,
            unreadCount: 1,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: .now,
            folder: "personal",
            serverRole: "member"
        )
        let firstMessage = RemoteMessageSnapshot(
            message: ChatMessage(
                id: UUID(uuidString: "16161616-1616-4616-8616-161616161616")!,
                clientID: request.id,
                conversationID: conversation.id,
                author: request.participant,
                text: request.body,
                sentAt: .now,
                delivery: .sent,
                isOutgoing: false
            ),
            metadata: MessageRemoteMetadata(revision: 0)
        )
        return MessageRequestAcceptResult(
            request: request,
            conversation: conversation,
            firstMessage: firstMessage
        )
    }

    func dismiss(_ requestID: UUID) throws {
        if failureMode == "dismiss-once", !didFailDismiss {
            didFailDismiss = true
            throw DebugMessageRequestError.transient
        }
        guard incoming.contains(where: { $0.id == requestID }) else {
            throw DebugMessageRequestError.unavailable
        }
        incoming.removeAll { $0.id == requestID }
    }

    func loadPrivacy() -> PrivacySettingsSnapshot { privacy }

    func updatePrivacy(
        discoverable: Bool?,
        requests: MessageRequestPolicy?
    ) throws -> PrivacySettingsSnapshot {
        if failureMode == "privacy-update-once", !didFailPrivacyUpdate {
            didFailPrivacyUpdate = true
            throw DebugMessageRequestError.transient
        }
        privacy = PrivacySettingsSnapshot(
            usernameDiscoverable: discoverable ?? privacy.usernameDiscoverable,
            messageRequests: requests ?? privacy.messageRequests
        )
        return privacy
    }
}

private enum DebugMessageRequestError: LocalizedError, Sendable {
    case unavailable
    case transient

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "DEBUG-запрос больше недоступен."
        case .transient:
            "Тестовый сервер временно не ответил."
        }
    }
}
#endif
