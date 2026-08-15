#if DEBUG
import Foundation

/// Explicitly opted-in Simulator automation used for connected UI evidence.
/// This type is absent from Release builds, and callers supply credentials only
/// through the launch-process environment. No credential is stored in source.
public struct DebugLaunchAutomation: Equatable, Sendable {
    public let username: String
    public let password: String
    public let conversationID: UUID?

    public init?(environment: [String: String]) {
        let splitPassword: String?
        if let prefix = environment["LUXORA_DEBUG_PASSWORD_PREFIX"],
           let suffix = environment["LUXORA_DEBUG_PASSWORD_SUFFIX"] {
            splitPassword = prefix + suffix
        } else {
            splitPassword = nil
        }

        guard environment["LUXORA_DEBUG_AUTOMATION"] == "1",
              let username = environment["LUXORA_DEBUG_USERNAME"]?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              username.count >= 3,
              let password = environment["LUXORA_DEBUG_PASSWORD"] ?? splitPassword,
              password.count >= 12
        else { return nil }

        self.username = username
        self.password = password
        conversationID = environment["LUXORA_DEBUG_OPEN_CHAT_ID"].flatMap(UUID.init(uuidString:))
    }
}

enum DebugSynchronizedDraftScenario: Equatable, Sendable {
    case autosaveRateLimitOnce

    init?(environment: [String: String]) {
        guard environment["LUXORA_UI_TEST_DRAFT_SCENARIO"] == "autosave-rate-limit-once" else {
            return nil
        }
        self = .autosaveRateLimitOnce
    }
}

private actor DebugSynchronizedDraftBackend {
    private let primaryConversationID: UUID
    private var states: [UUID: SynchronizedChatDraftState] = [:]
    private var receipts: [UUID: ChatDraftMutationResult] = [:]
    private var didRateLimitPrimaryPut = false
    private var rateLimitedCommand: ChatDraftPutCommand?

    init(primaryConversationID: UUID) {
        self.primaryConversationID = primaryConversationID
    }

    func load(chatID: UUID) async throws -> SynchronizedChatDraftState {
        try await Task.sleep(for: .milliseconds(1_500))
        return states[chatID] ?? SynchronizedChatDraftState(draft: nil, revision: 0)
    }

    func put(
        chatID: UUID,
        command: ChatDraftPutCommand
    ) async throws -> ChatDraftMutationResult {
        let shouldRateLimit = chatID == primaryConversationID && !didRateLimitPrimaryPut
        // Keep the first autosave visibly in flight while XCUIAutomation verifies
        // the real software keyboard. The returned rate-limit still carries the
        // bounded Retry-After value of three seconds.
        try await Task.sleep(for: .milliseconds(shouldRateLimit ? 6_000 : 3_000))

        if shouldRateLimit, !didRateLimitPrimaryPut {
            didRateLimitPrimaryPut = true
            rateLimitedCommand = command
            throw ChatDraftRateLimitError(retryAfterSeconds: 3)
        }
        if let rateLimitedCommand {
            guard command == rateLimitedCommand else {
                throw LuxoraAPIError.server(
                    status: 409,
                    code: "CHAT_DRAFT_DEBUG_COMMAND_CHANGED",
                    message: "The retry must preserve the same logical draft command."
                )
            }
            self.rateLimitedCommand = nil
        }
        if let receipt = receipts[command.clientNonce] {
            return ChatDraftMutationResult(state: receipt.state, replayed: true)
        }

        let current = states[chatID] ?? SynchronizedChatDraftState(draft: nil, revision: 0)
        guard current.revision == command.expectedRevision else {
            throw LuxoraAPIError.server(
                status: 409,
                code: "CHAT_DRAFT_REVISION_CONFLICT",
                message: "The draft revision changed."
            )
        }
        let revision = current.revision + 1
        let state = SynchronizedChatDraftState(
            draft: SynchronizedChatDraft(
                chatID: chatID,
                content: command.content,
                revision: revision,
                updatedAt: Date(timeIntervalSince1970: 1_785_834_060)
            ),
            revision: revision
        )
        let result = ChatDraftMutationResult(state: state, replayed: false)
        states[chatID] = state
        receipts[command.clientNonce] = result
        return result
    }

    func delete(
        chatID: UUID,
        command: ChatDraftDeleteCommand
    ) async throws -> ChatDraftMutationResult {
        try await Task.sleep(for: .milliseconds(3_000))
        if let receipt = receipts[command.clientNonce] {
            return ChatDraftMutationResult(state: receipt.state, replayed: true)
        }

        let current = states[chatID] ?? SynchronizedChatDraftState(draft: nil, revision: 0)
        guard current.revision == command.expectedRevision else {
            throw LuxoraAPIError.server(
                status: 409,
                code: "CHAT_DRAFT_REVISION_CONFLICT",
                message: "The draft revision changed."
            )
        }
        let state = SynchronizedChatDraftState(
            draft: nil,
            revision: current.revision + 1
        )
        let result = ChatDraftMutationResult(state: state, replayed: false)
        states[chatID] = state
        receipts[command.clientNonce] = result
        return result
    }
}

private struct DebugSynchronizedDraftFixture {
    let store: SynchronizedChatDraftStore
    let binding: SynchronizedChatDraftSessionBinding

    @MainActor
    static func make(
        accountID: UUID,
        primaryConversationID: UUID
    ) -> DebugSynchronizedDraftFixture {
        let backend = DebugSynchronizedDraftBackend(
            primaryConversationID: primaryConversationID
        )
        let store = SynchronizedChatDraftStore()
        let binding = store.configureRemote(
            accountID: accountID,
            sessionID: UUID(uuidString: "d7a6b0c1-0ee0-4d9a-8d36-4e3c5a9c1234")!,
            loader: { chatID in
                try await backend.load(chatID: chatID)
            },
            putter: { chatID, command in
                try await backend.put(chatID: chatID, command: command)
            },
            deleter: { chatID, command in
                try await backend.delete(chatID: chatID, command: command)
            }
        )
        return DebugSynchronizedDraftFixture(store: store, binding: binding)
    }
}

/// Deterministic data for exercising the production mobile shell in UI tests
/// and Simulator screenshot review. It is compiled out of Release and does not
/// import or link the separately distributed LuxoraDesignFixtures product.
@MainActor
enum DebugMobileScenario {
    static let primaryConversationID = UUID(
        uuidString: "8f0f19fe-d881-4ddd-8467-37065adf37d8"
    )!

    static func make(
        accessibilityMessageIndex: Int? = nil,
        accessibilityConversationLimit: Int? = nil,
        synchronizedDraftScenario: DebugSynchronizedDraftScenario? = nil
    ) -> (
        store: MessengerStore,
        capabilities: ServerCapabilities,
        synchronizedDraftStore: SynchronizedChatDraftStore?,
        synchronizedDraftBinding: SynchronizedChatDraftSessionBinding?
    ) {
        let me = Participant(
            id: UUID(uuidString: "770ec1e2-2fdc-445c-a145-c83bf86c3b20")!,
            displayName: "Егор Flenym",
            username: "flenym",
            initials: "EF",
            accentHex: "7C48D4",
            isOnline: true,
            status: "Создаёт Luxora Beta-0.1"
        )
        let mira = Participant(
            id: UUID(uuidString: "39e8abf7-08d7-4610-8ea1-248c3cabf27f")!,
            displayName: "Арина Волкова",
            username: "arina",
            initials: "АВ",
            accentHex: "496CE7",
            isOnline: true,
            status: "в сети"
        )
        let studio = Participant(
            id: UUID(uuidString: "d2550b4f-257e-4be5-92d2-1f1d54f5a201")!,
            displayName: "Команда Luxora",
            username: "luxora-studio",
            initials: "LS",
            accentHex: "744BD6",
            isOnline: true,
            status: "12 участников в сети"
        )
        let design = Participant(
            id: UUID(uuidString: "865219b8-0c42-4d77-b7cf-49ad4ab854e4")!,
            displayName: "Дизайн-круг",
            username: "design-circle",
            initials: "DC",
            accentHex: "B45EC8",
            isOnline: false,
            status: "8 участников"
        )
        let family = Participant(
            id: UUID(uuidString: "de6f13ba-ecf2-4325-a1ab-0920f1aadf31")!,
            displayName: "Семья Орловых",
            username: "family",
            initials: "FA",
            accentHex: "D16D82",
            isOnline: true,
            status: "4 участника"
        )
        let saved = Participant(
            id: me.id,
            displayName: "Избранное",
            username: me.username,
            initials: "И",
            accentHex: "5D54D7",
            isOnline: true,
            status: "Личные заметки"
        )

        let lada = Participant(
            id: UUID(uuidString: "e4423581-2a7e-458b-a885-41621390032c")!,
            displayName: "Лада Северова",
            username: "lada-sever",
            initials: "ЛС",
            accentHex: "2F9D8F",
            isOnline: true,
            status: "в сети"
        )
        let kirill = Participant(
            id: UUID(uuidString: "3cb65fe1-3e43-4934-96cf-328b7c2a8a5e")!,
            displayName: "Кирилл Орлов",
            username: "kirill-orlov",
            initials: "КО",
            accentHex: "D27845",
            isOnline: true,
            status: "в сети"
        )
        let sofia = Participant(
            id: UUID(uuidString: "f504919b-3cca-42b8-ab68-30aa1384ac75")!,
            displayName: "София Рей",
            username: "sofia-ray",
            initials: "СР",
            accentHex: "B6538C",
            isOnline: false,
            status: "была недавно"
        )
        let nikita = Participant(
            id: UUID(uuidString: "e660e2a3-e9a7-4c09-8f98-f36e9cff224d")!,
            displayName: "Никита Светлов",
            username: "nikita-light",
            initials: "НС",
            accentHex: "4A7FD1",
            isOnline: false,
            status: "был 5 минут назад"
        )
        let alice = Participant(
            id: UUID(uuidString: "732ac24e-1c2e-4356-8095-b7c5eb816ae0")!,
            displayName: "Алиса Миронова",
            username: "alice-mir",
            initials: "АМ",
            accentHex: "7A5BD8",
            isOnline: false,
            status: "была 12 минут назад"
        )
        let boris = Participant(
            id: UUID(uuidString: "121c8cab-8dcb-4e4e-8ba8-7f1f0d7e2011")!,
            displayName: "Борис Лебедев",
            username: "boris-lebedev",
            initials: "БЛ",
            accentHex: "557CC9",
            isOnline: false,
            status: "был только что"
        )
        let vera = Participant(
            id: UUID(uuidString: "232d9dbc-9edc-4f5f-9cb9-8f2f1e8f3022")!,
            displayName: "Вера Морозова",
            username: "vera-morozova",
            initials: "ВМ",
            accentHex: "4D9A82",
            isOnline: true,
            status: "в сети"
        )
        let daniil = Participant(
            id: UUID(uuidString: "343eacec-afed-4060-adca-9f301f904033")!,
            displayName: "Даниил Ким",
            username: "daniil-kim",
            initials: "ДК",
            accentHex: "CC7848",
            isOnline: false,
            status: "был 2 минуты назад"
        )
        let elena = Participant(
            id: UUID(uuidString: "454fbdfd-b0fe-4171-bedb-a04120a15044")!,
            displayName: "Елена Петрова",
            username: "elena-petrova",
            initials: "ЕП",
            accentHex: "B45D8F",
            isOnline: true,
            status: "в сети"
        )
        let mark = Participant(
            id: UUID(uuidString: "5650ce0e-c10f-4282-cfec-b15231b26055")!,
            displayName: "Марк Ветров",
            username: "mark-vetrov",
            initials: "МВ",
            accentHex: "5B70B4",
            isOnline: false,
            status: "был 9 минут назад"
        )
        let olga = Participant(
            id: UUID(uuidString: "6761df1f-d220-4393-d0fd-c26342c37066")!,
            displayName: "Ольга Соколова",
            username: "olga-sokolova",
            initials: "ОС",
            accentHex: "A75EAA",
            isOnline: false,
            status: "была 14 минут назад"
        )
        let yana = Participant(
            id: UUID(uuidString: "97c4bc5f-38d9-48d4-8f57-2ff1565f2d4a")!,
            displayName: "Яна Чернова",
            username: "yana-chernova",
            initials: "ЯЧ",
            accentHex: "9C55C4",
            isOnline: false,
            status: "была 20 минут назад"
        )

        let now = Date(timeIntervalSince1970: 1_785_834_060)
        let studioID = UUID(uuidString: "466bb23c-21c9-464b-b761-04686df7a060")!
        let designID = UUID(uuidString: "9d10f7ba-23b5-408f-b58a-f686bbd28a88")!
        let familyID = UUID(uuidString: "3533885a-431a-42c8-b8aa-51e9b5583ff3")!
        let savedID = UUID(uuidString: "1a7c9a6a-4dca-46ca-b417-7dc2f8f85e60")!
        let quietID = UUID(uuidString: "62499623-29d3-453c-a788-94d402f295c7")!
        let ladaID = UUID(uuidString: "98e01928-03cd-478d-9350-596f5614b39e")!
        let kirillID = UUID(uuidString: "c060a150-b63c-4ed2-9749-98569cabcd51")!
        let sofiaID = UUID(uuidString: "42b7ca5a-f632-47f8-b948-e0bef269c7b8")!
        let nikitaID = UUID(uuidString: "540891b0-0af9-48f8-9826-9cb90ecdb676")!
        let aliceID = UUID(uuidString: "72111983-351c-4909-b16d-036642a24fe3")!
        let borisID = UUID(uuidString: "181c8cab-8dcb-4e4e-8ba8-7f1f0d7e2018")!
        let veraID = UUID(uuidString: "292d9dbc-9edc-4f5f-9cb9-8f2f1e8f3029")!
        let daniilID = UUID(uuidString: "3a3eacec-afed-4060-adca-9f301f90403a")!
        let elenaID = UUID(uuidString: "4b4fbdfd-b0fe-4171-bedb-a04120a1504b")!
        let markID = UUID(uuidString: "5c50ce0e-c10f-4282-cfec-b15231b2605c")!
        let olgaID = UUID(uuidString: "6d61df1f-d220-4393-d0fd-c26342c3706d")!
        let yanaID = UUID(uuidString: "b91d4fd0-e45b-47f7-a18c-e59fa6a88a2f")!

        let conversations = [
            Conversation(
                id: primaryConversationID,
                title: mira.displayName,
                subtitle: "Новая навигация стала спокойнее ✦",
                kind: .direct,
                avatar: mira,
                memberCount: 2,
                unreadCount: 2,
                isMuted: false,
                isPinned: true,
                isTyping: true,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-45),
                folder: "personal"
            ),
            Conversation(
                id: studioID,
                title: studio.displayName,
                subtitle: "Лев: API-контракт готов к проверке",
                kind: .group,
                avatar: studio,
                memberCount: 42,
                unreadCount: 7,
                isMuted: false,
                isPinned: true,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-260),
                folder: "work"
            ),
            Conversation(
                id: familyID,
                title: family.displayName,
                subtitle: "Ужин перенесли на восемь 🍲",
                kind: .group,
                avatar: family,
                memberCount: 4,
                unreadCount: 3,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-1_100),
                folder: "personal"
            ),
            Conversation(
                id: designID,
                title: design.displayName,
                subtitle: "Соня обновила библиотеку компонентов",
                kind: .group,
                avatar: design,
                memberCount: 8,
                unreadCount: 0,
                isMuted: true,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-3_700),
                folder: "work"
            ),
            Conversation(
                id: savedID,
                title: "Избранное",
                subtitle: "Чек-лист запуска Beta-0.1",
                kind: .saved,
                avatar: saved,
                memberCount: 1,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-7_600),
                folder: "personal"
            ),
            Conversation(
                id: quietID,
                title: "Заметки продукта",
                subtitle: "Проверка поиска и настроек",
                kind: .channel,
                avatar: studio,
                memberCount: 18,
                unreadCount: 0,
                isMuted: true,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-12_400),
                folder: "work"
            ),
            Conversation(
                id: ladaID,
                title: lada.displayName,
                subtitle: "Встречаемся у северного входа",
                kind: .direct,
                avatar: lada,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-14_100),
                folder: "personal"
            ),
            Conversation(
                id: kirillID,
                title: kirill.displayName,
                subtitle: "Спасибо, всё получил",
                kind: .direct,
                avatar: kirill,
                memberCount: 2,
                unreadCount: 1,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-16_400),
                folder: "personal"
            ),
            Conversation(
                id: sofiaID,
                title: sofia.displayName,
                subtitle: "Посмотрю макет вечером",
                kind: .direct,
                avatar: sofia,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-19_200),
                folder: "work"
            ),
            Conversation(
                id: nikitaID,
                title: nikita.displayName,
                subtitle: "Сборка прошла без ошибок",
                kind: .direct,
                avatar: nikita,
                memberCount: 2,
                unreadCount: 0,
                isMuted: true,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-23_000),
                folder: "work"
            ),
            Conversation(
                id: aliceID,
                title: alice.displayName,
                subtitle: "До связи завтра",
                kind: .direct,
                avatar: alice,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-28_000),
                folder: "personal"
            ),
            Conversation(
                id: borisID,
                title: boris.displayName,
                subtitle: "Отправлю детали вечером",
                kind: .direct,
                avatar: boris,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-29_000),
                folder: "personal"
            ),
            Conversation(
                id: veraID,
                title: vera.displayName,
                subtitle: "Вижу обновление",
                kind: .direct,
                avatar: vera,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-30_000),
                folder: "work"
            ),
            Conversation(
                id: daniilID,
                title: daniil.displayName,
                subtitle: "Буду через десять минут",
                kind: .direct,
                avatar: daniil,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-31_000),
                folder: "personal"
            ),
            Conversation(
                id: elenaID,
                title: elena.displayName,
                subtitle: "Согласовано, спасибо",
                kind: .direct,
                avatar: elena,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-32_000),
                folder: "work"
            ),
            Conversation(
                id: markID,
                title: mark.displayName,
                subtitle: "Маршрут построен",
                kind: .direct,
                avatar: mark,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-33_000),
                folder: "personal"
            ),
            Conversation(
                id: olgaID,
                title: olga.displayName,
                subtitle: "Файлы уже в проекте",
                kind: .direct,
                avatar: olga,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-33_500),
                folder: "work"
            ),
            Conversation(
                id: yanaID,
                title: yana.displayName,
                subtitle: "Увидимся после обеда",
                kind: .direct,
                avatar: yana,
                memberCount: 2,
                unreadCount: 0,
                isMuted: false,
                isPinned: false,
                isTyping: false,
                isArchived: false,
                lastActivity: now.addingTimeInterval(-34_000),
                folder: "personal"
            ),
        ]

        let messages = [
            ChatMessage(
                id: UUID(uuidString: "a55197a4-3452-493c-b53c-60c20ae0b2cc")!,
                conversationID: primaryConversationID,
                author: mira,
                text: "Я уплотнила список чатов и сохранила спокойную поверхность сообщений.",
                sentAt: now.addingTimeInterval(-1_320),
                delivery: .read,
                isOutgoing: false
            ),
            ChatMessage(
                id: UUID(uuidString: "2ad14568-ed2e-41b3-b4ca-fd012074ff41")!,
                clientID: UUID(uuidString: "8b8897ef-32a6-45c2-9b67-8a1c3d3c95b3")!,
                conversationID: primaryConversationID,
                author: me,
                text: "Отлично. Навигация может быть знакомой, но у Luxora остаётся собственный ритм.",
                sentAt: now.addingTimeInterval(-1_060),
                delivery: .read,
                isOutgoing: true,
                reactions: [MessageReaction(emoji: "💜", count: 2, isMine: true)]
            ),
            ChatMessage(
                id: UUID(uuidString: "67609a0b-ebed-4881-87d5-f109f453c173")!,
                conversationID: primaryConversationID,
                author: mira,
                text: "Именно — плотно, быстро и читаемо. Декор не должен спорить с сообщениями.",
                sentAt: now.addingTimeInterval(-650),
                delivery: .read,
                isOutgoing: false,
                replyPreview: "У Luxora остаётся собственный ритм"
            ),
            ChatMessage(
                id: UUID(uuidString: "fc4e02b2-d1ce-49b1-8025-86db6f66e96f")!,
                clientID: UUID(uuidString: "f7a013e2-38ea-409b-9c93-1fbcfc0e749d")!,
                conversationID: primaryConversationID,
                author: me,
                text: "Звонки и медиа останутся явно закрытыми до готовности серверных контрактов.",
                sentAt: now.addingTimeInterval(-310),
                delivery: .delivered,
                isOutgoing: true
            ),
            ChatMessage(
                id: UUID(uuidString: "8c5f373e-ff2d-44ed-948f-79b5306fe695")!,
                conversationID: primaryConversationID,
                author: mira,
                text: "Новая навигация стала спокойнее ✦",
                sentAt: now.addingTimeInterval(-45),
                delivery: .read,
                isOutgoing: false,
                reactions: [MessageReaction(emoji: "✨", count: 3, isMine: false)]
            ),
        ]

        let projectedMessages: [ChatMessage]
        if let accessibilityMessageIndex,
           messages.indices.contains(accessibilityMessageIndex) {
            projectedMessages = [messages[accessibilityMessageIndex]]
        } else {
            projectedMessages = messages
        }

        let projectedConversations: [Conversation]
        if let accessibilityConversationLimit {
            projectedConversations = Array(
                conversations.prefix(max(1, accessibilityConversationLimit))
            )
        } else {
            projectedConversations = conversations
        }

        let messagesByConversation = [primaryConversationID: projectedMessages]
        let store = MessengerStore(
            conversations: projectedConversations,
            messagesByConversation: messagesByConversation,
            currentUser: me,
            selectedConversationID: primaryConversationID,
            loadedConversationIDs: Set(projectedConversations.map(\.id))
        )
        store.configureRemote(
            sender: { conversationID, clientID, text in
                ChatMessage(
                    id: clientID,
                    clientID: clientID,
                    conversationID: conversationID,
                    author: me,
                    text: text,
                    sentAt: now,
                    delivery: .sent,
                    isOutgoing: true
                )
            },
            loader: { conversationID in
                messagesByConversation[conversationID, default: []]
            }
        )
        store.connectionState = .online
        store.preferredAppearance = "dark"

        let synchronizedDraftFixture = synchronizedDraftScenario.map { _ in
            DebugSynchronizedDraftFixture.make(
                accountID: me.id,
                primaryConversationID: primaryConversationID
            )
        }

        let capabilities = ServerCapabilities(
            trust: .init(
                profile: "cloud_preview",
                contentReadableByServer: true,
                endToEndEncryption: false
            ),
            features: .init(
                phoneAuthentication: true,
                passwordAuthentication: true,
                deviceSessions: true,
                messaging: true,
                identityAccess: true,
                safetyReports: true,
                realtime: true,
                reconciliation: true,
                chatFolders: true,
                mediaUploads: true,
                serverSearchConfigured: false,
                calls: false,
                passkeys: false,
                push: false,
                drafts: synchronizedDraftFixture != nil
            ),
            limits: .init(
                maxMessageCodePoints: 10_000,
                maxAttachmentsPerMessage: 10,
                maxAttachmentBytes: 104_857_600,
                maxDraftCodePoints: synchronizedDraftFixture == nil ? nil : 10_000
            ),
            realtimeProtocolVersion: synchronizedDraftFixture == nil ? .legacyV1 : .scopedV2
        )
        return (
            store,
            capabilities,
            synchronizedDraftFixture?.store,
            synchronizedDraftFixture?.binding
        )
    }
}
#endif
