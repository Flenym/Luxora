import Foundation
import XCTest
@testable import LuxoraKit

final class RealtimeFrameDecoderTests: XCTestCase {
    func testUnhandledDurableEventStillAdvancesResumeCursor() throws {
        let data = Data(
            #"{"type":"dispatch","sequence":42,"event":{"type":"receipt.read","chatId":"75f11f49-cfa7-4488-b778-fc8f1439b900","userId":"6ec069d3-04cf-4f3b-b673-dd7497103f07","messageId":"d88ecf9e-d5bb-4109-98db-f56a34343033","readAt":"2026-08-03T12:00:00.000Z"}}"#.utf8
        )

        guard case let .cursor(sequence) = try RealtimeFrameDecoder.decode(data) else {
            return XCTFail("Expected an ignored durable event to advance the cursor")
        }
        XCTAssertEqual(sequence, 42)
    }
}
