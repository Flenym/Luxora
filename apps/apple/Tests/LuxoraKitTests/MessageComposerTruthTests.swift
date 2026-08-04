import XCTest
@testable import LuxoraKit

final class MessageComposerTruthTests: XCTestCase {
    func testThinHarnessNeverAdvertisesVoiceFromTheSendControl() {
        XCTAssertEqual(MessageComposerTruth.sendSymbol, "arrow.up")
        XCTAssertFalse(MessageComposerTruth.sendSymbol.localizedCaseInsensitiveContains("mic"))
    }
}
