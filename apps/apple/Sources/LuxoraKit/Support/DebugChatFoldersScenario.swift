#if DEBUG
import Foundation

@MainActor
enum DebugChatFoldersScenario {
    static func make(conversations: [Conversation], accountID: UUID) -> ChatFoldersStore {
        let initial = DebugChatFolderBackend.initialSnapshot(conversations: conversations)
        let backend = DebugChatFolderBackend(initial: initial)
        let store = ChatFoldersStore()
        let binding = store.configureRemote(
            accountID: accountID,
            loader: { await backend.list() },
            creator: { try await backend.create($0) },
            updater: { try await backend.update(folderID: $0, command: $1) },
            deleter: { try await backend.delete(folderID: $0, command: $1) },
            reorderer: { try await backend.reorder($0) }
        )
        try? store.replaceConfirmed(initial, binding: binding)
        return store
    }

    /// Resolves UI-test folder aliases before SwiftUI is mounted so a later
    /// view task can never overwrite an interaction performed by the test.
    static func selectInitialFolder(_ rawFolder: String?, in store: ChatFoldersStore) {
        guard let rawFolder else { return }
        let normalized = rawFolder.lowercased()
        if normalized == "all" {
            store.select(nil)
        } else if normalized == "archived" || normalized == "archive" {
            store.selectArchive()
        } else if let folderID = UUID(uuidString: rawFolder) {
            store.select(folderID)
        } else if let folder = store.folders.first(where: {
            $0.title.lowercased() == normalized
                || (
                    normalized == "channels"
                        && !$0.rules.unreadOnly
                        && $0.rules.includeKinds.count == 2
                        && $0.rules.includeKinds.contains(.group)
                        && $0.rules.includeKinds.contains(.channel)
                )
                || (normalized == "unread" && $0.rules.unreadOnly)
                || (normalized == "direct" && $0.rules.includeKinds == [.direct])
        }) {
            store.select(folder.id)
        }
    }
}

private actor DebugChatFolderBackend {
    private var folders: [ChatFolder]
    private var stateRevision: Int
    private var mutationReceipts: [UUID: DebugReceipt] = [:]

    init(initial: ChatFolderListSnapshot) {
        folders = initial.folders
        stateRevision = initial.stateRevision
    }

    static func initialSnapshot(conversations: [Conversation]) -> ChatFolderListSnapshot {
        let now = Date(timeIntervalSince1970: 1_785_834_060)
        let studioID = UUID(uuidString: "466bb23c-21c9-464b-b761-04686df7a060")
        let quietChannelID = UUID(uuidString: "62499623-29d3-453c-a788-94d402f295c7")
        let folderData: [(UUID, String, ChatFolderRules, [ChatFolderOverride])] = [
            (
                UUID(uuidString: "f1300000-0000-4000-8000-000000000001")!,
                "Непрочитанные",
                ChatFolderRules(
                    includeKinds: ChatFolderChatKind.allCases,
                    unreadOnly: true,
                    excludeMuted: false,
                    includeArchived: false
                ),
                []
            ),
            (
                UUID(uuidString: "f1300000-0000-4000-8000-000000000002")!,
                "Команда",
                ChatFolderRules(
                    includeKinds: [.group, .channel],
                    unreadOnly: false,
                    excludeMuted: true,
                    includeArchived: false
                ),
                [
                    studioID.map {
                        ChatFolderOverride(chatID: $0, mode: .include, pinnedPosition: 0)
                    },
                    quietChannelID.map {
                        ChatFolderOverride(chatID: $0, mode: .include, pinnedPosition: nil)
                    },
                ].compactMap { $0 }
            ),
            (
                UUID(uuidString: "f1300000-0000-4000-8000-000000000003")!,
                "Личные",
                ChatFolderRules(
                    includeKinds: [.direct],
                    unreadOnly: false,
                    excludeMuted: false,
                    includeArchived: false
                ),
                []
            ),
        ]
        let availableIDs = Set(conversations.map(\.id))
        let folders = folderData.enumerated().map { position, item in
            ChatFolder(
                id: item.0,
                title: item.1,
                position: position,
                revision: 1,
                rules: item.2,
                overrides: item.3.filter { availableIDs.contains($0.chatID) },
                createdAt: now.addingTimeInterval(Double(position)),
                updatedAt: now.addingTimeInterval(Double(position))
            )
        }
        return ChatFolderListSnapshot(folders: folders, stateRevision: 3)
    }

    func list() -> ChatFolderListSnapshot {
        ChatFolderListSnapshot(folders: folders, stateRevision: stateRevision)
    }

    func create(_ command: ChatFolderCreateCommand) throws -> ChatFolderMutationReceipt {
        if case let .mutation(receipt)? = mutationReceipts[command.clientNonce] {
            return ChatFolderMutationReceipt(
                folder: receipt.folder,
                stateRevision: receipt.stateRevision,
                replayed: true
            )
        }
        guard folders.count < ChatFolderContract.maximumFolders else {
            throw conflict("Достигнут лимит папок")
        }
        let draft = try command.draft.validated()
        stateRevision += 1
        let now = Date(timeIntervalSince1970: 1_785_834_060 + Double(stateRevision))
        let folder = ChatFolder(
            id: UUID(),
            title: draft.title,
            position: folders.count,
            revision: 1,
            rules: draft.rules,
            overrides: draft.overrides,
            createdAt: now,
            updatedAt: now
        )
        folders.append(folder)
        let receipt = ChatFolderMutationReceipt(
            folder: folder,
            stateRevision: stateRevision,
            replayed: false
        )
        mutationReceipts[command.clientNonce] = .mutation(receipt)
        return receipt
    }

    func update(
        folderID: UUID,
        command: ChatFolderPatchCommand
    ) throws -> ChatFolderMutationReceipt {
        if case let .mutation(receipt)? = mutationReceipts[command.clientNonce] {
            return ChatFolderMutationReceipt(
                folder: receipt.folder,
                stateRevision: receipt.stateRevision,
                replayed: true
            )
        }
        guard let index = folders.firstIndex(where: { $0.id == folderID }),
              folders[index].revision == command.expectedRevision
        else { throw conflict("Ревизия папки изменилась") }
        let current = folders[index]
        let next = ChatFolder(
            id: current.id,
            title: command.title ?? current.title,
            position: current.position,
            revision: current.revision + 1,
            rules: command.rules ?? current.rules,
            overrides: command.overrides ?? current.overrides,
            createdAt: current.createdAt,
            updatedAt: Date(timeIntervalSince1970: 1_785_834_060 + Double(stateRevision + 1))
        )
        _ = try next.validated()
        stateRevision += 1
        folders[index] = next
        let receipt = ChatFolderMutationReceipt(
            folder: next,
            stateRevision: stateRevision,
            replayed: false
        )
        mutationReceipts[command.clientNonce] = .mutation(receipt)
        return receipt
    }

    func delete(
        folderID: UUID,
        command: ChatFolderDeleteCommand
    ) throws -> ChatFolderDeleteReceipt {
        if case let .delete(receipt)? = mutationReceipts[command.clientNonce] {
            return ChatFolderDeleteReceipt(
                folderID: receipt.folderID,
                stateRevision: receipt.stateRevision,
                replayed: true
            )
        }
        guard let index = folders.firstIndex(where: { $0.id == folderID }),
              folders[index].revision == command.expectedRevision
        else { throw conflict("Ревизия папки изменилась") }
        folders.remove(at: index)
        stateRevision += 1
        let now = Date(timeIntervalSince1970: 1_785_834_060 + Double(stateRevision))
        folders = folders.enumerated().map { position, folder in
            guard folder.position != position else { return folder }
            return ChatFolder(
                id: folder.id,
                title: folder.title,
                position: position,
                revision: folder.revision + 1,
                rules: folder.rules,
                overrides: folder.overrides,
                createdAt: folder.createdAt,
                updatedAt: now
            )
        }
        let receipt = ChatFolderDeleteReceipt(
            folderID: folderID,
            stateRevision: stateRevision,
            replayed: false
        )
        mutationReceipts[command.clientNonce] = .delete(receipt)
        return receipt
    }

    func reorder(_ command: ChatFolderReorderCommand) throws -> ChatFolderReorderReceipt {
        if case let .reorder(receipt)? = mutationReceipts[command.clientNonce] {
            return ChatFolderReorderReceipt(
                folders: receipt.folders,
                stateRevision: receipt.stateRevision,
                replayed: true
            )
        }
        guard command.expectedStateRevision == stateRevision,
              command.folderIDs.count == folders.count,
              Set(command.folderIDs) == Set(folders.map(\.id))
        else { throw conflict("Состав папок изменился") }
        let byID = Dictionary(uniqueKeysWithValues: folders.map { ($0.id, $0) })
        let changed = command.folderIDs != folders.map(\.id)
        if changed {
            stateRevision += 1
            let now = Date(timeIntervalSince1970: 1_785_834_060 + Double(stateRevision))
            folders = command.folderIDs.enumerated().compactMap { position, id in
                guard let folder = byID[id] else { return nil }
                guard folder.position != position else { return folder }
                return ChatFolder(
                    id: folder.id,
                    title: folder.title,
                    position: position,
                    revision: folder.revision + 1,
                    rules: folder.rules,
                    overrides: folder.overrides,
                    createdAt: folder.createdAt,
                    updatedAt: now
                )
            }
        }
        let receipt = ChatFolderReorderReceipt(
            folders: folders,
            stateRevision: stateRevision,
            replayed: false
        )
        mutationReceipts[command.clientNonce] = .reorder(receipt)
        return receipt
    }

    private func conflict(_ message: String) -> LuxoraAPIError {
        .server(status: 409, code: "CONFLICT", message: message)
    }
}

private enum DebugReceipt {
    case mutation(ChatFolderMutationReceipt)
    case delete(ChatFolderDeleteReceipt)
    case reorder(ChatFolderReorderReceipt)
}
#endif
