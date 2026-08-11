#if DEBUG
import Foundation

/// Server-shaped, mutable community data used only by explicit Simulator/UI-test
/// launches. Production sessions always use `LuxoraCommunityAPIClient`.
@MainActor
enum DebugCommunityScenario {
    static func make(messengerStore: MessengerStore) -> CommunityStore {
        let projections = messengerStore.conversations
            .filter { $0.kind == .group || $0.kind == .channel }
            .enumerated()
            .map { offset, source in
                var conversation = source
                switch (conversation.kind, offset) {
                case (.channel, _):
                    conversation.serverRole = ChatMembershipRole.member.rawValue
                case (_, 0):
                    conversation.serverRole = ChatMembershipRole.owner.rawValue
                case (_, 1):
                    conversation.serverRole = ChatMembershipRole.admin.rawValue
                default:
                    conversation.serverRole = ChatMembershipRole.member.rawValue
                }
                return conversation
            }

        let fixture = DebugCommunityBackend(
            currentUser: messengerStore.currentUser,
            communities: projections
        )
        let store = CommunityStore(
            currentUserID: messengerStore.currentUser.id,
            communities: projections
        )
        store.configureRemote(
            creator: { kind, title, memberIDs in
                try await fixture.create(kind: kind, title: title, memberIDs: memberIDs)
            },
            communityLoader: { chatID in
                try await fixture.community(chatID)
            },
            memberLoader: { chatID in
                try await fixture.members(chatID)
            },
            exactUserLookup: { username in
                await fixture.lookup(username)
            },
            memberAdder: { chatID, userID, role, nonce in
                try await fixture.add(chatID: chatID, userID: userID, role: role, nonce: nonce)
            },
            memberRoleUpdater: { chatID, userID, role, revision, nonce in
                try await fixture.updateRole(
                    chatID: chatID,
                    userID: userID,
                    role: role,
                    expectedRevision: revision,
                    nonce: nonce
                )
            },
            memberRemover: { chatID, userID, revision, nonce in
                try await fixture.remove(
                    chatID: chatID,
                    userID: userID,
                    expectedRevision: revision,
                    nonce: nonce
                )
            }
        )
        return store
    }
}

private actor DebugCommunityBackend {
    private let currentUser: Participant
    private var communities: [UUID: Conversation]
    private var membersByChat: [UUID: [CommunityMember]]
    private var directory: [String: Participant]
    private var mutationReceipts: [UUID: CommunityMembershipMutationReceipt] = [:]
    private var nextCommunityIndex: Int
    private let now: Date

    init(currentUser: Participant, communities: [Conversation]) {
        let fixtureNow = Date(timeIntervalSince1970: 1_785_834_060)
        self.currentUser = currentUser
        self.communities = Dictionary(uniqueKeysWithValues: communities.map { ($0.id, $0) })
        nextCommunityIndex = communities.count + 1
        now = fixtureNow

        var pages: [UUID: [CommunityMember]] = [:]
        var users: [String: Participant] = [currentUser.username.lowercased(): currentUser]
        for (communityIndex, community) in communities.enumerated() {
            let page = Self.makeMembers(
                currentUser: currentUser,
                conversation: community,
                communityIndex: communityIndex,
                now: fixtureNow
            )
            pages[community.id] = page
            for member in page {
                users[member.participant.username.lowercased()] = member.participant
            }
        }
        for participant in Self.candidateDirectory {
            users[participant.username.lowercased()] = participant
        }
        membersByChat = pages
        directory = users
    }

    func create(
        kind: CommunityKind,
        title: String,
        memberIDs: [UUID]
    ) throws -> Conversation {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.count <= 120,
              memberIDs.count <= 199,
              Set(memberIDs).count == memberIDs.count
        else { throw failure(status: 400, code: "VALIDATION_ERROR", message: "Некорректные данные сообщества") }

        let candidates = Dictionary(uniqueKeysWithValues: directory.values.map { ($0.id, $0) })
        guard memberIDs.allSatisfy({ candidates[$0] != nil }) else {
            throw failure(status: 404, code: "USER_NOT_FOUND", message: "Пользователь не найден")
        }

        let chatID = UUID()
        let avatar = Participant(
            id: chatID,
            displayName: normalized,
            username: "community-\(nextCommunityIndex)",
            initials: Self.initials(for: normalized),
            accentHex: Self.accentHex(for: chatID),
            isOnline: false,
            status: kind == .channel ? "Канал" : "Группа"
        )
        let conversation = Conversation(
            id: chatID,
            title: normalized,
            subtitle: "Нет сообщений",
            kind: kind.conversationKind,
            avatar: avatar,
            memberCount: memberIDs.count + 1,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: now.addingTimeInterval(Double(nextCommunityIndex)),
            folder: "work",
            serverRole: ChatMembershipRole.owner.rawValue
        )
        nextCommunityIndex += 1
        var page = [member(currentUser, chatID: chatID, role: .owner, revision: 1)]
        page.append(contentsOf: memberIDs.compactMap { id in
            candidates[id].map { member($0, chatID: chatID, role: .member, revision: 1) }
        })
        communities[chatID] = conversation
        membersByChat[chatID] = page
        return conversation
    }

    func community(_ chatID: UUID) throws -> Conversation {
        guard let community = communities[chatID] else {
            throw failure(status: 404, code: "CHAT_NOT_FOUND", message: "Чат не найден")
        }
        return community
    }

    func members(_ chatID: UUID) throws -> [CommunityMember] {
        guard let members = membersByChat[chatID] else {
            throw failure(status: 404, code: "CHAT_NOT_FOUND", message: "Чат не найден")
        }
        return members
    }

    func lookup(_ username: String) -> Participant? {
        directory[username.lowercased()]
    }

    func add(
        chatID: UUID,
        userID: UUID,
        role: ChatMembershipRole,
        nonce: UUID
    ) throws -> CommunityMembershipMutationReceipt {
        if let replay = mutationReceipts[nonce] {
            return CommunityMembershipMutationReceipt(membership: replay.membership, replayed: true)
        }
        guard role != .owner,
              var page = membersByChat[chatID],
              var community = communities[chatID],
              let participant = directory.values.first(where: { $0.id == userID }),
              !page.contains(where: { $0.id == userID }),
              page.count < 200
        else { throw failure(status: 409, code: "MEMBERSHIP_CONFLICT", message: "Участника нельзя добавить") }

        let membership = ChatMembership(
            chatID: chatID,
            userID: userID,
            role: role,
            revision: 1,
            joinedAt: now,
            updatedAt: now
        )
        page.append(CommunityMember(membership: membership, participant: participant))
        community.memberCount = page.count
        membersByChat[chatID] = page
        communities[chatID] = community
        let receipt = CommunityMembershipMutationReceipt(membership: membership, replayed: false)
        mutationReceipts[nonce] = receipt
        return receipt
    }

    func updateRole(
        chatID: UUID,
        userID: UUID,
        role: ChatMembershipRole,
        expectedRevision: Int,
        nonce: UUID
    ) throws -> CommunityMembershipMutationReceipt {
        if let replay = mutationReceipts[nonce] {
            return CommunityMembershipMutationReceipt(membership: replay.membership, replayed: true)
        }
        guard role != .owner,
              var page = membersByChat[chatID],
              let index = page.firstIndex(where: { $0.id == userID }),
              page[index].membership.role != .owner,
              page[index].membership.revision == expectedRevision
        else { throw failure(status: 409, code: "MEMBERSHIP_REVISION_CONFLICT", message: "Состав чата уже изменился") }

        page[index].membership.role = role
        page[index].membership.revision += 1
        page[index].membership.updatedAt = now.addingTimeInterval(Double(page[index].membership.revision))
        membersByChat[chatID] = page
        let receipt = CommunityMembershipMutationReceipt(
            membership: page[index].membership,
            replayed: false
        )
        mutationReceipts[nonce] = receipt
        return receipt
    }

    func remove(
        chatID: UUID,
        userID: UUID,
        expectedRevision: Int,
        nonce: UUID
    ) throws -> CommunityMembershipMutationReceipt {
        if let replay = mutationReceipts[nonce] {
            return CommunityMembershipMutationReceipt(membership: replay.membership, replayed: true)
        }
        guard var page = membersByChat[chatID],
              let index = page.firstIndex(where: { $0.id == userID }),
              page[index].membership.role != .owner,
              page[index].membership.revision == expectedRevision
        else { throw failure(status: 409, code: "MEMBERSHIP_REVISION_CONFLICT", message: "Состав чата уже изменился") }

        var removed = page.remove(at: index).membership
        removed.revision += 1
        removed.updatedAt = now.addingTimeInterval(Double(removed.revision))
        let receipt = CommunityMembershipMutationReceipt(membership: removed, replayed: false)
        mutationReceipts[nonce] = receipt

        if userID == currentUser.id {
            communities[chatID] = nil
            membersByChat[chatID] = nil
        } else {
            membersByChat[chatID] = page
            communities[chatID]?.memberCount = page.count
        }
        return receipt
    }

    private func member(
        _ participant: Participant,
        chatID: UUID,
        role: ChatMembershipRole,
        revision: Int
    ) -> CommunityMember {
        CommunityMember(
            membership: ChatMembership(
                chatID: chatID,
                userID: participant.id,
                role: role,
                revision: revision,
                joinedAt: now.addingTimeInterval(-86_400),
                updatedAt: now.addingTimeInterval(-86_400)
            ),
            participant: participant
        )
    }

    private func failure(status: Int, code: String, message: String) -> LuxoraAPIError {
        .server(status: status, code: code, message: message)
    }

    private static func makeMembers(
        currentUser: Participant,
        conversation: Conversation,
        communityIndex: Int,
        now: Date
    ) -> [CommunityMember] {
        let currentRole = conversation.serverRole.flatMap(ChatMembershipRole.init(rawValue:)) ?? .member
        var participants: [(Participant, ChatMembershipRole)] = []
        if currentRole == .owner {
            participants.append((currentUser, .owner))
        } else {
            let owner = generatedParticipant(index: communityIndex * 200, online: true)
            participants.append((owner, .owner))
            participants.append((currentUser, currentRole))
        }

        var offset = 1
        while participants.count < conversation.memberCount {
            let participant = generatedParticipant(
                index: communityIndex * 200 + offset,
                online: offset.isMultiple(of: 4)
            )
            offset += 1
            guard participant.id != currentUser.id,
                  !participants.contains(where: { $0.0.id == participant.id })
            else { continue }
            let role: ChatMembershipRole = participants.count == 1 && currentRole == .owner
                ? .admin
                : .member
            participants.append((participant, role))
        }

        return participants.prefix(conversation.memberCount).map { participant, role in
            CommunityMember(
                membership: ChatMembership(
                    chatID: conversation.id,
                    userID: participant.id,
                    role: role,
                    revision: 1,
                    joinedAt: now.addingTimeInterval(-86_400),
                    updatedAt: now.addingTimeInterval(-86_400)
                ),
                participant: participant
            )
        }
    }

    private static func generatedParticipant(index: Int, online: Bool) -> Participant {
        let suffix = String(format: "%012x", index + 1)
        let id = UUID(uuidString: "10000000-0000-4000-8000-\(suffix)")!
        let firstNames = ["Арина", "Денис", "Лида", "Артём", "Мария", "Ярослав", "Дарья", "Лев"]
        let surnames = ["Волкова", "Орлов", "Рей", "Светлов", "Миронова", "Лебедев"]
        let displayName = "\(firstNames[index % firstNames.count]) \(surnames[index % surnames.count])"
        return Participant(
            id: id,
            displayName: displayName,
            username: "luxora-user-\(index + 1)",
            initials: initials(for: displayName),
            accentHex: accentHex(for: id),
            isOnline: online,
            status: online ? "в сети" : "был(а) недавно"
        )
    }

    private static let candidateDirectory: [Participant] = [
        Participant(
            id: UUID(uuidString: "20000000-0000-4000-8000-000000000001")!,
            displayName: "Мария Соколова",
            username: "maria",
            initials: "МС",
            accentHex: "7C48D4",
            isOnline: true,
            status: "в сети"
        ),
        Participant(
            id: UUID(uuidString: "20000000-0000-4000-8000-000000000002")!,
            displayName: "Никита Ветров",
            username: "nikita",
            initials: "НВ",
            accentHex: "496CE7",
            isOnline: false,
            status: "был 5 минут назад"
        ),
    ]

    private static func initials(for value: String) -> String {
        let words = value.split(whereSeparator: { $0.isWhitespace })
        let letters = words.prefix(2).compactMap(\.first)
        if !letters.isEmpty {
            return letters.map { String($0) }.joined().uppercased()
        }
        return String(value.prefix(1)).uppercased()
    }

    private static func accentHex(for id: UUID) -> String {
        let palette = ["7C48D4", "496CE7", "2F9D8F", "D27845", "B6538C", "5B70B4"]
        let checksum = id.uuidString.unicodeScalars.reduce(0) { partial, scalar in
            (partial + Int(scalar.value)) % palette.count
        }
        return palette[checksum]
    }
}
#endif
