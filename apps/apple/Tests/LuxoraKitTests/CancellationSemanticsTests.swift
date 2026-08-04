import Foundation
import XCTest
@testable import LuxoraKit

final class CancellationSemanticsTests: XCTestCase {
    func testCancelledURLRequestRemainsTaskCancellation() {
        let translated = LuxoraAPIClient.transportError(URLError(.cancelled))

        XCTAssertTrue(translated is CancellationError)
    }

    func testOrdinaryTransportFailureRemainsUserVisibleTransportError() {
        let translated = LuxoraAPIClient.transportError(URLError(.notConnectedToInternet))

        guard case .transport = translated as? LuxoraAPIError else {
            return XCTFail("Expected an ordinary transport error")
        }
    }
}
