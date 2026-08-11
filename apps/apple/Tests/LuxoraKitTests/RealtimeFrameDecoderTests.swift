import Foundation
import XCTest
@testable import LuxoraKit

final class RealtimeFrameDecoderTests: XCTestCase {
    func testReceiptDurableEventReachesDeliveryProjection() throws {
        let data = Data(
            #"{"type":"dispatch","sequence":42,"event":{"type":"receipt.read","chatId":"75f11f49-cfa7-4488-b778-fc8f1439b900","userId":"6ec069d3-04cf-4f3b-b673-dd7497103f07","messageId":"d88ecf9e-d5bb-4109-98db-f56a34343033","readAt":"2026-08-03T12:00:00.000Z"}}"#.utf8
        )

        guard case let .messageReceipt(chatID, messageID, isRead, sequence) = try RealtimeFrameDecoder.decode(data) else {
            return XCTFail("Expected a receipt signal")
        }
        XCTAssertEqual(chatID.uuidString.lowercased(), "75f11f49-cfa7-4488-b778-fc8f1439b900")
        XCTAssertEqual(messageID.uuidString.lowercased(), "d88ecf9e-d5bb-4109-98db-f56a34343033")
        XCTAssertTrue(isRead)
        XCTAssertEqual(sequence, 42)
    }

    func testMessageUpdatePreservesInteractionMetadataForStoreRehydration() throws {
        let data = Data(
            #"{"type":"dispatch","sequence":43,"event":{"type":"message.updated","message":{"id":"22222222-2222-4222-8222-222222222222","chatId":"11111111-1111-4111-8111-111111111111","sender":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","username":"flenym","displayName":"Flenym","bio":"","createdAt":"2026-08-04T18:00:00Z"},"kind":"text","body":"Обновлено","replyToMessageId":"33333333-3333-4333-8333-333333333333","topicId":null,"forwardedFrom":{"senderDisplayName":"Егор","originalCreatedAt":"2026-08-03T18:00:00Z"},"attachments":[],"isPinned":true,"clientNonce":"44444444-4444-4444-8444-444444444444","revision":5,"createdAt":"2026-08-04T18:00:00Z","updatedAt":"2026-08-04T18:01:00Z","editedAt":"2026-08-04T18:01:00Z","deletedAt":null}}}"#.utf8
        )

        guard case let .message(message, sequence) = try RealtimeFrameDecoder.decode(data) else {
            return XCTFail("Expected a realtime message snapshot")
        }
        XCTAssertEqual(sequence, 43)
        XCTAssertEqual(message.revision, 5)
        XCTAssertEqual(message.replyToMessageId?.uuidString.lowercased(), "33333333-3333-4333-8333-333333333333")
        XCTAssertEqual(message.forwardedFrom?.senderDisplayName, "Егор")
        XCTAssertTrue(message.isPinned)
    }

    func testPinAndUnpinDurableEventsReachTheStoreInsteadOfBecomingIgnoredCursors() throws {
        let pinData = Data(
            #"{"type":"dispatch","sequence":44,"event":{"type":"message.pinned","pin":{"chatId":"11111111-1111-4111-8111-111111111111","messageId":"22222222-2222-4222-8222-222222222222","pinnedBy":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","username":"flenym","displayName":"Flenym","bio":"","createdAt":"2026-08-04T18:00:00Z"},"pinnedAt":"2026-08-04T18:02:00Z"}}}"#.utf8
        )
        let unpinData = Data(
            #"{"type":"dispatch","sequence":45,"event":{"type":"message.unpinned","chatId":"11111111-1111-4111-8111-111111111111","messageId":"22222222-2222-4222-8222-222222222222"}}"#.utf8
        )

        guard case let .messagePin(chatID, messageID, active, sequence) = try RealtimeFrameDecoder.decode(pinData) else {
            return XCTFail("Expected a pin signal")
        }
        XCTAssertEqual(chatID.uuidString.lowercased(), "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(messageID.uuidString.lowercased(), "22222222-2222-4222-8222-222222222222")
        XCTAssertTrue(active)
        XCTAssertEqual(sequence, 44)

        guard case let .messagePin(_, _, unpinActive, unpinSequence) = try RealtimeFrameDecoder.decode(unpinData) else {
            return XCTFail("Expected an unpin signal")
        }
        XCTAssertFalse(unpinActive)
        XCTAssertEqual(unpinSequence, 45)
    }

    func testMessageRequestEventsPreserveAudienceSafeReconciliationData() throws {
        let createdData = Data(
            #"{"type":"dispatch","sequence":46,"event":{"type":"relationship.request.created","audience":"recipient_account","request":{"id":"55555555-5555-4555-8555-555555555555","direction":"incoming","state":"pending","body":"Здравствуйте","sender":{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","username":"egor","displayName":"Егор","bio":"","avatarUrl":null},"createdAt":"2026-08-04T18:03:00Z","expiresAt":"2026-09-03T18:03:00Z"}}}"#.utf8
        )
        let removedData = Data(
            #"{"type":"dispatch","sequence":47,"event":{"type":"relationship.request.removed","audience":"recipient_account","requestId":"55555555-5555-4555-8555-555555555555","removedAt":"2026-08-04T18:04:00Z"}}"#.utf8
        )
        let acceptedData = Data(
            #"{"type":"dispatch","sequence":48,"event":{"type":"relationship.request.accepted","audience":"participant_account","requestId":"55555555-5555-4555-8555-555555555555","chat":{"id":"66666666-6666-4666-8666-666666666666","kind":"direct","title":"Егор","avatarUrl":null,"role":"member","memberCount":2,"lastMessage":null,"lastActivityAt":"2026-08-04T18:05:00Z","createdAt":"2026-08-04T18:05:00Z","unreadCount":1},"acceptedAt":"2026-08-04T18:05:00Z"}}"#.utf8
        )
        let expiredData = Data(
            #"{"type":"dispatch","sequence":49,"event":{"type":"relationship.request.expired","audience":"participant_account","requestId":"55555555-5555-4555-8555-555555555555","expiredAt":"2026-09-03T18:03:00Z"}}"#.utf8
        )

        guard case let .messageRequestCreated(request, sequence) = try RealtimeFrameDecoder.decode(createdData) else {
            return XCTFail("Expected a privacy-projected request")
        }
        XCTAssertEqual(sequence, 46)
        XCTAssertEqual(try request.item().participant.username, "egor")
        XCTAssertEqual(try request.item().direction, .incoming)

        guard case let .messageRequestRemoved(requestID, removedSequence) = try RealtimeFrameDecoder.decode(removedData) else {
            return XCTFail("Expected a recipient-private removal")
        }
        XCTAssertEqual(requestID, request.id)
        XCTAssertEqual(removedSequence, 47)

        guard case let .messageRequestAccepted(acceptedID, chat, acceptedSequence) = try RealtimeFrameDecoder.decode(acceptedData) else {
            return XCTFail("Expected an accepted Direct projection")
        }
        XCTAssertEqual(acceptedID, request.id)
        XCTAssertEqual(chat.kind, "direct")
        XCTAssertEqual(acceptedSequence, 48)

        guard case let .messageRequestExpired(expiredID, expiredSequence) = try RealtimeFrameDecoder.decode(expiredData) else {
            return XCTFail("Expected request expiry")
        }
        XCTAssertEqual(expiredID, request.id)
        XCTAssertEqual(expiredSequence, 49)
    }
}
