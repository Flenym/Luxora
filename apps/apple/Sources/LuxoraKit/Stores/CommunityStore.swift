import Foundation
import Observation

public enum CommunityCreationCertainty: Equatable, Sendable {
    case idle
    case confirmed
    case definitivelyRejected
    case outcomeUnknown
}

enum CommunityStoreError: LocalizedError, Equatable {
    case invalidTitle
    case tooManyMembers
    case duplicateMember
    case invalidCommunity
    case invalidMemberPage
    case invalidMembershipReceipt
    case missingMemberList
    case operationNotPermitted
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalidTitle:
            "Название должно содержать от 1 до 120 символов."
        case .tooManyMembers:
            "В группе или канале может быть не более 200 участников вместе с владельцем."
        case .duplicateMember:
            "Один и тот же участник выбран несколько раз."
        case .invalidCommunity:
            "Сервер вернул несогласованные данные группы или канала."
        case .invalidMemberPage:
            "Сервер вернул несогласованный список участников."
        case .invalidMembershipReceipt:
            "Сервер не подтвердил изменение состава чата корректной квитанцией."
        case .missingMemberList:
            "Сначала загрузите актуальный список участников."
        case .operationNotPermitted:
            "У вашей роли нет права на это действие."
        case let .unavailable(message):
            message
        }
    }
}

private struct CommunityMembershipFenceKey: Hashable {
    let chatID: UUID
    let userID: UUID
}

private struct CommunityMembershipFence: Sendable {
    let membership: ChatMembership
    let isRemoved: Bool
    /// Durable realtime ordering, when the fence came from a dispatch. This
    /// lets a later `.added` event open a new membership lifecycle even if the
    /// server wall clock moved backwards between remove and re-add.
    let causalSequence: Int?
}

@MainActor
@Observable
public final class CommunityStore {
    public private(set) var currentUserID: UUID
    public private(set) var communities: [Conversation]
    public private(set) var communityStates: [UUID: RemoteContentState] = [:]
    public private(set) var membersByCommunity: [UUID: [CommunityMember]] = [:]
    public private(set) var memberListStates: [UUID: RemoteContentState] = [:]
    public private(set) var creationState: RemoteContentState = .idle
    public private(set) var creationCertainty: CommunityCreationCertainty = .idle
    public private(set) var creationError: String?
    public private(set) var lookupState: RemoteContentState = .idle
    public private(set) var lookupResult: Participant?
    public private(set) var mutationStates: [CommunityMemberMutationKey: RemoteContentState] = [:]
    public private(set) var mutationFailures: [CommunityMemberMutationKey: CommunityMemberMutationFailure] = [:]

    var remoteCreator: (@Sendable (CommunityKind, String, [UUID]) async throws -> Conversation)?
    var remoteCommunityLoader: (@Sendable (UUID) async throws -> Conversation)?
    var remoteMemberLoader: (@Sendable (UUID) async throws -> [CommunityMember])?
    var remoteExactUserLookup: (@Sendable (String) async throws -> Participant?)?
    var remoteMemberAdder: (@Sendable (UUID, UUID, ChatMembershipRole, UUID) async throws -> CommunityMembershipMutationReceipt)?
    var remoteMemberRoleUpdater: (@Sendable (UUID, UUID, ChatMembershipRole, Int, UUID) async throws -> CommunityMembershipMutationReceipt)?
    var remoteMemberRemover: (@Sendable (UUID, UUID, Int, UUID) async throws -> CommunityMembershipMutationReceipt)?

    @ObservationIgnored private var confirmedCommunityObserver: (@MainActor (Conversation) -> Void)?
    @ObservationIgnored private var confirmedCommunityMetadataObserver: (@MainActor (UUID, Int, String?) -> Void)?
    @ObservationIgnored private var confirmedCommunityRemovalObserver: (@MainActor (UUID) -> Void)?
    @ObservationIgnored private var creationRetry: CommunityCreationRetry?
    @ObservationIgnored private var mutationRetries: [CommunityMemberMutationKey: CommunityMemberMutationRetry] = [:]
    @ObservationIgnored private var lookupGeneration: UInt = 0
    @ObservationIgnored private var operationGeneration: UInt = 0
    @ObservationIgnored private var membershipFences: [CommunityMembershipFenceKey: CommunityMembershipFence] = [:]
    @ObservationIgnored private var membershipEpochs: [UUID: UInt] = [:]
    @ObservationIgnored private var memberLoadAttempts: [UUID: UInt] = [:]

    public init(currentUserID: UUID, communities: [Conversation] = []) {
        self.currentUserID = currentUserID
        self.communities = Self.sortedCommunities(
            communities.filter { $0.kind == .group || $0.kind == .channel }
        )
    }

    public var canRetryCommunityCreation: Bool {
        creationRetry != nil && creationCertainty == .definitivelyRejected
    }

    public func community(_ chatID: UUID) -> Conversation? {
        communities.first { $0.id == chatID }
    }

    public func members(_ chatID: UUID) -> [CommunityMember] {
        membersByCommunity[chatID] ?? []
    }

    public func memberListState(_ chatID: UUID) -> RemoteContentState {
        memberListStates[chatID] ?? .idle
    }

    public func mutationState(_ key: CommunityMemberMutationKey) -> RemoteContentState {
        mutationStates[key] ?? .idle
    }

    public func currentUserRole(in chatID: UUID) -> ChatMembershipRole? {
        currentRole(in: chatID)
    }

    public func containsMember(_ userID: UUID, in chatID: UUID) -> Bool {
        member(chatID: chatID, userID: userID) != nil
    }

    public func clearLookup() {
        lookupGeneration &+= 1
        lookupResult = nil
        lookupState = .idle
    }

    public func clearMutationFailure(_ key: CommunityMemberMutationKey) {
        guard mutationState(key) != .loading else { return }
        mutationStates[key] = .idle
        mutationFailures[key] = nil
        mutationRetries[key] = nil
    }

    public func synchronizeConfirmedCommunities(_ conversations: [Conversation]) throws {
        let candidates = conversations.filter { $0.kind == .group || $0.kind == .channel }
        guard Set(candidates.map(\.id)).count == candidates.count,
              candidates.allSatisfy(Self.validCommunityProjection)
        else {
            throw CommunityStoreError.invalidCommunity
        }
        communities = Self.sortedCommunities(candidates)
        let retained = Set(candidates.map(\.id))
        membersByCommunity = membersByCommunity.filter { retained.contains($0.key) }
        memberListStates = memberListStates.filter { retained.contains($0.key) }
        communityStates = communityStates.filter { retained.contains($0.key) }
        membershipFences = membershipFences.filter { retained.contains($0.key.chatID) }
        membershipEpochs = membershipEpochs.filter { retained.contains($0.key) }
        memberLoadAttempts = memberLoadAttempts.filter { retained.contains($0.key) }
    }

    /// Rebuilds community member pages and lifecycle fences from the same
    /// account-scoped snapshot boundary used by MessengerStore. This is the
    /// only HTTP path allowed to replace ambiguous membership incarnations.
    func validateReconciliation(
        _ bundle: LuxoraReconciliationBundle,
        currentUserID: UUID
    ) throws {
        _ = try stageReconciliation(bundle, currentUserID: currentUserID)
    }

    func applyReconciliation(
        _ bundle: LuxoraReconciliationBundle,
        currentUserID: UUID
    ) throws {
        let staged = try stageReconciliation(bundle, currentUserID: currentUserID)

        cancelRemoteOperations()
        communities = Self.sortedCommunities(staged.communities)
        membersByCommunity = staged.members
        communityStates = Dictionary(
            uniqueKeysWithValues: staged.communities.map { ($0.id, RemoteContentState.loaded) }
        )
        memberListStates = Dictionary(
            uniqueKeysWithValues: staged.communities.map { ($0.id, RemoteContentState.loaded) }
        )
        membershipFences = staged.fences
        membershipEpochs = Dictionary(
            uniqueKeysWithValues: staged.communities.map {
                ($0.id, membershipEpochs[$0.id, default: 0] &+ 1)
            }
        )
        memberLoadAttempts = Dictionary(
            uniqueKeysWithValues: staged.communities.map {
                ($0.id, memberLoadAttempts[$0.id, default: 0] &+ 1)
            }
        )
    }

    private struct ReconciliationProjection {
        let communities: [Conversation]
        let members: [UUID: [CommunityMember]]
        let fences: [CommunityMembershipFenceKey: CommunityMembershipFence]
    }

    private func stageReconciliation(
        _ bundle: LuxoraReconciliationBundle,
        currentUserID: UUID
    ) throws -> ReconciliationProjection {
        guard currentUserID == self.currentUserID else {
            throw CommunityStoreError.invalidMemberPage
        }

        var rebuiltCommunities: [Conversation] = []
        var rebuiltMembers: [UUID: [CommunityMember]] = [:]
        var rebuiltFences: [CommunityMembershipFenceKey: CommunityMembershipFence] = [:]

        for state in bundle.chats {
            let conversation = state.chat.conversation(currentUserID: currentUserID)
            guard conversation.kind == .group || conversation.kind == .channel else { continue }
            guard Self.validCommunityProjection(conversation),
                  state.members.count == conversation.memberCount,
                  state.members.count <= 200,
                  Set(state.members.map { $0.membership.userId }).count == state.members.count
            else { throw CommunityStoreError.invalidMemberPage }

            let members = try state.members.map { item -> CommunityMember in
                guard item.membership.chatId == conversation.id,
                      item.membership.userId == item.user.id,
                      item.membership.revision > 0,
                      item.membership.updatedAt >= item.membership.joinedAt,
                      let role = ChatMembershipRole(rawValue: item.membership.role)
                else { throw CommunityStoreError.invalidMemberPage }
                let membership = ChatMembership(
                    chatID: item.membership.chatId,
                    userID: item.membership.userId,
                    role: role,
                    revision: item.membership.revision,
                    joinedAt: item.membership.joinedAt,
                    updatedAt: item.membership.updatedAt
                )
                return CommunityMember(membership: membership, participant: item.user.participant)
            }
            guard members.filter({ $0.membership.role == .owner }).count == 1,
                  let ownMembership = members.first(where: { $0.id == currentUserID }),
                  conversation.serverRole == ownMembership.membership.role.rawValue
            else { throw CommunityStoreError.invalidMemberPage }

            let sorted = Self.sortedMembers(members)
            rebuiltCommunities.append(conversation)
            rebuiltMembers[conversation.id] = sorted
            for member in sorted {
                rebuiltFences[CommunityMembershipFenceKey(
                    chatID: conversation.id,
                    userID: member.id
                )] = CommunityMembershipFence(
                    membership: member.membership,
                    isRemoved: false,
                    causalSequence: bundle.boundary.sequence
                )
            }
        }
        guard Set(rebuiltCommunities.map(\.id)).count == rebuiltCommunities.count else {
            throw CommunityStoreError.invalidCommunity
        }
        return ReconciliationProjection(
            communities: rebuiltCommunities,
            members: rebuiltMembers,
            fences: rebuiltFences
        )
    }

    /// Applies a single server-confirmed group/channel projection, for example
    /// after creation or a durable `chat.created` realtime dispatch. Invalid
    /// projections are rejected before they can become visible in the UI.
    func validateConfirmedCommunity(_ conversation: Conversation) throws {
        guard Self.validCommunityProjection(conversation) else {
            throw CommunityStoreError.invalidCommunity
        }
    }

    public func acceptConfirmedCommunity(_ conversation: Conversation) throws {
        try validateConfirmedCommunity(conversation)
        upsert(conversation)
        communityStates[conversation.id] = .loaded
    }

    /// Removes only state already confirmed by the server (self-leave or a
    /// durable removal event). Callers must not use this for speculative UI.
    public func acceptConfirmedCommunityRemoval(_ chatID: UUID) {
        membershipEpochs[chatID, default: 0] &+= 1
        memberLoadAttempts[chatID, default: 0] &+= 1
        communities.removeAll { $0.id == chatID }
        membersByCommunity[chatID] = nil
        memberListStates[chatID] = nil
        communityStates[chatID] = nil
        mutationStates = mutationStates.filter { $0.key.chatID != chatID }
        mutationFailures = mutationFailures.filter { $0.key.chatID != chatID }
        mutationRetries = mutationRetries.filter { $0.key.chatID != chatID }
        confirmedCommunityRemovalObserver?(chatID)
    }

    /// A membership realtime event does not contain the changed user's public
    /// profile. Mark the page stale so the authoritative member endpoint is
    /// reloaded instead of synthesizing an incomplete row.
    public func markConfirmedMemberPageStale(_ chatID: UUID) {
        guard community(chatID) != nil else { return }
        memberListStates[chatID] = .idle
    }

    /// Applies the authoritative part of a durable membership event without
    /// manufacturing the public profile omitted by that event. It also avoids
    /// double-counting when the same server mutation was already reconciled by
    /// its HTTP response before realtime delivery.
    public func acceptConfirmedMembershipSignal(
        _ membership: ChatMembership,
        change: CommunityMembershipSignalChange,
        causalSequence: Int? = nil
    ) throws {
        try validateConfirmedMembershipSignal(
            membership,
            change: change,
            causalSequence: causalSequence
        )
        guard membership.revision > 0,
              membership.updatedAt >= membership.joinedAt,
              causalSequence.map({ $0 > 0 }) ?? true
        else { throw CommunityStoreError.invalidMembershipReceipt }

        let chatID = membership.chatID
        let fenceKey = CommunityMembershipFenceKey(
            chatID: membership.chatID,
            userID: membership.userID
        )
        if let fence = membershipFences[fenceKey],
           !isAuthorizedNewLifecycle(
               membership,
               change: change,
               causalSequence: causalSequence,
               after: fence
           ) {
            guard membership.joinedAt == fence.membership.joinedAt else {
                // A member page has no causal cursor and timestamps are not a
                // monotonic lifecycle identifier. Unknown incarnations must be
                // reconciled, never allowed to roll a confirmed fence back.
                throw CommunityStoreError.invalidMembershipReceipt
            }
            if membership.revision < fence.membership.revision { return }
            if membership.revision == fence.membership.revision {
                guard fence.membership == membership,
                      fence.isRemoved == (change == .removed)
                else { throw CommunityStoreError.invalidMembershipReceipt }
                if let causalSequence,
                   fence.causalSequence.map({ causalSequence > $0 }) ?? true {
                    // An HTTP receipt may establish the tombstone first. The
                    // identical later dispatch enriches it with causal order so
                    // a subsequent re-add can open a new lifecycle safely.
                    recordMembershipFence(
                        membership,
                        isRemoved: change == .removed,
                        causalSequence: causalSequence
                    )
                }
                return
            }
            if fence.isRemoved {
                // Only `.added` may leave a removed lifecycle, and only the
                // authorized newer incarnation handled above. A later role or
                // second removal cannot revive/mutate a tombstone.
                throw CommunityStoreError.invalidMembershipReceipt
            }
            if change == .added {
                // `.added` must open a different, globally newer lifecycle;
                // it cannot be a revision bump inside an active incarnation.
                throw CommunityStoreError.invalidMembershipReceipt
            }
        }

        if membership.userID == currentUserID, change == .removed {
            recordMembershipFence(
                membership,
                isRemoved: true,
                causalSequence: causalSequence
            )
            acceptConfirmedCommunityRemoval(chatID)
            return
        }
        guard let communityIndex = communities.firstIndex(where: { $0.id == chatID }) else {
            // `chat.created` or snapshot reconciliation owns the full projection
            // when this account has only just been added.
            recordMembershipFence(
                membership,
                isRemoved: change == .removed,
                causalSequence: causalSequence
            )
            return
        }

        // A forced refresh changes only the loading indicator; the previously
        // validated page remains confirmed baseline and can absorb a complete
        // role/remove event while the request is in flight.
        let hasConfirmedPage = membersByCommunity[chatID] != nil
        let memberIndex = membersByCommunity[chatID]?.firstIndex { $0.id == membership.userID }

        if membership.userID == currentUserID {
            communities[communityIndex].serverRole = membership.role.rawValue
        }

        switch change {
        case .added:
            if membership.userID != currentUserID {
                let alreadyReflected = hasConfirmedPage && memberIndex != nil
                if !alreadyReflected {
                    let nextCount = communities[communityIndex].memberCount + 1
                    guard (1...200).contains(nextCount) else {
                        throw CommunityStoreError.invalidCommunity
                    }
                    communities[communityIndex].memberCount = nextCount
                }
            }
            if let memberIndex, hasConfirmedPage {
                membersByCommunity[chatID]?[memberIndex].membership = membership
                memberListStates[chatID] = .loaded
            } else {
                // The event has no display name/avatar, so retain the old page
                // only as stale evidence until `/members` returns the profile.
                memberListStates[chatID] = .idle
            }

        case .roleUpdated:
            if let memberIndex, hasConfirmedPage {
                membersByCommunity[chatID]?[memberIndex].membership = membership
                memberListStates[chatID] = .loaded
            } else {
                memberListStates[chatID] = .idle
            }

        case .removed:
            let alreadyReflected = hasConfirmedPage && memberIndex == nil
            if !alreadyReflected {
                let nextCount = communities[communityIndex].memberCount - 1
                guard (1...200).contains(nextCount) else {
                    throw CommunityStoreError.invalidCommunity
                }
                communities[communityIndex].memberCount = nextCount
            }
            if let memberIndex, hasConfirmedPage {
                membersByCommunity[chatID]?.remove(at: memberIndex)
                memberListStates[chatID] = .loaded
            } else if !hasConfirmedPage {
                memberListStates[chatID] = .idle
            }
        }

        recordMembershipFence(
            membership,
            isRemoved: change == .removed,
            causalSequence: causalSequence
        )
        publishCommunityMetadata(communities[communityIndex])
    }

    /// Pure preflight for the throwing half of a cross-store membership
    /// dispatch. ApplicationSession calls this before Messenger is mutated,
    /// then keeps the established Messenger -> Community commit order so the
    /// absolute metadata observer cannot double-increment member counts.
    func validateConfirmedMembershipSignal(
        _ membership: ChatMembership,
        change: CommunityMembershipSignalChange,
        causalSequence: Int? = nil
    ) throws {
        guard membership.revision > 0,
              membership.updatedAt >= membership.joinedAt,
              causalSequence.map({ $0 > 0 }) ?? true
        else { throw CommunityStoreError.invalidMembershipReceipt }

        let fenceKey = CommunityMembershipFenceKey(
            chatID: membership.chatID,
            userID: membership.userID
        )
        if let fence = membershipFences[fenceKey],
           !isAuthorizedNewLifecycle(
               membership,
               change: change,
               causalSequence: causalSequence,
               after: fence
           ) {
            guard membership.joinedAt == fence.membership.joinedAt else {
                throw CommunityStoreError.invalidMembershipReceipt
            }
            if membership.revision < fence.membership.revision { return }
            if membership.revision == fence.membership.revision {
                guard fence.membership == membership,
                      fence.isRemoved == (change == .removed)
                else { throw CommunityStoreError.invalidMembershipReceipt }
                return
            }
            if fence.isRemoved || change == .added {
                throw CommunityStoreError.invalidMembershipReceipt
            }
        }

        if membership.userID == currentUserID, change == .removed { return }
        guard let community = community(membership.chatID) else { return }
        let hasConfirmedPage = membersByCommunity[membership.chatID] != nil
        let containsMember = membersByCommunity[membership.chatID]?.contains {
            $0.id == membership.userID
        } == true

        switch change {
        case .added where membership.userID != currentUserID:
            if !(hasConfirmedPage && containsMember) {
                guard (1...200).contains(community.memberCount + 1) else {
                    throw CommunityStoreError.invalidCommunity
                }
            }
        case .removed:
            let alreadyReflected = hasConfirmedPage && !containsMember
            if !alreadyReflected {
                guard (1...200).contains(community.memberCount - 1) else {
                    throw CommunityStoreError.invalidCommunity
                }
            }
        case .added, .roleUpdated:
            break
        }
    }

    @discardableResult
    public func createCommunity(
        kind: CommunityKind,
        title rawTitle: String,
        memberIDs rawMemberIDs: [UUID]
    ) async -> Conversation? {
        guard creationState != .loading else { return nil }
        do {
            let input = try Self.validatedCreationInput(
                kind: kind,
                title: rawTitle,
                memberIDs: rawMemberIDs,
                currentUserID: currentUserID
            )
            return await performCreation(input)
        } catch {
            creationRetry = nil
            creationCertainty = .definitivelyRejected
            creationError = Self.russianMessage(for: error)
            creationState = .failed(creationError ?? "Не удалось создать чат.")
            return nil
        }
    }

    @discardableResult
    public func retryCommunityCreation() async -> Conversation? {
        guard let creationRetry, creationCertainty == .definitivelyRejected else { return nil }
        return await performCreation(creationRetry)
    }

    public func clearCreationResult() {
        guard creationState != .loading else { return }
        creationState = .idle
        creationCertainty = .idle
        creationError = nil
        creationRetry = nil
    }

    public func refreshCommunity(_ chatID: UUID) async {
        guard let remoteCommunityLoader else {
            communityStates[chatID] = .failed("Загрузка группы или канала с сервера не подключена.")
            return
        }
        guard communityStates[chatID] != .loading else { return }
        let generation = operationGeneration
        let membershipEpoch = membershipEpochs[chatID, default: 0]
        communityStates[chatID] = .loading
        do {
            var loaded = try await remoteCommunityLoader(chatID)
            try Self.validateCommunity(loaded, expectedID: chatID)
            guard operationGeneration == generation, !Task.isCancelled else { return }
            if membershipEpochs[chatID, default: 0] != membershipEpoch {
                // A membership dispatch committed while this detail request was
                // in flight. The delayed GET may still update identity fields,
                // but it cannot roll member count/role back. If the account was
                // removed, it must not resurrect the community at all.
                guard let current = community(chatID) else { return }
                loaded.memberCount = current.memberCount
                loaded.serverRole = current.serverRole
            }
            upsert(loaded)
            communityStates[chatID] = .loaded
        } catch is CancellationError {
            guard operationGeneration == generation else { return }
            communityStates[chatID] = community(chatID) == nil ? .idle : .loaded
        } catch {
            guard operationGeneration == generation else { return }
            communityStates[chatID] = .failed(Self.russianMessage(for: error))
        }
    }

    public func loadMembers(_ chatID: UUID, force: Bool = false) async {
        guard let remoteMemberLoader else {
            memberListStates[chatID] = .failed("Загрузка участников с сервера не подключена.")
            return
        }
        guard force || memberListState(chatID) != .loading else { return }
        let generation = operationGeneration
        memberLoadAttempts[chatID, default: 0] &+= 1
        let attempt = memberLoadAttempts[chatID, default: 0]
        let membershipEpoch = membershipEpochs[chatID, default: 0]
        memberListStates[chatID] = .loading
        do {
            let loaded = try await remoteMemberLoader(chatID)
            guard operationGeneration == generation,
                  memberLoadAttempts[chatID] == attempt,
                  membershipEpochs[chatID, default: 0] == membershipEpoch,
                  !Task.isCancelled
            else { return }
            let validated = try validateMemberPage(loaded, chatID: chatID)
            acceptMemberPage(validated, chatID: chatID)
            memberListStates[chatID] = .loaded
        } catch is CancellationError {
            guard operationGeneration == generation,
                  memberLoadAttempts[chatID] == attempt
            else { return }
            memberListStates[chatID] = members(chatID).isEmpty ? .idle : .loaded
        } catch {
            guard operationGeneration == generation,
                  memberLoadAttempts[chatID] == attempt
            else { return }
            memberListStates[chatID] = .failed(Self.russianMessage(for: error))
        }
    }

    public func lookupMemberCandidate(_ rawUsername: String) async {
        lookupGeneration &+= 1
        let generation = lookupGeneration
        lookupResult = nil
        let username = Self.normalizedUsername(rawUsername)
        guard !username.isEmpty else {
            lookupState = .idle
            return
        }
        guard let remoteExactUserLookup else {
            lookupState = .failed("Точный поиск username на сервере не подключён.")
            return
        }
        lookupState = .loading
        do {
            let participant = try await remoteExactUserLookup(username)
            guard lookupGeneration == generation, !Task.isCancelled else { return }
            if let participant {
                guard participant.username.caseInsensitiveCompare(username) == .orderedSame,
                      participant.id != currentUserID
                else {
                    throw CommunityStoreError.invalidMemberPage
                }
            }
            lookupResult = participant
            lookupState = .loaded
        } catch is CancellationError {
            guard lookupGeneration == generation else { return }
            lookupState = .idle
        } catch {
            guard lookupGeneration == generation else { return }
            lookupResult = nil
            lookupState = .failed(Self.russianMessage(for: error))
        }
    }

    @discardableResult
    public func addMember(
        _ participant: Participant,
        role: ChatMembershipRole = .member,
        to chatID: UUID
    ) async -> Bool {
        let fenceKey = CommunityMembershipFenceKey(chatID: chatID, userID: participant.id)
        let command = CommunityMemberMutationRetry.add(
            participant: participant,
            role: role,
            preflightFence: membershipFences[fenceKey],
            nonce: UUID()
        )
        return await performMutation(command, chatID: chatID)
    }

    @discardableResult
    public func changeRole(
        of userID: UUID,
        to role: ChatMembershipRole,
        in chatID: UUID
    ) async -> Bool {
        guard let target = member(chatID: chatID, userID: userID) else {
            recordPreflightFailure(chatID: chatID, userID: userID, kind: .changeRole, error: .missingMemberList)
            return false
        }
        let command = CommunityMemberMutationRetry.changeRole(
            userID: userID,
            role: role,
            previous: target.membership,
            nonce: UUID()
        )
        return await performMutation(command, chatID: chatID)
    }

    @discardableResult
    public func removeMember(_ userID: UUID, from chatID: UUID) async -> Bool {
        guard let target = member(chatID: chatID, userID: userID) else {
            recordPreflightFailure(chatID: chatID, userID: userID, kind: .remove, error: .missingMemberList)
            return false
        }
        let command = CommunityMemberMutationRetry.remove(
            userID: userID,
            previous: target.membership,
            nonce: UUID()
        )
        return await performMutation(command, chatID: chatID)
    }

    @discardableResult
    public func retryMutation(_ key: CommunityMemberMutationKey) async -> Bool {
        guard let command = mutationRetries[key] else { return false }
        return await performMutation(command, chatID: key.chatID)
    }

    public func canAddMember(role: ChatMembershipRole, to chatID: UUID) -> Bool {
        guard role != .owner, let actorRole = currentRole(in: chatID) else { return false }
        return actorRole == .owner || (actorRole == .admin && role == .member)
    }

    public func canChangeRole(of userID: UUID, to role: ChatMembershipRole, in chatID: UUID) -> Bool {
        guard role != .owner,
              currentRole(in: chatID) == .owner,
              let target = member(chatID: chatID, userID: userID),
              target.membership.role != .owner
        else { return false }
        return target.membership.role != role
    }

    public func canRemoveMember(_ userID: UUID, from chatID: UUID) -> Bool {
        guard let actorRole = currentRole(in: chatID),
              let target = member(chatID: chatID, userID: userID),
              target.membership.role != .owner
        else { return false }
        if userID == currentUserID { return true }
        if actorRole == .owner { return true }
        return actorRole == .admin && target.membership.role == .member
    }

    public func canPublish(in conversation: Conversation) -> Bool {
        guard conversation.kind == .group || conversation.kind == .channel else { return true }
        let role = currentRole(in: conversation.id)
            ?? conversation.serverRole.flatMap(ChatMembershipRole.init(rawValue:))
        guard let role else { return false }
        return conversation.kind == .group || role.isPrivileged
    }

    func configureRemote(
        creator: @escaping @Sendable (CommunityKind, String, [UUID]) async throws -> Conversation,
        communityLoader: @escaping @Sendable (UUID) async throws -> Conversation,
        memberLoader: @escaping @Sendable (UUID) async throws -> [CommunityMember],
        exactUserLookup: @escaping @Sendable (String) async throws -> Participant?,
        memberAdder: @escaping @Sendable (UUID, UUID, ChatMembershipRole, UUID) async throws -> CommunityMembershipMutationReceipt,
        memberRoleUpdater: @escaping @Sendable (UUID, UUID, ChatMembershipRole, Int, UUID) async throws -> CommunityMembershipMutationReceipt,
        memberRemover: @escaping @Sendable (UUID, UUID, Int, UUID) async throws -> CommunityMembershipMutationReceipt
    ) {
        remoteCreator = creator
        remoteCommunityLoader = communityLoader
        remoteMemberLoader = memberLoader
        remoteExactUserLookup = exactUserLookup
        remoteMemberAdder = memberAdder
        remoteMemberRoleUpdater = memberRoleUpdater
        remoteMemberRemover = memberRemover
    }

    /// Keeps the messenger inbox synchronized only with projections that this
    /// store has already validated as server-confirmed. The callbacks run on
    /// the main actor and are never used for speculative optimistic state.
    func configureProjectionObservers(
        communityUpdated: @escaping @MainActor (Conversation) -> Void,
        communityRemoved: @escaping @MainActor (UUID) -> Void,
        communityMetadataUpdated: @escaping @MainActor (UUID, Int, String?) -> Void = { _, _, _ in }
    ) {
        confirmedCommunityObserver = communityUpdated
        confirmedCommunityRemovalObserver = communityRemoved
        confirmedCommunityMetadataObserver = communityMetadataUpdated
    }

    func replaceIdentity(_ userID: UUID, communities: [Conversation] = []) {
        cancelRemoteOperations()
        currentUserID = userID
        self.communities = Self.sortedCommunities(
            communities.filter { $0.kind == .group || $0.kind == .channel }
        )
        communityStates.removeAll()
        membersByCommunity.removeAll()
        memberListStates.removeAll()
        creationState = .idle
        creationCertainty = .idle
        creationError = nil
        creationRetry = nil
        lookupState = .idle
        lookupResult = nil
        mutationStates.removeAll()
        mutationFailures.removeAll()
        mutationRetries.removeAll()
        membershipFences.removeAll()
        membershipEpochs.removeAll()
        memberLoadAttempts.removeAll()
    }

    func cancelRemoteOperations() {
        operationGeneration &+= 1
        lookupGeneration &+= 1
        if creationState == .loading { creationState = .idle }
        communityStates = communityStates.mapValues { $0 == .loading ? .idle : $0 }
        memberListStates = memberListStates.mapValues { $0 == .loading ? .idle : $0 }
        mutationStates = mutationStates.mapValues { $0 == .loading ? .idle : $0 }
        if lookupState == .loading { lookupState = .idle }
    }

    private func performCreation(_ input: CommunityCreationRetry) async -> Conversation? {
        guard let remoteCreator else {
            creationRetry = input
            creationCertainty = .definitivelyRejected
            creationError = "Создание групп и каналов на сервере не подключено."
            creationState = .failed(creationError!)
            return nil
        }
        let generation = operationGeneration
        creationState = .loading
        creationCertainty = .idle
        creationError = nil
        do {
            let created = try await remoteCreator(input.kind, input.title, input.memberIDs)
            let expectedMemberCount = Set(input.memberIDs.filter { $0 != currentUserID }).count + 1
            try Self.validateCreatedCommunity(
                created,
                input: input,
                expectedMemberCount: expectedMemberCount
            )
            guard operationGeneration == generation, !Task.isCancelled else { return nil }
            upsert(created)
            creationRetry = nil
            creationCertainty = .confirmed
            creationState = .loaded
            return created
        } catch is CancellationError {
            guard operationGeneration == generation else { return nil }
            creationRetry = nil
            creationCertainty = .outcomeUnknown
            creationError = "Создание могло завершиться на сервере. Обновите список чатов; не повторяйте запрос вслепую."
            creationState = .failed(creationError!)
            return nil
        } catch {
            guard operationGeneration == generation else { return nil }
            let definitive = Self.isDefinitiveCreationFailure(error)
            creationRetry = definitive ? input : nil
            creationCertainty = definitive ? .definitivelyRejected : .outcomeUnknown
            creationError = definitive
                ? Self.russianMessage(for: error)
                : "Результат создания неизвестен. Обновите список чатов; повтор может создать дубликат."
            creationState = .failed(creationError!)
            return nil
        }
    }

    private func performMutation(
        _ command: CommunityMemberMutationRetry,
        chatID: UUID
    ) async -> Bool {
        let key = command.key(chatID: chatID)
        guard mutationState(key) != .loading else { return false }
        do {
            try validatePermission(for: command, chatID: chatID)
        } catch {
            recordFailure(key: key, command: nil, error: error)
            return false
        }
        guard let remoteMemberLoader else {
            recordFailure(
                key: key,
                command: command,
                error: CommunityStoreError.unavailable("Загрузка участников с сервера не подключена.")
            )
            return false
        }
        let generation = operationGeneration
        mutationRetries[key] = command
        mutationFailures[key] = nil
        mutationStates[key] = .loading
        do {
            let receipt = try await execute(command, chatID: chatID)
            try validate(receipt, for: command, chatID: chatID)
            guard operationGeneration == generation, !Task.isCancelled else { return false }

            var removalReceiptIsCurrent = false
            if case .add = command {
                // A successful nonced add receipt is direct causal authority
                // for a new incarnation, including re-add after
                // a physical-delete tombstone. UI remains confirmed-only until
                // the post-mutation member page validates.
                _ = recordMembershipFence(receipt.membership, isRemoved: false)
            } else if case .remove = command {
                // Record the terminal revision before the canonical page read.
                // A concurrent re-add with a still higher global revision can
                // then replace it without being overwritten after the read.
                removalReceiptIsCurrent = recordMembershipFence(
                    receipt.membership,
                    isRemoved: true
                )
            }

            let shouldRemoveCurrentUser = command.isSelfRemoval(currentUserID: currentUserID)
                && removalReceiptIsCurrent
            if shouldRemoveCurrentUser {
                acceptConfirmedCommunityRemoval(chatID)
            } else {
                let loaded = try await remoteMemberLoader(chatID)
                let validated = try validateMemberPage(
                    loaded,
                    chatID: chatID,
                    requireKnownCountMatch: false
                )
                try validatePostMutationPage(validated, receipt: receipt, command: command)
                guard operationGeneration == generation, !Task.isCancelled else { return false }
                acceptMemberPage(validated, chatID: chatID)
                memberListStates[chatID] = .loaded
            }

            // `acceptConfirmedCommunityRemoval` deliberately purges every
            // chat-scoped cache. Do not recreate a detached mutation entry for
            // a community that is no longer visible to this account.
            if !shouldRemoveCurrentUser {
                mutationStates[key] = .loaded
                mutationFailures[key] = nil
                mutationRetries[key] = nil
            }
            return true
        } catch is CancellationError {
            guard operationGeneration == generation else { return false }
            mutationStates[key] = .idle
            return false
        } catch {
            guard operationGeneration == generation else { return false }
            recordFailure(key: key, command: command, error: error)
            return false
        }
    }

    private func execute(
        _ command: CommunityMemberMutationRetry,
        chatID: UUID
    ) async throws -> CommunityMembershipMutationReceipt {
        switch command {
        case let .add(participant, role, _, nonce):
            guard let remoteMemberAdder else {
                throw CommunityStoreError.unavailable("Добавление участников на сервере не подключено.")
            }
            return try await remoteMemberAdder(chatID, participant.id, role, nonce)
        case let .changeRole(userID, role, previous, nonce):
            guard let remoteMemberRoleUpdater else {
                throw CommunityStoreError.unavailable("Изменение ролей на сервере не подключено.")
            }
            return try await remoteMemberRoleUpdater(chatID, userID, role, previous.revision, nonce)
        case let .remove(userID, previous, nonce):
            guard let remoteMemberRemover else {
                throw CommunityStoreError.unavailable("Удаление участников на сервере не подключено.")
            }
            return try await remoteMemberRemover(chatID, userID, previous.revision, nonce)
        }
    }

    private func validatePermission(
        for command: CommunityMemberMutationRetry,
        chatID: UUID
    ) throws {
        guard memberListState(chatID) == .loaded else { throw CommunityStoreError.missingMemberList }
        switch command {
        case let .add(participant, role, preflightFence, _):
            let currentFence = membershipFences[CommunityMembershipFenceKey(
                chatID: chatID,
                userID: participant.id
            )]
            guard member(chatID: chatID, userID: participant.id) == nil,
                  Self.sameFence(currentFence, preflightFence),
                  preflightFence?.isRemoved != false,
                  canAddMember(role: role, to: chatID)
            else { throw CommunityStoreError.operationNotPermitted }
        case let .changeRole(userID, role, _, _):
            guard canChangeRole(of: userID, to: role, in: chatID) else {
                throw CommunityStoreError.operationNotPermitted
            }
        case let .remove(userID, _, _):
            guard canRemoveMember(userID, from: chatID) else {
                throw CommunityStoreError.operationNotPermitted
            }
        }
    }

    private func validate(
        _ receipt: CommunityMembershipMutationReceipt,
        for command: CommunityMemberMutationRetry,
        chatID: UUID
    ) throws {
        let membership = receipt.membership
        guard membership.chatID == chatID,
              membership.userID == command.userID,
              membership.revision > 0,
              membership.updatedAt >= membership.joinedAt
        else { throw CommunityStoreError.invalidMembershipReceipt }
        switch command {
        case let .add(_, role, preflightFence, _):
            guard membership.role == role else {
                throw CommunityStoreError.invalidMembershipReceipt
            }
            if let fence = preflightFence {
                guard fence.isRemoved,
                      membership.revision > fence.membership.revision,
                      membership.joinedAt > fence.membership.updatedAt
                else { throw CommunityStoreError.invalidMembershipReceipt }
            }
        case let .changeRole(_, role, previous, _):
            guard membership.role == role,
                  membership.revision == previous.revision + 1,
                  membership.joinedAt == previous.joinedAt,
                  membership.updatedAt > previous.updatedAt
            else { throw CommunityStoreError.invalidMembershipReceipt }
        case let .remove(_, previous, _):
            guard membership.role == previous.role,
                  membership.revision == previous.revision + 1,
                  membership.joinedAt == previous.joinedAt,
                  membership.updatedAt > previous.updatedAt
            else { throw CommunityStoreError.invalidMembershipReceipt }
        }
    }

    private func validatePostMutationPage(
        _ page: [CommunityMember],
        receipt: CommunityMembershipMutationReceipt,
        command: CommunityMemberMutationRetry
    ) throws {
        let reflected = page.first { $0.id == command.userID }
        switch command {
        case .add, .changeRole:
            guard let reflected = reflected?.membership,
                  reflected.revision >= receipt.membership.revision,
                  reflected.updatedAt >= receipt.membership.updatedAt
            else {
                throw CommunityStoreError.invalidMemberPage
            }
            if reflected.revision == receipt.membership.revision {
                guard reflected.role == receipt.membership.role,
                      reflected.joinedAt == receipt.membership.joinedAt
                else { throw CommunityStoreError.invalidMemberPage }
            }
        case .remove:
            if let reflected = reflected?.membership {
                guard reflected.joinedAt != receipt.membership.joinedAt,
                      reflected.revision > receipt.membership.revision
                else { throw CommunityStoreError.invalidMemberPage }
            }
        }
    }

    private func validateMemberPage(
        _ page: [CommunityMember],
        chatID: UUID,
        requireKnownCountMatch: Bool = true
    ) throws -> [CommunityMember] {
        guard !page.isEmpty,
              page.count <= 200,
              Set(page.map(\.id)).count == page.count,
              page.filter({ $0.membership.role == .owner }).count == 1,
              page.contains(where: { $0.id == currentUserID }),
              page.allSatisfy({ member in
                  member.membership.chatID == chatID
                      && member.membership.userID == member.participant.id
                      && member.membership.revision > 0
                      && member.membership.updatedAt >= member.membership.joinedAt
              })
        else { throw CommunityStoreError.invalidMemberPage }
        if requireKnownCountMatch,
           let community = community(chatID),
           community.memberCount != page.count {
            throw CommunityStoreError.invalidMemberPage
        }
        for member in page {
            let key = CommunityMembershipFenceKey(chatID: chatID, userID: member.id)
            guard let fence = membershipFences[key] else { continue }
            if member.membership.joinedAt != fence.membership.joinedAt {
                // Backend migration 024 keeps revision monotonic across a
                // physical delete/re-add. That is the lifecycle authority;
                // wall-clock timestamps are never ordered here.
                guard fence.isRemoved,
                      member.membership.revision > fence.membership.revision,
                      member.membership.joinedAt > fence.membership.updatedAt
                else { throw CommunityStoreError.invalidMemberPage }
                continue
            }
            guard !fence.isRemoved else {
                // A tombstoned incarnation cannot become active again with the
                // same joinedAt, regardless of a numerically higher revision.
                throw CommunityStoreError.invalidMemberPage
            }
            guard member.membership.revision >= fence.membership.revision else {
                throw CommunityStoreError.invalidMemberPage
            }
            if member.membership.revision == fence.membership.revision {
                guard !fence.isRemoved, member.membership == fence.membership else {
                    throw CommunityStoreError.invalidMemberPage
                }
            }
        }
        return Self.sortedMembers(page)
    }

    private func acceptMemberPage(_ page: [CommunityMember], chatID: UUID) {
        let incomingIDs = Set(page.map(\.id))
        let previous = membersByCommunity[chatID] ?? []
        for removed in previous where !incomingIDs.contains(removed.id) {
            let key = CommunityMembershipFenceKey(chatID: chatID, userID: removed.id)
            let existing = membershipFences[key]
            if existing == nil || existing!.membership.revision <= removed.membership.revision {
                recordMembershipFence(
                    removed.membership,
                    isRemoved: true,
                    allowSyntheticRemoval: true
                )
            }
        }
        for member in page {
            recordMembershipFence(member.membership, isRemoved: false)
        }
        membersByCommunity[chatID] = page
        if let index = communities.firstIndex(where: { $0.id == chatID }) {
            communities[index].memberCount = page.count
            communities[index].serverRole = page.first(where: { $0.id == currentUserID })?.membership.role.rawValue
            publishCommunityMetadata(communities[index])
        }
    }

    private func publishCommunityMetadata(_ conversation: Conversation) {
        confirmedCommunityMetadataObserver?(
            conversation.id,
            conversation.memberCount,
            conversation.serverRole
        )
    }

    private func isAuthorizedNewLifecycle(
        _ membership: ChatMembership,
        change: CommunityMembershipSignalChange,
        causalSequence: Int?,
        after fence: CommunityMembershipFence
    ) -> Bool {
        guard change == .added,
              fence.isRemoved,
              membership.revision > fence.membership.revision,
              membership.joinedAt > fence.membership.updatedAt
        else { return false }
        if let causalSequence,
           let fenceSequence = fence.causalSequence {
            return causalSequence > fenceSequence
        }
        return true
    }

    @discardableResult
    private func recordMembershipFence(
        _ membership: ChatMembership,
        isRemoved: Bool,
        causalSequence: Int? = nil,
        allowSyntheticRemoval: Bool = false
    ) -> Bool {
        let key = CommunityMembershipFenceKey(chatID: membership.chatID, userID: membership.userID)
        if let existing = membershipFences[key] {
            if membership.revision < existing.membership.revision { return false }
            if membership.revision == existing.membership.revision {
                if existing.membership == membership, existing.isRemoved == isRemoved {
                    if let causalSequence,
                       existing.causalSequence.map({ causalSequence > $0 }) ?? true {
                        membershipFences[key] = CommunityMembershipFence(
                            membership: membership,
                            isRemoved: isRemoved,
                            causalSequence: causalSequence
                        )
                    }
                    return true
                }
                guard allowSyntheticRemoval,
                      !existing.isRemoved,
                      isRemoved,
                      existing.membership == membership
                else { return false }
            } else if membership.joinedAt == existing.membership.joinedAt {
                guard membership.updatedAt >= existing.membership.updatedAt,
                      !(existing.isRemoved && !isRemoved)
                else { return false }
            } else {
                guard existing.isRemoved,
                      !isRemoved,
                      membership.joinedAt > existing.membership.updatedAt
                else { return false }
            }
        }
        let retainedSequence: Int?
        if let causalSequence {
            retainedSequence = causalSequence
        } else if let existing = membershipFences[key],
                  existing.membership.joinedAt == membership.joinedAt {
            retainedSequence = existing.causalSequence
        } else {
            retainedSequence = nil
        }
        let semanticTransition = membershipFences[key].map {
            $0.membership != membership || $0.isRemoved != isRemoved
        } ?? true
        membershipFences[key] = CommunityMembershipFence(
            membership: membership,
            isRemoved: isRemoved,
            causalSequence: retainedSequence
        )
        if semanticTransition {
            membershipEpochs[membership.chatID, default: 0] &+= 1
        }
        return true
    }

    private static func sameFence(
        _ lhs: CommunityMembershipFence?,
        _ rhs: CommunityMembershipFence?
    ) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): true
        case let (lhs?, rhs?):
            lhs.membership == rhs.membership
                && lhs.isRemoved == rhs.isRemoved
        default: false
        }
    }

    private func currentRole(in chatID: UUID) -> ChatMembershipRole? {
        member(chatID: chatID, userID: currentUserID)?.membership.role
            ?? community(chatID)?.serverRole.flatMap(ChatMembershipRole.init(rawValue:))
    }

    private func member(chatID: UUID, userID: UUID) -> CommunityMember? {
        membersByCommunity[chatID]?.first { $0.id == userID }
    }

    private func recordPreflightFailure(
        chatID: UUID,
        userID: UUID,
        kind: CommunityMemberMutationKind,
        error: CommunityStoreError
    ) {
        recordFailure(
            key: CommunityMemberMutationKey(chatID: chatID, userID: userID, kind: kind),
            command: nil,
            error: error
        )
    }

    private func recordFailure(
        key: CommunityMemberMutationKey,
        command: CommunityMemberMutationRetry?,
        error: Error
    ) {
        let detail = Self.russianMessage(for: error)
        mutationStates[key] = .failed(detail)
        mutationFailures[key] = CommunityMemberMutationFailure(key: key, detail: detail)
        mutationRetries[key] = command
    }

    private func upsert(_ conversation: Conversation) {
        if let index = communities.firstIndex(where: { $0.id == conversation.id }) {
            communities[index] = conversation
        } else {
            communities.append(conversation)
        }
        communities = Self.sortedCommunities(communities)
        confirmedCommunityObserver?(conversation)
    }

    private static func validatedCreationInput(
        kind: CommunityKind,
        title rawTitle: String,
        memberIDs: [UUID],
        currentUserID: UUID
    ) throws -> CommunityCreationRetry {
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 120 else { throw CommunityStoreError.invalidTitle }
        guard Set(memberIDs).count == memberIDs.count else { throw CommunityStoreError.duplicateMember }
        let peers = memberIDs.filter { $0 != currentUserID }
        guard peers.count <= 199 else { throw CommunityStoreError.tooManyMembers }
        return CommunityCreationRetry(kind: kind, title: title, memberIDs: peers)
    }

    private static func validateCreatedCommunity(
        _ community: Conversation,
        input: CommunityCreationRetry,
        expectedMemberCount: Int
    ) throws {
        guard validCommunityProjection(community),
              community.kind == input.kind.conversationKind,
              community.title == input.title,
              community.serverRole == ChatMembershipRole.owner.rawValue,
              community.memberCount == expectedMemberCount
        else { throw CommunityStoreError.invalidCommunity }
    }

    private static func validateCommunity(_ community: Conversation, expectedID: UUID) throws {
        guard community.id == expectedID, validCommunityProjection(community) else {
            throw CommunityStoreError.invalidCommunity
        }
    }

    private static func validCommunityProjection(_ conversation: Conversation) -> Bool {
        (conversation.kind == .group || conversation.kind == .channel)
            && !conversation.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && conversation.title.count <= 120
            && (1...200).contains(conversation.memberCount)
            && conversation.serverRole.flatMap(ChatMembershipRole.init(rawValue:)) != nil
    }

    private static func isDefinitiveCreationFailure(_ error: Error) -> Bool {
        guard case let LuxoraAPIError.server(status, _, _) = error else { return false }
        return 400..<500 ~= status
    }

    private static func russianMessage(for error: Error) -> String {
        if let localized = error as? LocalizedError,
           let message = localized.errorDescription,
           !message.isEmpty {
            return message
        }
        return "Нет связи с сервером. Проверьте сеть и повторите."
    }

    private static func normalizedUsername(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
    }

    private static func sortedCommunities(_ communities: [Conversation]) -> [Conversation] {
        communities.sorted { lhs, rhs in
            if lhs.lastActivity != rhs.lastActivity { return lhs.lastActivity > rhs.lastActivity }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }

    private static func sortedMembers(_ members: [CommunityMember]) -> [CommunityMember] {
        members.sorted { lhs, rhs in
            let leftRank = roleRank(lhs.membership.role)
            let rightRank = roleRank(rhs.membership.role)
            if leftRank != rightRank { return leftRank < rightRank }
            let comparison = lhs.participant.displayName.localizedCaseInsensitiveCompare(rhs.participant.displayName)
            if comparison != .orderedSame { return comparison == .orderedAscending }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }

    private static func roleRank(_ role: ChatMembershipRole) -> Int {
        switch role {
        case .owner: 0
        case .admin: 1
        case .member: 2
        }
    }
}

private struct CommunityCreationRetry: Sendable {
    let kind: CommunityKind
    let title: String
    let memberIDs: [UUID]
}

private enum CommunityMemberMutationRetry: Sendable {
    case add(
        participant: Participant,
        role: ChatMembershipRole,
        preflightFence: CommunityMembershipFence?,
        nonce: UUID
    )
    /// Captured before dispatch: realtime may apply the same mutation before
    /// its HTTP response returns, so validation cannot consult mutable UI state.
    case changeRole(userID: UUID, role: ChatMembershipRole, previous: ChatMembership, nonce: UUID)
    case remove(userID: UUID, previous: ChatMembership, nonce: UUID)

    var userID: UUID {
        switch self {
        case let .add(participant, _, _, _): participant.id
        case let .changeRole(userID, _, _, _), let .remove(userID, _, _): userID
        }
    }

    func key(chatID: UUID) -> CommunityMemberMutationKey {
        let kind: CommunityMemberMutationKind
        switch self {
        case .add: kind = .add
        case .changeRole: kind = .changeRole
        case .remove: kind = .remove
        }
        return CommunityMemberMutationKey(chatID: chatID, userID: userID, kind: kind)
    }

    func isSelfRemoval(currentUserID: UUID) -> Bool {
        guard case let .remove(userID, _, _) = self else { return false }
        return userID == currentUserID
    }
}
