import XCTest
@testable import LuxoraKit
import LuxoraDesignFixtures

/// Guards of `MessengerStore.transcribeMessage`: the client never sends a
/// transcript without server-granted consent, never resubmits over an
/// existing transcript and never sends blank text. The server remains the
/// source of truth (first writer wins, voice/audio-only); these tests only
/// pin the local fail-closed behaviour.
@MainActor
final class VoiceTranscriptStoreTests: XCTestCase {
    func testTranscribeFailsClosedWithoutServerConsent() async throws {
        let fixture = LuxoraDesignFixtures.makeStore()
        let conversationID = try XCTUnwrap(fixture.selectedConversationID)
        var message = try XCTUnwrap(fixture.selectedMessages.first)
        message.transcriptionAllowed = false
        message.transcript = nil
        let store = MessengerStore(
            conversations: fixture.conversations,
            messagesByConversation: [conversationID: [message]],
            currentUser: fixture.currentUser,
            selectedConversationID: conversationID,
            loadedConversationIDs: [conversationID]
        )
        let probe = TranscriptPutProbe()
        configure(store, probe: probe)

        let applied = await store.transcribeMessage(message.id, text: "Расшифровка")

        XCTAssertFalse(applied)
        let putCalls = await probe.calls
        XCTAssertEqual(putCalls.count, 0)
    }

    func testTranscribeFailsClosedWhenTranscriptAlreadyExists() async throws {
        let fixture = LuxoraDesignFixtures.makeStore()
        let conversationID = try XCTUnwrap(fixture.selectedConversationID)
        var message = try XCTUnwrap(fixture.selectedMessages.first)
        message.transcriptionAllowed = true
        message.transcript = "Уже есть"
        let store = MessengerStore(
            conversations: fixture.conversations,
            messagesByConversation: [conversationID: [message]],
            currentUser: fixture.currentUser,
            selectedConversationID: conversationID,
            loadedConversationIDs: [conversationID]
        )
        let probe = TranscriptPutProbe()
        configure(store, probe: probe)

        let applied = await store.transcribeMessage(message.id, text: "Повторная")

        XCTAssertFalse(applied)
        let putCalls = await probe.calls
        XCTAssertEqual(putCalls.count, 0)
    }

    func testTranscribeRejectsBlankText() async throws {
        let fixture = LuxoraDesignFixtures.makeStore()
        let conversationID = try XCTUnwrap(fixture.selectedConversationID)
        var message = try XCTUnwrap(fixture.selectedMessages.first)
        message.transcriptionAllowed = true
        message.transcript = nil
        let store = MessengerStore(
            conversations: fixture.conversations,
            messagesByConversation: [conversationID: [message]],
            currentUser: fixture.currentUser,
            selectedConversationID: conversationID,
            loadedConversationIDs: [conversationID]
        )
        let probe = TranscriptPutProbe()
        configure(store, probe: probe)

        let applied = await store.transcribeMessage(message.id, text: "   \n ")

        XCTAssertFalse(applied)
        let putCalls = await probe.calls
        XCTAssertEqual(putCalls.count, 0)
    }

    func testTranscribeSuccessStoresServerTranscript() async throws {
        let fixture = LuxoraDesignFixtures.makeStore()
        let conversationID = try XCTUnwrap(fixture.selectedConversationID)
        var message = try XCTUnwrap(fixture.selectedMessages.first)
        message.transcriptionAllowed = true
        message.transcript = nil
        let store = MessengerStore(
            conversations: fixture.conversations,
            messagesByConversation: [conversationID: [message]],
            currentUser: fixture.currentUser,
            selectedConversationID: conversationID,
            loadedConversationIDs: [conversationID]
        )
        let probe = TranscriptPutProbe()
        var confirmed = message
        confirmed.transcript = "Текст расшифровки"
        await probe.setResult(confirmed)
        configure(store, probe: probe)

        let applied = await store.transcribeMessage(message.id, text: "Текст расшифровки")

        XCTAssertTrue(applied)
        let putCalls = await probe.calls
        XCTAssertEqual(putCalls.count, 1)
        XCTAssertEqual(store.messagesByConversation[conversationID]?.first?.transcript, "Текст расшифровки")
    }

    private func configure(_ store: MessengerStore, probe: TranscriptPutProbe) {
        let currentUser = store.currentUser
        let initialMessages = store.messagesByConversation
        store.configureRemote(
            sender: { conversationID, nonce, body in
                ChatMessage(
                    id: UUID(), clientID: nonce, conversationID: conversationID,
                    author: currentUser, text: body, sentAt: .now,
                    delivery: .sent, isOutgoing: true
                )
            },
            transcriptPutter: { messageID, text in
                try await probe.put(messageID: messageID, text: text)
            },
            loader: { conversationID in initialMessages[conversationID, default: []] }
        )
    }
}

private actor TranscriptPutProbe {
    private(set) var calls: [(messageID: UUID, text: String)] = []
    private var result: ChatMessage?

    func setResult(_ message: ChatMessage) {
        result = message
    }

    func put(messageID: UUID, text: String) throws -> ChatMessage {
        calls.append((messageID: messageID, text: text))
        guard let result else { throw TranscriptPutTestError.noResult }
        return result
    }
}

private enum TranscriptPutTestError: Error {
    case noResult
}
