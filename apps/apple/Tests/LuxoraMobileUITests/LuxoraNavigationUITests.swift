import XCTest

final class LuxoraNavigationUITests: XCTestCase {
    private let archivableConversationID = "1a7c9a6a-4dca-46ca-b417-7dc2f8f85e60"
    private let teamFolderID = "f1300000-0000-4000-8000-000000000002"

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
    func testFolderSettingsCanSelectTheSystemAllChatsFolder() {
        let app = messengerApp(destination: "you-folders", initialFolder: "channels")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chat-folders-settings-screen"].waitForExistence(timeout: 8))
        let allChatsMatches = app.buttons.matching(identifier: "chat-folders-all")
        XCTAssertEqual(allChatsMatches.count, 1)
        let allChats = allChatsMatches.firstMatch
        XCTAssertTrue(allChats.exists)
        XCTAssertTrue(allChats.isEnabled)
        XCTAssertFalse(allChats.isSelected || (allChats.value as? String) == "Выбрано")
        allChats.tap()
        XCTAssertTrue(waitUntil(timeout: 3) {
            allChats.isSelected || (allChats.value as? String) == "Выбрано"
        })
        app.navigationBars.buttons["Настройки"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings-screen"].waitForExistence(timeout: 5))
        let chatsTab = app.tabBars.buttons["Чаты"]
        XCTAssertTrue(chatsTab.waitForExistence(timeout: 5))
        chatsTab.tap()
        let allRail = app.buttons["chat-folder-rail-all"]
        XCTAssertTrue(allRail.waitForExistence(timeout: 3))
        XCTAssertTrue(waitUntil(timeout: 3) {
            allRail.isSelected || (allRail.value as? String) == "Выбрано"
        })
    }

    @MainActor
    func testChatFoldersRussianVisualEvidence() {
        let app = messengerApp(destination: "chats", initialFolder: "all")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 8))
        let all = app.buttons["chat-folder-rail-all"]
        XCTAssertTrue(all.waitForExistence(timeout: 3))
        XCTAssertTrue(waitUntil(timeout: 3) {
            all.isSelected || (all.value as? String) == "Выбрано"
        })
        keepScreenshot("folders-01-all-chats", app: app)

        let archivableRow = app.buttons["inbox-row-\(archivableConversationID)"]
        XCTAssertTrue(archivableRow.waitForExistence(timeout: 3))
        archivableRow.swipeLeft()
        let archiveAction = app.buttons["В архив"]
        XCTAssertTrue(archiveAction.waitForExistence(timeout: 3))
        archiveAction.tap()
        XCTAssertTrue(archivableRow.waitForNonExistence(timeout: 5))

        let archive = app.buttons["chat-folder-rail-archive"]
        XCTAssertTrue(archive.waitForExistence(timeout: 5))
        archive.tap()
        XCTAssertTrue(waitUntil(timeout: 3) {
            archive.isSelected || (archive.value as? String) == "Выбрано"
        })
        keepScreenshot("folders-02-archive", app: app)
        app.terminate()

        let teamApp = messengerApp(destination: "chats", initialFolder: "channels")
        teamApp.launch()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 8)
        )
        let team = teamApp.buttons["chat-folder-rail-\(teamFolderID)"]
        XCTAssertTrue(team.waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntil(timeout: 3) {
            team.isSelected || (team.value as? String) == "Выбрано"
        })
        keepScreenshot("folders-03-team", app: teamApp)

        let settingsTab = teamApp.tabBars.buttons["Настройки"]
        XCTAssertTrue(settingsTab.waitForExistence(timeout: 3))
        XCTAssertTrue(waitUntil(timeout: 3) { settingsTab.isHittable })
        settingsTab.tap()
        let settingsScreen = teamApp.descendants(matching: .any)["settings-screen"]
        if !settingsScreen.waitForExistence(timeout: 3) {
            let currentSettingsTab = teamApp.tabBars.buttons["Настройки"]
            XCTAssertTrue(currentSettingsTab.waitForExistence(timeout: 3))
            currentSettingsTab.tap()
        }
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 5))
        let folders = teamApp.buttons["you-settings-folders"]
        XCTAssertTrue(folders.waitForExistence(timeout: 3))
        folders.tap()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["chat-folders-settings-screen"]
                .waitForExistence(timeout: 5)
        )
        keepScreenshot("folders-04-settings", app: teamApp)

        let create = teamApp.buttons["chat-folders-create-row"]
        XCTAssertTrue(create.waitForExistence(timeout: 3))
        create.tap()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["chat-folder-editor-screen"]
                .waitForExistence(timeout: 5)
        )
        keepScreenshot("folders-05-editor", app: teamApp)

        teamApp.navigationBars.buttons["Отмена"].tap()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["chat-folders-settings-screen"]
                .waitForExistence(timeout: 5)
        )
        teamApp.navigationBars.buttons["Настройки"].tap()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["settings-screen"].waitForExistence(timeout: 5)
        )
        let chatsTab = teamApp.tabBars.buttons["Чаты"]
        XCTAssertTrue(chatsTab.waitForExistence(timeout: 5))
        chatsTab.tap()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["chats-screen"].waitForExistence(timeout: 5)
        )
        teamApp.buttons["chats-spaces"].tap()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["spaces-screen"].waitForExistence(timeout: 5)
        )
        keepScreenshot("folders-06-spaces", app: teamApp)

        teamApp.buttons["spaces-create"].tap()
        teamApp.buttons["Создать группу"].tap()
        XCTAssertTrue(
            teamApp.descendants(matching: .any)["community-create-screen"]
                .waitForExistence(timeout: 5)
        )
        keepScreenshot("folders-07-create-group", app: teamApp)
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
    private func keepScreenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

final class LuxoraCommunityUITests: XCTestCase {
    private let studioID = "466bb23c-21c9-464b-b761-04686df7a060"
    private let channelID = "62499623-29d3-453c-a788-94d402f295c7"
    private let mariaID = "20000000-0000-4000-8000-000000000001"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testGroupProfileAddsMemberAndChangesConfirmedRole() {
        let app = communityApp(destination: "spaces")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["spaces-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["spaces-community-\(studioID)"].exists)
        XCTAssertTrue(app.buttons["spaces-community-\(channelID)"].exists)
        keepScreenshot("community-01-spaces", app: app)

        app.buttons["spaces-community-\(studioID)"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 5))
        let profileButton = app.buttons["conversation-community-profile"]
        XCTAssertTrue(profileButton.exists)
        XCTAssertTrue(profileButton.label.contains("Команда Luxora"))
        keepScreenshot("community-02-group-chat", app: app)

        profileButton.tap()
        XCTAssertTrue(app.descendants(matching: .any)["community-profile-screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Команда Luxora"].exists)
        XCTAssertTrue(app.buttons["community-add-member"].waitForExistence(timeout: 5))
        keepScreenshot("community-03-group-profile", app: app)

        app.buttons["community-add-member"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["community-add-screen"].waitForExistence(timeout: 4))
        let username = app.textFields["community-add-username"]
        XCTAssertTrue(username.exists)
        username.tap()
        username.typeText("maria")
        let add = app.buttons["community-add-submit"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        keepScreenshot("community-04-add-member", app: app)
        add.tap()
        XCTAssertFalse(app.descendants(matching: .any)["community-add-screen"].waitForExistence(timeout: 5))

        let search = app.buttons["community-profile-action-поиск"]
        XCTAssertTrue(search.waitForExistence(timeout: 3))
        search.tap()
        let searchField = app.searchFields["Поиск участников"]
        XCTAssertTrue(searchField.waitForExistence(timeout: 3))
        searchField.typeText("maria")

        let maria = app.descendants(matching: .any)["community-member-\(mariaID)"]
        XCTAssertTrue(maria.waitForExistence(timeout: 4))
        XCTAssertTrue(maria.label.contains("Участник"))
        app.buttons["Действия с Мария Соколова"].tap()
        app.buttons["Назначить администратором"].tap()
        XCTAssertTrue(waitUntil(timeout: 5) { maria.label.contains("Администратор") })
        keepScreenshot("community-05-member-admin", app: app)
    }

    @MainActor
    func testCreateGroupPublishesItIntoConversationAndProfileNavigation() {
        let app = communityApp(destination: "spaces")
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["spaces-screen"].waitForExistence(timeout: 8))
        app.buttons["spaces-create"].tap()
        app.buttons["Создать группу"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["community-create-screen"].waitForExistence(timeout: 4))
        let title = app.textFields["community-create-title"]
        title.tap()
        title.typeText("Команда Beta")
        let submit = app.buttons["community-create-submit"]
        XCTAssertTrue(submit.isEnabled)
        keepScreenshot("community-06-create-group", app: app)
        submit.tap()

        XCTAssertTrue(app.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["conversation-community-profile"].label.contains("Команда Beta"))
        XCTAssertTrue(app.descendants(matching: .any)["message-composer"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["channel-read-only-composer"].exists)
        keepScreenshot("community-07-created-group-chat", app: app)

        app.buttons["conversation-community-profile"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["community-profile-screen"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["Команда Beta"].exists)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "владелец")
        ).firstMatch.exists)
    }

    @MainActor
    func testChannelMemberIsReadOnlyAndCanLeaveAfterServerConfirmation() {
        let app = communityApp(destination: "conversation", conversationID: channelID)
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["conversation-screen"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["channel-read-only-composer"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["message-composer"].exists)
        XCTAssertTrue(app.buttons["conversation-community-profile"].label.contains("Заметки продукта"))
        keepScreenshot("community-08-channel-read-only", app: app)

        app.buttons["conversation-community-profile"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["community-profile-screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Заметки продукта"].exists)
        let leave = app.buttons["community-profile-action-покинуть"]
        XCTAssertTrue(leave.waitForExistence(timeout: 5))
        keepScreenshot("community-09-channel-profile", app: app)

        leave.tap()
        let confirmedLeave = app.sheets.buttons["Покинуть"]
        XCTAssertTrue(confirmedLeave.waitForExistence(timeout: 3))
        confirmedLeave.tap()
        XCTAssertTrue(app.descendants(matching: .any)["spaces-screen"].waitForExistence(timeout: 6))
        XCTAssertFalse(app.buttons["spaces-community-\(channelID)"].exists)
        keepScreenshot("community-10-channel-left", app: app)
    }

    @MainActor
    private func communityApp(destination: String, conversationID: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(ru-RU)", "-AppleLocale", "ru_RU"]
        app.launchEnvironment["LUXORA_UI_TEST_RESET_SESSION"] = "1"
        app.launchEnvironment["LUXORA_UI_TEST_SCENARIO"] = "messenger"
        app.launchEnvironment["LUXORA_UI_TEST_DESTINATION"] = destination
        if let conversationID {
            app.launchEnvironment["LUXORA_UI_TEST_CONVERSATION_ID"] = conversationID
        }
        return app
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
    private func keepScreenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
