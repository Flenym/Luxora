import XCTest

final class LuxoraDesignLabUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testLoginPasskeyUnavailableScenarioIsExplicitlyGated() {
        let app = launch(scenario: "login-passkey-unavailable")

        XCTAssertTrue(app.scrollViews["auth-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["design-lab-banner"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["auth-passkey-status"].exists)
        XCTAssertFalse(app.buttons["auth-passkey"].isEnabled)
    }

    @MainActor
    func testChatListAndConversationScenariosExposeAccessibleRoots() {
        var app = launch(scenario: "chat-list")
        XCTAssertTrue(app.descendants(matching: .any)["chat-list-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["connection-summary"].exists)
        app.terminate()

        app = launch(scenario: "conversation")
        XCTAssertTrue(app.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Send message"].exists)
    }

    @MainActor
    private func launch(scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--scenario=\(scenario)"]
        app.launch()
        return app
    }
}
