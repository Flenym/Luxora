import Foundation
@testable import LuxoraKit
import XCTest

// MARK: - Fixtures

enum CallFixture {
    static func participant(
        memberID: UUID,
        role: String = "member",
        status: String,
        acceptedAtMs: Int? = nil
    ) -> APICallParticipant {
        APICallParticipant(
            membershipId: UUID(),
            memberId: memberID,
            role: role,
            status: status,
            acceptedAtMs: acceptedAtMs
        )
    }

    static func call(
        creatorMemberID: UUID,
        participants: [APICallParticipant],
        state: CallStateValue,
        endReason: String? = nil,
        createdAtMs: Int = 1_700_000_000_000,
        updatedAtMs: Int = 1_700_000_100_000,
        endedAtMs: Int? = nil,
        callID: UUID = UUID(),
        chatID: UUID = UUID(),
        revision: Int = 2
    ) -> APICall {
        APICall(
            callId: callID,
            chatId: chatID,
            kind: "one_to_one",
            mediaMode: "audio",
            state: state,
            revision: revision,
            epoch: 1,
            creatorMemberId: creatorMemberID,
            participants: participants,
            endReason: endReason,
            createdAtMs: createdAtMs,
            updatedAtMs: updatedAtMs,
            endedAtMs: endedAtMs
        )
    }
}

// MARK: - Pure derivation matrix

final class CallHistoryDerivationTests: XCTestCase {
    private let me = UUID(uuidString: "AAAAAAAA-0000-4000-8000-000000000001")!
    private let peer = UUID(uuidString: "BBBBBBBB-0000-4000-8000-000000000002")!

    private func incoming(
        state: CallStateValue = .ended,
        myStatus: String = "ringing",
        myAcceptedAtMs: Int? = nil,
        peerStatus: String = "ringing",
        peerAcceptedAtMs: Int? = nil,
        endReason: String? = nil,
        updatedAtMs: Int = 1_700_000_100_000,
        endedAtMs: Int? = nil
    ) -> APICall {
        CallFixture.call(
            creatorMemberID: peer,
            participants: [
                CallFixture.participant(
                    memberID: peer,
                    role: "host",
                    status: peerStatus,
                    acceptedAtMs: peerAcceptedAtMs
                ),
                CallFixture.participant(
                    memberID: me,
                    status: myStatus,
                    acceptedAtMs: myAcceptedAtMs
                ),
            ],
            state: state,
            endReason: endReason,
            updatedAtMs: updatedAtMs,
            endedAtMs: endedAtMs
        )
    }

    private func outgoing(
        state: CallStateValue = .ended,
        myStatus: String = "left",
        myAcceptedAtMs: Int? = nil,
        peerStatus: String = "left",
        peerAcceptedAtMs: Int? = nil,
        endReason: String? = nil,
        createdAtMs: Int = 1_700_000_000_000,
        updatedAtMs: Int = 1_700_000_100_000,
        endedAtMs: Int? = nil
    ) -> APICall {
        CallFixture.call(
            creatorMemberID: me,
            participants: [
                CallFixture.participant(
                    memberID: me,
                    role: "host",
                    status: myStatus,
                    acceptedAtMs: myAcceptedAtMs
                ),
                CallFixture.participant(
                    memberID: peer,
                    status: peerStatus,
                    acceptedAtMs: peerAcceptedAtMs
                ),
            ],
            state: state,
            endReason: endReason,
            createdAtMs: createdAtMs,
            updatedAtMs: updatedAtMs,
            endedAtMs: endedAtMs
        )
    }

    func testDirectionComesOnlyFromCreatorMemberID() {
        XCTAssertEqual(
            CallHistoryDerivation.direction(of: outgoing(state: .ringing), accountID: me),
            .outgoing
        )
        XCTAssertEqual(
            CallHistoryDerivation.direction(of: incoming(state: .ringing), accountID: me),
            .incoming
        )
    }

    func testMissedMatrix() {
        XCTAssertEqual(
            CallHistoryDerivation.missedEndReasons,
            Set([
                "no-answer",
                "cancelled",
                "busy",
                "declined",
                "membership-revoked",
                "network-timeout",
                "server-failure",
            ])
        )

        for reason in [
            "no-answer",
            "cancelled",
            "busy",
            "declined",
            "membership-revoked",
            "network-timeout",
            "server-failure",
        ] {
            XCTAssertTrue(
                CallHistoryDerivation.isMissed(
                    incoming(endReason: reason, endedAtMs: 1_700_000_050_000),
                    accountID: me
                ),
                "incoming unanswered \(reason) must count as missed"
            )
        }

        // I declined it myself: the row says "declined", not "missed".
        XCTAssertFalse(
            CallHistoryDerivation.isMissed(
                incoming(myStatus: "declined", endReason: "declined", endedAtMs: 1_700_000_050_000),
                accountID: me
            )
        )
        // I answered and the call later completed: never missed.
        XCTAssertFalse(
            CallHistoryDerivation.isMissed(
                incoming(
                    myStatus: "left",
                    myAcceptedAtMs: 1_700_000_020_000,
                    endReason: "completed",
                    endedAtMs: 1_700_000_060_000
                ),
                accountID: me
            )
        )
        XCTAssertFalse(
            CallHistoryDerivation.isMissed(
                incoming(endReason: "completed", endedAtMs: 1_700_000_060_000),
                accountID: me
            )
        )
        // Still live calls are not history verdicts.
        XCTAssertFalse(CallHistoryDerivation.isMissed(incoming(state: .ringing), accountID: me))
        // Outgoing calls are never "missed".
        XCTAssertFalse(
            CallHistoryDerivation.isMissed(
                outgoing(myStatus: "left", endReason: "no-answer", endedAtMs: 1_700_000_050_000),
                accountID: me
            )
        )
    }

    func testStatusMatrix() {
        XCTAssertEqual(
            CallHistoryDerivation.status(of: outgoing(state: .ringing, myStatus: "ringing"), accountID: me),
            .ringing
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(of: incoming(state: .ringing), accountID: me),
            .incoming
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(of: outgoing(state: .active, myAcceptedAtMs: 1_700_000_010_000), accountID: me),
            .active
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(
                of: incoming(endReason: "no-answer", endedAtMs: 1_700_000_050_000),
                accountID: me
            ),
            .missed
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(
                of: incoming(myStatus: "declined", endReason: "declined", endedAtMs: 1_700_000_050_000),
                accountID: me
            ),
            .declined
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(
                of: outgoing(endReason: "declined", endedAtMs: 1_700_000_050_000),
                accountID: me
            ),
            .declined
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(
                of: outgoing(myStatus: "left", endReason: "no-answer", endedAtMs: 1_700_000_050_000),
                accountID: me
            ),
            .cancelled
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(
                of: incoming(
                    myStatus: "left",
                    myAcceptedAtMs: 1_700_000_020_000,
                    endReason: "completed",
                    endedAtMs: 1_700_000_060_000
                ),
                accountID: me
            ),
            .completed
        )
        XCTAssertEqual(
            CallHistoryDerivation.status(
                of: outgoing(
                    myStatus: "left",
                    myAcceptedAtMs: 1_700_000_020_000,
                    endReason: "completed",
                    endedAtMs: 1_700_000_060_000
                ),
                accountID: me
            ),
            .completed
        )
    }

    func testDurationOnlyForAnsweredEndedCalls() {
        let answered = outgoing(
            state: .ended,
            myStatus: "left",
            myAcceptedAtMs: 1_700_000_010_000,
            endReason: "completed",
            endedAtMs: 1_700_000_070_000
        )
        XCTAssertEqual(CallHistoryDerivation.durationSeconds(of: answered), 60)

        XCTAssertNil(
            CallHistoryDerivation.durationSeconds(
                of: outgoing(
                    state: .ended,
                    endReason: "no-answer",
                    endedAtMs: 1_700_000_070_000
                )
            )
        )
        XCTAssertNil(
            CallHistoryDerivation.durationSeconds(
                of: outgoing(
                    state: .ended,
                    myAcceptedAtMs: 1_700_000_010_000,
                    endReason: "completed",
                    endedAtMs: nil
                )
            )
        )
        XCTAssertNil(
            CallHistoryDerivation.durationSeconds(
                of: outgoing(
                    state: .active,
                    myAcceptedAtMs: 1_700_000_010_000
                )
            )
        )
        // Guarded against a server clock that would produce a negative value.
        XCTAssertNil(
            CallHistoryDerivation.durationSeconds(
                of: outgoing(
                    state: .ended,
                    myAcceptedAtMs: 1_700_000_070_000,
                    endReason: "completed",
                    endedAtMs: 1_700_000_060_000
                )
            )
        )

        // Group call duration starts at the first acceptance.
        let group = CallFixture.call(
            creatorMemberID: me,
            participants: [
                CallFixture.participant(
                    memberID: me,
                    role: "host",
                    status: "left",
                    acceptedAtMs: 1_700_000_020_000
                ),
                CallFixture.participant(
                    memberID: peer,
                    status: "left",
                    acceptedAtMs: 1_700_000_010_000
                ),
            ],
            state: .ended,
            endReason: "completed",
            endedAtMs: 1_700_000_070_000
        )
        XCTAssertEqual(CallHistoryDerivation.durationSeconds(of: group), 60)
    }

    func testElapsedSecondsAnchorsToAnswerTime() {
        let answered = outgoing(state: .active, myAcceptedAtMs: 5_000, createdAtMs: 1_000)
        XCTAssertEqual(CallHistoryDerivation.elapsedSeconds(of: answered, nowMs: 12_000), 7)

        // An outgoing ring that nobody accepted yet anchors to the server
        // updated timestamp instead of inventing an answer moment.
        let ringing = CallFixture.call(
            creatorMemberID: me,
            participants: [
                CallFixture.participant(memberID: me, role: "host", status: "ringing"),
                CallFixture.participant(memberID: peer, status: "ringing"),
            ],
            state: .ringing,
            createdAtMs: 1_000,
            updatedAtMs: 8_000
        )
        XCTAssertEqual(CallHistoryDerivation.elapsedSeconds(of: ringing, nowMs: 10_000), 2)
        XCTAssertEqual(CallHistoryDerivation.elapsedSeconds(of: answered, nowMs: 4_000), 0)
    }

    func testFormattedDuration() {
        XCTAssertEqual(CallHistoryDerivation.formattedDuration(0), "0:00")
        XCTAssertEqual(CallHistoryDerivation.formattedDuration(5), "0:05")
        XCTAssertEqual(CallHistoryDerivation.formattedDuration(65), "1:05")
        XCTAssertEqual(CallHistoryDerivation.formattedDuration(3_661), "1:01:01")
        XCTAssertEqual(CallHistoryDerivation.formattedDuration(-40), "0:00")
    }

    func testDateLabelUsesInjectedCalendar() {
        let calendar = Self.utcCalendar()
        let nowMs = Self.dateMs(2026, 10, 31, 12, 0, calendar: calendar)

        XCTAssertEqual(
            CallHistoryDerivation.dateLabel(
                updatedAtMs: Self.dateMs(2026, 10, 31, 9, 5, calendar: calendar),
                nowMs: nowMs,
                calendar: calendar
            ),
            "09:05"
        )
        XCTAssertEqual(
            CallHistoryDerivation.dateLabel(
                updatedAtMs: Self.dateMs(2026, 10, 30, 23, 59, calendar: calendar),
                nowMs: nowMs,
                calendar: calendar
            ),
            "Вчера"
        )
        XCTAssertEqual(
            CallHistoryDerivation.dateLabel(
                updatedAtMs: Self.dateMs(2026, 10, 28, 10, 0, calendar: calendar),
                nowMs: nowMs,
                calendar: calendar
            ),
            "Ср"
        )
        XCTAssertEqual(
            CallHistoryDerivation.dateLabel(
                updatedAtMs: Self.dateMs(2026, 10, 21, 10, 0, calendar: calendar),
                nowMs: nowMs,
                calendar: calendar
            ),
            "21.10.2026"
        )
    }

    func testLabelsMatchServerState() {
        XCTAssertEqual(CallHistoryDerivation.callStateTitle(.active), "Разговор")
        XCTAssertEqual(CallHistoryDerivation.callStateTitle(.connecting), "Подключение…")
        XCTAssertTrue(CallHistoryDerivation.incomingRingLabel(state: .ringing).contains("Звонит"))
    }

    private static func utcCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.locale = Locale(identifier: "ru_RU")
        return calendar
    }

    private static func dateMs(
        _ year: Int,
        _ month: Int,
        _ day: Int,
        _ hour: Int,
        _ minute: Int,
        calendar: Calendar
    ) -> Int {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        let date = calendar.date(from: components)!
        return Int(date.timeIntervalSince1970 * 1_000)
    }
}

// MARK: - Store behaviour with a mocked transport

private final class CallHistoryRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func record(_ value: String) {
        lock.withLock { values.append(value) }
    }

    var requestCount: Int {
        lock.withLock { values.count }
    }
}

private func decodeCallJSON(_ object: [String: Any]) throws -> APICall {
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(APICall.self, from: data)
}

private enum CallJSON {
    static func call(
        callID: UUID,
        chatID: UUID,
        creatorMemberID: UUID,
        state: String,
        endReason: String? = nil,
        createdAtMs: Int = 1_700_000_000_000,
        updatedAtMs: Int = 1_700_000_100_000,
        endedAtMs: Int? = nil,
        participants: [[String: Any]]
    ) -> [String: Any] {
        [
            "callId": callID.uuidString.lowercased(),
            "chatId": chatID.uuidString.lowercased(),
            "kind": "one_to_one",
            "mediaMode": "audio",
            "state": state,
            "revision": 2,
            "epoch": 1,
            "creatorMemberId": creatorMemberID.uuidString.lowercased(),
            "participants": participants,
            "createdAtMs": createdAtMs,
            "updatedAtMs": updatedAtMs,
            "pendingEndReason": NSNull(),
            "endReason": stringOrNull(endReason),
            "endedAtMs": intOrNull(endedAtMs),
        ]
    }

    static func participant(
        memberID: UUID,
        role: String = "member",
        status: String,
        acceptedAtMs: Int? = nil
    ) -> [String: Any] {
        [
            "membershipId": UUID().uuidString.lowercased(),
            "memberId": memberID.uuidString.lowercased(),
            "role": role,
            "status": status,
            "membershipEpoch": 1,
            "invitedAtMs": 1_700_000_000_000,
            "acceptedAtMs": intOrNull(acceptedAtMs),
            "activeAtMs": NSNull(),
            "removedAtMs": NSNull(),
        ]
    }

    static func response(_ calls: [[String: Any]]) -> (Int, [String: String], Data) {
        (
            200,
            ["Content-Type": "application/json"],
            (try? JSONSerialization.data(withJSONObject: ["calls": calls])) ?? Data()
        )
    }

    static func failure(status: Int, code: String) -> (Int, [String: String], Data) {
        (
            status,
            ["Content-Type": "application/json"],
            (try? JSONSerialization.data(withJSONObject: ["error": ["code": code]])) ?? Data()
        )
    }

    static func intOrNull(_ value: Int?) -> Any {
        if let value { return value }
        return NSNull()
    }

    static func stringOrNull(_ value: String?) -> Any {
        if let value { return value }
        return NSNull()
    }
}

private final class CallHistoryURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, headers, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
final class CallHistoryStoreTests: XCTestCase {
    override func tearDown() {
        CallHistoryURLProtocol.handler = nil
        super.tearDown()
    }

    private func makeStore(accountID: UUID) -> CallsStore {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CallHistoryURLProtocol.self]
        let client = LuxoraAPIClient(
            configuration: LuxoraClientConfiguration(
                apiBaseURL: URL(string: "https://calls-history.invalid")!,
                realtimeURL: URL(string: "wss://calls-history.invalid/v2/realtime")!
            ),
            session: URLSession(configuration: configuration)
        )
        let store = CallsStore(api: client, accountID: accountID, tokenProvider: { "token" })
        store.mediaEnabled = false
        return store
    }

    func testCallResponseDecodingKeepsServerTimestampsAndAcceptance() throws {
        let callID = UUID()
        let chatID = UUID()
        let memberID = UUID()
        let object = CallJSON.call(
            callID: callID,
            chatID: chatID,
            creatorMemberID: memberID,
            state: "ended",
            endReason: "completed",
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            endedAtMs: 1_700_000_060_000,
            participants: [
                CallJSON.participant(
                    memberID: memberID,
                    role: "host",
                    status: "left",
                    acceptedAtMs: 1_700_000_020_000
                )
            ]
        )

        let decoded = try decodeCallJSON(object)
        XCTAssertEqual(decoded.callId, callID)
        XCTAssertEqual(decoded.chatId, chatID)
        XCTAssertEqual(decoded.createdAtMs, 1_700_000_000_000)
        XCTAssertEqual(decoded.updatedAtMs, 1_700_000_100_000)
        XCTAssertEqual(decoded.endedAtMs, 1_700_000_060_000)
        XCTAssertEqual(decoded.endReason, "completed")
        XCTAssertEqual(decoded.participants.first?.acceptedAtMs, 1_700_000_020_000)
    }

    func testLoadHistoryDedupesByCallIDAndSortsByServerUpdate() async {
        let me = UUID()
        let peer = UUID()
        let chatID = UUID()
        let newerCallID = UUID()
        let olderCallID = UUID()

        CallHistoryURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/calls")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token")
            let rawChatID = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "chatId" }?.value
            XCTAssertEqual(rawChatID, chatID.uuidString.lowercased())

            let newerCall = CallJSON.call(
                callID: newerCallID,
                chatID: chatID,
                creatorMemberID: me,
                state: "ended",
                endReason: "completed",
                createdAtMs: 1_700_000_150_000,
                updatedAtMs: 1_700_000_200_000,
                endedAtMs: 1_700_000_190_000,
                participants: [
                    CallJSON.participant(memberID: me, role: "host", status: "left", acceptedAtMs: 1_700_000_160_000),
                    CallJSON.participant(memberID: peer, status: "left", acceptedAtMs: 1_700_000_160_000),
                ]
            )
            var newerOlderRevision = newerCall
            newerOlderRevision["revision"] = 1
            newerOlderRevision["updatedAtMs"] = 1_700_000_150_000
            let olderCall = CallJSON.call(
                callID: olderCallID,
                chatID: chatID,
                creatorMemberID: peer,
                state: "ended",
                endReason: "no-answer",
                createdAtMs: 1_700_000_010_000,
                updatedAtMs: 1_700_000_050_000,
                endedAtMs: 1_700_000_040_000,
                participants: [
                    CallJSON.participant(memberID: peer, role: "host", status: "left"),
                    CallJSON.participant(memberID: me, status: "left"),
                ]
            )
            return CallJSON.response([olderCall, newerCall, newerOlderRevision])
        }

        let store = makeStore(accountID: me)
        let loaded = await store.loadHistory(chatID: chatID)
        XCTAssertTrue(loaded)
        XCTAssertEqual(store.historyState(for: chatID), .loaded)
        XCTAssertNil(store.historyError(for: chatID))

        let calls = store.calls(for: chatID)
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls.first?.callId, newerCallID)
        XCTAssertEqual(calls.first?.revision, 2)
        XCTAssertEqual(calls.last?.callId, olderCallID)
    }

    func testLoadHistoryFailureIsRetryableAndKeepsRowsHonest() async {
        let me = UUID()
        let peer = UUID()
        let chatID = UUID()
        let callID = UUID()
        let recorder = CallHistoryRequestRecorder()

        CallHistoryURLProtocol.handler = { request in
            recorder.record(request.url?.absoluteString ?? "")
            guard recorder.requestCount > 1 else {
                return CallJSON.failure(status: 404, code: "NOT_FOUND")
            }
            let call = CallJSON.call(
                callID: callID,
                chatID: chatID,
                creatorMemberID: peer,
                state: "ended",
                endReason: "no-answer",
                createdAtMs: 1_700_000_000_000,
                updatedAtMs: 1_700_000_050_000,
                endedAtMs: 1_700_000_040_000,
                participants: [
                    CallJSON.participant(memberID: peer, role: "host", status: "left"),
                    CallJSON.participant(memberID: me, status: "left"),
                ]
            )
            return CallJSON.response([call])
        }

        let store = makeStore(accountID: me)
        let firstAttempt = await store.loadHistory(chatID: chatID)
        XCTAssertFalse(firstAttempt)
        XCTAssertEqual(store.historyState(for: chatID), .failed)
        XCTAssertNotNil(store.historyError(for: chatID))
        XCTAssertTrue(store.calls(for: chatID).isEmpty)

        let retry = await store.loadHistory(chatID: chatID, force: true)
        XCTAssertTrue(retry)
        XCTAssertEqual(store.historyState(for: chatID), .loaded)
        XCTAssertNil(store.historyError(for: chatID))
        XCTAssertEqual(store.calls(for: chatID).count, 1)
        XCTAssertEqual(recorder.requestCount, 2)
    }

    func testLoadRecentHistoryMergesChatsAndWarnsOnPartialFailure() async {
        let me = UUID()
        let peer = UUID()
        let chatA = UUID()
        let chatB = UUID()
        let callID = UUID()

        CallHistoryURLProtocol.handler = { request in
            let rawChatID = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "chatId" }?.value
            if rawChatID == chatB.uuidString.lowercased() {
                return CallJSON.failure(status: 404, code: "NOT_FOUND")
            }
            let call = CallJSON.call(
                callID: callID,
                chatID: chatA,
                creatorMemberID: me,
                state: "ended",
                endReason: "completed",
                createdAtMs: 1_700_000_000_000,
                updatedAtMs: 1_700_000_050_000,
                endedAtMs: 1_700_000_040_000,
                participants: [
                    CallJSON.participant(memberID: me, role: "host", status: "left", acceptedAtMs: 1_700_000_010_000),
                    CallJSON.participant(memberID: peer, status: "left", acceptedAtMs: 1_700_000_010_000),
                ]
            )
            return CallJSON.response([call])
        }

        let store = makeStore(accountID: me)
        await store.loadRecentHistory(chatIDs: [chatA, chatB])

        XCTAssertEqual(store.historyState, .loaded)
        XCTAssertNotNil(store.historyError)
        XCTAssertEqual(store.recentCalls.count, 1)
        XCTAssertEqual(store.recentCalls.first?.callId, callID)
    }

    func testLoadRecentHistoryAllFailuresIsAnErrorState() async {
        let me = UUID()
        let chatA = UUID()
        let chatB = UUID()

        CallHistoryURLProtocol.handler = { _ in
            CallJSON.failure(status: 503, code: "SERVICE_UNAVAILABLE")
        }

        let store = makeStore(accountID: me)
        await store.loadRecentHistory(chatIDs: [chatA, chatB])

        XCTAssertEqual(store.historyState, .failed)
        XCTAssertNotNil(store.historyError)
        XCTAssertTrue(store.recentCalls.isEmpty)
    }

    func testEmptyLatestHistoryIsLoadedNotSynthesized() async {
        let me = UUID()
        let chatID = UUID()

        CallHistoryURLProtocol.handler = { _ in CallJSON.response([]) }

        let store = makeStore(accountID: me)
        await store.loadRecentHistory(chatIDs: [chatID])

        XCTAssertEqual(store.historyState, .loaded)
        XCTAssertNil(store.historyError)
        XCTAssertTrue(store.recentCalls.isEmpty)
        XCTAssertEqual(store.calls(for: chatID), [])
    }

    func testInitialStateAndMuteGuardsAreHonest() async {
        let store = makeStore(accountID: UUID())

        XCTAssertEqual(store.historyState, .idle)
        XCTAssertTrue(store.recentCalls.isEmpty)
        XCTAssertTrue(store.canStartCall)
        XCTAssertFalse(store.speakerControlAvailable)
        XCTAssertEqual(store.mediaStatusTitle, "Голос не подключён")

        await store.toggleMute()
        XCTAssertFalse(store.isMuted)
        XCTAssertNotNil(store.errorMessage)
        store.clearError()
        XCTAssertNil(store.errorMessage)
    }

    func testIncomingRingStaysInBannerInsteadOfInCallCover() {
        let me = UUID()
        let peer = UUID()
        let callID = UUID()
        let chatID = UUID()
        let ringCall = CallFixture.call(
            creatorMemberID: peer,
            participants: [
                CallFixture.participant(memberID: peer, role: "host", status: "ringing"),
                CallFixture.participant(memberID: me, status: "ringing"),
            ],
            state: .ringing,
            callID: callID,
            chatID: chatID
        )
        let store = makeStore(accountID: me)
        store.apply(ringCall)
        XCTAssertNotNil(store.incomingCall)
        XCTAssertNil(store.presentedCall)

        let answered = CallFixture.call(
            creatorMemberID: peer,
            participants: [
                CallFixture.participant(memberID: peer, role: "host", status: "accepted", acceptedAtMs: 1_700_000_010_000),
                CallFixture.participant(memberID: me, status: "accepted", acceptedAtMs: 1_700_000_010_000),
            ],
            state: .connecting,
            callID: callID,
            chatID: chatID
        )
        store.apply(answered)
        XCTAssertNil(store.incomingCall)
        XCTAssertEqual(store.presentedCall?.callId, callID)
        XCTAssertFalse(store.canStartCall)
    }

    func testEndedCallRefreshesAnAlreadyOpenHistoryLog() async throws {
        let me = UUID()
        let peer = UUID()
        let chatID = UUID()
        let callID = UUID()
        let recorder = CallHistoryRequestRecorder()

        CallHistoryURLProtocol.handler = { _ in
            recorder.record("fetch")
            let ended = recorder.requestCount > 1
            let call = CallJSON.call(
                callID: callID,
                chatID: chatID,
                creatorMemberID: me,
                state: ended ? "ended" : "active",
                endReason: ended ? "completed" : nil,
                createdAtMs: 1_700_000_000_000,
                updatedAtMs: ended ? 1_700_000_100_000 : 1_700_000_050_000,
                endedAtMs: ended ? 1_700_000_090_000 : nil,
                participants: [
                    CallJSON.participant(memberID: me, role: "host", status: "active", acceptedAtMs: 1_700_000_010_000),
                    CallJSON.participant(memberID: peer, status: "active", acceptedAtMs: 1_700_000_010_000),
                ]
            )
            return CallJSON.response([call])
        }

        let store = makeStore(accountID: me)
        await store.loadHistory(chatID: chatID)
        XCTAssertEqual(store.calls(for: chatID).first?.state, .active)
        XCTAssertEqual(recorder.requestCount, 1)

        let live = CallFixture.call(
            creatorMemberID: me,
            participants: [
                CallFixture.participant(memberID: me, role: "host", status: "active", acceptedAtMs: 1_700_000_010_000),
                CallFixture.participant(memberID: peer, status: "active", acceptedAtMs: 1_700_000_010_000),
            ],
            state: .active,
            callID: callID,
            chatID: chatID
        )
        store.apply(live)
        XCTAssertEqual(recorder.requestCount, 1)

        let ended = CallFixture.call(
            creatorMemberID: me,
            participants: [
                CallFixture.participant(memberID: me, role: "host", status: "left", acceptedAtMs: 1_700_000_010_000),
                CallFixture.participant(memberID: peer, status: "left", acceptedAtMs: 1_700_000_010_000),
            ],
            state: .ended,
            endReason: "completed",
            endedAtMs: 1_700_000_090_000,
            callID: callID,
            chatID: chatID
        )
        store.apply(ended)

        let deadline = Date().addingTimeInterval(5)
        while recorder.requestCount < 2 || store.calls(for: chatID).first?.state != .ended {
            if Date() >= deadline { break }
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(recorder.requestCount, 2)
        XCTAssertEqual(store.calls(for: chatID).first?.state, .ended)
        XCTAssertEqual(store.calls(for: chatID).first?.callId, callID)
    }
}
