import Foundation
import Observation

public enum RemoteContentState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

struct CurrentUserProfileSnapshot: Equatable, Sendable {
    let participant: Participant
    let bio: String
}

private enum CurrentUserProfileError: LocalizedError {
    case unavailable
    case inconsistentResponse

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Серверное редактирование профиля не настроено."
        case .inconsistentResponse:
            "Сервер вернул профиль другой учётной записи."
        }
    }
}

private enum CurrentUserAvatarError: LocalizedError {
    case unavailable
    case invalidImage
    case inconsistentResponse

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Серверное фото профиля не настроено."
        case .invalidImage:
            "Выберите корректное PNG-фото размером не более 8 МБ."
        case .inconsistentResponse:
            "Сервер вернул профиль другой учётной записи."
        }
    }
}

private struct MessengerMembershipFenceKey: Hashable {
    let chatID: UUID
    let userID: UUID
}

private struct MessengerMembershipFence {
    let revision: Int
    let role: String
    let joinedAt: Date
    let updatedAt: Date
    let isRemoved: Bool
    let causalSequence: Int?
}

@MainActor
@Observable
public final class MessengerStore {
    public private(set) var conversations: [Conversation]
    public private(set) var messagesByConversation: [UUID: [ChatMessage]]
    public var selectedConversationID: UUID? {
        didSet {
            guard oldValue != selectedConversationID else { return }
            handleComposerConversationChange(from: oldValue)
        }
    }
    public var selectedFolder: ConversationFolder = .all
    public var searchQuery = ""
    public var draft = "" {
        didSet {
            guard oldValue != draft else { return }
            handleComposerDraftChange()
        }
    }
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
    public private(set) var messageMetadataByID: [UUID: MessageRemoteMetadata] = [:]
    public var composerMode: MessageComposerMode = .new {
        didSet {
            guard oldValue != composerMode else { return }
            handleComposerModeChange()
        }
    }
    public internal(set) var synchronizedDraftStore: SynchronizedChatDraftStore?
    public private(set) var messageMutationStates: [MessageMutationKey: RemoteContentState] = [:]
    public private(set) var messageMutationFailure: MessageMutationFailure?
    public private(set) var profileUpdateState: RemoteContentState = .idle
    public private(set) var avatarUpdateState: RemoteContentState = .idle
    public private(set) var messageRequestsByDirection: [MessageRequestDirection: [MessageRequestItem]] = [
        .incoming: [],
        .outgoing: [],
    ]
    public private(set) var messageRequestListStates: [MessageRequestDirection: RemoteContentState] = [
        .incoming: .idle,
        .outgoing: .idle,
    ]
    public private(set) var messageRequestMutationStates: [UUID: RemoteContentState] = [:]
    public private(set) var messageRequestMutationErrors: [UUID: String] = [:]
    public private(set) var lastAcceptedMessageRequestConversationID: UUID?
    public private(set) var messageRequestLookupState: RemoteContentState = .idle
    public private(set) var messageRequestLookupResult: Participant?
    public private(set) var messageRequestCreationState: RemoteContentState = .idle
    public private(set) var messageRequestCreationError: String?
    public private(set) var privacySettings: PrivacySettingsSnapshot?
    public private(set) var privacySettingsState: RemoteContentState = .idle

    /// Media picked in the composer that will be uploaded on send.
    public private(set) var composerMedia: [PendingMediaAttachment] = []
    public private(set) var isUploadingMedia = false
    public private(set) var mediaUploadProgress: Double = 0
    public private(set) var mediaUploadError: String?
    public var composerTranscriptionConsent = false

    public private(set) var currentUser: Participant
    public private(set) var currentUserBio: String
    var remoteMessageSender: (@Sendable (UUID, UUID, String) async throws -> ChatMessage)?
    var remoteMessageLoader: (@Sendable (UUID) async throws -> [ChatMessage])?
    var remoteConversationLoader: (@Sendable () async throws -> [Conversation])?
    var remotePeopleSearcher: (@Sendable (String) async throws -> [Participant])?
    var remoteDirectConversationCreator: (@Sendable (UUID) async throws -> Conversation)?
    var remoteReadMarker: (@Sendable (UUID, UUID) async throws -> Void)?
    var remoteReactionSetter: (@Sendable (UUID, String, Bool) async throws -> [MessageReaction])?
    var remoteMessageSnapshotSender: (@Sendable (UUID, UUID, String, UUID?) async throws -> RemoteMessageSnapshot)?
    var remoteMediaMessageSender: (@Sendable (UUID, UUID, String, UUID?, [UUID], Bool) async throws -> ChatMessage)?
    var remoteAttachmentUploader: (@Sendable (PendingMediaAttachment) async throws -> MessageAttachment)?
    var remoteTranscriptPutter: (@Sendable (UUID, String) async throws -> ChatMessage)?
    var remoteScheduleMessage: (@Sendable (UUID, String, UUID?, Date) async throws -> ScheduledMessage)?
    var remoteScheduledListLoader: (@Sendable (UUID) async throws -> [ScheduledMessage])?
    var remoteScheduledCanceller: (@Sendable (UUID) async throws -> Void)?
    var remoteMessageSnapshotLoader: (@Sendable (UUID) async throws -> [RemoteMessageSnapshot])?
    var remoteMessageEditor: (@Sendable (UUID, String, Int?) async throws -> RemoteMessageSnapshot)?
    var remoteMessageDeleter: (@Sendable (UUID) async throws -> RemoteMessageSnapshot)?
    var remoteMessageForwarder: (@Sendable (UUID, UUID, UUID) async throws -> RemoteMessageSnapshot)?
    var remoteMessagePinSetter: (@Sendable (UUID, UUID, Bool) async throws -> Bool)?
    var remoteProfileUpdater: (@Sendable (String, String) async throws -> CurrentUserProfileSnapshot)?
    var remoteAvatarUploader: (@Sendable (Data) async throws -> CurrentUserProfileSnapshot)?
    var remoteAvatarClearer: (@Sendable () async throws -> CurrentUserProfileSnapshot)?
    var remoteMessageRequestLoader: (@Sendable (MessageRequestDirection) async throws -> [MessageRequestItem])?
    var remoteExactUserLookup: (@Sendable (String) async throws -> Participant?)?
    var remoteMessageRequestCreator: (@Sendable (UUID, String, UUID) async throws -> MessageRequestItem)?
    var remoteMessageRequestAccepter: (@Sendable (UUID) async throws -> MessageRequestAcceptResult)?
    var remoteMessageRequestDismisser: (@Sendable (UUID) async throws -> Void)?
    var remotePrivacySettingsLoader: (@Sendable () async throws -> PrivacySettingsSnapshot)?
    var remotePrivacySettingsUpdater: (@Sendable (Bool?, MessageRequestPolicy?, PrivacyVisibility?, PrivacyVisibility?, PrivacyVisibility?, PrivacyVisibility?, PrivacyVisibility?) async throws -> PrivacySettingsSnapshot)?
    private var loadedConversationIDs: Set<UUID>
    @ObservationIgnored private var remoteOperations: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var profileUpdateOperation: Task<CurrentUserProfileSnapshot, Error>?
    @ObservationIgnored private var profileUpdateGeneration: UInt = 0
    @ObservationIgnored private var membershipFences: [MessengerMembershipFenceKey: MessengerMembershipFence] = [:]
    @ObservationIgnored private var conversationLifecycleGenerations: [UUID: UInt] = [:]
    @ObservationIgnored private var avatarUpdateOperation: Task<CurrentUserProfileSnapshot, Error>?
    @ObservationIgnored private var avatarUpdateGeneration: UInt = 0
    @ObservationIgnored var draftBeforeEditing = ""
    @ObservationIgnored var composerModeBeforeEditing: MessageComposerMode = .new
    @ObservationIgnored var composerDraftsByConversation: [UUID: String] = [:]
    @ObservationIgnored var composerModesByConversation: [UUID: MessageComposerMode] = [:]
    @ObservationIgnored var unresolvedReplyIDsByConversation: [UUID: UUID] = [:]
    @ObservationIgnored var composerDraftGenerations: [UUID: UInt] = [:]
    @ObservationIgnored var isRestoringComposerState = false
    @ObservationIgnored private var messageMutationRetries: [MessageMutationKey: MessageMutationRetry] = [:]
    @ObservationIgnored private var messageRequestMutationRetries: [UUID: MessageRequestMutationRetry] = [:]
    @ObservationIgnored private var messageRequestCreationRetry: MessageRequestCreationRetry?
    @ObservationIgnored private var privacySettingsRetry: PrivacySettingsRetry?
    @ObservationIgnored private var messageRequestLookupGeneration: UInt = 0
    @ObservationIgnored private var muteExpiryOperation: Task<Void, Never>?

    public init(
        conversations: [Conversation],
        messagesByConversation: [UUID: [ChatMessage]],
        currentUser: Participant,
        currentUserBio: String? = nil,
        selectedConversationID: UUID? = nil,
        loadedConversationIDs: Set<UUID> = []
    ) {
        self.conversations = conversations
        self.messagesByConversation = messagesByConversation
        self.currentUser = currentUser
        self.currentUserBio = currentUserBio
            ?? (currentUser.status == "@\(currentUser.username)" ? "" : currentUser.status)
        self.selectedConversationID = selectedConversationID ?? conversations.first?.id
        self.loadedConversationIDs = loadedConversationIDs
        conversationListState = .loaded
        messageStates = Dictionary(
            uniqueKeysWithValues: loadedConversationIDs.map { ($0, RemoteContentState.loaded) }
        )
        rescheduleMuteExpirations()
    }

    public var filteredConversations: [Conversation] {
        conversations
            .filter(selectedFolder.includes)
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
        guard connectionState == .online,
              let selectedConversationID,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              draft.unicodeScalars.count <= SynchronizedChatDraft.maximumTextCodePoints
        else { return false }
        if unresolvedReplyIDsByConversation[selectedConversationID] != nil {
            if case .edit = composerMode {
                // The unresolved reply belongs to the underlying draft, not to
                // the existing message currently being edited.
            } else {
                return false
            }
        }
        if let conversation = conversations.first(where: { $0.id == selectedConversationID }),
           conversation.kind == .channel,
           !Self.isPrivileged(conversation.serverRole) {
            return false
        }

        switch composerMode {
        case .new:
            return remoteMessageSnapshotSender != nil || remoteMessageSender != nil
        case .reply:
            return remoteMessageSnapshotSender != nil
        case let .edit(target):
            return remoteMessageEditor != nil
                && messageMutationState(messageID: target.id, kind: .edit) != .loading
        }
    }

    public var supportsReplying: Bool { remoteMessageSnapshotSender != nil }
    public var supportsForwarding: Bool { remoteMessageForwarder != nil }
    public var supportsMessagePinning: Bool { remoteMessagePinSetter != nil }
    public var supportsMessageRequests: Bool {
        remoteMessageRequestLoader != nil
            && remoteMessageRequestAccepter != nil
            && remoteMessageRequestDismisser != nil
    }
    public var supportsMessageRequestCreation: Bool {
        remoteExactUserLookup != nil && remoteMessageRequestCreator != nil
    }
    public var supportsPrivacySettings: Bool {
        remotePrivacySettingsLoader != nil && remotePrivacySettingsUpdater != nil
    }
    public var pendingIncomingMessageRequestCount: Int {
        messageRequestsByDirection[.incoming, default: []].filter { $0.state == .pending }.count
    }

    public func messageRequests(_ direction: MessageRequestDirection) -> [MessageRequestItem] {
        messageRequestsByDirection[direction, default: []]
    }

    public func messageRequestListState(_ direction: MessageRequestDirection) -> RemoteContentState {
        messageRequestListStates[direction] ?? .idle
    }

    public func messageRequestMutationState(_ requestID: UUID) -> RemoteContentState {
        messageRequestMutationStates[requestID] ?? .idle
    }

    public func metadata(for messageID: UUID) -> MessageRemoteMetadata {
        messageMetadataByID[messageID] ?? MessageRemoteMetadata()
    }

    public func messageMutationState(messageID: UUID, kind: MessageMutationKind) -> RemoteContentState {
        messageMutationStates[MessageMutationKey(messageID: messageID, kind: kind)] ?? .idle
    }

    public func isMessageMutationInFlight(_ messageID: UUID) -> Bool {
        MessageMutationKind.allCases.contains {
            messageMutationState(messageID: messageID, kind: $0) == .loading
        }
    }

    public func pinnedMessages(for conversationID: UUID) -> [ChatMessage] {
        messagesByConversation[conversationID, default: []].filter {
            messageMetadataByID[$0.id]?.isPinned == true
                && messageMetadataByID[$0.id]?.isDeleted != true
        }
    }

    public func canReply(to message: ChatMessage) -> Bool {
        supportsReplying && isStable(message) && !metadata(for: message.id).isDeleted
    }

    public func canEdit(_ message: ChatMessage) -> Bool {
        remoteMessageEditor != nil
            && message.isOutgoing
            && isStable(message)
            && !metadata(for: message.id).isDeleted
    }

    public func canDelete(_ message: ChatMessage) -> Bool {
        let role = conversations.first(where: { $0.id == message.conversationID })?.serverRole
        return remoteMessageDeleter != nil
            && (message.isOutgoing || Self.isPrivileged(role))
            && isStable(message)
            && !metadata(for: message.id).isDeleted
    }

    public func canForward(_ message: ChatMessage) -> Bool {
        supportsForwarding && isStable(message) && !metadata(for: message.id).isDeleted
    }

    public func canPin(_ message: ChatMessage, in conversation: Conversation) -> Bool {
        supportsMessagePinning
            && (
                conversation.kind == .direct
                    || conversation.kind == .saved
                    || Self.isPrivileged(conversation.serverRole)
            )
            && isStable(message)
            && !metadata(for: message.id).isDeleted
    }

    public func canForward(to conversation: Conversation) -> Bool {
        conversation.kind != .channel || Self.isPrivileged(conversation.serverRole)
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
            let previouslyKnownChatIDs = knownComposerProjectionChatIDs()
                .union(conversations.map(\.id))
            let existing = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
            let retainedChatIDs = Set(remoteConversations.map(\.id))
            let removedSelectedChat = selectedConversationID.map {
                !retainedChatIDs.contains($0)
            } ?? false
            conversations = remoteConversations.map { remote in
                guard let local = existing[remote.id] else { return remote }
                var merged = remote
                // Pinning and custom folders remain local. Archive and mute are
                // account-scoped server projections and must converge across
                // this account's devices instead of preserving stale UI state.
                merged.isPinned = local.isPinned
                merged.folder = local.folder
                return merged
            }
            if let selectedConversationID,
               !conversations.contains(where: { $0.id == selectedConversationID }) {
                self.selectedConversationID = conversations.first?.id
            } else if selectedConversationID == nil {
                selectedConversationID = conversations.first?.id
            }
            for removedChatID in previouslyKnownChatIDs.subtracting(retainedChatIDs) {
                fenceConversationLifecycle(removedChatID)
                let removedMessageIDs = Set(messagesByConversation[removedChatID, default: []].map(\.id))
                messagesByConversation[removedChatID] = nil
                messageStates[removedChatID] = nil
                loadedConversationIDs.remove(removedChatID)
                messageMetadataByID = messageMetadataByID.filter {
                    !removedMessageIDs.contains($0.key)
                }
                scrubMessageMutationState(messageIDs: removedMessageIDs)
                removeComposerDraft(for: removedChatID)
            }
            if removedSelectedChat {
                draftBeforeEditing = ""
                composerModeBeforeEditing = .new
            }
            conversationListState = .loaded
            rescheduleMuteExpirations()
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
        guard conversations.contains(where: { $0.id == conversationID }),
              remoteMessageSnapshotLoader != nil || remoteMessageLoader != nil
        else { return }
        let lifecycleGeneration = conversationLifecycleGenerations[conversationID] ?? 0
        let currentState = messageState(for: conversationID)
        if !force, currentState == .loading || currentState == .loaded { return }

        messageStates[conversationID] = .loading
        lastRemoteActionError = nil
        do {
            if let remoteMessageSnapshotLoader {
                let snapshots = try await remoteMessageSnapshotLoader(conversationID)
                guard !Task.isCancelled else {
                    messageStates[conversationID] = loadedConversationIDs.contains(conversationID) ? .loaded : .idle
                    return
                }
                guard ownsConversationLifecycle(
                    conversationID,
                    generation: lifecycleGeneration
                ) else { return }
                applySnapshots(snapshots, to: conversationID)
            } else if let remoteMessageLoader {
                let messages = try await remoteMessageLoader(conversationID)
                guard !Task.isCancelled else {
                    messageStates[conversationID] = loadedConversationIDs.contains(conversationID) ? .loaded : .idle
                    return
                }
                guard ownsConversationLifecycle(
                    conversationID,
                    generation: lifecycleGeneration
                ) else { return }
                messagesByConversation[conversationID] = messages.sorted { $0.sentAt < $1.sentAt }
            }
            guard !Task.isCancelled else {
                messageStates[conversationID] = loadedConversationIDs.contains(conversationID) ? .loaded : .idle
                return
            }
            guard ownsConversationLifecycle(
                conversationID,
                generation: lifecycleGeneration
            ) else { return }
            loadedConversationIDs.insert(conversationID)
            messageStates[conversationID] = .loaded
            applySynchronizedDraftProjection(for: conversationID)
        } catch is CancellationError {
            guard ownsConversationLifecycle(
                conversationID,
                generation: lifecycleGeneration
            ) else { return }
            if !loadedConversationIDs.contains(conversationID) {
                messageStates[conversationID] = .idle
            }
        } catch {
            guard ownsConversationLifecycle(
                conversationID,
                generation: lifecycleGeneration
            ) else { return }
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

    public func loadMessageRequests(
        _ direction: MessageRequestDirection,
        force: Bool = false
    ) async {
        guard let remoteMessageRequestLoader else {
            messageRequestListStates[direction] = .failed(
                "Запросы на переписку недоступны на этом подключении."
            )
            return
        }
        let currentState = messageRequestListState(direction)
        if !force, currentState == .loading || currentState == .loaded { return }

        messageRequestListStates[direction] = .loading
        do {
            let requests = try await remoteMessageRequestLoader(direction)
            guard !Task.isCancelled else {
                messageRequestListStates[direction] = messageRequests(direction).isEmpty ? .idle : .loaded
                return
            }
            guard requests.allSatisfy({ $0.direction == direction }) else {
                throw MessageRequestClientError.inconsistentDirection
            }
            messageRequestsByDirection[direction] = requests
                .sorted { $0.createdAt > $1.createdAt }
            messageRequestListStates[direction] = .loaded
        } catch is CancellationError {
            messageRequestListStates[direction] = messageRequests(direction).isEmpty ? .idle : .loaded
        } catch {
            messageRequestListStates[direction] = .failed(error.localizedDescription)
        }
    }

    public func lookupMessageRequestRecipient(_ username: String) {
        let normalized = username
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
        guard !normalized.isEmpty else {
            messageRequestLookupGeneration &+= 1
            messageRequestLookupResult = nil
            messageRequestLookupState = .idle
            return
        }
        guard let remoteExactUserLookup else {
            messageRequestLookupResult = nil
            messageRequestLookupState = .failed("Точный поиск username недоступен на этом подключении.")
            return
        }

        messageRequestLookupGeneration &+= 1
        let generation = messageRequestLookupGeneration
        messageRequestLookupState = .loading
        messageRequestLookupResult = nil
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let participant = try await remoteExactUserLookup(normalized)
                guard let self,
                      !Task.isCancelled,
                      messageRequestLookupGeneration == generation
                else { return }
                guard participant == nil
                    || participant?.username.caseInsensitiveCompare(normalized) == .orderedSame
                else {
                    throw MessageRequestClientError.inconsistentLookup
                }
                messageRequestLookupResult = participant?.id == currentUser.id ? nil : participant
                messageRequestLookupState = .loaded
            } catch is CancellationError {
                guard let self, messageRequestLookupGeneration == generation else { return }
                messageRequestLookupState = .idle
            } catch {
                guard let self, messageRequestLookupGeneration == generation else { return }
                messageRequestLookupResult = nil
                messageRequestLookupState = .failed(error.localizedDescription)
            }
        }
        remoteOperations[operationID] = task
    }

    public func createMessageRequest(to recipientID: UUID, body: String) {
        let normalizedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard recipientID != currentUser.id,
              !normalizedBody.isEmpty,
              normalizedBody.unicodeScalars.count <= 1_000
        else {
            messageRequestCreationError = "Первое сообщение должно содержать от 1 до 1000 символов."
            messageRequestCreationState = .failed(messageRequestCreationError ?? "Некорректное сообщение.")
            return
        }
        startMessageRequestCreation(
            recipientID: recipientID,
            body: normalizedBody,
            clientNonce: .clientNonceV4()
        )
    }

    public func retryMessageRequestCreation() {
        guard let retry = messageRequestCreationRetry else { return }
        startMessageRequestCreation(
            recipientID: retry.recipientID,
            body: retry.body,
            clientNonce: retry.clientNonce
        )
    }

    public func acceptMessageRequest(_ requestID: UUID) {
        startMessageRequestMutation(requestID: requestID, retry: .accept)
    }

    public func dismissMessageRequest(_ requestID: UUID) {
        startMessageRequestMutation(requestID: requestID, retry: .dismiss)
    }

    public func retryMessageRequestMutation(_ requestID: UUID) {
        guard let retry = messageRequestMutationRetries[requestID] else { return }
        startMessageRequestMutation(requestID: requestID, retry: retry)
    }

    public func consumeAcceptedMessageRequestConversation() -> UUID? {
        defer { lastAcceptedMessageRequestConversationID = nil }
        return lastAcceptedMessageRequestConversationID
    }

    public func loadPrivacySettings(force: Bool = false) async {
        guard let remotePrivacySettingsLoader else {
            privacySettingsState = .failed("Серверные настройки конфиденциальности недоступны.")
            return
        }
        if !force, privacySettingsState == .loading || privacySettingsState == .loaded { return }

        privacySettingsState = .loading
        do {
            let settings = try await remotePrivacySettingsLoader()
            guard !Task.isCancelled else {
                privacySettingsState = privacySettings == nil ? .idle : .loaded
                return
            }
            privacySettings = settings
            privacySettingsState = .loaded
        } catch is CancellationError {
            privacySettingsState = privacySettings == nil ? .idle : .loaded
        } catch {
            privacySettingsState = .failed(error.localizedDescription)
        }
    }

    public func updatePrivacySettings(
        usernameDiscoverable: Bool? = nil,
        messageRequests: MessageRequestPolicy? = nil,
        lastSeen: PrivacyVisibility? = nil,
        profilePhoto: PrivacyVisibility? = nil,
        forwards: PrivacyVisibility? = nil,
        voiceMessages: PrivacyVisibility? = nil,
        calls: PrivacyVisibility? = nil
    ) {
        guard usernameDiscoverable != nil || messageRequests != nil
            || lastSeen != nil || profilePhoto != nil || forwards != nil
            || voiceMessages != nil || calls != nil else { return }
        startPrivacySettingsUpdate(
            usernameDiscoverable: usernameDiscoverable,
            messageRequests: messageRequests,
            lastSeen: lastSeen,
            profilePhoto: profilePhoto,
            forwards: forwards,
            voiceMessages: voiceMessages,
            calls: calls
        )
    }

    public func retryPrivacySettingsUpdate() {
        guard let retry = privacySettingsRetry else { return }
        startPrivacySettingsUpdate(
            usernameDiscoverable: retry.usernameDiscoverable,
            messageRequests: retry.messageRequests,
            lastSeen: retry.lastSeen,
            profilePhoto: retry.profilePhoto,
            forwards: retry.forwards,
            voiceMessages: retry.voiceMessages,
            calls: retry.calls
        )
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
              let conversationID = selectedConversationID
        else { return }
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty || !composerMedia.isEmpty else { return }

        if case let .edit(target) = composerMode, composerMedia.isEmpty {
            startEdit(messageID: target.id, body: body, expectedRevision: target.revision)
            return
        }

        let replyTarget: MessageComposerTarget?
        if case let .reply(target) = composerMode {
            replyTarget = target
        } else {
            replyTarget = nil
        }

        if !composerMedia.isEmpty {
            startMediaSend(
                conversationID: conversationID,
                body: body,
                replyTarget: replyTarget
            )
            return
        }

        let clientID = UUID()
        var message = ChatMessage(
            id: clientID,
            clientID: clientID,
            conversationID: conversationID,
            author: currentUser,
            text: body,
            sentAt: .now,
            delivery: .sending,
            isOutgoing: true
        )
        if let replyTarget {
            message.replyPreview = "\(replyTarget.authorName): \(replyTarget.preview)"
        }
        messagesByConversation[conversationID, default: []].append(message)
        messageMetadataByID[message.id] = MessageRemoteMetadata(replyToMessageID: replyTarget?.id)
        clearComposerAfterSending(chatID: conversationID)
        updateConversationPreview(conversationID, text: body)

        startSend(
            conversationID: conversationID,
            clientID: clientID,
            messageID: message.id,
            body: body,
            replyToMessageID: replyTarget?.id
        )
    }

    public func retryMessage(_ messageID: UUID) {
        guard connectionState == .online,
              let (conversationID, message) = message(withID: messageID),
              message.delivery == .failed,
              remoteMessageSnapshotSender != nil || remoteMessageSender != nil
        else { return }
        updateDelivery(message.id, in: conversationID, to: .sending)
        let metadata = metadata(for: message.id)
        let attachmentIDs = metadata.attachmentIDs
        if !attachmentIDs.isEmpty, let mediaSender = remoteMediaMessageSender {
            startMediaDelivery(
                conversationID: conversationID,
                clientID: message.clientID,
                messageID: message.id,
                body: message.text,
                replyToMessageID: metadata.replyToMessageID,
                attachmentIDs: attachmentIDs,
                transcriptionConsent: metadata.transcriptionConsent,
                mediaSender: mediaSender
            )
            return
        }
        startSend(
            conversationID: conversationID,
            clientID: message.clientID,
            messageID: message.id,
            body: message.text,
            replyToMessageID: metadata.replyToMessageID
        )
    }

    public func beginReply(to message: ChatMessage) {
        guard canReply(to: message) else { return }
        if case .edit = composerMode {
            restoreComposerAfterEditing()
        }
        composerMode = .reply(composerTarget(for: message))
    }

    public func beginEditing(_ message: ChatMessage) {
        guard canEdit(message) else { return }
        if case .edit = composerMode {
            // Preserve the draft that existed before entering the first edit.
        } else {
            draftBeforeEditing = draft
            composerModeBeforeEditing = composerMode
        }
        composerMode = .edit(composerTarget(for: message))
        draft = message.text
    }

    public func cancelComposerMode() {
        if case .edit = composerMode {
            restoreComposerAfterEditing()
            return
        }
        composerMode = .new
    }

    public private(set) var scheduledMessages: [ScheduledMessage] = []
    public private(set) var scheduledError: String?

    /// Schedules the current composer text for later delivery (text-only v1).
    public func scheduleMessage(body: String, sendAt: Date) async -> Bool {
        guard let conversationID = selectedConversationID, let remote = remoteScheduleMessage else { return false }
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, sendAt > Date().addingTimeInterval(60) else {
            scheduledError = "Выберите время минимум на минуту вперёд."
            return false
        }
        do {
            let replyID: UUID?
            if case let .reply(target) = composerMode { replyID = target.id } else { replyID = nil }
            let scheduled = try await remote(conversationID, text, replyID, sendAt)
            scheduledMessages.append(scheduled)
            scheduledMessages.sort { $0.sendAt < $1.sendAt }
            scheduledError = nil
            return true
        } catch {
            scheduledError = error.localizedDescription
            return false
        }
    }

    public func loadScheduledMessages() async {
        guard let conversationID = selectedConversationID, let loader = remoteScheduledListLoader else { return }
        do {
            scheduledMessages = try await loader(conversationID)
            scheduledError = nil
        } catch {
            scheduledError = error.localizedDescription
        }
    }

    public func cancelScheduledMessage(_ id: UUID) async -> Bool {
        guard let remote = remoteScheduledCanceller else { return false }
        do {
            try await remote(id)
            scheduledMessages.removeAll { $0.id == id }
            return true
        } catch {
            scheduledError = error.localizedDescription
            return false
        }
    }

    public func deleteMessage(_ messageID: UUID) {
        guard let (_, message) = message(withID: messageID), canDelete(message) else { return }
        startDelete(messageID: messageID)
    }

    /// Submits a user-provided transcript for a consenting voice message.
    /// The server keeps the first writer; the text is server-readable
    /// (cloud preview, not E2EE) and shown to every chat member.
    public func transcribeMessage(_ messageID: UUID, text: String) async -> Bool {
        guard let remote = remoteTranscriptPutter,
              let (_, message) = message(withID: messageID),
              message.transcriptionAllowed,
              message.transcript == nil
        else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        do {
            let updated = try await remote(messageID, trimmed)
            replaceMessage(messageID, with: updated)
            return true
        } catch {
            lastRemoteActionError = error.localizedDescription
            return false
        }
    }

    public func forwardMessage(_ messageID: UUID, to conversationID: UUID) {
        guard let (_, message) = message(withID: messageID),
              canForward(message),
              let destination = conversations.first(where: { $0.id == conversationID }),
              canForward(to: destination)
        else { return }
        startForward(messageID: messageID, conversationID: conversationID, clientNonce: UUID())
    }

    public func togglePin(_ messageID: UUID, in conversationID: UUID) {
        guard let conversation = conversations.first(where: { $0.id == conversationID }),
              let (_, message) = message(withID: messageID),
              canPin(message, in: conversation)
        else { return }
        startPin(
            messageID: messageID,
            conversationID: conversationID,
            active: !metadata(for: messageID).isPinned
        )
    }

    public func retryLastMessageMutation() {
        guard let failure = messageMutationFailure,
              let retry = messageMutationRetries[failure.key]
        else { return }
        messageMutationFailure = nil
        switch retry {
        case let .edit(body, expectedRevision):
            startEdit(messageID: failure.key.messageID, body: body, expectedRevision: expectedRevision)
        case .delete:
            startDelete(messageID: failure.key.messageID)
        case let .forward(conversationID, clientNonce):
            startForward(
                messageID: failure.key.messageID,
                conversationID: conversationID,
                clientNonce: clientNonce
            )
        case let .pin(conversationID, active):
            startPin(messageID: failure.key.messageID, conversationID: conversationID, active: active)
        }
    }

    public func dismissMessageMutationFailure() {
        guard let failure = messageMutationFailure else { return }
        messageMutationRetries[failure.key] = nil
        messageMutationFailure = nil
    }

    public func toggleReaction(_ emoji: String, messageID: UUID) {
        guard let conversationID = selectedConversationID,
              let messageIndex = messagesByConversation[conversationID]?.firstIndex(where: { $0.id == messageID })
        else { return }

        let message = messagesByConversation[conversationID]![messageIndex]
        guard !metadata(for: message.id).isDeleted else { return }
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

    func applyConfirmedChatPreferences(_ preferences: ChatPreferences, chatID: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == chatID }) else { return }
        conversations[index].isArchived = preferences.isArchived
        conversations[index].isMuted = preferences.isMuted()
        conversations[index].mutedUntil = preferences.mutedUntil
        rescheduleMuteExpirations()
    }

    @discardableResult
    public func updateCurrentUserProfile(displayName: String, bio: String) async -> Bool {
        let normalizedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBio = bio.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(normalizedName.count), normalizedBio.count <= 500 else {
            profileUpdateState = .failed("Имя должно содержать 1–80 символов, описание — не более 500.")
            return false
        }
        guard normalizedName != currentUser.displayName || normalizedBio != currentUserBio else {
            profileUpdateState = .loaded
            return true
        }
        guard let remoteProfileUpdater else {
            profileUpdateState = .failed(CurrentUserProfileError.unavailable.localizedDescription)
            return false
        }
        guard profileUpdateState != .loading, avatarUpdateState != .loading else { return false }

        profileUpdateState = .loading
        let generation = profileUpdateGeneration
        let operation = Task {
            try await remoteProfileUpdater(normalizedName, normalizedBio)
        }
        profileUpdateOperation = operation
        defer {
            if profileUpdateGeneration == generation {
                profileUpdateOperation = nil
            }
        }

        do {
            let snapshot = try await withTaskCancellationHandler {
                try await operation.value
            } onCancel: {
                operation.cancel()
            }
            guard profileUpdateGeneration == generation,
                  !operation.isCancelled,
                  !Task.isCancelled
            else {
                if profileUpdateGeneration == generation {
                    profileUpdateState = .idle
                }
                return false
            }
            guard snapshot.participant.id == currentUser.id,
                  snapshot.participant.username == currentUser.username
            else {
                throw CurrentUserProfileError.inconsistentResponse
            }
            applyCurrentUserProfile(snapshot)
            profileUpdateState = .loaded
            return true
        } catch is CancellationError {
            if profileUpdateGeneration == generation {
                profileUpdateState = .idle
            }
            return false
        } catch {
            guard profileUpdateGeneration == generation else {
                return false
            }
            profileUpdateState = .failed(error.localizedDescription)
            return false
        }
    }

    @discardableResult
    public func updateCurrentUserAvatar(pngData: Data) async -> Bool {
        guard !pngData.isEmpty, pngData.count <= 8 * 1_024 * 1_024 else {
            avatarUpdateState = .failed(CurrentUserAvatarError.invalidImage.localizedDescription)
            return false
        }
        guard let remoteAvatarUploader else {
            avatarUpdateState = .failed(CurrentUserAvatarError.unavailable.localizedDescription)
            return false
        }
        guard avatarUpdateState != .loading, profileUpdateState != .loading else { return false }
        return await performAvatarUpdate {
            try await remoteAvatarUploader(pngData)
        }
    }

    @discardableResult
    public func clearCurrentUserAvatar() async -> Bool {
        guard currentUser.avatarPath != nil else {
            avatarUpdateState = .loaded
            return true
        }
        guard let remoteAvatarClearer else {
            avatarUpdateState = .failed(CurrentUserAvatarError.unavailable.localizedDescription)
            return false
        }
        guard avatarUpdateState != .loading, profileUpdateState != .loading else { return false }
        return await performAvatarUpdate {
            try await remoteAvatarClearer()
        }
    }

    private func performAvatarUpdate(
        operation remoteOperation: @escaping @Sendable () async throws -> CurrentUserProfileSnapshot
    ) async -> Bool {
        avatarUpdateState = .loading
        let generation = avatarUpdateGeneration
        let operation = Task { try await remoteOperation() }
        avatarUpdateOperation = operation
        defer {
            if avatarUpdateGeneration == generation {
                avatarUpdateOperation = nil
            }
        }

        do {
            let snapshot = try await withTaskCancellationHandler {
                try await operation.value
            } onCancel: {
                operation.cancel()
            }
            guard avatarUpdateGeneration == generation,
                  !operation.isCancelled,
                  !Task.isCancelled
            else {
                if avatarUpdateGeneration == generation { avatarUpdateState = .idle }
                return false
            }
            guard snapshot.participant.id == currentUser.id,
                  snapshot.participant.username == currentUser.username
            else { throw CurrentUserAvatarError.inconsistentResponse }
            applyCurrentUserProfile(snapshot)
            avatarUpdateState = .loaded
            return true
        } catch is CancellationError {
            if avatarUpdateGeneration == generation { avatarUpdateState = .idle }
            return false
        } catch {
            guard avatarUpdateGeneration == generation else { return false }
            avatarUpdateState = .failed(error.localizedDescription)
            return false
        }
    }

    func configureRemote(
        sender: @escaping @Sendable (UUID, UUID, String) async throws -> ChatMessage,
        mediaAttachmentUploader: (@Sendable (PendingMediaAttachment) async throws -> MessageAttachment)? = nil,
        mediaMessageSender: (@Sendable (UUID, UUID, String, UUID?, [UUID], Bool) async throws -> ChatMessage)? = nil,
        transcriptPutter: (@Sendable (UUID, String) async throws -> ChatMessage)? = nil,
        scheduleMessage: (@Sendable (UUID, String, UUID?, Date) async throws -> ScheduledMessage)? = nil,
        scheduledListLoader: (@Sendable (UUID) async throws -> [ScheduledMessage])? = nil,
        scheduledCanceller: (@Sendable (UUID) async throws -> Void)? = nil,
        loader: @escaping @Sendable (UUID) async throws -> [ChatMessage],
        conversationsLoader: (@Sendable () async throws -> [Conversation])? = nil,
        peopleSearcher: (@Sendable (String) async throws -> [Participant])? = nil,
        directConversationCreator: (@Sendable (UUID) async throws -> Conversation)? = nil,
        readMarker: (@Sendable (UUID, UUID) async throws -> Void)? = nil,
        reactionSetter: (@Sendable (UUID, String, Bool) async throws -> [MessageReaction])? = nil,
        messageSender: (@Sendable (UUID, UUID, String, UUID?) async throws -> RemoteMessageSnapshot)? = nil,
        messageSnapshotLoader: (@Sendable (UUID) async throws -> [RemoteMessageSnapshot])? = nil,
        messageEditor: (@Sendable (UUID, String, Int?) async throws -> RemoteMessageSnapshot)? = nil,
        messageDeleter: (@Sendable (UUID) async throws -> RemoteMessageSnapshot)? = nil,
        messageForwarder: (@Sendable (UUID, UUID, UUID) async throws -> RemoteMessageSnapshot)? = nil,
        messagePinSetter: (@Sendable (UUID, UUID, Bool) async throws -> Bool)? = nil,
        profileUpdater: (@Sendable (String, String) async throws -> CurrentUserProfileSnapshot)? = nil,
        avatarUploader: (@Sendable (Data) async throws -> CurrentUserProfileSnapshot)? = nil,
        avatarClearer: (@Sendable () async throws -> CurrentUserProfileSnapshot)? = nil,
        messageRequestLoader: (@Sendable (MessageRequestDirection) async throws -> [MessageRequestItem])? = nil,
        exactUserLookup: (@Sendable (String) async throws -> Participant?)? = nil,
        messageRequestCreator: (@Sendable (UUID, String, UUID) async throws -> MessageRequestItem)? = nil,
        messageRequestAccepter: (@Sendable (UUID) async throws -> MessageRequestAcceptResult)? = nil,
        messageRequestDismisser: (@Sendable (UUID) async throws -> Void)? = nil,
        privacySettingsLoader: (@Sendable () async throws -> PrivacySettingsSnapshot)? = nil,
        privacySettingsUpdater: (@Sendable (Bool?, MessageRequestPolicy?) async throws -> PrivacySettingsSnapshot)? = nil
    ) {
        remoteMessageSender = sender
        remoteAttachmentUploader = mediaAttachmentUploader
        remoteMediaMessageSender = mediaMessageSender
        remoteTranscriptPutter = transcriptPutter
        remoteScheduleMessage = scheduleMessage
        remoteScheduledListLoader = scheduledListLoader
        remoteScheduledCanceller = scheduledCanceller
        remoteMessageLoader = loader
        remoteConversationLoader = conversationsLoader
        remotePeopleSearcher = peopleSearcher
        remoteDirectConversationCreator = directConversationCreator
        remoteReadMarker = readMarker
        remoteReactionSetter = reactionSetter
        remoteMessageSnapshotSender = messageSender
        remoteMessageSnapshotLoader = messageSnapshotLoader
        remoteMessageEditor = messageEditor
        remoteMessageDeleter = messageDeleter
        remoteMessageForwarder = messageForwarder
        remoteMessagePinSetter = messagePinSetter
        remoteProfileUpdater = profileUpdater
        remoteAvatarUploader = avatarUploader
        remoteAvatarClearer = avatarClearer
        remoteMessageRequestLoader = messageRequestLoader
        remoteExactUserLookup = exactUserLookup
        remoteMessageRequestCreator = messageRequestCreator
        remoteMessageRequestAccepter = messageRequestAccepter
        remoteMessageRequestDismisser = messageRequestDismisser
        remotePrivacySettingsLoader = privacySettingsLoader
        remotePrivacySettingsUpdater = privacySettingsUpdater
        if let selectedConversationID {
            loadRemoteMessagesIfNeeded(
                selectedConversationID,
                markRead: true,
                force: messageSnapshotLoader != nil
            )
        }
    }

    func configureMessageRequestRemote(
        loader: @escaping @Sendable (MessageRequestDirection) async throws -> [MessageRequestItem],
        exactUserLookup: @escaping @Sendable (String) async throws -> Participant?,
        creator: @escaping @Sendable (UUID, String, UUID) async throws -> MessageRequestItem,
        accepter: @escaping @Sendable (UUID) async throws -> MessageRequestAcceptResult,
        dismisser: @escaping @Sendable (UUID) async throws -> Void,
        privacyLoader: @escaping @Sendable () async throws -> PrivacySettingsSnapshot,
        privacyUpdater: @escaping @Sendable (Bool?, MessageRequestPolicy?) async throws -> PrivacySettingsSnapshot
    ) {
        remoteMessageRequestLoader = loader
        remoteExactUserLookup = exactUserLookup
        remoteMessageRequestCreator = creator
        remoteMessageRequestAccepter = accepter
        remoteMessageRequestDismisser = dismisser
        remotePrivacySettingsLoader = privacyLoader
        remotePrivacySettingsUpdater = privacyUpdater
    }

    func applyRealtimeMessage(_ message: ChatMessage) {
        guard conversations.contains(where: { $0.id == message.conversationID }) else { return }
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
        applySynchronizedDraftProjection(for: message.conversationID)
    }

    func applyRealtimeConversation(_ remote: Conversation) {
        var conversation = remote
        if let existing = conversations.first(where: { $0.id == remote.id }) {
            conversation.isPinned = existing.isPinned
            conversation.folder = existing.folder
        }
        upsertConversation(conversation)
        conversationListState = .loaded
        if selectedConversationID == nil, !conversation.isArchived {
            selectedConversationID = conversation.id
        }
    }

    /// Applies only membership-derived fields. Community member pages do not
    /// carry inbox preview, activity, unread, archive, mute or typing state,
    /// so they must never replace the full conversation projection.
    func applyConfirmedCommunityMetadata(
        chatID: UUID,
        memberCount: Int,
        serverRole: String?
    ) {
        guard let index = conversations.firstIndex(where: { $0.id == chatID }),
              conversations[index].kind == .group || conversations[index].kind == .channel,
              (1...200).contains(memberCount)
        else { return }
        conversations[index].memberCount = memberCount
        conversations[index].serverRole = serverRole
    }

    /// Community detail/member endpoints own identity and membership metadata,
    /// not inbox transport or account preferences. Merging field-by-field keeps
    /// a delayed detail GET from rolling preview, unread, archive, mute, typing
    /// or last-activity state back after a durable event.
    func applyConfirmedCommunityIdentity(_ remote: Conversation) {
        guard remote.kind == .group || remote.kind == .channel,
              (1...200).contains(remote.memberCount),
              remote.serverRole.flatMap(ChatMembershipRole.init(rawValue:)) != nil
        else { return }
        guard let index = conversations.firstIndex(where: { $0.id == remote.id }) else {
            upsertConversation(remote)
            return
        }
        guard conversations[index].kind == .group || conversations[index].kind == .channel else {
            return
        }
        conversations[index].title = remote.title
        conversations[index].kind = remote.kind
        conversations[index].avatar = remote.avatar
        conversations[index].memberCount = remote.memberCount
        conversations[index].serverRole = remote.serverRole
    }

    func applyConfirmedConversationRemoval(_ chatID: UUID) {
        let removedSelectedChat = selectedConversationID == chatID
        fenceConversationLifecycle(chatID)
        let removedMessageIDs = Set(messagesByConversation[chatID, default: []].map(\.id))
        conversations.removeAll { $0.id == chatID }
        messagesByConversation[chatID] = nil
        messageStates[chatID] = nil
        loadedConversationIDs.remove(chatID)
        messageMetadataByID = messageMetadataByID.filter {
            !removedMessageIDs.contains($0.key)
        }
        scrubMessageMutationState(messageIDs: removedMessageIDs)
        if selectedConversationID == chatID {
            selectedConversationID = conversations.first(where: { !$0.isArchived })?.id
                ?? conversations.first?.id
        }
        // The selection didSet stores the old active composer before restoring
        // the replacement chat. Purge after that transition so removed-chat
        // private text cannot be resurrected in the per-chat maps.
        removeComposerDraft(for: chatID)
        if removedSelectedChat {
            draftBeforeEditing = ""
            composerModeBeforeEditing = .new
        }
        rescheduleMuteExpirations()
    }

    func applyRealtimeMessageSnapshot(_ snapshot: RemoteMessageSnapshot) {
        applySnapshot(snapshot)
        applySynchronizedDraftProjection(for: snapshot.message.conversationID)
    }

    /// Produces only server-confirmed rows for the durable cache. Optimistic
    /// `.sending`/`.failed` rows belong exclusively to the stable-nonce outbox
    /// and must never be mistaken for server truth after a restart.
    func durableConfirmedProjection() -> (
        conversations: [Conversation],
        messages: [DurableConversationMessages]
    ) {
        let messages = messagesByConversation.map { conversationID, messages in
            DurableConversationMessages(
                conversationID: conversationID,
                snapshots: messages.compactMap { message in
                    guard message.delivery != .sending, message.delivery != .failed else {
                        return nil
                    }
                    return DurableConfirmedMessageSnapshot(
                        message: message,
                        metadata: metadata(for: message.id)
                    )
                }
            )
        }
        return (conversations, messages)
    }

    /// Rehydrates outbox rows as optimistic messages without starting network
    /// work. ApplicationSession starts one ordered replay after the production
    /// remote closures and session fence are installed.
    func restoreDurablePendingTextOutbox(_ pendingMessages: [DurablePendingTextMessage]) {
        for pending in pendingMessages.sorted(by: { $0.ordinal < $1.ordinal }) {
            guard conversations.contains(where: { $0.id == pending.conversationID }) else {
                continue
            }
            let existing = messagesByConversation[pending.conversationID, default: []]
            guard !existing.contains(where: { $0.clientID == pending.clientNonce }) else {
                continue
            }
            let optimistic = ChatMessage(
                id: pending.clientNonce,
                clientID: pending.clientNonce,
                conversationID: pending.conversationID,
                author: currentUser,
                text: pending.body,
                sentAt: pending.enqueuedAt,
                delivery: .sending,
                isOutgoing: true
            )
            messagesByConversation[pending.conversationID, default: []].append(optimistic)
            messagesByConversation[pending.conversationID]?.sort { $0.sentAt < $1.sentAt }
            messageMetadataByID[optimistic.id] = MessageRemoteMetadata(
                replyToMessageID: pending.replyToMessageID
            )
            resolveReplyPreviews(in: pending.conversationID)
            updateConversationPreview(pending.conversationID, text: pending.body)
        }
    }

    func applyDurableOutboxConfirmation(_ snapshot: DurableConfirmedMessageSnapshot) {
        replaceOptimisticSnapshot(
            snapshot.message.clientID,
            in: snapshot.message.conversationID,
            with: snapshot.remoteSnapshot
        )
    }

    func applyDurableOutboxFailure(clientNonce: UUID, detail: String?) {
        for (conversationID, messages) in messagesByConversation {
            guard let message = messages.first(where: { $0.clientID == clientNonce }) else {
                continue
            }
            updateDelivery(message.id, in: conversationID, to: .failed)
            lastRemoteActionError = detail
            return
        }
    }

    func applyRealtimePin(chatID: UUID, messageID: UUID, active: Bool) {
        guard messagesByConversation[chatID]?.contains(where: { $0.id == messageID }) == true else {
            // The durable event is valid but the page containing its message is
            // not loaded. A forced reload rehydrates the authoritative pin set.
            loadRemoteMessagesIfNeeded(chatID, markRead: false, force: true)
            return
        }
        var metadata = metadata(for: messageID)
        metadata.isPinned = active
        messageMetadataByID[messageID] = metadata
    }

    func applyRealtimeMessageReactions(
        chatID: UUID,
        messageID: UUID,
        reactions: [MessageReaction]
    ) {
        guard let index = messagesByConversation[chatID]?.firstIndex(where: { $0.id == messageID })
        else {
            loadRemoteMessagesIfNeeded(chatID, markRead: false, force: true)
            return
        }
        messagesByConversation[chatID]![index].reactions = reactions.filter { $0.count > 0 }
    }

    func applyRealtimeMessageReceipt(chatID: UUID, messageID: UUID, isRead: Bool) {
        guard let index = messagesByConversation[chatID]?.firstIndex(where: { $0.id == messageID }),
              messagesByConversation[chatID]![index].isOutgoing
        else { return }
        let existing = messagesByConversation[chatID]![index].delivery
        if isRead {
            messagesByConversation[chatID]![index].delivery = .read
        } else if existing != .read {
            messagesByConversation[chatID]![index].delivery = .delivered
        }
    }

    /// Returns true when the event cannot be represented from its payload and
    /// the caller must rebuild from the authoritative v2 snapshot before
    /// committing that event's cursor.
    func applyRealtimeMembership(
        _ event: RealtimeChatMembershipEvent,
        currentUserID: UUID,
        causalSequence: Int? = nil
    ) -> Bool {
        let chatID = event.membership.chatId
        let key = MessengerMembershipFenceKey(
            chatID: chatID,
            userID: event.membership.userId
        )
        let isRemoved = event.change == .removed
        if let fence = membershipFences[key] {
            let isNewLifecycle = event.change == .added
                && fence.isRemoved
                && event.membership.revision > fence.revision
                && event.membership.joinedAt > fence.updatedAt
                && (causalSequence.flatMap { sequence in
                    fence.causalSequence.map { sequence > $0 }
                } ?? true)
            if isNewLifecycle {
                // Continue below and replace the old incarnation fence.
            } else if event.membership.joinedAt != fence.joinedAt {
                // Without a causal lifecycle proof, force the account-scoped
                // reconciliation instead of guessing from revision reset.
                return true
            } else {
            if event.membership.revision < fence.revision {
                return false
            }
            if event.membership.revision == fence.revision {
                let identical = fence.role == event.membership.role
                    && fence.joinedAt == event.membership.joinedAt
                    && fence.updatedAt == event.membership.updatedAt
                    && fence.isRemoved == isRemoved
                guard identical else { return true }
                if let causalSequence,
                   fence.causalSequence.map({ causalSequence > $0 }) ?? true {
                    membershipFences[key] = MessengerMembershipFence(
                        revision: fence.revision,
                        role: fence.role,
                        joinedAt: fence.joinedAt,
                        updatedAt: fence.updatedAt,
                        isRemoved: fence.isRemoved,
                        causalSequence: causalSequence
                    )
                }
                return false
            }
            if fence.isRemoved {
                return true
            }
            if event.change == .added {
                return true
            }
            }
        }
        membershipFences[key] = MessengerMembershipFence(
            revision: event.membership.revision,
            role: event.membership.role,
            joinedAt: event.membership.joinedAt,
            updatedAt: event.membership.updatedAt,
            isRemoved: isRemoved,
            causalSequence: causalSequence
        )
        if event.membership.userId == currentUserID {
            switch event.change {
            case .removed:
                applyConfirmedConversationRemoval(chatID)
                return false
            case .roleUpdated:
                guard let index = conversations.firstIndex(where: { $0.id == chatID }) else {
                    return true
                }
                conversations[index].serverRole = event.membership.role
                return false
            case .added:
                // Membership payloads intentionally omit title/kind/avatar.
                // A newly added account therefore requires the canonical chat
                // page before its cursor can be acknowledged.
                return true
            }
        }

        guard let index = conversations.firstIndex(where: { $0.id == chatID }) else {
            return true
        }
        switch event.change {
        case .added:
            conversations[index].memberCount += 1
        case .removed:
            conversations[index].memberCount = max(0, conversations[index].memberCount - 1)
        case .roleUpdated:
            break
        }
        return false
    }

    func applyRealtimeMessageRequestCreated(_ request: MessageRequestItem) {
        upsertMessageRequest(request)
        messageRequestListStates[request.direction] = .loaded
    }

    func applyRealtimeMessageRequestRemoved(_ requestID: UUID) {
        removeMessageRequest(requestID)
        messageRequestListStates[.incoming] = .loaded
    }

    func applyRealtimeMessageRequestAccepted(_ requestID: UUID, conversation: Conversation) {
        removeMessageRequest(requestID)
        upsertConversation(conversation)
        messageRequestMutationStates[requestID] = .loaded
        messageRequestMutationErrors[requestID] = nil
        messageRequestMutationRetries[requestID] = nil
    }

    func applyRealtimeMessageRequestExpired(_ requestID: UUID) {
        if let index = messageRequestsByDirection[.outgoing]?.firstIndex(where: { $0.id == requestID }) {
            messageRequestsByDirection[.outgoing]![index].state = .expired
        }
        messageRequestsByDirection[.incoming]?.removeAll { $0.id == requestID }
        messageRequestMutationStates[requestID] = .loaded
        messageRequestMutationErrors[requestID] = nil
        messageRequestMutationRetries[requestID] = nil
    }

    func cancelRemoteOperations() {
        remoteOperations.values.forEach { $0.cancel() }
        remoteOperations.removeAll()
        muteExpiryOperation?.cancel()
        muteExpiryOperation = nil
        profileUpdateGeneration &+= 1
        profileUpdateOperation?.cancel()
        profileUpdateOperation = nil
        profileUpdateState = .idle
        avatarUpdateGeneration &+= 1
        avatarUpdateOperation?.cancel()
        avatarUpdateOperation = nil
        avatarUpdateState = .idle
        if case .edit = composerMode {
            restoreComposerAfterEditing(synchronize: false)
        }
        isRestoringComposerState = true
        composerMode = .new
        isRestoringComposerState = false
        messageMutationStates = messageMutationStates.mapValues { state in
            state == .loading ? .idle : state
        }
        messageMutationFailure = nil
        messageMutationRetries.removeAll()
        messageRequestListStates = messageRequestListStates.mapValues { state in
            state == .loading ? .idle : state
        }
        messageRequestMutationStates = messageRequestMutationStates.mapValues { state in
            state == .loading ? .idle : state
        }
        messageRequestMutationErrors.removeAll()
        messageRequestMutationRetries.removeAll()
        messageRequestLookupState = .idle
        messageRequestLookupResult = nil
        messageRequestLookupGeneration &+= 1
        messageRequestCreationState = .idle
        messageRequestCreationError = nil
        messageRequestCreationRetry = nil
        privacySettingsState = privacySettings == nil ? .idle : .loaded
        privacySettingsRetry = nil
        lastAcceptedMessageRequestConversationID = nil
    }

    /// Publishes a fully staged v2 snapshot in one MainActor turn. Network and
    /// decoding work is completed before this method is entered, so a failed
    /// resource page can never expose a half-rebuilt account to SwiftUI.
    func validateReconciliation(
        _ bundle: LuxoraReconciliationBundle,
        currentUserID: UUID
    ) throws {
        guard currentUser.id == currentUserID,
              bundle.currentUser.id == currentUserID,
              Set(bundle.chats.map { $0.chat.id }).count == bundle.chats.count
        else { throw LuxoraAPIError.invalidResponse }

        let incoming = try bundle.incomingRequests.map { try $0.item() }
        let outgoing = try bundle.outgoingRequests.map { try $0.item() }
        guard incoming.allSatisfy({ $0.direction == .incoming }),
              outgoing.allSatisfy({ $0.direction == .outgoing }),
              bundle.chats.allSatisfy({ state in
                  Set(state.members.map { $0.membership.userId }).count == state.members.count
                      && Set(state.messages.map { $0.message.id }).count == state.messages.count
              })
        else { throw LuxoraAPIError.invalidResponse }
    }

    /// Finds stable chat IDs whose current-account membership belongs to a
    /// different lifetime than the locally fenced membership. Role/revision
    /// changes within the same `joinedAt` lifetime intentionally do not count:
    /// local dirty text remains eligible for the normal CAS rebase in that
    /// case. A changed join instant, or a newly present membership after an
    /// observed removal, is a hard privacy boundary.
    func synchronizedDraftLifecycleResetChatIDs(
        in bundle: LuxoraReconciliationBundle,
        currentUserID: UUID
    ) -> Set<UUID> {
        guard currentUser.id == currentUserID else { return [] }
        var resetChatIDs: Set<UUID> = []
        for chatState in bundle.chats {
            guard let membership = chatState.members.first(where: {
                $0.membership.userId == currentUserID
                    && $0.membership.chatId == chatState.chat.id
            })?.membership,
                  let previous = membershipFences[
                      MessengerMembershipFenceKey(
                          chatID: chatState.chat.id,
                          userID: currentUserID
                      )
                  ]
            else { continue }
            if previous.isRemoved || previous.joinedAt != membership.joinedAt {
                resetChatIDs.insert(chatState.chat.id)
            }
        }
        return resetChatIDs
    }

    func applyReconciliation(
        _ bundle: LuxoraReconciliationBundle,
        currentUserID: UUID
    ) throws {
        try validateReconciliation(bundle, currentUserID: currentUserID)

        let incoming = try bundle.incomingRequests.map { try $0.item() }
        let outgoing = try bundle.outgoingRequests.map { try $0.item() }
        guard incoming.allSatisfy({ $0.direction == .incoming }),
              outgoing.allSatisfy({ $0.direction == .outgoing })
        else { throw LuxoraAPIError.invalidResponse }

        let previousConversationIDs = Set(conversations.map(\.id))
            .union(knownComposerProjectionChatIDs())
        let previousMessageIDsByChat = messagesByConversation.mapValues { Set($0.map(\.id)) }
        let activeEditBeforeReconciliation: (
            chatID: UUID,
            target: MessageComposerTarget,
            editBody: String,
            underlyingDraft: String,
            underlyingMode: MessageComposerMode
        )? = {
            guard let selectedConversationID,
                  case let .edit(target) = composerMode
            else { return nil }
            return (
                selectedConversationID,
                target,
                draft,
                draftBeforeEditing,
                composerModeBeforeEditing
            )
        }()
        let removedSelectedChat = selectedConversationID.map { selectedID in
            !bundle.chats.contains(where: { $0.chat.id == selectedID })
        } ?? false
        let existingConversations = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
        var rebuiltConversations: [Conversation] = []
        var rebuiltMessages: [UUID: [ChatMessage]] = [:]
        var rebuiltMetadata: [UUID: MessageRemoteMetadata] = [:]

        for chatState in bundle.chats {
            var conversation = chatState.chat.conversation(currentUserID: currentUserID)
            if let existing = existingConversations[conversation.id] {
                conversation.isPinned = existing.isPinned
                conversation.folder = existing.folder
            }
            rebuiltConversations.append(conversation)

            let pinnedIDs = Set(chatState.pins.map(\.messageId))
            var projectedMessages: [ChatMessage] = []
            for state in chatState.messages {
                var message = state.message.message(currentUserID: currentUserID)
                message.reactions = state.reactions.map(\.reaction)
                if message.isOutgoing {
                    if state.receipts.contains(where: { $0.readAt != nil }) {
                        message.delivery = .read
                    } else if !state.receipts.isEmpty {
                        message.delivery = .delivered
                    }
                }
                projectedMessages.append(message)
                rebuiltMetadata[message.id] = MessageRemoteMetadata(
                    revision: state.message.revision,
                    replyToMessageID: state.message.replyToMessageId,
                    forwardedFrom: state.message.forwardedFrom?.messageProvenance,
                    isPinned: pinnedIDs.contains(message.id),
                    isDeleted: state.message.deletedAt != nil
                )
            }
            rebuiltMessages[conversation.id] = projectedMessages.sorted { $0.sentAt < $1.sentAt }
        }

        cancelRemoteOperations()
        conversations = rebuiltConversations
        messagesByConversation = rebuiltMessages
        messageMetadataByID = rebuiltMetadata
        applyCurrentUserProfile(
            CurrentUserProfileSnapshot(
                participant: bundle.currentUser.participant,
                bio: bundle.currentUser.bio
            )
        )
        loadedConversationIDs = Set(rebuiltConversations.map(\.id))
        messageStates = Dictionary(
            uniqueKeysWithValues: loadedConversationIDs.map { ($0, RemoteContentState.loaded) }
        )
        messageRequestsByDirection = [.incoming: incoming, .outgoing: outgoing]
        messageRequestListStates = [.incoming: .loaded, .outgoing: .loaded]
        membershipFences = Dictionary(
            uniqueKeysWithValues: bundle.chats.flatMap { chatState in
                chatState.members.map { member in
                    (
                        MessengerMembershipFenceKey(
                            chatID: member.membership.chatId,
                            userID: member.membership.userId
                        ),
                        MessengerMembershipFence(
                            revision: member.membership.revision,
                            role: member.membership.role,
                            joinedAt: member.membership.joinedAt,
                            updatedAt: member.membership.updatedAt,
                            isRemoved: false,
                            causalSequence: bundle.boundary.sequence
                        )
                    )
                }
            }
        )
        conversationListState = .loaded
        if let selectedConversationID,
           rebuiltConversations.contains(where: { $0.id == selectedConversationID }) {
            self.selectedConversationID = selectedConversationID
        } else {
            selectedConversationID = rebuiltConversations.first(where: { !$0.isArchived })?.id
                ?? rebuiltConversations.first?.id
        }
        let retainedConversationIDs = Set(rebuiltConversations.map(\.id))
        for removedChatID in previousConversationIDs.subtracting(retainedConversationIDs) {
            // This must stay after the selectedConversationID transition: its
            // didSet first snapshots the old composer and could otherwise
            // recreate a draft for a chat that disappeared from the snapshot.
            fenceConversationLifecycle(removedChatID)
            scrubMessageMutationState(
                messageIDs: previousMessageIDsByChat[removedChatID] ?? []
            )
            removeComposerDraft(for: removedChatID)
        }
        if removedSelectedChat {
            draftBeforeEditing = ""
            composerModeBeforeEditing = .new
        }
        if let activeEditBeforeReconciliation,
           selectedConversationID == activeEditBeforeReconciliation.chatID,
           let retainedMessage = messagesByConversation[
               activeEditBeforeReconciliation.chatID
           ]?.first(where: { $0.id == activeEditBeforeReconciliation.target.id }),
           canEdit(retainedMessage) {
            draftBeforeEditing = activeEditBeforeReconciliation.underlyingDraft
            composerModeBeforeEditing = activeEditBeforeReconciliation.underlyingMode
            let refreshedTarget = composerTarget(for: retainedMessage)
            let conflictSafeTarget = MessageComposerTarget(
                id: refreshedTarget.id,
                authorName: refreshedTarget.authorName,
                preview: refreshedTarget.preview,
                revision: activeEditBeforeReconciliation.target.revision
            )
            isRestoringComposerState = true
            composerMode = .edit(conflictSafeTarget)
            draft = activeEditBeforeReconciliation.editBody
            isRestoringComposerState = false
        }
        for conversationID in rebuiltMessages.keys {
            resolveReplyPreviews(in: conversationID)
        }
        lastRemoteActionError = nil
        rescheduleMuteExpirations()
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

    private func applyCurrentUserProfile(_ snapshot: CurrentUserProfileSnapshot) {
        let userID = currentUser.id
        currentUser = snapshot.participant
        currentUserBio = snapshot.bio

        for index in conversations.indices where conversations[index].avatar.id == userID {
            conversations[index].avatar = snapshot.participant
        }
        messagesByConversation = messagesByConversation.mapValues { messages in
            messages.map { message in
                guard message.author.id == userID else { return message }
                return ChatMessage(
                    id: message.id,
                    clientID: message.clientID,
                    conversationID: message.conversationID,
                    author: snapshot.participant,
                    text: message.text,
                    sentAt: message.sentAt,
                    editedAt: message.editedAt,
                    delivery: message.delivery,
                    isOutgoing: message.isOutgoing,
                    replyPreview: message.replyPreview,
                    reactions: message.reactions
                )
            }
        }
    }

    private func updateDelivery(_ messageID: UUID, in conversationID: UUID, to state: MessageDelivery) {
        guard let index = messagesByConversation[conversationID]?.firstIndex(where: { $0.id == messageID }) else { return }
        messagesByConversation[conversationID]![index].delivery = state
    }

    private func replaceMessage(_ messageID: UUID, with updated: ChatMessage) {
        guard let (conversationID, _) = message(withID: messageID),
              let index = messagesByConversation[conversationID]?.firstIndex(where: { $0.id == messageID })
        else { return }
        messagesByConversation[conversationID]![index] = updated
    }

    private func replaceOptimisticMessage(_ clientID: UUID, in conversationID: UUID, with message: ChatMessage) {
        guard conversations.contains(where: { $0.id == conversationID }) else { return }
        guard let index = messagesByConversation[conversationID]?.firstIndex(where: { $0.clientID == clientID }) else {
            applyRealtimeMessage(message)
            return
        }
        let optimisticID = messagesByConversation[conversationID]![index].id
        messagesByConversation[conversationID]![index] = message
        if optimisticID != message.id {
            messageMetadataByID[optimisticID] = nil
        }
        lastRemoteActionError = nil
    }

    private func replaceOptimisticSnapshot(
        _ clientID: UUID,
        in conversationID: UUID,
        with snapshot: RemoteMessageSnapshot
    ) {
        guard conversations.contains(where: { $0.id == conversationID }),
              snapshot.message.conversationID == conversationID
        else { return }
        guard let index = messagesByConversation[conversationID]?.firstIndex(where: { $0.clientID == clientID }) else {
            applySnapshot(snapshot)
            return
        }
        let optimisticID = messagesByConversation[conversationID]![index].id
        var confirmed = snapshot.message
        confirmed.reactions = messagesByConversation[conversationID]![index].reactions
        messagesByConversation[conversationID]![index] = confirmed
        messageMetadataByID[optimisticID] = nil
        messageMetadataByID[confirmed.id] = snapshot.metadata
        resolveReplyPreviews(in: conversationID)
        lastRemoteActionError = nil
    }

    private func loadRemoteMessagesIfNeeded(_ conversationID: UUID, markRead: Bool, force: Bool = false) {
        guard remoteMessageSnapshotLoader != nil || remoteMessageLoader != nil else { return }
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            guard let self else { return }
            await loadMessages(for: conversationID, force: force)
            if markRead { await markConversationRead(conversationID) }
        }
        remoteOperations[operationID] = task
    }

    private func startMessageRequestCreation(
        recipientID: UUID,
        body: String,
        clientNonce: UUID
    ) {
        guard let remoteMessageRequestCreator else {
            messageRequestCreationError = "Отправка запроса недоступна на этом подключении."
            messageRequestCreationState = .failed(messageRequestCreationError ?? "Отправка недоступна.")
            return
        }
        guard messageRequestCreationState != .loading else { return }

        messageRequestCreationState = .loading
        messageRequestCreationError = nil
        messageRequestCreationRetry = MessageRequestCreationRetry(
            recipientID: recipientID,
            body: body,
            clientNonce: clientNonce
        )
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let request = try await remoteMessageRequestCreator(recipientID, body, clientNonce)
                guard let self, !Task.isCancelled else { return }
                guard request.direction == .outgoing else {
                    throw MessageRequestClientError.inconsistentDirection
                }
                guard request.state == .pending,
                      request.participant.id == recipientID,
                      request.body == body
                else {
                    throw MessageRequestClientError.inconsistentCreation
                }
                upsertMessageRequest(request)
                messageRequestListStates[.outgoing] = .loaded
                messageRequestCreationState = .loaded
                messageRequestCreationError = nil
                messageRequestCreationRetry = nil
            } catch is CancellationError {
                self?.messageRequestCreationState = .idle
            } catch {
                self?.messageRequestCreationError = error.localizedDescription
                self?.messageRequestCreationState = .failed(error.localizedDescription)
            }
        }
        remoteOperations[operationID] = task
    }

    private func startMessageRequestMutation(
        requestID: UUID,
        retry: MessageRequestMutationRetry
    ) {
        guard let request = messageRequestsByDirection[.incoming]?.first(where: {
            $0.id == requestID && $0.state == .pending
        }) else { return }
        guard messageRequestMutationState(requestID) != .loading else { return }

        switch retry {
        case .accept where remoteMessageRequestAccepter == nil,
             .dismiss where remoteMessageRequestDismisser == nil:
            messageRequestMutationStates[requestID] = .failed(
                "Действие с запросом недоступно на этом подключении."
            )
            return
        default:
            break
        }

        messageRequestMutationStates[requestID] = .loading
        messageRequestMutationErrors[requestID] = nil
        messageRequestMutationRetries[requestID] = retry
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                switch retry {
                case .accept:
                    guard let accepter = self?.remoteMessageRequestAccepter else {
                        throw MessageRequestClientError.unavailable
                    }
                    let result = try await accepter(request.id)
                    guard let self, !Task.isCancelled else { return }
                    guard result.request.id == request.id,
                          result.request.direction == .incoming,
                          result.request.state == .accepted,
                          result.request.participant.id == request.participant.id,
                          result.conversation.kind == .direct,
                          result.conversation.memberCount == 2,
                          result.conversation.serverRole == "member",
                          result.firstMessage.message.conversationID == result.conversation.id,
                          result.firstMessage.message.clientID == request.id,
                          result.firstMessage.message.author.id == request.participant.id,
                          result.firstMessage.message.text == request.body,
                          !result.firstMessage.message.isOutgoing,
                          !result.firstMessage.metadata.isDeleted,
                          result.firstMessage.metadata.revision.map({ $0 >= 0 }) ?? true
                    else {
                        throw MessageRequestClientError.inconsistentAcceptance
                    }
                    removeMessageRequest(request.id)
                    upsertConversation(result.conversation)
                    applySnapshot(result.firstMessage)
                    lastAcceptedMessageRequestConversationID = result.conversation.id
                case .dismiss:
                    guard let dismisser = self?.remoteMessageRequestDismisser else {
                        throw MessageRequestClientError.unavailable
                    }
                    try await dismisser(request.id)
                    guard let self, !Task.isCancelled else { return }
                    removeMessageRequest(request.id)
                }
                guard let self, !Task.isCancelled else { return }
                messageRequestMutationStates[request.id] = .loaded
                messageRequestMutationErrors[request.id] = nil
                messageRequestMutationRetries[request.id] = nil
            } catch is CancellationError {
                self?.messageRequestMutationStates[request.id] = .idle
            } catch {
                self?.messageRequestMutationStates[request.id] = .failed(error.localizedDescription)
                self?.messageRequestMutationErrors[request.id] = error.localizedDescription
            }
        }
        remoteOperations[operationID] = task
    }

    private func startPrivacySettingsUpdate(
        usernameDiscoverable: Bool?,
        messageRequests: MessageRequestPolicy?,
        lastSeen: PrivacyVisibility?,
        profilePhoto: PrivacyVisibility?,
        forwards: PrivacyVisibility?,
        voiceMessages: PrivacyVisibility?,
        calls: PrivacyVisibility?
    ) {
        guard let remotePrivacySettingsUpdater else {
            privacySettingsState = .failed("Изменение конфиденциальности недоступно на этом подключении.")
            return
        }
        guard privacySettingsState != .loading else { return }

        privacySettingsState = .loading
        privacySettingsRetry = PrivacySettingsRetry(
            usernameDiscoverable: usernameDiscoverable,
            messageRequests: messageRequests,
            lastSeen: lastSeen,
            profilePhoto: profilePhoto,
            forwards: forwards,
            voiceMessages: voiceMessages,
            calls: calls
        )
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let settings = try await remotePrivacySettingsUpdater(
                    usernameDiscoverable,
                    messageRequests,
                    lastSeen,
                    profilePhoto,
                    forwards,
                    voiceMessages,
                    calls
                )
                guard let self, !Task.isCancelled else { return }
                guard usernameDiscoverable.map({ $0 == settings.usernameDiscoverable }) ?? true,
                      messageRequests.map({ $0 == settings.messageRequests }) ?? true,
                      lastSeen.map({ $0 == settings.lastSeen }) ?? true,
                      profilePhoto.map({ $0 == settings.profilePhoto }) ?? true,
                      forwards.map({ $0 == settings.forwards }) ?? true,
                      voiceMessages.map({ $0 == settings.voiceMessages }) ?? true,
                      calls.map({ $0 == settings.calls }) ?? true
                else {
                    throw MessageRequestClientError.inconsistentPrivacy
                }
                privacySettings = settings
                privacySettingsState = .loaded
                privacySettingsRetry = nil
            } catch is CancellationError {
                self?.privacySettingsState = self?.privacySettings == nil ? .idle : .loaded
            } catch {
                self?.privacySettingsState = .failed(error.localizedDescription)
            }
        }
        remoteOperations[operationID] = task
    }

    /// Appends picked media to the composer payload (Telegram-style chips).
    public func addComposerMedia(_ items: [PendingMediaAttachment]) {
        guard !items.isEmpty else { return }
        mediaUploadError = nil
        composerMedia.append(contentsOf: items.prefix(max(0, 10 - composerMedia.count)))
    }

    public func removeComposerMedia(id: UUID) {
        composerMedia.removeAll { $0.id == id }
    }

    public func clearMediaUploadError() {
        if mediaUploadError != nil { mediaUploadError = nil }
    }

    private func startMediaSend(
        conversationID: UUID,
        body: String,
        replyTarget: MessageComposerTarget?
    ) {
        guard let uploader = remoteAttachmentUploader,
              let mediaSender = remoteMediaMessageSender,
              !isUploadingMedia
        else { return }
        let items = composerMedia
        isUploadingMedia = true
        mediaUploadProgress = 0
        mediaUploadError = nil

        let replyToMessageID = replyTarget?.id
        let replyPreview = replyTarget.map { "\($0.authorName): \($0.preview)" }
        Task { [weak self] in
            var attachmentIDs: [UUID] = []
            var attachments: [MessageAttachment] = []
            for (index, item) in items.enumerated() {
                do {
                    let attachment = try await uploader(item)
                    attachmentIDs.append(attachment.id)
                    attachments.append(attachment)
                    let completed = Double(index + 1) / Double(items.count)
                    await MainActor.run { [weak self] in
                        self?.mediaUploadProgress = completed
                    }
                } catch is CancellationError {
                    await MainActor.run { [weak self] in
                        self?.isUploadingMedia = false
                    }
                    return
                } catch {
                    await MainActor.run { [weak self] in
                        self?.isUploadingMedia = false
                        self?.mediaUploadError = Self.mediaUploadFailureMessage(error)
                    }
                    return
                }
            }
            await MainActor.run { [weak self] in
                self?.finishMediaSend(
                    conversationID: conversationID,
                    body: body,
                    replyToMessageID: replyToMessageID,
                    replyPreview: replyPreview,
                    attachmentIDs: attachmentIDs,
                    attachments: attachments,
                    mediaSender: mediaSender
                )
            }
        }
    }

    private func finishMediaSend(
        conversationID: UUID,
        body: String,
        replyToMessageID: UUID?,
        replyPreview: String?,
        attachmentIDs: [UUID],
        attachments: [MessageAttachment],
        mediaSender: @escaping (@Sendable (UUID, UUID, String, UUID?, [UUID], Bool) async throws -> ChatMessage)
    ) {
        isUploadingMedia = false
        mediaUploadProgress = 0
        composerMedia = []
        let consent = composerTranscriptionConsent && attachments.contains { $0.isVoice }
        composerTranscriptionConsent = false

        let clientID = UUID()
        var message = ChatMessage(
            id: clientID,
            clientID: clientID,
            conversationID: conversationID,
            author: currentUser,
            text: body,
            sentAt: .now,
            delivery: .sending,
            isOutgoing: true,
            replyPreview: replyPreview,
            attachments: attachments,
            transcriptionAllowed: consent
        )
        messagesByConversation[conversationID, default: []].append(message)
        messageMetadataByID[message.id] = MessageRemoteMetadata(
            replyToMessageID: replyToMessageID,
            attachmentIDs: attachmentIDs,
            transcriptionConsent: consent
        )
        let preview = attachments.contains { $0.isImage } && body.isEmpty ? "Фото" : (body.isEmpty ? "Файл" : body)
        clearComposerAfterSending(chatID: conversationID)
        updateConversationPreview(conversationID, text: preview)

        startMediaDelivery(
            conversationID: conversationID,
            clientID: clientID,
            messageID: message.id,
            body: body,
            replyToMessageID: replyToMessageID,
            attachmentIDs: attachmentIDs,
            transcriptionConsent: consent,
            mediaSender: mediaSender
        )
    }

    private func startMediaDelivery(
        conversationID: UUID,
        clientID: UUID,
        messageID: UUID,
        body: String,
        replyToMessageID: UUID?,
        attachmentIDs: [UUID],
        transcriptionConsent: Bool,
        mediaSender: @escaping (@Sendable (UUID, UUID, String, UUID?, [UUID], Bool) async throws -> ChatMessage)
    ) {
        let lifecycleGeneration = conversationLifecycleGenerations[conversationID] ?? 0
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let confirmed = try await mediaSender(
                    conversationID, clientID, body, replyToMessageID, attachmentIDs, transcriptionConsent
                )
                guard let self,
                      !Task.isCancelled,
                      ownsConversationLifecycle(conversationID, generation: lifecycleGeneration)
                else { return }
                replaceOptimisticMessage(clientID, in: conversationID, with: confirmed)
            } catch is CancellationError {
                return
            } catch {
                guard let self,
                      ownsConversationLifecycle(conversationID, generation: lifecycleGeneration)
                else { return }
                updateDelivery(messageID, in: conversationID, to: .failed)
                lastRemoteActionError = error.localizedDescription
            }
        }
        remoteOperations[operationID] = task
    }

    private static func mediaUploadFailureMessage(_ error: Error) -> String {
        if case let LuxoraAPIError.server(_, code, message) = error {
            switch code {
            case "VALIDATION_FAILED":
                return "Файл не подходит под ограничения сервера."
            case "RATE_LIMITED":
                return "Слишком много загрузок. Подождите немного."
            default:
                return "Не удалось загрузить файл: \(message)"
            }
        }
        if error is CancellationError { return "" }
        return "Нет связи с сервером. Повторите отправку."
    }

    private func startSend(
        conversationID: UUID,
        clientID: UUID,
        messageID: UUID,
        body: String,
        replyToMessageID: UUID?
    ) {
        let lifecycleGeneration = conversationLifecycleGenerations[conversationID] ?? 0
        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                if let snapshotSender = self?.remoteMessageSnapshotSender {
                    let confirmed = try await snapshotSender(conversationID, clientID, body, replyToMessageID)
                    guard let self,
                          !Task.isCancelled,
                          ownsConversationLifecycle(
                              conversationID,
                              generation: lifecycleGeneration
                          )
                    else { return }
                    replaceOptimisticSnapshot(clientID, in: conversationID, with: confirmed)
                } else if let sender = self?.remoteMessageSender {
                    let confirmed = try await sender(conversationID, clientID, body)
                    guard let self,
                          !Task.isCancelled,
                          ownsConversationLifecycle(
                              conversationID,
                              generation: lifecycleGeneration
                          )
                    else { return }
                    replaceOptimisticMessage(clientID, in: conversationID, with: confirmed)
                } else {
                    throw MessageMutationUnavailableError()
                }
            } catch is CancellationError {
                return
            } catch {
                guard let self,
                      ownsConversationLifecycle(
                          conversationID,
                          generation: lifecycleGeneration
                      )
                else { return }
                updateDelivery(messageID, in: conversationID, to: .failed)
                lastRemoteActionError = error.localizedDescription
            }
        }
        remoteOperations[operationID] = task
    }

    private func startEdit(messageID: UUID, body: String, expectedRevision: Int?) {
        guard let remoteMessageEditor,
              let (conversationID, _) = message(withID: messageID)
        else { return }
        let lifecycleGeneration = conversationLifecycleGenerations[conversationID] ?? 0
        let key = MessageMutationKey(messageID: messageID, kind: .edit)
        guard messageMutationStates[key] != .loading else { return }
        messageMutationStates[key] = .loading
        messageMutationFailure = nil
        messageMutationRetries[key] = .edit(body: body, expectedRevision: expectedRevision)

        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let snapshot = try await remoteMessageEditor(messageID, body, expectedRevision)
                guard let self,
                      !Task.isCancelled,
                      ownsConversationLifecycle(
                          conversationID,
                          generation: lifecycleGeneration
                      )
                else { return }
                applySnapshot(snapshot)
                messageMutationStates[key] = .loaded
                messageMutationRetries[key] = nil
                messageMutationFailure = nil
                if case let .edit(target) = composerMode, target.id == messageID {
                    restoreComposerAfterEditing()
                }
            } catch is CancellationError {
                self?.messageMutationStates[key] = .idle
            } catch {
                guard let self,
                      ownsConversationLifecycle(
                          conversationID,
                          generation: lifecycleGeneration
                      )
                else { return }
                recordMutationFailure(key: key, error: error)
            }
        }
        remoteOperations[operationID] = task
    }

    private func startDelete(messageID: UUID) {
        guard let remoteMessageDeleter,
              let (conversationID, _) = message(withID: messageID)
        else { return }
        let lifecycleGeneration = conversationLifecycleGenerations[conversationID] ?? 0
        let key = MessageMutationKey(messageID: messageID, kind: .delete)
        guard messageMutationStates[key] != .loading else { return }
        messageMutationStates[key] = .loading
        messageMutationFailure = nil
        messageMutationRetries[key] = .delete

        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let snapshot = try await remoteMessageDeleter(messageID)
                guard let self,
                      !Task.isCancelled,
                      ownsConversationLifecycle(
                          conversationID,
                          generation: lifecycleGeneration
                      )
                else { return }
                applySnapshot(snapshot)
                messageMutationStates[key] = .loaded
                messageMutationRetries[key] = nil
                messageMutationFailure = nil
                if composerMode.target?.id == messageID {
                    cancelComposerMode()
                }
            } catch is CancellationError {
                self?.messageMutationStates[key] = .idle
            } catch {
                guard let self,
                      ownsConversationLifecycle(
                          conversationID,
                          generation: lifecycleGeneration
                      )
                else { return }
                recordMutationFailure(key: key, error: error)
            }
        }
        remoteOperations[operationID] = task
    }

    private func startForward(messageID: UUID, conversationID: UUID, clientNonce: UUID) {
        guard let remoteMessageForwarder else { return }
        let key = MessageMutationKey(messageID: messageID, kind: .forward)
        guard messageMutationStates[key] != .loading else { return }
        messageMutationStates[key] = .loading
        messageMutationFailure = nil
        messageMutationRetries[key] = .forward(conversationID: conversationID, clientNonce: clientNonce)

        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let snapshot = try await remoteMessageForwarder(messageID, conversationID, clientNonce)
                guard let self, !Task.isCancelled else { return }
                applySnapshot(snapshot)
                messageMutationStates[key] = .loaded
                messageMutationRetries[key] = nil
                messageMutationFailure = nil
            } catch is CancellationError {
                self?.messageMutationStates[key] = .idle
            } catch {
                self?.recordMutationFailure(key: key, error: error)
            }
        }
        remoteOperations[operationID] = task
    }

    private func startPin(messageID: UUID, conversationID: UUID, active: Bool) {
        guard let remoteMessagePinSetter else { return }
        let key = MessageMutationKey(messageID: messageID, kind: .pin)
        guard messageMutationStates[key] != .loading else { return }
        messageMutationStates[key] = .loading
        messageMutationFailure = nil
        messageMutationRetries[key] = .pin(conversationID: conversationID, active: active)

        let operationID = UUID()
        let task = Task { [weak self] in
            defer { self?.remoteOperations[operationID] = nil }
            do {
                let confirmed = try await remoteMessagePinSetter(conversationID, messageID, active)
                guard let self, !Task.isCancelled else { return }
                var metadata = metadata(for: messageID)
                metadata.isPinned = confirmed
                messageMetadataByID[messageID] = metadata
                messageMutationStates[key] = .loaded
                messageMutationRetries[key] = nil
                messageMutationFailure = nil
            } catch is CancellationError {
                self?.messageMutationStates[key] = .idle
            } catch {
                self?.recordMutationFailure(key: key, error: error)
            }
        }
        remoteOperations[operationID] = task
    }

    private func applySnapshots(_ snapshots: [RemoteMessageSnapshot], to conversationID: UUID) {
        guard conversations.contains(where: { $0.id == conversationID }),
              snapshots.allSatisfy({ $0.message.conversationID == conversationID })
        else { return }
        let existingByID = Dictionary(
            uniqueKeysWithValues: messagesByConversation[conversationID, default: []].map { ($0.id, $0) }
        )
        let serverClientIDs = Set(snapshots.map(\.message.clientID))
        let retainedOptimistic = existingByID.values.filter {
            ($0.delivery == .sending || $0.delivery == .failed)
                && !serverClientIDs.contains($0.clientID)
        }
        let oldIDs = Set(existingByID.keys)
        let newIDs = Set(snapshots.map(\.message.id)).union(retainedOptimistic.map(\.id))
        for removedID in oldIDs.subtracting(newIDs) {
            messageMetadataByID[removedID] = nil
        }

        let confirmedMessages = snapshots.map { snapshot in
            var message = snapshot.message
            if let existing = existingByID[message.id], !snapshot.metadata.isDeleted {
                message.reactions = existing.reactions
            }
            messageMetadataByID[message.id] = snapshot.metadata
            return message
        }
        messagesByConversation[conversationID] = (confirmedMessages + retainedOptimistic)
        .sorted { $0.sentAt < $1.sentAt }
        resolveReplyPreviews(in: conversationID)
    }

    private func applySnapshot(_ snapshot: RemoteMessageSnapshot) {
        let conversationID = snapshot.message.conversationID
        guard conversations.contains(where: { $0.id == conversationID }) else { return }
        var messages = messagesByConversation[conversationID, default: []]
        var message = snapshot.message
        if let index = messages.firstIndex(where: {
            $0.id == message.id || $0.clientID == message.clientID
        }) {
            message.reactions = snapshot.metadata.isDeleted ? [] : messages[index].reactions
            messages[index] = message
        } else {
            messages.append(message)
        }
        messages.sort { $0.sentAt < $1.sentAt }
        messagesByConversation[conversationID] = messages
        messageMetadataByID[message.id] = snapshot.metadata
        resolveReplyPreviews(in: conversationID)
        if messages.last?.id == message.id {
            updateConversationPreview(conversationID, text: message.text)
        }
        messageStates[conversationID] = .loaded
        loadedConversationIDs.insert(conversationID)
        lastRemoteActionError = nil
    }

    private func resolveReplyPreviews(in conversationID: UUID) {
        guard var messages = messagesByConversation[conversationID] else { return }
        let messagesByID = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for index in messages.indices {
            guard let replyID = messageMetadataByID[messages[index].id]?.replyToMessageID else {
                messages[index].replyPreview = nil
                continue
            }
            guard let target = messagesByID[replyID] else {
                messages[index].replyPreview = "Ответ на сообщение"
                continue
            }
            let targetText = messageMetadataByID[target.id]?.isDeleted == true
                ? "Удалённое сообщение"
                : target.text
            messages[index].replyPreview = "\(target.author.displayName): \(targetText)"
        }
        messagesByConversation[conversationID] = messages
    }

    private func composerTarget(for message: ChatMessage) -> MessageComposerTarget {
        MessageComposerTarget(
            id: message.id,
            authorName: message.author.displayName,
            preview: String(message.text.prefix(120)),
            revision: metadata(for: message.id).revision
        )
    }

    private func recordMutationFailure(key: MessageMutationKey, error: Error) {
        let detail = error.localizedDescription
        messageMutationStates[key] = .failed(detail)
        messageMutationFailure = MessageMutationFailure(key: key, detail: detail)
        lastRemoteActionError = detail
    }

    private func isStable(_ message: ChatMessage) -> Bool {
        message.delivery != .sending
            && message.delivery != .failed
            && !isMessageMutationInFlight(message.id)
    }

    private static func isPrivileged(_ role: String?) -> Bool {
        role == "owner" || role == "admin"
    }

    private func message(withID messageID: UUID) -> (UUID, ChatMessage)? {
        for (conversationID, messages) in messagesByConversation {
            if let message = messages.first(where: { $0.id == messageID }) {
                return (conversationID, message)
            }
        }
        return nil
    }

    private func upsertMessageRequest(_ request: MessageRequestItem) {
        var requests = messageRequestsByDirection[request.direction, default: []]
        if let index = requests.firstIndex(where: { $0.id == request.id }) {
            requests[index] = request
        } else {
            requests.append(request)
        }
        requests.sort { $0.createdAt > $1.createdAt }
        messageRequestsByDirection[request.direction] = requests
    }

    private func removeMessageRequest(_ requestID: UUID) {
        for direction in MessageRequestDirection.allCases {
            messageRequestsByDirection[direction]?.removeAll { $0.id == requestID }
        }
    }

    private func upsertConversation(_ conversation: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index] = conversation
        } else {
            conversations.append(conversation)
        }
        rescheduleMuteExpirations()
    }

    private func fenceConversationLifecycle(_ conversationID: UUID) {
        conversationLifecycleGenerations[conversationID] =
            (conversationLifecycleGenerations[conversationID] ?? 0) &+ 1
    }

    private func ownsConversationLifecycle(
        _ conversationID: UUID,
        generation: UInt
    ) -> Bool {
        (conversationLifecycleGenerations[conversationID] ?? 0) == generation
            && conversations.contains(where: { $0.id == conversationID })
    }

    private func scrubMessageMutationState(messageIDs: Set<UUID>) {
        guard !messageIDs.isEmpty else { return }
        messageMutationStates = messageMutationStates.filter {
            !messageIDs.contains($0.key.messageID)
        }
        messageMutationRetries = messageMutationRetries.filter {
            !messageIDs.contains($0.key.messageID)
        }
        if let failure = messageMutationFailure,
           messageIDs.contains(failure.key.messageID) {
            messageMutationFailure = nil
        }
    }

    private func rescheduleMuteExpirations(now: Date = Date()) {
        muteExpiryOperation?.cancel()
        muteExpiryOperation = nil

        for index in conversations.indices {
            if let deadline = conversations[index].mutedUntil {
                conversations[index].isMuted = deadline > now
            }
        }
        guard let nextDeadline = conversations.compactMap(\.mutedUntil)
            .filter({ $0 > now })
            .min()
        else { return }

        let delay = max(0, nextDeadline.timeIntervalSince(now))
        muteExpiryOperation = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
            guard let self, !Task.isCancelled else { return }
            rescheduleMuteExpirations()
        }
    }
}

private enum MessageMutationRetry: Sendable {
    case edit(body: String, expectedRevision: Int?)
    case delete
    case forward(conversationID: UUID, clientNonce: UUID)
    case pin(conversationID: UUID, active: Bool)
}

private enum MessageRequestMutationRetry: Sendable {
    case accept
    case dismiss
}

private struct MessageRequestCreationRetry: Sendable {
    let recipientID: UUID
    let body: String
    let clientNonce: UUID
}

private struct PrivacySettingsRetry: Sendable {
    let usernameDiscoverable: Bool?
    let messageRequests: MessageRequestPolicy?
    let lastSeen: PrivacyVisibility?
    let profilePhoto: PrivacyVisibility?
    let forwards: PrivacyVisibility?
    let voiceMessages: PrivacyVisibility?
    let calls: PrivacyVisibility?
}

private struct MessageMutationUnavailableError: LocalizedError, Sendable {
    var errorDescription: String? { "Действие недоступно на текущем серверном подключении." }
}

private enum MessageRequestClientError: LocalizedError, Sendable {
    case unavailable
    case inconsistentDirection
    case inconsistentLookup
    case inconsistentCreation
    case inconsistentAcceptance
    case inconsistentPrivacy

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Действие с запросом недоступно на текущем серверном подключении."
        case .inconsistentDirection:
            "Сервер вернул запрос с неверным направлением."
        case .inconsistentLookup:
            "Сервер вернул профиль для другого username."
        case .inconsistentCreation:
            "Сервер вернул несогласованное подтверждение нового запроса."
        case .inconsistentAcceptance:
            "Сервер вернул несогласованное подтверждение принятия запроса."
        case .inconsistentPrivacy:
            "Сервер не подтвердил выбранные настройки конфиденциальности."
        }
    }
}
