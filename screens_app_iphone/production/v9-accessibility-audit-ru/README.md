# Luxora Beta-0.1 — iPhone accessibility evidence

Владелец и разработчик: **Flenym**. Контрольный прогон выполнен 11 августа 2026
года в Xcode 26.6 на отдельном `Luxora Accessibility iPhone 17 Pro` Simulator,
iOS 26.5 (`23F77`), UUID `B8C6A79C-8F71-4A09-B141-EE1FFCA480EA`.

## Проверенный итог

`/tmp/LuxoraAccessibilityAfterCore-B8C6-20260811-v17-full.xcresult`:
**6/6 passed, 0 failed, 0 skipped**, build succeeded без warnings/errors.

`after-xcresult/` содержит оригинальные XCTest attachments финального snapshot:

- `01-auth-welcome-after.png`;
- `02-auth-phone-after.png`;
- `03-chats-after.png`;
- `04-conversation-after.png`;
- `05-profile-after.png`;
- `06-profile-edit-keyboard-after.png`;
- `07-settings-after.png`;
- `manifest-v17.json` и `test-summary-v17.json`;
- `quarantine/01-message.txt` — `05-message.txt` с исходными системными issues.

Все семь финальных PNG — реальные кадры собранного SwiftUI-приложения размером
1206×2622. Они открыты и проверены по одному; это не imagegen, не макеты и не
ретушь. Категория шрифта в этих семи вложениях — `large`.

## Dynamic Type и quarantine

Системный Dynamic Type audit и отдельные production reflow fixtures проходят.
iOS 26.5 `textClipped` при этом выдаёт известный класс Inspector false positive
для каждого из пяти полностью видимых message bodies. Исключение узкое: только OS
major 26, только пять allowlisted fixtures, только полный non-ellipsis label и
frame, заканчивающийся выше composer. Все пять принятых issues сохранены, поэтому
quarantine видим и проверяем; новые issues по-прежнему валят тест.

`18-conversation-single-message-axxxl-v12-inspector-proof.png` — оригинальный
ручной кадр на `accessibility-extra-extra-extra-large`, показывающий полный первый
flagged body. Это честно маркированная промежуточная подписанная v12, не финальный
v17 attachment. Независимый root-просмотр подтвердил полный body, но выявил
частично обрезанный сверху AXXXL title/status переписки.

`19-conversation-single-message-axxxl-header-fixed.png` — повторный ручной кадр
из подписанной сборки после исправления: имя, статус и полный текст сообщения
одновременно видны при AXXXL. Закреплённый контекст перенесён в прокручиваемую
ленту, а масштаб навигационного заголовка ограничен стандартным XXXL; текст
сообщений по-прежнему использует выбранный пользователем AXXXL без ограничения.
Целевой системный прогон после финальной правки:
`/tmp/LuxoraAccessibilityConversationHeaderFix-20260811-v3.xcresult`, **1/1
passed**, 0 failures.

## До/после

`before-xcresult/` экспортирован из
`/tmp/LuxoraAccessibilityBaseline-B8C6-20260811.xcresult`: baseline был **0/3** и
подтвердил clipping, Dynamic Type, contrast и hit-region дефекты.

Кадры 01–08 и 14–18 в корне — промежуточная история. Файлы 09–13 были ошибочно
подписаны как AXXXL при реальной категории `large`; они перемещены в корзину и не
участвуют в доказательствах.

## Целостность и границы

- `SHA256SUMS` покрывает сохранённый набор evidence.
- `after-xcresult/EVIDENCE_SCAN.md` фиксирует локальный secret/fixture scan.
- Полный технический отчёт:
  `docs/audits/IPHONE_ACCESSIBILITY_PERFORMANCE_BETA_0_1_RU.md`.
- Instruments/ETTrace не записывались, поэтому performance-цифры не заявляются.
- v17 доказывает snapshot своего xcresult; после новых iOS source edits нужен
  повторный подписанный прогон.
