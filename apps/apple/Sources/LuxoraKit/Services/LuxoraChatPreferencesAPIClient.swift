import Foundation

extension LuxoraAPIClient {
    func chatPreferences(chatID: UUID, token: String) async throws -> APIChatPreferences {
        struct Response: Decodable, Sendable {
            let preferences: APIChatPreferences
        }
        let response: Response = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)/preferences",
            token: token
        )
        return response.preferences
    }

    func updateChatPreferences(
        chatID: UUID,
        patch: ChatPreferencesPatch,
        token: String
    ) async throws -> APIChatPreferences {
        guard patch.hasChanges else { throw LuxoraAPIError.invalidResponse }
        struct Response: Decodable, Sendable {
            let preferences: APIChatPreferences
        }
        let response: Response = try await requestEncoded(
            path: "/v1/chats/\(chatID.apiPathComponent)/preferences",
            method: "PATCH",
            body: patch,
            token: token
        )
        return response.preferences
    }
}
