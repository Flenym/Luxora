import XCTest
@testable import LuxoraKit

@MainActor
final class CallsStoreTests: XCTestCase {
    private let me = UUID()
    private let peer = UUID()
    private let callID = UUID()
    private let chatID = UUID()

    private func makeStore() -> CallsStore {
        CallsStore(
            api: LuxoraAPIClient(
                configuration: LuxoraClientConfiguration(
                    apiBaseURL: URL(string: "https://calls-store.invalid")!,
                    realtimeURL: URL(string: "wss://calls-store.invalid/v1/realtime")!
                )
            ),
            accountID: me,
            tokenProvider: { "token" }
        )
    }

    private func call(
        state: CallStateValue,
        creator: UUID,
        myStatus: String,
        revision: Int = 1
    ) -> APICall {
        APICall(
            callId: callID,
            chatId: chatID,
            kind: "one_to_one",
            mediaMode: "audio",
            state: state,
            revision: revision,
            epoch: 1,
            creatorMemberId: creator,
            participants: [
                APICallParticipant(membershipId: UUID(), memberId: creator, role: "host", status: "accepted"),
                APICallParticipant(membershipId: UUID(), memberId: me, role: "member", status: myStatus),
            ],
            endReason: nil
        )
    }

    func testInvitedCalleeSeesIncomingCall() {
        let store = makeStore()
        store.apply(call(state: .ringing, creator: peer, myStatus: "ringing"))

        XCTAssertEqual(store.incomingCall?.callId, callID)
        XCTAssertEqual(store.activeCall?.callId, callID)
    }

    func testCreatorNeverSeesOwnCallAsIncoming() {
        let store = makeStore()
        store.apply(call(state: .ringing, creator: me, myStatus: "accepted"))

        XCTAssertNil(store.incomingCall)
        XCTAssertEqual(store.activeCall?.callId, callID)
    }

    func testEndedCallClearsActiveAndIncoming() {
        let store = makeStore()
        store.apply(call(state: .ringing, creator: peer, myStatus: "ringing"))
        store.apply(call(state: .ended, creator: peer, myStatus: "left", revision: 3))

        XCTAssertNil(store.incomingCall)
        XCTAssertNil(store.activeCall)
        XCTAssertEqual(store.mediaState, .idle)
    }

    func testAcceptedCalleeIsNotIncomingAnymore() {
        let store = makeStore()
        store.apply(call(state: .ringing, creator: peer, myStatus: "ringing"))
        store.apply(call(state: .connecting, creator: peer, myStatus: "accepted", revision: 2))

        XCTAssertNil(store.incomingCall)
        XCTAssertEqual(store.activeCall?.state, .connecting)
    }
}

final class CallRealtimeDecoderTests: XCTestCase {
    private let callID = UUID()
    private let chatID = UUID()

    private func frame(eventKeys: Set<String>? = nil, state: String = "ringing") -> Data {
        let event: [String: Any] = [
            "type": "call.state.changed",
            "callId": callID.uuidString.lowercased(),
            "chatId": chatID.uuidString.lowercased(),
            "state": state,
            "revision": 2,
            "occurredAt": "2026-10-10T10:00:00.000Z",
        ]
        let filtered = eventKeys.map { keys in event.filter { keys.contains($0.key) } } ?? event
        let object: [String: Any] = [
            "type": "dispatch",
            "sequence": 7,
            "cursor": "luxora-rt1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "event": filtered,
        ]
        return try! JSONSerialization.data(withJSONObject: object)
    }

    func testDecodesCallStateChange() throws {
        let decoded = try XCTUnwrap(CallRealtimeFrameDecoder.decode(frame()))

        XCTAssertEqual(decoded.callID, callID)
        XCTAssertEqual(decoded.chatID, chatID)
        XCTAssertEqual(decoded.state, .ringing)
        XCTAssertEqual(decoded.revision, 2)
        XCTAssertEqual(decoded.sequence, 7)
    }

    func testIgnoresOtherEventTypes() throws {
        let other = try JSONSerialization.data(withJSONObject: [
            "type": "dispatch",
            "sequence": 1,
            "cursor": "luxora-rt1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "event": ["type": "message.created"],
        ])
        XCTAssertNil(try CallRealtimeFrameDecoder.decode(other))
    }

    func testRejectsUnexpectedEventFields() {
        // A media-bearing field must never be accepted into the call model.
        let leaking = frame(eventKeys: nil)
        var object = try! JSONSerialization.jsonObject(with: leaking) as! [String: Any]
        var event = object["event"] as! [String: Any]
        event["roomName"] = "room-abc"
        object["event"] = event
        let data = try! JSONSerialization.data(withJSONObject: object)

        XCTAssertThrowsError(try CallRealtimeFrameDecoder.decode(data))
    }
}
