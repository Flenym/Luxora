# iPhone: accessibility и code-first performance — Beta-0.1

Владелец и разработчик: **Flenym**
Контрольная дата: **11 августа 2026 года**

## Итог checkpoint

Подписанный `LuxoraMobile` UI-test gate завершён успешно: **6/6 passed, 0
failed, 0 skipped**. Проверены русские экраны первого запуска и телефона, чатов,
переписки, профиля, редактора профиля с клавиатурой и настроек.

- xcresult: `/tmp/LuxoraAccessibilityAfterCore-B8C6-20260811-v17-full.xcresult`;
- результат XCTest: `Passed`;
- время шести тестов: `188.806 s`;
- build result: `succeeded`, 0 errors, 0 warnings, 0 analyzer warnings;
- схема: `LuxoraMobile`, локальная подпись `Sign to Run Locally`;
- Xcode: 26.6.

Это доказательство конкретного snapshot сборки. Любые изменения iOS source после
этого прогона требуют нового gate и не должны автоматически приписываться v17.

## Воспроизводимое окружение

- Simulator: `Luxora Accessibility iPhone 17 Pro`;
- UUID: `B8C6A79C-8F71-4A09-B141-EE1FFCA480EA`;
- модель: iPhone 17 Pro, arm64;
- iOS: 26.5 (`23F77`);
- проект: `apps/apple/Luxora.xcodeproj`;
- parallel testing: выключен, чтобы UI и снимки были детерминированными.

Команда финального прогона:

```sh
xcodebuild test \
  -project apps/apple/Luxora.xcodeproj \
  -scheme LuxoraMobile \
  -destination 'platform=iOS Simulator,id=B8C6A79C-8F71-4A09-B141-EE1FFCA480EA' \
  -derivedDataPath /tmp/LuxoraAccessibilityAfterCoreDerivedData-v1 \
  -resultBundlePath /tmp/LuxoraAccessibilityAfterCore-B8C6-20260811-v17-full.xcresult \
  -parallel-testing-enabled NO \
  -only-testing:LuxoraMobileUITests/LuxoraAccessibilityAuditUITests
```

Машиночитаемый итог и экспортный manifest сохранены рядом со снимками:
`after-xcresult/test-summary-v17.json` и `after-xcresult/manifest-v17.json`.

## Что именно прошло

| Тест | Runtime-контракт |
| --- | --- |
| Авторизация | Полные русские labels, доступная кнопка продолжения, экран номера, Dynamic Type, contrast, hit regions, descriptions, text clipping и traits. |
| Чаты | Заголовок, folders/status rails, VoiceOver-названия и 44 pt controls; полный screenshot-контракт и системные аудиты на ограниченном fixture из пяти production rows. |
| Переписка | Заголовок/status value, composer/attachment/send, пять полных message labels/values, stable viewport audits; каждый production bubble отдельно проходит Dynamic Type. |
| Профиль | Полные действия «копировать», «поделиться», QR, hittability и системные аудиты. |
| Редактор профиля | Детерминированный focus, клавиатура, «Далее»/«Готово», закрытие клавиатуры и доступная кнопка сохранения. |
| Настройки | Полные labels и hittability профиля, устройств и папок, плюс весь набор системных аудитов. |

Пять сообщений не помещаются одновременно на одном viewport при максимальном
Accessibility XXXL. Поэтому полный transcript отдельно проверяет семантику и
actions, а reflow проверяется для каждого из пяти детерминированных сообщений в
том же production `PhoneMessageBubble`. Список чатов аналогично использует пять
production rows для системного reflow-аудита, чтобы XCTest не классифицировал
невидимые `List` cells как обрезанные.

## Узкий quarantine iOS 26.5 Inspector

`textClipped` на iOS 26.5 сообщает один и тот же warning для каждого визуально
полного message body, хотя отдельный `dynamicType` audit проходит. Поведение
соответствует классу false positive, который сотрудник Apple рекомендует
фиксировать через Feedback Assistant, если текст действительно растёт и
визуально не обрезается: [Apple Developer Forums — Accessibility Inspector
Bugs](https://developer.apple.com/forums/thread/823968).

Предупреждение не подавляется глобально. Оно принимается в quarantine только
если одновременно выполнены все условия:

1. runtime имеет major version 26;
2. элемент совпадает с одним из пяти allowlisted fixture ID/body;
3. frame непустой, целиком находится по ширине/сверху в app frame и заканчивается
   минимум на 1 pt выше composer;
4. VoiceOver label непустой и не содержит многоточия.

Каждое принятое предупреждение сохранено отдельным исходным XCTest-вложением в
`after-xcresult/quarantine/`. Любое новое сообщение, другой OS major или нарушение
геометрии продолжит падать. Оригинальный ручной кадр
`18-conversation-single-message-axxxl-v12-inspector-proof.png` показывает
полностью видимый первый flagged body при системном
`accessibility-extra-extra-extra-large`; это промежуточная подписанная v12,
снятая до последнего безопасного упрощения layout, а не финальный v17 screenshot.
Независимый root-просмотр этого же кадра подтвердил body, но обнаружил отдельную
оставшуюся проблему: увеличенные title/status в верхней части переписки частично
обрезаны сверху. Этот header не входит в quarantine для message body, не считается
закрытым и должен получить отдельный fix плюс новый combined signed прогон.

## Baseline и визуальные доказательства

Baseline на том же Simulator:
`/tmp/LuxoraAccessibilityBaseline-B8C6-20260811.xcresult` — **0/3 passed**.
Он подтвердил clipping, слабый contrast, неполный Dynamic Type и четыре hit region
ниже системного минимума. Оригинальные вложения лежат в `before-xcresult/`.

Финальные v17 XCTest-вложения лежат в `after-xcresult/`:

1. `01-auth-welcome-after.png`;
2. `02-auth-phone-after.png`;
3. `03-chats-after.png`;
4. `04-conversation-after.png`;
5. `05-profile-after.png`;
6. `06-profile-edit-keyboard-after.png`;
7. `07-settings-after.png`.

Все семь PNG имеют исходное разрешение 1206×2622 и просмотрены вручную в
original. Вывод: наложений текста на controls нет; auth CTA и release marker
видны; chat folders/status rail и нижняя навигация не перекрывают строки;
сообщения и metadata помещаются над composer; профиль и settings сохраняют
иерархию; editor показывает доступные keyboard actions. Скриншоты сняты в
обычной категории `large`; поддержку больших размеров доказывают системный
Dynamic Type audit, отдельные reflow fixtures и честно маркированные AXXXL кадры
14–18, а не название файла.

Ошибочно названные кандидаты 09–13, реально снятые в `large`, перемещены в
корзину и могут быть восстановлены. Кадры 01–08 и 14–18 остаются только
промежуточной историей и не выдаются за финальные v17-вложения.

## Production-изменения доступности

- Убраны жёсткие высоты и искусственные Dynamic Type caps на проверяемых формах,
  rails, chat rows и message bubbles; длинные строки получают вертикальный рост.
- На крупных размерах title/status переписки переезжают из тесного navigation bar
  в scroll content, а bubble занимает доступную ширину. Нижний scroll anchor
  оставляет безопасный зазор над composer.
- Собственные buttons имеют минимум 44 pt; системные toolbar controls оставлены
  нативными. Пограничные `.tertiary` подписи заменены устойчивыми системными
  foreground/background парами.
- Message VoiceOver contract содержит автора, текст, направление, время,
  доставку, edit/pin/forward/reactions. Reply/copy/edit/pin/forward/delete/retry и
  реакции доступны через actions rotor без включения `textSelection` на пузыре.
- Folders, stories и messages имеют стабильные IDs и именованные rotors. Story
  identity основана на conversation ID, а не на повторяемом participant ID.
- Auth и profile editor используют локальный `FocusState`; keyboard toolbar даёт
  «Назад», «Далее», «Готово»/«Скрыть клавиатуру» в соответствующем контексте.
- `accessibilityReduceMotion` отключает программные scroll/transition animations;
  welcome motion не запускается при Reduce Motion, а contour `TimelineView`
  ставится на pause. Loader отдельно убирает glow при Reduce Transparency или
  increased contrast; системные Material/Bar/Glass surfaces сохраняют системную
  адаптацию.

Отдельная runtime-матрица с физически включёнными Reduce Motion и Reduce
Transparency в v17 не записывалась. Здесь есть code-path review и обычный
system-audit gate; ручной device pass этих двух настроек остаётся release gate.

## Code-first SwiftUI performance audit

Без изменения поведения исправлены следующие P0/P1 code smells:

- filter/sort списка чатов материализуется один раз на render pass и повторно
  используется list/empty-state;
- сообщения, remote state и failed-send projection текущей переписки читаются
  один раз на render pass;
- message и status collections используют `LazyVStack`/`LazyHStack` и стабильные
  UUID/string IDs;
- unread total и status projection вычисляются один раз для rail render pass;
- contact filter/group/sort материализуется один раз и повторно используется
  списком, alphabet rail и empty-state;
- programmatic scrolling уважает Reduce Motion.

Повторный canary scan audited views не нашёл `.id(UUID())`, `DateFormatter()` в
`body`, нестабильный `\.self` для message/chat collections или sort/filter прямо
в `ForEach`. Два `enumerated()` используют стабильные IDs доменных элементов.
`git diff --check` по затронутым iOS source/test файлам чист.

Намеренно не сделаны без trace: дробление большого `MessengerStore`, кэш QR из
Core Image и дополнительная мемоизация малых settings/search выборок. Instruments
или ETTrace не записывались, поэтому документ **не заявляет** FPS, launch time,
CPU, memory или измеренное ускорение.

## Локальный evidence canary

Экспортированные `.json`/`.txt` проверены на Authorization/Bearer, password/OTP/
secret, JWT, полный российский номер и private-key headers: совпадений нет. У PNG
нет GPS, автора или origin metadata; визуально нет введённого номера, кода,
пароля или токена. Видимые имена и сообщения — синтетический UI-test fixture.
Полный локальный отчёт: `after-xcresult/EVIDENCE_SCAN.md`.

Это не серверный log/content/token canary и не доказательство production ingress,
traces или crash pipeline.

## Оставшиеся release gates

- ручной VoiceOver rotor/reading-order pass на физическом iPhone;
- внешняя клавиатура, Switch Control и Voice Control;
- отдельный runtime pass Reduce Motion + Reduce Transparency;
- light/dark + локализации вне ru-RU;
- Instruments/ETTrace до любых performance claims;
- повторный signed UI gate после последующих изменений shared iOS source.
