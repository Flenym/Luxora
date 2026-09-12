import Foundation
@testable import LuxoraKit
import XCTest

final class ChatAPIContractTests: XCTestCase {
    func testCreateDirectBodyMatchesStrictServerContract() throws {
        let userID = try XCTUnwrap(UUID(uuidString: "BC692927-6287-4566-B3CA-D6E1A68254DC"))
        let body = APIChatBody.createDirect(userID: userID)

        XCTAssertEqual(Set(body.keys), ["kind", "userId"])
        XCTAssertEqual(body["kind"], "direct")
        XCTAssertEqual(body["userId"], "bc692927-6287-4566-b3ca-d6e1a68254dc")
    }

    func testSendBodyPreservesTextAndCanonicalIdempotencyNonce() throws {
        let nonce = try XCTUnwrap(UUID(uuidString: "45FA51A5-700F-4AE7-96FC-A0172D991716"))
        let body = APIChatBody.sendMessage(
            clientNonce: nonce,
            body: "Привет, Luxora",
            replyToMessageID: nil,
            attachmentIDs: []
        )

        let data = try JSONEncoder().encode(body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "text")
        XCTAssertEqual(json["body"] as? String, "Привет, Luxora")
        XCTAssertEqual(json["clientNonce"] as? String, "45fa51a5-700f-4ae7-96fc-a0172d991716")
        XCTAssertNil(json["attachmentIds"])
    }

    func testSendMediaBodyOmitsTextAndCarriesAttachmentIds() throws {
        let nonce = try XCTUnwrap(UUID(uuidString: "45FA51A5-700F-4AE7-96FC-A0172D991716"))
        let attachmentID = try XCTUnwrap(UUID(uuidString: "85CE9209-F691-412B-B566-8D1AE2C56B49"))
        let body = APIChatBody.sendMessage(
            clientNonce: nonce,
            body: "",
            replyToMessageID: nil,
            attachmentIDs: [attachmentID]
        )

        let data = try JSONEncoder().encode(body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["kind"])
        XCTAssertNil(json["body"])
        XCTAssertEqual(json["attachmentIds"] as? [String], ["85ce9209-f691-412b-b566-8d1ae2c56b49"])
    }

    func testReadAndReactionBodiesContainNoInventedFields() throws {
        let messageID = try XCTUnwrap(UUID(uuidString: "85CE9209-F691-412B-B566-8D1AE2C56B49"))

        XCTAssertEqual(
            APIChatBody.markRead(messageID: messageID),
            ["messageId": "85ce9209-f691-412b-b566-8d1ae2c56b49"]
        )
        XCTAssertEqual(APIChatBody.reaction(emoji: "🔥"), ["emoji": "🔥"])
    }

    func testScheduledMessageDecodesBoundedProjection() throws {
        let payload = """
        {"id":"85ce9209-f691-412b-b566-8d1ae2c56b49",\
        "chatId":"85ce9209-f691-412b-b566-8d1ae2c56b49",\
        "body":"Напомнить","replyToMessageId":null,"topicId":null,\
        "sendAt":"2026-09-13T00:00:00.000Z","state":"pending",\
        "failureCode":null,"createdAt":"2026-09-12T00:00:00.000Z"}
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(APIScheduledMessage.self, from: Data(payload.utf8))
        let scheduled = decoded.scheduled()
        XCTAssertEqual(scheduled.body, "Напомнить")
        XCTAssertEqual(scheduled.state, "pending")
        XCTAssertNil(scheduled.failureCode)
    }

    func testUserSearchEscapesQueryDelimitersInsteadOfCreatingExtraParameters() {
        XCTAssertEqual(LuxoraAPIClient.encodedQueryValue("mira&limit=999"), "mira%26limit%3D999")
        XCTAssertEqual(LuxoraAPIClient.encodedQueryValue("Егор Flenym"), "%D0%95%D0%B3%D0%BE%D1%80%20Flenym")
    }
}
