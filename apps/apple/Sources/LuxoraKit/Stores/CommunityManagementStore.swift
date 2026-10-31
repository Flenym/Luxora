import Foundation
import Observation

/// Server-backed management surface for group/channel administration.
///
/// The store owns invite-link listing and creation (the raw bearer token is
/// returned by the server exactly once, so it is kept in memory only and is
/// never logged), the join-request approval queue and the ownership-transfer
/// ceremony. Every action is gated by the real role read from `CommunityStore`
/// and by whether the matching transport closure is wired; the UI never
/// pretends an action succeeded before the server confirms it.
@MainActor
@Observable
public final class CommunityManagementStore {
    public private(set) var currentUserID: UUID

    // MARK: Invite links

    public private(set) var inviteLinksByChat: [UUID: [CommunityInviteLink]] = [:]
    public private(set) var inviteListStates: [UUID: RemoteContentState] = [:]
    public private(set) var inviteActionStates: [UUID: RemoteContentState] = [:]
    public private(set) var inviteActionErrors: [UUID: String] = [:]
    /// The one-time token returned by the last successful creation. Shown to
    /// the account once and cleared explicitly; the server keeps only a digest.
    public private(set) var lastCreatedInvite: CommunityInviteCreation?
    public private(set) var lastCreatedInviteWasCopied = false
    public private(set) var revokingLinkIDs: Set<UUID> = []

    // MARK: Join requests

    public private(set) var joinRequestsByChat: [UUID: [CommunityJoinRequest]] = [:]
    public private(set) var joinRequestListStates: [UUID: RemoteContentState] = [:]
    public private(set) var joinDecisionStates: [UUID: RemoteContentState] = [:]
    public private(set) var joinDecisionErrors: [UUID: String] = [:]

    // MARK: Ownership transfer

    public private(set) var pendingTransfersByChat: [UUID: CommunityOwnershipTransfer] = [:]
    public private(set) var ownershipTransferStates: [UUID: RemoteContentState] = [:]
    public private(set) var ownershipActionStates: [UUID: RemoteContentState] = [:]
    public private(set) var ownershipActionErrors: [UUID: String] = [:]

    // MARK: Join by link

    public private(set) var joinByLinkState: RemoteContentState = .idle
    public private(set) var joinByLinkError: String?
    public private(set) var joinByLinkOutcome: CommunityInviteJoinOutcome?

    var remoteInviteLinkLoader: (@Sendable (UUID) async throws -> [CommunityInviteLink])?
    var remoteInviteLinkCreator: (@Sendable (UUID, Bool, Int?, Int?, UUID) async throws -> CommunityInviteCreation)?
    var remoteInviteLinkRevoker: (@Sendable (UUID, UUID) async throws -> CommunityInviteRevocation)?
    var remoteJoinRequestLoader: (@Sendable (UUID) async throws -> [CommunityJoinRequest])?
    var remoteJoinRequestApprover: (@Sendable (UUID, UUID) async throws -> CommunityJoinDecision)?
    var remoteJoinRequestDenier: (@Sendable (UUID, UUID) async throws -> CommunityJoinDecision)?
    var remotePendingTransferLoader: (@Sendable (UUID) async throws -> CommunityOwnershipTransfer?)?
    var remoteTransferInitiator: (@Sendable (UUID, UUID, UUID) async throws -> CommunityOwnershipTransferReceipt)?
    var remoteTransferAccepter: (@Sendable (UUID, UUID) async throws -> CommunityOwnershipTransferReceipt)?
    var remoteTransferCanceller: (@Sendable (UUID, UUID) async throws -> CommunityOwnershipTransferReceipt)?
    var remoteInviteJoiner: (@Sendable (String, UUID) async throws -> CommunityInviteJoinOutcome)?

    @ObservationIgnored private let communityStore: CommunityStore?
    @ObservationIgnored private var generation: UInt = 0
    @ObservationIgnored private var inviteCreationRetries: [UUID: InviteCreationCommand] = [:]
    @ObservationIgnored private var ownershipInitiationRetries: [UUID: OwnershipInitiationCommand] = [:]
    @ObservationIgnored private var joinByInviteRetry: JoinByInviteCommand?
    @ObservationIgnored private var joinDecisionRetries: [UUID: JoinDecision] = [:]

    public init(currentUserID: UUID, communityStore: CommunityStore? = nil) {
        self.currentUserID = currentUserID
        self.communityStore = communityStore
    }

    // MARK: Role gating (server remains the final authority)

    public func isManager(chatID: UUID) -> Bool {
        currentRole(in: chatID)?.isPrivileged == true
    }

    public func canManageInviteLinks(chatID: UUID) -> Bool {
        isManager(chatID: chatID)
            && remoteInviteLinkLoader != nil
            && remoteInviteLinkCreator != nil
            && remoteInviteLinkRevoker != nil
    }

    public func canManageJoinRequests(chatID: UUID) -> Bool {
        isManager(chatID: chatID)
            && remoteJoinRequestLoader != nil
            && remoteJoinRequestApprover != nil
            && remoteJoinRequestDenier != nil
    }

    public func canInitiateOwnershipTransfer(chatID: UUID) -> Bool {
        currentRole(in: chatID) == .owner
            && pendingTransfersByChat[chatID] == nil
            && remoteTransferInitiator != nil
            && ownershipActionState(chatID: chatID) != .loading
    }

    public func canCancelOwnershipTransfer(chatID: UUID) -> Bool {
        currentRole(in: chatID) == .owner
            && pendingTransfer(chatID: chatID)?.fromUserID == currentUserID
            && remoteTransferCanceller != nil
            && ownershipActionState(chatID: chatID) != .loading
    }

    public func canAcceptOwnershipTransfer(chatID: UUID) -> Bool {
        isSuccessor(chatID: chatID)
            && remoteTransferAccepter != nil
            && ownershipActionState(chatID: chatID) != .loading
    }

    public func isSuccessor(chatID: UUID) -> Bool {
        guard let transfer = pendingTransfersByChat[chatID],
              transfer.state == .pending
        else { return false }
        return transfer.toUserID == currentUserID
    }

    public func canViewOwnershipTransfer(chatID: UUID) -> Bool {
        isManager(chatID: chatID) || isSuccessor(chatID: chatID)
    }

    public func canCreateInviteLink(chatID: UUID) -> Bool {
        canManageInviteLinks(chatID: chatID)
            && inviteActionState(chatID: chatID) != .loading
            && lastCreatedInvite?.invite.chatID != chatID
    }

    public func canRetryInviteCreation(chatID: UUID) -> Bool {
        inviteCreationRetries[chatID] != nil && inviteActionState(chatID: chatID) != .loading
    }

    public func canRetryOwnershipInitiation(chatID: UUID) -> Bool {
        ownershipInitiationRetries[chatID] != nil && ownershipActionState(chatID: chatID) != .loading
    }

    public func canRetryJoinByInvite() -> Bool {
        joinByInviteRetry != nil && joinByLinkState != .loading
    }

    // MARK: Read helpers

    public func inviteLinks(chatID: UUID) -> [CommunityInviteLink] {
        inviteLinksByChat[chatID] ?? []
    }

    public func inviteListState(chatID: UUID) -> RemoteContentState {
        inviteListStates[chatID] ?? .idle
    }

    public func inviteActionState(chatID: UUID) -> RemoteContentState {
        inviteActionStates[chatID] ?? .idle
    }

    public func inviteActionError(chatID: UUID) -> String? {
        inviteActionErrors[chatID]
    }

    public func isRevokingInviteLink(_ linkID: UUID) -> Bool {
        revokingLinkIDs.contains(linkID)
    }

    public func joinRequests(chatID: UUID) -> [CommunityJoinRequest] {
        joinRequestsByChat[chatID] ?? []
    }

    public func pendingJoinRequests(chatID: UUID) -> [CommunityJoinRequest] {
        joinRequests(chatID: chatID).filter { $0.state == .pending }
    }

    public func joinRequestListState(chatID: UUID) -> RemoteContentState {
        joinRequestListStates[chatID] ?? .idle
    }

    public func joinDecisionState(requestID: UUID) -> RemoteContentState {
        joinDecisionStates[requestID] ?? .idle
    }

    public func joinDecisionError(requestID: UUID) -> String? {
        joinDecisionErrors[requestID]
    }

    public func pendingTransfer(chatID: UUID) -> CommunityOwnershipTransfer? {
        pendingTransfersByChat[chatID]
    }

    public func hasPendingTransfer(chatID: UUID) -> Bool {
        pendingTransfer(chatID: chatID)?.state == .pending
    }

    public func ownershipTransferState(chatID: UUID) -> RemoteContentState {
        ownershipTransferStates[chatID] ?? .idle
    }

    public func ownershipActionState(chatID: UUID) -> RemoteContentState {
        ownershipActionStates[chatID] ?? .idle
    }

    public func ownershipActionError(chatID: UUID) -> String? {
        ownershipActionErrors[chatID]
    }

    public var joinedChatID: UUID? {
        switch joinByLinkOutcome {
        case let .joined(membership, _): membership.chatID
        case let .pending(request, _): request.chatID
        case nil: nil
        }
    }

    // MARK: Invite links

    public func loadInviteLinks(chatID: UUID, force: Bool = false) async {
        guard isManager(chatID: chatID) else {
            inviteListStates[chatID] = .failed(Self.managerOnlyMessage)
            return
        }
        guard let remoteInviteLinkLoader else {
            inviteListStates[chatID] = .failed("Загрузка ссылок-приглашений не подключена.")
            return
        }
        if !force, inviteListStates[chatID] == .loading { return }
        let operationGeneration = generation
        inviteListStates[chatID] = .loading
        do {
            let loaded = try await remoteInviteLinkLoader(chatID)
            guard generation == operationGeneration, !Task.isCancelled else { return }
            guard loaded.count <= 100,
                  Set(loaded.map(\.id)).count == loaded.count,
                  loaded.allSatisfy({ $0.chatID == chatID })
            else { throw LuxoraAPIError.invalidResponse }
            inviteLinksByChat[chatID] = Self.sortedInviteLinks(loaded)
            inviteListStates[chatID] = .loaded
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            inviteListStates[chatID] = inviteLinksByChat[chatID] == nil ? .idle : .loaded
        } catch {
            guard generation == operationGeneration else { return }
            inviteListStates[chatID] = .failed(
                Self.message(for: error, context: .inviteLinks)
            )
        }
    }

    /// Starts a new creation command with a fresh nonce. Retrying an ambiguous
    /// transport failure must go through `retryCreateInviteLink(chatID:)` so the
    /// server's idempotency key is reused instead of minting a duplicate link.
    @discardableResult
    public func createInviteLink(
        chatID: UUID,
        approvalRequired: Bool,
        expiresInSeconds: Int?,
        maxUses: Int?
    ) async -> Bool {
        guard isManager(chatID: chatID) else {
            recordInviteActionFailure(chatID: chatID, message: Self.managerOnlyMessage, retryable: false)
            return false
        }
        guard let remoteInviteLinkCreator else {
            recordInviteActionFailure(
                chatID: chatID,
                message: "Создание ссылок-приглашений не подключено.",
                retryable: false
            )
            return false
        }
        if let expiresInSeconds, !(1...90 * 24 * 3_600).contains(expiresInSeconds) {
            recordInviteActionFailure(
                chatID: chatID,
                message: "Срок действия ссылки — от 1 часа до 90 дней.",
                retryable: false
            )
            return false
        }
        if let maxUses, !(1...10_000).contains(maxUses) {
            recordInviteActionFailure(
                chatID: chatID,
                message: "Лимит вступлений — от 1 до 10 000.",
                retryable: false
            )
            return false
        }
        let command = InviteCreationCommand(
            chatID: chatID,
            approvalRequired: approvalRequired,
            expiresInSeconds: expiresInSeconds,
            maxUses: maxUses,
            nonce: UUID()
        )
        return await performInviteCreation(
            command,
            creator: remoteInviteLinkCreator,
            chatID: chatID
        )
    }

    @discardableResult
    public func retryCreateInviteLink(chatID: UUID) async -> Bool {
        guard isManager(chatID: chatID) else {
            recordInviteActionFailure(chatID: chatID, message: Self.managerOnlyMessage, retryable: false)
            return false
        }
        guard let command = inviteCreationRetries[chatID] else { return false }
        guard let remoteInviteLinkCreator else {
            recordInviteActionFailure(
                chatID: chatID,
                message: "Создание ссылок-приглашений не подключено.",
                retryable: false
            )
            return false
        }
        return await performInviteCreation(
            command,
            creator: remoteInviteLinkCreator,
            chatID: chatID
        )
    }

    @discardableResult
    public func revokeInviteLink(chatID: UUID, linkID: UUID) async -> Bool {
        guard isManager(chatID: chatID) else {
            recordInviteActionFailure(chatID: chatID, message: Self.managerOnlyMessage, retryable: false)
            return false
        }
        guard let remoteInviteLinkRevoker else {
            recordInviteActionFailure(
                chatID: chatID,
                message: "Отзыв ссылок-приглашений не подключён.",
                retryable: false
            )
            return false
        }
        guard !revokingLinkIDs.contains(linkID) else { return false }
        let operationGeneration = generation
        revokingLinkIDs.insert(linkID)
        inviteActionErrors[chatID] = nil
        do {
            let revocation = try await remoteInviteLinkRevoker(chatID, linkID)
            guard generation == operationGeneration, !Task.isCancelled else { return false }
            guard revocation.invite.id == linkID,
                  revocation.invite.chatID == chatID,
                  revocation.invite.isRevoked
            else { throw LuxoraAPIError.invalidResponse }
            revokingLinkIDs.remove(linkID)
            replaceInviteInList(revocation.invite, chatID: chatID)
            inviteActionStates[chatID] = .loaded
            inviteActionErrors[chatID] = nil
            return true
        } catch is CancellationError {
            if generation == operationGeneration {
                revokingLinkIDs.remove(linkID)
            }
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            revokingLinkIDs.remove(linkID)
            recordInviteActionFailure(
                chatID: chatID,
                message: Self.message(for: error, context: .inviteRevoke),
                retryable: false
            )
            return false
        }
    }

    public func markCreatedInviteCopied() {
        guard lastCreatedInvite != nil else { return }
        lastCreatedInviteWasCopied = true
    }

    /// The one-time token must not linger once the account dismisses the
    /// shown-once card; the server cannot reissue it.
    public func clearCreatedInviteToken() {
        lastCreatedInvite = nil
        lastCreatedInviteWasCopied = false
    }

    public func clearInviteActionError(chatID: UUID) {
        guard inviteActionState(chatID: chatID) != .loading else { return }
        inviteActionStates[chatID] = .idle
        inviteActionErrors[chatID] = nil
        inviteCreationRetries[chatID] = nil
    }

    // MARK: Join requests

    public func loadJoinRequests(chatID: UUID, force: Bool = false) async {
        guard isManager(chatID: chatID) else {
            joinRequestListStates[chatID] = .failed(Self.managerOnlyMessage)
            return
        }
        guard let remoteJoinRequestLoader else {
            joinRequestListStates[chatID] = .failed("Загрузка заявок на вступление не подключена.")
            return
        }
        if !force, joinRequestListStates[chatID] == .loading { return }
        let operationGeneration = generation
        joinRequestListStates[chatID] = .loading
        do {
            let loaded = try await remoteJoinRequestLoader(chatID)
            guard generation == operationGeneration, !Task.isCancelled else { return }
            guard loaded.count <= 200,
                  Set(loaded.map(\.id)).count == loaded.count,
                  loaded.allSatisfy({ $0.chatID == chatID })
            else { throw LuxoraAPIError.invalidResponse }
            joinRequestsByChat[chatID] = Self.sortedJoinRequests(loaded)
            joinRequestListStates[chatID] = .loaded
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            joinRequestListStates[chatID] = joinRequestsByChat[chatID] == nil ? .idle : .loaded
        } catch {
            guard generation == operationGeneration else { return }
            joinRequestListStates[chatID] = .failed(
                Self.message(for: error, context: .joinRequests)
            )
        }
    }

    @discardableResult
    public func approveJoinRequest(chatID: UUID, requestID: UUID) async -> Bool {
        await decideJoinRequest(chatID: chatID, requestID: requestID, decision: .approve)
    }

    @discardableResult
    public func denyJoinRequest(chatID: UUID, requestID: UUID) async -> Bool {
        await decideJoinRequest(chatID: chatID, requestID: requestID, decision: .deny)
    }

    public func clearJoinDecisionError(requestID: UUID) {
        guard joinDecisionStates[requestID] != .loading else { return }
        joinDecisionStates[requestID] = .idle
        joinDecisionErrors[requestID] = nil
        joinDecisionRetries[requestID] = nil
    }

    public func canRetryJoinDecision(requestID: UUID) -> Bool {
        joinDecisionRetries[requestID] != nil && joinDecisionStates[requestID] != .loading
    }

    /// Replays the last approve/deny intent. The server decides by request
    /// state, so repeating the same decision after a lost response is safe.
    @discardableResult
    public func retryJoinDecision(chatID: UUID, requestID: UUID) async -> Bool {
        guard let decision = joinDecisionRetries[requestID] else { return false }
        return await decideJoinRequest(chatID: chatID, requestID: requestID, decision: decision)
    }

    // MARK: Ownership transfer

    /// The server hides the pending ceremony from anyone who is not a manager
    /// or the designated successor. Non-managers may still call this so a
    /// successor can discover the ceremony; a forbidden response is surfaced
    /// honestly instead of being synthesized into "no transfer".
    public func loadPendingOwnershipTransfer(chatID: UUID, force: Bool = false) async {
        guard let remotePendingTransferLoader else {
            ownershipTransferStates[chatID] = .failed("Передача владения не подключена.")
            return
        }
        if !force, ownershipTransferStates[chatID] == .loading { return }
        let operationGeneration = generation
        ownershipTransferStates[chatID] = .loading
        do {
            let transfer = try await remotePendingTransferLoader(chatID)
            guard generation == operationGeneration, !Task.isCancelled else { return }
            if let transfer {
                guard transfer.chatID == chatID,
                      transfer.state == .pending,
                      transfer.fromUserID != transfer.toUserID
                else { throw LuxoraAPIError.invalidResponse }
                pendingTransfersByChat[chatID] = transfer
            } else {
                pendingTransfersByChat[chatID] = nil
            }
            ownershipTransferStates[chatID] = .loaded
            ownershipActionErrors[chatID] = nil
        } catch is CancellationError {
            guard generation == operationGeneration else { return }
            ownershipTransferStates[chatID] = pendingTransfersByChat[chatID] == nil ? .idle : .loaded
        } catch {
            guard generation == operationGeneration else { return }
            ownershipTransferStates[chatID] = .failed(
                Self.message(for: error, context: .ownership)
            )
        }
    }

    @discardableResult
    public func initiateOwnershipTransfer(chatID: UUID, targetUserID: UUID) async -> Bool {
        guard currentRole(in: chatID) == .owner else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Передать владение может только текущий владелец сообщества.",
                retryable: false
            )
            return false
        }
        guard targetUserID != currentUserID else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Вы уже владелец этого сообщества.",
                retryable: false
            )
            return false
        }
        guard let remoteTransferInitiator else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Передача владения не подключена.",
                retryable: false
            )
            return false
        }
        guard pendingTransfersByChat[chatID] == nil else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Уже есть ожидающая передача владения. Дождитесь решения или отмените её.",
                retryable: false
            )
            return false
        }
        let command = OwnershipInitiationCommand(
            chatID: chatID,
            targetUserID: targetUserID,
            nonce: UUID()
        )
        return await performOwnershipInitiation(
            command,
            initiator: remoteTransferInitiator,
            chatID: chatID
        )
    }

    @discardableResult
    public func retryInitiateOwnershipTransfer(chatID: UUID) async -> Bool {
        guard let command = ownershipInitiationRetries[chatID] else { return false }
        guard let remoteTransferInitiator else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Передача владения не подключена.",
                retryable: false
            )
            return false
        }
        return await performOwnershipInitiation(
            command,
            initiator: remoteTransferInitiator,
            chatID: chatID
        )
    }

    @discardableResult
    public func acceptOwnershipTransfer(chatID: UUID) async -> Bool {
        guard isSuccessor(chatID: chatID), let transfer = pendingTransfer(chatID: chatID) else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Принять передачу может только назначенный преемник.",
                retryable: false
            )
            return false
        }
        guard let remoteTransferAccepter else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Принятие передачи владения не подключено.",
                retryable: false
            )
            return false
        }
        guard ownershipActionState(chatID: chatID) != .loading else { return false }
        let operationGeneration = generation
        ownershipActionStates[chatID] = .loading
        ownershipActionErrors[chatID] = nil
        do {
            let receipt = try await remoteTransferAccepter(chatID, transfer.id)
            guard generation == operationGeneration, !Task.isCancelled else { return false }
            try Self.validateTransferReceipt(
                receipt,
                chatID: chatID,
                expectedID: transfer.id,
                expectedState: .accepted
            )
            pendingTransfersByChat[chatID] = nil
            ownershipTransferStates[chatID] = .loaded
            ownershipActionStates[chatID] = .loaded
            return true
        } catch is CancellationError {
            if generation == operationGeneration {
                ownershipActionStates[chatID] = .idle
            }
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            recordOwnershipActionFailure(
                chatID: chatID,
                message: Self.message(for: error, context: .ownership),
                retryable: true
            )
            return false
        }
    }

    @discardableResult
    public func cancelOwnershipTransfer(chatID: UUID) async -> Bool {
        guard currentRole(in: chatID) == .owner,
              let transfer = pendingTransfer(chatID: chatID),
              transfer.fromUserID == currentUserID
        else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Отменить передачу может только текущий владелец, который её начал.",
                retryable: false
            )
            return false
        }
        guard let remoteTransferCanceller else {
            recordOwnershipActionFailure(
                chatID: chatID,
                message: "Отмена передачи владения не подключена.",
                retryable: false
            )
            return false
        }
        guard ownershipActionState(chatID: chatID) != .loading else { return false }
        let operationGeneration = generation
        ownershipActionStates[chatID] = .loading
        ownershipActionErrors[chatID] = nil
        do {
            let receipt = try await remoteTransferCanceller(chatID, transfer.id)
            guard generation == operationGeneration, !Task.isCancelled else { return false }
            try Self.validateTransferReceipt(
                receipt,
                chatID: chatID,
                expectedID: transfer.id,
                expectedState: .cancelled
            )
            pendingTransfersByChat[chatID] = nil
            ownershipTransferStates[chatID] = .loaded
            ownershipActionStates[chatID] = .loaded
            return true
        } catch is CancellationError {
            if generation == operationGeneration {
                ownershipActionStates[chatID] = .idle
            }
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            recordOwnershipActionFailure(
                chatID: chatID,
                message: Self.message(for: error, context: .ownership),
                retryable: true
            )
            return false
        }
    }

    public func clearOwnershipActionError(chatID: UUID) {
        guard ownershipActionState(chatID: chatID) != .loading else { return }
        ownershipActionStates[chatID] = .idle
        ownershipActionErrors[chatID] = nil
        ownershipInitiationRetries[chatID] = nil
    }

    /// True only when the server-issued expiry has genuinely passed; the UI
    /// must not guess a different lifetime than the 24-hour server rule.
    public func isPendingTransferExpired(chatID: UUID, now: Date = Date()) -> Bool {
        guard let transfer = pendingTransfer(chatID: chatID) else { return false }
        return transfer.state == .pending && transfer.expiresAt <= now
    }

    // MARK: Join by link

    /// Accepts either the raw 43-character bearer token or a link/text that
    /// contains exactly one token. A transport failure keeps the same nonce so
    /// `retryJoinByInvite()` is idempotent; definitive rejections clear it.
    @discardableResult
    public func joinByInvite(rawInput: String) async -> CommunityInviteJoinOutcome? {
        guard joinByLinkState != .loading else { return nil }
        guard let token = Self.inviteToken(from: rawInput) else {
            joinByInviteRetry = nil
            joinByLinkOutcome = nil
            joinByLinkError = "Не удалось распознать токен: нужен 43-символьный токен-приглашение или ссылка с ним."
            joinByLinkState = .failed(joinByLinkError!)
            return nil
        }
        let command: JoinByInviteCommand
        if let retry = joinByInviteRetry, retry.token == token {
            command = retry
        } else {
            command = JoinByInviteCommand(token: token, nonce: UUID())
        }
        return await performJoinByInvite(command)
    }

    @discardableResult
    public func retryJoinByInvite() async -> CommunityInviteJoinOutcome? {
        guard let command = joinByInviteRetry, joinByLinkState != .loading else { return nil }
        return await performJoinByInvite(command)
    }

    public func clearJoinByLinkResult() {
        guard joinByLinkState != .loading else { return }
        joinByLinkState = .idle
        joinByLinkError = nil
        joinByLinkOutcome = nil
        joinByInviteRetry = nil
    }

    public func refresh(chatID: UUID) async {
        if isManager(chatID: chatID) {
            await loadInviteLinks(chatID: chatID, force: true)
            await loadJoinRequests(chatID: chatID, force: true)
        }
        await loadPendingOwnershipTransfer(chatID: chatID, force: true)
    }

    func configureRemote(
        inviteLinkLoader: @escaping @Sendable (UUID) async throws -> [CommunityInviteLink],
        inviteLinkCreator: @escaping @Sendable (UUID, Bool, Int?, Int?, UUID) async throws -> CommunityInviteCreation,
        inviteLinkRevoker: @escaping @Sendable (UUID, UUID) async throws -> CommunityInviteRevocation,
        joinRequestLoader: @escaping @Sendable (UUID) async throws -> [CommunityJoinRequest],
        joinRequestApprover: @escaping @Sendable (UUID, UUID) async throws -> CommunityJoinDecision,
        joinRequestDenier: @escaping @Sendable (UUID, UUID) async throws -> CommunityJoinDecision,
        pendingTransferLoader: @escaping @Sendable (UUID) async throws -> CommunityOwnershipTransfer?,
        transferInitiator: @escaping @Sendable (UUID, UUID, UUID) async throws -> CommunityOwnershipTransferReceipt,
        transferAccepter: @escaping @Sendable (UUID, UUID) async throws -> CommunityOwnershipTransferReceipt,
        transferCanceller: @escaping @Sendable (UUID, UUID) async throws -> CommunityOwnershipTransferReceipt,
        inviteJoiner: @escaping @Sendable (String, UUID) async throws -> CommunityInviteJoinOutcome
    ) {
        remoteInviteLinkLoader = inviteLinkLoader
        remoteInviteLinkCreator = inviteLinkCreator
        remoteInviteLinkRevoker = inviteLinkRevoker
        remoteJoinRequestLoader = joinRequestLoader
        remoteJoinRequestApprover = joinRequestApprover
        remoteJoinRequestDenier = joinRequestDenier
        remotePendingTransferLoader = pendingTransferLoader
        remoteTransferInitiator = transferInitiator
        remoteTransferAccepter = transferAccepter
        remoteTransferCanceller = transferCanceller
        remoteInviteJoiner = inviteJoiner
    }

    func cancelRemoteOperations() {
        generation &+= 1
        for chatID in Array(inviteListStates.keys) where inviteListStates[chatID] == .loading {
            inviteListStates[chatID] = inviteLinksByChat[chatID] == nil ? .idle : .loaded
        }
        for chatID in Array(inviteActionStates.keys) where inviteActionStates[chatID] == .loading {
            inviteActionStates[chatID] = .idle
        }
        revokingLinkIDs.removeAll()
        for chatID in Array(joinRequestListStates.keys) where joinRequestListStates[chatID] == .loading {
            joinRequestListStates[chatID] = joinRequestsByChat[chatID] == nil ? .idle : .loaded
        }
        for requestID in Array(joinDecisionStates.keys) where joinDecisionStates[requestID] == .loading {
            joinDecisionStates[requestID] = .idle
        }
        for chatID in Array(ownershipTransferStates.keys) where ownershipTransferStates[chatID] == .loading {
            ownershipTransferStates[chatID] = pendingTransfersByChat[chatID] == nil ? .idle : .loaded
        }
        for chatID in Array(ownershipActionStates.keys) where ownershipActionStates[chatID] == .loading {
            ownershipActionStates[chatID] = .idle
        }
        if joinByLinkState == .loading { joinByLinkState = .idle }
    }

    // MARK: Internal machinery

    private enum JoinDecision: String {
        case approve
        case deny
    }

    private func performInviteCreation(
        _ command: InviteCreationCommand,
        creator: @escaping @Sendable (UUID, Bool, Int?, Int?, UUID) async throws -> CommunityInviteCreation,
        chatID: UUID
    ) async -> Bool {
        guard inviteActionState(chatID: chatID) != .loading else { return false }
        let operationGeneration = generation
        inviteCreationRetries[chatID] = command
        inviteActionStates[chatID] = .loading
        inviteActionErrors[chatID] = nil
        do {
            let created = try await creator(
                command.chatID,
                command.approvalRequired,
                command.expiresInSeconds,
                command.maxUses,
                command.nonce
            )
            guard generation == operationGeneration, !Task.isCancelled else { return false }
            guard created.invite.chatID == chatID,
                  Self.isValidInviteToken(created.token)
            else { throw LuxoraAPIError.invalidResponse }
            inviteCreationRetries[chatID] = nil
            inviteActionStates[chatID] = .loaded
            inviteActionErrors[chatID] = nil
            lastCreatedInvite = created
            lastCreatedInviteWasCopied = false
            replaceInviteInList(created.invite, chatID: chatID)
            return true
        } catch is CancellationError {
            if generation == operationGeneration {
                inviteActionStates[chatID] = .idle
            }
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            let definitive = Self.isDefinitiveRejection(error)
            if definitive { inviteCreationRetries[chatID] = nil }
            recordInviteActionFailure(
                chatID: chatID,
                message: Self.message(for: error, context: .inviteCreate),
                retryable: !definitive
            )
            return false
        }
    }

    private func decideJoinRequest(
        chatID: UUID,
        requestID: UUID,
        decision: JoinDecision
    ) async -> Bool {
        guard isManager(chatID: chatID) else {
            recordJoinDecisionFailure(requestID: requestID, message: Self.managerOnlyMessage)
            return false
        }
        let remote: (@Sendable (UUID, UUID) async throws -> CommunityJoinDecision)?
        switch decision {
        case .approve: remote = remoteJoinRequestApprover
        case .deny: remote = remoteJoinRequestDenier
        }
        guard let remote else {
            recordJoinDecisionFailure(
                requestID: requestID,
                message: "Решение по заявкам не подключено."
            )
            return false
        }
        guard joinDecisionStates[requestID] != .loading else { return false }
        guard let request = joinRequestsByChat[chatID]?.first(where: { $0.id == requestID }) else {
            recordJoinDecisionFailure(
                requestID: requestID,
                message: "Заявка не найдена в загруженном списке. Обновите заявки."
            )
            return false
        }
        guard request.state == .pending else {
            recordJoinDecisionFailure(
                requestID: requestID,
                message: "Заявка уже обработана. Обновите список."
            )
            return false
        }
        let operationGeneration = generation
        joinDecisionRetries[requestID] = decision
        joinDecisionStates[requestID] = .loading
        joinDecisionErrors[requestID] = nil
        do {
            let result = try await remote(chatID, requestID)
            guard generation == operationGeneration, !Task.isCancelled else { return false }
            guard result.request.id == requestID,
                  result.request.chatID == chatID
            else { throw LuxoraAPIError.invalidResponse }
            switch decision {
            case .approve:
                guard result.request.state == .approved else {
                    throw LuxoraAPIError.invalidResponse
                }
            case .deny:
                guard result.request.state == .denied else {
                    throw LuxoraAPIError.invalidResponse
                }
            }
            replaceJoinRequestInList(result.request, chatID: chatID)
            joinDecisionRetries[requestID] = nil
            joinDecisionStates[requestID] = .loaded
            joinDecisionErrors[requestID] = nil
            return true
        } catch is CancellationError {
            if generation == operationGeneration {
                joinDecisionStates[requestID] = .idle
            }
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            if Self.isDefinitiveRejection(error) {
                joinDecisionRetries[requestID] = nil
            }
            recordJoinDecisionFailure(
                requestID: requestID,
                message: Self.message(for: error, context: .joinDecision)
            )
            return false
        }
    }

    private func performOwnershipInitiation(
        _ command: OwnershipInitiationCommand,
        initiator: @escaping @Sendable (UUID, UUID, UUID) async throws -> CommunityOwnershipTransferReceipt,
        chatID: UUID
    ) async -> Bool {
        guard ownershipActionState(chatID: chatID) != .loading else { return false }
        let operationGeneration = generation
        ownershipInitiationRetries[chatID] = command
        ownershipActionStates[chatID] = .loading
        ownershipActionErrors[chatID] = nil
        do {
            let receipt = try await initiator(command.chatID, command.targetUserID, command.nonce)
            guard generation == operationGeneration, !Task.isCancelled else { return false }
            guard receipt.transfer.chatID == chatID,
                  receipt.transfer.state == .pending,
                  receipt.transfer.fromUserID == currentUserID,
                  receipt.transfer.toUserID == command.targetUserID,
                  receipt.transfer.expiresAt > receipt.transfer.createdAt
            else { throw LuxoraAPIError.invalidResponse }
            ownershipInitiationRetries[chatID] = nil
            pendingTransfersByChat[chatID] = receipt.transfer
            ownershipTransferStates[chatID] = .loaded
            ownershipActionStates[chatID] = .loaded
            ownershipActionErrors[chatID] = nil
            return true
        } catch is CancellationError {
            if generation == operationGeneration {
                ownershipActionStates[chatID] = .idle
            }
            return false
        } catch {
            guard generation == operationGeneration else { return false }
            let definitive = Self.isDefinitiveRejection(error)
            if definitive { ownershipInitiationRetries[chatID] = nil }
            recordOwnershipActionFailure(
                chatID: chatID,
                message: Self.message(for: error, context: .ownership),
                retryable: !definitive
            )
            if definitive {
                // A pending ceremony may already exist on the server; reload so
                // the UI state matches reality instead of guessing.
                await loadPendingOwnershipTransfer(chatID: chatID, force: true)
            }
            return false
        }
    }

    private func performJoinByInvite(_ command: JoinByInviteCommand) async -> CommunityInviteJoinOutcome? {
        guard let remoteInviteJoiner else {
            joinByLinkOutcome = nil
            joinByInviteRetry = nil
            joinByLinkError = "Присоединение по ссылке не подключено."
            joinByLinkState = .failed(joinByLinkError!)
            return nil
        }
        let operationGeneration = generation
        joinByInviteRetry = command
        joinByLinkState = .loading
        joinByLinkError = nil
        joinByLinkOutcome = nil
        do {
            let outcome = try await remoteInviteJoiner(command.token, command.nonce)
            guard generation == operationGeneration, !Task.isCancelled else { return nil }
            joinByInviteRetry = nil
            joinByLinkOutcome = outcome
            joinByLinkState = .loaded
            return outcome
        } catch is CancellationError {
            if generation == operationGeneration {
                joinByLinkState = .idle
            }
            return nil
        } catch {
            guard generation == operationGeneration else { return nil }
            let definitive = Self.isDefinitiveRejection(error)
            if definitive { joinByInviteRetry = nil }
            joinByLinkOutcome = nil
            joinByLinkError = Self.message(for: error, context: .joinByLink)
            joinByLinkState = .failed(joinByLinkError ?? "Не удалось присоединиться по ссылке.")
            return nil
        }
    }

    private func recordInviteActionFailure(chatID: UUID, message: String, retryable: Bool) {
        inviteActionStates[chatID] = .failed(message)
        inviteActionErrors[chatID] = message
        if !retryable { inviteCreationRetries[chatID] = nil }
    }

    private func recordJoinDecisionFailure(requestID: UUID, message: String) {
        joinDecisionStates[requestID] = .failed(message)
        joinDecisionErrors[requestID] = message
    }

    private func recordOwnershipActionFailure(chatID: UUID, message: String, retryable: Bool) {
        ownershipActionStates[chatID] = .failed(message)
        ownershipActionErrors[chatID] = message
        if !retryable { ownershipInitiationRetries[chatID] = nil }
    }

    private func replaceInviteInList(_ invite: CommunityInviteLink, chatID: UUID) {
        guard invite.chatID == chatID else { return }
        var links = inviteLinksByChat[chatID] ?? []
        if let index = links.firstIndex(where: { $0.id == invite.id }) {
            links[index] = invite
        } else {
            links.append(invite)
        }
        inviteLinksByChat[chatID] = Self.sortedInviteLinks(links)
    }

    private func replaceJoinRequestInList(_ request: CommunityJoinRequest, chatID: UUID) {
        guard request.chatID == chatID else { return }
        var requests = joinRequestsByChat[chatID] ?? []
        if let index = requests.firstIndex(where: { $0.id == request.id }) {
            requests[index] = request
        } else {
            requests.append(request)
        }
        joinRequestsByChat[chatID] = Self.sortedJoinRequests(requests)
    }

    private func currentRole(in chatID: UUID) -> ChatMembershipRole? {
        communityStore?.currentUserRole(in: chatID)
    }

    // MARK: Validation and mapping

    private static let managerOnlyMessage =
        "Управлять ссылками и заявками могут только владелец и администраторы."

    static func isValidInviteToken(_ token: String) -> Bool {
        token.count == 43 && token.allSatisfy(isInviteTokenCharacter)
    }

    private static func isInviteTokenCharacter(_ character: Character) -> Bool {
        guard character.isASCII else { return false }
        return character.isLetter || character.isNumber || character == "-" || character == "_"
    }

    /// Accepts the raw token or a pasted text/link. Exactly one 43-character
    /// token run must exist; anything else is rejected instead of guessed.
    static func inviteToken(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if isValidInviteToken(trimmed) { return trimmed }
        var candidates: [String] = []
        var run = ""
        for character in trimmed {
            if isInviteTokenCharacter(character) {
                run.append(character)
            } else {
                if run.count == 43 { candidates.append(run) }
                run = ""
            }
        }
        if run.count == 43 { candidates.append(run) }
        guard candidates.count == 1 else { return nil }
        return candidates[0]
    }

    private static func validateTransferReceipt(
        _ receipt: CommunityOwnershipTransferReceipt,
        chatID: UUID,
        expectedID: UUID,
        expectedState: CommunityOwnershipTransferState
    ) throws {
        let transfer = receipt.transfer
        guard transfer.id == expectedID,
              transfer.chatID == chatID,
              transfer.state == expectedState,
              transfer.fromUserID != transfer.toUserID,
              transfer.expiresAt > transfer.createdAt
        else { throw LuxoraAPIError.invalidResponse }
    }

    private static func isDefinitiveRejection(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return 400..<500 ~= status
    }

    private enum ErrorContext: Equatable {
        case inviteLinks
        case inviteCreate
        case inviteRevoke
        case joinRequests
        case joinDecision
        case ownership
        case joinByLink
    }

    private static func message(for error: Error, context: ErrorContext) -> String {
        if error is CancellationError { return "Запрос отменён." }
        guard let apiError = error as? LuxoraAPIError else {
            return "Нет связи с сервером. Проверьте сеть и повторите."
        }
        switch apiError {
        case .invalidResponse:
            return "Сервер вернул несогласованные данные. Повторите запрос."
        case .transport:
            switch context {
            case .inviteCreate, .ownership, .joinByLink:
                return "Нет связи с сервером. Проверьте сеть и повторите — повтор безопасен."
            case .inviteLinks, .inviteRevoke, .joinRequests, .joinDecision:
                return "Нет связи с сервером. Проверьте сеть и повторите."
            }
        case .incompatibleServer:
            return "Сервер Luxora не поддерживает управление сообществом в этой версии."
        case .missingSession:
            return "Сеанс недоступен. Войдите снова."
        case .syncUnstable:
            return "Состояние менялось во время запроса. Повторите."
        case let .server(status, _, _):
            return serverMessage(status: status, context: context)
        }
    }

    private static func serverMessage(status: Int, context: ErrorContext) -> String {
        if status == 401 { return "Сеанс истёк. Войдите снова." }
        switch context {
        case .inviteLinks, .inviteCreate, .inviteRevoke:
            if status == 403 { return managerOnlyMessage }
            if status == 404 {
                return context == .inviteCreate
                    ? "Сообщество не найдено на сервере."
                    : "Ссылка-приглашение не найдена на сервере. Обновите список."
            }
            if status == 409, context == .inviteCreate {
                return "Сервер уже обработал такой запрос, но токен показывается только один раз — создать повторно нельзя. Создайте новую ссылку."
            }
            if status == 400 { return "Сервер отклонил параметры ссылки. Проверьте срок и лимит." }
        case .joinRequests, .joinDecision:
            if status == 403 { return managerOnlyMessage }
            if status == 404 {
                return context == .joinDecision
                    ? "Заявка не найдена или ссылка-приглашение больше не действует. Обновите заявки."
                    : "Сообщество не найдено на сервере."
            }
            if status == 409 {
                return "Сервер не смог принять заявку: возможно, ссылка истекла или отозвана либо достигнут предел в 200 участников. Обновите список."
            }
        case .ownership:
            if status == 403 {
                return "Передачу владения видят только владелец, администраторы и назначенный преемник; менять её может владелец."
            }
            if status == 404 {
                return "Передача владения не найдена на сервере. Обновите состояние."
            }
            if status == 409 {
                return "Уже есть ожидающая передача владения или состояние изменилось. Обновите."
            }
        case .joinByLink:
            if status == 403 { return "Сервер запретил присоединение по этой ссылке." }
            if status == 404 {
                return "Ссылка-приглашение больше не действует: она отозвана, истекла или исчерпана."
            }
            if status == 409 {
                return "Сервер отклонил присоединение: возможно, в сообществе уже 200 участников. Проверьте ссылку."
            }
            if status == 400 { return "Сервер не принял токен-приглашение. Проверьте, что он скопирован полностью." }
        }
        if status == 429 { return "Слишком много запросов. Подождите и повторите." }
        return "Сервер не выполнил запрос (код \(status))."
    }

    private static func sortedInviteLinks(_ links: [CommunityInviteLink]) -> [CommunityInviteLink] {
        links.sorted { lhs, rhs in
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }

    private static func sortedJoinRequests(_ requests: [CommunityJoinRequest]) -> [CommunityJoinRequest] {
        requests.sorted { lhs, rhs in
            if lhs.state != rhs.state {
                let rank: (CommunityJoinRequestState) -> Int = { state in
                    state == .pending ? 0 : 1
                }
                return rank(lhs.state) < rank(rhs.state)
            }
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }
}

private struct InviteCreationCommand: Sendable {
    let chatID: UUID
    let approvalRequired: Bool
    let expiresInSeconds: Int?
    let maxUses: Int?
    let nonce: UUID
}

private struct OwnershipInitiationCommand: Sendable {
    let chatID: UUID
    let targetUserID: UUID
    let nonce: UUID
}

private struct JoinByInviteCommand: Sendable {
    let token: String
    let nonce: UUID
}
