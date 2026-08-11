import Foundation

/// A deliberately narrow transport for the already-shipped group/channel
/// membership HTTP surface. It remains independent until the application
/// session and production UI are wired, which keeps partial UI from claiming
/// a capability merely because the server route exists.
actor LuxoraCommunityAPIClient {
    private let configuration: LuxoraClientConfiguration
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(configuration: LuxoraClientConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
    }

    func createCommunity(
        kind: CommunityKind,
        title: String,
        memberIDs: [UUID],
        token: String
    ) async throws -> APIChat {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty,
              normalizedTitle.count <= 120,
              memberIDs.count <= 199,
              Set(memberIDs).count == memberIDs.count
        else { throw LuxoraAPIError.invalidResponse }
        let response: APICommunityChatResponse = try await request(
            path: "/v1/chats",
            method: "POST",
            body: APICommunityCreateBody(
                kind: kind,
                title: normalizedTitle,
                memberIds: memberIDs.map(\.apiPathComponent)
            ),
            token: token
        )
        return response.chat
    }

    func community(chatID: UUID, token: String) async throws -> APIChat {
        let response: APICommunityChatResponse = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)",
            token: token
        )
        return response.chat
    }

    func communityMembers(chatID: UUID, token: String) async throws -> [CommunityMember] {
        let response: APICommunityMemberListResponse = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)/members",
            token: token
        )
        guard response.items.count <= 200 else { throw LuxoraAPIError.invalidResponse }
        return try response.items.map { try $0.member(expectedChatID: chatID) }
    }

    func addCommunityMember(
        chatID: UUID,
        userID: UUID,
        role: ChatMembershipRole,
        clientNonce: UUID,
        token: String
    ) async throws -> CommunityMembershipMutationReceipt {
        guard role != .owner else { throw LuxoraAPIError.invalidResponse }
        let response: APICommunityMembershipMutationResponse = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)/members",
            method: "POST",
            body: APICommunityAddMemberBody(
                userId: userID.apiPathComponent,
                role: role,
                clientNonce: clientNonce.apiPathComponent
            ),
            token: token
        )
        return try response.receipt(expectedChatID: chatID, expectedUserID: userID)
    }

    func updateCommunityMemberRole(
        chatID: UUID,
        userID: UUID,
        role: ChatMembershipRole,
        expectedRevision: Int,
        clientNonce: UUID,
        token: String
    ) async throws -> CommunityMembershipMutationReceipt {
        guard role != .owner, expectedRevision > 0 else {
            throw LuxoraAPIError.invalidResponse
        }
        let response: APICommunityMembershipMutationResponse = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)/members/\(userID.apiPathComponent)",
            method: "PATCH",
            body: APICommunityUpdateMemberBody(
                role: role,
                expectedRevision: expectedRevision,
                clientNonce: clientNonce.apiPathComponent
            ),
            token: token
        )
        return try response.receipt(expectedChatID: chatID, expectedUserID: userID)
    }

    func removeCommunityMember(
        chatID: UUID,
        userID: UUID,
        expectedRevision: Int,
        clientNonce: UUID,
        token: String
    ) async throws -> CommunityMembershipMutationReceipt {
        guard expectedRevision > 0 else { throw LuxoraAPIError.invalidResponse }
        let response: APICommunityMembershipMutationResponse = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)/members/\(userID.apiPathComponent)",
            method: "DELETE",
            body: APICommunityRemoveMemberBody(
                expectedRevision: expectedRevision,
                clientNonce: clientNonce.apiPathComponent
            ),
            token: token
        )
        return try response.receipt(expectedChatID: chatID, expectedUserID: userID)
    }

    private func request<Response: Decodable & Sendable>(
        path: String,
        method: String = "GET",
        token: String
    ) async throws -> Response {
        try await performRequest(path: path, method: method, body: nil, token: token)
    }

    private func request<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        path: String,
        method: String,
        body: Body,
        token: String
    ) async throws -> Response {
        let encodedBody = try encoder.encode(body)
        return try await performRequest(
            path: path,
            method: method,
            body: encodedBody,
            token: token
        )
    }

    private func performRequest<Response: Decodable & Sendable>(
        path: String,
        method: String,
        body: Data?,
        token: String
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL) else {
            throw LuxoraAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse,
              Self.sameOrigin(http.url, configuration.apiBaseURL)
        else {
            throw LuxoraAPIError.invalidResponse
        }
        guard 200..<300 ~= http.statusCode else {
            let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data)
            throw LuxoraAPIError.server(
                status: http.statusCode,
                code: envelope?.error.code ?? "HTTP_\(http.statusCode)",
                message: envelope?.error.message ?? LuxoraL10n.text("error.server_request_failed")
            )
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
    }

    private static func transportError(_ error: Error) -> Error {
        let cocoaError = error as NSError
        if error is CancellationError
            || (cocoaError.domain == NSURLErrorDomain && cocoaError.code == NSURLErrorCancelled)
        {
            return CancellationError()
        }
        return LuxoraAPIError.transport(error.localizedDescription)
    }

    private static func sameOrigin(_ candidate: URL?, _ configuredBase: URL) -> Bool {
        guard let candidate else { return false }
        return candidate.scheme?.lowercased() == configuredBase.scheme?.lowercased()
            && candidate.host?.lowercased() == configuredBase.host?.lowercased()
            && candidate.port == configuredBase.port
    }
}

private struct APICommunityCreateBody: Encodable, Sendable {
    let kind: CommunityKind
    let title: String
    let memberIds: [String]
}

private struct APICommunityAddMemberBody: Encodable, Sendable {
    let userId: String
    let role: ChatMembershipRole
    let clientNonce: String
}

private struct APICommunityUpdateMemberBody: Encodable, Sendable {
    let role: ChatMembershipRole
    let expectedRevision: Int
    let clientNonce: String
}

private struct APICommunityRemoveMemberBody: Encodable, Sendable {
    let expectedRevision: Int
    let clientNonce: String
}

private struct APICommunityChatResponse: Decodable, Sendable {
    let chat: APIChat
}

private struct APICommunityMemberListResponse: Decodable, Sendable {
    let items: [APICommunityMember]
}

private struct APICommunityMembershipMutationResponse: Decodable, Sendable {
    let membership: APICommunityMembership
    let replayed: Bool

    func receipt(
        expectedChatID: UUID,
        expectedUserID: UUID
    ) throws -> CommunityMembershipMutationReceipt {
        let membership = try membership.membership()
        guard membership.chatID == expectedChatID,
              membership.userID == expectedUserID
        else {
            throw LuxoraAPIError.invalidResponse
        }
        return CommunityMembershipMutationReceipt(
            membership: membership,
            replayed: replayed
        )
    }
}

private struct APICommunityMember: Decodable, Sendable {
    let membership: APICommunityMembership
    let user: APIUser

    func member(expectedChatID: UUID) throws -> CommunityMember {
        let membership = try membership.membership()
        guard membership.chatID == expectedChatID,
              membership.userID == user.id
        else {
            throw LuxoraAPIError.invalidResponse
        }
        return CommunityMember(
            membership: membership,
            participant: user.participant
        )
    }
}

private struct APICommunityMembership: Decodable, Sendable {
    let chatId: UUID
    let userId: UUID
    let role: ChatMembershipRole
    let revision: Int
    let joinedAt: Date
    let updatedAt: Date

    func membership() throws -> ChatMembership {
        guard revision > 0, updatedAt >= joinedAt else {
            throw LuxoraAPIError.invalidResponse
        }
        return ChatMembership(
            chatID: chatId,
            userID: userId,
            role: role,
            revision: revision,
            joinedAt: joinedAt,
            updatedAt: updatedAt
        )
    }
}
