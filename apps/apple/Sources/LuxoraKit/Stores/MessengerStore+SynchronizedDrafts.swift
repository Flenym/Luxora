import Foundation

@MainActor
extension MessengerStore {
    public var synchronizedDraftsEnabled: Bool {
        synchronizedDraftStore != nil
    }

    public var selectedDraftSynchronizationState: RemoteContentState {
        guard let synchronizedDraftStore, let selectedConversationID else { return .idle }
        let mutation = synchronizedDraftStore.mutationState(for: selectedConversationID)
        if mutation == .loading { return mutation }
        if case .failed = mutation { return mutation }
        return synchronizedDraftStore.loadState(for: selectedConversationID)
    }

    public var isSelectedDraftReplyResolving: Bool {
        guard let selectedConversationID else { return false }
        return unresolvedReplyIDsByConversation[selectedConversationID] != nil
    }

    func configureSynchronizedDrafts(_ store: SynchronizedChatDraftStore?) {
        synchronizedDraftStore?.setChatUnavailableHandler(nil)
        synchronizedDraftStore = store
        guard let store else { return }
        store.setChatUnavailableHandler { [weak self, weak store] chatID in
            guard let self, let store, self.synchronizedDraftStore === store else { return }
            self.scrubComposerProjection(for: chatID)
        }
        for (chatID, text) in composerDraftsByConversation {
            let replyID = replyTargetID(in: composerModesByConversation[chatID] ?? .new)
            _ = store.setLocalDraft(for: chatID, text: text, replyToMessageID: replyID)
        }
    }

    public func loadSynchronizedDraft(for chatID: UUID, force: Bool = false) async {
        guard let store = synchronizedDraftStore else { return }
        _ = await store.refresh(chatID, force: force)
        guard synchronizedDraftStore === store else { return }
        if store.isChatUnavailable(chatID) {
            scrubComposerProjection(for: chatID)
            return
        }
        applySynchronizedDraftProjection(for: chatID)
    }

    public func retrySynchronizedDraft(for chatID: UUID) async {
        guard let store = synchronizedDraftStore else { return }
        await store.refresh(chatID, force: true)
        guard synchronizedDraftStore === store,
              store.confirmedState(for: chatID) != nil
        else { return }
        applySynchronizedDraftProjection(for: chatID)
        _ = await store.persist(chatID)
        guard synchronizedDraftStore === store else { return }
        applySynchronizedDraftProjection(for: chatID)
    }

    func applySynchronizedDraftProjection(for chatID: UUID) {
        guard let store = synchronizedDraftStore else { return }
        if store.isChatUnavailable(chatID) {
            scrubComposerProjection(for: chatID)
            return
        }
        guard store.confirmedState(for: chatID) != nil else { return }

        var content = store.localDraft(for: chatID)
        var mode: MessageComposerMode = .new
        if let replyID = content.replyToMessageID,
           let target = availableReplyTarget(id: replyID, chatID: chatID) {
            mode = .reply(target)
            unresolvedReplyIDsByConversation[chatID] = nil
        } else if content.replyToMessageID != nil,
                  messageState(for: chatID) == .loaded {
            // The server may retain text after its reply target is removed.
            // Keep that text, clear only the unavailable relationship, and
            // converge the corrected projection back through CAS.
            content = SynchronizedChatDraftContent(text: content.text)
            unresolvedReplyIDsByConversation[chatID] = nil
            _ = store.setLocalDraft(for: chatID, text: content.text)
            store.schedulePersist(chatID)
        } else if let replyID = content.replyToMessageID {
            // Message history is not authoritative yet. Keep this relationship
            // out of the visible UI, but retain it while the user types so a
            // valid cross-device reply is not silently rewritten to `.new`.
            unresolvedReplyIDsByConversation[chatID] = replyID
        } else {
            unresolvedReplyIDsByConversation[chatID] = nil
        }

        composerDraftsByConversation[chatID] = content.text
        composerModesByConversation[chatID] = mode
        guard selectedConversationID == chatID else { return }
        if case .edit = composerMode {
            // A late draft GET/realtime event updates the underlying draft but
            // never replaces the active message-edit body. Cancelling edit
            // restores this newest synchronized text/reply context.
            draftBeforeEditing = content.text
            composerModeBeforeEditing = mode
            return
        }
        restoreActiveComposer(text: content.text, mode: mode)
    }

    func applySynchronizedDraftRecoveryInvalidation(
        _ plan: SynchronizedChatDraftRecoveryPlan
    ) {
        for chatID in plan.removedChatIDs {
            removeComposerDraft(for: chatID)
        }
        for chatID in plan.lifecycleResetChatIDs {
            // Same stable chat ID, different membership lifetime. This is a
            // privacy boundary, so use the hard scrub that also exits edit
            // staging instead of the soft retained-chat invalidation.
            scrubComposerProjection(for: chatID)
        }
        for chatID in plan.cleanInvalidatedChatIDs {
            invalidateComposerProjectionForRecovery(for: chatID)
        }
        // Dirty values are deliberately left in their account/session/chat
        // maps. They have no confirmed CAS base and cannot persist until the
        // chat is lazily refreshed or a newer realtime draft arrives.
    }

    func applyComposerLifecycleReset(chatIDs: Set<UUID>) {
        for chatID in chatIDs {
            scrubComposerProjection(for: chatID)
        }
    }

    func handleComposerConversationChange(from oldConversationID: UUID?) {
        guard !isRestoringComposerState else { return }
        if let oldConversationID {
            if case .edit = composerMode {
                composerDraftsByConversation[oldConversationID] = draftBeforeEditing
                composerModesByConversation[oldConversationID] = storableMode(composerModeBeforeEditing)
            } else {
                composerDraftsByConversation[oldConversationID] = draft
                composerModesByConversation[oldConversationID] = storableMode(composerMode)
            }
        }

        guard let selectedConversationID else {
            restoreActiveComposer(text: "", mode: .new)
            return
        }
        let text = composerDraftsByConversation[selectedConversationID] ?? ""
        let storedMode = composerModesByConversation[selectedConversationID] ?? .new
        let mode = validatedStoredMode(
            storedMode,
            chatID: selectedConversationID
        )
        if case let .reply(target) = storedMode,
           mode == .new,
           messageState(for: selectedConversationID) != .loaded {
            unresolvedReplyIDsByConversation[selectedConversationID] = target.id
        } else if case .reply = mode {
            unresolvedReplyIDsByConversation[selectedConversationID] = nil
        }
        composerModesByConversation[selectedConversationID] = mode
        restoreActiveComposer(text: text, mode: mode)
    }

    func handleComposerDraftChange() {
        guard !isRestoringComposerState,
              let chatID = selectedConversationID,
              !isEditingComposer
        else { return }
        composerDraftsByConversation[chatID] = draft
        composerDraftGenerations[chatID] = (composerDraftGenerations[chatID] ?? 0) &+ 1
        synchronizeActiveComposer(chatID: chatID)
    }

    func handleComposerModeChange() {
        guard !isRestoringComposerState,
              let chatID = selectedConversationID,
              !isEditingComposer
        else { return }
        let mode = storableMode(composerMode)
        composerModesByConversation[chatID] = mode
        composerDraftsByConversation[chatID] = draft
        composerDraftGenerations[chatID] = (composerDraftGenerations[chatID] ?? 0) &+ 1
        synchronizeActiveComposer(chatID: chatID)
    }

    func restoreComposerAfterEditing(synchronize: Bool = true) {
        let restoredMode = storableMode(composerModeBeforeEditing)
        restoreActiveComposer(text: draftBeforeEditing, mode: restoredMode)
        guard let chatID = selectedConversationID else { return }
        composerDraftsByConversation[chatID] = draftBeforeEditing
        composerModesByConversation[chatID] = restoredMode
        if synchronize {
            composerDraftGenerations[chatID] = (composerDraftGenerations[chatID] ?? 0) &+ 1
            synchronizeActiveComposer(chatID: chatID)
        }
    }

    func clearComposerAfterSending(chatID: UUID) {
        composerDraftsByConversation[chatID] = ""
        composerModesByConversation[chatID] = .new
        unresolvedReplyIDsByConversation[chatID] = nil
        composerDraftGenerations[chatID] = (composerDraftGenerations[chatID] ?? 0) &+ 1
        if selectedConversationID == chatID {
            restoreActiveComposer(text: "", mode: .new)
        }
        guard let synchronizedDraftStore else { return }
        _ = synchronizedDraftStore.setLocalDraft(for: chatID, text: "")
        synchronizedDraftStore.schedulePersist(chatID)
    }

    func removeComposerDraft(for chatID: UUID) {
        composerDraftsByConversation[chatID] = nil
        composerModesByConversation[chatID] = nil
        unresolvedReplyIDsByConversation[chatID] = nil
        composerDraftGenerations[chatID] = nil
        synchronizedDraftStore?.removeChat(chatID)
        if selectedConversationID == chatID {
            resetComposerStaging()
        }
    }

    func knownComposerProjectionChatIDs() -> Set<UUID> {
        Set(composerDraftsByConversation.keys)
            .union(composerModesByConversation.keys)
            .union(unresolvedReplyIDsByConversation.keys)
            .union(composerDraftGenerations.keys)
            .union(synchronizedDraftStore?.knownChatIDs() ?? [])
    }

    private var isEditingComposer: Bool {
        if case .edit = composerMode { return true }
        return false
    }

    private func synchronizeActiveComposer(chatID: UUID) {
        guard let synchronizedDraftStore else { return }
        let mode = composerModesByConversation[chatID] ?? .new
        let visibleReplyID = replyTargetID(in: mode)
        if visibleReplyID != nil {
            unresolvedReplyIDsByConversation[chatID] = nil
        }
        _ = synchronizedDraftStore.setLocalDraft(
            for: chatID,
            text: composerDraftsByConversation[chatID] ?? "",
            replyToMessageID: visibleReplyID ?? unresolvedReplyIDsByConversation[chatID]
        )
        synchronizedDraftStore.schedulePersist(chatID)
    }

    private func scrubComposerProjection(for chatID: UUID) {
        composerDraftsByConversation[chatID] = nil
        composerModesByConversation[chatID] = nil
        unresolvedReplyIDsByConversation[chatID] = nil
        composerDraftGenerations[chatID] = nil
        if selectedConversationID == chatID {
            restoreActiveComposer(text: "", mode: .new)
            resetComposerStaging()
        }
    }

    private func invalidateComposerProjectionForRecovery(for chatID: UUID) {
        composerDraftsByConversation[chatID] = nil
        composerModesByConversation[chatID] = nil
        unresolvedReplyIDsByConversation[chatID] = nil
        composerDraftGenerations[chatID] = nil
        guard selectedConversationID == chatID else { return }
        if case .edit = composerMode {
            draftBeforeEditing = ""
            composerModeBeforeEditing = .new
        } else {
            restoreActiveComposer(text: "", mode: .new)
        }
    }

    private func resetComposerStaging() {
        draftBeforeEditing = ""
        composerModeBeforeEditing = .new
    }

    private func restoreActiveComposer(text: String, mode: MessageComposerMode) {
        isRestoringComposerState = true
        draft = text
        composerMode = mode
        isRestoringComposerState = false
    }

    private func storableMode(_ mode: MessageComposerMode) -> MessageComposerMode {
        switch mode {
        case .new, .reply:
            mode
        case .edit:
            .new
        }
    }

    private func validatedStoredMode(
        _ mode: MessageComposerMode,
        chatID: UUID
    ) -> MessageComposerMode {
        guard case let .reply(target) = mode else { return .new }
        return availableReplyTarget(id: target.id, chatID: chatID).map(MessageComposerMode.reply)
            ?? .new
    }

    private func replyTargetID(in mode: MessageComposerMode) -> UUID? {
        guard case let .reply(target) = mode else { return nil }
        return target.id
    }

    private func availableReplyTarget(id: UUID, chatID: UUID) -> MessageComposerTarget? {
        guard let message = messagesByConversation[chatID]?.first(where: { $0.id == id }),
              messageMetadataByID[id]?.isDeleted != true
        else { return nil }
        return MessageComposerTarget(
            id: message.id,
            authorName: message.author.displayName,
            preview: String(message.text.prefix(120)),
            revision: messageMetadataByID[id]?.revision
        )
    }
}
