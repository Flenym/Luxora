import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class ChatFoldersStoreTests: XCTestCase {
    private let accountID = UUID(uuidString: "A1000000-0000-4000-8000-000000000001")!
    private let folderAID = UUID(uuidString: "F1000000-0000-4000-8000-000000000001")!
    private let folderBID = UUID(uuidString: "F2000000-0000-4000-8000-000000000002")!
    private let chatID = UUID(uuidString: "C1000000-0000-4000-8000-000000000001")!

    func testMutationPublishesOnlyAfterReceiptAndExactRetryReusesNonce() async throws {
        let initial = snapshot([folderA()], stateRevision: 1)
        let created = folder(
            id: folderBID,
            title: "Новая",
            position: 1,
            revision: 1
        )
        let probe = RetryCreateProbe(
            receipt: ChatFolderMutationReceipt(folder: created, stateRevision: 2, replayed: true)
        )
        let store = ChatFoldersStore()
        _ = try configured(store, snapshot: initial, creator: { command in
            try await probe.create(command)
        })

        store.create(ChatFolderDraft(title: "Новая", rules: .allUnarchived, overrides: []))
        await waitUntil { if case .failed = store.mutationState { true } else { false } }
        XCTAssertEqual(store.folders.map(\.id), [folderAID])
        XCTAssertTrue(store.mutationFailure?.supportsExactRetry == true)

        store.retryLastMutation()
        await waitUntil { store.mutationState == .loaded && store.folders.count == 2 }
        let commands = await probe.commands
        XCTAssertEqual(commands.count, 2)
        XCTAssertEqual(commands[0].clientNonce, commands[1].clientNonce)
        XCTAssertEqual(store.folders.map(\.id), [folderAID, folderBID])
    }

    func testStaleEditorRevisionConflictsAndNeverRebasesFullDraftOverRemoteOverrides() async throws {
        let remoteOverride = ChatFolderOverride(
            chatID: chatID,
            mode: .include,
            pinnedPosition: 0
        )
        let remote = snapshot([
            folderA(title: "Удалённая версия", revision: 2, overrides: [remoteOverride]),
        ], stateRevision: 2)
        let probe = ConflictUpdateProbe()
        let store = ChatFoldersStore()
        _ = try configured(
            store,
            snapshot: snapshot([folderA()], stateRevision: 1),
            loader: { remote },
            updater: { folderID, command in
                try await probe.update(folderID: folderID, command: command)
            }
        )

        store.update(
            folderID: folderAID,
            draft: ChatFolderDraft(title: "Локальный заголовок", rules: .allUnarchived, overrides: []),
            expectedRevision: 1
        )
        await waitUntil { if case .failed = store.mutationState { true } else { false } }

        let commands = await probe.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands[0].expectedRevision, 1)
        XCTAssertEqual(store.folder(id: folderAID)?.title, "Удалённая версия")
        XCTAssertEqual(store.folder(id: folderAID)?.overrides, [remoteOverride])
        XCTAssertFalse(store.mutationFailure?.supportsExactRetry ?? true)
        XCTAssertFalse(store.mutationFailure?.requiresReviewAfterRefresh ?? true)

        store.retryLastMutation()
        try? await Task.sleep(for: .milliseconds(30))
        let retryCommandCount = await probe.commands.count
        XCTAssertEqual(retryCommandCount, 1)
    }

    func testStaleDeleteUsesDialogRevisionAndCannotDeleteNewerFolder() async throws {
        let remote = snapshot([folderA(title: "Новая версия", revision: 2)], stateRevision: 2)
        let probe = ConflictDeleteProbe()
        let store = ChatFoldersStore()
        _ = try configured(
            store,
            snapshot: snapshot([folderA()], stateRevision: 1),
            loader: { remote },
            deleter: { folderID, command in
                try await probe.delete(folderID: folderID, command: command)
            }
        )

        store.delete(folderID: folderAID, expectedRevision: 1)
        await waitUntil { if case .failed = store.mutationState { true } else { false } }
        let capturedRevision = await probe.command?.expectedRevision
        XCTAssertEqual(capturedRevision, 1)
        XCTAssertEqual(store.folder(id: folderAID)?.revision, 2)
    }

    func testUnrelatedRealtimeInterruptPreservesExactCommandUntilReplaySucceeds() async throws {
        let first = snapshot([folderA(), folderB()], stateRevision: 1)
        let refreshed = snapshot([
            folderA(),
            folderB(title: "B с другого устройства", revision: 2),
        ], stateRevision: 2)
        let confirmedA = folderA(title: "Локальная A", revision: 2)
        let probe = SuspendedThenReplayUpdateProbe(
            receipt: ChatFolderMutationReceipt(
                folder: confirmedA,
                stateRevision: 3,
                replayed: true
            )
        )
        let store = ChatFoldersStore()
        let binding = try configured(
            store,
            snapshot: first,
            loader: { refreshed },
            updater: { folderID, command in
                try await probe.update(folderID: folderID, command: command)
            }
        )

        store.update(
            folderID: folderAID,
            draft: ChatFolderDraft(title: "Локальная A", rules: .allUnarchived, overrides: []),
            expectedRevision: 1
        )
        await probe.waitUntilStarted()
        let event = dispatch(stateRevision: 2, sequence: 10)
        XCTAssertTrue(store.applyRealtime(event, binding: binding))
        let refreshedForEvent = await store.refreshForRealtime(minimumStateRevision: 2)
        XCTAssertTrue(refreshedForEvent)
        XCTAssertEqual(store.folder(id: folderBID)?.title, "B с другого устройства")
        XCTAssertTrue(store.mutationFailure?.supportsExactRetry == true)
        guard case .failed = store.mutationState else {
            return XCTFail("An account-wide event cannot confirm an unidentified command")
        }

        await probe.releaseFirst()
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(store.folder(id: folderAID)?.title, "A")

        store.retryLastMutation()
        await waitUntil { store.mutationState == .loaded && store.stateRevision == 3 }
        let commands = await probe.commands
        XCTAssertEqual(commands.count, 2)
        XCTAssertEqual(commands[0].clientNonce, commands[1].clientNonce)
        XCTAssertEqual(store.folder(id: folderAID)?.title, "Локальная A")

        try store.commitRealtime(event, binding: binding)
    }

    func testFailedRealtimeRefreshAllowsExactUncommittedDispatchReplay() async throws {
        let refreshed = snapshot([folderA(revision: 2)], stateRevision: 2)
        let loader = FailThenSnapshotLoader(snapshot: refreshed)
        let store = ChatFoldersStore()
        let binding = try configured(
            store,
            snapshot: snapshot([folderA()], stateRevision: 1),
            loader: { try await loader.load() }
        )
        let event = dispatch(stateRevision: 2, sequence: 11)

        XCTAssertTrue(store.applyRealtime(event, binding: binding))
        let firstRefresh = await store.refreshForRealtime(minimumStateRevision: 2)
        XCTAssertFalse(firstRefresh)
        XCTAssertTrue(store.applyRealtime(event, binding: binding))
        let secondRefresh = await store.refreshForRealtime(minimumStateRevision: 2)
        XCTAssertTrue(secondRefresh)
        try store.commitRealtime(event, binding: binding)
        XCTAssertFalse(store.applyRealtime(event, binding: binding))
    }

    func testFullReconciliationFallbackRetainsInterruptedPendingExactReplay() async throws {
        let first = snapshot([folderA(), folderB()], stateRevision: 1)
        let reconciled = snapshot([
            folderA(),
            folderB(title: "B из snapshot", revision: 2),
        ], stateRevision: 2)
        let probe = SuspendedThenReplayUpdateProbe(
            receipt: ChatFolderMutationReceipt(
                folder: folderA(title: "Локальная после replay", revision: 2),
                stateRevision: 3,
                replayed: true
            )
        )
        let store = ChatFoldersStore()
        let binding = try configured(
            store,
            snapshot: first,
            updater: { folderID, command in
                try await probe.update(folderID: folderID, command: command)
            }
        )
        store.update(
            folderID: folderAID,
            draft: ChatFolderDraft(
                title: "Локальная после replay",
                rules: .allUnarchived,
                overrides: []
            ),
            expectedRevision: 1
        )
        await probe.waitUntilStarted()
        XCTAssertTrue(store.applyRealtime(dispatch(stateRevision: 2, sequence: 12), binding: binding))

        try store.replaceConfirmed(reconciled, binding: binding)
        XCTAssertEqual(store.folder(id: folderBID)?.title, "B из snapshot")
        XCTAssertTrue(store.mutationFailure?.supportsExactRetry == true)
        guard case .failed = store.mutationState else {
            return XCTFail("Full reconciliation cannot invent mutation confirmation")
        }

        await probe.releaseFirst()
        store.retryLastMutation()
        await waitUntil { store.mutationState == .loaded && store.stateRevision == 3 }
        let commands = await probe.commands
        XCTAssertEqual(commands.count, 2)
        XCTAssertEqual(commands[0].clientNonce, commands[1].clientNonce)
    }

    func testDeleteAlwaysRefetchesCompactedSiblingRevisions() async throws {
        let first = snapshot([folderA(), folderB(position: 1)], stateRevision: 1)
        let compactedB = folderB(position: 0, revision: 2)
        let compactedSnapshot = snapshot([compactedB], stateRevision: 2)
        let store = ChatFoldersStore()
        _ = try configured(
            store,
            snapshot: first,
            loader: { compactedSnapshot },
            deleter: { folderID, _ in
                ChatFolderDeleteReceipt(folderID: folderID, stateRevision: 2, replayed: false)
            }
        )

        store.delete(folderID: folderAID, expectedRevision: 1)
        await waitUntil { store.mutationState == .loaded && store.folders.count == 1 }
        XCTAssertEqual(store.folders.first?.id, folderBID)
        XCTAssertEqual(store.folders.first?.position, 0)
        XCTAssertEqual(store.folders.first?.revision, 2)
    }

    func testHistoricalReplayReceiptNeverRollsBackNewerProjection() async throws {
        let current = snapshot([folderA(title: "Текущая", revision: 3)], stateRevision: 3)
        let historical = folderA(title: "Старая квитанция", revision: 2)
        let store = ChatFoldersStore()
        _ = try configured(
            store,
            snapshot: current,
            updater: { _, _ in
                ChatFolderMutationReceipt(folder: historical, stateRevision: 2, replayed: true)
            }
        )

        store.update(
            folderID: folderAID,
            draft: ChatFolderDraft(title: "Старая квитанция", rules: .allUnarchived, overrides: []),
            expectedRevision: 3
        )
        await waitUntil { store.mutationState == .loaded }
        XCTAssertEqual(store.stateRevision, 3)
        XCTAssertEqual(store.folder(id: folderAID)?.title, "Текущая")
    }

    func testConflictRefreshFailureBlocksRetryUntilAuthoritativeRefresh() async throws {
        let current = snapshot([folderA()], stateRevision: 1)
        let refreshed = snapshot([folderA(title: "Удалённая", revision: 2)], stateRevision: 2)
        let loader = FailThenSnapshotLoader(snapshot: refreshed)
        let probe = ConflictUpdateProbe()
        let store = ChatFoldersStore()
        _ = try configured(
            store,
            snapshot: current,
            loader: { try await loader.load() },
            updater: { folderID, command in
                try await probe.update(folderID: folderID, command: command)
            }
        )

        store.update(
            folderID: folderAID,
            draft: ChatFolderDraft(title: "Локальная", rules: .allUnarchived, overrides: []),
            expectedRevision: 1
        )
        await waitUntil { if case .failed = store.mutationState { true } else { false } }
        XCTAssertFalse(store.mutationFailure?.supportsExactRetry ?? true)
        XCTAssertFalse(store.mutationFailure?.requiresReviewAfterRefresh ?? true)
        store.retryLastMutation()
        let countBeforeRefresh = await probe.commands.count
        XCTAssertEqual(countBeforeRefresh, 1)

        let didRefresh = await store.refresh(force: true)
        XCTAssertTrue(didRefresh)
        XCTAssertEqual(store.folder(id: folderAID)?.title, "Удалённая")
        XCTAssertFalse(store.mutationFailure?.supportsExactRetry ?? true)
        store.retryLastMutation()
        let countAfterRefresh = await probe.commands.count
        XCTAssertEqual(countAfterRefresh, 1)
    }

    func testHigherSequenceAndRevisionAcceptEarlierChangedAt() throws {
        let store = ChatFoldersStore()
        let binding = try configured(
            store,
            snapshot: snapshot([folderA(revision: 2)], stateRevision: 2)
        )
        let committed = ChatFoldersRealtimeDispatch(
            accountID: accountID,
            stateRevision: 2,
            changedAt: Date(timeIntervalSince1970: 500),
            sequence: 20,
            cursor: dispatch(stateRevision: 2, sequence: 20).cursor
        )
        try store.commitRealtime(committed, binding: binding)
        let clockRollback = ChatFoldersRealtimeDispatch(
            accountID: accountID,
            stateRevision: 3,
            changedAt: Date(timeIntervalSince1970: 100),
            sequence: 21,
            cursor: committed.cursor
        )
        XCTAssertTrue(store.applyRealtime(clockRollback, binding: binding))
    }

    func testSystemArchiveRemainsReachableWithoutCustomFolders() {
        let active = conversation(id: chatID, archived: false)
        let archivedID = UUID(uuidString: "C2000000-0000-4000-8000-000000000002")!
        let archived = conversation(id: archivedID, archived: true)
        let store = ChatFoldersStore(
            snapshot: ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )

        XCTAssertEqual(store.visibleConversations(from: [active, archived]).map(\.id), [active.id])
        store.selectArchive()
        XCTAssertEqual(store.visibleConversations(from: [active, archived]).map(\.id), [archived.id])
        store.select(nil)
        XCTAssertEqual(store.visibleConversations(from: [active, archived]).map(\.id), [active.id])
    }

    private func configured(
        _ store: ChatFoldersStore,
        snapshot: ChatFolderListSnapshot,
        loader: @escaping ChatFoldersStore.Loader = {
            throw FolderStoreHarnessError.unexpectedCall
        },
        creator: @escaping ChatFoldersStore.Creator = { _ in
            throw FolderStoreHarnessError.unexpectedCall
        },
        updater: @escaping ChatFoldersStore.Updater = { _, _ in
            throw FolderStoreHarnessError.unexpectedCall
        },
        deleter: @escaping ChatFoldersStore.Deleter = { _, _ in
            throw FolderStoreHarnessError.unexpectedCall
        },
        reorderer: @escaping ChatFoldersStore.Reorderer = { _ in
            throw FolderStoreHarnessError.unexpectedCall
        }
    ) throws -> ChatFoldersSessionBinding {
        let binding = store.configureRemote(
            accountID: accountID,
            loader: loader,
            creator: creator,
            updater: updater,
            deleter: deleter,
            reorderer: reorderer
        )
        try store.replaceConfirmed(snapshot, binding: binding)
        return binding
    }

    private func waitUntil(
        timeoutIterations: Int = 300,
        _ predicate: @MainActor () -> Bool
    ) async {
        for _ in 0..<timeoutIterations {
            if predicate() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Timed out waiting for folder store state")
    }

    private func dispatch(stateRevision: Int, sequence: Int) -> ChatFoldersRealtimeDispatch {
        ChatFoldersRealtimeDispatch(
            accountID: accountID,
            stateRevision: stateRevision,
            changedAt: Date(timeIntervalSince1970: TimeInterval(sequence)),
            sequence: sequence,
            cursor: "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"
        )
    }

    private func snapshot(
        _ folders: [ChatFolder],
        stateRevision: Int
    ) -> ChatFolderListSnapshot {
        ChatFolderListSnapshot(folders: folders, stateRevision: stateRevision)
    }

    private func folderA(
        title: String = "A",
        revision: Int = 1,
        overrides: [ChatFolderOverride] = []
    ) -> ChatFolder {
        folder(id: folderAID, title: title, position: 0, revision: revision, overrides: overrides)
    }

    private func folderB(
        title: String = "B",
        position: Int = 1,
        revision: Int = 1
    ) -> ChatFolder {
        folder(id: folderBID, title: title, position: position, revision: revision)
    }

    private func folder(
        id: UUID,
        title: String,
        position: Int,
        revision: Int,
        overrides: [ChatFolderOverride] = []
    ) -> ChatFolder {
        ChatFolder(
            id: id,
            title: title,
            position: position,
            revision: revision,
            rules: .allUnarchived,
            overrides: overrides,
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: TimeInterval(revision))
        )
    }

    private func conversation(id: UUID, archived: Bool) -> Conversation {
        Conversation(
            id: id,
            title: archived ? "Архивный" : "Активный",
            subtitle: "",
            kind: .direct,
            avatar: Participant(
                id: id,
                displayName: "Чат",
                username: "chat",
                initials: "Ч",
                accentHex: "#5B5FF0",
                isOnline: false,
                status: ""
            ),
            memberCount: 2,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: archived,
            lastActivity: Date(timeIntervalSince1970: archived ? 1 : 2),
            folder: "personal"
        )
    }
}

private actor RetryCreateProbe {
    private let receipt: ChatFolderMutationReceipt
    private(set) var commands: [ChatFolderCreateCommand] = []

    init(receipt: ChatFolderMutationReceipt) { self.receipt = receipt }

    func create(_ command: ChatFolderCreateCommand) throws -> ChatFolderMutationReceipt {
        commands.append(command)
        if commands.count == 1 {
            throw LuxoraAPIError.transport("response lost")
        }
        return receipt
    }
}

private actor ConflictUpdateProbe {
    private(set) var commands: [ChatFolderPatchCommand] = []

    func update(
        folderID _: UUID,
        command: ChatFolderPatchCommand
    ) throws -> ChatFolderMutationReceipt {
        commands.append(command)
        throw LuxoraAPIError.server(status: 409, code: "CONFLICT", message: "stale")
    }
}

private actor ConflictDeleteProbe {
    private(set) var command: ChatFolderDeleteCommand?

    func delete(
        folderID _: UUID,
        command: ChatFolderDeleteCommand
    ) throws -> ChatFolderDeleteReceipt {
        self.command = command
        throw LuxoraAPIError.server(status: 409, code: "CONFLICT", message: "stale")
    }
}

private actor SuspendedThenReplayUpdateProbe {
    private let receipt: ChatFolderMutationReceipt
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var commands: [ChatFolderPatchCommand] = []

    init(receipt: ChatFolderMutationReceipt) { self.receipt = receipt }

    func update(
        folderID _: UUID,
        command: ChatFolderPatchCommand
    ) async throws -> ChatFolderMutationReceipt {
        commands.append(command)
        if commands.count == 1 {
            started = true
            startWaiters.forEach { $0.resume() }
            startWaiters.removeAll()
            await withCheckedContinuation { releaseWaiters.append($0) }
        }
        return receipt
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func releaseFirst() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor FailThenSnapshotLoader {
    private let snapshot: ChatFolderListSnapshot
    private var calls = 0

    init(snapshot: ChatFolderListSnapshot) { self.snapshot = snapshot }

    func load() throws -> ChatFolderListSnapshot {
        calls += 1
        if calls == 1 { throw LuxoraAPIError.transport("offline") }
        return snapshot
    }
}

private enum FolderStoreHarnessError: Error {
    case unexpectedCall
}
