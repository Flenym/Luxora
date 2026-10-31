import Foundation

/// Call control over the REST API (services/api routes under /v1/calls).
///
/// Errors are reduced to status plus a known-safe code, the same policy as the
/// chat-draft client: response bodies, tokens and media material never leave
/// this layer.
struct APICallParticipant: Decodable, Equatable, Sendable {
    let membershipId: UUID
    let memberId: UUID
    let role: String
    let status: String
    /// Server time this participant accepted the call. Nil until the invitee
    /// accepts; used only to derive an answered duration, never invented.
    let acceptedAtMs: Int?
}

struct APICall: Decodable, Equatable, Sendable {
    let callId: UUID
    let chatId: UUID
    let kind: String
    let mediaMode: String
    let state: CallStateValue
    let revision: Int
    let epoch: Int
    let creatorMemberId: UUID
    let participants: [APICallParticipant]
    let endReason: String?
    /// Server timestamps of the call record. They come from the projected
    /// call response, so relative labels and durations are always derived from
    /// server truth instead of a client clock guess.
    let createdAtMs: Int
    let updatedAtMs: Int
    let endedAtMs: Int?
}

struct APICallEnvelope: Decodable, Sendable {
    let call: APICall
}

struct APICallListEnvelope: Decodable, Sendable {
    let calls: [APICall]
}

/// Media join material. The LiveKit token and TURN credential are secrets: they
/// are used once to join the room and are never logged or persisted.
struct APIJoinGrant: Decodable, Sendable {
    let serverUrl: String
    let token: String
    let tokenExpiresAtMs: Int
    let participantIdentity: String
}

private struct CallCreateBody: Encodable, Sendable {
    let chatId: String
    let mediaMode: String
    let clientNonce: String
}

private struct CallRevisionBody: Encodable, Sendable {
    let expectedRevision: Int
}

private struct CallHangupBody: Encodable, Sendable {
    let expectedRevision: Int
    let scope: String
}

private struct CallDeclineBody: Encodable, Sendable {
    let expectedRevision: Int
    let reason: String
}

private struct CallJoinGrantBody: Encodable, Sendable {
    let requestedSources: [String]
}

private struct CallErrorEnvelope: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        let code: String
    }

    let error: Payload
}

extension LuxoraAPIClient {
    func createCall(chatID: UUID, mediaMode: String, clientNonce: UUID, token: String) async throws -> APICall {
        let response: APICallEnvelope = try await callRequest(
            path: "/v1/calls",
            method: "POST",
            body: CallCreateBody(
                chatId: chatID.uuidString.lowercased(),
                mediaMode: mediaMode,
                clientNonce: clientNonce.uuidString.lowercased()
            ),
            token: token
        )
        return response.call
    }

    func listCalls(chatID: UUID, token: String) async throws -> [APICall] {
        let response: APICallListEnvelope = try await callRequest(
            path: "/v1/calls?chatId=\(chatID.uuidString.lowercased())",
            method: "GET",
            body: Optional<CallRevisionBody>.none,
            token: token
        )
        return response.calls
    }

    func getCall(callID: UUID, token: String) async throws -> APICall {
        let response: APICallEnvelope = try await callRequest(
            path: "/v1/calls/\(callID.uuidString.lowercased())",
            method: "GET",
            body: Optional<CallRevisionBody>.none,
            token: token
        )
        return response.call
    }

    func ringCall(callID: UUID, expectedRevision: Int, token: String) async throws -> APICall {
        try await callAction(callID: callID, action: "ring", body: CallRevisionBody(expectedRevision: expectedRevision), token: token)
    }

    func acceptCall(callID: UUID, expectedRevision: Int, token: String) async throws -> APICall {
        try await callAction(callID: callID, action: "accept", body: CallRevisionBody(expectedRevision: expectedRevision), token: token)
    }

    func declineCall(callID: UUID, expectedRevision: Int, token: String) async throws -> APICall {
        try await callAction(
            callID: callID,
            action: "decline",
            body: CallDeclineBody(expectedRevision: expectedRevision, reason: "declined"),
            token: token
        )
    }

    func hangupCall(callID: UUID, expectedRevision: Int, token: String) async throws -> APICall {
        try await callAction(
            callID: callID,
            action: "hangup",
            body: CallHangupBody(expectedRevision: expectedRevision, scope: "self"),
            token: token
        )
    }

    func joinGrant(callID: UUID, requestedSources: [String], token: String) async throws -> APIJoinGrant {
        try await callRequest(
            path: "/v1/calls/\(callID.uuidString.lowercased())/join-grant",
            method: "POST",
            body: CallJoinGrantBody(requestedSources: requestedSources),
            token: token
        )
    }

    private func callAction<Body: Encodable & Sendable>(
        callID: UUID,
        action: String,
        body: Body,
        token: String
    ) async throws -> APICall {
        let response: APICallEnvelope = try await callRequest(
            path: "/v1/calls/\(callID.uuidString.lowercased())/\(action)",
            method: "POST",
            body: body,
            token: token
        )
        return response.call
    }

    private func callRequest<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        path: String,
        method: String,
        body: Body?,
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
            let envelope = try? decoder.decode(CallErrorEnvelope.self, from: data)
            throw Self.sanitizedCallError(status: http.statusCode, proposedCode: envelope?.error.code)
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw LuxoraAPIError.invalidResponse
        }
    }

    private static func sanitizedCallError(status: Int, proposedCode: String?) -> LuxoraAPIError {
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
}
