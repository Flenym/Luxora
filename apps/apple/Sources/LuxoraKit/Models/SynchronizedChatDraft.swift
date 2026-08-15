import Foundation

public struct SynchronizedChatDraftContent: Equatable, Sendable {
    public let text: String
    public let replyToMessageID: UUID?

    public init(text: String, replyToMessageID: UUID? = nil) {
        self.text = text
        self.replyToMessageID = replyToMessageID
    }

    public static let empty = SynchronizedChatDraftContent(text: "")

    var isEmpty: Bool {
        text.isEmpty && replyToMessageID == nil
    }

    var isServerValid: Bool {
        !isEmpty && text.unicodeScalars.count <= SynchronizedChatDraft.maximumTextCodePoints
    }
}

public struct SynchronizedChatDraft: Equatable, Sendable {
    public static let maximumTextCodePoints = 10_000

    public let chatID: UUID
    public let content: SynchronizedChatDraftContent
    public let revision: Int
    public let updatedAt: Date

    init(
        chatID: UUID,
        content: SynchronizedChatDraftContent,
        revision: Int,
        updatedAt: Date
    ) {
        self.chatID = chatID
        self.content = content
        self.revision = revision
        self.updatedAt = updatedAt
    }

    public var text: String { content.text }
    public var replyToMessageID: UUID? { content.replyToMessageID }
}

public struct SynchronizedChatDraftState: Equatable, Sendable {
    public let draft: SynchronizedChatDraft?
    public let revision: Int

    init(draft: SynchronizedChatDraft?, revision: Int) {
        self.draft = draft
        self.revision = revision
    }

    public var content: SynchronizedChatDraftContent {
        draft?.content ?? .empty
    }
}

struct ChatDraftMutationResult: Equatable, Sendable {
    let state: SynchronizedChatDraftState
    let replayed: Bool
}

struct ChatDraftPutCommand: Equatable, Sendable {
    let content: SynchronizedChatDraftContent
    let expectedRevision: Int
    let clientNonce: UUID
}

struct ChatDraftDeleteCommand: Equatable, Sendable {
    let expectedRevision: Int
    let clientNonce: UUID
}

struct APIChatDraft: Decodable, Sendable {
    let chatId: UUID
    let text: String
    let replyToMessageId: UUID?
    let revision: Int
    let updatedAt: Date

    private enum CodingKeys: String, CodingKey {
        case chatId
        case text
        case replyToMessageId
        case revision
        case updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try container.decode(UUID.self, forKey: .chatId)
        text = try container.decode(String.self, forKey: .text)
        replyToMessageId = try container.decodeRequiredNullable(
            UUID.self,
            forKey: .replyToMessageId
        )
        revision = try container.decode(Int.self, forKey: .revision)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }

    func validated(expectedChatID: UUID) throws -> SynchronizedChatDraft {
        let content = SynchronizedChatDraftContent(
            text: text,
            replyToMessageID: replyToMessageId
        )
        guard SynchronizedChatDraftContract.isRFCUUID(chatId),
              chatId == expectedChatID,
              replyToMessageId.map(SynchronizedChatDraftContract.isRFCUUID) ?? true,
              content.isServerValid,
              revision > 0,
              revision <= SynchronizedChatDraftContract.maximumSafeInteger
        else { throw LuxoraAPIError.invalidResponse }
        return SynchronizedChatDraft(
            chatID: chatId,
            content: content,
            revision: revision,
            updatedAt: updatedAt
        )
    }
}

struct APIChatDraftStateResponse: Decodable, Sendable {
    let draft: APIChatDraft?
    let revision: Int

    private enum CodingKeys: String, CodingKey {
        case draft
        case revision
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        draft = try container.decodeRequiredNullable(APIChatDraft.self, forKey: .draft)
        revision = try container.decode(Int.self, forKey: .revision)
    }

    func validated(expectedChatID: UUID) throws -> SynchronizedChatDraftState {
        try SynchronizedChatDraftContract.validatedState(
            draft: draft,
            revision: revision,
            expectedChatID: expectedChatID
        )
    }
}

struct APIChatDraftMutationResponse: Decodable, Sendable {
    let draft: APIChatDraft?
    let revision: Int
    let replayed: Bool

    private enum CodingKeys: String, CodingKey {
        case draft
        case revision
        case replayed
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        draft = try container.decodeRequiredNullable(APIChatDraft.self, forKey: .draft)
        revision = try container.decode(Int.self, forKey: .revision)
        replayed = try container.decode(Bool.self, forKey: .replayed)
    }

    func validated(expectedChatID: UUID) throws -> ChatDraftMutationResult {
        ChatDraftMutationResult(
            state: try SynchronizedChatDraftContract.validatedState(
                draft: draft,
                revision: revision,
                expectedChatID: expectedChatID
            ),
            replayed: replayed
        )
    }
}

enum SynchronizedChatDraftContract {
    static let maximumSafeInteger = 9_007_199_254_740_991

    static func isRFCUUID(_ value: UUID) -> Bool {
        let bytes = withUnsafeBytes(of: value.uuid) { Array($0) }
        guard bytes.count == 16 else { return false }
        let version = (bytes[6] & 0xF0) >> 4
        return (1...8).contains(version) && (bytes[8] & 0xC0) == 0x80
    }

    static func validatedState(
        draft: APIChatDraft?,
        revision: Int,
        expectedChatID: UUID
    ) throws -> SynchronizedChatDraftState {
        guard revision >= 0, revision <= maximumSafeInteger else {
            throw LuxoraAPIError.invalidResponse
        }
        let validatedDraft = try draft?.validated(expectedChatID: expectedChatID)
        guard validatedDraft?.revision == revision || validatedDraft == nil else {
            throw LuxoraAPIError.invalidResponse
        }
        return SynchronizedChatDraftState(draft: validatedDraft, revision: revision)
    }
}

private extension KeyedDecodingContainer {
    func decodeRequiredNullable<Value: Decodable>(
        _ type: Value.Type,
        forKey key: Key
    ) throws -> Value? {
        guard contains(key) else {
            throw DecodingError.keyNotFound(
                key,
                DecodingError.Context(
                    codingPath: codingPath,
                    debugDescription: "Required nullable key is missing"
                )
            )
        }
        return try decodeIfPresent(type, forKey: key)
    }
}
