import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class CommunityStoreTests: XCTestCase {
    private let ownerID = UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!
    private let memberID = UUID(uuidString: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!
    private let candidateID = UUID(uuidString: "cccccccc-cccc-4ccc-8ccc-cccccccccccc")!
    private let chatID = UUID(uuidString: "dddddddd-dddd-4ddd-8ddd-dddddddddddd")!

    func testAmbiguousCreationNeverPublishesAChatOrOffersBlindRetry() async {
        let store = CommunityStore(currentUserID: ownerID)
        configure(
            store,
            creator: { _, _, _ in throw LuxoraAPIError.transport("response lost") }
        )

        let result = await store.createCommunity(
            kind: .group,
            title: "Команда Luxora",
            memberIDs: [memberID]
        )

        XCTAssertNil(result)
        XCTAssertTrue(store.communities.isEmpty)
        XCTAssertEqual(store.creationCertainty, .outcomeUnknown)
        XCTAssertFalse(store.canRetryCommunityCreation)
        guard case let .failed(detail) = store.creationState else {
            return XCTFail("The unknown outcome must remain visible")
        }
        XCTAssertTrue(detail.contains("дубликат"))
        let blindRetry = await store.retryCommunityCreation()
        XCTAssertNil(blindRetry)
    }

    func testDefinitiveCreationRejectionCanRetryAndOnlyPublishesConfirmedChat() async {
        let confirmed = conversation(
            kind: .channel,
            title: "Новости Luxora",
            role: .owner,
            memberCount: 1
        )
        let probe = CommunityCreationProbe(confirmed: confirmed)
        let store = CommunityStore(currentUserID: ownerID)
        configure(store, creator: { kind, title, memberIDs in
            try await probe.create(kind: kind, title: title, memberIDs: memberIDs)
        })

        let firstAttempt = await store.createCommunity(
            kind: .channel,
            title: "Новости Luxora",
            memberIDs: []
        )
        XCTAssertNil(firstAttempt)
        XCTAssertEqual(store.creationCertainty, .definitivelyRejected)
        XCTAssertTrue(store.canRetryCommunityCreation)
        XCTAssertTrue(store.communities.isEmpty)

        let retried = await store.retryCommunityCreation()

        XCTAssertEqual(retried?.id, chatID)
        XCTAssertEqual(store.communities.map(\.id), [chatID])
        XCTAssertEqual(store.creationCertainty, .confirmed)
        XCTAssertFalse(store.canRetryCommunityCreation)
        let creationCalls = await probe.callCount
        XCTAssertEqual(creationCalls, 2)
    }

    func testInvalidMemberPagePreservesPreviouslyConfirmedMembersAndShowsFailure() async {
        let initial = baseMembers()
        let page = CommunityMemberPageProbe(page: initial)
        let store = makeStore()
        configure(store, memberLoader: { _ in await page.load() })

        await store.loadMembers(chatID)
        XCTAssertEqual(store.members(chatID).map(\.id), [ownerID, memberID])

        await page.replace(with: [initial[0], initial[0]])
        await store.loadMembers(chatID, force: true)

        XCTAssertEqual(store.members(chatID).map(\.id), [ownerID, memberID])
        guard case .failed = store.memberListState(chatID) else {
            return XCTFail("A hostile duplicate page must be rejected visibly")
        }
    }

    func testAddRetryReusesNonceAndNeverInsertsAnUnconfirmedMember() async {
        let initial = baseMembers()
        let candidate = participant(id: candidateID, name: "Мария", username: "maria")
        let addedMembership = membership(
            userID: candidateID,
            role: .member,
            revision: 1,
            joinedAt: updatedDate,
            updatedAt: updatedDate
        )
        let probe = CommunityAddProbe(
            receipt: CommunityMembershipMutationReceipt(
                membership: addedMembership,
                replayed: false
            )
        )
        let store = makeStore()
        configure(
            store,
            memberLoader: { _ in
                if await probe.hasConfirmedMutation {
                    return initial + [CommunityMember(membership: addedMembership, participant: candidate)]
                }
                return initial
            },
            memberAdder: { chatID, userID, role, nonce in
                try await probe.add(chatID: chatID, userID: userID, role: role, nonce: nonce)
            }
        )
        await store.loadMembers(chatID)

        let firstAdd = await store.addMember(candidate, to: chatID)
        XCTAssertFalse(firstAdd)
        XCTAssertEqual(store.members(chatID).map(\.id), [ownerID, memberID])
        let key = CommunityMemberMutationKey(chatID: chatID, userID: candidateID, kind: .add)
        guard case .failed = store.mutationState(key) else {
            return XCTFail("The lost response must be visible and retryable")
        }

        let retriedAdd = await store.retryMutation(key)
        XCTAssertTrue(retriedAdd)
        XCTAssertEqual(store.members(chatID).map(\.id), [ownerID, memberID, candidateID])
        XCTAssertEqual(store.community(chatID)?.memberCount, 3)
        XCTAssertEqual(store.mutationState(key), .loaded)
        let nonces = await probe.nonces
        XCTAssertEqual(nonces.count, 2)
        XCTAssertEqual(nonces.first, nonces.last)
    }

    func testInconsistentRoleReceiptDoesNotChangeConfirmedMemberPage() async {
        let initial = baseMembers()
        let receiptJoinedAt = joinedDate
        let receiptUpdatedAt = updatedDate
        let store = makeStore()
        configure(
            store,
            memberLoader: { _ in initial },
            memberRoleUpdater: { chatID, userID, _, expectedRevision, _ in
                CommunityMembershipMutationReceipt(
                    membership: ChatMembership(
                        chatID: chatID,
                        userID: userID,
                        role: .admin,
                        revision: expectedRevision,
                        joinedAt: receiptJoinedAt,
                        updatedAt: receiptUpdatedAt
                    ),
                    replayed: false
                )
            }
        )
        await store.loadMembers(chatID)

        let changed = await store.changeRole(of: memberID, to: .admin, in: chatID)
        XCTAssertFalse(changed)

        XCTAssertEqual(store.members(chatID).first(where: { $0.id == memberID })?.membership.role, .member)
        let key = CommunityMemberMutationKey(chatID: chatID, userID: memberID, kind: .changeRole)
        guard case .failed = store.mutationState(key) else {
            return XCTFail("A stale receipt must never alter the confirmed role")
        }
    }

    func testOwnerAdminMemberPermissionsAndChannelPublishingMatchServerPolicy() async {
        let ownerStore = makeStore(kind: .channel, role: .owner)
        let ownerPage = baseMembers()
        configure(ownerStore, memberLoader: { _ in ownerPage })
        await ownerStore.loadMembers(chatID)
        XCTAssertTrue(ownerStore.canAddMember(role: .admin, to: chatID))
        XCTAssertTrue(ownerStore.canChangeRole(of: memberID, to: .admin, in: chatID))
        XCTAssertTrue(ownerStore.canRemoveMember(memberID, from: chatID))
        XCTAssertTrue(ownerStore.canPublish(in: try! XCTUnwrap(ownerStore.community(chatID))))
        XCTAssertFalse(ownerStore.canRemoveMember(ownerID, from: chatID))

        let adminStore = CommunityStore(
            currentUserID: memberID,
            communities: [conversation(kind: .channel, title: "Новости Luxora", role: .admin, memberCount: 2)]
        )
        let adminPage = [
            communityMember(userID: ownerID, role: .owner, name: "Flenym", username: "flenym"),
            communityMember(userID: memberID, role: .admin, revision: 2, name: "Админ", username: "admin"),
        ]
        configure(adminStore, memberLoader: { _ in adminPage })
        await adminStore.loadMembers(chatID)
        XCTAssertTrue(adminStore.canAddMember(role: .member, to: chatID))
        XCTAssertFalse(adminStore.canAddMember(role: .admin, to: chatID))
        XCTAssertFalse(adminStore.canChangeRole(of: ownerID, to: .member, in: chatID))
        XCTAssertTrue(adminStore.canPublish(in: try! XCTUnwrap(adminStore.community(chatID))))

        let memberStore = CommunityStore(
            currentUserID: memberID,
            communities: [conversation(kind: .channel, title: "Новости Luxora", role: .member, memberCount: 2)]
        )
        let memberPage = baseMembers()
        configure(memberStore, memberLoader: { _ in memberPage })
        await memberStore.loadMembers(chatID)
        XCTAssertFalse(memberStore.canAddMember(role: .member, to: chatID))
        XCTAssertFalse(memberStore.canPublish(in: try! XCTUnwrap(memberStore.community(chatID))))

        var group = try! XCTUnwrap(memberStore.community(chatID))
        group.kind = .group
        XCTAssertTrue(memberStore.canPublish(in: group))
        XCTAssertTrue(memberStore.canRemoveMember(memberID, from: chatID))
    }

    func testConfirmedCommunityProjectionUpsertsAndConfirmedRemovalClearsState() async throws {
        let store = makeStore()
        var observedUpdates: [Conversation] = []
        var observedRemovals: [UUID] = []
        store.configureProjectionObservers(
            communityUpdated: { observedUpdates.append($0) },
            communityRemoved: { observedRemovals.append($0) }
        )
        let page = baseMembers()
        configure(store, memberLoader: { _ in page })
        await store.loadMembers(chatID)

        var updated = conversation(
            kind: .group,
            title: "Команда Luxora — обновлено",
            role: .owner,
            memberCount: 2
        )
        updated.lastActivity = updatedDate.addingTimeInterval(60)
        try store.acceptConfirmedCommunity(updated)

        XCTAssertEqual(store.community(chatID)?.title, "Команда Luxora — обновлено")
        XCTAssertEqual(store.communityStates[chatID], .loaded)
        XCTAssertEqual(store.members(chatID).count, 2)
        XCTAssertEqual(observedUpdates.last?.title, "Команда Luxora — обновлено")

        store.acceptConfirmedCommunityRemoval(chatID)

        XCTAssertNil(store.community(chatID))
        XCTAssertTrue(store.members(chatID).isEmpty)
        XCTAssertEqual(store.memberListState(chatID), .idle)
        XCTAssertNil(store.communityStates[chatID])
        XCTAssertEqual(observedRemovals, [chatID])
    }

    func testInvalidConfirmedCommunityProjectionIsRejected() {
        let store = makeStore()
        var invalid = conversation(
            kind: .group,
            title: "Команда Luxora",
            role: .owner,
            memberCount: 2
        )
        invalid.kind = .direct

        XCTAssertThrowsError(try store.acceptConfirmedCommunity(invalid)) { error in
            XCTAssertEqual(error as? CommunityStoreError, .invalidCommunity)
        }
        XCTAssertEqual(store.community(chatID)?.kind, .group)
    }

    func testMembershipSignalMarksPageStaleWithoutInventingRows() async {
        let store = makeStore()
        let page = baseMembers()
        configure(store, memberLoader: { _ in page })
        await store.loadMembers(chatID)
        XCTAssertEqual(store.memberListState(chatID), .loaded)

        store.markConfirmedMemberPageStale(chatID)

        XCTAssertEqual(store.memberListState(chatID), .idle)
        XCTAssertEqual(store.members(chatID), page)
    }

    func testMembershipAddedSignalUpdatesCountWithoutInventingProfileOrDoubleCountingHTTPReconciliation() async throws {
        let initial = baseMembers()
        let addedMembership = membership(
            userID: candidateID,
            role: .member,
            revision: 1,
            joinedAt: updatedDate,
            updatedAt: updatedDate
        )
        let candidate = participant(id: candidateID, name: "Мария", username: "maria")
        let page = CommunityMemberPageProbe(page: initial)
        let store = makeStore()
        configure(store, memberLoader: { _ in await page.load() })
        await store.loadMembers(chatID)

        try store.acceptConfirmedMembershipSignal(addedMembership, change: .added)

        XCTAssertEqual(store.community(chatID)?.memberCount, 3)
        XCTAssertEqual(store.memberListState(chatID), .idle)
        XCTAssertEqual(store.members(chatID).map(\.id), [ownerID, memberID])

        await page.replace(with: initial + [
            CommunityMember(membership: addedMembership, participant: candidate),
        ])
        await store.loadMembers(chatID, force: true)
        XCTAssertEqual(store.memberListState(chatID), .loaded)

        try store.acceptConfirmedMembershipSignal(addedMembership, change: .added)

        XCTAssertEqual(store.community(chatID)?.memberCount, 3)
        XCTAssertEqual(store.members(chatID).map(\.id), [ownerID, memberID, candidateID])
        XCTAssertEqual(store.memberListState(chatID), .loaded)
    }

    func testMembershipRoleSignalUpdatesCurrentRoleAndConfirmedRow() async throws {
        let page = baseMembers()
        let store = CommunityStore(
            currentUserID: memberID,
            communities: [conversation(
                kind: .channel,
                title: "Новости Luxora",
                role: .member,
                memberCount: 2
            )]
        )
        configure(store, memberLoader: { _ in page })
        await store.loadMembers(chatID)
        let promoted = membership(
            userID: memberID,
            role: .admin,
            revision: 2,
            updatedAt: updatedDate
        )

        try store.acceptConfirmedMembershipSignal(promoted, change: .roleUpdated)

        XCTAssertEqual(store.currentUserRole(in: chatID), .admin)
        XCTAssertEqual(store.community(chatID)?.serverRole, ChatMembershipRole.admin.rawValue)
        XCTAssertEqual(store.members(chatID).first(where: { $0.id == memberID })?.membership, promoted)
        XCTAssertEqual(store.memberListState(chatID), .loaded)
        XCTAssertEqual(store.community(chatID)?.memberCount, 2)
    }

    func testConfirmedSelfLeavePurgesCommunityAndAllChatScopedMutationState() async {
        let page = baseMembers()
        let joinedAt = joinedDate
        let updatedAt = updatedDate
        let store = CommunityStore(
            currentUserID: memberID,
            communities: [conversation(
                kind: .group,
                title: "Команда Luxora",
                role: .member,
                memberCount: 2
            )]
        )
        configure(
            store,
            memberLoader: { _ in page },
            memberRemover: { chatID, userID, expectedRevision, _ in
                CommunityMembershipMutationReceipt(
                    membership: ChatMembership(
                        chatID: chatID,
                        userID: userID,
                        role: .member,
                        revision: expectedRevision + 1,
                        joinedAt: joinedAt,
                        updatedAt: updatedAt
                    ),
                    replayed: false
                )
            }
        )
        await store.loadMembers(chatID)

        let removed = await store.removeMember(memberID, from: chatID)

        XCTAssertTrue(removed)
        XCTAssertNil(store.community(chatID))
        XCTAssertTrue(store.members(chatID).isEmpty)
        XCTAssertNil(store.communityStates[chatID])
        XCTAssertEqual(store.memberListState(chatID), .idle)
        XCTAssertTrue(store.mutationStates.keys.allSatisfy { $0.chatID != chatID })
        XCTAssertTrue(store.mutationFailures.keys.allSatisfy { $0.chatID != chatID })
    }

    private var joinedDate: Date { Date(timeIntervalSince1970: 1_786_435_200) }
    private var updatedDate: Date { Date(timeIntervalSince1970: 1_786_438_800) }

    private func makeStore(
        kind: ConversationKind = .group,
        role: ChatMembershipRole = .owner
    ) -> CommunityStore {
        CommunityStore(
            currentUserID: ownerID,
            communities: [conversation(
                kind: kind,
                title: kind == .channel ? "Новости Luxora" : "Команда Luxora",
                role: role,
                memberCount: 2
            )]
        )
    }

    private func conversation(
        kind: ConversationKind,
        title: String,
        role: ChatMembershipRole,
        memberCount: Int
    ) -> Conversation {
        let avatar = participant(id: chatID, name: title, username: "luxora-community")
        return Conversation(
            id: chatID,
            title: title,
            subtitle: "Нет сообщений",
            kind: kind,
            avatar: avatar,
            memberCount: memberCount,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: updatedDate,
            folder: "work",
            serverRole: role.rawValue
        )
    }

    private func baseMembers() -> [CommunityMember] {
        [
            communityMember(userID: ownerID, role: .owner, name: "Flenym", username: "flenym"),
            communityMember(userID: memberID, role: .member, name: "Егор", username: "egor"),
        ]
    }

    private func communityMember(
        userID: UUID,
        role: ChatMembershipRole,
        revision: Int = 1,
        name: String,
        username: String
    ) -> CommunityMember {
        CommunityMember(
            membership: membership(userID: userID, role: role, revision: revision),
            participant: participant(id: userID, name: name, username: username)
        )
    }

    private func membership(
        chatID: UUID? = nil,
        userID: UUID,
        role: ChatMembershipRole,
        revision: Int,
        joinedAt: Date? = nil,
        updatedAt: Date? = nil
    ) -> ChatMembership {
        ChatMembership(
            chatID: chatID ?? self.chatID,
            userID: userID,
            role: role,
            revision: revision,
            joinedAt: joinedAt ?? joinedDate,
            updatedAt: updatedAt ?? joinedDate
        )
    }

    private func participant(id: UUID, name: String, username: String) -> Participant {
        Participant(
            id: id,
            displayName: name,
            username: username,
            initials: String(name.prefix(1)).uppercased(),
            accentHex: "2F1893",
            isOnline: false,
            status: "@\(username)"
        )
    }

    private func configure(
        _ store: CommunityStore,
        creator: @escaping @Sendable (CommunityKind, String, [UUID]) async throws -> Conversation = { _, _, _ in
            throw CommunityStoreError.unavailable("creator")
        },
        communityLoader: @escaping @Sendable (UUID) async throws -> Conversation = { _ in
            throw CommunityStoreError.unavailable("community loader")
        },
        memberLoader: @escaping @Sendable (UUID) async throws -> [CommunityMember] = { _ in
            throw CommunityStoreError.unavailable("member loader")
        },
        exactUserLookup: @escaping @Sendable (String) async throws -> Participant? = { _ in nil },
        memberAdder: @escaping @Sendable (UUID, UUID, ChatMembershipRole, UUID) async throws -> CommunityMembershipMutationReceipt = { _, _, _, _ in
            throw CommunityStoreError.unavailable("member adder")
        },
        memberRoleUpdater: @escaping @Sendable (UUID, UUID, ChatMembershipRole, Int, UUID) async throws -> CommunityMembershipMutationReceipt = { _, _, _, _, _ in
            throw CommunityStoreError.unavailable("role updater")
        },
        memberRemover: @escaping @Sendable (UUID, UUID, Int, UUID) async throws -> CommunityMembershipMutationReceipt = { _, _, _, _ in
            throw CommunityStoreError.unavailable("member remover")
        }
    ) {
        store.configureRemote(
            creator: creator,
            communityLoader: communityLoader,
            memberLoader: memberLoader,
            exactUserLookup: exactUserLookup,
            memberAdder: memberAdder,
            memberRoleUpdater: memberRoleUpdater,
            memberRemover: memberRemover
        )
    }
}

private actor CommunityCreationProbe {
    private let confirmed: Conversation
    private(set) var callCount = 0

    init(confirmed: Conversation) {
        self.confirmed = confirmed
    }

    func create(kind: CommunityKind, title: String, memberIDs: [UUID]) throws -> Conversation {
        callCount += 1
        if callCount == 1 {
            throw LuxoraAPIError.server(status: 409, code: "CONFLICT", message: "definitive")
        }
        return confirmed
    }
}

private actor CommunityMemberPageProbe {
    private var page: [CommunityMember]

    init(page: [CommunityMember]) {
        self.page = page
    }

    func load() -> [CommunityMember] { page }
    func replace(with page: [CommunityMember]) { self.page = page }
}

private actor CommunityAddProbe {
    private let receipt: CommunityMembershipMutationReceipt
    private(set) var nonces: [UUID] = []
    private(set) var hasConfirmedMutation = false

    init(receipt: CommunityMembershipMutationReceipt) {
        self.receipt = receipt
    }

    func add(
        chatID: UUID,
        userID: UUID,
        role: ChatMembershipRole,
        nonce: UUID
    ) throws -> CommunityMembershipMutationReceipt {
        nonces.append(nonce)
        if nonces.count == 1 {
            throw LuxoraAPIError.transport("response lost")
        }
        hasConfirmedMutation = true
        return CommunityMembershipMutationReceipt(membership: receipt.membership, replayed: true)
    }
}
