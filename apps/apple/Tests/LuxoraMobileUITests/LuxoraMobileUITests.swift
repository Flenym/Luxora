import XCTest

final class LuxoraMobileUITests: XCTestCase {
    private let primaryConversationID = "8f0f19fe-d881-4ddd-8467-37065adf37d8"
    private let channelConversationID = "62499623-29d3-453c-a788-94d402f295c7"
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
        let unavailable = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Не удалось связаться с сервером")
        ).firstMatch
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
        phone.tap()
        phone.typeText(nationalNumber)
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-phone-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-code-screen"].waitForExistence(timeout: 12))
        attachScreenshot("live-02-otp", from: app)
        let code = app.textFields["auth-code"]
        code.tap()
        code.typeText(verificationCode)
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-code-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-profile-screen"].waitForExistence(timeout: 12))
        attachScreenshot("live-03-profile", from: app)
        let displayName = app.textFields["auth-display-name"]
        displayName.tap()
        displayName.typeText("Flenym iPhone")
        app.buttons["auth-keyboard-done"].tap()
        app.buttons["auth-profile-submit"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["auth-username-screen"].waitForExistence(timeout: 5))
        let usernameField = app.textFields["auth-username"]
        usernameField.tap()
        usernameField.typeText(username)
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
        app.buttons["spaces-create-gated"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["feature-status-sheet"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Сервер пока не поддерживает пространства, полный контроль участников и модерацию."].waitForExistence(timeout: 3))
        dismissFeatureStatusSheet(in: app)
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

        let channels = app.buttons["inbox-folder-channels"]
        for _ in 0..<3 where !channels.isHittable {
            rail.swipeLeft()
        }
        XCTAssertTrue(channels.isHittable)
        channels.tap()
        XCTAssertTrue(channels.isSelected || (channels.value as? String) == "Выбрано")

        let channelRow = app.buttons["inbox-row-\(channelConversationID)"]
        XCTAssertTrue(channelRow.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["inbox-row-\(primaryConversationID)"].exists)
        channelRow.tap()

        let composer = app.descendants(matching: .any)["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        composer.tap()
        composer.typeText("Обновление списка")
        app.buttons["message-send"].tap()
        XCTAssertTrue(app.staticTexts["Обновление списка"].waitForExistence(timeout: 3))
        app.navigationBars.buttons["Чаты"].tap()

        XCTAssertTrue(channels.waitForExistence(timeout: 3))
        XCTAssertTrue(channels.isHittable)
        XCTAssertTrue(channels.isSelected || (channels.value as? String) == "Выбрано")

        for _ in 0..<3 where !app.buttons["inbox-folder-all"].isHittable {
            rail.swipeRight()
        }
        XCTAssertTrue(app.buttons["inbox-folder-all"].isHittable)
        app.terminate()

        let restored = messengerApp(initialFolder: "channels")
        restored.launch()
        let restoredChannels = restored.buttons["inbox-folder-channels"]
        XCTAssertTrue(restoredChannels.waitForExistence(timeout: 8))
        XCTAssertTrue(restoredChannels.isHittable)
        XCTAssertTrue(restoredChannels.isSelected || (restoredChannels.value as? String) == "Выбрано")
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
        XCTAssertTrue(app.staticTexts["Поиск по медиа пока недоступен."].waitForExistence(timeout: 3))

        app.buttons["search-close"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 3))
        assertRootShellVisible(in: app)
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
        let channels = edit.buttons["inbox-folder-channels"]
        for _ in 0..<3 where !channels.isHittable {
            folderRail.swipeLeft()
        }
        XCTAssertTrue(channels.isHittable)
        channels.tap()
        XCTAssertTrue(edit.buttons["edit-chat-row-\(channelConversationID)"].waitForExistence(timeout: 3))
        let removeChannels = edit.buttons["folder-remove-channels-gated"]
        XCTAssertTrue(removeChannels.isHittable)
        removeChannels.tap()
        XCTAssertTrue(edit.descendants(matching: .any)["feature-status-sheet"].waitForExistence(timeout: 3))
        XCTAssertTrue(edit.staticTexts["Папки в Beta-0.1 работают как фильтры на этом iPhone; добавление, удаление и синхронизация пока не реализованы."].exists)
        dismissFeatureStatusSheet(in: edit)
        XCTAssertTrue(edit.staticTexts["Прочитать все, недоступно"].exists)
        XCTAssertTrue(edit.staticTexts["Архив, недоступно"].exists)
        XCTAssertTrue(edit.staticTexts["Удалить, недоступно"].exists)
        XCTAssertTrue(edit.buttons["Готово"].exists)
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
    private func dismissFeatureStatusSheet(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let sheet = app.descendants(matching: .any)["feature-status-sheet"]
        XCTAssertTrue(sheet.exists, "Экран статуса функции должен быть открыт", file: file, line: line)
        sheet.buttons["Готово"].tap()
    }

    @MainActor
    private func attachScreenshot(_ name: String, from app: XCUIApplication) {
        XCTAssertEqual(app.state, .runningForeground)
        // The authentication flow deliberately fades through an empty transition
        // surface. Element existence can become true a frame before the new screen
        // is visible, so let that short production animation finish before evidence
        // is captured.
        Thread.sleep(forTimeInterval: 2.0)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
