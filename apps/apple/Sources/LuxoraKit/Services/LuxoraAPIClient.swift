import Foundation

actor LuxoraAPIClient {
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

    func capabilities() async throws -> ServerCapabilities {
        let response: APICapabilities = try await request(path: "/v1/capabilities", token: nil)
        return try response.validated()
    }

    func register(username: String, displayName: String, password: String, deviceName: String) async throws -> APIAuthResponse {
        try await request(
            path: "/v1/auth/register",
            method: "POST",
            body: [
                "username": username,
                "displayName": displayName,
                "password": password,
                "deviceName": deviceName,
            ],
            token: nil
        )
    }

    func login(username: String, password: String, deviceName: String) async throws -> APIAuthResponse {
        try await request(
            path: "/v1/auth/login",
            method: "POST",
            body: [
                "username": username,
                "password": password,
                "deviceName": deviceName,
            ],
            token: nil
        )
    }

    func requestPhoneCode(
        countryCode: String,
        nationalNumber: String,
        deviceName: String,
        clientNonce: UUID
    ) async throws -> APIPhoneCodeChallenge {
        try await request(
            path: "/v1/auth/phone/challenges",
            method: "POST",
            body: APIPhoneAuthenticationBody.begin(
                countryCode: countryCode,
                nationalNumber: nationalNumber,
                deviceName: deviceName,
                clientNonce: clientNonce
            ),
            token: nil
        )
    }

    func verifyPhoneCode(
        challengeID: String,
        code: String,
        deviceName: String,
        clientNonce: UUID
    ) async throws -> APIPhoneCodeVerificationResult {
        let encodedChallengeID = try Self.encodedPathComponent(challengeID)
        return try await request(
            path: "/v1/auth/phone/challenges/\(encodedChallengeID)/verify",
            method: "POST",
            body: APIPhoneAuthenticationBody.verify(
                code: code,
                deviceName: deviceName,
                clientNonce: clientNonce
            ),
            token: nil
        )
    }

    func completePhoneRegistration(
        registrationToken: String,
        displayName: String,
        username: String,
        bio: String,
        deviceName: String,
        clientNonce: UUID
    ) async throws -> APIAuthResponse {
        try await request(
            path: "/v1/auth/phone/registrations",
            method: "POST",
            body: APIPhoneAuthenticationBody.registration(
                registrationToken: registrationToken,
                displayName: displayName,
                username: username,
                bio: bio,
                deviceName: deviceName,
                clientNonce: clientNonce
            ),
            token: nil
        )
    }

    func checkPhoneUsername(
        registrationToken: String,
        username: String
    ) async throws -> APIPhoneUsernameAvailability {
        try await request(
            path: "/v1/auth/phone/usernames/check",
            method: "POST",
            body: APIPhoneAuthenticationBody.usernameCheck(
                registrationToken: registrationToken,
                username: username
            ),
            token: nil
        )
    }

    func currentUser(token: String) async throws -> APIUser {
        struct Response: Decodable, Sendable { let user: APIUser }
        let response: Response = try await request(path: "/v1/me", token: token)
        return response.user
    }

    func refresh(refreshToken: String) async throws -> APITokens {
        struct Response: Decodable, Sendable { let tokens: APITokens }
        let response: Response = try await request(
            path: "/v1/auth/refresh",
            method: "POST",
            body: ["refreshToken": refreshToken],
            token: nil
        )
        return response.tokens
    }

    func revokeCurrentSession(token: String) async throws {
        struct EmptyResponse: Decodable, Sendable {}
        try await requestWithoutResponse(path: "/v1/auth/sessions/current", method: "DELETE", token: token)
    }

    func chats(token: String) async throws -> [APIChat] {
        let response: APIList<APIChat> = try await request(path: "/v1/chats?limit=100", token: token)
        return response.items
    }

    func messages(chatID: UUID, token: String) async throws -> [APIMessage] {
        let response: APIList<APIMessage> = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)/messages?limit=100",
            token: token
        )
        return Array(response.items.reversed())
    }

    func sendMessage(chatID: UUID, clientNonce: UUID, body: String, token: String) async throws -> APIMessage {
        struct Response: Decodable, Sendable { let message: APIMessage }
        let response: Response = try await request(
            path: "/v1/chats/\(chatID.apiPathComponent)/messages",
            method: "POST",
            body: APIChatBody.sendMessage(clientNonce: clientNonce, body: body),
            token: token
        )
        return response.message
    }

    func createDirectChat(userID: UUID, token: String) async throws -> APIChat {
        struct Response: Decodable, Sendable { let chat: APIChat }
        let response: Response = try await request(
            path: "/v1/chats",
            method: "POST",
            body: APIChatBody.createDirect(userID: userID),
            token: token
        )
        return response.chat
    }

    func markRead(chatID: UUID, messageID: UUID, token: String) async throws {
        try await requestWithoutResponse(
            path: "/v1/chats/\(chatID.apiPathComponent)/read",
            method: "POST",
            body: APIChatBody.markRead(messageID: messageID),
            token: token
        )
    }

    func setReaction(messageID: UUID, emoji: String, active: Bool, token: String) async throws -> [APIReactionSummary] {
        struct Response: Decodable, Sendable { let items: [APIReactionSummary] }
        let response: Response = try await request(
            path: "/v1/messages/\(messageID.apiPathComponent)/reactions",
            method: active ? "PUT" : "DELETE",
            body: APIChatBody.reaction(emoji: emoji),
            token: token
        )
        return response.items
    }

    func searchUsers(query: String, token: String) async throws -> [APIUser] {
        guard let encoded = Self.encodedQueryValue(query) else { return [] }
        let response: APIList<APIUser> = try await request(path: "/v1/users/search?q=\(encoded)&limit=30", token: token)
        return response.items
    }

    private func request<Response: Decodable & Sendable>(
        path: String,
        method: String = "GET",
        body: [String: String]? = nil,
        token: String?
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL) else {
            throw LuxoraAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse else { throw LuxoraAPIError.invalidResponse }
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

    private func requestWithoutResponse(
        path: String,
        method: String,
        body: [String: String]? = nil,
        token: String
    ) async throws {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL) else {
            throw LuxoraAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse else { throw LuxoraAPIError.invalidResponse }
        guard 200..<300 ~= http.statusCode else {
            let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data)
            throw LuxoraAPIError.server(
                status: http.statusCode,
                code: envelope?.error.code ?? "HTTP_\(http.statusCode)",
                message: envelope?.error.message ?? LuxoraL10n.text("error.server_request_failed")
            )
        }
    }

    static func transportError(_ error: Error) -> Error {
        let cocoaError = error as NSError
        if error is CancellationError
            || (cocoaError.domain == NSURLErrorDomain && cocoaError.code == NSURLErrorCancelled)
        {
            return CancellationError()
        }
        return LuxoraAPIError.transport(error.localizedDescription)
    }

    private static func encodedPathComponent(_ value: String) throws -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard !value.isEmpty,
              let encoded = value.addingPercentEncoding(withAllowedCharacters: allowed),
              !encoded.isEmpty
        else {
            throw LuxoraAPIError.invalidResponse
        }
        return encoded
    }

    static func encodedQueryValue(_ value: String) -> String? {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        return value.addingPercentEncoding(withAllowedCharacters: allowed)
    }
}

enum APIChatBody {
    static func createDirect(userID: UUID) -> [String: String] {
        [
            "kind": "direct",
            "userId": userID.apiPathComponent,
        ]
    }

    static func sendMessage(clientNonce: UUID, body: String) -> [String: String] {
        [
            "kind": "text",
            "body": body,
            "clientNonce": clientNonce.apiPathComponent,
        ]
    }

    static func markRead(messageID: UUID) -> [String: String] {
        ["messageId": messageID.apiPathComponent]
    }

    static func reaction(emoji: String) -> [String: String] {
        ["emoji": emoji]
    }
}

enum APIPhoneAuthenticationBody {
    static func usernameCheck(registrationToken: String, username: String) -> [String: String] {
        [
            "registrationToken": registrationToken,
            "username": username,
        ]
    }

    static func begin(
        countryCode: String,
        nationalNumber: String,
        deviceName: String,
        clientNonce: UUID
    ) -> [String: String] {
        [
            "countryCode": countryCode,
            "nationalNumber": nationalNumber,
            "deviceName": deviceName,
            "clientNonce": clientNonce.apiPathComponent,
        ]
    }

    static func verify(code: String, deviceName: String, clientNonce: UUID) -> [String: String] {
        [
            "code": code,
            "deviceName": deviceName,
            "clientNonce": clientNonce.apiPathComponent,
        ]
    }

    static func registration(
        registrationToken: String,
        displayName: String,
        username: String,
        bio: String,
        deviceName: String,
        clientNonce: UUID
    ) -> [String: String] {
        [
            "registrationToken": registrationToken,
            "displayName": displayName,
            "username": username,
            "bio": bio,
            "deviceName": deviceName,
            "clientNonce": clientNonce.apiPathComponent,
        ]
    }
}

extension UUID {
    /// Server-owned UUIDs use one canonical lowercase representation in path
    /// segments. Foundation's display representation is uppercase.
    var apiPathComponent: String { uuidString.lowercased() }

    /// Authentication mutation idempotency keys are explicit RFC 4122 UUIDv4
    /// values, including on platforms where the Foundation implementation may
    /// change its default UUID generation strategy.
    static func clientNonceV4() -> UUID {
        var bytes = UUID().uuid
        withUnsafeMutableBytes(of: &bytes) { rawBytes in
            rawBytes[6] = (rawBytes[6] & 0x0F) | 0x40
            rawBytes[8] = (rawBytes[8] & 0x3F) | 0x80
        }
        return UUID(uuid: bytes)
    }
}
