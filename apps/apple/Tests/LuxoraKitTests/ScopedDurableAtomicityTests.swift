import Foundation
@testable import LuxoraKit
import LuxoraDesignFixtures
import XCTest

@MainActor
final class ScopedDurableAtomicityTests: XCTestCase {
    func testMalformedCommunityChatLeavesMessengerAndCommunityUnchanged() {
        let harness = makeHarness(memberCount: 2)
        let beforeMessenger = harness.messenger.conversations
        let beforeCommunities = harness.community.communities
        let now = Date(timeIntervalSince1970: 1_786_435_200)
        let invalidChat = APIChat(
            id: UUID(),
            kind: "group",
            title: "Некорректная роль",
            avatarUrl: nil,
            role: "not_a_server_role",
            memberCount: 2,
            lastMessage: nil,
            lastActivityAt: now,
            createdAt: now,
            unreadCount: 5,
            archivedAt: nil,
            mutedUntil: nil
        )

        XCTAssertThrowsError(try harness.session.applyScopedDurable(
            .chat(invalidChat, sequence: 20),
            expectedSequence: 20,
            userID: harness.userID,
            store: harness.messenger,
            communityStore: harness.community
        ))
        XCTAssertEqual(harness.messenger.conversations, beforeMessenger)
        XCTAssertEqual(harness.community.communities, beforeCommunities)
    }

    func testMalformedMembershipRoleLeavesBothStoresUnchanged() {
        let harness = makeHarness(memberCount: 2)
        let beforeMessenger = harness.messenger.conversations
        let beforeCommunities = harness.community.communities
        let event = membershipEvent(
            harness: harness,
            role: "invalid_role",
            change: .roleUpdated,
            userID: harness.userID
        )

        XCTAssertThrowsError(try harness.session.applyScopedDurable(
            .chatMembership(event, sequence: 21),
            expectedSequence: 21,
            userID: harness.userID,
            store: harness.messenger,
            communityStore: harness.community
        ))
        XCTAssertEqual(harness.messenger.conversations, beforeMessenger)
        XCTAssertEqual(harness.community.communities, beforeCommunities)
    }

    func testMembershipCountOverflowPreflightLeavesBothStoresUnchanged() {
        let harness = makeHarness(memberCount: 200)
        let beforeMessenger = harness.messenger.conversations
        let beforeCommunities = harness.community.communities
        let event = membershipEvent(
            harness: harness,
            role: ChatMembershipRole.member.rawValue,
            change: .added,
            userID: UUID()
        )

        XCTAssertThrowsError(try harness.session.applyScopedDurable(
            .chatMembership(event, sequence: 22),
            expectedSequence: 22,
            userID: harness.userID,
            store: harness.messenger,
            communityStore: harness.community
        ))
        XCTAssertEqual(harness.messenger.conversations, beforeMessenger)
        XCTAssertEqual(harness.community.communities, beforeCommunities)
    }

    func testValidMembershipAddCommitsExactlyOnceWithObserverInstalled() throws {
        let harness = makeHarness(memberCount: 7)
        let event = membershipEvent(
            harness: harness,
            role: ChatMembershipRole.member.rawValue,
            change: .added,
            userID: UUID()
        )

        XCTAssertFalse(try harness.session.applyScopedDurable(
            .chatMembership(event, sequence: 23),
            expectedSequence: 23,
            userID: harness.userID,
            store: harness.messenger,
            communityStore: harness.community
        ))
        XCTAssertEqual(harness.messenger.conversations.first?.memberCount, 8)
        XCTAssertEqual(harness.community.communities.first?.memberCount, 8)
    }

    private func makeHarness(memberCount: Int) -> DurableAtomicityHarness {
        let fixture = LuxoraDesignFixtures.makeStore()
        let user = fixture.currentUser
        let groupID = UUID()
        let group = Conversation(
            id: groupID,
            title: "Команда",
            subtitle: "Серверная группа",
            kind: .group,
            avatar: Participant(
                id: groupID,
                displayName: "Команда",
                username: "team",
                initials: "К",
                accentHex: "5856D6",
                isOnline: false,
                status: "Группа"
            ),
            memberCount: memberCount,
            unreadCount: 0,
            isMuted: false,
            isPinned: false,
            isTyping: false,
            isArchived: false,
            lastActivity: Date(timeIntervalSince1970: 1_786_435_200),
            folder: "work",
            serverRole: ChatMembershipRole.owner.rawValue
        )
        let messenger = MessengerStore(
            conversations: [group],
            messagesByConversation: [:],
            currentUser: user
        )
        let community = CommunityStore(currentUserID: user.id, communities: [group])
        community.configureProjectionObservers(
            communityUpdated: { messenger.applyConfirmedCommunityIdentity($0) },
            communityRemoved: { messenger.applyConfirmedConversationRemoval($0) },
            communityMetadataUpdated: {
                messenger.applyConfirmedCommunityMetadata(
                    chatID: $0,
                    memberCount: $1,
                    serverRole: $2
                )
            }
        )
        return DurableAtomicityHarness(
            session: ApplicationSession(),
            messenger: messenger,
            community: community,
            userID: user.id,
            chatID: groupID
        )
    }

    private func membershipEvent(
        harness: DurableAtomicityHarness,
        role: String,
        change: RealtimeChatMembershipEvent.Change,
        userID: UUID
    ) -> RealtimeChatMembershipEvent {
        let now = Date(timeIntervalSince1970: 1_786_435_200)
        return RealtimeChatMembershipEvent(
            audience: .memberAccount,
            change: change,
            membership: APIChatMembership(
                chatId: harness.chatID,
                userId: userID,
                role: role,
                revision: 1,
                joinedAt: now,
                updatedAt: now
            ),
            actorUserID: harness.userID,
            changedAt: now
        )
    }
}

@MainActor
private struct DurableAtomicityHarness {
    let session: ApplicationSession
    let messenger: MessengerStore
    let community: CommunityStore
    let userID: UUID
    let chatID: UUID
}
