import Foundation

struct ChatDraftRateLimitError: LocalizedError, Equatable, Sendable {
    static let minimumRetryAfterSeconds = 1
    static let maximumRetryAfterSeconds = 86_400

    let retryAfterSeconds: Int

    init(retryAfterSeconds: Int) {
        self.retryAfterSeconds = min(
            max(retryAfterSeconds, Self.minimumRetryAfterSeconds),
            Self.maximumRetryAfterSeconds
        )
    }

    init(headerValue: String?, detailValue: Int?) {
        if let headerValue, let parsedHeader = Int(headerValue) {
            self.init(retryAfterSeconds: parsedHeader)
        } else if let detailValue {
            self.init(retryAfterSeconds: detailValue)
        } else {
            self.init(retryAfterSeconds: Self.minimumRetryAfterSeconds)
        }
    }

    var errorDescription: String? {
        "Слишком много сохранений. Автоповтор через \(retryAfterSeconds) с."
    }
}

struct APIChatDraftErrorEnvelope: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        struct Details: Decodable, Sendable {
            let retryAfterSeconds: Int?
        }

        let code: String
        let message: String
        let details: Details?
    }

    let error: Payload
}

extension LuxoraAPIClient {
    func chatDraft(chatID: UUID, token: String) async throws -> SynchronizedChatDraftState {
        guard SynchronizedChatDraftContract.isRFCUUID(chatID) else {
            throw LuxoraAPIError.invalidResponse
        }
        let response: APIChatDraftStateResponse = try await requestChatDraft(
            path: "/v1/chats/\(chatID.apiPathComponent)/draft",
            token: token
        )
        return try response.validated(expectedChatID: chatID)
    }

    func putChatDraft(
        chatID: UUID,
        command: ChatDraftPutCommand,
        token: String
    ) async throws -> ChatDraftMutationResult {
        guard SynchronizedChatDraftContract.isRFCUUID(chatID),
              SynchronizedChatDraftContract.isRFCUUID(command.clientNonce),
              command.content.replyToMessageID.map(SynchronizedChatDraftContract.isRFCUUID) ?? true,
              command.content.isServerValid,
              command.expectedRevision >= 0,
              command.expectedRevision <= SynchronizedChatDraftContract.maximumSafeInteger
        else { throw LuxoraAPIError.invalidResponse }

        let response: APIChatDraftMutationResponse = try await requestChatDraftMutation(
            path: "/v1/chats/\(chatID.apiPathComponent)/draft",
            method: "PUT",
            body: ChatDraftPutBody(command: command),
            token: token
        )
        return try response.validated(expectedChatID: chatID)
    }

    func deleteChatDraft(
        chatID: UUID,
        command: ChatDraftDeleteCommand,
        token: String
    ) async throws -> ChatDraftMutationResult {
        guard SynchronizedChatDraftContract.isRFCUUID(chatID),
              SynchronizedChatDraftContract.isRFCUUID(command.clientNonce),
              command.expectedRevision > 0,
              command.expectedRevision <= SynchronizedChatDraftContract.maximumSafeInteger
        else { throw LuxoraAPIError.invalidResponse }

        let response: APIChatDraftMutationResponse = try await requestChatDraftMutation(
            path: "/v1/chats/\(chatID.apiPathComponent)/draft",
            method: "DELETE",
            body: ChatDraftDeleteBody(command: command),
            token: token
        )
        return try response.validated(expectedChatID: chatID)
    }
}

private struct ChatDraftPutBody: Encodable, Sendable {
    let text: String
    let replyToMessageId: String?
    let expectedRevision: Int
    let clientNonce: String

    init(command: ChatDraftPutCommand) {
        text = command.content.text
        replyToMessageId = command.content.replyToMessageID?.apiPathComponent
        expectedRevision = command.expectedRevision
        clientNonce = command.clientNonce.apiPathComponent
    }
}

private struct ChatDraftDeleteBody: Encodable, Sendable {
    let expectedRevision: Int
    let clientNonce: String

    init(command: ChatDraftDeleteCommand) {
        expectedRevision = command.expectedRevision
        clientNonce = command.clientNonce.apiPathComponent
    }
}
