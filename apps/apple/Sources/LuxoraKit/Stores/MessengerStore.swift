import Foundation
import Observation

public enum RemoteContentState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

@MainActor
@Observable
public final class MessengerStore {
    public private(set) var conversations: [Conversation]
    public private(set) var messagesByConversation: [UUID: [ChatMessage]]
    public var selectedConversationID: UUID?
    public var selectedFolder: ConversationFolder = .all
    public var searchQuery = ""
    public var draft = ""
    public var presentedSheet: AppSheet?
    public var isInspectorPresented = false
    public var isSearchFocused = false
    public var connectionState: ConnectionState = .offline
    public var preferredAppearance = "system"
    public var reduceMotion = false
    public private(set) var conversationListState: RemoteContentState
    public private(set) var messageStates: [UUID: RemoteContentState]
    public private(set) var peopleSearchState: RemoteContentState = .idle
    public private(set) var peopleSearchResults: [Participant] = []
    public private(set) var directConversationCreationState: RemoteContentState = .idle
    public private(set) var lastRemoteActionError: String?

    public let currentUser: Participant
    var remoteMessageSender: (@Sendable (UUID, UUID, String) async throws -> ChatMessage)?
    var remoteMessageLoader: (@Sendable (UUID) async throws -> [ChatMessage])?
    var remoteConversationLoader: (@Sendable () async throws -> [Conversation])?
    var remotePeopleSearcher: (@Sendable (String) async throws -> [Participant])?
    var remoteDirectConversationCreator: (@Sendable (UUID) async throws -> Conversation)?
    var remoteReadMarker: (@Sendable (UUID, UUID) async throws -> Void)?
    var remoteReactionSetter: (@Sendable (UUID, String, Bool) async throws -> [MessageReaction])?
    private var loadedConversationIDs: Set<UUID>
    @ObservationIgnored private var remoteOperations: [UUID: Task<Void, Never>] = [:]

    public init(
        conversations: [Conversation],
        messagesByConversation: [UUID: [ChatMessage]],
        currentUser: Participant,
        selectedConversationID: UUID? = nil,
        loadedConversationIDs: Set<UUID> = []
    ) {
        self.conversations = conversations
        self.messagesByConversation = messagesByConversation
        self.currentUser = currentUser
        self.selectedConversationID = selectedConversationID ?? conversations.first?.id
        self.loadedConversationIDs = loadedConversationIDs
        conversationListState = .loaded
        messageStates = Dictionary(
            uniqueKeysWithValues: loadedConversationIDs.map { ($0, RemoteContentState.loaded) }
        )
    }

    public var filteredConversations: [Conversation] {
        conversations
            .filter { conversation in
                switch selectedFolder {
                case .all: true
                case .unread: conversation.unreadCount > 0
                case .personal: conversation.folder == "personal"
                case .work: conversation.folder == "work"
                case .groups: conversation.kind == .group
                case .channels: conversation.kind == .channel
                case .saved: conversation.kind == .saved
                }
            }
            .filter { conversation in
                searchQuery.isEmpty
                    || conversation.title.localizedCaseInsensitiveContains(searchQuery)
                    || conversation.subtitle.localizedCaseInsensitiveContains(searchQuery)
            }
            .sorted { lhs, rhs in
                if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
                return lhs.lastActivity > rhs.lastActivity
            }
    }

    public var selectedConversation: Conversation? {
        guard let selectedConversationID else { return nil }
        return conversations.first { $0.id == selectedConversationID }
    }

    public var selectedMessages: [ChatMessage] {
        guard let selectedConversationID else { return [] }
        return messagesByConversation[selectedConversationID, default: []]
    }

    public var canSend: Bool {
        connectionState == .online
            && remoteMessageSender != nil
            && selectedConversationID != nil
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func selectConversation(_ id: UUID) {
        selectedConversationID = id
        loadRemoteMessagesIfNeeded(id, markRead: true)
    }

    public func messageState(for conversationID: UUID) -> RemoteContentState {
        messageStates[conversationID] ?? .idle
    }

    public func refreshConversations() async {
        guard let remoteConversationLoader else { return }
        conversationListState = .loading
        lastRemoteActionError = nil
        do {
            let remoteConversations = try await remoteConversationLoader()
            guard !Task.isCancelled else {
                conversationListState = conversations.isEmpty ? .idle : .loaded
                return
            }
            let existing = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
            conversations = remoteConversations.map { remote in
                guard let local = existing[remote.id] else { return remote }
                var merged = remote
                // Pinning, muting, archiving and custom folders are currently
                // device-local preferences; a server refresh must not erase them.
                merged.isPinned = local.isPinned
                merged.isMuted = local.isMuted
                merged.isArchived = local.isArchived
                merged.folder = local.folder
                return merged
            }
            if let selectedConversationID,
               !conversations.contains(where: { $0.id == selectedConversationID }) {
                self.selectedConversationID = conversations.first?.id
            } else if selectedConversationID == nil {
                selectedConversationID = conversations.first?.id
            }
            conversationListState = .loaded
        } catch is CancellationError {
            conversationListState = conversations.isEmpty ? .idle : .loaded
            return
        } catch {
            let message = error.localizedDescription
            conversationListState = .failed(message)
            lastRemoteActionError = message
        }
    }

    public func loadMessages(for conversationID: UUID, force: Bool = false) async {
        guard let remoteMessageLoader else { return }
        let currentState = messageState(for: conversationID)
        if !force, currentState == .loading || currentState == .loaded { return }

        messageStates[conversationID] = .loading
        lastRemoteActionError = nil
        do {
            let messages = try await remoteMessageLoader(conversationID)
            guard !Task.isCancelled else {
                messageStates[conversationID] = loadedConversationIDs.contains(conversationID) ? .loaded : .idle
                return
            }
            messagesByConversation[conversationID] = messages.sorted { $0.sentAt < $1.sentAt }
            loadedConversationIDs.insert(conversationID)
            messageStates[conversationID] = .loaded
        } catch is CancellationError {
            if !loadedConversationIDs.contains(conversationID) {
                messageStates[conversationID] = .idle
            }
        } catch {
            loadedConversationIDs.remove(conversationID)
            let message = error.localizedDescription
            messageStates[conversationID] = .failed(message)
            lastRemoteActionError = message
        }
    }

    public func searchKnownPeople(_ query: String) async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            peopleSearchResults = []
            peopleSearchState = .idle
            return
        }
        guard let remotePeopleSearcher else {
            peopleSearchResults = []
            peopleSearchState = .failed("Поиск пользователей недоступен на этом подключении.")
            return
        }

        peopleSearchState = .loading
        do {
            let results = try await remotePeopleSearcher(normalized)
            guard !Task.isCancelled else { return }
            peopleSearchResults = results.filter { $0.id != currentUser.id }
            peopleSearchState = .loaded
        } catch is CancellationError {
            return
        } catch {
            peopleSearchResults = []
            peopleSearchState = .failed(error.localizedDescription)
        }
    }

    public func createDirectConversation(with userID: UUID) async -> UUID? {
        guard let remoteDirectConversationCreator else {
            directConversationCreationState = .failed("Создание личного чата недоступно на этом подключении.")
            return nil
        }
        guard directConversationCreationState != .loading else { return nil }

        directConversationCreationState = .loading
        lastRemoteActionError = nil
        do {
            let conversation = try await remoteDirectConversationCreator(userID)
            guard !Task.isCancelled else {
                directConversationCreationState = .idle
                return nil
            }
            upsertConversation(conversation)
            selectedConversationID = conversation.id
            directConversationCreationState = .loaded
            await loadMessages(for: conversation.id, force: true)
            return conversation.id
        } catch is CancellationError {
            directConversationCreationState = .idle
            return nil
        } catch {
            let message = error.localizedDescription
            directConversationCreationState = .failed(message)
            lastRemoteActionError = message
            return nil
        }
    }

    public func markConversationRead(_ conversationID: UUID) async {
        guard let remoteReadMarker,
              let index = conversations.firstIndex(where: { $0.id == conversationID }),
              conversations[index].unreadCount > 0,
              let messageID = messagesByConversation[conversationID]?.last?.id
        else { return }
        do {
            try await remoteReadMarker(conversationID, messageID)
            guard !Task.isCancelled else { return }
            if let refreshedIndex = conversations.firstIndex(where: { $0.id == conversationID }) {
                conversations[refreshedIndex].unreadCount = 0
            }
        } catch is CancellationError {
            return
        } catch {
            lastRemoteActionError = error.localizedDescription
        }
    }

    public func sendDraft() {
        guard canSend,
              let conversationID = selectedConversationID,
              let remoteMessageSender
        else { return }
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }

        let clientID = UUID()
        let message = ChatMessage(
            id: clientID,
            clientID: clientID,
            conversationID: conversationID,
            author: currentUser,
            text: body,
            sentAt: .now,
            delivery: .sending,
            isOutgoing: true
        )
        messagesByConversation[conversationID, default: []].append(message)
        draft = ""
        updateConversationPreview(conversationID, text: body)

        startSend(
            conversationID: conversationID,
            clientID: clientID,
            messageID: message.id,
            body: body,
            sender: remoteMessageSender
        )
    }

    public func retryMessage(_ messageID: UUID) {
        guard connectionState == .online,
              let remoteMessageSender,
              let (conversationID, message) = message(withID: messageID),
              message.delivery == .failed
        else { return }
        updateDelivery(message.id, in: conversationID, to: .sending)
        startSend(
            conversationID: conversationID,
            clientID: message.clientID,
            messageID: message.id,
            body: message.text,
            sender: remoteMessageSender
        )
    }

    public func toggleReaction(_ emoji: String, messageID: UUID) {
        guard let conversationID = selectedConversationID,
              let messageIndex = messagesByConversation[conversationID]?.firstIndex(where: { $0.id == messageID })
        else { return }

        let message = messagesByConversation[conversationID]![messageIndex]
        if remoteReactionSetter != nil,
           message.delivery == .sending || message.delivery == .failed {
            return
        }
        let previousReactions = messagesByConversation[conversationID]![messageIndex].reactions
        let willBeActive = !previousReactions.contains(where: { $0.emoji == emoji && $0.isMine })
        applyLocalReaction(emoji, conversationID: conversationID, messageIndex: messageIndex)

        guard let remoteReactionSetter else { return }
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let reactions = try await remoteReactionSetter(message.id, emoji, willBeActive)
                guard let self,
                      let currentIndex = messagesByConversation[conversationID]?.firstIndex(where: { $0.id == message.id })
                else { return }
                messagesByConversation[conversationID]![currentIndex].reactions = reactions
            } catch is CancellationError {
                return
            } catch {
                guard let self,
                      let currentIndex = messagesByConversation[conversationID]?.firstIndex(where: { $0.id == message.id })
                else { return }
                messagesByConversation[conversationID]![currentIndex].reactions = previousReactions
                lastRemoteActionError = error.localizedDescription
            }
        }
        remoteOperations[operationID] = task
    }

    private func applyLocalReaction(_ emoji: String, conversationID: UUID, messageIndex: Int) {
        if let reactionIndex = messagesByConversation[conversationID]?[messageIndex].reactions.firstIndex(where: { $0.emoji == emoji }) {
            var reaction = messagesByConversation[conversationID]![messageIndex].reactions[reactionIndex]
            reaction.count += reaction.isMine ? -1 : 1
            reaction.isMine.toggle()
            if reaction.count <= 0 {
                messagesByConversation[conversationID]![messageIndex].reactions.remove(at: reactionIndex)
            } else {
                messagesByConversation[conversationID]![messageIndex].reactions[reactionIndex] = reaction
            }
        } else {
            messagesByConversation[conversationID]![messageIndex].reactions.append(
                MessageReaction(emoji: emoji, count: 1, isMine: true)
            )
        }
    }

    public func present(_ sheet: AppSheet) {
        presentedSheet = sheet
    }

    public func archiveSelectedConversation() {
        guard let selectedConversationID,
              let index = conversations.firstIndex(where: { $0.id == selectedConversationID })
        else { return }
        conversations[index].isArchived.toggle()
    }

    func configureRemote(
        sender: @escaping @Sendable (UUID, UUID, String) async throws -> ChatMessage,
        loader: @escaping @Sendable (UUID) async throws -> [ChatMessage],
        conversationsLoader: (@Sendable () async throws -> [Conversation])? = nil,
        peopleSearcher: (@Sendable (String) async throws -> [Participant])? = nil,
        directConversationCreator: (@Sendable (UUID) async throws -> Conversation)? = nil,
        readMarker: (@Sendable (UUID, UUID) async throws -> Void)? = nil,
        reactionSetter: (@Sendable (UUID, String, Bool) async throws -> [MessageReaction])? = nil
    ) {
        remoteMessageSender = sender
        remoteMessageLoader = loader
        remoteConversationLoader = conversationsLoader
        remotePeopleSearcher = peopleSearcher
        remoteDirectConversationCreator = directConversationCreator
        remoteReadMarker = readMarker
        remoteReactionSetter = reactionSetter
        if let selectedConversationID {
            loadRemoteMessagesIfNeeded(selectedConversationID, markRead: true)
        }
    }

    func applyRealtimeMessage(_ message: ChatMessage) {
        var messages = messagesByConversation[message.conversationID, default: []]
        if let index = messages.firstIndex(where: { $0.id == message.id || $0.clientID == message.clientID }) {
            messages[index] = message
        } else {
            messages.append(message)
        }
        messages.sort { $0.sentAt < $1.sentAt }
        messagesByConversation[message.conversationID] = messages
        updateConversationPreview(message.conversationID, text: message.text)
        messageStates[message.conversationID] = .loaded
    }

    func cancelRemoteOperations() {
        remoteOperations.values.forEach { $0.cancel() }
        remoteOperations.removeAll()
    }

    func setTyping(_ isTyping: Bool, conversationID: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else { return }
        conversations[index].isTyping = isTyping
    }

    private func updateConversationPreview(_ conversationID: UUID, text: String) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else { return }
        conversations[index].subtitle = text
        conversations[index].lastActivity = .now
    }

    private func updateDelivery(_ messageID: UUID, in conversationID: UUID, to state: MessageDelivery) {
        guard let index = messagesByConversation[conversationID]?.firstIndex(where: { $0.id == messageID }) else { return }
        messagesByConversation[conversationID]![index].delivery = state
    }

    private func replaceOptimisticMessage(_ clientID: UUID, in conversationID: UUID, with message: ChatMessage) {
        guard let index = messagesByConversation[conversationID]?.firstIndex(where: { $0.clientID == clientID }) else {
            applyRealtimeMessage(message)
            return
        }
        messagesByConversation[conversationID]![index] = message
        lastRemoteActionError = nil
    }

    private func loadRemoteMessagesIfNeeded(_ conversationID: UUID, markRead: Bool) {
        guard remoteMessageLoader != nil else { return }
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            guard let self else { return }
            await loadMessages(for: conversationID)
            if markRead { await markConversationRead(conversationID) }
        }
        remoteOperations[operationID] = task
    }

    private func startSend(
        conversationID: UUID,
        clientID: UUID,
        messageID: UUID,
        body: String,
        sender: @escaping @Sendable (UUID, UUID, String) async throws -> ChatMessage
    ) {
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let confirmed = try await sender(conversationID, clientID, body)
                self?.replaceOptimisticMessage(clientID, in: conversationID, with: confirmed)
            } catch is CancellationError {
                return
            } catch {
                self?.updateDelivery(messageID, in: conversationID, to: .failed)
                self?.lastRemoteActionError = error.localizedDescription
            }
        }
        remoteOperations[operationID] = task
    }

    private func message(withID messageID: UUID) -> (UUID, ChatMessage)? {
        for (conversationID, messages) in messagesByConversation {
            if let message = messages.first(where: { $0.id == messageID }) {
                return (conversationID, message)
            }
        }
        return nil
    }

    private func upsertConversation(_ conversation: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index] = conversation
        } else {
            conversations.append(conversation)
        }
    }
}
