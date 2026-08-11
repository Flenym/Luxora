import Foundation
import XCTest
@testable import LuxoraKit

final class CommunityLiveBackendIntegrationTests: XCTestCase {
    func testGroupsChannelsRolesAndPublishingAgainstLiveDocker() async throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_TEST=1 while the local API is running")
        }

        let api = LuxoraAPIClient(configuration: .development)
        let communityAPI = LuxoraCommunityAPIClient(configuration: .development)
        let suffix = UUID().uuidString
            .replacingOccurrences(of: "-", with: "")
            .prefix(10)
            .lowercased()
        let password = "LuxoraCommunities!2026"
        let owner = try await api.register(
            username: "community_owner_\(suffix)",
            displayName: "Владелец сообщества",
            password: password,
            deviceName: "Swift community owner"
        )
        let member = try await api.register(
            username: "community_member_\(suffix)",
            displayName: "Участник сообщества",
            password: password,
            deviceName: "Swift community member"
        )
        defer {
            Task {
                try? await api.revokeCurrentSession(token: owner.tokens.accessToken)
                try? await api.revokeCurrentSession(token: member.tokens.accessToken)
            }
        }

        // The server allows invitations only across an accepted relationship.
        let request = try await api.createMessageRequest(
            recipientUserID: member.user.id,
            body: "Подтверждаем связь для закрытого сообщества",
            clientNonce: .clientNonceV4(),
            token: owner.tokens.accessToken
        )
        _ = try await api.acceptMessageRequest(
            id: request.id,
            token: member.tokens.accessToken
        )

        let group = try await communityAPI.createCommunity(
            kind: .group,
            title: "Live Swift Group",
            memberIDs: [],
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(group.kind, "group")
        XCTAssertEqual(group.role, ChatMembershipRole.owner.rawValue)
        XCTAssertEqual(group.memberCount, 1)
        let confirmedGroup = try await communityAPI.community(
            chatID: group.id,
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(confirmedGroup.id, group.id)

        let addNonce = UUID.clientNonceV4()
        let added = try await communityAPI.addCommunityMember(
            chatID: group.id,
            userID: member.user.id,
            role: .member,
            clientNonce: addNonce,
            token: owner.tokens.accessToken
        )
        XCTAssertFalse(added.replayed)
        XCTAssertEqual(added.membership.revision, 1)
        let replay = try await communityAPI.addCommunityMember(
            chatID: group.id,
            userID: member.user.id,
            role: .member,
            clientNonce: addNonce,
            token: owner.tokens.accessToken
        )
        XCTAssertTrue(replay.replayed)
        XCTAssertEqual(replay.membership, added.membership)

        var groupMembers = try await communityAPI.communityMembers(
            chatID: group.id,
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(Set(groupMembers.map(\.id)), Set([owner.user.id, member.user.id]))
        let promoted = try await communityAPI.updateCommunityMemberRole(
            chatID: group.id,
            userID: member.user.id,
            role: .admin,
            expectedRevision: added.membership.revision,
            clientNonce: .clientNonceV4(),
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(promoted.membership.role, .admin)
        XCTAssertEqual(promoted.membership.revision, 2)

        let removed = try await communityAPI.removeCommunityMember(
            chatID: group.id,
            userID: member.user.id,
            expectedRevision: promoted.membership.revision,
            clientNonce: .clientNonceV4(),
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(removed.membership.revision, 3)
        groupMembers = try await communityAPI.communityMembers(
            chatID: group.id,
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(groupMembers.map(\.id), [owner.user.id])

        let channel = try await communityAPI.createCommunity(
            kind: .channel,
            title: "Live Swift Channel",
            memberIDs: [member.user.id],
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(channel.kind, "channel")
        XCTAssertEqual(channel.memberCount, 2)

        do {
            _ = try await api.sendMessage(
                chatID: channel.id,
                clientNonce: .clientNonceV4(),
                body: "Обычный подписчик не должен публиковать",
                token: member.tokens.accessToken
            )
            XCTFail("The live channel accepted a publication from a member")
        } catch let LuxoraAPIError.server(status, _, _) {
            XCTAssertEqual(status, 403)
        }

        let channelMembers = try await communityAPI.communityMembers(
            chatID: channel.id,
            token: owner.tokens.accessToken
        )
        let channelMembership = try XCTUnwrap(
            channelMembers.first(where: { $0.id == member.user.id })
        )
        let channelAdmin = try await communityAPI.updateCommunityMemberRole(
            chatID: channel.id,
            userID: member.user.id,
            role: .admin,
            expectedRevision: channelMembership.membership.revision,
            clientNonce: .clientNonceV4(),
            token: owner.tokens.accessToken
        )
        let publication = try await api.sendMessage(
            chatID: channel.id,
            clientNonce: .clientNonceV4(),
            body: "Публикация подтверждённого администратора",
            token: member.tokens.accessToken
        )
        XCTAssertEqual(publication.body, "Публикация подтверждённого администратора")
        let channelMessages = try await api.messages(
            chatID: channel.id,
            token: owner.tokens.accessToken
        )
        XCTAssertEqual(channelMessages.map(\.id), [publication.id])

        _ = try await communityAPI.removeCommunityMember(
            chatID: channel.id,
            userID: member.user.id,
            expectedRevision: channelAdmin.membership.revision,
            clientNonce: .clientNonceV4(),
            token: member.tokens.accessToken
        )
        do {
            _ = try await communityAPI.community(
                chatID: channel.id,
                token: member.tokens.accessToken
            )
            XCTFail("A removed subscriber retained access to the live channel")
        } catch let LuxoraAPIError.server(status, _, _) {
            XCTAssertEqual(status, 404)
        }
    }
}
