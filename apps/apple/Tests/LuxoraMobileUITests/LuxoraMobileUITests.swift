import XCTest

final class LuxoraMobileUITests: XCTestCase {
    private let primaryConversationID = "8f0f19fe-d881-4ddd-8467-37065adf37d8"
    private let channelConversationID = "62499623-29d3-453c-a788-94d402f295c7"
    private let writableTeamConversationID = "466bb23c-21c9-464b-b761-04686df7a060"
    private let teamFolderID = "f1300000-0000-4000-8000-000000000002"
    private let lastStatusParticipantID = "97c4bc5f-38d9-48d4-8f57-2ff1565f2d4a"
    private let yanaConversationID = "b91d4fd0-e45b-47f7-a18c-e59fa6a88a2f"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testProductionLaunchUsesRussianPhoneAuthenticationAndNoFixtureEntry() {
        let app = russianApp()
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_API_URL"] = "http://127.0.0.1:9"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = "ws://127.0.0.1:9/v1/realtime"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["auth-welcome-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Luxora"].exists)
        XCTAssertTrue(app.buttons["auth-start"].exists)
        XCTAssertFalse(app.textFields["auth-username"].exists)
        XCTAssertFalse(app.secureTextFields["auth-password"].exists)
        XCTAssertFalse(app.buttons["Войти"].exists)
        XCTAssertFalse(app.buttons["Создать аккаунт"].exists)
        XCTAssertFalse(app.buttons["Локальный предпросмотр"].exists)

        app.buttons["auth-start"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["auth-phone-screen"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["auth-country"].exists)
        XCTAssertTrue(app.textFields["auth-phone"].exists)
        XCTAssertTrue(app.staticTexts["Luxora не имитирует отправку SMS или вход без ответа сервера."].exists)
        XCTAssertFalse(app.textFields["auth-code"].exists)

        let phone = app.textFields["auth-phone"]
        phone.tap()
        phone.typeText("9991234218")
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-phone-submit"].tap()
        let unavailable = app.descendants(matching: .any)["auth-error-network"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 4))
        XCTAssertTrue(unavailable.label.contains("Нет связи с сервером"))
        XCTAssertEqual(app.buttons["auth-phone-submit"].label, "Повторить")
        app.buttons["auth-phone-submit"].tap()
        XCTAssertTrue(unavailable.waitForExistence(timeout: 4))
        XCTAssertFalse(app.descendants(matching: .any)["auth-code-screen"].exists)
    }

    @MainActor
    func testDebugOnlyPhoneAuthenticationPreviewTraversesOTPAndProfileWithoutServerClaims() {
        let app = russianApp()
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_UI_TEST_AUTH_PREVIEW"] = "1"
        app.launchEnvironment["LUXORA_UI_TEST_AUTH_STEP"] = "phone"
        app.launchEnvironment["LUXORA_API_URL"] = "http://127.0.0.1:9"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = "ws://127.0.0.1:9/v1/realtime"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["auth-phone-screen"].waitForExistence(timeout: 8))
        app.buttons["auth-country"].tap()
        XCTAssertTrue(app.navigationBars["Страна"].waitForExistence(timeout: 3))
        let countrySearch = app.searchFields.firstMatch
        XCTAssertTrue(countrySearch.exists)
        countrySearch.tap()
        countrySearch.typeText("Германия")
        let germany = app.buttons["auth-country-DE"]
        XCTAssertTrue(germany.waitForExistence(timeout: 3))
        germany.tap()
        XCTAssertTrue(app.descendants(matching: .any)["auth-phone-screen"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["auth-country"].label.contains("Германия"))

        let phone = app.textFields["auth-phone"]
        XCTAssertTrue(phone.exists)
        phone.tap()
        phone.typeText("9991234218")
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-phone-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-code-screen"].waitForExistence(timeout: 3))
        let code = app.textFields["auth-code"]
        XCTAssertTrue(code.exists)
        code.tap()
        code.typeText("123456")
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-code-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-profile-screen"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["auth-avatar-picker"].exists)
        let name = app.textFields["auth-display-name"]
        XCTAssertTrue(name.exists)
        name.tap()
        name.typeText("Егор Flenym")
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-profile-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-username-screen"].waitForExistence(timeout: 3))
        let username = app.textFields["auth-username"]
        XCTAssertTrue(username.exists)
        username.tap()
        username.typeText("flenym")
        app.buttons["auth-keyboard-done"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["auth-username-taken"].waitForExistence(timeout: 3))
        app.buttons["auth-username-suggestion-flenym_1"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["auth-username-available"].waitForExistence(timeout: 3))
        app.buttons["auth-username-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-permissions-screen"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["auth-permissions-later"].exists)
        app.buttons["auth-permissions-later"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-sync-screen"].waitForExistence(timeout: 3))
        app.buttons["auth-sync-continue"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-completed-screen"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Код не отправлялся и аккаунт не создавался. Это DEBUG-only сценарий для Xcode и скриншотов."].exists)
    }

    @MainActor
    func testOptInLivePhoneRegistrationSynchronizesIntoChats() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_LIVE_PHONE_UI_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_PHONE_UI_TEST=1 while the configured phone-auth API is running")
        }
        guard let verificationCode = environment["LUXORA_LIVE_PHONE_CODE"],
              verificationCode.count == 6
        else {
            throw XCTSkip("Set the development/provider verification code in LUXORA_LIVE_PHONE_CODE")
        }

        let uniqueSuffix = String(
            format: "%07d",
            Int(Date().timeIntervalSince1970) % 10_000_000
        )
        let nationalNumber = environment["LUXORA_LIVE_PHONE_NATIONAL_NUMBER"]
            ?? "999\(uniqueSuffix)"
        let username = environment["LUXORA_LIVE_PHONE_USERNAME"]
            ?? "ios_\(uniqueSuffix)"

        let app = russianApp()
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_API_URL"] = environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        app.launch()

        let welcome = app.descendants(matching: .any)["auth-welcome-screen"]
        if welcome.waitForExistence(timeout: 4) {
            app.buttons["auth-start"].tap()
        }
        XCTAssertTrue(app.descendants(matching: .any)["auth-phone-screen"].waitForExistence(timeout: 8))
        attachScreenshot("live-01-phone", from: app)

        let phone = app.textFields["auth-phone"]
        focusAndType(nationalNumber, into: phone)
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-phone-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-code-screen"].waitForExistence(timeout: 12))
        attachScreenshot("live-02-otp", from: app)
        let code = app.textFields["auth-code"]
        focusAndType(verificationCode, into: code)
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-code-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-profile-screen"].waitForExistence(timeout: 12))
        attachScreenshot("live-03-profile", from: app)
        let displayName = app.textFields["auth-display-name"]
        focusAndType("Flenym iPhone", into: displayName)
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-profile-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-username-screen"].waitForExistence(timeout: 5))
        let usernameField = app.textFields["auth-username"]
        focusAndType(username, into: usernameField)
        app.buttons["auth-keyboard-done"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["auth-username-available"].waitForExistence(timeout: 10))
        attachScreenshot("live-04-username-available", from: app)
        app.buttons["auth-username-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-permissions-screen"].waitForExistence(timeout: 20))
        attachScreenshot("live-05-permissions", from: app)
        app.buttons["auth-permissions-later"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["Чатов пока нет"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Не найдено"].exists)
        attachScreenshot("live-06-chats", from: app)
    }

    @MainActor
    func testOptInLiveRestoredSessionOpensSettingsWithoutFixtures() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_LIVE_PHONE_UI_TEST"] == "1" else {
            throw XCTSkip("Set LUXORA_LIVE_PHONE_UI_TEST=1 after the live phone-registration test")
        }

        let app = russianApp()
        app.launchEnvironment["LUXORA_API_URL"] = environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        app.launchEnvironment["LUXORA_REALTIME_URL"] = environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 12))
        let settingsTab = app.tabBars.buttons["Настройки"]
        XCTAssertTrue(settingsTab.waitForExistence(timeout: 5))
        XCTAssertTrue(settingsTab.isHittable)
        Thread.sleep(forTimeInterval: 1.0)
        settingsTab.tap()
        let settingsScreen = app.descendants(matching: .any)["settings-screen"]
        if !settingsScreen.waitForExistence(timeout: 3) {
            // The iOS 26 floating tab bar can still be finishing its launch
            // morph after the Chats root exists. Re-resolve and tap once more.
            app.tabBars.buttons["Настройки"].tap()
        }
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Flenym iPhone"].waitForExistence(timeout: 3))
        attachScreenshot("live-07-restored-settings", from: app)

        app.buttons["settings-profile"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["own-profile-screen"].waitForExistence(timeout: 5))
        app.buttons["own-profile-edit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["profile-edit-screen"].waitForExistence(timeout: 5))

        let name = app.textFields["profile-edit-name"]
        focusAndType(
            String(repeating: XCUIKeyboardKey.delete.rawValue, count: 32) + "Flenym iPhone Live",
            into: name
        )
        let bio = app.descendants(matching: .any)["profile-edit-bio"]
        focusAndType("Профиль сохранён сервером Luxora Beta-0.1", into: bio)
        app.buttons["profile-edit-save"].tap()

        XCTAssertTrue(app.staticTexts["Flenym iPhone Live"].waitForExistence(timeout: 12))
        XCTAssertTrue(
            app.staticTexts["Профиль сохранён сервером Luxora Beta-0.1"].waitForExistence(timeout: 3)
        )
        XCTAssertFalse(app.descendants(matching: .any)["profile-edit-screen"].exists)
        attachScreenshot("live-08-profile-patch", from: app)

        app.terminate()
        let persisted = russianApp()
        persisted.launchEnvironment["LUXORA_API_URL"] = environment["LUXORA_API_URL"]
            ?? "http://127.0.0.1:8080"
        persisted.launchEnvironment["LUXORA_REALTIME_URL"] = environment["LUXORA_REALTIME_URL"]
            ?? "ws://127.0.0.1:8080/v1/realtime"
        persisted.launch()
        XCTAssertTrue(persisted.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 12))
        persisted.tabBars.buttons["Настройки"].tap()
        XCTAssertTrue(persisted.staticTexts["Flenym iPhone Live"].waitForExistence(timeout: 5))
        attachScreenshot("live-09-profile-persisted", from: persisted)
    }

    @MainActor
    func testOptInLiveChatPreferencesMuteArchiveAndRestoreUseConfirmedServerState() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["LUXORA_LIVE_CHAT_PREFERENCES_UI_TEST"] == "1",
              environment["LUXORA_DEBUG_AUTOMATION"] == "1",
              let chatID = environment["LUXORA_LIVE_CHAT_ID"],
              !chatID.isEmpty
        else {
            throw XCTSkip("Provide a disposable live account and chat for preference UI proof")
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
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 15))
        let rowIdentifier = "inbox-row-\(chatID.lowercased())"
        let row = app.buttons[rowIdentifier]
        XCTAssertTrue(row.waitForExistence(timeout: 15))

        row.swipeRight()
        let mute = app.buttons["Без звука"]
        XCTAssertTrue(mute.waitForExistence(timeout: 4))
        mute.tap()
        let muted = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", "уведомления выключены"),
            object: row
        )
        XCTAssertEqual(XCTWaiter.wait(for: [muted], timeout: 12), .completed)
        attachScreenshot("live-20-chat-muted-confirmed", from: app)

        row.swipeLeft()
        let archive = app.buttons["В архив"]
        XCTAssertTrue(archive.waitForExistence(timeout: 4))
        archive.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 12))

        let archiveFolder = app.buttons["chat-folder-rail-archive"]
        XCTAssertTrue(archiveFolder.waitForExistence(timeout: 4))
        archiveFolder.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 12))
        attachScreenshot("live-21-chat-archive-confirmed", from: app)

        row.swipeLeft()
        let restore = app.buttons["Вернуть"]
        XCTAssertTrue(restore.waitForExistence(timeout: 4))
        restore.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 12))
        app.buttons["chat-folder-rail-all"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 12))
        attachScreenshot("live-22-chat-restored-confirmed", from: app)
    }

    @MainActor
    func testRussianFourTabShellAndSeparateSearchKeepSpacesInsideChats() {
        let app = messengerApp()
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 8))
        assertRootShellVisible(in: app)
        XCTAssertFalse(app.tabBars.buttons["Пространства"].exists)

        app.tabBars.buttons["Контакты"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["contacts-screen"].waitForExistence(timeout: 3))

        app.tabBars.buttons["Звонки"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["calls-screen"].waitForExistence(timeout: 3))
        app.buttons["calls-start-gated"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["feature-status-sheet"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Сервер пока не поддерживает сигналинг звонков."].exists)
        dismissFeatureStatusSheet(in: app)

        app.tabBars.buttons["Чаты"].tap()
        app.buttons["chats-spaces"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["spaces-screen"].waitForExistence(timeout: 3))
        assertRootShellHidden(in: app)
        app.buttons["spaces-create"].tap()
        app.buttons["Создать группу"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["community-create-screen"].waitForExistence(timeout: 3))
        app.buttons["Отмена"].tap()
    }

    @MainActor
    func testChatsUsesNoResultsStateOnlyForANonemptyQuery() {
        let app = messengerApp()
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.descendants(matching: .any)["inbox-empty-search"].exists)

        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 3))
        search.tap()
        search.typeText("luxora-no-such-conversation")

        let noResults = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Нет результатов")
        ).firstMatch
        XCTAssertTrue(noResults.waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Чатов пока нет"].exists)
    }

    @MainActor
    func testFolderRailScrollsBothDirectionsFiltersAndPreservesPositionAcrossStoreUpdate() {
        let app = messengerApp()
        app.launch()

        let rail = app.descendants(matching: .any)["chat-folder-rail"]
        XCTAssertTrue(rail.waitForExistence(timeout: 8))
        XCTAssertEqual(rail.label, "Папки чатов, горизонтальный список")

        let channels = app.buttons["chat-folder-rail-\(teamFolderID)"]
        for _ in 0..<3 where !channels.isHittable {
            rail.swipeLeft()
        }
        XCTAssertTrue(channels.isHittable)
        channels.tap()
        XCTAssertTrue(waitUntil(timeout: 3) {
            channels.isSelected || (channels.value as? String) == "Выбрано"
        })

        let channelRow = app.buttons["inbox-row-\(channelConversationID)"]
        XCTAssertTrue(channelRow.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["inbox-row-\(primaryConversationID)"].exists)

        // This channel is intentionally member/read-only. Keep it as proof
        // that an explicit include beats excludeMuted, then use the owner
        // group to exercise a real message-backed store update.
        let writableTeamRow = app.buttons["inbox-row-\(writableTeamConversationID)"]
        XCTAssertTrue(writableTeamRow.waitForExistence(timeout: 3))
        writableTeamRow.tap()

        let composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        let dismissKeyboard = app.buttons["message-composer-keyboard-dismiss"]
        XCTAssertTrue(dismissKeyboard.waitForExistence(timeout: 3))
        attachScreenshot("composer-keyboard-dismiss-inline", from: app)
        dismissKeyboard.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        composer.tap()
        composer.typeText("Обновление списка")
        app.buttons["message-send"].tap()
        XCTAssertTrue(app.staticTexts["Обновление списка"].waitForExistence(timeout: 3))
        app.navigationBars.buttons["Чаты"].tap()

        XCTAssertTrue(channels.waitForExistence(timeout: 3))
        XCTAssertTrue(channels.isHittable)
        XCTAssertTrue(waitUntil(timeout: 3) {
            channels.isSelected || (channels.value as? String) == "Выбрано"
        })

        for _ in 0..<3 where !app.buttons["chat-folder-rail-all"].isHittable {
            rail.swipeRight()
        }
        XCTAssertTrue(app.buttons["chat-folder-rail-all"].isHittable)
        app.terminate()

        let restored = messengerApp(initialFolder: "channels")
        restored.launch()
        let restoredChannels = restored.buttons["chat-folder-rail-\(teamFolderID)"]
        XCTAssertTrue(restoredChannels.waitForExistence(timeout: 8))
        XCTAssertTrue(restoredChannels.isHittable)
        XCTAssertTrue(waitUntil(timeout: 3) {
            restoredChannels.isSelected || (restoredChannels.value as? String) == "Выбрано"
        })
        XCTAssertTrue(restored.buttons["inbox-row-\(channelConversationID)"].exists)
    }

    @MainActor
    func testStatusRailScrollsBothDirectionsAndOnlyOpensTruthfulGate() {
        let app = messengerApp(showStatusRail: true)
        app.launch()

        let rail = app.descendants(matching: .any)["status-story-rail"]
        XCTAssertTrue(rail.waitForExistence(timeout: 8))
        XCTAssertEqual(rail.label, "Истории и статусы, горизонтальный список")

        let lastStatus = app.buttons["status-item-\(lastStatusParticipantID)"]
        for _ in 0..<8 where !lastStatus.isHittable {
            rail.swipeLeft()
        }
        XCTAssertTrue(lastStatus.isHittable)
        lastStatus.tap()

        XCTAssertTrue(app.descendants(matching: .any)["feature-status-sheet"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Истории и статусы"].exists)
        let truthfulDetail = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Сервер пока не поддерживает истории и статусы.")
        ).firstMatch
        XCTAssertTrue(truthfulDetail.exists)
        dismissFeatureStatusSheet(in: app)

        let myStatus = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Моя история")).firstMatch
        for _ in 0..<6 {
            rail.swipeRight()
        }
        XCTAssertTrue(rail.exists)
        XCTAssertTrue(myStatus.exists)
    }

    @MainActor
    func testDirectConversationUsesRemoteTextSemanticsLockedMediaAndNoBottomShell() {
        let app = messengerApp()
        app.launch()

        let row = app.buttons["inbox-row-\(primaryConversationID)"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()

        XCTAssertTrue(app.descendants(matching: .any)["conversation-truth-state"].waitForExistence(timeout: 4))
        assertRootShellHidden(in: app)

        let composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        let send = app.buttons["message-send"]
        XCTAssertFalse(send.isEnabled)

        composer.tap()
        composer.typeText("Сообщение UI-теста")
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(app.staticTexts["Сообщение UI-теста"].waitForExistence(timeout: 3))

        app.buttons["message-attachment"].tap()
        XCTAssertTrue(app.staticTexts["Медиа и файлы"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Сервер принимает загрузки, но отправка вложений на iPhone ещё не включена."].exists)
    }

    @MainActor
    func testSynchronizedDraftLoadingAutosaveCrossChatRestoreRateLimitRetryKeyboardAndSend() {
        let primaryDraft = "Черновик для синхронизации"
        let teamDraft = "Отдельный черновик команды"
        let app = messengerApp()
        app.launchEnvironment["LUXORA_UI_TEST_DRAFT_SCENARIO"] = "autosave-rate-limit-once"
        app.launch()

        let primaryRow = app.buttons["inbox-row-\(primaryConversationID)"]
        XCTAssertTrue(primaryRow.waitForExistence(timeout: 8))
        primaryRow.tap()

        var loading = app.descendants(matching: .any)["message-draft-sync-loading"]
        XCTAssertTrue(loading.waitForExistence(timeout: 3))
        XCTAssertTrue(loading.waitForNonExistence(timeout: 4))

        var composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        focusAndType(primaryDraft, into: composer)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(loading.exists, "Autosave должен быть видимо активен во время ввода")
        let dismissKeyboard = app.buttons["message-composer-keyboard-dismiss"]
        XCTAssertTrue(dismissKeyboard.waitForExistence(timeout: 3))
        XCTAssertTrue(dismissKeyboard.isHittable)
        dismissKeyboard.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))

        let failure = app.descendants(matching: .any)["message-draft-sync-failure"]
        // Retry-After is intentionally short. Poll without XCTest's one-second
        // existence cadence so the production failure state remains observable.
        XCTAssertTrue(waitUntil(timeout: 5) { failure.exists })
        XCTAssertTrue(
            app.staticTexts["Слишком много сохранений. Автоповтор через 3 с."].exists
        )
        let retry = app.buttons["message-draft-sync-retry"]
        XCTAssertTrue(retry.exists)
        XCTAssertTrue(retry.isHittable)
        composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertEqual(composer.value as? String, primaryDraft)
        attachScreenshot("drafts-01-rate-limit-retry", from: app, settleTime: 0)

        retry.tap()
        XCTAssertTrue(failure.waitForNonExistence(timeout: 5))
        XCTAssertTrue(loading.waitForNonExistence(timeout: 5))
        composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertEqual(composer.value as? String, primaryDraft)

        app.navigationBars.buttons["Чаты"].tap()
        let teamRow = app.buttons["inbox-row-\(writableTeamConversationID)"]
        XCTAssertTrue(teamRow.waitForExistence(timeout: 4))
        teamRow.tap()
        loading = app.descendants(matching: .any)["message-draft-sync-loading"]
        XCTAssertTrue(loading.waitForExistence(timeout: 3))
        XCTAssertTrue(loading.waitForNonExistence(timeout: 4))

        composer = app.descendants(matching: .any)["message-composer"]
        focusAndType(teamDraft, into: composer)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(loading.exists, "Autosave команды должен быть видимо активен во время ввода")
        app.buttons["message-composer-keyboard-dismiss"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        XCTAssertTrue(loading.waitForNonExistence(timeout: 4))
        XCTAssertFalse(app.descendants(matching: .any)["message-draft-sync-failure"].exists)

        app.navigationBars.buttons["Чаты"].tap()
        XCTAssertTrue(primaryRow.waitForExistence(timeout: 4))
        primaryRow.tap()
        loading = app.descendants(matching: .any)["message-draft-sync-loading"]
        XCTAssertTrue(loading.waitForExistence(timeout: 3))
        XCTAssertTrue(loading.waitForNonExistence(timeout: 4))

        composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertEqual(composer.value as? String, primaryDraft)
        XCTAssertNotEqual(composer.value as? String, teamDraft)
        XCTAssertTrue(app.buttons["message-send"].isEnabled)
        attachScreenshot("drafts-02-cross-chat-restored", from: app)

        app.buttons["message-send"].tap()
        XCTAssertTrue(app.staticTexts[primaryDraft].waitForExistence(timeout: 4))
        XCTAssertTrue(loading.waitForExistence(timeout: 3))
        XCTAssertTrue(loading.waitForNonExistence(timeout: 4))
        XCTAssertFalse(app.buttons["message-send"].isEnabled)
        composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertNotEqual(composer.value as? String, primaryDraft)
        attachScreenshot("drafts-03-sent-and-cleared", from: app)
    }

    @MainActor
    func testMessageContextActionsReplyEditAndDeleteUseServerShapedState() {
        let app = messengerApp()
        app.launchEnvironment["LUXORA_UI_TEST_MESSAGE_ACTIONS"] = "1"
        app.launch()

        let row = app.buttons["inbox-row-\(primaryConversationID)"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()

        let incoming = app.descendants(matching: .any)["message-8c5f373e-ff2d-44ed-948f-79b5306fe695"]
        XCTAssertTrue(incoming.waitForExistence(timeout: 4))
        incoming.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Ответить"].waitForExistence(timeout: 3))
        app.buttons["Ответить"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["message-composer-mode"].waitForExistence(timeout: 3))

        let composer = app.descendants(matching: .any)["message-composer"]
        composer.tap()
        composer.typeText("Ответ из контекстного меню")
        app.buttons["message-send"].tap()
        XCTAssertTrue(app.staticTexts["Ответ из контекстного меню"].waitForExistence(timeout: 4))

        let outgoingID = "message-fc4e02b2-d1ce-49b1-8025-86db6f66e96f"
        let outgoing = app.descendants(matching: .any)[outgoingID]
        XCTAssertTrue(outgoing.waitForExistence(timeout: 4))
        outgoing.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Изменить"].waitForExistence(timeout: 3))
        app.buttons["Изменить"].tap()
        XCTAssertTrue(app.staticTexts["Редактирование"].waitForExistence(timeout: 3))

        composer.tap()
        composer.typeKey("a", modifierFlags: .command)
        composer.typeText("Сообщение изменено на сервере")
        app.buttons["message-send"].tap()
        XCTAssertTrue(app.staticTexts["Сообщение изменено на сервере"].waitForExistence(timeout: 4))

        outgoing.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Удалить"].waitForExistence(timeout: 3))
        app.buttons["Удалить"].tap()
        XCTAssertTrue(app.buttons["Удалить для всех"].waitForExistence(timeout: 3))
        app.buttons["Удалить для всех"].tap()
        XCTAssertTrue(app.staticTexts["Сообщение удалено"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["Ответить"].exists)
    }

    @MainActor
    func testMessagePinAndForwardProduceVisibleConfirmedDestinations() {
        let savedConversationID = "1a7c9a6a-4dca-46ca-b417-7dc2f8f85e60"
        let messageID = "message-8c5f373e-ff2d-44ed-948f-79b5306fe695"
        let app = messengerApp(destination: "conversation")
        app.launchEnvironment["LUXORA_UI_TEST_CONVERSATION_ID"] = primaryConversationID
        app.launchEnvironment["LUXORA_UI_TEST_MESSAGE_ACTIONS"] = "1"
        app.launch()

        let message = app.descendants(matching: .any)[messageID]
        XCTAssertTrue(message.waitForExistence(timeout: 8))

        message.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Закрепить"].waitForExistence(timeout: 3))
        app.buttons["Закрепить"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation-pinned-message"].waitForExistence(timeout: 4))

        message.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Переслать"].waitForExistence(timeout: 3))
        app.buttons["Переслать"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["forward-destination-sheet"].waitForExistence(timeout: 4))
        let saved = app.buttons["forward-destination-\(savedConversationID)"]
        XCTAssertTrue(saved.waitForExistence(timeout: 3))
        saved.tap()

        app.navigationBars.buttons["Чаты"].tap()
        let savedRow = app.buttons["inbox-row-\(savedConversationID)"]
        if !savedRow.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(savedRow.waitForExistence(timeout: 4))
        savedRow.tap()
        XCTAssertTrue(app.staticTexts["Новая навигация стала спокойнее ✦"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.descendants(matching: .any)["message-forward-provenance"].exists)
    }

    @MainActor
    func testMessageRequestsCreateDismissAndAcceptUseConfirmedServerShapedState() {
        let firstIncomingID = "12121212-1212-4212-8212-121212121212"
        let secondIncomingID = "13131313-1313-4313-8313-131313131313"
        let app = messengerApp(destination: "message-requests")
        app.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] = "1"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["message-requests-screen"].waitForExistence(timeout: 8))
        assertRootShellHidden(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["message-request-row-\(firstIncomingID)"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.descendants(matching: .any)["message-request-row-\(secondIncomingID)"].exists)
        XCTAssertTrue(app.staticTexts["Мария Лебедева"].exists)
        attachScreenshot("requests-01-incoming", from: app)

        let direction = app.segmentedControls["message-requests-direction"]
        XCTAssertTrue(direction.waitForExistence(timeout: 3))
        direction.buttons["Исходящие"].tap()
        XCTAssertTrue(app.staticTexts["Алексей Романов"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Ожидает"].exists)
        attachScreenshot("requests-02-outgoing", from: app)

        app.buttons["message-request-new"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["message-request-new-sheet"].waitForExistence(timeout: 3))
        let username = app.textFields["message-request-username"]
        focusAndType("alexey_romanov", into: username)
        app.buttons["message-request-lookup"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["message-request-recipient"].waitForExistence(timeout: 3))
        let firstMessage = app.descendants(matching: .any)["message-request-body"]
        focusAndType("Здравствуйте! Это новый подтверждённый запрос Luxora.", into: firstMessage)
        attachScreenshot("requests-03-new-confirmed-recipient", from: app)
        app.buttons["message-request-send"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["message-request-new-sheet"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Здравствуйте! Это новый подтверждённый запрос Luxora."].waitForExistence(timeout: 3))

        direction.buttons["Входящие"].tap()
        app.buttons["message-request-dismiss-\(secondIncomingID)"].tap()
        let confirmDismissal = app.sheets.buttons["Удалить"].firstMatch
        XCTAssertTrue(confirmDismissal.waitForExistence(timeout: 3))
        attachScreenshot("requests-04-private-dismiss-confirm", from: app)
        confirmDismissal.tap()
        XCTAssertFalse(
            app.descendants(matching: .any)["message-request-row-\(secondIncomingID)"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertTrue(app.descendants(matching: .any)["message-request-row-\(firstIncomingID)"].exists)

        app.buttons["message-request-accept-\(firstIncomingID)"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Мария Лебедева"].exists)
        XCTAssertTrue(
            app.descendants(matching: .any)["message-composer"]
                .waitForExistence(timeout: 4)
        )
        attachScreenshot("requests-05-accepted-chat", from: app)
    }

    @MainActor
    func testMessageRequestPrivacyControlsPersistOnlyAfterServerConfirmation() {
        let app = messengerApp(destination: "you-privacy")
        app.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] = "1"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["you-privacy-screen"].waitForExistence(timeout: 8))
        let discoverable = app.switches["privacy-username-discoverable"]
        XCTAssertTrue(discoverable.waitForExistence(timeout: 4))
        XCTAssertTrue(app.descendants(matching: .any)["privacy-settings-confirmed"].exists)
        discoverable.tap()
        XCTAssertTrue(app.descendants(matching: .any)["privacy-settings-confirmed"].waitForExistence(timeout: 3))

        let policy = app.buttons["privacy-message-requests-policy"]
        XCTAssertTrue(policy.exists)
        policy.tap()
        XCTAssertTrue(app.buttons["Никто"].waitForExistence(timeout: 3))
        app.buttons["Никто"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["privacy-settings-confirmed"].waitForExistence(timeout: 3))
        XCTAssertTrue(policy.label.contains("Никто") || policy.value as? String == "Никто")
        attachScreenshot("requests-06-privacy-confirmed", from: app)
    }

    @MainActor
    func testMessageRequestFailuresRemainVisibleAndRetryToConfirmedState() {
        let requestID = "12121212-1212-4212-8212-121212121212"

        let list = messengerApp(destination: "message-requests")
        list.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] = "1"
        list.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUEST_FAILURE"] = "list-once"
        list.launch()
        XCTAssertTrue(list.descendants(matching: .any)["message-requests-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(list.descendants(matching: .any)["remote-failure-row"].waitForExistence(timeout: 4))
        XCTAssertTrue(list.staticTexts["Не удалось обновить входящие запросы"].exists)
        attachScreenshot("requests-07-load-error", from: list)
        list.buttons["Повторить"].tap()
        XCTAssertTrue(list.descendants(matching: .any)["message-request-row-\(requestID)"].waitForExistence(timeout: 4))
        XCTAssertFalse(list.descendants(matching: .any)["remote-failure-row"].exists)
        list.terminate()

        let mutation = messengerApp(destination: "message-requests")
        mutation.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] = "1"
        mutation.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUEST_FAILURE"] = "accept-once"
        mutation.launch()
        XCTAssertTrue(mutation.buttons["message-request-accept-\(requestID)"].waitForExistence(timeout: 8))
        mutation.buttons["message-request-accept-\(requestID)"].tap()
        XCTAssertTrue(
            mutation.descendants(matching: .any)["message-request-mutation-error-\(requestID)"]
                .waitForExistence(timeout: 4)
        )
        XCTAssertTrue(mutation.descendants(matching: .any)["message-request-row-\(requestID)"].exists)
        attachScreenshot("requests-08-action-error-retry", from: mutation)
        mutation.buttons["Повторить"].tap()
        XCTAssertTrue(mutation.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            mutation.staticTexts[
                "Здравствуйте! Видела ваш проект Luxora и хочу обсудить иллюстрации для запуска."
            ].waitForExistence(timeout: 4)
        )
        XCTAssertTrue(mutation.textFields["message-composer"].isHittable)
        mutation.terminate()

        let privacy = messengerApp(destination: "you-privacy")
        privacy.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] = "1"
        privacy.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUEST_FAILURE"] = "privacy-update-once"
        privacy.launch()
        let policy = privacy.buttons["privacy-message-requests-policy"]
        XCTAssertTrue(policy.waitForExistence(timeout: 8))
        XCTAssertFalse(policy.label.contains("Никто"))
        policy.tap()
        let nobody = privacy.buttons["Никто"]
        XCTAssertTrue(nobody.waitForExistence(timeout: 3))
        nobody.tap()
        let privacyFailure = privacy.descendants(matching: .any)["remote-failure-row"]
        XCTAssertTrue(privacyFailure.waitForExistence(timeout: 4))
        XCTAssertTrue(privacyFailure.isHittable)
        XCTAssertTrue(privacy.staticTexts["Настройки не сохранены"].exists)
        XCTAssertFalse(policy.label.contains("Никто"))
        attachScreenshot("requests-09-privacy-error", from: privacy)
        let retry = privacyFailure.buttons["Повторить"]
        XCTAssertTrue(retry.isHittable)
        retry.tap()
        XCTAssertTrue(privacy.descendants(matching: .any)["privacy-settings-confirmed"].waitForExistence(timeout: 4))
        XCTAssertTrue(policy.label.contains("Никто") || policy.value as? String == "Никто")
    }

    @MainActor
    func testMessageRequestsExposeLoadingAndEmptyStatesWithoutInventingPeople() {
        let loading = messengerApp(destination: "message-requests")
        loading.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] = "1"
        loading.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUEST_FAILURE"] = "loading"
        loading.launch()
        XCTAssertTrue(loading.descendants(matching: .any)["message-requests-loading"].waitForExistence(timeout: 8))
        XCTAssertFalse(loading.staticTexts["Мария Лебедева"].exists)
        attachScreenshot("requests-10-loading", from: loading)
        loading.terminate()

        let empty = messengerApp(destination: "message-requests")
        empty.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUESTS"] = "1"
        empty.launchEnvironment["LUXORA_UI_TEST_MESSAGE_REQUEST_FAILURE"] = "empty"
        empty.launch()
        XCTAssertTrue(
            empty.descendants(matching: .any)["message-requests-empty-incoming"]
                .waitForExistence(timeout: 8)
        )
        XCTAssertTrue(empty.staticTexts["Новых запросов нет"].exists)
        XCTAssertFalse(empty.staticTexts["Мария Лебедева"].exists)
        attachScreenshot("requests-11-empty", from: empty)
    }

    @MainActor
    func testGlobalSearchUsesBottomScopesAndClosesBackToRussianRootShell() {
        let app = messengerApp(destination: "search")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["search-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["search-recent-people"].exists)
        XCTAssertTrue(app.buttons["search-scope-Чаты"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["search-scope-Чаты"].isSelected)
        XCTAssertTrue(app.textFields["search-query"].exists)
        assertRootShellHidden(in: app)

        app.buttons["search-scope-Медиа"].tap()
        XCTAssertTrue(app.staticTexts["Введите запрос"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Медиа"].exists)

        app.buttons["search-close"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 3))
        assertRootShellVisible(in: app)
    }

    @MainActor
    func testGlobalSearchFindsServerShapedPeopleAndMessagesAndOpensTheirChat() {
        var app = messengerApp(destination: "search")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["search-screen"].waitForExistence(timeout: 8))
        app.buttons["search-scope-Люди"].tap()
        focusAndType("Арина", into: app.textFields["search-query"])

        let person = app.buttons["search-person-39e8abf7-08d7-4610-8ea1-248c3cabf27f"]
        XCTAssertTrue(person.waitForExistence(timeout: 5))
        XCTAssertTrue(person.isHittable)
        attachScreenshot("search-01-people-results", from: app)
        person.tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Арина Волкова"].exists)
        app.terminate()

        app = messengerApp(destination: "search")
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["search-screen"].waitForExistence(timeout: 8))
        app.buttons["search-scope-Сообщения"].tap()
        focusAndType("навигация", into: app.textFields["search-query"])

        let message = app.buttons["search-message-8c5f373e-ff2d-44ed-948f-79b5306fe695"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertTrue(message.isHittable)
        attachScreenshot("search-02-message-results", from: app)
        message.tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Новая навигация стала спокойнее ✦"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testContactsProfileAndEditModeKeepUnavailableActionsVisiblyLocked() {
        let contacts = messengerApp(destination: "contacts")
        contacts.launch()
        XCTAssertTrue(contacts.descendants(matching: .any)["contacts-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(contacts.buttons["contacts-sort"].exists)
        XCTAssertTrue(contacts.buttons["contacts-add-gated"].exists)
        XCTAssertTrue(contacts.buttons["contacts-invite-gated"].exists)

        let alphabetRail = contacts.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Алфавитный указатель контактов"))
            .firstMatch
        XCTAssertTrue(alphabetRail.waitForExistence(timeout: 3))
        XCTAssertEqual(alphabetRail.label, "Алфавитный указатель контактов")
        let ya = contacts.buttons["contact-index-Я"]
        XCTAssertTrue(ya.exists)
        XCTAssertTrue(ya.isEnabled)
        ya.tap()

        let yana = contacts.buttons["contact-row-\(yanaConversationID)"]
        XCTAssertTrue(yana.waitForExistence(timeout: 3))
        XCTAssertTrue(yana.isHittable)
        yana.tap()
        XCTAssertTrue(contacts.descendants(matching: .any)["contact-profile-screen"].waitForExistence(timeout: 3))
        assertRootShellHidden(in: contacts)
        let profileActions = contacts.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "contact-profile-action-")
        )
        XCTAssertEqual(profileActions.count, 5)
        for identifier in [
            "contact-profile-action-call",
            "contact-profile-action-video",
            "contact-profile-action-mute",
            "contact-profile-action-search",
            "contact-profile-action-more",
        ] {
            XCTAssertTrue(contacts.buttons[identifier].exists)
        }
        XCTAssertTrue(contacts.descendants(matching: .any)["contact-profile-details"].exists)
        XCTAssertTrue(contacts.descendants(matching: .any)["contact-profile-content-scopes"].exists)
        XCTAssertTrue(contacts.descendants(matching: .any)["contact-profile-content-grid"].exists)
        contacts.buttons["contact-profile-action-call"].tap()
        XCTAssertTrue(contacts.descendants(matching: .any)["feature-status-sheet"].waitForExistence(timeout: 3))
        dismissFeatureStatusSheet(in: contacts)
        contacts.buttons["contact-profile-action-more"].tap()
        XCTAssertTrue(contacts.buttons["Написать сообщение"].waitForExistence(timeout: 3))
        contacts.terminate()

        let edit = messengerApp(destination: "edit-chats", showStatusRail: true)
        edit.launch()
        XCTAssertTrue(edit.descendants(matching: .any)["edit-chats-screen"].waitForExistence(timeout: 8))
        assertRootShellHidden(in: edit)
        XCTAssertTrue(edit.descendants(matching: .any)["status-story-rail"].exists)
        let folderRail = edit.descendants(matching: .any)["chat-folder-rail"]
        XCTAssertTrue(folderRail.exists)
        let channels = edit.buttons["chat-folder-rail-\(teamFolderID)"]
        for _ in 0..<3 where !channels.isHittable {
            folderRail.swipeLeft()
        }
        XCTAssertTrue(channels.isHittable)
        channels.tap()
        XCTAssertTrue(edit.buttons["edit-chat-row-\(channelConversationID)"].waitForExistence(timeout: 3))
        XCTAssertTrue(edit.staticTexts["Прочитать все, недоступно"].exists)
        XCTAssertTrue(edit.staticTexts["Архив, недоступно"].exists)
        XCTAssertTrue(edit.staticTexts["Удалить, недоступно"].exists)
        XCTAssertTrue(edit.buttons["Готово"].exists)
        edit.terminate()

        let folders = messengerApp(destination: "you-folders")
        folders.launch()
        XCTAssertTrue(folders.descendants(matching: .any)["chat-folders-settings-screen"].waitForExistence(timeout: 8))
        let teamSettings = folders.buttons["chat-folder-settings-\(teamFolderID)"]
        XCTAssertTrue(teamSettings.waitForExistence(timeout: 3))
        teamSettings.swipeLeft()
        folders.buttons["Удалить"].tap()
        let confirmedDelete = folders.buttons["Удалить «Команда»"]
        XCTAssertTrue(confirmedDelete.waitForExistence(timeout: 3))
        confirmedDelete.tap()
        XCTAssertTrue(teamSettings.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testSettingsInventoryDevicesAndDetailsUseRussianTruthStatesWithoutShellOverlap() {
        let root = messengerApp(destination: "settings")
        root.launch()
        XCTAssertTrue(root.descendants(matching: .any)["settings-screen"].waitForExistence(timeout: 8))
        assertRootShellVisible(in: root)
        XCTAssertTrue(root.buttons["settings-profile"].exists)
        XCTAssertTrue(root.buttons["you-settings-folders"].exists)
        XCTAssertTrue(root.buttons["you-settings-devices"].exists)

        XCTAssertTrue(reveal("you-settings-notifications", in: root).exists)
        XCTAssertTrue(reveal("you-settings-privacy", in: root).exists)
        XCTAssertTrue(reveal("you-settings-data", in: root).exists)
        XCTAssertTrue(reveal("you-settings-appearance", in: root).exists)
        XCTAssertTrue(reveal("you-settings-language", in: root).exists)
        XCTAssertTrue(reveal("you-settings-help", in: root).exists)
        XCTAssertTrue(reveal("you-settings-about", in: root).exists)
        root.terminate()

        let devices = messengerApp(destination: "you-devices")
        devices.launch()
        XCTAssertTrue(devices.descendants(matching: .any)["you-devices-screen"].waitForExistence(timeout: 8))
        assertRootShellHidden(in: devices)
        XCTAssertTrue(devices.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Этот iPhone")).firstMatch.exists)
        XCTAssertTrue(devices.buttons["devices-revoke-current"].exists)
        devices.terminate()

        let privacy = messengerApp(destination: "you-privacy")
        privacy.launch()
        XCTAssertTrue(privacy.descendants(matching: .any)["you-privacy-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(privacy.staticTexts["Luxora не заявляет о сквозном шифровании."].exists)
        assertRootShellHidden(in: privacy)
        privacy.terminate()

        let appearance = messengerApp(destination: "you-appearance")
        appearance.launch()
        XCTAssertTrue(appearance.descendants(matching: .any)["you-appearance-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(appearance.segmentedControls.buttons["Тёмная"].exists)
        assertRootShellHidden(in: appearance)
    }

    @MainActor
    private func russianApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(ru-RU)", "-AppleLocale", "ru_RU"]
        return app
    }

    @MainActor
    private func messengerApp(
        destination: String? = nil,
        showStatusRail: Bool = false,
        initialFolder: String? = nil
    ) -> XCUIApplication {
        let app = russianApp()
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_UI_TEST_SCENARIO"] = "messenger"
        app.launchEnvironment["LUXORA_UI_TEST_DESTINATION"] = destination ?? "chats"
        if showStatusRail {
            app.launchEnvironment["LUXORA_UI_TEST_SHOW_STATUS_RAIL"] = "1"
        }
        if let initialFolder {
            app.launchEnvironment["LUXORA_UI_TEST_INITIAL_FOLDER"] = initialFolder
        }
        return app
    }

    @MainActor
    private func assertRootShellVisible(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for title in ["Контакты", "Звонки", "Чаты", "Настройки", "Поиск"] {
            XCTAssertTrue(app.tabBars.buttons[title].isHittable, "\(title) должна быть доступна в корневой панели", file: file, line: line)
        }
    }

    @MainActor
    private func assertRootShellHidden(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(app.tabBars.firstMatch.exists, "Корневая панель не должна перекрывать вложенный экран", file: file, line: line)
    }

    @MainActor
    private func reveal(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        let element = app.buttons[identifier]
        for _ in 0..<8 where !element.exists {
            app.swipeUp()
        }
        return element
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        } while Date() < deadline
        return condition()
    }

    @MainActor
    private func dismissFeatureStatusSheet(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let sheet = app.descendants(matching: .any)["feature-status-sheet"]
        XCTAssertTrue(sheet.exists, "Экран статуса функции должен быть открыт", file: file, line: line)
        sheet.buttons["Готово"].tap()
    }

    private func focusAndType(
        _ text: String,
        into element: XCUIElement,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard element.waitForExistence(timeout: 3) else {
            return XCTFail("Поле ввода не появилось", file: file, line: line)
        }
        for _ in 0..<4 {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.5)).tap()
            if element.luxoraHasKeyboardFocus {
                element.typeText(text)
                return
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTFail("Не удалось передать фокус полю \(element)", file: file, line: line)
    }

    @MainActor
    private func attachScreenshot(
        _ name: String,
        from app: XCUIApplication,
        settleTime: TimeInterval = 2.0
    ) {
        XCTAssertEqual(app.state, .runningForeground)
        // The authentication flow deliberately fades through an empty transition
        // surface. Element existence can become true a frame before the new screen
        // is visible, so let that short production animation finish before evidence
        // is captured.
        if settleTime > 0 {
            Thread.sleep(forTimeInterval: settleTime)
        }
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private extension XCUIElement {
    var luxoraHasKeyboardFocus: Bool {
        (value(forKey: "hasKeyboardFocus") as? Bool) == true
    }
}
