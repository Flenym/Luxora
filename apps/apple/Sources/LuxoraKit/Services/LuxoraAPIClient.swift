import CryptoKit
import Foundation

actor LuxoraAPIClient {
    static let maximumCursorPages = 1_000

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

    func completePhonePassword(
        passwordToken: String,
        password: String,
        deviceName: String,
        clientNonce: UUID
    ) async throws -> APIAuthResponse {
        try await request(
            path: "/v1/auth/phone/password",
            method: "POST",
            body: APIPhoneAuthenticationBody.password(
                passwordToken: passwordToken,
                password: password,
                deviceName: deviceName,
                clientNonce: clientNonce
            ),
            token: nil
        )
    }

    func startPhoneRecovery(
        passwordToken: String,
        clientNonce: UUID
    ) async throws -> APIPhoneRecoveryStarted {
        try await request(
            path: "/v1/auth/phone/recovery/start",
            method: "POST",
            body: APIPhoneAuthenticationBody.recoveryStart(
                passwordToken: passwordToken,
                clientNonce: clientNonce
            ),
            token: nil
        )
    }

    func completePhoneRecovery(
        recoveryToken: String,
        newPassword: String,
        deviceName: String,
        clientNonce: UUID
    ) async throws -> APIAuthResponse {
        try await request(
            path: "/v1/auth/phone/recovery/complete",
            method: "POST",
            body: APIPhoneAuthenticationBody.recoveryComplete(
                recoveryToken: recoveryToken,
                newPassword: newPassword,
                deviceName: deviceName,
                clientNonce: clientNonce
            ),
            token: nil
        )
    }

    func beginPhoneBinding(
        countryCode: String,
        nationalNumber: String,
        deviceName: String,
        clientNonce: UUID,
        token: String
    ) async throws -> APIPhoneCodeChallenge {
        try await request(
            path: "/v1/me/phone/binding/challenges",
            method: "POST",
            body: APIPhoneAuthenticationBody.bindingBegin(
                countryCode: countryCode,
                nationalNumber: nationalNumber,
                deviceName: deviceName,
                clientNonce: clientNonce
            ),
            token: token
        )
    }

    func completePhoneBinding(
        bindingToken: String,
        clientNonce: UUID,
        token: String
    ) async throws -> APIPhoneBindingCompleted {
        try await request(
            path: "/v1/me/phone/binding/complete",
            method: "POST",
            body: APIPhoneAuthenticationBody.bindingComplete(
                bindingToken: bindingToken,
                clientNonce: clientNonce
            ),
            token: token
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

    func updateCurrentUser(displayName: String, bio: String, token: String) async throws -> APIUser {
        struct Response: Decodable, Sendable { let user: APIUser }
        let response: Response = try await request(
            path: "/v1/me",
            method: "PATCH",
            body: APIProfileBody.update(displayName: displayName, bio: bio),
            token: token
        )
        return response.user
    }

    /// Resumable source upload followed by the server-owned avatar derivative
    /// binding. The idempotency key is stable for identical bytes, so a retry
    /// after any lost response re-enters the same upload instead of duplicating
    /// storage or guessing whether a command committed.
    func uploadProfileAvatar(pngData: Data, token: String) async throws -> APIUser {
        guard !pngData.isEmpty, pngData.count <= 8 * 1_024 * 1_024 else {
            throw LuxoraAPIError.invalidResponse
        }

        let digest = APIAvatarUploadContract.sha256Hex(pngData)
        let idempotencyKey = APIAvatarUploadContract.idempotencyKey(for: pngData)
        var upload = try await createAvatarUpload(
            sizeBytes: pngData.count,
            sha256: digest,
            idempotencyKey: idempotencyKey,
            imageWidth: 512,
            imageHeight: 512,
            token: token
        )
        guard upload.sizeBytes == pngData.count,
              upload.chunkSizeBytes > 0,
              upload.receivedChunkIndexes.allSatisfy({ $0 >= 0 })
        else { throw LuxoraAPIError.invalidResponse }

        switch upload.status {
        case .failed, .expired:
            throw LuxoraAPIError.server(
                status: 409,
                code: upload.failureCode ?? "UPLOAD_UNAVAILABLE",
                message: "Загрузка фото больше не может быть продолжена."
            )
        case .active:
            let received = Set(upload.receivedChunkIndexes)
            let chunkCount = (pngData.count + upload.chunkSizeBytes - 1) / upload.chunkSizeBytes
            for index in 0..<chunkCount where !received.contains(index) {
                try Task.checkCancellation()
                let start = index * upload.chunkSizeBytes
                let end = min(start + upload.chunkSizeBytes, pngData.count)
                let chunk = pngData.subdata(in: start..<end)
                upload = try await putAvatarUploadChunk(
                    uploadID: upload.id,
                    index: index,
                    start: start,
                    total: pngData.count,
                    bytes: chunk,
                    token: token
                )
            }
        case .completing, .completed:
            break
        }

        if upload.status != .completed || upload.attachment == nil {
            upload = try await completeAvatarUpload(id: upload.id, token: token)
        }
        guard upload.status == .completed, let attachmentID = upload.attachment?.id else {
            throw LuxoraAPIError.invalidResponse
        }
        return try await bindProfileAvatar(attachmentID: attachmentID, token: token)
    }

    func clearProfileAvatar(token: String) async throws -> APIUser {
        let response: APIUserResponse = try await request(
            path: "/v1/me/avatar",
            method: "DELETE",
            token: token
        )
        return response.user
    }

    func avatarImageData(path: String, token: String) async throws -> Data {
        let validatedPath = try APIAvatarUploadContract.validatedAvatarPath(path)
        let (data, response) = try await requestRaw(
            path: validatedPath,
            method: "GET",
            accept: "image/png",
            token: token
        )
        guard data.count <= 8 * 1_024 * 1_024,
              !data.isEmpty,
              response.value(forHTTPHeaderField: "Content-Type")?
                .lowercased().hasPrefix("image/png") == true
        else { throw LuxoraAPIError.invalidResponse }
        return data
    }

    func phonePasswordStatus(token: String) async throws -> APIPhonePasswordStatus {
        try await request(path: "/v1/me/phone-password", token: token)
    }

    private func createAvatarUpload(
        kind: String = "image",
        fileName: String = "profile-avatar.png",
        mimeType: String = "image/png",
        sizeBytes: Int,
        sha256: String,
        idempotencyKey: UUID,
        metadata: APIMediaDimensions? = nil,
        imageWidth: Int? = nil,
        imageHeight: Int? = nil,
        token: String
    ) async throws -> APIUploadSession {
        let resolvedMetadata = metadata ?? APIMediaDimensions(
            width: imageWidth,
            height: imageHeight,
            durationMs: nil,
            waveform: nil
        )
        let response: APIUploadResponse = try await requestEncoded(
            path: "/v1/uploads",
            method: "POST",
            body: APIAttachmentCreateBody(
                kind: kind,
                fileName: fileName,
                mimeType: mimeType,
                sizeBytes: sizeBytes,
                sha256: sha256,
                idempotencyKey: idempotencyKey.apiPathComponent,
                metadata: resolvedMetadata
            ),
            token: token
        )
        return response.upload
    }

    private func putAvatarUploadChunk(
        uploadID: UUID,
        index: Int,
        start: Int,
        total: Int,
        bytes: Data,
        token: String
    ) async throws -> APIUploadSession {
        let (responseData, _) = try await requestRaw(
            path: "/v1/uploads/\(uploadID.apiPathComponent)/chunks/\(index)",
            method: "PUT",
            body: bytes,
            accept: "application/json",
            contentType: "application/octet-stream",
            headers: [
                "Content-Range": "bytes \(start)-\(start + bytes.count - 1)/\(total)",
                "X-Chunk-SHA256": APIAvatarUploadContract.sha256Hex(bytes),
                "Content-Length": String(bytes.count),
            ],
            token: token
        )
        do {
            return try decoder.decode(APIUploadResponse.self, from: responseData).upload
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
    }

    private func completeAvatarUpload(id: UUID, token: String) async throws -> APIUploadSession {
        let response: APIUploadResponse = try await request(
            path: "/v1/uploads/\(id.apiPathComponent)/complete",
            method: "POST",
            token: token
        )
        return response.upload
    }

    private func bindProfileAvatar(attachmentID: UUID, token: String) async throws -> APIUser {
        let response: APIUserResponse = try await requestEncoded(
            path: "/v1/me/avatar",
            method: "PUT",
            body: APIAvatarUploadContract.BindAvatar(
                attachmentId: attachmentID.apiPathComponent
            ),
            token: token
        )
        return response.user
    }

    /// Uploads one attachment through the resumable session pipeline and
    /// returns the server-confirmed attachment record.
    func uploadAttachment(
        kind: String,
        fileName: String,
        mimeType: String,
        data: Data,
        imageWidth: Int?,
        imageHeight: Int?,
        durationMs: Int? = nil,
        waveform: [Int]? = nil,
        token: String,
        progress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> MessageAttachment {
        let session = try await createAvatarUpload(
            kind: kind,
            fileName: fileName,
            mimeType: mimeType,
            sizeBytes: data.count,
            sha256: APIAvatarUploadContract.sha256Hex(data),
            idempotencyKey: UUID.clientNonceV4(),
            metadata: APIMediaDimensions(
                width: imageWidth,
                height: imageHeight,
                durationMs: durationMs,
                waveform: waveform
            ),
            token: token
        )
        let chunkSize = max(1, session.chunkSizeBytes)
        var offset = 0
        var index = 0
        while offset < data.count {
            let end = min(offset + chunkSize, data.count)
            let chunk = data.subdata(in: offset..<end)
            _ = try await putAvatarUploadChunk(
                uploadID: session.id,
                index: index,
                start: offset,
                total: data.count,
                bytes: chunk,
                token: token
            )
            offset = end
            index += 1
            progress?(Double(offset) / Double(max(1, data.count)))
        }
        let completed = try await completeAvatarUpload(id: session.id, token: token)
        guard let attachment = completed.attachment else {
            throw LuxoraAPIError.invalidResponse
        }
        return attachment.attachment()
    }

    /// Downloads raw attachment bytes (images for display, files for export).
    func attachmentData(path: String, token: String, maxBytes: Int = 26_214_400) async throws -> Data {
        guard path.hasPrefix("/v1/attachments/") else {
            throw LuxoraAPIError.invalidResponse
        }
        let (data, response) = try await requestRaw(
            path: path,
            method: "GET",
            accept: "*/*",
            token: token
        )
        guard !data.isEmpty, data.count <= maxBytes else {
            throw LuxoraAPIError.invalidResponse
        }
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            throw LuxoraAPIError.invalidResponse
        }
        return data
    }

    func configurePhonePassword(
        password: String,
        currentPassword: String?,
        token: String
    ) async throws -> APIPhonePasswordStatus {
        try await requestEncoded(
            path: "/v1/me/phone-password",
            method: "PUT",
            body: APIPhonePasswordSettingsBody.Configure(
                password: password,
                currentPassword: currentPassword
            ),
            token: token
        )
    }

    func disablePhonePassword(
        currentPassword: String,
        token: String
    ) async throws -> APIPhonePasswordStatus {
        try await requestEncoded(
            path: "/v1/me/phone-password",
            method: "DELETE",
            body: APIPhonePasswordSettingsBody.Disable(currentPassword: currentPassword),
            token: token
        )
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

    func deviceSessions(token: String) async throws -> [APIDeviceSession] {
        let response: APIList<APIDeviceSession> = try await request(
            path: "/v1/auth/sessions",
            token: token
        )
        return response.items
    }

    func revokeDeviceSession(id: UUID, token: String) async throws {
        try await requestWithoutResponse(
            path: "/v1/auth/sessions/\(id.apiPathComponent)",
            method: "DELETE",
            token: token
        )
    }

    func currentPushRegistration(token: String) async throws -> APIPushRegistration? {
        struct Response: Decodable, Sendable { let registration: APIPushRegistration? }
        let response: Response = try await request(
            path: "/v1/push/registrations/current",
            token: token
        )
        if let registration = response.registration {
            try Self.validatePushRegistration(registration)
        }
        return response.registration
    }

    func upsertPushRegistration(
        deviceTokenHex: String,
        environment: APNSPushEnvironment,
        token: String
    ) async throws -> APIPushRegistration {
        let normalizedToken = deviceTokenHex.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard (32...1_024).contains(normalizedToken.count),
              normalizedToken.count.isMultiple(of: 2),
              normalizedToken.unicodeScalars.allSatisfy({ scalar in
                  (48...57).contains(scalar.value) || (97...102).contains(scalar.value)
              })
        else { throw LuxoraAPIError.invalidResponse }

        struct Body: Encodable, Sendable {
            let platform: String
            let environment: APNSPushEnvironment
            let token: String
        }
        struct Response: Decodable, Sendable { let registration: APIPushRegistration }
        let response: Response = try await requestEncoded(
            path: "/v1/push/registrations/current",
            method: "PUT",
            body: Body(platform: "apns", environment: environment, token: normalizedToken),
            token: token
        )
        try Self.validatePushRegistration(response.registration)
        return response.registration
    }

    func unregisterCurrentPushRegistration(token: String) async throws {
        try await requestWithoutResponse(
            path: "/v1/push/registrations/current",
            method: "DELETE",
            token: token
        )
    }

    func notificationSettings(token: String) async throws -> APINotificationSettings {
        struct Response: Decodable, Sendable { let settings: APINotificationSettings }
        let response: Response = try await request(
            path: "/v1/notifications/settings",
            token: token
        )
        return response.settings
    }

    func updateNotificationSettings(
        _ patch: NotificationSettingsPatch,
        token: String
    ) async throws -> APINotificationSettings {
        guard patch.hasChanges else { throw LuxoraAPIError.invalidResponse }
        struct Response: Decodable, Sendable { let settings: APINotificationSettings }
        let response: Response = try await requestEncoded(
            path: "/v1/notifications/settings",
            method: "PATCH",
            body: patch,
            token: token
        )
        return response.settings
    }

    func chats(token: String) async throws -> [APIChat] {
        var items: [APIChat] = []
        var itemIDs = Set<UUID>()
        var cursor: String?
        var visitedCursors = Set<String>()
        var pageCount = 0
        repeat {
            try Task.checkCancellation()
            pageCount += 1
            guard pageCount <= Self.maximumCursorPages else {
                throw LuxoraAPIError.invalidResponse
            }
            var path = "/v1/chats?limit=100"
            if let cursor, let encodedCursor = Self.encodedQueryValue(cursor) {
                path += "&cursor=\(encodedCursor)"
            }
            let page: APIList<APIChat> = try await request(path: path, token: token)
            guard page.items.allSatisfy({ itemIDs.insert($0.id).inserted }) else {
                throw LuxoraAPIError.invalidResponse
            }
            items.append(contentsOf: page.items)
            cursor = page.nextCursor
            if let cursor, !visitedCursors.insert(cursor).inserted {
                throw LuxoraAPIError.invalidResponse
            }
        } while cursor != nil
        return items
    }

    func messages(chatID: UUID, token: String) async throws -> [APIMessage] {
        var items: [APIMessage] = []
        var itemIDs = Set<UUID>()
        var cursor: String?
        var visitedCursors = Set<String>()
        var pageCount = 0
        repeat {
            try Task.checkCancellation()
            pageCount += 1
            guard pageCount <= Self.maximumCursorPages else {
                throw LuxoraAPIError.invalidResponse
            }
            var path = "/v1/chats/\(chatID.apiPathComponent)/messages?limit=100"
            if let cursor, let encodedCursor = Self.encodedQueryValue(cursor) {
                path += "&cursor=\(encodedCursor)"
            }
            let page: APIList<APIMessage> = try await request(path: path, token: token)
            guard page.items.allSatisfy({ itemIDs.insert($0.id).inserted }) else {
                throw LuxoraAPIError.invalidResponse
            }
            items.append(contentsOf: page.items)
            cursor = page.nextCursor
            if let cursor, !visitedCursors.insert(cursor).inserted {
                throw LuxoraAPIError.invalidResponse
            }
        } while cursor != nil
        return Array(items.reversed())
    }

    func sendMessage(
        chatID: UUID,
        clientNonce: UUID,
        body: String,
        replyToMessageID: UUID? = nil,
        attachmentIDs: [UUID] = [],
        transcriptionConsent: Bool = false,
        token: String
    ) async throws -> APIMessage {
        struct Response: Decodable, Sendable { let message: APIMessage }
        let response: Response = try await requestEncoded(
            path: "/v1/chats/\(chatID.apiPathComponent)/messages",
            method: "POST",
            body: APIChatBody.sendMessage(
                clientNonce: clientNonce,
                body: body,
                replyToMessageID: replyToMessageID,
                attachmentIDs: attachmentIDs,
                transcriptionConsent: transcriptionConsent
            ),
            token: token
        )
        return response.message
    }

    func putMessageTranscript(
        messageID: UUID,
        text: String,
        clientNonce: UUID,
        token: String
    ) async throws -> APIMessage {
        struct Body: Encodable, Sendable {
            let text: String
            let clientNonce: String
        }
        struct Response: Decodable, Sendable { let message: APIMessage }
        let response: Response = try await requestEncoded(
            path: "/v1/messages/\(messageID.apiPathComponent)/transcript",
            method: "PUT",
            body: Body(text: text, clientNonce: clientNonce.apiPathComponent),
            token: token
        )
        return response.message
    }

    func editMessage(
        messageID: UUID,
        body: String,
        expectedRevision: Int?,
        token: String
    ) async throws -> APIMessage {
        struct Response: Decodable, Sendable { let message: APIMessage }
        let response: Response = try await requestEncoded(
            path: "/v1/messages/\(messageID.apiPathComponent)",
            method: "PATCH",
            body: APIChatBody.EditMessage(body: body, expectedRevision: expectedRevision),
            token: token
        )
        return response.message
    }

    func deleteMessage(messageID: UUID, token: String) async throws -> APIMessage {
        struct Response: Decodable, Sendable { let message: APIMessage }
        let response: Response = try await request(
            path: "/v1/messages/\(messageID.apiPathComponent)",
            method: "DELETE",
            token: token
        )
        return response.message
    }

    func forwardMessage(
        messageID: UUID,
        to chatID: UUID,
        clientNonce: UUID,
        token: String
    ) async throws -> APIMessage {
        struct Response: Decodable, Sendable { let message: APIMessage }
        let response: Response = try await request(
            path: "/v1/messages/\(messageID.apiPathComponent)/forward",
            method: "POST",
            body: APIChatBody.forward(chatID: chatID, clientNonce: clientNonce),
            token: token
        )
        return response.message
    }

    func setMessagePinned(
        chatID: UUID,
        messageID: UUID,
        active: Bool,
        token: String
    ) async throws -> Bool {
        let path = "/v1/chats/\(chatID.apiPathComponent)/pins/\(messageID.apiPathComponent)"
        if active {
            struct Response: Decodable, Sendable { let pin: APIMessagePin }
            let _: Response = try await request(path: path, method: "PUT", token: token)
        } else {
            try await requestWithoutResponse(path: path, method: "DELETE", token: token)
        }
        return active
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
        (try await searchUsersPage(query: query, cursor: nil, token: token)).items
    }

    func searchUsersPage(
        query: String,
        cursor: String?,
        limit: Int = 30,
        token: String
    ) async throws -> APIList<APIUser> {
        let path = try Self.searchPath(
            base: "/v1/users/search",
            query: query,
            cursor: cursor,
            limit: limit
        )
        return try await request(path: path, token: token)
    }

    func searchMessagesPage(
        query: String,
        cursor: String?,
        limit: Int = 30,
        token: String
    ) async throws -> APIList<APIMessage> {
        let path = try Self.searchPath(
            base: "/v1/search/messages",
            query: query,
            cursor: cursor,
            limit: limit
        )
        return try await request(path: path, token: token)
    }

    func searchFilesPage(
        query: String,
        cursor: String?,
        limit: Int = 30,
        token: String
    ) async throws -> APIList<APISearchAttachment> {
        let path = try Self.searchPath(
            base: "/v1/search/files",
            query: query,
            cursor: cursor,
            limit: limit
        )
        return try await request(path: path, token: token)
    }

    func lookupUser(username: String, token: String) async throws -> APIPublicProfile? {
        guard let encoded = Self.encodedQueryValue(username) else { return nil }
        struct Response: Decodable, Sendable { let profile: APIPublicProfile? }
        let response: Response = try await request(
            path: "/v1/users/lookup?username=\(encoded)",
            token: token
        )
        return response.profile
    }

    func privacySettings(token: String) async throws -> APIPrivacySettings {
        struct Response: Decodable, Sendable { let settings: APIPrivacySettings }
        let response: Response = try await request(path: "/v1/privacy", token: token)
        return response.settings
    }

    func updatePrivacySettings(
        usernameDiscoverable: Bool? = nil,
        messageRequests: MessageRequestPolicy? = nil,
        token: String
    ) async throws -> APIPrivacySettings {
        struct Response: Decodable, Sendable { let settings: APIPrivacySettings }
        let response: Response = try await requestEncoded(
            path: "/v1/privacy",
            method: "PATCH",
            body: APIIdentityBody.PrivacyPatch(
                usernameDiscoverable: usernameDiscoverable,
                messageRequests: messageRequests
            ),
            token: token
        )
        return response.settings
    }

    func messageRequests(
        direction: MessageRequestDirection,
        cursor: String? = nil,
        limit: Int = 100,
        token: String
    ) async throws -> APIList<APIMessageRequest> {
        var path = "/v1/message-requests?direction=\(direction.rawValue)&limit=\(min(max(limit, 1), 100))"
        if let cursor, let encodedCursor = Self.encodedQueryValue(cursor) {
            path += "&cursor=\(encodedCursor)"
        }
        return try await request(path: path, token: token)
    }

    func allMessageRequests(
        direction: MessageRequestDirection,
        token: String
    ) async throws -> [APIMessageRequest] {
        var items: [APIMessageRequest] = []
        var cursor: String?
        var visitedCursors = Set<String>()
        repeat {
            let page = try await messageRequests(
                direction: direction,
                cursor: cursor,
                limit: 100,
                token: token
            )
            items.append(contentsOf: page.items)
            cursor = page.nextCursor
            if let cursor, !visitedCursors.insert(cursor).inserted {
                throw LuxoraAPIError.invalidResponse
            }
        } while cursor != nil
        return items
    }

    func createMessageRequest(
        recipientUserID: UUID,
        body: String,
        clientNonce: UUID,
        token: String
    ) async throws -> APIMessageRequest {
        struct Response: Decodable, Sendable { let request: APIMessageRequest }
        let response: Response = try await requestEncoded(
            path: "/v1/message-requests",
            method: "POST",
            body: APIIdentityBody.CreateMessageRequest(
                recipientUserId: recipientUserID.apiPathComponent,
                body: body,
                clientNonce: clientNonce.apiPathComponent
            ),
            token: token
        )
        return response.request
    }

    func acceptMessageRequest(id: UUID, token: String) async throws -> APIAcceptMessageRequestResponse {
        try await request(
            path: "/v1/message-requests/\(id.apiPathComponent)/accept",
            method: "POST",
            token: token
        )
    }

    func dismissMessageRequest(id: UUID, token: String) async throws {
        try await requestWithoutResponse(
            path: "/v1/message-requests/\(id.apiPathComponent)",
            method: "DELETE",
            token: token
        )
    }

    func request<Response: Decodable & Sendable>(
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
        guard let http = response as? HTTPURLResponse,
              Self.sameOrigin(http.url, configuration.apiBaseURL)
        else { throw LuxoraAPIError.invalidResponse }
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

    func requestEncoded<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        path: String,
        method: String,
        body: Body,
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
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse,
              Self.sameOrigin(http.url, configuration.apiBaseURL)
        else { throw LuxoraAPIError.invalidResponse }
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

    /// Draft requests use an isolated error boundary so hostile server text is
    /// never retained by errors surfaced to the composer or diagnostics.
    func requestChatDraft<Response: Decodable & Sendable>(
        path: String,
        token: String
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL) else {
            throw LuxoraAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await performChatDraftRequest(request, recognizesRateLimit: false)
    }

    /// Chat draft mutations retain scoped 429 metadata so the in-memory draft
    /// store can retry the same nonce after a bounded server-directed delay.
    /// Every other server rejection is reduced to status plus a known-safe
    /// code; neither response text nor request body/token material survives.
    func requestChatDraftMutation<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        path: String,
        method: String,
        body: Body,
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
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        return try await performChatDraftRequest(request, recognizesRateLimit: true)
    }

    private func performChatDraftRequest<Response: Decodable & Sendable>(
        _ request: URLRequest,
        recognizesRateLimit: Bool
    ) async throws -> Response {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse,
              Self.sameOrigin(http.url, configuration.apiBaseURL)
        else { throw LuxoraAPIError.invalidResponse }
        guard 200..<300 ~= http.statusCode else {
            let envelope = try? decoder.decode(APIChatDraftErrorEnvelope.self, from: data)
            if recognizesRateLimit, http.statusCode == 429 {
                throw ChatDraftRateLimitError(
                    headerValue: http.value(forHTTPHeaderField: "Retry-After"),
                    detailValue: envelope?.error.details?.retryAfterSeconds
                )
            }
            throw Self.sanitizedChatDraftServerError(
                status: http.statusCode,
                proposedCode: envelope?.error.code
            )
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
    }

    private static func sanitizedChatDraftServerError(
        status: Int,
        proposedCode: String?
    ) -> LuxoraAPIError {
        let safeCode: String
        switch proposedCode {
        case "BAD_REQUEST",
             "UNAUTHENTICATED",
             "FORBIDDEN",
             "NOT_FOUND",
             "CONFLICT",
             "RATE_LIMITED",
             "VALIDATION_FAILED",
             "INTERNAL_ERROR",
             "SERVICE_UNAVAILABLE":
            safeCode = proposedCode ?? "HTTP_\(status)"
        default:
            safeCode = "HTTP_\(status)"
        }
        return LuxoraAPIError.server(
            status: status,
            code: safeCode,
            message: LuxoraL10n.text("error.server_request_failed")
        )
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
        guard let http = response as? HTTPURLResponse,
              Self.sameOrigin(http.url, configuration.apiBaseURL)
        else { throw LuxoraAPIError.invalidResponse }
        guard 200..<300 ~= http.statusCode else {
            let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data)
            throw LuxoraAPIError.server(
                status: http.statusCode,
                code: envelope?.error.code ?? "HTTP_\(http.statusCode)",
                message: envelope?.error.message ?? LuxoraL10n.text("error.server_request_failed")
            )
        }
    }

    private func requestRaw(
        path: String,
        method: String,
        body: Data? = nil,
        accept: String,
        contentType: String? = nil,
        headers: [String: String] = [:],
        token: String
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL)?.absoluteURL else {
            throw LuxoraAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue(accept, forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
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
        else { throw LuxoraAPIError.invalidResponse }
        guard 200..<300 ~= http.statusCode else {
            let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data)
            throw LuxoraAPIError.server(
                status: http.statusCode,
                code: envelope?.error.code ?? "HTTP_\(http.statusCode)",
                message: envelope?.error.message ?? LuxoraL10n.text("error.server_request_failed")
            )
        }
        return (data, http)
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

    private static func sameOrigin(_ candidate: URL?, _ configuredBase: URL) -> Bool {
        guard let candidate else { return false }
        return candidate.scheme?.lowercased() == configuredBase.scheme?.lowercased()
            && candidate.host?.lowercased() == configuredBase.host?.lowercased()
            && candidate.port == configuredBase.port
    }

    private static func validatePushRegistration(_ registration: APIPushRegistration) throws {
        guard registration.platform == "apns",
              registration.topic == "app.luxora.mobile"
        else { throw LuxoraAPIError.invalidResponse }
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

    private static func searchPath(
        base: String,
        query: String,
        cursor: String?,
        limit: Int
    ) throws -> String {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              (1...100).contains(limit),
              let encodedQuery = encodedQueryValue(normalized)
        else { throw LuxoraAPIError.invalidResponse }

        var path = "\(base)?q=\(encodedQuery)&limit=\(limit)"
        if let cursor {
            guard !cursor.isEmpty, let encodedCursor = encodedQueryValue(cursor) else {
                throw LuxoraAPIError.invalidResponse
            }
            path += "&cursor=\(encodedCursor)"
        }
        return path
    }
}

struct APISendMessageBody: Encodable, Sendable {
    let kind: String?
    let body: String?
    let clientNonce: UUID
    let replyToMessageID: UUID?
    let attachmentIds: [UUID]?
    let transcriptionConsent: Bool?

    private enum CodingKeys: String, CodingKey {
        case kind
        case body
        case clientNonce
        case replyToMessageID = "replyToMessageId"
        case attachmentIds
        case transcriptionConsent
    }

    func encode(to encoder: Encoder) throws {
        // Server-owned UUIDs use the canonical lowercase representation.
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(kind, forKey: .kind)
        try container.encodeIfPresent(body, forKey: .body)
        try container.encode(clientNonce.apiPathComponent, forKey: .clientNonce)
        if let replyToMessageID {
            try container.encode(replyToMessageID.apiPathComponent, forKey: .replyToMessageID)
        }
        if let attachmentIds, !attachmentIds.isEmpty {
            try container.encode(attachmentIds.map { $0.apiPathComponent }, forKey: .attachmentIds)
        }
        try container.encodeIfPresent(transcriptionConsent, forKey: .transcriptionConsent)
    }
}

struct APIAttachmentCreateBody: Encodable, Sendable {
    let kind: String
    let fileName: String
    let mimeType: String
    let sizeBytes: Int
    let sha256: String
    let idempotencyKey: String
    let metadata: APIMediaDimensions
}

struct APIMediaDimensions: Encodable, Sendable {
    let width: Int?
    let height: Int?
    let durationMs: Int?
    let waveform: [Int]?
}

enum APIChatBody {
    static func createDirect(userID: UUID) -> [String: String] {
        [
            "kind": "direct",
            "userId": userID.apiPathComponent,
        ]
    }

    static func sendMessage(
        clientNonce: UUID,
        body: String,
        replyToMessageID: UUID?,
        attachmentIDs: [UUID],
        transcriptionConsent: Bool = false
    ) -> APISendMessageBody {
        APISendMessageBody(
            kind: body.isEmpty ? nil : "text",
            body: body.isEmpty ? nil : body,
            clientNonce: clientNonce,
            replyToMessageID: replyToMessageID,
            attachmentIds: attachmentIDs.isEmpty ? nil : attachmentIDs,
            transcriptionConsent: transcriptionConsent ? true : nil
        )
    }

    struct EditMessage: Encodable, Sendable {
        let body: String
        let expectedRevision: Int?
    }

    static func forward(chatID: UUID, clientNonce: UUID) -> [String: String] {
        [
            "chatId": chatID.apiPathComponent,
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

    static func password(
        passwordToken: String,
        password: String,
        deviceName: String,
        clientNonce: UUID
    ) -> [String: String] {
        [
            "passwordToken": passwordToken,
            "password": password,
            "deviceName": deviceName,
            "clientNonce": clientNonce.apiPathComponent,
        ]
    }

    static func recoveryStart(
        passwordToken: String,
        clientNonce: UUID
    ) -> [String: String] {
        [
            "passwordToken": passwordToken,
            "clientNonce": clientNonce.apiPathComponent,
        ]
    }

    static func recoveryComplete(
        recoveryToken: String,
        newPassword: String,
        deviceName: String,
        clientNonce: UUID
    ) -> [String: String] {
        [
            "recoveryToken": recoveryToken,
            "password": newPassword,
            "deviceName": deviceName,
            "clientNonce": clientNonce.apiPathComponent,
        ]
    }

    static func bindingBegin(
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

    static func bindingComplete(
        bindingToken: String,
        clientNonce: UUID
    ) -> [String: String] {
        [
            "bindingToken": bindingToken,
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

enum APIPhonePasswordSettingsBody {
    struct Configure: Encodable, Sendable {
        let password: String
        let currentPassword: String?
    }

    struct Disable: Encodable, Sendable {
        let currentPassword: String
    }
}

enum APIProfileBody {
    static func update(displayName: String, bio: String) -> [String: String] {
        [
            "displayName": displayName,
            "bio": bio,
        ]
    }
}

enum APIAvatarUploadContract {
    struct Metadata: Encodable, Sendable {
        let width: Int
        let height: Int
    }

    struct CreateUpload: Encodable, Sendable {
        let kind: String
        let fileName: String
        let mimeType: String
        let sizeBytes: Int
        let sha256: String
        let idempotencyKey: String
        let metadata: Metadata
    }

    struct BindAvatar: Encodable, Sendable {
        let attachmentId: String
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func idempotencyKey(for data: Data) -> UUID {
        var bytes = Array(SHA256.hash(data: data).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x40
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    static func validatedAvatarPath(_ path: String) throws -> String {
        guard !path.contains("?"), !path.contains("#") else {
            throw LuxoraAPIError.invalidResponse
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: true)
        guard components.count == 4,
              components[0] == "v1",
              components[1] == "attachments",
              UUID(uuidString: String(components[2])) != nil,
              components[3] == "content",
              path.first == "/"
        else { throw LuxoraAPIError.invalidResponse }
        return path
    }
}

enum APIIdentityBody {
    struct PrivacyPatch: Encodable, Sendable {
        let usernameDiscoverable: Bool?
        let messageRequests: MessageRequestPolicy?
    }

    struct CreateMessageRequest: Encodable, Sendable {
        let recipientUserId: String
        let body: String
        let clientNonce: String
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
