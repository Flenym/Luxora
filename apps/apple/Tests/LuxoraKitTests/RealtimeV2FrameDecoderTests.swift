import Foundation
import XCTest
@testable import LuxoraKit

final class RealtimeV2FrameDecoderTests: XCTestCase {
    private let cursor = "luxora-rt1.\(String(repeating: "a", count: 40)).\(String(repeating: "b", count: 40))"

    func testHelloRequiresExactV2Handshake() throws {
        let valid = Data(#"{"type":"hello","protocolVersion":2,"connectionId":"10000000-0000-4000-8000-000000000001","heartbeatIntervalMs":25000}"#.utf8)
        XCTAssertNoThrow(try RealtimeHelloDecoder.validate(valid, expectedVersion: 2))

        let wrongVersion = Data(#"{"type":"hello","protocolVersion":1,"connectionId":"10000000-0000-4000-8000-000000000001","heartbeatIntervalMs":25000}"#.utf8)
        XCTAssertThrowsError(try RealtimeHelloDecoder.validate(wrongVersion, expectedVersion: 2))

        let additive = Data(#"{"type":"hello","protocolVersion":2,"connectionId":"10000000-0000-4000-8000-000000000001","heartbeatIntervalMs":25000,"unexpected":true}"#.utf8)
        XCTAssertThrowsError(try RealtimeHelloDecoder.validate(additive, expectedVersion: 2))
    }

    func testReadyAndCheckpointPreserveOpaqueProgress() throws {
        let ready = Data(
            """
            {"type":"ready","userId":"20000000-0000-4000-8000-000000000002","sessionId":"30000000-0000-4000-8000-000000000003","sequence":41,"headSequence":45,"cursor":"\(cursor)","resumed":true,"resumeMode":"scoped_cursor","retention":{"maxReplayEvents":500,"cursorTtlSeconds":604800}}
            """.utf8
        )
        guard case let .ready(userID, sessionID, sequence, headSequence, decodedCursor, resumed) = try RealtimeV2FrameDecoder.decode(ready) else {
            return XCTFail("Expected strict v2 ready")
        }
        XCTAssertEqual(userID.uuidString.lowercased(), "20000000-0000-4000-8000-000000000002")
        XCTAssertEqual(sessionID.uuidString.lowercased(), "30000000-0000-4000-8000-000000000003")
        XCTAssertEqual(sequence, 41)
        XCTAssertEqual(headSequence, 45)
        XCTAssertEqual(decodedCursor, cursor)
        XCTAssertTrue(resumed)

        let checkpoint = Data(
            "{\"type\":\"sync.checkpoint\",\"sequence\":45,\"cursor\":\"\(cursor)\"}".utf8
        )
        guard case let .checkpoint(sequence, decodedCursor) = try RealtimeV2FrameDecoder.decode(checkpoint) else {
            return XCTFail("Expected checkpoint")
        }
        XCTAssertEqual(sequence, 45)
        XCTAssertEqual(decodedCursor, cursor)
    }

    func testDurableDispatchCarriesCursorAlongsideLegacyProjection() throws {
        let data = Data(
            """
            {"type":"dispatch","sequence":46,"cursor":"\(cursor)","event":{"type":"message.unpinned","chatId":"40000000-0000-4000-8000-000000000004","messageId":"50000000-0000-4000-8000-000000000005"}}
            """.utf8
        )
        guard case let .dispatch(signal, sequence, decodedCursor) = try RealtimeV2FrameDecoder.decode(data),
              case let .messagePin(chatID, messageID, active, legacySequence) = signal
        else { return XCTFail("Expected scoped unpin dispatch") }
        XCTAssertEqual(sequence, 46)
        XCTAssertEqual(legacySequence, 46)
        XCTAssertEqual(decodedCursor, cursor)
        XCTAssertEqual(chatID.uuidString.lowercased(), "40000000-0000-4000-8000-000000000004")
        XCTAssertEqual(messageID.uuidString.lowercased(), "50000000-0000-4000-8000-000000000005")
        XCTAssertFalse(active)
    }

    func testStrictAccountProjectionInvalidationCarriesNoLocalPatch() throws {
        let data = Data(
            """
            {"type":"dispatch","sequence":47,"cursor":"\(cursor)","event":{"type":"sync.invalidated","audience":"account_projection","accountId":"20000000-0000-4000-8000-000000000002","reason":"avatar_updated","changedAt":"2026-08-11T12:00:00Z"}}
            """.utf8
        )
        guard case let .syncInvalidated(dispatch) = try RealtimeV2FrameDecoder.decode(data) else {
            return XCTFail("Expected strict account invalidation")
        }
        XCTAssertEqual(
            dispatch.accountID,
            UUID(uuidString: "20000000-0000-4000-8000-000000000002")
        )
        XCTAssertEqual(dispatch.reason, .avatarUpdated)
        XCTAssertEqual(dispatch.sequence, 47)
        XCTAssertEqual(dispatch.cursor, cursor)

        guard case let .cursor(legacySequence) = try RealtimeFrameDecoder.decode(data) else {
            return XCTFail("V1 must safely skip the V2-only payload")
        }
        XCTAssertEqual(legacySequence, 47)
    }

    func testInvalidationRejectsWrongAudienceUnknownReasonAndAdditiveFields() {
        let wrongAudience = Data(
            """
            {"type":"dispatch","sequence":47,"cursor":"\(cursor)","event":{"type":"sync.invalidated","audience":"member_account","accountId":"20000000-0000-4000-8000-000000000002","reason":"profile_updated","changedAt":"2026-08-11T12:00:00Z"}}
            """.utf8
        )
        XCTAssertThrowsError(try RealtimeV2FrameDecoder.decode(wrongAudience))

        let unknownReason = Data(
            """
            {"type":"dispatch","sequence":47,"cursor":"\(cursor)","event":{"type":"sync.invalidated","audience":"account_projection","accountId":"20000000-0000-4000-8000-000000000002","reason":"unknown","changedAt":"2026-08-11T12:00:00Z"}}
            """.utf8
        )
        XCTAssertThrowsError(try RealtimeV2FrameDecoder.decode(unknownReason))

        let additive = Data(
            """
            {"type":"dispatch","sequence":47,"cursor":"\(cursor)","event":{"type":"sync.invalidated","audience":"account_projection","accountId":"20000000-0000-4000-8000-000000000002","reason":"attachment_removed","changedAt":"2026-08-11T12:00:00Z","unexpected":true}}
            """.utf8
        )
        XCTAssertThrowsError(try RealtimeV2FrameDecoder.decode(additive))
    }

    func testSyncRequiredExposesOnlyCanonicalRecoveryContract() throws {
        let data = Data(#"{"type":"sync.required","reason":"cursor_expired","headSequence":51,"recovery":{"type":"http_snapshot","path":"/v2/sync/snapshot"}}"#.utf8)
        guard case let .syncRequired(reason, headSequence, path) = try RealtimeV2FrameDecoder.decode(data) else {
            return XCTFail("Expected recovery request")
        }
        XCTAssertEqual(reason, .cursorExpired)
        XCTAssertEqual(headSequence, 51)
        XCTAssertEqual(path, "/v2/sync/snapshot")
    }

    func testMalformedOrNullCursorNeverAdvancesScopedProgress() throws {
        let malformed = Data(#"{"type":"sync.checkpoint","sequence":1,"cursor":"corrupted"}"#.utf8)
        XCTAssertThrowsError(try RealtimeV2FrameDecoder.decode(malformed))

        let nullDispatch = Data(#"{"type":"dispatch","sequence":1,"cursor":null,"event":{"type":"attachment.stored"}}"#.utf8)
        XCTAssertThrowsError(try RealtimeV2FrameDecoder.decode(nullDispatch))
    }
}
