import Foundation
import XCTest
@testable import LuxoraKit

final class SessionCredentialCoordinatorTests: XCTestCase {
    func testConcurrentUnauthorizedRequestsShareOneRefreshRotation() async throws {
        let probe = RefreshProbe()
        let sessionID = UUID()
        let coordinator = SessionCredentialCoordinator(
            credentials: SessionCredentials(
                accessToken: "expired-access",
                refreshToken: "initial-refresh",
                sessionID: sessionID
            ),
            refreshOperation: { token in
                try await probe.refresh(token: token, sessionID: sessionID)
            },
            persistOperation: { credentials in
                Task { await probe.persist(credentials) }
            }
        )

        async let first = coordinator.withAccessToken(Self.protectedOperation)
        async let second = coordinator.withAccessToken(Self.protectedOperation)

        let values = try await [first, second]
        XCTAssertEqual(values, ["fresh-access", "fresh-access"])
        let refreshCount = await probe.refreshCount
        XCTAssertEqual(refreshCount, 1)
    }

    private static let protectedOperation: @Sendable (String) async throws -> String = { token in
        if token == "expired-access" {
            throw LuxoraAPIError.server(status: 401, code: "UNAUTHORIZED", message: "Expired")
        }
        return token
    }
}

private actor RefreshProbe {
    private(set) var refreshCount = 0
    private(set) var persisted: SessionCredentials?

    func refresh(token: String, sessionID: UUID) async throws -> SessionCredentials {
        XCTAssertEqual(token, "initial-refresh")
        refreshCount += 1
        try await Task.sleep(for: .milliseconds(40))
        return SessionCredentials(
            accessToken: "fresh-access",
            refreshToken: "rotated-refresh",
            sessionID: sessionID
        )
    }

    func persist(_ credentials: SessionCredentials) {
        persisted = credentials
    }
}
