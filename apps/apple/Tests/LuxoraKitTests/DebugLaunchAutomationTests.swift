#if DEBUG
import XCTest
@testable import LuxoraKit

final class DebugLaunchAutomationTests: XCTestCase {
    func testAutomationRequiresExplicitOptIn() {
        XCTAssertNil(DebugLaunchAutomation(environment: [
            "LUXORA_DEBUG_USERNAME": "egor_beta",
            "LUXORA_DEBUG_PASSWORD": "debug-test-placeholder",
        ]))
    }

    func testAutomationRejectsMissingOrShortCredentials() {
        XCTAssertNil(DebugLaunchAutomation(environment: [
            "LUXORA_DEBUG_AUTOMATION": "1",
            "LUXORA_DEBUG_USERNAME": "egor_beta",
        ]))
        XCTAssertNil(DebugLaunchAutomation(environment: [
            "LUXORA_DEBUG_AUTOMATION": "1",
            "LUXORA_DEBUG_USERNAME": "egor_beta",
            "LUXORA_DEBUG_PASSWORD": "short",
        ]))
    }

    func testAutomationParsesAnOptionalConversationID() throws {
        let chatID = try XCTUnwrap(UUID(uuidString: "bc692927-6287-4566-b3ca-d6e1a68254dc"))
        let automation = try XCTUnwrap(DebugLaunchAutomation(environment: [
            "LUXORA_DEBUG_AUTOMATION": "1",
            "LUXORA_DEBUG_USERNAME": "egor_beta",
            "LUXORA_DEBUG_PASSWORD": "debug-test-placeholder",
            "LUXORA_DEBUG_OPEN_CHAT_ID": chatID.uuidString,
        ]))

        XCTAssertEqual(automation.username, "egor_beta")
        XCTAssertEqual(automation.conversationID, chatID)
    }
}
#endif
