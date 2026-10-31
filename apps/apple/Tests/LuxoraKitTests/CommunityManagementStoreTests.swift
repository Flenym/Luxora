import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class CommunityManagementStoreTests: XCTestCase {
    private let ownerID = UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!
    private let adminID = UUID(uuidString: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!
    private let memberID = UUID(uuidString: "cccccccc-cccc-4ccc-8ccc-cccccccccccc")!
    private let strangerID = UUID(uuidString: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")!
    private let chatID = UUID(uuidString: "dddddddd-dddd-4ddd-8ddd-dddddddddddd")!
    private let linkID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let requestID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let transferID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!

    // MARK: Role gating

    func testRoleGatingUsesCommunityRoleAndWiredTransport() {
        let ownerStore = makeManagementStore(role: .owner)
        XCTAssertTrue(ownerStore.isManager(chatID: chatID))
        XCTAssertFalse(ownerStore.canManageInviteLinks(chatID: chatID))
        XCTAssertFalse(ownerStore.canInitiateOwnershipTransfer(chatID: chatID))

        configure(ownerStore)

        XCTAssertTrue(ownerStore.canManageInviteLinks(chatID: chatID))
        XCTAssertTrue(ownerStore.canManageJoinRequests(chatID: chatID))
        XCTAssertTrue(ownerStore.canInitiateOwnershipTransfer(chatID: chatID))

        let adminStore = makeManagementStore(role: .admin)
        configure(adminStore)
        XCTAssertTrue(adminStore.isManager(chatID: chatID))
        XCTAssertTrue(adminStore.canManageInviteLinks(chatID: chatID))
        XCTAssertFalse(adminStore.canInitiateOwnershipTransfer(chatID: chatID))

        let memberStore = makeManagementStore(role: .member)
        configure(memberStore)
        XCTAssertFalse(memberStore.isManager(chatID: chatID))
        XCTAssertFalse(memberStore.canManageInviteLinks(chatID: chatID))
        XCTAssertFalse(memberStore.canManageJoinRequests(chatID: chatID))
        XCTAssertFalse(memberStore.canInitiateOwnershipTransfer(chatID: chatID))
    }

    func testUnavailableTransportIsReportedHonestlyAndNeverFakesState() async {
        let store = makeManagementStore(role: .owner)

        await store.loadInviteLinks(chatID: chatID)
        guard case let .failed(inviteDetail) = store.inviteListState(chatID: chatID) else {
            return XCTFail("Unwired invite loader must fail visibly")
        }
        XCTAssertTrue(inviteDetail.contains("не подключена"))

        await store.loadJoinRequests(chatID: chatID)
        guard case let .failed(requestDetail) = store.joinRequestListState(chatID: chatID) else {
            return XCTFail("Unwired join-request loader must fail visibly")
        }
        XCTAssertTrue(requestDetail.contains("не подключена"))

        await store.loadPendingOwnershipTransfer(chatID: chatID)
        guard case let .failed(transferDetail) = store.ownershipTransferState(chatID: chatID) else {
            return XCTFail("Unwired transfer loader must fail visibly")
        }
        XCTAssertTrue(transferDetail.contains("не подключена"))

        let initiated = await store.initiateOwnershipTransfer(chatID: chatID, targetUserID: memberID)
        XCTAssertFalse(initiated)
        XCTAssertNil(store.pendingTransfer(chatID: chatID))

        let joined = await store.joinByInvite(rawInput: String(repeating: "A", count: 43))
        XCTAssertNil(joined)
        guard case let .failed(joinDetail) = store.joinByLinkState else {
            return XCTFail("Unwired join must fail visibly")
        }
        XCTAssertTrue(joinDetail.contains("не подключено"))
    }

    // MARK: Invite links

    func testInviteCreateStoresShownOnceTokenAndUpsertsList() async {
        let creation = inviteCreation(token: token(seed: "A"))
        let probe = InviteCreationProbe(creation: creation)
        let store = makeManagementStore(role: .owner)
        configure(store, inviteCreator: { chatID, approvalRequired, expiresInSeconds, maxUses, nonce in
            try await probe.create(
                chatID: chatID,
                approvalRequired: approvalRequired,
                expiresInSeconds: expiresInSeconds,
                maxUses: maxUses,
                nonce: nonce
            )
        })

        let created = await store.createInviteLink(
            chatID: chatID,
            approvalRequired: true,
            expiresInSeconds: 86_400,
            maxUses: 25
        )

        XCTAssertTrue(created)
        XCTAssertEqual(store.lastCreatedInvite?.token, token(seed: "A"))
        XCTAssertEqual(store.inviteLinks(chatID: chatID).map(\.id), [linkID])
        XCTAssertEqual(store.inviteActionState(chatID: chatID), .loaded)
        XCTAssertFalse(store.canCreateInviteLink(chatID: chatID))
        let approvalFlags = await probe.approvalFlags
        let expirySeconds = await probe.expirySeconds
        let maxUsesValues = await probe.maxUsesValues
        let nonces = await probe.nonces
        XCTAssertEqual(approvalFlags.first, true)
        XCTAssertEqual(expirySeconds.first, Optional(86_400))
        XCTAssertEqual(maxUsesValues.first, Optional(25))
        XCTAssertEqual(nonces.count, 1)

        store.markCreatedInviteCopied()
        XCTAssertTrue(store.lastCreatedInviteWasCopied)
        store.clearCreatedInviteToken()
        XCTAssertNil(store.lastCreatedInvite)
        XCTAssertFalse(store.lastCreatedInviteWasCopied)
    }

    func testInviteCreationRetryReusesNonceAfterLostResponse() async {
        let creation = inviteCreation(token: token(seed: "B"))
        let probe = InviteCreationProbe(
            creation: creation,
            failuresBeforeSuccess: [.transport("response lost")]
        )
        let store = makeManagementStore(role: .owner)
        configure(store, inviteCreator: { chatID, approvalRequired, expiresInSeconds, maxUses, nonce in
            try await probe.create(
                chatID: chatID,
                approvalRequired: approvalRequired,
                expiresInSeconds: expiresInSeconds,
                maxUses: maxUses,
                nonce: nonce
            )
        })

        let created = await store.createInviteLink(
            chatID: chatID,
            approvalRequired: false,
            expiresInSeconds: nil,
            maxUses: nil
        )

        XCTAssertFalse(created)
        XCTAssertNil(store.lastCreatedInvite)
        XCTAssertTrue(store.canRetryInviteCreation(chatID: chatID))
        guard case let .failed(detail) = store.inviteActionState(chatID: chatID) else {
            return XCTFail("A lost response must be visible")
        }
        XCTAssertTrue(detail.contains("повтор безопасен"))

        let retried = await store.retryCreateInviteLink(chatID: chatID)

        XCTAssertTrue(retried)
        XCTAssertEqual(store.lastCreatedInvite?.token, token(seed: "B"))
        XCTAssertFalse(store.canRetryInviteCreation(chatID: chatID))
        let nonces = await probe.nonces
        XCTAssertEqual(nonces.count, 2)
        XCTAssertEqual(nonces.first, nonces.last)
    }

    func testInviteCreationDefinitiveConflictNeverOffersSameNonceRetry() async {
        let probe = InviteCreationProbe(
            creation: inviteCreation(token: token(seed: "C")),
            failuresBeforeSuccess: [
                .server(status: 409, code: "CONFLICT", message: "already created")
            ]
        )
        let store = makeManagementStore(role: .owner)
        configure(store, inviteCreator: { chatID, approvalRequired, expiresInSeconds, maxUses, nonce in
            try await probe.create(
                chatID: chatID,
                approvalRequired: approvalRequired,
                expiresInSeconds: expiresInSeconds,
                maxUses: maxUses,
                nonce: nonce
            )
        })

        let created = await store.createInviteLink(
            chatID: chatID,
            approvalRequired: false,
            expiresInSeconds: nil,
            maxUses: nil
        )

        XCTAssertFalse(created)
        XCTAssertNil(store.lastCreatedInvite)
        XCTAssertFalse(store.canRetryInviteCreation(chatID: chatID))
        guard case let .failed(detail) = store.inviteActionState(chatID: chatID) else {
            return XCTFail("A definite conflict must stay visible")
        }
        XCTAssertTrue(detail.contains("один раз"))
    }

    func testLoadInviteLinksIsManagerGatedAndRejectsInconsistentPages() async {
        let page = InviteLinkLoaderProbe()
        let store = makeManagementStore(role: .owner)
        configure(store, inviteLoader: { _ in try await page.load() })

        await page.enqueueFailure(.transport("offline"))
        await store.loadInviteLinks(chatID: chatID)
        guard case .failed = store.inviteListState(chatID: chatID) else {
            return XCTFail("Load failure must be visible")
        }

        await page.replace(items: [
            inviteLink(id: linkID, createdAt: updatedDate),
            inviteLink(
                id: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!,
                createdAt: joinedDate
            ),
        ], failures: [])
        await store.loadInviteLinks(chatID: chatID, force: true)

        XCTAssertEqual(store.inviteListState(chatID: chatID), .loaded)
        XCTAssertEqual(store.inviteLinks(chatID: chatID).count, 2)
        XCTAssertEqual(store.inviteLinks(chatID: chatID).first?.createdAt, updatedDate)

        await page.replace(items: [
            inviteLink(id: linkID, chatID: strangerID, createdAt: updatedDate)
        ], failures: [])
        await store.loadInviteLinks(chatID: chatID, force: true)
        guard case .failed = store.inviteListState(chatID: chatID) else {
            return XCTFail("A page for another chat must be rejected")
        }
        XCTAssertEqual(store.inviteLinks(chatID: chatID).count, 2)

        let memberStore = makeManagementStore(role: .member)
        let memberPage = InviteLinkLoaderProbe()
        configure(memberStore, inviteLoader: { _ in try await memberPage.load() })
        await memberStore.loadInviteLinks(chatID: chatID)
        guard case .failed = memberStore.inviteListState(chatID: chatID) else {
            return XCTFail("A member must not load invite links")
        }
        let memberLoadCalls = await memberPage.callCount
        XCTAssertEqual(memberLoadCalls, 0)
    }

    func testRevokeInviteLinkReflectsOnlyServerConfirmation() async {
        let revoked = inviteLink(id: linkID, revokedAt: updatedDate)
        let probe = RevokeProbe(revocation: CommunityInviteRevocation(invite: revoked, replayed: false))
        let store = makeManagementStore(role: .owner)
        configure(store, inviteRevoker: { chatID, linkID in
            try await probe.revoke(chatID: chatID, linkID: linkID)
        })

        let succeeded = await store.revokeInviteLink(chatID: chatID, linkID: linkID)

        XCTAssertTrue(succeeded)
        XCTAssertTrue(store.inviteLinks(chatID: chatID).contains(where: { $0.id == linkID && $0.isRevoked }))
        XCTAssertFalse(store.isRevokingInviteLink(linkID))

        let failingProbe = RevokeProbe(
            revocation: nil,
            failuresBeforeSuccess: [.transport("offline")]
        )
        let failingStore = makeManagementStore(role: .owner)
        configure(failingStore, inviteRevoker: { chatID, linkID in
            try await failingProbe.revoke(chatID: chatID, linkID: linkID)
        })
        await failingStore.loadInviteLinks(chatID: chatID)
        let failed = await failingStore.revokeInviteLink(chatID: chatID, linkID: linkID)
        XCTAssertFalse(failed)
        XCTAssertNotNil(failingStore.inviteActionError(chatID: chatID))
        XCTAssertFalse(failingStore.isRevokingInviteLink(linkID))
    }

    // MARK: Join requests

    func testJoinRequestApproveTransitionsAndRetryKeepsRequestPending() async {
        let page = JoinRequestLoaderProbe(items: [pendingJoinRequest()])
        let decisionProbe = JoinDecisionProbe(
            approveResult: decidedJoinDecision(state: .approved),
            failuresBeforeApprove: [.transport("response lost")]
        )
        let store = makeManagementStore(role: .owner)
        configure(
            store,
            joinRequestLoader: { _ in await page.load() },
            joinApprover: { chatID, requestID in
                try await decisionProbe.approve(chatID: chatID, requestID: requestID)
            }
        )

        await store.loadJoinRequests(chatID: chatID)
        XCTAssertEqual(store.pendingJoinRequests(chatID: chatID).count, 1)

        let approved = await store.approveJoinRequest(chatID: chatID, requestID: requestID)

        XCTAssertFalse(approved)
        XCTAssertEqual(store.pendingJoinRequests(chatID: chatID).count, 1)
        guard case .failed = store.joinDecisionState(requestID: requestID) else {
            return XCTFail("A lost approval response must stay visible")
        }
        XCTAssertTrue(store.canRetryJoinDecision(requestID: requestID))

        let retried = await store.retryJoinDecision(chatID: chatID, requestID: requestID)

        XCTAssertTrue(retried)
        XCTAssertEqual(store.joinDecisionState(requestID: requestID), .loaded)
        XCTAssertTrue(store.pendingJoinRequests(chatID: chatID).isEmpty)
        XCTAssertEqual(store.joinRequests(chatID: chatID).first?.state, .approved)
        let approveCalls = await decisionProbe.approveCalls
        XCTAssertEqual(approveCalls, 2)
    }

    func testJoinRequestDenyAndManagerOnlyGating() async {
        let page = JoinRequestLoaderProbe(items: [pendingJoinRequest()])
        let decisionProbe = JoinDecisionProbe(
            denyResult: decidedJoinDecision(state: .denied)
        )
        let store = makeManagementStore(role: .admin)
        configure(
            store,
            joinRequestLoader: { _ in await page.load() },
            joinDenier: { chatID, requestID in
                try await decisionProbe.deny(chatID: chatID, requestID: requestID)
            }
        )
        await store.loadJoinRequests(chatID: chatID)

        let denied = await store.denyJoinRequest(chatID: chatID, requestID: requestID)

        XCTAssertTrue(denied)
        XCTAssertTrue(store.pendingJoinRequests(chatID: chatID).isEmpty)
        XCTAssertEqual(store.joinRequests(chatID: chatID).first?.state, .denied)
        let denyCalls = await decisionProbe.denyCalls
        XCTAssertEqual(denyCalls, 1)

        let memberStore = makeManagementStore(role: .member)
        let memberProbe = JoinDecisionProbe(denyResult: decidedJoinDecision(state: .denied))
        configure(memberStore, joinDenier: { chatID, requestID in
            try await memberProbe.deny(chatID: chatID, requestID: requestID)
        })
        let memberDenied = await memberStore.denyJoinRequest(chatID: chatID, requestID: requestID)
        XCTAssertFalse(memberDenied)
        let memberDenyCalls = await memberProbe.denyCalls
        XCTAssertEqual(memberDenyCalls, 0)
    }

    // MARK: Ownership transfer

    func testOwnershipInitiationRetryReusesNonceAndShowsPendingCard() async {
        let transfer = ownershipTransfer()
        let probe = TransferInitiationProbe(
            receipt: CommunityOwnershipTransferReceipt(transfer: transfer, replayed: false),
            failuresBeforeSuccess: [.transport("response lost")]
        )
        let store = makeManagementStore(role: .owner)
        configure(store, transferInitiator: { chatID, targetUserID, nonce in
            try await probe.initiate(chatID: chatID, targetUserID: targetUserID, nonce: nonce)
        })

        let initiated = await store.initiateOwnershipTransfer(chatID: chatID, targetUserID: memberID)

        XCTAssertFalse(initiated)
        XCTAssertNil(store.pendingTransfer(chatID: chatID))
        XCTAssertTrue(store.canRetryOwnershipInitiation(chatID: chatID))

        let retried = await store.retryInitiateOwnershipTransfer(chatID: chatID)

        XCTAssertTrue(retried)
        XCTAssertEqual(store.pendingTransfer(chatID: chatID)?.id, transferID)
        XCTAssertTrue(store.hasPendingTransfer(chatID: chatID))
        XCTAssertFalse(store.canInitiateOwnershipTransfer(chatID: chatID))
        let nonces = await probe.nonces
        XCTAssertEqual(nonces.count, 2)
        XCTAssertEqual(nonces.first, nonces.last)
    }

    func testOwnershipAcceptIsSuccessorOnlyAndExpiryUsesServerDates() async {
        let transfer = ownershipTransfer()
        let acceptedTransfer = ownershipTransfer(
            state: .accepted,
            decidedBy: memberID,
            decidedAt: updatedDate
        )
        let page = PendingTransferProbe(transfer: transfer)
        let acceptProbe = TransferAcceptProbe(transfer: acceptedTransfer)
        let ownerStore = makeManagementStore(role: .owner)
        configure(
            ownerStore,
            pendingTransferLoader: { _ in await page.load() },
            transferAccepter: { chatID, transferID in
                try await acceptProbe.accept(chatID: chatID, transferID: transferID)
            }
        )
        await ownerStore.loadPendingOwnershipTransfer(chatID: chatID)
        XCTAssertFalse(ownerStore.isSuccessor(chatID: chatID))
        XCTAssertFalse(ownerStore.canAcceptOwnershipTransfer(chatID: chatID))
        let ownerAccepted = await ownerStore.acceptOwnershipTransfer(chatID: chatID)
        XCTAssertFalse(ownerAccepted)
        let ownerAcceptCalls = await acceptProbe.callCount
        XCTAssertEqual(ownerAcceptCalls, 0)

        let successorStore = makeManagementStore(role: .member, currentUserID: memberID)
        configure(
            successorStore,
            pendingTransferLoader: { _ in await page.load() },
            transferAccepter: { chatID, transferID in
                try await acceptProbe.accept(chatID: chatID, transferID: transferID)
            }
        )
        await successorStore.loadPendingOwnershipTransfer(chatID: chatID)
        XCTAssertTrue(successorStore.isSuccessor(chatID: chatID))
        XCTAssertTrue(successorStore.canViewOwnershipTransfer(chatID: chatID))
        XCTAssertFalse(
            successorStore.isPendingTransferExpired(
                chatID: chatID,
                now: joinedDate.addingTimeInterval(3_600)
            )
        )

        let accepted = await successorStore.acceptOwnershipTransfer(chatID: chatID)
        XCTAssertTrue(accepted)
        XCTAssertNil(successorStore.pendingTransfer(chatID: chatID))
        XCTAssertFalse(successorStore.isSuccessor(chatID: chatID))
        let successorAcceptCalls = await acceptProbe.callCount
        XCTAssertEqual(successorAcceptCalls, 1)
    }

    func testOwnershipCancelClearsPendingTransferOnlyForInitiatingOwner() async {
        let transfer = ownershipTransfer()
        let page = PendingTransferProbe(transfer: transfer)
        let cancelProbe = TransferCancelProbe(
            transfer: ownershipTransfer(
                state: .cancelled,
                decidedBy: ownerID,
                decidedAt: updatedDate
            )
        )
        let store = makeManagementStore(role: .owner)
        configure(
            store,
            pendingTransferLoader: { _ in await page.load() },
            transferCanceller: { chatID, transferID in
                try await cancelProbe.cancel(chatID: chatID, transferID: transferID)
            }
        )
        await store.loadPendingOwnershipTransfer(chatID: chatID)
        XCTAssertTrue(store.canCancelOwnershipTransfer(chatID: chatID))

        let cancelled = await store.cancelOwnershipTransfer(chatID: chatID)

        XCTAssertTrue(cancelled)
        XCTAssertNil(store.pendingTransfer(chatID: chatID))
        XCTAssertFalse(store.canCancelOwnershipTransfer(chatID: chatID))
        let cancelCalls = await cancelProbe.callCount
        XCTAssertEqual(cancelCalls, 1)
    }

    func testPendingTransferExpiredDerivationUsesServerExpiry() async {
        let expiredTransfer = ownershipTransfer(
            expiresAt: joinedDate.addingTimeInterval(-60)
        )
        let page = PendingTransferProbe(transfer: expiredTransfer)
        let store = makeManagementStore(role: .owner)
        configure(store, pendingTransferLoader: { _ in await page.load() })

        await store.loadPendingOwnershipTransfer(chatID: chatID)

        XCTAssertTrue(store.isPendingTransferExpired(chatID: chatID))
        XCTAssertFalse(store.isPendingTransferExpired(chatID: chatID, now: joinedDate.addingTimeInterval(-120)))
    }

    // MARK: Join by link

    func testInviteTokenParsingAcceptsRawTokenAndLinks() {
        let rawToken = token(seed: "D")
        XCTAssertEqual(CommunityManagementStore.inviteToken(from: rawToken), rawToken)
        XCTAssertEqual(
            CommunityManagementStore.inviteToken(from: "  luxora://join/\(rawToken)  "),
            rawToken
        )
        XCTAssertEqual(
            CommunityManagementStore.inviteToken(from: "Откройте Luxora: https://luxora.app/join/\(rawToken)."),
            rawToken
        )
        XCTAssertNil(CommunityManagementStore.inviteToken(from: ""))
        XCTAssertNil(CommunityManagementStore.inviteToken(from: "not-a-token"))
        XCTAssertNil(
            CommunityManagementStore.inviteToken(
                from: "\(token(seed: "E")) \(token(seed: "F"))"
            )
        )
        XCTAssertFalse(CommunityManagementStore.isValidInviteToken(String(repeating: "Ж", count: 43)))
    }

    func testJoinByLinkReportsJoinedPendingAndRejectionsHonestly() async {
        let joinedProbe = InviteJoinProbe(
            outcome: .joined(
                membership: membership(userID: memberID, role: .member),
                replayed: false
            )
        )
        let joinedStore = makeManagementStore(role: .member, currentUserID: memberID)
        configure(joinedStore, inviteJoiner: { token, nonce in
            try await joinedProbe.join(token: token, nonce: nonce)
        })

        let joined = await joinedStore.joinByInvite(rawInput: token(seed: "G"))

        XCTAssertNotNil(joined)
        XCTAssertEqual(joinedStore.joinByLinkState, .loaded)
        XCTAssertEqual(joinedStore.joinedChatID, chatID)
        joinedStore.clearJoinByLinkResult()
        XCTAssertNil(joinedStore.joinedChatID)
        XCTAssertNil(joinedStore.joinByLinkOutcome)
        XCTAssertEqual(joinedStore.joinByLinkState, .idle)

        let pendingStore = makeManagementStore(role: .member, currentUserID: memberID)
        // Captured by value so the @Sendable transport closure never touches
        // main-actor test helpers.
        let pendingRequest = pendingJoinRequest()
        configure(pendingStore, inviteJoiner: { _, _ in
            .pending(request: pendingRequest, replayed: true)
        })
        let pending = await pendingStore.joinByInvite(rawInput: token(seed: "H"))
        XCTAssertNotNil(pending)
        XCTAssertEqual(pendingStore.joinedChatID, chatID)

        let rejectedStore = makeManagementStore(role: .member, currentUserID: memberID)
        configure(rejectedStore, inviteJoiner: { _, _ in
            throw LuxoraAPIError.server(status: 404, code: "NOT_FOUND", message: "gone")
        })
        let rejected = await rejectedStore.joinByInvite(rawInput: token(seed: "I"))
        XCTAssertNil(rejected)
        guard case let .failed(detail) = rejectedStore.joinByLinkState else {
            return XCTFail("A dead invite link must stay visible")
        }
        XCTAssertTrue(detail.contains("отозвана"))
        XCTAssertFalse(rejectedStore.canRetryJoinByInvite())

        let invalidStore = makeManagementStore(role: .member, currentUserID: memberID)
        configure(invalidStore)
        let invalid = await invalidStore.joinByInvite(rawInput: "мусор")
        XCTAssertNil(invalid)
        guard case let .failed(invalidDetail) = invalidStore.joinByLinkState else {
            return XCTFail("An unparsable token must be rejected visibly")
        }
        XCTAssertTrue(invalidDetail.contains("распознать"))
    }

    func testJoinByLinkRetryReusesNonceAfterLostResponse() async {
        let probe = InviteJoinProbe(
            outcome: .joined(
                membership: membership(userID: memberID, role: .member),
                replayed: true
            ),
            failuresBeforeSuccess: [.transport("response lost")]
        )
        let store = makeManagementStore(role: .member, currentUserID: memberID)
        configure(store, inviteJoiner: { token, nonce in
            try await probe.join(token: token, nonce: nonce)
        })

        let first = await store.joinByInvite(rawInput: token(seed: "J"))
        XCTAssertNil(first)
        XCTAssertTrue(store.canRetryJoinByInvite())

        let retried = await store.retryJoinByInvite()

        XCTAssertNotNil(retried)
        XCTAssertEqual(store.joinByLinkState, .loaded)
        let nonces = await probe.nonces
        XCTAssertEqual(nonces.count, 2)
        XCTAssertEqual(nonces.first, nonces.last)
    }

    // MARK: Helpers

    private var joinedDate: Date { Date(timeIntervalSince1970: 1_786_435_200) }
    private var updatedDate: Date { Date(timeIntervalSince1970: 1_786_438_800) }

    private func token(seed: Character) -> String {
        String(Array(repeating: seed, count: 43))
    }

    private func makeManagementStore(
        role: ChatMembershipRole,
        currentUserID: UUID? = nil
    ) -> CommunityManagementStore {
        let userID = currentUserID ?? ownerID
        let communities = CommunityStore(
            currentUserID: userID,
            communities: [conversation(role: role)]
        )
        return CommunityManagementStore(currentUserID: userID, communityStore: communities)
    }

    private func conversation(role: ChatMembershipRole) -> Conversation {
        Conversation(
            id: chatID,
            title: "Команда Luxora",
            subtitle: "Нет сообщений",
            kind: .group,
            avatar: participant(id: chatID, name: "Команда Luxora", username: "luxora-community"),
            memberCount: 2,
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

    private func membership(
        userID: UUID,
        role: ChatMembershipRole,
        revision: Int = 1,
        joinedAt: Date? = nil,
        updatedAt: Date? = nil
    ) -> ChatMembership {
        ChatMembership(
            chatID: chatID,
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

    private func inviteLink(
        id: UUID = UUID(),
        chatID: UUID? = nil,
        createdAt: Date? = nil,
        revokedAt: Date? = nil
    ) -> CommunityInviteLink {
        CommunityInviteLink(
            id: id,
            chatID: chatID ?? self.chatID,
            createdBy: ownerID,
            approvalRequired: true,
            expiresAt: joinedDate.addingTimeInterval(7 * 24 * 3_600),
            maxUses: 50,
            useCount: 3,
            revokedAt: revokedAt,
            createdAt: createdAt ?? joinedDate
        )
    }

    private func inviteCreation(token: String) -> CommunityInviteCreation {
        CommunityInviteCreation(
            invite: inviteLink(id: linkID),
            token: token,
            replayed: false
        )
    }

    private func pendingJoinRequest() -> CommunityJoinRequest {
        CommunityJoinRequest(
            id: requestID,
            chatID: chatID,
            userID: strangerID,
            inviteLinkID: linkID,
            state: .pending,
            decidedBy: nil,
            createdAt: updatedDate,
            decidedAt: nil
        )
    }

    private func decidedJoinDecision(state: CommunityJoinRequestState) -> CommunityJoinDecision {
        CommunityJoinDecision(
            request: CommunityJoinRequest(
                id: requestID,
                chatID: chatID,
                userID: strangerID,
                inviteLinkID: linkID,
                state: state,
                decidedBy: ownerID,
                createdAt: updatedDate,
                decidedAt: updatedDate.addingTimeInterval(60)
            ),
            membership: nil,
            replayed: false
        )
    }

    private func ownershipTransfer(
        state: CommunityOwnershipTransferState = .pending,
        from fromUserID: UUID? = nil,
        to toUserID: UUID? = nil,
        expiresAt: Date? = nil,
        createdAt: Date? = nil,
        decidedBy: UUID? = nil,
        decidedAt: Date? = nil
    ) -> CommunityOwnershipTransfer {
        let created = createdAt ?? joinedDate
        return CommunityOwnershipTransfer(
            id: transferID,
            chatID: chatID,
            fromUserID: fromUserID ?? ownerID,
            toUserID: toUserID ?? memberID,
            state: state,
            expiresAt: expiresAt ?? created.addingTimeInterval(24 * 3_600),
            createdAt: created,
            decidedAt: decidedAt,
            decidedBy: decidedBy
        )
    }

    private func configure(
        _ store: CommunityManagementStore,
        inviteLoader: @escaping @Sendable (UUID) async throws -> [CommunityInviteLink] = { _ in
            throw LuxoraAPIError.transport("invite loader")
        },
        inviteCreator: @escaping @Sendable (UUID, Bool, Int?, Int?, UUID) async throws -> CommunityInviteCreation = { _, _, _, _, _ in
            throw LuxoraAPIError.transport("invite creator")
        },
        inviteRevoker: @escaping @Sendable (UUID, UUID) async throws -> CommunityInviteRevocation = { _, _ in
            throw LuxoraAPIError.transport("invite revoker")
        },
        joinRequestLoader: @escaping @Sendable (UUID) async throws -> [CommunityJoinRequest] = { _ in
            throw LuxoraAPIError.transport("join request loader")
        },
        joinApprover: @escaping @Sendable (UUID, UUID) async throws -> CommunityJoinDecision = { _, _ in
            throw LuxoraAPIError.transport("join approver")
        },
        joinDenier: @escaping @Sendable (UUID, UUID) async throws -> CommunityJoinDecision = { _, _ in
            throw LuxoraAPIError.transport("join denier")
        },
        pendingTransferLoader: @escaping @Sendable (UUID) async throws -> CommunityOwnershipTransfer? = { _ in
            throw LuxoraAPIError.transport("transfer loader")
        },
        transferInitiator: @escaping @Sendable (UUID, UUID, UUID) async throws -> CommunityOwnershipTransferReceipt = { _, _, _ in
            throw LuxoraAPIError.transport("transfer initiator")
        },
        transferAccepter: @escaping @Sendable (UUID, UUID) async throws -> CommunityOwnershipTransferReceipt = { _, _ in
            throw LuxoraAPIError.transport("transfer accepter")
        },
        transferCanceller: @escaping @Sendable (UUID, UUID) async throws -> CommunityOwnershipTransferReceipt = { _, _ in
            throw LuxoraAPIError.transport("transfer canceller")
        },
        inviteJoiner: @escaping @Sendable (String, UUID) async throws -> CommunityInviteJoinOutcome = { _, _ in
            throw LuxoraAPIError.transport("invite joiner")
        }
    ) {
        store.configureRemote(
            inviteLinkLoader: inviteLoader,
            inviteLinkCreator: inviteCreator,
            inviteLinkRevoker: inviteRevoker,
            joinRequestLoader: joinRequestLoader,
            joinRequestApprover: joinApprover,
            joinRequestDenier: joinDenier,
            pendingTransferLoader: pendingTransferLoader,
            transferInitiator: transferInitiator,
            transferAccepter: transferAccepter,
            transferCanceller: transferCanceller,
            inviteJoiner: inviteJoiner
        )
    }
}

// MARK: - Probes

private actor InviteCreationProbe {
    private(set) var nonces: [UUID] = []
    private(set) var approvalFlags: [Bool] = []
    private(set) var expirySeconds: [Int?] = []
    private(set) var maxUsesValues: [Int?] = []
    private let creation: CommunityInviteCreation
    private var failuresBeforeSuccess: [LuxoraAPIError]

    init(creation: CommunityInviteCreation, failuresBeforeSuccess: [LuxoraAPIError] = []) {
        self.creation = creation
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func create(
        chatID: UUID,
        approvalRequired: Bool,
        expiresInSeconds: Int?,
        maxUses: Int?,
        nonce: UUID
    ) throws -> CommunityInviteCreation {
        nonces.append(nonce)
        approvalFlags.append(approvalRequired)
        expirySeconds.append(expiresInSeconds)
        maxUsesValues.append(maxUses)
        if !failuresBeforeSuccess.isEmpty {
            throw failuresBeforeSuccess.removeFirst()
        }
        return creation
    }
}

private actor InviteLinkLoaderProbe {
    private var items: [CommunityInviteLink] = []
    private var failures: [LuxoraAPIError] = []
    private(set) var callCount = 0

    init(items: [CommunityInviteLink] = []) {
        self.items = items
    }

    func load() throws -> [CommunityInviteLink] {
        callCount += 1
        if !failures.isEmpty {
            throw failures.removeFirst()
        }
        return items
    }

    func enqueueFailure(_ error: LuxoraAPIError) {
        failures.append(error)
    }

    func replace(items: [CommunityInviteLink], failures: [LuxoraAPIError]) {
        self.items = items
        self.failures = failures
    }
}

private actor RevokeProbe {
    private let revocation: CommunityInviteRevocation?
    private var failuresBeforeSuccess: [LuxoraAPIError]

    init(revocation: CommunityInviteRevocation?, failuresBeforeSuccess: [LuxoraAPIError] = []) {
        self.revocation = revocation
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func revoke(chatID: UUID, linkID: UUID) throws -> CommunityInviteRevocation {
        if !failuresBeforeSuccess.isEmpty {
            throw failuresBeforeSuccess.removeFirst()
        }
        guard let revocation else { throw LuxoraAPIError.transport("revoke") }
        return revocation
    }
}

private actor JoinRequestLoaderProbe {
    private let items: [CommunityJoinRequest]
    private(set) var callCount = 0

    init(items: [CommunityJoinRequest]) {
        self.items = items
    }

    func load() -> [CommunityJoinRequest] {
        callCount += 1
        return items
    }
}

private actor JoinDecisionProbe {
    private let approveResult: CommunityJoinDecision?
    private let denyResult: CommunityJoinDecision?
    private var failuresBeforeApprove: [LuxoraAPIError]
    private(set) var approveCalls = 0
    private(set) var denyCalls = 0

    init(
        approveResult: CommunityJoinDecision? = nil,
        denyResult: CommunityJoinDecision? = nil,
        failuresBeforeApprove: [LuxoraAPIError] = []
    ) {
        self.approveResult = approveResult
        self.denyResult = denyResult
        self.failuresBeforeApprove = failuresBeforeApprove
    }

    func approve(chatID: UUID, requestID: UUID) throws -> CommunityJoinDecision {
        approveCalls += 1
        if !failuresBeforeApprove.isEmpty {
            throw failuresBeforeApprove.removeFirst()
        }
        guard let approveResult else { throw LuxoraAPIError.transport("approve") }
        return approveResult
    }

    func deny(chatID: UUID, requestID: UUID) throws -> CommunityJoinDecision {
        denyCalls += 1
        guard let denyResult else { throw LuxoraAPIError.transport("deny") }
        return denyResult
    }
}

private actor PendingTransferProbe {
    private let transfer: CommunityOwnershipTransfer?
    private(set) var callCount = 0

    init(transfer: CommunityOwnershipTransfer?) {
        self.transfer = transfer
    }

    func load() -> CommunityOwnershipTransfer? {
        callCount += 1
        return transfer
    }
}

private actor TransferInitiationProbe {
    private let receipt: CommunityOwnershipTransferReceipt
    private var failuresBeforeSuccess: [LuxoraAPIError]
    private(set) var nonces: [UUID] = []
    private(set) var targets: [UUID] = []

    init(receipt: CommunityOwnershipTransferReceipt, failuresBeforeSuccess: [LuxoraAPIError] = []) {
        self.receipt = receipt
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func initiate(chatID: UUID, targetUserID: UUID, nonce: UUID) throws -> CommunityOwnershipTransferReceipt {
        nonces.append(nonce)
        targets.append(targetUserID)
        if !failuresBeforeSuccess.isEmpty {
            throw failuresBeforeSuccess.removeFirst()
        }
        return receipt
    }
}

private actor TransferAcceptProbe {
    private let transfer: CommunityOwnershipTransfer
    private var failuresBeforeSuccess: [LuxoraAPIError]
    private(set) var callCount = 0

    init(transfer: CommunityOwnershipTransfer, failuresBeforeSuccess: [LuxoraAPIError] = []) {
        self.transfer = transfer
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func accept(chatID: UUID, transferID: UUID) throws -> CommunityOwnershipTransferReceipt {
        callCount += 1
        if !failuresBeforeSuccess.isEmpty {
            throw failuresBeforeSuccess.removeFirst()
        }
        return CommunityOwnershipTransferReceipt(transfer: transfer, replayed: false)
    }
}

private actor TransferCancelProbe {
    private let transfer: CommunityOwnershipTransfer
    private var failuresBeforeSuccess: [LuxoraAPIError]
    private(set) var callCount = 0

    init(transfer: CommunityOwnershipTransfer, failuresBeforeSuccess: [LuxoraAPIError] = []) {
        self.transfer = transfer
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func cancel(chatID: UUID, transferID: UUID) throws -> CommunityOwnershipTransferReceipt {
        callCount += 1
        if !failuresBeforeSuccess.isEmpty {
            throw failuresBeforeSuccess.removeFirst()
        }
        return CommunityOwnershipTransferReceipt(transfer: transfer, replayed: false)
    }
}

private actor InviteJoinProbe {
    private let outcome: CommunityInviteJoinOutcome
    private var failuresBeforeSuccess: [LuxoraAPIError]
    private(set) var nonces: [UUID] = []
    private(set) var tokens: [String] = []

    init(outcome: CommunityInviteJoinOutcome, failuresBeforeSuccess: [LuxoraAPIError] = []) {
        self.outcome = outcome
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func join(token: String, nonce: UUID) throws -> CommunityInviteJoinOutcome {
        tokens.append(token)
        nonces.append(nonce)
        if !failuresBeforeSuccess.isEmpty {
            throw failuresBeforeSuccess.removeFirst()
        }
        return outcome
    }
}
