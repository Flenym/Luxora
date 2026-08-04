import XCTest
@testable import LuxoraKit

final class ApplicationPresentationStateTests: XCTestCase {
    func testAuthenticationLifecycleStatesRemainDistinct() {
        XCTAssertEqual(resolve(.restoring), .restoring)
        XCTAssertEqual(resolve(.unauthenticated), .unauthenticated)
        XCTAssertEqual(resolve(.restorationFailed, error: "Server unavailable"), .error("Server unavailable"))
    }

    func testAuthenticatedConnectionStatesRemainTruthful() {
        XCTAssertEqual(resolve(.authenticated, connection: .connecting), .connecting)
        XCTAssertEqual(resolve(.authenticated, connection: .online), .connected)
        XCTAssertEqual(resolve(.authenticated, connection: .offline), .offline)
        XCTAssertEqual(
            resolve(.authenticated, connection: .degraded("Handshake failed")),
            .error("Handshake failed")
        )
    }

    func testAuthenticatedSessionWithoutMessengerStateIsAnError() {
        XCTAssertEqual(
            resolve(.authenticated),
            .error("Для авторизованного сеанса не создано состояние мессенджера.")
        )
    }

    private func resolve(
        _ phase: ApplicationPhase,
        connection: ConnectionState? = nil,
        error: String? = nil
    ) -> ApplicationPresentationState {
        ApplicationPresentationState(
            phase: phase,
            connectionState: connection,
            errorMessage: error
        )
    }
}
