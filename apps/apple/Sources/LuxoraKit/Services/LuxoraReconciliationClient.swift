import Foundation

struct RealtimeReconciliationBoundary: Equatable, Sendable {
    let sequence: Int
    let cursor: String
    let capturedAt: Date
    let cursorExpiresAt: Date
}

struct ReconciliationMessageState: Sendable {
    let message: APIMessage
    let reactions: [APIReactionSummary]
    let receipts: [APIMessageReceipt]
}

struct ReconciliationChatState: Sendable {
    let chat: APIChat
    let members: [APIChatMember]
    let messages: [ReconciliationMessageState]
    let pins: [APIMessagePin]
    let topics: [APIChatTopic]
}

struct LuxoraReconciliationBundle: Sendable {
    let boundary: RealtimeReconciliationBoundary
    let currentUser: APIUser
    let incomingRequests: [APIMessageRequest]
    let outgoingRequests: [APIMessageRequest]
    let blocks: [APIBlockedAccount]
    let chats: [ReconciliationChatState]
    let attachments: [APIReconciliationAttachment]
    let safetyReports: [APIReconciliationSafetyReport]
    let chatFolders: ChatFolderListSnapshot
}

private struct APIRealtimeSnapshot: Decodable, Sendable {
    struct Boundary: Decodable, Sendable {
        let sequence: Int
        let cursor: String
        let capturedAt: Date
        let cursorExpiresAt: Date
    }
    struct Reset: Decodable, Sendable {
        let required: Bool
        let collections: [String]
    }
    struct Resources: Decodable, Sendable {
        let incomingMessageRequests: String
        let outgoingMessageRequests: String
        let blocks: String
        let chats: String
        let attachments: String
        let safetyReports: String
        let chatFolders: String
        let membersTemplate: String
        let messagesTemplate: String
        let pinsTemplate: String
        let topicsTemplate: String
        let reactionsTemplate: String
        let receiptsTemplate: String
    }
    struct Pagination: Decodable, Sendable {
        let cursorParameter: String
        let limitParameter: String
        let nextCursorField: String
        let maxPageSize: Int
    }
    struct Resume: Decodable, Sendable {
        let websocketPath: String
        let authenticateField: String
        let applyEventsIdempotently: Bool
        let sequenceAdjacencyRequired: Bool
    }

    let contractVersion: Int
    let scope: String
    let boundary: Boundary
    let reset: Reset
    let resources: Resources
    let pagination: Pagination
    let resume: Resume

    func validatedBoundary() throws -> RealtimeReconciliationBoundary {
        let expectedCollections = [
            "message_requests", "blocks", "chats", "members", "messages", "pins",
            "topics", "reactions", "receipts", "attachments", "safety_reports",
            "chat_folders",
        ]
        guard contractVersion == 1,
              scope == "account_session",
              boundary.sequence >= 0,
              RealtimeCursorValidator.isValid(boundary.cursor),
              boundary.cursorExpiresAt > boundary.capturedAt,
              reset.required,
              reset.collections == expectedCollections,
              resources.incomingMessageRequests == "/v1/message-requests?direction=incoming",
              resources.outgoingMessageRequests == "/v1/message-requests?direction=outgoing",
              resources.blocks == "/v2/sync/blocks",
              resources.chats == "/v2/sync/chats",
              resources.attachments == "/v1/attachments",
              resources.safetyReports == "/v1/safety/reports",
              resources.chatFolders == "/v1/chat-folders",
              resources.membersTemplate == "/v1/chats/{chatId}/members",
              resources.messagesTemplate == "/v1/chats/{chatId}/messages",
              resources.pinsTemplate == "/v1/chats/{chatId}/pins",
              resources.topicsTemplate == "/v1/chats/{chatId}/topics",
              resources.reactionsTemplate == "/v1/messages/{messageId}/reactions",
              resources.receiptsTemplate == "/v1/messages/{messageId}/receipts",
              pagination.cursorParameter == "cursor",
              pagination.limitParameter == "limit",
              pagination.nextCursorField == "nextCursor",
              pagination.maxPageSize == 100,
              resume.websocketPath == "/v2/realtime",
              resume.authenticateField == "resumeCursor",
              resume.applyEventsIdempotently,
              !resume.sequenceAdjacencyRequired
        else { throw LuxoraAPIError.invalidResponse }
        return RealtimeReconciliationBoundary(
            sequence: boundary.sequence,
            cursor: boundary.cursor,
            capturedAt: boundary.capturedAt,
            cursorExpiresAt: boundary.cursorExpiresAt
        )
    }

    func hasSameFetchContract(as other: APIRealtimeSnapshot) -> Bool {
        contractVersion == other.contractVersion
            && scope == other.scope
            && reset.required == other.reset.required
            && reset.collections == other.reset.collections
            && resources.incomingMessageRequests == other.resources.incomingMessageRequests
            && resources.outgoingMessageRequests == other.resources.outgoingMessageRequests
            && resources.blocks == other.resources.blocks
            && resources.chats == other.resources.chats
            && resources.attachments == other.resources.attachments
            && resources.safetyReports == other.resources.safetyReports
            && resources.chatFolders == other.resources.chatFolders
            && resources.membersTemplate == other.resources.membersTemplate
            && resources.messagesTemplate == other.resources.messagesTemplate
            && resources.pinsTemplate == other.resources.pinsTemplate
            && resources.topicsTemplate == other.resources.topicsTemplate
            && resources.reactionsTemplate == other.resources.reactionsTemplate
            && resources.receiptsTemplate == other.resources.receiptsTemplate
            && pagination.cursorParameter == other.pagination.cursorParameter
            && pagination.limitParameter == other.pagination.limitParameter
            && pagination.nextCursorField == other.pagination.nextCursorField
            && pagination.maxPageSize == other.pagination.maxPageSize
            && resume.websocketPath == other.resume.websocketPath
            && resume.authenticateField == other.resume.authenticateField
            && resume.applyEventsIdempotently == other.resume.applyEventsIdempotently
            && resume.sequenceAdjacencyRequired == other.resume.sequenceAdjacencyRequired
    }
}

struct APIChatMembership: Decodable, Sendable {
    let chatId: UUID
    let userId: UUID
    let role: String
    let revision: Int
    let joinedAt: Date
    let updatedAt: Date
}

struct APIChatMember: Decodable, Sendable {
    let membership: APIChatMembership
    let user: APIUser
}

struct APIChatTopic: Decodable, Sendable {
    let id: UUID
    let chatId: UUID
    let title: String
    let createdBy: APIUser
    let createdAt: Date
    let updatedAt: Date
    let closedAt: Date?
}

struct APIMessageReceipt: Decodable, Sendable {
    let userId: UUID
    let deliveredAt: Date
    let readAt: Date?
}

struct APIBlockedAccount: Decodable, Sendable {
    let accountId: UUID
    let profileSnapshot: APIPublicProfile?
    let blockedAt: Date
}

struct APIReconciliationAttachment: Decodable, Sendable {
    let id: UUID
    let createdAt: Date
}

struct APIReconciliationSafetyReport: Decodable, Sendable {
    let id: UUID
    let subjectAccountId: UUID
    let submittedAt: Date
}

private struct APIItems<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
}

private struct APIReconciliationChatFolders: Decodable, Sendable {
    let items: [ChatFolder]
    let stateRevision: Int

    func snapshot() throws -> ChatFolderListSnapshot {
        try ChatFolderListSnapshot(folders: items, stateRevision: stateRevision).validated()
    }
}

extension LuxoraAPIClient {
    func reconciliationBundle(
        token: String,
        expectedUserID: UUID
    ) async throws -> LuxoraReconciliationBundle {
        // Resource endpoints are individually linearizable but are not a
        // materialized historical snapshot. Two equal durable boundaries prove
        // that no account-visible mutation happened across the entire read.
        // A changed boundary discards every fetched page and retries from zero.
        for _ in 0..<3 {
            try Task.checkCancellation()
            let opening: APIRealtimeSnapshot = try await request(
                path: "/v2/sync/snapshot",
                token: token
            )
            let openingBoundary = try opening.validatedBoundary()
            let candidate = try await reconciliationCandidate(
                snapshot: opening,
                boundary: openingBoundary,
                token: token,
                expectedUserID: expectedUserID
            )
            try Task.checkCancellation()
            let closing: APIRealtimeSnapshot = try await request(
                path: "/v2/sync/snapshot",
                token: token
            )
            let closingBoundary = try closing.validatedBoundary()
            guard opening.hasSameFetchContract(as: closing) else {
                throw LuxoraAPIError.invalidResponse
            }
            guard openingBoundary.sequence == closingBoundary.sequence else {
                continue
            }
            return LuxoraReconciliationBundle(
                boundary: closingBoundary,
                currentUser: candidate.currentUser,
                incomingRequests: candidate.incomingRequests,
                outgoingRequests: candidate.outgoingRequests,
                blocks: candidate.blocks,
                chats: candidate.chats,
                attachments: candidate.attachments,
                safetyReports: candidate.safetyReports,
                chatFolders: candidate.chatFolders
            )
        }
        throw LuxoraAPIError.syncUnstable
    }

    private func reconciliationCandidate(
        snapshot: APIRealtimeSnapshot,
        boundary: RealtimeReconciliationBoundary,
        token: String,
        expectedUserID: UUID
    ) async throws -> LuxoraReconciliationBundle {
        // `/v1/me` is intentionally part of the same B1 -> resources -> B2
        // quiescence window. Profile-only invalidations (including accounts
        // with no chats) must therefore publish the new self projection in the
        // same MainActor transaction as every other reconciled collection.
        let currentUser = try await self.currentUser(token: token)
        guard currentUser.id == expectedUserID else {
            throw LuxoraAPIError.invalidResponse
        }

        let incoming: [APIMessageRequest] = try await allReconciliationPages(
            basePath: snapshot.resources.incomingMessageRequests,
            token: token
        )
        let outgoing: [APIMessageRequest] = try await allReconciliationPages(
            basePath: snapshot.resources.outgoingMessageRequests,
            token: token
        )
        guard incoming.allSatisfy({ $0.direction == .incoming }),
              outgoing.allSatisfy({ $0.direction == .outgoing })
        else { throw LuxoraAPIError.invalidResponse }

        let blocks: [APIBlockedAccount] = try await allReconciliationPages(
            basePath: snapshot.resources.blocks,
            token: token
        )
        guard Self.unique(blocks.map(\.accountId)),
              blocks.allSatisfy({ block in
                  block.profileSnapshot.map { $0.id == block.accountId } ?? true
              })
        else { throw LuxoraAPIError.invalidResponse }

        let chats: [APIChat] = try await allReconciliationPages(
            basePath: snapshot.resources.chats,
            token: token
        )
        guard Self.unique(chats.map(\.id)) else { throw LuxoraAPIError.invalidResponse }

        var chatStates: [ReconciliationChatState] = []
        var globallySeenMessageIDs = Set<UUID>()
        for chat in chats {
            try Task.checkCancellation()
            let chatID = chat.id
            let membersResponse: APIItems<APIChatMember> = try await request(
                path: "/v1/chats/\(chatID.apiPathComponent)/members",
                token: token
            )
            let members = membersResponse.items
            guard Self.unique(members.map { $0.membership.userId }),
                  members.allSatisfy({ member in
                      member.membership.chatId == chatID
                          && member.membership.userId == member.user.id
                          && member.membership.revision > 0
                          && member.membership.updatedAt >= member.membership.joinedAt
                  })
            else { throw LuxoraAPIError.invalidResponse }

            let messages: [APIMessage] = try await allReconciliationPages(
                basePath: "/v1/chats/\(chatID.apiPathComponent)/messages",
                token: token
            )
            guard Self.unique(messages.map(\.id)),
                  messages.allSatisfy({ $0.chatId == chatID }),
                  messages.allSatisfy({ globallySeenMessageIDs.insert($0.id).inserted })
            else { throw LuxoraAPIError.invalidResponse }

            let pinsResponse: APIItems<APIMessagePin> = try await request(
                path: "/v1/chats/\(chatID.apiPathComponent)/pins",
                token: token
            )
            let pins = pinsResponse.items
            let messageIDs = Set(messages.map(\.id))
            guard Self.unique(pins.map(\.messageId)),
                  pins.allSatisfy({ $0.chatId == chatID && messageIDs.contains($0.messageId) })
            else { throw LuxoraAPIError.invalidResponse }

            let topicsResponse: APIItems<APIChatTopic> = try await request(
                path: "/v1/chats/\(chatID.apiPathComponent)/topics",
                token: token
            )
            let topics = topicsResponse.items
            guard Self.unique(topics.map(\.id)),
                  topics.allSatisfy({ $0.chatId == chatID && $0.updatedAt >= $0.createdAt })
            else { throw LuxoraAPIError.invalidResponse }

            var messageStates: [ReconciliationMessageState] = []
            for message in messages.reversed() {
                try Task.checkCancellation()
                let reactionsResponse: APIItems<APIReactionSummary> = try await request(
                    path: "/v1/messages/\(message.id.apiPathComponent)/reactions",
                    token: token
                )
                let receiptsResponse: APIItems<APIMessageReceipt> = try await request(
                    path: "/v1/messages/\(message.id.apiPathComponent)/receipts",
                    token: token
                )
                guard Self.unique(reactionsResponse.items.map(\.emoji)),
                      reactionsResponse.items.allSatisfy({ $0.count > 0 }),
                      Self.unique(receiptsResponse.items.map(\.userId)),
                      receiptsResponse.items.allSatisfy({ receipt in
                          receipt.readAt.map { $0 >= receipt.deliveredAt } ?? true
                      })
                else { throw LuxoraAPIError.invalidResponse }
                messageStates.append(
                    ReconciliationMessageState(
                        message: message,
                        reactions: reactionsResponse.items,
                        receipts: receiptsResponse.items
                    )
                )
            }

            chatStates.append(
                ReconciliationChatState(
                    chat: chat,
                    members: members,
                    messages: messageStates,
                    pins: pins,
                    topics: topics
                )
            )
        }

        let attachments: [APIReconciliationAttachment] = try await allReconciliationPages(
            basePath: snapshot.resources.attachments,
            token: token
        )
        let reports: [APIReconciliationSafetyReport] = try await allReconciliationPages(
            basePath: snapshot.resources.safetyReports,
            token: token
        )
        guard Self.unique(attachments.map(\.id)), Self.unique(reports.map(\.id)) else {
            throw LuxoraAPIError.invalidResponse
        }
        let folderResponse: APIReconciliationChatFolders = try await request(
            path: snapshot.resources.chatFolders,
            token: token
        )
        let chatFolders = try folderResponse.snapshot()

        return LuxoraReconciliationBundle(
            boundary: boundary,
            currentUser: currentUser,
            incomingRequests: incoming,
            outgoingRequests: outgoing,
            blocks: blocks,
            chats: chatStates,
            attachments: attachments,
            safetyReports: reports,
            chatFolders: chatFolders
        )
    }

    private func allReconciliationPages<Item: Decodable & Sendable>(
        basePath: String,
        token: String
    ) async throws -> [Item] {
        var items: [Item] = []
        var cursor: String?
        var visited = Set<String>()
        var pageCount = 0
        repeat {
            try Task.checkCancellation()
            pageCount += 1
            guard pageCount <= 10_000 else { throw LuxoraAPIError.invalidResponse }
            var path = basePath
            path += basePath.contains("?") ? "&limit=100" : "?limit=100"
            if let cursor {
                guard visited.insert(cursor).inserted,
                      let encoded = Self.reconciliationQueryValue(cursor)
                else { throw LuxoraAPIError.invalidResponse }
                path += "&cursor=\(encoded)"
            }
            let page: APIList<Item> = try await request(path: path, token: token)
            items.append(contentsOf: page.items)
            cursor = page.nextCursor
        } while cursor != nil
        return items
    }

    private static func reconciliationQueryValue(_ value: String) -> String? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed)
    }

    private static func unique<Value: Hashable>(_ values: [Value]) -> Bool {
        Set(values).count == values.count
    }
}
