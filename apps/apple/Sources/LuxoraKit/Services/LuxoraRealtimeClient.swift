import Foundation

enum RealtimeSignal: Sendable {
    case ready(sequence: Int)
    case message(APIMessage, sequence: Int)
    case cursor(sequence: Int)
    case typing(conversationID: UUID, isTyping: Bool)
    case syncRequired
}

final class LuxoraRealtimeClient: @unchecked Sendable {
    private let configuration: LuxoraClientConfiguration
    private let session: URLSession

    init(configuration: LuxoraClientConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func signals(token: String, resumeFrom: Int?) -> AsyncThrowingStream<RealtimeSignal, Error> {
        let socket = session.webSocketTask(with: configuration.realtimeURL)
        socket.resume()

        return AsyncThrowingStream { continuation in
            let worker = Task {
                do {
                    var authentication: [String: Any] = [
                        "type": "authenticate",
                        "accessToken": token,
                    ]
                    if let resumeFrom { authentication["resumeFrom"] = resumeFrom }
                    let authenticationData = try JSONSerialization.data(withJSONObject: authentication)
                    guard let authenticationText = String(data: authenticationData, encoding: .utf8) else {
                        throw LuxoraAPIError.invalidResponse
                    }
                    try await socket.send(.string(authenticationText))

                    while !Task.isCancelled {
                        let frame = try await socket.receive()
                        let data: Data
                        switch frame {
                        case let .data(value): data = value
                        case let .string(value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        if let signal = try RealtimeFrameDecoder.decode(data) {
                            continuation.yield(signal)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                worker.cancel()
                socket.cancel(with: .goingAway, reason: nil)
            }
        }
    }
}

enum RealtimeFrameDecoder {
    private struct Header: Decodable { let type: String }
    private struct Ready: Decodable { let sequence: Int }
    private struct Typing: Decodable {
        let chatId: UUID
        let isTyping: Bool
    }
    private struct Dispatch: Decodable {
        let sequence: Int
        let event: Event
    }
    private enum Event: Decodable {
        case message(APIMessage)
        case ignored

        private enum CodingKeys: String, CodingKey {
            case type
            case message
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let type = try container.decode(String.self, forKey: .type)
            switch type {
            case "message.created", "message.updated", "message.deleted":
                self = .message(try container.decode(APIMessage.self, forKey: .message))
            default:
                self = .ignored
            }
        }
    }

    static func decode(_ data: Data) throws -> RealtimeSignal? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        switch try decoder.decode(Header.self, from: data).type {
        case "ready":
            return .ready(sequence: try decoder.decode(Ready.self, from: data).sequence)
        case "dispatch":
            let dispatch = try decoder.decode(Dispatch.self, from: data)
            if case let .message(message) = dispatch.event {
                return .message(message, sequence: dispatch.sequence)
            }
            // Every durable dispatch advances the resume cursor, including event
            // kinds this thin harness does not render yet.
            return .cursor(sequence: dispatch.sequence)
        case "typing.updated":
            let typing = try decoder.decode(Typing.self, from: data)
            return .typing(conversationID: typing.chatId, isTyping: typing.isTyping)
        case "sync.required":
            return .syncRequired
        default:
            return nil
        }
    }
}
