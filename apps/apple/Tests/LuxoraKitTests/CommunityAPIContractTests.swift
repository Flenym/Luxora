import Foundation
@testable import LuxoraKit
import XCTest

final class CommunityAPIContractTests: XCTestCase {
    private let chatID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let ownerID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let memberID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    private let nonce = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!

    override func tearDown() {
        CommunityContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testCreateUsesExactGroupChannelContractAndBearerAuthentication() async throws {
        let client = makeClient { [chatID, memberID] request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/chats")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try request.communityJSONBody()
            XCTAssertEqual(Set(body.keys), ["kind", "title", "memberIds"])
            XCTAssertEqual(body["kind"] as? String, "channel")
            XCTAssertEqual(body["title"] as? String, "Новости Luxora")
            XCTAssertEqual(body["memberIds"] as? [String], [memberID.apiPathComponent])
            return (201, communityJSON(["chat": chatJSON(
                id: chatID,
                kind: "channel",
                title: "Новости Luxora",
                role: "owner",
                memberCount: 2
            )]))
        }

        let chat = try await client.createCommunity(
            kind: .channel,
            title: "  Новости Luxora  ",
            memberIDs: [memberID],
            token: "access-token"
        )

        XCTAssertEqual(chat.id, chatID)
        XCTAssertEqual(chat.kind, "channel")
        XCTAssertEqual(chat.role, "owner")
        XCTAssertEqual(chat.memberCount, 2)
    }

    func testGetAndMemberListDecodeStrictIdentityProjection() async throws {
        let calls = CommunityLockedCounter()
        let client = makeClient { [chatID, ownerID, memberID] request in
            if calls.increment() == 1 {
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)")
                XCTAssertNil(request.httpBody)
                return (200, communityJSON(["chat": chatJSON(
                    id: chatID,
                    kind: "group",
                    title: "Команда Luxora",
                    role: "admin",
                    memberCount: 2
                )]))
            }
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/members")
            return (200, communityJSON(["items": [
                memberJSON(chatID: chatID, userID: ownerID, role: "owner", revision: 1, username: "flenym"),
                memberJSON(chatID: chatID, userID: memberID, role: "member", revision: 3, username: "maria"),
            ]]))
        }

        let chat = try await client.community(chatID: chatID, token: "access-token")
        let members = try await client.communityMembers(chatID: chatID, token: "access-token")

        XCTAssertEqual(chat.id, chatID)
        XCTAssertEqual(chat.role, "admin")
        XCTAssertEqual(members.map(\.id), [ownerID, memberID])
        XCTAssertEqual(members.last?.membership.revision, 3)
        XCTAssertEqual(members.last?.participant.username, "maria")
    }

    func testMembershipMutationsUseExactBodiesPathsAndStableCallerNonce() async throws {
        let calls = CommunityLockedCounter()
        let client = makeClient { [chatID, memberID, nonce] request in
            let body = try request.communityJSONBody()
            switch calls.increment() {
            case 1:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/members")
                XCTAssertEqual(Set(body.keys), ["userId", "role", "clientNonce"])
                XCTAssertEqual(body["userId"] as? String, memberID.apiPathComponent)
                XCTAssertEqual(body["role"] as? String, "member")
                XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
                return (201, communityJSON(mutationJSON(
                    chatID: chatID,
                    userID: memberID,
                    role: "member",
                    revision: 1,
                    replayed: false
                )))
            case 2:
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/members/\(memberID.apiPathComponent)")
                XCTAssertEqual(Set(body.keys), ["role", "expectedRevision", "clientNonce"])
                XCTAssertEqual(body["role"] as? String, "admin")
                XCTAssertEqual((body["expectedRevision"] as? NSNumber)?.intValue, 1)
                XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
                return (200, communityJSON(mutationJSON(
                    chatID: chatID,
                    userID: memberID,
                    role: "admin",
                    revision: 2,
                    replayed: false,
                    updatedAt: "2026-08-11T10:01:00Z"
                )))
            default:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/members/\(memberID.apiPathComponent)")
                XCTAssertEqual(Set(body.keys), ["expectedRevision", "clientNonce"])
                XCTAssertEqual((body["expectedRevision"] as? NSNumber)?.intValue, 2)
                XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
                return (200, communityJSON(mutationJSON(
                    chatID: chatID,
                    userID: memberID,
                    role: "admin",
                    revision: 3,
                    replayed: true,
                    updatedAt: "2026-08-11T10:02:00Z"
                )))
            }
        }

        let added = try await client.addCommunityMember(
            chatID: chatID,
            userID: memberID,
            role: .member,
            clientNonce: nonce,
            token: "access-token"
        )
        let updated = try await client.updateCommunityMemberRole(
            chatID: chatID,
            userID: memberID,
            role: .admin,
            expectedRevision: 1,
            clientNonce: nonce,
            token: "access-token"
        )
        let removed = try await client.removeCommunityMember(
            chatID: chatID,
            userID: memberID,
            expectedRevision: 2,
            clientNonce: nonce,
            token: "access-token"
        )

        XCTAssertEqual(added.membership.revision, 1)
        XCTAssertEqual(updated.membership.role, .admin)
        XCTAssertEqual(removed.membership.revision, 3)
        XCTAssertTrue(removed.replayed)
        XCTAssertEqual(calls.current, 3)
    }

    func testMemberListRejectsMismatchedMembershipAndProfileIdentity() async throws {        let client = makeClient { [chatID, ownerID, memberID] _ in
            (200, communityJSON(["items": [
                memberJSON(
                    chatID: chatID,
                    userID: ownerID,
                    role: "owner",
                    revision: 1,
                    username: "flenym",
                    profileID: memberID
                ),
            ]]))
        }

        do {
            _ = try await client.communityMembers(chatID: chatID, token: "access-token")
            XCTFail("A profile belonging to another account must be rejected")
        } catch LuxoraAPIError.invalidResponse {
            // Expected: never expose an attacker-controlled mismatched identity.
        }
    }

    func testInviteLinksUseExactContractAndRejectForeignChatProjection() async throws {
        let calls = CommunityLockedCounter()
        let linkID = UUID(uuidString: "55555555-5555-4555-8555-555555555555")!
        let inviteToken = String(repeating: "B", count: 43)
        let client = makeClient { [chatID, ownerID, memberID, nonce] request in
            let body = try request.communityJSONBody()
            switch calls.increment() {
            case 1:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/invite-links")
                XCTAssertEqual(Set(body.keys), ["maxUses", "clientNonce"])
                XCTAssertEqual((body["maxUses"] as? NSNumber)?.intValue, 5)
                XCTAssertEqual(body["clientNonce"] as? String, nonce.apiPathComponent)
                return (201, communityJSON([
                    "invite": inviteJSON(
                        id: linkID,
                        chatID: chatID,
                        createdBy: ownerID,
                        maxUses: 5,
                        useCount: 0
                    ),
                    "token": inviteToken,
                    "replayed": false,
                ]))
            case 2:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/invite-links")
                return (200, communityJSON(["items": [
                    inviteJSON(
                        id: linkID,
                        chatID: chatID,
                        createdBy: ownerID,
                        maxUses: 5,
                        useCount: 1
                    ),
                ]]))
            case 3:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/v1/invite-links/join")
                XCTAssertEqual(Set(body.keys), ["token", "clientNonce"])
                XCTAssertEqual(body["token"] as? String, inviteToken)
                return (201, communityJSON(mutationJSON(
                    chatID: chatID,
                    userID: memberID,
                    role: "member",
                    revision: 1,
                    replayed: false
                )))
            default:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/v1/chats/\(chatID.apiPathComponent)/invite-links/\(linkID.apiPathComponent)")
                return (200, communityJSON([
                    "invite": inviteJSON(
                        id: linkID,
                        chatID: chatID,
                        createdBy: ownerID,
                        revokedAt: "2026-09-13T12:05:00Z"
                    ),
                    "replayed": false,
                ]))
            }
        }

        let created = try await client.createInviteLink(
            chatID: chatID,
            expiresInSeconds: nil,
            maxUses: 5,
            clientNonce: nonce,
            token: "access-token"
        )
        XCTAssertEqual(created.invite.id, linkID)
        XCTAssertEqual(created.token, inviteToken)
        XCTAssertFalse(created.replayed)
        XCTAssertFalse(created.invite.isExhausted)

        let listed = try await client.inviteLinks(chatID: chatID, token: "access-token")
        XCTAssertEqual(listed.map(\.id), [linkID])
        XCTAssertEqual(listed.first?.useCount, 1)

        let joined = try await client.joinByInvite(
            token: inviteToken,
            clientNonce: nonce,
            token: "access-token"
        )
        XCTAssertEqual(joined.membership.userID, memberID)
        XCTAssertFalse(joined.replayed)

        let revoked = try await client.revokeInviteLink(
            chatID: chatID,
            linkID: linkID,
            token: "access-token"
        )
        XCTAssertTrue(revoked.invite.isRevoked)
        XCTAssertFalse(revoked.replayed)
        XCTAssertEqual(calls.current, 4)
    }

    func testInviteLinkRejectsMalformedTokenBeforeNetwork() async throws {
        let client = makeClient { _ in
            XCTFail("Malformed invite token must be rejected before URLSession receives a request")
            return (400, communityJSON([:]))
        }
        do {
            _ = try await client.joinByInvite(
                token: "too-short",
                clientNonce: nonce,
                token: "access-token"
            )
            XCTFail("Malformed invite token must be rejected")
        } catch LuxoraAPIError.invalidResponse {
            // Expected before URLSession receives a request.
        }
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> LuxoraCommunityAPIClient {
        CommunityContractURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommunityContractURLProtocol.self]
        return LuxoraCommunityAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://community.contract.invalid")!,
                realtimeURL: URL(string: "wss://community.contract.invalid/v1/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
    }
}

private final class CommunityContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw CommunityContractError.missingHandler }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private enum CommunityContractError: Error { case missingHandler }

private final class CommunityLockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private extension URLRequest {
    func communityJSONBody() throws -> [String: Any] {
        let data: Data
        if let httpBody {
            data = httpBody
        } else if let stream = httpBodyStream {
            stream.open()
            defer { stream.close() }
            var result = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count < 0 { throw stream.streamError ?? CommunityContractError.missingHandler }
                if count == 0 { break }
                result.append(buffer, count: count)
            }
            data = result
        } else {
            data = Data()
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private func communityJSON(_ object: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

private func chatJSON(
    id: UUID,
    kind: String,
    title: String,
    role: String,
    memberCount: Int
) -> [String: Any] {
    [
        "id": id.apiPathComponent,
        "kind": kind,
        "title": title,
        "avatarUrl": NSNull(),
        "role": role,
        "memberCount": memberCount,
        "lastMessage": NSNull(),
        "lastActivityAt": "2026-08-11T10:00:00Z",
        "createdAt": "2026-08-11T09:00:00Z",
        "unreadCount": 0,
    ]
}

private func memberJSON(
    chatID: UUID,
    userID: UUID,
    role: String,
    revision: Int,
    username: String,
    profileID: UUID? = nil
) -> [String: Any] {
    [
        "membership": membershipJSON(
            chatID: chatID,
            userID: userID,
            role: role,
            revision: revision
        ),
        "user": [
            "id": (profileID ?? userID).apiPathComponent,
            "username": username,
            "displayName": username.capitalized,
            "bio": "",
            "avatarUrl": NSNull(),
            "avatarPath": NSNull(),
            "createdAt": "2026-08-01T09:00:00Z",
            "presence": "offline",
            "lastSeenAt": NSNull(),
        ],
    ]
}

private func membershipJSON(
    chatID: UUID,
    userID: UUID,
    role: String,
    revision: Int,
    updatedAt: String = "2026-08-11T10:00:00Z"
) -> [String: Any] {
    [
        "chatId": chatID.apiPathComponent,
        "userId": userID.apiPathComponent,
        "role": role,
        "revision": revision,
        "joinedAt": "2026-08-11T09:00:00Z",
        "updatedAt": updatedAt,
    ]
}

private func mutationJSON(
    chatID: UUID,
    userID: UUID,
    role: String,
    revision: Int,
    replayed: Bool,
    updatedAt: String = "2026-08-11T10:00:00Z"
) -> [String: Any] {
    [
        "membership": membershipJSON(
            chatID: chatID,
            userID: userID,
            role: role,
            revision: revision,
            updatedAt: updatedAt
        ),
        "replayed": replayed,
    ]
}

private func inviteJSON(
    id: UUID,
    chatID: UUID,
    createdBy: UUID,
    maxUses: Int? = nil,
    useCount: Int = 0,
    revokedAt: String? = nil
) -> [String: Any] {
    [
        "id": id.apiPathComponent,
        "chatId": chatID.apiPathComponent,
        "createdBy": createdBy.apiPathComponent,
        "expiresAt": NSNull(),
        "maxUses": maxUses.map { $0 as Any } ?? NSNull(),
        "useCount": useCount,
        "revokedAt": revokedAt.map { $0 as Any } ?? NSNull(),
        "createdAt": "2026-09-13T12:00:00Z",
    ]
}
