import Foundation

struct ChatFolderCreateCommand: Equatable, Sendable {
    let draft: ChatFolderDraft
    let clientNonce: UUID
}

struct ChatFolderPatchCommand: Equatable, Sendable {
    let title: String?
    let rules: ChatFolderRules?
    let overrides: [ChatFolderOverride]?
    let expectedRevision: Int
    let clientNonce: UUID

    var hasChanges: Bool { title != nil || rules != nil || overrides != nil }
}

struct ChatFolderDeleteCommand: Equatable, Sendable {
    let expectedRevision: Int
    let clientNonce: UUID
}

struct ChatFolderReorderCommand: Equatable, Sendable {
    let folderIDs: [UUID]
    let expectedStateRevision: Int
    let clientNonce: UUID
}

struct ChatFolderMutationReceipt: Equatable, Sendable {
    let folder: ChatFolder
    let stateRevision: Int
    let replayed: Bool
}

struct ChatFolderDeleteReceipt: Equatable, Sendable {
    let folderID: UUID
    let stateRevision: Int
    let replayed: Bool
}

struct ChatFolderReorderReceipt: Equatable, Sendable {
    let folders: [ChatFolder]
    let stateRevision: Int
    let replayed: Bool
}

struct ChatFolderRateLimitError: LocalizedError, Equatable, Sendable {
    let retryAfterSeconds: Int?
    let idempotencyTTLSeconds: Int?
    let maximumActiveReceipts: Int?

    var errorDescription: String? {
        if let retryAfterSeconds {
            return "Слишком много изменений папок. Повторите через \(retryAfterSeconds) с."
        }
        return "Слишком много изменений папок. Подождите и повторите ту же команду."
    }
}

actor LuxoraChatFoldersAPIClient {
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

    func folders(token: String) async throws -> ChatFolderListSnapshot {
        let response: APIChatFolderListResponse = try await request(
            path: "/v1/chat-folders",
            token: token
        )
        return try response.snapshot()
    }

    func create(
        _ command: ChatFolderCreateCommand,
        token: String
    ) async throws -> ChatFolderMutationReceipt {
        let draft = try command.draft.validated().canonicalized
        let response: APIChatFolderMutationResponse = try await request(
            path: "/v1/chat-folders",
            method: "POST",
            body: APICreateChatFolderBody(
                title: draft.title,
                rules: draft.rules,
                overrides: draft.overrides,
                clientNonce: command.clientNonce.apiPathComponent
            ),
            token: token
        )
        let receipt = try response.receipt()
        guard receipt.folder.title == draft.title,
              receipt.folder.rules == draft.rules,
              receipt.folder.overrides == draft.overrides
        else { throw LuxoraAPIError.invalidResponse }
        return receipt
    }

    func patch(
        folderID: UUID,
        command: ChatFolderPatchCommand,
        token: String
    ) async throws -> ChatFolderMutationReceipt {
        guard command.expectedRevision > 0, command.hasChanges else {
            throw LuxoraAPIError.invalidResponse
        }
        let title = command.title.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard title.map({ !$0.isEmpty && $0.unicodeScalars.count <= ChatFolderContract.maximumTitleCodePoints })
            ?? true
        else { throw LuxoraAPIError.invalidResponse }
        let rules = try command.rules?.validated().canonicalized
        let overrides = try command.overrides.map { try $0.validatedCanonicalOverrides() }
        let response: APIChatFolderMutationResponse = try await request(
            path: "/v1/chat-folders/\(folderID.apiPathComponent)",
            method: "PATCH",
            body: APIPatchChatFolderBody(
                title: title,
                rules: rules,
                overrides: overrides,
                expectedRevision: command.expectedRevision,
                clientNonce: command.clientNonce.apiPathComponent
            ),
            token: token
        )
        let receipt = try response.receipt()
        guard receipt.folder.id == folderID,
              title.map({ receipt.folder.title == $0 }) ?? true,
              rules.map({ receipt.folder.rules == $0 }) ?? true,
              overrides.map({ receipt.folder.overrides == $0 }) ?? true
        else { throw LuxoraAPIError.invalidResponse }
        return receipt
    }

    func delete(
        folderID: UUID,
        command: ChatFolderDeleteCommand,
        token: String
    ) async throws -> ChatFolderDeleteReceipt {
        guard command.expectedRevision > 0 else { throw LuxoraAPIError.invalidResponse }
        let response: APIChatFolderDeleteResponse = try await request(
            path: "/v1/chat-folders/\(folderID.apiPathComponent)",
            method: "DELETE",
            body: APIDeleteChatFolderBody(
                expectedRevision: command.expectedRevision,
                clientNonce: command.clientNonce.apiPathComponent
            ),
            token: token
        )
        guard response.folderId == folderID, response.stateRevision >= 0 else {
            throw LuxoraAPIError.invalidResponse
        }
        return ChatFolderDeleteReceipt(
            folderID: response.folderId,
            stateRevision: response.stateRevision,
            replayed: response.replayed
        )
    }

    func reorder(
        _ command: ChatFolderReorderCommand,
        token: String
    ) async throws -> ChatFolderReorderReceipt {
        guard !command.folderIDs.isEmpty,
              command.folderIDs.count <= ChatFolderContract.maximumFolders,
              Set(command.folderIDs).count == command.folderIDs.count,
              command.expectedStateRevision >= 0
        else { throw LuxoraAPIError.invalidResponse }
        let response: APIChatFolderReorderResponse = try await request(
            path: "/v1/chat-folders/order",
            method: "PUT",
            body: APIReorderChatFoldersBody(
                folderIds: command.folderIDs.map(\.apiPathComponent),
                expectedStateRevision: command.expectedStateRevision,
                clientNonce: command.clientNonce.apiPathComponent
            ),
            token: token
        )
        let snapshot = try ChatFolderListSnapshot(
            folders: response.items,
            stateRevision: response.stateRevision
        ).validated()
        guard snapshot.folders.map(\.id) == command.folderIDs else {
            throw LuxoraAPIError.invalidResponse
        }
        return ChatFolderReorderReceipt(
            folders: snapshot.folders,
            stateRevision: snapshot.stateRevision,
            replayed: response.replayed
        )
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
        let encoded: Data
        do {
            encoded = try encoder.encode(body)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
        return try await performRequest(path: path, method: method, body: encoded, token: token)
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
            let cocoaError = error as NSError
            if error is CancellationError
                || (cocoaError.domain == NSURLErrorDomain && cocoaError.code == NSURLErrorCancelled) {
                throw CancellationError()
            }
            throw LuxoraAPIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse,
              Self.sameOrigin(http.url, configuration.apiBaseURL)
        else { throw LuxoraAPIError.invalidResponse }

        guard 200..<300 ~= http.statusCode else {
            let envelope = try? decoder.decode(APIChatFolderErrorEnvelope.self, from: data)
            if http.statusCode == 429 {
                let headerValue = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "")
                let detailValue = envelope?.error.details?.retryAfterSeconds
                throw ChatFolderRateLimitError(
                    retryAfterSeconds: Self.safeRetryAfter(headerValue ?? detailValue),
                    idempotencyTTLSeconds:
                        envelope?.error.details?.idempotencyTtlSeconds
                            == ChatFolderContract.idempotencyTTLSeconds
                            ? ChatFolderContract.idempotencyTTLSeconds
                            : nil,
                    maximumActiveReceipts:
                        envelope?.error.details?.maxActiveReceipts
                            == ChatFolderContract.maximumActiveCommandReceipts
                            ? ChatFolderContract.maximumActiveCommandReceipts
                            : nil
                )
            }
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

    private static func sameOrigin(_ candidate: URL?, _ configuredBase: URL) -> Bool {
        guard let candidate else { return false }
        return candidate.scheme?.lowercased() == configuredBase.scheme?.lowercased()
            && candidate.host?.lowercased() == configuredBase.host?.lowercased()
            && candidate.port == configuredBase.port
    }

    private static func safeRetryAfter(_ value: Int?) -> Int? {
        guard let value, value > 0 else { return nil }
        return min(value, ChatFolderContract.idempotencyTTLSeconds)
    }
}

private struct APICreateChatFolderBody: Encodable, Sendable {
    let title: String
    let rules: ChatFolderRules
    let overrides: [ChatFolderOverride]
    let clientNonce: String
}

private struct APIPatchChatFolderBody: Encodable, Sendable {
    let title: String?
    let rules: ChatFolderRules?
    let overrides: [ChatFolderOverride]?
    let expectedRevision: Int
    let clientNonce: String
}

private struct APIDeleteChatFolderBody: Encodable, Sendable {
    let expectedRevision: Int
    let clientNonce: String
}

private struct APIReorderChatFoldersBody: Encodable, Sendable {
    let folderIds: [String]
    let expectedStateRevision: Int
    let clientNonce: String
}

private struct APIChatFolderListResponse: Decodable, Sendable {
    let items: [ChatFolder]
    let stateRevision: Int

    func snapshot() throws -> ChatFolderListSnapshot {
        try ChatFolderListSnapshot(folders: items, stateRevision: stateRevision).validated()
    }
}

private struct APIChatFolderMutationResponse: Decodable, Sendable {
    let folder: ChatFolder
    let stateRevision: Int
    let replayed: Bool

    func receipt() throws -> ChatFolderMutationReceipt {
        guard stateRevision >= 0 else { throw LuxoraAPIError.invalidResponse }
        return ChatFolderMutationReceipt(
            folder: try folder.validated(),
            stateRevision: stateRevision,
            replayed: replayed
        )
    }
}

private struct APIChatFolderDeleteResponse: Decodable, Sendable {
    let folderId: UUID
    let stateRevision: Int
    let replayed: Bool
}

private struct APIChatFolderReorderResponse: Decodable, Sendable {
    let items: [ChatFolder]
    let stateRevision: Int
    let replayed: Bool
}

private struct APIChatFolderErrorEnvelope: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        struct Details: Decodable, Sendable {
            let retryAfterSeconds: Int?
            let idempotencyTtlSeconds: Int?
            let maxActiveReceipts: Int?
        }

        let code: String
        let message: String
        let details: Details?
    }

    let error: Payload
}

private extension ChatFolderRules {
    var canonicalized: ChatFolderRules {
        let order = Dictionary(uniqueKeysWithValues: ChatFolderChatKind.allCases.enumerated().map {
            ($0.element, $0.offset)
        })
        return ChatFolderRules(
            includeKinds: includeKinds.sorted { order[$0, default: 0] < order[$1, default: 0] },
            unreadOnly: unreadOnly,
            excludeMuted: excludeMuted,
            includeArchived: includeArchived
        )
    }
}

private extension ChatFolderDraft {
    var canonicalized: ChatFolderDraft {
        ChatFolderDraft(
            title: title,
            rules: rules.canonicalized,
            overrides: overrides.canonicalized
        )
    }
}

private extension Array where Element == ChatFolderOverride {
    func validatedCanonicalOverrides() throws -> [ChatFolderOverride] {
        guard count <= ChatFolderContract.maximumOverrides,
              Set(map(\.chatID)).count == count
        else { throw LuxoraAPIError.invalidResponse }
        let checked = try map { try $0.validated() }
        let pins = checked.compactMap(\.pinnedPosition)
        guard Set(pins).count == pins.count else { throw LuxoraAPIError.invalidResponse }
        return checked.canonicalized
    }

    var canonicalized: [ChatFolderOverride] {
        sorted { lhs, rhs in
            switch (lhs.pinnedPosition, rhs.pinnedPosition) {
            case let (.some(left), .some(right)) where left != right: return left < right
            case (.some, .none): return true
            case (.none, .some): return false
            default: return lhs.chatID.apiPathComponent < rhs.chatID.apiPathComponent
            }
        }
    }
}
