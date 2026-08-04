import XCTest

final class LuxoraNavigationUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testOwnProfileCopyAndQRButtonsOpenRealLocalActions() {
        let app = messengerApp(destination: "you-profile")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["own-profile-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["own-profile-share"].exists)
        XCTAssertTrue(app.buttons["own-profile-identity"].exists)

        app.buttons["own-profile-copy-username"].tap()
        XCTAssertTrue(app.alerts["Username скопирован"].waitForExistence(timeout: 3))
        app.alerts.buttons["ОК"].tap()

        app.buttons["own-profile-open-qr"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["own-profile-qr-screen"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["own-profile-qr-share"].exists)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "В нём нет токена входа")
        ).firstMatch.exists)
    }

    @MainActor
    func testFolderResetChangesTheActiveChatFilterLocally() {
        let app = messengerApp(destination: "you-folders", initialFolder: "channels")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["you-folders-screen"].waitForExistence(timeout: 8))
        let reset = app.buttons["folders-reset-all"]
        XCTAssertTrue(reset.exists)
        XCTAssertTrue(reset.isEnabled)
        reset.tap()
        XCTAssertFalse(reset.isEnabled)
    }

    @MainActor
    func testContactProfileSearchOpensOnlyTheLoadedMessageIndex() {
        let app = messengerApp(destination: "contact-profile")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["contact-profile-screen"].waitForExistence(timeout: 8))
        let search = app.buttons["contact-profile-action-search"]
        XCTAssertTrue(search.exists)
        search.tap()

        XCTAssertTrue(app.descendants(matching: .any)["contact-message-search-screen"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.searchFields["Поиск в переписке"].exists)
    }

    @MainActor
    private func messengerApp(destination: String, initialFolder: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(ru-RU)", "-AppleLocale", "ru_RU"]
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_UI_TEST_SCENARIO"] = "messenger"
        app.launchEnvironment["LUXORA_UI_TEST_DESTINATION"] = destination
        if let initialFolder {
            app.launchEnvironment["LUXORA_UI_TEST_INITIAL_FOLDER"] = initialFolder
        }
        return app
    }
}
