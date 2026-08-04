import Foundation
import XCTest
@testable import LuxoraKit

final class LiveBackendIntegrationTests: XCTestCase {
    func testRegistrationSessionChatListAndRealtimeHandshake() async throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_TEST=1 while the local API is running")
        }

        let configuration = LuxoraClientConfiguration.development
        let api = LuxoraAPIClient(configuration: configuration)
        let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
        let username = "swift_\(suffix)"

        let authentication = try await api.register(
            username: username,
            displayName: "Swift Integration",
            password: "LuxoraIntegration!2026",
            deviceName: "Swift test"
        )

        let currentUser = try await api.currentUser(token: authentication.tokens.accessToken)
        let chats = try await api.chats(token: authentication.tokens.accessToken)

        XCTAssertEqual(currentUser.username, username)
        XCTAssertEqual(currentUser.id, authentication.user.id)
        XCTAssertTrue(chats.isEmpty)

        let savedChat = try await api.createDirectChat(
            userID: currentUser.id,
            token: authentication.tokens.accessToken
        )
        let sent = try await api.sendMessage(
            chatID: savedChat.id,
            clientNonce: .clientNonceV4(),
            body: "Live Swift chat contract",
            token: authentication.tokens.accessToken
        )
        let messages = try await api.messages(
            chatID: savedChat.id,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(messages.map(\.id), [sent.id])
        XCTAssertEqual(messages.first?.body, "Live Swift chat contract")

        try await api.markRead(
            chatID: savedChat.id,
            messageID: sent.id,
            token: authentication.tokens.accessToken
        )
        let activeReactions = try await api.setReaction(
            messageID: sent.id,
            emoji: "🔥",
            active: true,
            token: authentication.tokens.accessToken
        )
        XCTAssertEqual(activeReactions.first?.emoji, "🔥")
        XCTAssertEqual(activeReactions.first?.count, 1)
        XCTAssertEqual(activeReactions.first?.reactedByMe, true)
        let clearedReactions = try await api.setReaction(
            messageID: sent.id,
            emoji: "🔥",
            active: false,
            token: authentication.tokens.accessToken
        )
        XCTAssertTrue(clearedReactions.isEmpty)

        let refreshedChats = try await api.chats(token: authentication.tokens.accessToken)
        XCTAssertEqual(refreshedChats.map(\.id), [savedChat.id])

        let realtime = LuxoraRealtimeClient(configuration: configuration)
        let ready = expectation(description: "Realtime ready")
        let task = Task {
            for try await signal in realtime.signals(token: authentication.tokens.accessToken, resumeFrom: nil) {
                if case .ready = signal {
                    ready.fulfill()
                    return
                }
            }
        }
        await fulfillment(of: [ready], timeout: 5)
        task.cancel()
        try await api.revokeCurrentSession(token: authentication.tokens.accessToken)
    }
}
