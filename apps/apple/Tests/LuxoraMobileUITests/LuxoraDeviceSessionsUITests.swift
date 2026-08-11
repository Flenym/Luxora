import XCTest

final class LuxoraDeviceSessionsUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testOptInLiveDeviceListAndRemoteRevocation() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_LIVE_PHONE_UI_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_PHONE_UI_TEST=1 after saving a real phone session")
        }
        guard let otherDeviceName = environment["LUXORA_LIVE_OTHER_DEVICE_NAME"],
              !otherDeviceName.isEmpty
        else {
            throw XCTSkip("Seed a second session and set LUXORA_LIVE_OTHER_DEVICE_NAME")
        }

        let app = XCUIApplication()
        app.launchArguments += [
            "-AppleLanguages", "(ru-RU)",
            "-AppleLocale", "ru_RU",
            "-luxora.onboarding.didCompletePermissionsPrimer", "YES",
        ]
        app.launchEnvironment["LUXORA_API_URL"] = environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        for key in [
            "LUXORA_DEBUG_AUTOMATION",
            "LUXORA_DEBUG_USERNAME",
            "LUXORA_DEBUG_PASSWORD_PREFIX",
            "LUXORA_DEBUG_PASSWORD_SUFFIX",
            "LUXORA_UI_TEST_RESET_SESSION",
        ] {
            if let value = environment[key] {
                app.launchEnvironment[key] = value
            }
        }
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 15))
        openSettings(in: app)
        let devicesButton = revealButton("you-settings-devices", in: app)
        XCTAssertTrue(devicesButton.isHittable)
        devicesButton.tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["you-devices-screen"].waitForExistence(timeout: 8)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["device-session-current-marker"]
                .waitForExistence(timeout: 12)
        )
        let remoteDevice = app.staticTexts[otherDeviceName]
        XCTAssertTrue(remoteDevice.waitForExistence(timeout: 12))
        attachScreenshot("live-10-devices-before-revoke", from: app)

        let revokeButtons = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "device-session-revoke-")
        )
        let revoke = try firstHittable(in: revokeButtons, timeout: 5)
        revoke.tap()
        let destructive = try firstHittable(
            in: app.buttons.matching(NSPredicate(format: "label == %@", "Завершить сеанс")),
            timeout: 5
        )
        destructive.tap()

        XCTAssertTrue(remoteDevice.waitForNonExistence(timeout: 12))
        XCTAssertTrue(app.descendants(matching: .any)["device-session-current-marker"].exists)
        attachScreenshot("live-11-devices-after-revoke", from: app)
    }

    @MainActor
    func testDebugPhonePasswordChallengeIsRussianSecureAndRevealable() {
        let app = russianApp()
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_UI_TEST_AUTH_PREVIEW"] = "1"
        app.launchEnvironment["LUXORA_UI_TEST_AUTH_STEP"] = "password"
        app.launchEnvironment["LUXORA_API_URL"] = "http://127.0.0.1:9"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = "ws://127.0.0.1:9/v1/realtime"
        app.launch()

        XCTAssertTrue(
            app.descendants(matching: .any)["auth-phone-password-screen"]
                .waitForExistence(timeout: 8)
        )
        XCTAssertTrue(app.staticTexts["Пароль учётной записи"].exists)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "одноразовый код")
        ).firstMatch.exists)

        let securePassword = app.secureTextFields["auth-phone-password"]
        XCTAssertTrue(securePassword.waitForExistence(timeout: 3))
        focusAndType("Luxora secure test password", into: securePassword)
        XCTAssertFalse(app.textFields["auth-phone-password"].exists)

        app.buttons["auth-phone-password-reveal"].tap()
        let revealedPassword = app.textFields["auth-phone-password"]
        XCTAssertTrue(revealedPassword.waitForExistence(timeout: 3))
        XCTAssertEqual(revealedPassword.value as? String, "Luxora secure test password")

        app.buttons["auth-phone-password-reveal"].tap()
        XCTAssertTrue(app.secureTextFields["auth-phone-password"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["auth-phone-password-submit"].isEnabled)
    }

    @MainActor
    func testOptInLivePhonePasswordLoginChangeAndDisable() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_LIVE_PHONE_PASSWORD_UI_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_PHONE_PASSWORD_UI_TEST=1 after seeding a phone password")
        }
        guard let verificationCode = secretFragments(
                prefixKey: "LUXORA_LIVE_PHONE_CODE_PREFIX",
                suffixKey: "LUXORA_LIVE_PHONE_CODE_SUFFIX",
                environment: environment
              ),
              verificationCode.joined().count == 6,
              let nationalNumber = environment["LUXORA_LIVE_PHONE_NATIONAL_NUMBER"],
              !nationalNumber.isEmpty,
              let currentPassword = secretFragments(
                prefixKey: "LUXORA_LIVE_PHONE_PASSWORD_PREFIX",
                suffixKey: "LUXORA_LIVE_PHONE_PASSWORD_SUFFIX",
                environment: environment
              ),
              currentPassword.joined().count >= 15,
              let replacementPassword = secretFragments(
                prefixKey: "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_PREFIX",
                suffixKey: "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_SUFFIX",
                environment: environment
              ),
              replacementPassword.joined().count >= 15
        else {
            throw XCTSkip("Provide the live phone, development code, and two strong passwords")
        }

        let app = russianApp()
        app.launchArguments += [
            "-luxora.onboarding.didCompletePermissionsPrimer", "YES",
        ]
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_API_URL"] = environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        app.launchEnvironment["LUXORA_UI_TEST_SECURE_AUTOFILL"] = "1"
        for key in [
            "LUXORA_LIVE_PHONE_NATIONAL_NUMBER",
            "LUXORA_LIVE_PHONE_CODE_PREFIX",
            "LUXORA_LIVE_PHONE_CODE_SUFFIX",
            "LUXORA_LIVE_PHONE_PASSWORD_PREFIX",
            "LUXORA_LIVE_PHONE_PASSWORD_SUFFIX",
            "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_PREFIX",
            "LUXORA_LIVE_PHONE_REPLACEMENT_PASSWORD_SUFFIX",
        ] {
            if let value = environment[key] {
                app.launchEnvironment[key] = value
            }
        }
        app.launch()

        let welcome = app.descendants(matching: .any)["auth-welcome-screen"]
        if welcome.waitForExistence(timeout: 4) {
            app.buttons["auth-start"].tap()
        }
        XCTAssertTrue(app.descendants(matching: .any)["auth-phone-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.textFields["auth-phone"].waitForExistence(timeout: 5))
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-phone-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-code-screen"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.textFields["auth-code"].waitForExistence(timeout: 5))
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-code-submit"].tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["auth-phone-password-screen"]
                .waitForExistence(timeout: 12)
        )
        attachScreenshot("live-12-password-required", from: app)

        let passwordField = app.secureTextFields["auth-phone-password"]
        focusAndType("wrong password", into: passwordField)
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-phone-password-submit"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["auth-error-password-invalid"]
                .waitForExistence(timeout: 12)
        )
        attachScreenshot("live-13-password-invalid", from: app)

        let correctedPassword = app.secureTextFields["auth-phone-password"]
        XCTAssertTrue(correctedPassword.waitForExistence(timeout: 5))
        assertSecureEntryLength(currentPassword.joined().count, in: correctedPassword)
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-phone-password-submit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 15))

        openSettings(in: app)
        let passwordSettings = revealButton("you-settings-phone-password", in: app)
        XCTAssertTrue(passwordSettings.isHittable)
        passwordSettings.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["phone-password-settings-screen"]
                .waitForExistence(timeout: 8)
        )
        let enabledStatus = app.staticTexts["phone-password-settings-status"]
        XCTAssertTrue(enabledStatus.waitForExistence(timeout: 12))
        XCTAssertTrue(enabledStatus.label.contains("Пароль включён"))
        attachScreenshot("live-14-password-settings-enabled", from: app)

        XCTAssertTrue(app.secureTextFields["phone-password-current"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["phone-password-new"].exists)
        XCTAssertTrue(app.secureTextFields["phone-password-confirmation"].exists)
        app.swipeUp()
        let save = app.buttons["phone-password-save"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        XCTAssertTrue(save.isEnabled)
        save.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["phone-password-settings-saved"]
                .waitForExistence(timeout: 12)
        )

        let replacementCurrent = app.secureTextFields["phone-password-current"]
        if !replacementCurrent.isHittable { app.swipeDown() }
        XCTAssertTrue(replacementCurrent.waitForExistence(timeout: 5))
        assertSecureEntryLength(replacementPassword.joined().count, in: replacementCurrent)
        app.swipeUp()
        let disable = app.buttons["phone-password-disable"]
        XCTAssertTrue(disable.waitForExistence(timeout: 5))
        XCTAssertTrue(disable.isEnabled)
        disable.tap()
        let destructive = try firstHittable(
            in: app.buttons.matching(NSPredicate(format: "label == %@", "Отключить пароль")),
            timeout: 5
        )
        destructive.tap()

        XCTAssertTrue(enabledStatus.waitForExistence(timeout: 12))
        XCTAssertTrue(enabledStatus.label.contains("Пароль не настроен"))
        attachScreenshot("live-15-password-settings-disabled", from: app)
    }

    @MainActor
    func testOptInLiveAvatarUploadPersistsReloadAndClears() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_LIVE_AVATAR_UI_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_AVATAR_UI_TEST=1 with a disposable live account")
        }
        guard environment["LUXORA_DEBUG_AUTOMATION"] == "1",
              let username = environment["LUXORA_DEBUG_USERNAME"], !username.isEmpty,
              secretFragments(
                prefixKey: "LUXORA_DEBUG_PASSWORD_PREFIX",
                suffixKey: "LUXORA_DEBUG_PASSWORD_SUFFIX",
                environment: environment
              ) != nil
        else {
            throw XCTSkip("Provide fragmented credentials for a disposable live account")
        }

        let app = russianApp()
        app.launchArguments += [
            "-luxora.onboarding.didCompletePermissionsPrimer", "YES",
        ]
        app.launchEnvironment["LUXORA_API_URL"] = environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        for key in [
            "LUXORA_DEBUG_AUTOMATION",
            "LUXORA_DEBUG_USERNAME",
            "LUXORA_DEBUG_PASSWORD_PREFIX",
            "LUXORA_DEBUG_PASSWORD_SUFFIX",
            "LUXORA_UI_TEST_RESET_SESSION",
        ] {
            if let value = environment[key] {
                app.launchEnvironment[key] = value
            }
        }
        app.launchEnvironment["LUXORA_UI_TEST_AVATAR_FIXTURE"] = "1"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 15))
        openSettings(in: app)
        let profile = revealButton("settings-profile", in: app)
        XCTAssertTrue(profile.isHittable)
        profile.tap()
        XCTAssertTrue(app.descendants(matching: .any)["own-profile-screen"].waitForExistence(timeout: 8))
        app.buttons["own-profile-edit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["profile-edit-screen"].waitForExistence(timeout: 8))

        XCTAssertTrue(app.descendants(matching: .any)["profile-avatar-crop"].waitForExistence(timeout: 8))
        attachScreenshot("live-16-avatar-crop", from: app)
        app.buttons["profile-avatar-crop-done"].tap()
        let upload = app.buttons["profile-avatar-upload"]
        XCTAssertTrue(upload.waitForExistence(timeout: 8))
        XCTAssertTrue(upload.isEnabled)
        upload.tap()

        let clear = app.buttons["profile-avatar-clear"]
        XCTAssertTrue(clear.waitForExistence(timeout: 30))
        XCTAssertFalse(app.descendants(matching: .any)["profile-avatar-error"].exists)
        attachScreenshot("live-17-avatar-saved", from: app)

        app.terminate()
        let restored = russianApp()
        restored.launchArguments += [
            "-luxora.onboarding.didCompletePermissionsPrimer", "YES",
        ]
        restored.launchEnvironment["LUXORA_API_URL"] = environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        restored.launchEnvironment["LUXORA_REALTIME_URL"] = environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        restored.launch()

        XCTAssertTrue(
            restored.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 15)
        )
        openSettings(in: restored)
        let restoredProfile = revealButton("settings-profile", in: restored)
        XCTAssertTrue(restoredProfile.isHittable)
        restoredProfile.tap()
        XCTAssertTrue(
            restored.descendants(matching: .any)["own-profile-screen"].waitForExistence(timeout: 8)
        )
        restored.buttons["own-profile-edit"].tap()
        XCTAssertTrue(
            restored.descendants(matching: .any)["profile-edit-screen"].waitForExistence(timeout: 8)
        )
        let persistedClear = restored.buttons["profile-avatar-clear"]
        XCTAssertTrue(persistedClear.waitForExistence(timeout: 15))
        attachScreenshot("live-18-avatar-restored", from: restored)

        persistedClear.tap()
        let destructive = try firstHittable(
            in: restored.buttons.matching(NSPredicate(format: "label == %@", "Удалить фото")),
            timeout: 5
        )
        destructive.tap()
        XCTAssertTrue(persistedClear.waitForNonExistence(timeout: 20))
        XCTAssertFalse(restored.descendants(matching: .any)["profile-avatar-error"].exists)
        attachScreenshot("live-19-avatar-cleared", from: restored)
    }

    @MainActor
    private func openSettings(in app: XCUIApplication) {
        let settingsTab = app.tabBars.buttons["Настройки"]
        XCTAssertTrue(settingsTab.waitForExistence(timeout: 5))
        settingsTab.tap()
        let settingsScreen = app.descendants(matching: .any)["settings-screen"]
        if !settingsScreen.waitForExistence(timeout: 3) {
            app.tabBars.buttons["Настройки"].tap()
        }
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 5))
    }

    @MainActor
    private func revealButton(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        let button = app.buttons[identifier]
        for _ in 0..<8 where !button.exists || !button.isHittable {
            app.swipeUp()
        }
        return button
    }

    @MainActor
    private func firstHittable(
        in query: XCUIElementQuery,
        timeout: TimeInterval
    ) throws -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for index in 0..<query.count {
                let candidate = query.element(boundBy: index)
                if candidate.exists, candidate.isHittable {
                    return candidate
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        throw DeviceSessionsUITestError.noHittableButton
    }

    @MainActor
    private func attachScreenshot(_ name: String, from app: XCUIApplication) {
        XCTAssertEqual(app.state, .runningForeground)
        Thread.sleep(forTimeInterval: 1.0)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func focusAndType(_ text: String, into element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        element.tap()
        element.typeText(text)
    }

    @MainActor
    private func focusAndType(_ fragments: [String], into element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        for fragment in fragments {
            element.tap()
            element.typeText(fragment)
        }
    }

    @MainActor
    private func replaceText(with text: String, in element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        element.tap()
        element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 160))
        element.typeText(text)
    }

    @MainActor
    private func replaceText(with fragments: [String], in element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        element.tap()
        element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 160))
        for fragment in fragments {
            element.tap()
            element.typeText(fragment)
        }
    }

    @MainActor
    private func assertSecureEntryLength(_ expectedCount: Int, in element: XCUIElement) {
        let obscuredValue = element.value as? String
        XCTAssertEqual(
            obscuredValue?.count,
            expectedCount,
            "Secure field must preserve every character across a retry"
        )
    }

    private func secretFragments(
        prefixKey: String,
        suffixKey: String,
        environment: [String: String]
    ) -> [String]? {
        guard let prefix = environment[prefixKey], !prefix.isEmpty,
              let suffix = environment[suffixKey], !suffix.isEmpty
        else { return nil }
        return [prefix, suffix]
    }

    @MainActor
    private func russianApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-AppleLanguages", "(ru-RU)",
            "-AppleLocale", "ru_RU",
        ]
        return app
    }
}

private enum DeviceSessionsUITestError: Error {
    case noHittableButton
}
