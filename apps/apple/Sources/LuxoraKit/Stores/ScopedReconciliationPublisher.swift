import Foundation

/// Commits one account-scoped reconciliation bundle across every observable
/// projection. All throwing validation is completed before the first store is
/// mutated, so a malformed community page or folder snapshot cannot publish a
/// newer profile/chat projection while the durable cursor remains unchanged.
@MainActor
enum ScopedReconciliationPublisher {
    static func publish(
        _ bundle: LuxoraReconciliationBundle,
        currentUserID: UUID,
        messengerStore: MessengerStore,
        communityStore: CommunityStore,
        preferencesStore: ChatPreferencesStore,
        foldersStore: ChatFoldersStore,
        foldersBinding: ChatFoldersSessionBinding,
        beforeCommit: @MainActor () -> Void = {}
    ) throws {
        try messengerStore.validateReconciliation(bundle, currentUserID: currentUserID)
        try communityStore.validateReconciliation(bundle, currentUserID: currentUserID)
        try foldersStore.validateReplacement(bundle.chatFolders, binding: foldersBinding)

        // The methods below only commit the projections validated above. There
        // is deliberately no suspension point in this MainActor transaction.
        // Draft recovery uses this hook so its destructive privacy fences run
        // only after every throwing preflight has succeeded.
        beforeCommit()
        try messengerStore.applyReconciliation(bundle, currentUserID: currentUserID)
        try communityStore.applyReconciliation(bundle, currentUserID: currentUserID)
        preferencesStore.replaceConfirmed(
            Dictionary(
                uniqueKeysWithValues: bundle.chats.map {
                    ($0.chat.id, $0.chat.preferences)
                }
            )
        )
        try foldersStore.replaceConfirmed(bundle.chatFolders, binding: foldersBinding)
    }
}
