import XCTest
@testable import LuxoraKit

final class RussianLocalizationTests: XCTestCase {
    func testPackageLocalizationDefaultsToRussian() {
        XCTAssertEqual(LuxoraL10n.developmentLocalization, "ru")
        XCTAssertEqual(LuxoraL10n.text("tab.contacts"), "Контакты")
        XCTAssertEqual(LuxoraL10n.text("tab.calls"), "Звонки")
        XCTAssertEqual(LuxoraL10n.text("tab.chats"), "Чаты")
        XCTAssertEqual(LuxoraL10n.text("tab.settings"), "Настройки")
        XCTAssertEqual(LuxoraL10n.text("tab.search"), "Поиск")
        XCTAssertEqual(LuxoraL10n.text("folder.channels"), "Каналы")
        XCTAssertEqual(LuxoraL10n.text("feature.stories.title"), "Истории и статусы")
        XCTAssertEqual(LuxoraL10n.text("error.missing_session"), "Войдите, чтобы продолжить.")
    }
}
