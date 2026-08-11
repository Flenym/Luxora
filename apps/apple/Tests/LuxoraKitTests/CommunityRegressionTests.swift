import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class CommunityRegressionTests: XCTestCase {
    private let chatID = UUID(uuidString: "A1000000-0000-4000-8000-000000000001")!
    private let ownerID = UUID(uuidString: "A2000000-0000-4000-8000-000000000002")!
    private let memberID = UUID(uuidString: "A3000000-0000-4000-8000-000000000003")!

    func testMemberProjectionUpdatesOnlyMetadataAndPreservesInboxTruth() {
        var chat = conversation(role: .owner, memberCount: 2)
        chat.subtitle = "Новый preview после realtime"
        chat.unreadCount = 9
        chat.isArchived = true
        chat.isMuted = true
        chat.isTyping = true
        chat.lastActivity = Date(timeIntervalSince1970: 900)
        let messenger = MessengerStore(
            conversations: [chat],
            messagesByConversation: [:],
            currentUser: participant(ownerID, name: "Owner")
        )

        messenger.applyConfirmedCommunityMetadata(
            chatID: chatID,
            memberCount: 3,
            serverRole: ChatMembershipRole.member.rawValue
        )
        let projected = messenger.conversations[0]
        XCTAssertEqual(projected.memberCount, 3)
        XCTAssertEqual(projected.serverRole, "member")
        XCTAssertEqual(projected.subtitle, "Новый preview после realtime")
        XCTAssertEqual(projected.unreadCount, 9)
        XCTAssertTrue(projected.isArchived)
        XCTAssertTrue(projected.isMuted)
        XCTAssertTrue(projected.isTyping)
        XCTAssertEqual(projected.lastActivity, Date(timeIntervalSince1970: 900))
    }

    func testDelayedMemberGETCannotRollbackRealtimeRoleRevision() async throws {
        let revisionOne = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let loader = CommunityPageSequence(first: revisionOne, suspended: revisionOne)
        let store = communityStore(loader: { _ in try await loader.load() })
        await store.loadMembers(chatID)
        XCTAssertEqual(store.currentUserRole(in: chatID), .owner)

        let delayed = Task { await store.loadMembers(chatID, force: true) }
        await loader.waitUntilSuspendedStarted()
        try store.acceptConfirmedMembershipSignal(
            membership(userID: ownerID, role: .member, revision: 2),
            change: .roleUpdated
        )
        XCTAssertEqual(store.currentUserRole(in: chatID), .member)

        await loader.releaseSuspended()
        await delayed.value
        XCTAssertEqual(store.currentUserRole(in: chatID), .member)
        XCTAssertEqual(store.members(chatID).first(where: { $0.id == ownerID })?.membership.revision, 2)
        XCTAssertEqual(store.memberListState(chatID), .loaded)
    }

    func testRemovedMembershipTombstoneRejectsStalePageResurrection() async throws {
        let page = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let loader = CommunityPageSequence(first: page, suspended: page)
        let store = communityStore(loader: { _ in try await loader.load() })
        await store.loadMembers(chatID)
        XCTAssertTrue(store.containsMember(memberID, in: chatID))

        try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .member, revision: 2),
            change: .removed
        )
        XCTAssertFalse(store.containsMember(memberID, in: chatID))

        let delayed = Task { await store.loadMembers(chatID, force: true) }
        await loader.waitUntilSuspendedStarted()
        await loader.releaseSuspended()
        await delayed.value
        XCTAssertFalse(store.containsMember(memberID, in: chatID))
    }

    func testMessengerHistoricalMembershipReplayCannotReopenChannelComposer() {
        var channel = conversation(role: .owner, memberCount: 2)
        channel.kind = .channel
        let messenger = MessengerStore(
            conversations: [channel],
            messagesByConversation: [:],
            currentUser: participant(ownerID, name: "Owner")
        )

        XCTAssertFalse(messenger.applyRealtimeMembership(
            realtimeEvent(userID: ownerID, role: .member, revision: 2),
            currentUserID: ownerID
        ))
        XCTAssertEqual(messenger.conversations[0].serverRole, "member")
        XCTAssertFalse(messenger.applyRealtimeMembership(
            realtimeEvent(userID: ownerID, role: .owner, revision: 1),
            currentUserID: ownerID
        ))
        XCTAssertEqual(messenger.conversations[0].serverRole, "member")
    }

    func testRoleReceiptRemainsValidWhenRealtimeArrivesBeforeHTTPResponse() async {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let promotedMembership = membership(userID: memberID, role: .admin, revision: 2)
        let promotedPage = initial.map { member in
            guard member.id == memberID else { return member }
            return CommunityMember(membership: promotedMembership, participant: member.participant)
        }
        let pages = CommunityPageQueue([initial, promotedPage])
        var store: CommunityStore!
        store = communityStore(
            loader: { _ in try await pages.next() },
            roleUpdater: { [weak store] _, _, _, _, _ in
                let receipt = CommunityMembershipMutationReceipt(
                    membership: promotedMembership,
                    replayed: false
                )
                try await MainActor.run {
                    try store?.acceptConfirmedMembershipSignal(
                        promotedMembership,
                        change: .roleUpdated,
                        causalSequence: 20
                    )
                }
                return receipt
            }
        )
        await store.loadMembers(chatID)

        let changed = await store.changeRole(of: memberID, to: .admin, in: chatID)
        XCTAssertTrue(changed)
        XCTAssertEqual(store.members(chatID).first(where: { $0.id == memberID })?.membership, promotedMembership)
    }

    func testRemoveReceiptRemainsValidWhenRealtimeArrivesBeforeHTTPResponse() async {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let removedMembership = membership(userID: memberID, role: .member, revision: 2)
        let remaining = initial.filter { $0.id != memberID }
        let pages = CommunityPageQueue([initial, remaining])
        var store: CommunityStore!
        store = communityStore(
            loader: { _ in try await pages.next() },
            remover: { [weak store] _, _, _, _ in
                let receipt = CommunityMembershipMutationReceipt(
                    membership: removedMembership,
                    replayed: false
                )
                try await MainActor.run {
                    try store?.acceptConfirmedMembershipSignal(
                        removedMembership,
                        change: .removed,
                        causalSequence: 30
                    )
                }
                return receipt
            }
        )
        await store.loadMembers(chatID)

        let removed = await store.removeMember(memberID, from: chatID)
        XCTAssertTrue(removed)
        XCTAssertFalse(store.containsMember(memberID, in: chatID))
        XCTAssertEqual(store.community(chatID)?.memberCount, 1)
    }

    func testOrderedRemoveThenGloballyNewerReaddOpensLifecycleAndStaleRevisionOneIsRejected() async throws {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let newJoinedAt = Date(timeIntervalSince1970: 4)
        let readded = membership(
            userID: memberID,
            role: .member,
            revision: 3,
            joinedAt: newJoinedAt,
            updatedAt: newJoinedAt
        )
        let readdedPage = initial.map { member in
            guard member.id == memberID else { return member }
            return CommunityMember(membership: readded, participant: member.participant)
        }
        let pages = CommunityPageQueue([initial, readdedPage])
        let store = communityStore(loader: { _ in try await pages.next() })
        await store.loadMembers(chatID)

        try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .member, revision: 2),
            change: .removed,
            causalSequence: 40
        )
        XCTAssertThrowsError(try store.acceptConfirmedMembershipSignal(
            membership(
                userID: memberID,
                role: .member,
                revision: 1,
                joinedAt: newJoinedAt,
                updatedAt: newJoinedAt
            ),
            change: .added,
            causalSequence: 41
        ))
        XCTAssertThrowsError(try store.acceptConfirmedMembershipSignal(
            membership(
                userID: memberID,
                role: .member,
                revision: 2,
                joinedAt: newJoinedAt,
                updatedAt: newJoinedAt
            ),
            change: .added,
            causalSequence: 41
        ))
        try store.acceptConfirmedMembershipSignal(
            readded,
            change: .added,
            causalSequence: 42
        )
        await store.loadMembers(chatID, force: true)

        XCTAssertEqual(store.members(chatID).first(where: { $0.id == memberID })?.membership, readded)
        XCTAssertEqual(store.community(chatID)?.memberCount, 2)
        let promoted = membership(
            userID: memberID,
            role: .admin,
            revision: 4,
            joinedAt: newJoinedAt,
            updatedAt: Date(timeIntervalSince1970: 5)
        )
        try store.acceptConfirmedMembershipSignal(
            promoted,
            change: .roleUpdated,
            causalSequence: 43
        )
        XCTAssertEqual(store.members(chatID).first(where: { $0.id == memberID })?.membership, promoted)
    }

    func testNoncedReaddReceiptRevisionThreeAuthorizesCanonicalPage() async throws {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let candidate = try XCTUnwrap(initial.first(where: { $0.id == memberID })?.participant)
        let joinedAt = Date(timeIntervalSince1970: 4)
        let readded = membership(
            userID: memberID,
            role: .member,
            revision: 3,
            joinedAt: joinedAt,
            updatedAt: joinedAt
        )
        let page = initial.map { member in
            guard member.id == memberID else { return member }
            return CommunityMember(membership: readded, participant: member.participant)
        }
        let pages = CommunityPageQueue([initial, page])
        let store = communityStore(
            loader: { _ in try await pages.next() },
            adder: { _, _, _, _ in
                CommunityMembershipMutationReceipt(membership: readded, replayed: false)
            }
        )
        await store.loadMembers(chatID)
        try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .member, revision: 2),
            change: .removed,
            causalSequence: 44
        )

        let added = await store.addMember(candidate, to: chatID)
        XCTAssertTrue(added)
        XCTAssertEqual(store.members(chatID).first(where: { $0.id == memberID })?.membership, readded)
        XCTAssertEqual(store.community(chatID)?.memberCount, 2)
    }

    func testSkippedRemovalEventAllowsNewerPageAfterSyntheticOmissionTombstone() async throws {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let remaining = initial.filter { $0.id != memberID }
        let joinedAt = Date(timeIntervalSince1970: 4)
        let readdedMembership = membership(
            userID: memberID,
            role: .member,
            revision: 3,
            joinedAt: joinedAt,
            updatedAt: joinedAt
        )
        let readded = initial.map { member in
            guard member.id == memberID else { return member }
            return CommunityMember(
                membership: readdedMembership,
                participant: member.participant
            )
        }
        let pages = CommunityPageQueue([initial, remaining, readded])
        let store = communityStore(loader: { _ in try await pages.next() })
        await store.loadMembers(chatID)

        try store.acceptConfirmedCommunity(conversation(role: .owner, memberCount: 1))
        await store.loadMembers(chatID, force: true)
        XCTAssertFalse(store.containsMember(memberID, in: chatID))

        try store.acceptConfirmedCommunity(conversation(role: .owner, memberCount: 2))
        await store.loadMembers(chatID, force: true)
        XCTAssertEqual(
            store.members(chatID).first(where: { $0.id == memberID })?.membership,
            readdedMembership
        )
    }

    func testRemovedLifecycleRejectsHigherRoleSecondRemovalAndSameJoinedPage() async throws {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let invalidActive = replacingMember(in: initial, role: .admin, revision: 3)
        let pages = CommunityPageQueue([initial, invalidActive])
        let store = communityStore(loader: { _ in try await pages.next() })
        await store.loadMembers(chatID)
        try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .member, revision: 2),
            change: .removed,
            causalSequence: 46
        )

        XCTAssertThrowsError(try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .admin, revision: 3),
            change: .roleUpdated,
            causalSequence: 47
        ))
        XCTAssertThrowsError(try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .member, revision: 3),
            change: .removed,
            causalSequence: 47
        ))

        try store.acceptConfirmedCommunity(conversation(role: .owner, memberCount: 2))
        await store.loadMembers(chatID, force: true)
        XCTAssertFalse(store.containsMember(memberID, in: chatID))
        guard case .failed = store.memberListState(chatID) else {
            return XCTFail("Same joinedAt cannot reactivate a removed lifecycle")
        }
    }

    func testAddReceiptCannotRollbackNewerEventBeforeResponseFence() async throws {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let candidate = try XCTUnwrap(initial.first(where: { $0.id == memberID })?.participant)
        let ownerOnly = initial.filter { $0.id != memberID }
        let joinedAt = Date(timeIntervalSince1970: 4)
        let addedMembership = membership(
            userID: memberID,
            role: .member,
            revision: 3,
            joinedAt: joinedAt,
            updatedAt: joinedAt
        )
        let promotedMembership = membership(
            userID: memberID,
            role: .admin,
            revision: 4,
            joinedAt: joinedAt,
            updatedAt: Date(timeIntervalSince1970: 5)
        )
        let promotedPage = ownerOnly + [
            CommunityMember(membership: promotedMembership, participant: candidate),
        ]
        let pages = CommunityPageQueue([initial, promotedPage])
        var store: CommunityStore!
        store = communityStore(
            loader: { _ in try await pages.next() },
            adder: { [weak store] _, _, _, _ in
                try await MainActor.run {
                    try store?.acceptConfirmedMembershipSignal(
                        addedMembership,
                        change: .added,
                        causalSequence: 48
                    )
                    try store?.acceptConfirmedMembershipSignal(
                        promotedMembership,
                        change: .roleUpdated,
                        causalSequence: 49
                    )
                }
                return CommunityMembershipMutationReceipt(
                    membership: addedMembership,
                    replayed: false
                )
            }
        )
        await store.loadMembers(chatID)
        try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .member, revision: 2),
            change: .removed,
            causalSequence: 47
        )

        let added = await store.addMember(candidate, to: chatID)
        XCTAssertTrue(added)
        XCTAssertEqual(
            store.members(chatID).first(where: { $0.id == memberID })?.membership,
            promotedMembership
        )
    }

    func testExactAddRetrySurvivesCausalSequenceEnrichmentOfSameTombstone() async throws {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let candidate = try XCTUnwrap(initial.first(where: { $0.id == memberID })?.participant)
        let joinedAt = Date(timeIntervalSince1970: 4)
        let readdedMembership = membership(
            userID: memberID,
            role: .member,
            revision: 3,
            joinedAt: joinedAt,
            updatedAt: joinedAt
        )
        let readded = initial.map { member in
            guard member.id == memberID else { return member }
            return CommunityMember(membership: readdedMembership, participant: member.participant)
        }
        let pages = CommunityPageQueue([initial, readded])
        let probe = CommunityAddRetryProbe(receipt: CommunityMembershipMutationReceipt(
            membership: readdedMembership,
            replayed: true
        ))
        let store = communityStore(
            loader: { _ in try await pages.next() },
            adder: { _, _, _, _ in try await probe.add() }
        )
        await store.loadMembers(chatID)
        let tombstone = membership(userID: memberID, role: .member, revision: 2)
        try store.acceptConfirmedMembershipSignal(
            tombstone,
            change: .removed,
            causalSequence: 80
        )

        let firstAttempt = await store.addMember(candidate, to: chatID)
        XCTAssertFalse(firstAttempt)
        try store.acceptConfirmedMembershipSignal(
            tombstone,
            change: .removed,
            causalSequence: 81
        )
        let key = CommunityMemberMutationKey(
            chatID: chatID,
            userID: memberID,
            kind: .add
        )
        let retried = await store.retryMutation(key)
        XCTAssertTrue(retried)
        XCTAssertEqual(
            store.members(chatID).first(where: { $0.id == memberID })?.membership,
            readdedMembership
        )
    }

    func testDelayedSelfRemoveReceiptCannotDeleteCausallyReaddedCommunity() async throws {
        let selfMembership = membership(userID: memberID, role: .member, revision: 1)
        let ownerMembership = membership(userID: ownerID, role: .owner, revision: 1)
        let initial = [
            CommunityMember(membership: ownerMembership, participant: participant(ownerID, name: "Owner")),
            CommunityMember(membership: selfMembership, participant: participant(memberID, name: "Member")),
        ]
        let joinedAt = Date(timeIntervalSince1970: 4)
        let readdedMembership = membership(
            userID: memberID,
            role: .member,
            revision: 3,
            joinedAt: joinedAt,
            updatedAt: joinedAt
        )
        let canonical = [
            initial[0],
            CommunityMember(membership: readdedMembership, participant: initial[1].participant),
        ]
        let removalReceipt = membership(userID: memberID, role: .member, revision: 2)
        let readdedConversation = conversation(role: .member, memberCount: 2)
        let pages = CommunityPageQueue([initial, canonical])
        let store = CommunityStore(
            currentUserID: memberID,
            communities: [conversation(role: .member, memberCount: 2)]
        )
        store.configureRemote(
            creator: { _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall },
            communityLoader: { _ in throw CommunityRegressionHarnessError.unexpectedCall },
            memberLoader: { _ in try await pages.next() },
            exactUserLookup: { _ in nil },
            memberAdder: { _, _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall },
            memberRoleUpdater: { _, _, _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall },
            memberRemover: { [weak store] _, _, _, _ in
                try await MainActor.run {
                    try store?.acceptConfirmedMembershipSignal(
                        removalReceipt,
                        change: .removed,
                        causalSequence: 70
                    )
                    try store?.acceptConfirmedCommunity(readdedConversation)
                    try store?.acceptConfirmedMembershipSignal(
                        readdedMembership,
                        change: .added,
                        causalSequence: 71
                    )
                }
                return CommunityMembershipMutationReceipt(
                    membership: removalReceipt,
                    replayed: false
                )
            }
        )
        await store.loadMembers(chatID)

        let removed = await store.removeMember(memberID, from: chatID)
        XCTAssertTrue(removed)
        XCTAssertNotNil(store.community(chatID))
        XCTAssertEqual(
            store.members(chatID).first(where: { $0.id == memberID })?.membership,
            readdedMembership
        )
    }

    func testMessengerOrderedRemoveThenGloballyNewerReaddReplacesLifecycleFence() {
        let messenger = MessengerStore(
            conversations: [conversation(role: .owner, memberCount: 2)],
            messagesByConversation: [:],
            currentUser: participant(ownerID, name: "Owner")
        )
        XCTAssertFalse(messenger.applyRealtimeMembership(
            realtimeEvent(
                userID: memberID,
                role: .member,
                revision: 2,
                change: .removed
            ),
            currentUserID: ownerID,
            causalSequence: 50
        ))
        XCTAssertTrue(messenger.applyRealtimeMembership(
            realtimeEvent(
                userID: memberID,
                role: .admin,
                revision: 3,
                change: .roleUpdated
            ),
            currentUserID: ownerID,
            causalSequence: 51
        ))
        XCTAssertTrue(messenger.applyRealtimeMembership(
            realtimeEvent(
                userID: memberID,
                role: .member,
                revision: 3,
                change: .removed
            ),
            currentUserID: ownerID,
            causalSequence: 51
        ))
        let newJoinedAt = Date(timeIntervalSince1970: 4)
        XCTAssertTrue(messenger.applyRealtimeMembership(
            realtimeEvent(
                userID: memberID,
                role: .member,
                revision: 1,
                change: .added,
                joinedAt: newJoinedAt,
                updatedAt: newJoinedAt
            ),
            currentUserID: ownerID,
            causalSequence: 51
        ))
        XCTAssertEqual(messenger.conversations[0].memberCount, 1)
        XCTAssertTrue(messenger.applyRealtimeMembership(
            realtimeEvent(
                userID: memberID,
                role: .member,
                revision: 2,
                change: .added,
                joinedAt: newJoinedAt,
                updatedAt: newJoinedAt
            ),
            currentUserID: ownerID,
            causalSequence: 51
        ))
        XCTAssertEqual(messenger.conversations[0].memberCount, 1)
        XCTAssertFalse(messenger.applyRealtimeMembership(
            realtimeEvent(
                userID: memberID,
                role: .member,
                revision: 3,
                change: .added,
                joinedAt: newJoinedAt,
                updatedAt: newJoinedAt
            ),
            currentUserID: ownerID,
            causalSequence: 52
        ))
        XCTAssertEqual(messenger.conversations[0].memberCount, 2)
        XCTAssertFalse(messenger.applyRealtimeMembership(
            realtimeEvent(
                userID: memberID,
                role: .admin,
                revision: 4,
                change: .roleUpdated,
                joinedAt: newJoinedAt,
                updatedAt: Date(timeIntervalSince1970: 5)
            ),
            currentUserID: ownerID,
            causalSequence: 53
        ))
        XCTAssertEqual(messenger.conversations[0].memberCount, 2)
    }

    func testNewestOverlappingForcedMemberLoadWinsPerChat() async {
        let initial = members(ownerRole: .owner, ownerRevision: 1, includesMember: true)
        let older = replacingMember(in: initial, role: .member, revision: 2)
        let newer = replacingMember(in: initial, role: .admin, revision: 3)
        let probe = OverlappingCommunityPageProbe(initial: initial, older: older, newer: newer)
        let store = communityStore(loader: { _ in try await probe.load() })
        await store.loadMembers(chatID)

        let olderTask = Task { await store.loadMembers(chatID, force: true) }
        await probe.waitUntilStarted(call: 2)
        let newerTask = Task { await store.loadMembers(chatID, force: true) }
        await probe.waitUntilStarted(call: 3)
        await probe.release(call: 3)
        await newerTask.value
        await probe.release(call: 2)
        await olderTask.value

        let member = store.members(chatID).first(where: { $0.id == memberID })
        XCTAssertEqual(member?.membership.role, .admin)
        XCTAssertEqual(member?.membership.revision, 3)
        XCTAssertEqual(store.memberListState(chatID), .loaded)
    }

    func testDelayedCommunityDetailPreservesNewMembershipAndMessengerInboxFields() async throws {
        var stale = conversation(role: .owner, memberCount: 2)
        stale.title = "Новое серверное название"
        stale.subtitle = "Устаревший preview"
        stale.unreadCount = 0
        stale.isArchived = false
        stale.isMuted = false
        stale.isTyping = false
        stale.lastActivity = Date(timeIntervalSince1970: 2)
        let detail = SuspendedCommunityDetail(stale)
        let store = communityStore(loader: { _ in throw CommunityRegressionHarnessError.unexpectedCall })
        store.configureRemote(
            creator: { _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall },
            communityLoader: { _ in try await detail.load() },
            memberLoader: { _ in throw CommunityRegressionHarnessError.unexpectedCall },
            exactUserLookup: { _ in nil },
            memberAdder: { _, _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall },
            memberRoleUpdater: { _, _, _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall },
            memberRemover: { _, _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall }
        )

        var inbox = conversation(role: .owner, memberCount: 2)
        inbox.subtitle = "Свежий preview"
        inbox.unreadCount = 8
        inbox.isArchived = true
        inbox.isMuted = true
        inbox.isTyping = true
        inbox.lastActivity = Date(timeIntervalSince1970: 900)
        let messenger = MessengerStore(
            conversations: [inbox],
            messagesByConversation: [:],
            currentUser: participant(ownerID, name: "Owner")
        )
        store.configureProjectionObservers(
            communityUpdated: { messenger.applyConfirmedCommunityIdentity($0) },
            communityRemoved: { _ in },
            communityMetadataUpdated: { chatID, count, role in
                messenger.applyConfirmedCommunityMetadata(
                    chatID: chatID,
                    memberCount: count,
                    serverRole: role
                )
            }
        )

        let refresh = Task { await store.refreshCommunity(chatID) }
        await detail.waitUntilStarted()
        try store.acceptConfirmedMembershipSignal(
            membership(userID: memberID, role: .member, revision: 2),
            change: .removed,
            causalSequence: 60
        )
        try store.acceptConfirmedMembershipSignal(
            membership(userID: ownerID, role: .member, revision: 2),
            change: .roleUpdated,
            causalSequence: 61
        )
        await detail.release()
        await refresh.value

        XCTAssertEqual(store.community(chatID)?.memberCount, 1)
        XCTAssertEqual(store.community(chatID)?.serverRole, "member")
        let projected = messenger.conversations[0]
        XCTAssertEqual(projected.title, "Новое серверное название")
        XCTAssertEqual(projected.memberCount, 1)
        XCTAssertEqual(projected.serverRole, "member")
        XCTAssertEqual(projected.subtitle, "Свежий preview")
        XCTAssertEqual(projected.unreadCount, 8)
        XCTAssertTrue(projected.isArchived)
        XCTAssertTrue(projected.isMuted)
        XCTAssertTrue(projected.isTyping)
        XCTAssertEqual(projected.lastActivity, Date(timeIntervalSince1970: 900))
    }

    private func communityStore(
        loader: @escaping @Sendable (UUID) async throws -> [CommunityMember],
        adder: @escaping @Sendable (UUID, UUID, ChatMembershipRole, UUID) async throws -> CommunityMembershipMutationReceipt = { _, _, _, _ in
            throw CommunityRegressionHarnessError.unexpectedCall
        },
        roleUpdater: @escaping @Sendable (UUID, UUID, ChatMembershipRole, Int, UUID) async throws -> CommunityMembershipMutationReceipt = { _, _, _, _, _ in
            throw CommunityRegressionHarnessError.unexpectedCall
        },
        remover: @escaping @Sendable (UUID, UUID, Int, UUID) async throws -> CommunityMembershipMutationReceipt = { _, _, _, _ in
            throw CommunityRegressionHarnessError.unexpectedCall
        }
    ) -> CommunityStore {
        let store = CommunityStore(
            currentUserID: ownerID,
            communities: [conversation(role: .owner, memberCount: 2)]
        )
        store.configureRemote(
            creator: { _, _, _ in throw CommunityRegressionHarnessError.unexpectedCall },
            communityLoader: { _ in throw CommunityRegressionHarnessError.unexpectedCall },
            memberLoader: loader,
            exactUserLookup: { _ in nil },
            memberAdder: adder,
            memberRoleUpdater: roleUpdater,
            memberRemover: remover
        )
        return store
    }

    private func replacingMember(
        in page: [CommunityMember],
        role: ChatMembershipRole,
        revision: Int
    ) -> [CommunityMember] {
        page.map { member in
            guard member.id == memberID else { return member }
            return CommunityMember(
                membership: membership(userID: memberID, role: role, revision: revision),
                participant: member.participant
            )
        }
    }

    private func members(
        ownerRole: ChatMembershipRole,
        ownerRevision: Int,
        includesMember: Bool
    ) -> [CommunityMember] {
        var page = [
            CommunityMember(
                membership: membership(
                    userID: ownerID,
                    role: ownerRole,
                    revision: ownerRevision
                ),
                participant: participant(ownerID, name: "Owner")
            ),
        ]
        if includesMember {
            page.append(CommunityMember(
                membership: membership(userID: memberID, role: .member, revision: 1),
                participant: participant(memberID, name: "Member")
            ))
        }
        return page
    }

    private func membership(
        userID: UUID,
        role: ChatMembershipRole,
        revision: Int,
        joinedAt: Date = Date(timeIntervalSince1970: 1),
        updatedAt: Date? = nil
    ) -> ChatMembership {
        ChatMembership(
            chatID: chatID,
            userID: userID,
            role: role,
            revision: revision,
            joinedAt: joinedAt,
            updatedAt: updatedAt ?? Date(timeIntervalSince1970: TimeInterval(revision + 1))
        )
    }

    private func realtimeEvent(
        userID: UUID,
        role: ChatMembershipRole,
        revision: Int,
        change: RealtimeChatMembershipEvent.Change = .roleUpdated,
        joinedAt: Date = Date(timeIntervalSince1970: 1),
        updatedAt: Date? = nil
    ) -> RealtimeChatMembershipEvent {
        let membership = membership(
            userID: userID,
            role: role,
            revision: revision,
            joinedAt: joinedAt,
            updatedAt: updatedAt
        )
        return RealtimeChatMembershipEvent(
            audience: .memberAccount,
            change: change,
            membership: APIChatMembership(
                chatId: membership.chatID,
                userId: membership.userID,
                role: membership.role.rawValue,
                revision: membership.revision,
                joinedAt: membership.joinedAt,
                updatedAt: membership.updatedAt
            ),
            actorUserID: ownerID,
            changedAt: membership.updatedAt
        )
    }

    private func conversation(
        role: ChatMembershipRole,
        memberCount: Int
    ) -> Conversation {
        Conversation(
            id: chatID,
            title: "Команда",
            subtitle: "Старый preview",
            kind: .group,
            avatar: participant(chatID, name: "Команда"),
            memberCount: memberCount,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: Date(timeIntervalSince1970: 1),
            folder: "work",
            serverRole: role.rawValue
        )
    }

    private func participant(_ id: UUID, name: String) -> Participant {
        Participant(
            id: id,
            displayName: name,
            username: name.lowercased(),
            initials: String(name.prefix(1)),
            accentHex: "#5B5FF0",
            isOnline: false,
            status: ""
        )
    }
}

private actor CommunityPageSequence {
    private let first: [CommunityMember]
    private let suspended: [CommunityMember]
    private var calls = 0
    private var suspendedStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(first: [CommunityMember], suspended: [CommunityMember]) {
        self.first = first
        self.suspended = suspended
    }

    func load() async throws -> [CommunityMember] {
        calls += 1
        guard calls > 1 else { return first }
        suspendedStarted = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return suspended
    }

    func waitUntilSuspendedStarted() async {
        guard !suspendedStarted else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func releaseSuspended() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor CommunityPageQueue {
    private var pages: [[CommunityMember]]

    init(_ pages: [[CommunityMember]]) {
        self.pages = pages
    }

    func next() throws -> [CommunityMember] {
        guard !pages.isEmpty else { throw CommunityRegressionHarnessError.unexpectedCall }
        return pages.removeFirst()
    }
}

private actor CommunityAddRetryProbe {
    private let receipt: CommunityMembershipMutationReceipt
    private var calls = 0

    init(receipt: CommunityMembershipMutationReceipt) {
        self.receipt = receipt
    }

    func add() throws -> CommunityMembershipMutationReceipt {
        calls += 1
        if calls == 1 { throw LuxoraAPIError.transport("lost response") }
        return receipt
    }
}

private actor OverlappingCommunityPageProbe {
    private let initial: [CommunityMember]
    private let older: [CommunityMember]
    private let newer: [CommunityMember]
    private var calls = 0
    private var started = Set<Int>()
    private var startWaiters: [Int: [CheckedContinuation<Void, Never>]] = [:]
    private var releaseWaiters: [Int: CheckedContinuation<Void, Never>] = [:]

    init(initial: [CommunityMember], older: [CommunityMember], newer: [CommunityMember]) {
        self.initial = initial
        self.older = older
        self.newer = newer
    }

    func load() async throws -> [CommunityMember] {
        calls += 1
        let call = calls
        guard call > 1 else { return initial }
        started.insert(call)
        startWaiters.removeValue(forKey: call)?.forEach { $0.resume() }
        await withCheckedContinuation { releaseWaiters[call] = $0 }
        return call == 2 ? older : newer
    }

    func waitUntilStarted(call: Int) async {
        guard !started.contains(call) else { return }
        await withCheckedContinuation { startWaiters[call, default: []].append($0) }
    }

    func release(call: Int) {
        releaseWaiters.removeValue(forKey: call)?.resume()
    }
}

private actor SuspendedCommunityDetail {
    private let conversation: Conversation
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(_ conversation: Conversation) {
        self.conversation = conversation
    }

    func load() async throws -> Conversation {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return conversation
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private enum CommunityRegressionHarnessError: Error {
    case unexpectedCall
}
