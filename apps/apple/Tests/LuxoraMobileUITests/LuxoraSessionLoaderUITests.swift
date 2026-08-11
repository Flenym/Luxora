import XCTest

final class LuxoraSessionLoaderUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testContourLoaderHasOneStableRussianAccessibilityStatus() {
        let app = restorationApp(holdMilliseconds: 4_000)
        app.launch()

        let restoration = app.descendants(matching: .any)["session-restoring-screen"]
        XCTAssertTrue(restoration.waitForExistence(timeout: 4))
        XCTAssertEqual(restoration.label, "Восстановление сеанса Luxora")
        XCTAssertEqual(
            restoration.value as? String,
            "Проверяем сохранённый сеанс устройства на сервере Luxora."
        )
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)

        attachScreenshot("session-loader-dark", from: app)
    }

    @MainActor
    func testOptInActualKeychainSessionTransitionsFromContourLoaderToChats() throws {
        try requireLiveSavedSession()

        let app = restorationApp(holdMilliseconds: 2_500)
        app.launch()

        XCTAssertTrue(
            app.descendants(matching: .any)["session-restoring-screen"]
                .waitForExistence(timeout: 4)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["chats-screen"]
                .waitForExistence(timeout: 18)
        )
        XCTAssertFalse(app.descendants(matching: .any)["session-restoring-screen"].exists)
    }

    @MainActor
    func testOptInCancellationRetryAndErrorRecoveryPreserveActualKeychainSession() throws {
        try requireLiveSavedSession()

        let cancelled = restorationApp(holdMilliseconds: 8_000)
        cancelled.launch()
        XCTAssertTrue(
            cancelled.descendants(matching: .any)["session-restoring-screen"]
                .waitForExistence(timeout: 4)
        )
        cancelled.terminate()

        let unavailable = restorationApp(
            apiURL: "http://127.0.0.1:1",
            realtimeURL: "ws://127.0.0.1:1/v1/realtime"
        )
        unavailable.launch()

        let retry = unavailable.buttons["Повторить"]
        XCTAssertTrue(retry.waitForExistence(timeout: 12))
        XCTAssertTrue(retry.isHittable)
        XCTAssertTrue(unavailable.buttons["Войти заново"].exists)
        XCTAssertTrue(unavailable.staticTexts["Не удалось восстановить сеанс"].exists)
        XCTAssertTrue(unavailable.staticTexts["Не удалось связаться с сервером."].exists)
        XCTAssertFalse(unavailable.staticTexts["Не удалось восстановить сеанс: Не удалось связаться с сервером."].exists)

        retry.tap()
        XCTAssertTrue(unavailable.buttons["Повторить"].waitForExistence(timeout: 12))
        XCTAssertTrue(unavailable.buttons["Войти заново"].exists)
        unavailable.terminate()

        let recovered = restorationApp()
        recovered.launch()
        XCTAssertTrue(
            recovered.descendants(matching: .any)["chats-screen"]
                .waitForExistence(timeout: 18)
        )
    }

    @MainActor
    private func requireLiveSavedSession() throws {
        guard ProcessInfo.processInfo.environment["LUXORA_LIVE_PHONE_UI_TEST"] == "1" else {
            throw XCTSkip(
                "Set LUXORA_LIVE_PHONE_UI_TEST=1 after creating a real saved phone session"
            )
        }
    }

    @MainActor
    private func restorationApp(
        apiURL: String? = nil,
        realtimeURL: String? = nil,
        holdMilliseconds: Int? = nil
    ) -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(ru-RU)", "-AppleLocale", "ru_RU"]
        app.launchEnvironment["LUXORA_API_URL"] = apiURL
            ?? environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = realtimeURL
            ?? environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        if let holdMilliseconds {
            app.launchEnvironment["LUXORA_UI_TEST_RESTORE_HOLD_MS"] = String(holdMilliseconds)
        }
        return app
    }

    @MainActor
    private func attachScreenshot(_ name: String, from app: XCUIApplication) {
        XCTAssertEqual(app.state, .runningForeground)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
