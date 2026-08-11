import Foundation
@testable import LuxoraKit
import LuxoraDesignFixtures
import XCTest

@MainActor
final class ScopedReconciliationPublisherTests: XCTestCase {
    func testInvalidCommunityPreflightLeavesEveryProjectionCursorAndInflightLoadUnchanged() async throws {
        let messenger = LuxoraDesignFixtures.makeStore()
        let userID = messenger.currentUser.id
        let originalUser = messenger.currentUser
        let originalBio = messenger.currentUserBio
        let originalConversations = messenger.conversations
        let originalMessages = messenger.messagesByConversation
        let originalSelection = messenger.selectedConversationID

        let community = CommunityStore(
            currentUserID: userID,
            communities: messenger.conversations
        )
        let originalCommunities = community.communities
        let originalMembers = community.membersByCommunity
        let originalCommunityStates = community.communityStates
        let originalMemberListStates = community.memberListStates

        let existingChatID = try XCTUnwrap(messenger.conversations.first?.id)
        let existingPreferences = ChatPreferences(
            archivedAt: Date(timeIntervalSince1970: 1_786_435_200),
            mutedUntil: nil
        )
        let preferences = ChatPreferencesStore()
        _ = preferences.configureRemote(
            accountID: userID,
            loader: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        preferences.replaceConfirmed([existingChatID: existingPreferences])
        let originalPreferences = preferences.confirmed

        let folderGate = ReconciliationFolderLoadGate()
        let folders = ChatFoldersStore()
        let foldersBinding = folders.configureRemote(
            accountID: userID,
            loader: { try await folderGate.load() },
            creator: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            deleter: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            reorderer: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        try folders.replaceConfirmed(
            ChatFolderListSnapshot(folders: [], stateRevision: 0),
            binding: foldersBinding
        )
        let folderLoad = Task { await folders.refresh(force: true) }
        try await waitUntil { await folderGate.isWaiting }
        XCTAssertEqual(folders.loadState, .loading)

        let oldCursor = Self.validCursor(seed: "o")
        let newCursor = Self.validCursor(seed: "n")
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "account-b-access",
                refreshToken: "account-b-refresh",
                sessionID: UUID(),
                realtimeV2Cursor: oldCursor
            ),
            refreshOperation: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            persistOperation: { _ in }
        )
        let invalidBundle = Self.invalidCommunityBundle(
            currentUser: originalUser,
            currentUserBio: originalBio,
            cursor: newCursor
        )
        var cursorCommitCallCount = 0

        do {
            try ScopedReconciliationPublisher.publish(
                invalidBundle,
                currentUserID: userID,
                messengerStore: messenger,
                communityStore: community,
                preferencesStore: preferences,
                foldersStore: folders,
                foldersBinding: foldersBinding
            )
            cursorCommitCallCount += 1
            try await coordinator.commitRealtimeV2Cursor(newCursor)
            XCTFail("An invalid community projection must abort the entire publication")
        } catch CommunityStoreError.invalidMemberPage {
            // Expected preflight failure before any commit or cancellation.
        } catch {
            XCTFail("Expected invalidMemberPage, received \(error)")
        }

        XCTAssertEqual(messenger.currentUser, originalUser)
        XCTAssertEqual(messenger.currentUserBio, originalBio)
        XCTAssertEqual(messenger.conversations, originalConversations)
        XCTAssertEqual(messenger.messagesByConversation, originalMessages)
        XCTAssertEqual(messenger.selectedConversationID, originalSelection)
        XCTAssertEqual(community.communities, originalCommunities)
        XCTAssertEqual(community.membersByCommunity, originalMembers)
        XCTAssertEqual(community.communityStates, originalCommunityStates)
        XCTAssertEqual(community.memberListStates, originalMemberListStates)
        XCTAssertEqual(preferences.confirmed, originalPreferences)
        XCTAssertTrue(folders.folders.isEmpty)
        XCTAssertEqual(folders.stateRevision, 0)
        XCTAssertEqual(folders.loadState, .loading, "Preflight must not cancel active work")
        XCTAssertEqual(cursorCommitCallCount, 0)
        let cursorAfterFailure = await coordinator.realtimeV2Cursor()
        XCTAssertEqual(cursorAfterFailure, oldCursor)

        await folderGate.finish(
            ChatFolderListSnapshot(folders: [], stateRevision: 0)
        )
        _ = await folderLoad.value
        XCTAssertEqual(folders.loadState, .loaded)
    }

    func testInvalidFolderPreflightLeavesAllFourStoresAndCursorCommitProbeUntouched() throws {
        let messenger = LuxoraDesignFixtures.makeStore()
        let userID = messenger.currentUser.id
        let originalUser = messenger.currentUser
        let originalBio = messenger.currentUserBio
        let originalConversations = messenger.conversations
        let originalMessages = messenger.messagesByConversation

        let community = CommunityStore(
            currentUserID: userID,
            communities: messenger.conversations
        )
        let originalCommunities = community.communities
        let originalMembers = community.membersByCommunity

        let existingChatID = try XCTUnwrap(messenger.conversations.first?.id)
        let preferences = ChatPreferencesStore()
        _ = preferences.configureRemote(
            accountID: userID,
            loader: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        preferences.replaceConfirmed([
            existingChatID: ChatPreferences(archivedAt: nil, mutedUntil: .distantFuture),
        ])
        let originalPreferences = preferences.confirmed

        let folders = ChatFoldersStore()
        let foldersBinding = folders.configureRemote(
            accountID: userID,
            loader: { throw ReconciliationPublisherHarnessError.unexpectedCall },
            creator: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            updater: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            deleter: { _, _ in throw ReconciliationPublisherHarnessError.unexpectedCall },
            reorderer: { _ in throw ReconciliationPublisherHarnessError.unexpectedCall }
        )
        try folders.replaceConfirmed(
            ChatFolderListSnapshot(folders: [], stateRevision: 0),
            binding: foldersBinding
        )
        let invalidFolderBundle = Self.invalidFolderBundle(currentUser: originalUser)
        let cursorCommitProbe = ReconciliationCursorCommitProbe()

        do {
            try ScopedReconciliationPublisher.publish(
                invalidFolderBundle,
                currentUserID: userID,
                messengerStore: messenger,
                communityStore: community,
                preferencesStore: preferences,
                foldersStore: folders,
                foldersBinding: foldersBinding
            )
            cursorCommitProbe.commit(invalidFolderBundle.boundary.cursor)
            XCTFail("An invalid folder snapshot must abort the entire publication")
        } catch LuxoraAPIError.invalidResponse {
            // Expected before any store or cursor publication.
        } catch {
            XCTFail("Expected invalidResponse, received \(error)")
        }

        XCTAssertEqual(messenger.currentUser, originalUser)
        XCTAssertEqual(messenger.currentUserBio, originalBio)
        XCTAssertEqual(messenger.conversations, originalConversations)
        XCTAssertEqual(messenger.messagesByConversation, originalMessages)
        XCTAssertEqual(community.communities, originalCommunities)
        XCTAssertEqual(community.membersByCommunity, originalMembers)
        XCTAssertEqual(preferences.confirmed, originalPreferences)
        XCTAssertTrue(folders.folders.isEmpty)
        XCTAssertEqual(folders.stateRevision, 0)
        XCTAssertEqual(cursorCommitProbe.callCount, 0)
        XCTAssertNil(cursorCommitProbe.cursor)
    }

    private static func invalidCommunityBundle(
        currentUser: Participant,
        currentUserBio: String,
        cursor: String
    ) -> LuxoraReconciliationBundle {
        let now = Date(timeIntervalSince1970: 1_786_435_200)
        let user = APIUser(
            id: currentUser.id,
            username: currentUser.username,
            displayName: "Не должен примениться",
            bio: "Не должен примениться",
            avatarUrl: nil,
            avatarPath: "/avatars/uncommitted",
            createdAt: now,
            presence: "online",
            lastSeenAt: now
        )
        let invalidGroup = APIChat(
            id: UUID(),
            kind: "group",
            title: "Несогласованная группа",
            avatarUrl: nil,
            role: "owner",
            memberCount: 2,
            lastMessage: nil,
            lastActivityAt: now,
            createdAt: now,
            unreadCount: 4,
            archivedAt: nil,
            mutedUntil: nil
        )
        return LuxoraReconciliationBundle(
            boundary: RealtimeReconciliationBoundary(
                sequence: 99,
                cursor: cursor,
                capturedAt: now,
                cursorExpiresAt: now.addingTimeInterval(86_400)
            ),
            currentUser: user,
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [
                ReconciliationChatState(
                    chat: invalidGroup,
                    members: [], // memberCount=2 must fail Community preflight.
                    messages: [],
                    pins: [],
                    topics: []
                ),
            ],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: 1)
        )
    }

    private static func validCursor(seed: Character) -> String {
        "luxora-rt1.\(String(repeating: seed, count: 40)).\(String(repeating: seed, count: 40))"
    }

    private static func invalidFolderBundle(
        currentUser: Participant
    ) -> LuxoraReconciliationBundle {
        let now = Date(timeIntervalSince1970: 1_786_435_200)
        return LuxoraReconciliationBundle(
            boundary: RealtimeReconciliationBoundary(
                sequence: 100,
                cursor: validCursor(seed: "f"),
                capturedAt: now,
                cursorExpiresAt: now.addingTimeInterval(86_400)
            ),
            currentUser: APIUser(
                id: currentUser.id,
                username: currentUser.username,
                displayName: "Профиль из неприменённого снимка",
                bio: "Не публиковать",
                avatarUrl: nil,
                avatarPath: "/avatars/not-published",
                createdAt: now,
                presence: "online",
                lastSeenAt: now
            ),
            incomingRequests: [],
            outgoingRequests: [],
            blocks: [],
            chats: [],
            attachments: [],
            safetyReports: [],
            chatFolders: ChatFolderListSnapshot(folders: [], stateRevision: -1)
        )
    }

    private func waitUntil(
        _ predicate: @escaping @Sendable () async -> Bool
    ) async throws {
        for _ in 0..<200 {
            if await predicate() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Timed out waiting for the in-flight folder load")
    }
}

private actor ReconciliationFolderLoadGate {
    private var continuation: CheckedContinuation<ChatFolderListSnapshot, Error>?

    var isWaiting: Bool { continuation != nil }

    func load() async throws -> ChatFolderListSnapshot {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish(_ snapshot: ChatFolderListSnapshot) {
        continuation?.resume(returning: snapshot)
        continuation = nil
    }
}

private enum ReconciliationPublisherHarnessError: Error {
    case unexpectedCall
}

@MainActor
private final class ReconciliationCursorCommitProbe {
    private(set) var callCount = 0
    private(set) var cursor: String?

    func commit(_ cursor: String) {
        callCount += 1
        self.cursor = cursor
    }
}
