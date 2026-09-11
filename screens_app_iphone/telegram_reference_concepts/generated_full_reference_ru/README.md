# Generated full-reference Luxora concepts

> **Ни один generated bitmap не является authoritative UI source или runtime evidence.** Единственный authoritative visual source — 62 неизменяемых пользовательских Telegram screenshots в родительской папке. Слово `accepted` ниже означает только `concept QA-passed` после original-detail проверки.

Эта папка предназначена только для новых Luxora ImageGen-исследований по полному набору из 62 пользовательских iPhone-референсов.

Правила:

- один asset — один вызов ImageGen;
- каждый результат осматривается в original detail до принятия;
- имя содержит номер семейства, экран, язык и версию;
- только Luxora branding, русские строки и безопасные синтетические данные;
- Dynamic Island в обычном состоянии однотонный матово-чёрный;
- никаких Telegram marks, Premium/Stars/Wallet/Gifts, реальных QR или персональных данных;
- это concept-only слой, а не Simulator/runtime proof;
- отклонённые варианты переносятся в отдельный `rejected/`, без перезаписи принятого файла.

## QA-журнал

| Asset | Результат | Original-detail QA |
| --- | --- | --- |
| `01-main-chats-ru-v1` | rejected; изолирован в `rejected/` | Геометрия, shell, synthetic data и idle island прошли; лишний вертикальный glyph перед первым заголовком и написание бренда кириллицей не прошли строгий текстовый gate. V2 отложен из-за приоритета gap-flows. |
| `gap-auth-welcome-ru-v1` | rejected; изолирован в `rejected/` | Логотип, русский текст, CTA и privacy hierarchy прошли; Dynamic Island получил видимую обводку, а status indicators отсутствовали. Запущена исправленная v2. |
| `gap-auth-welcome-ru-v2` | visual-approved / **copy-rejected**; перенесён в `visual_only/` | Геометрия, mark, status bar и island прошли, но «защищённом пространстве» и «Ваши данные под вашим контролем» не прошли product truth-gate для Beta-0.1 cloud preview. Не использовать как product-approved board. |
| `gap-auth-welcome-ru-v3` | **superseded / visual-only**; перенесён в `visual_only/` | Truth-safe визуально, но больше не соответствует обязательному phone-first Telegram-reference auth решению. Маркетинговый welcome не является основным auth screen. |
| `gap-loader-dark-invisible-contour-ru-v1` | visual-approved / **copy-rejected**; перенесён в `visual_only/` | Motion keyframe прошёл, но «Защищённое соединение» не подтверждено runtime/TLS evidence и нарушает product truth-gate. Не использовать как product-approved board. |
| `gap-loader-light-invisible-contour-ru-v1` | visual-approved / **copy-rejected**; перенесён в `visual_only/` | Light motion keyframe прошёл, но тот же неподтверждённый security claim не прошёл product truth-gate. Не использовать как product-approved board. |
| `gap-loader-dark-invisible-contour-ru-v2` | visual-approved / **motion-rejected**; перенесён в `visual_only/` | Truth-safe copy прошла, но нижний spinner создаёт третью анимацию и нарушает owner-contract «ровно два runner». V3 обязана оставить только runners и neutral text. |
| `gap-loader-dark-v3-attempt1` | **rejected**; изолирован в `rejected/` | Ровно две точки, отсутствие spinner и neutral text прошли, но Dynamic Island получил видимую обводку, а tails остались слишком длинными для compact-ray contract. SHA-256 `d0b1823efb936ad6480f34fc0c2b6d49046a7bda0277a5c640955eb3a9da9ae4`. |
| `gap-loader-dark-invisible-contour-ru-v3.png` | **accepted concept keyframe**, 1179×2556 | Ровно два violet/ice-blue runner, два tapered trails, no spinner/full mark/route/claim и единственная neutral Beta-copy; true-black status region без видимой island-обводки прошёл original-detail QA. Bitmap не доказывает motion. SHA-256 `a57a89a47a839c74759331408d78c792554eb375787c7453a55a454f633e0562`. |
| `gap-loader-light-invisible-contour-ru-v3.png` | **accepted concept keyframe**, 1179×2556 | Ровно два black runner, два tapered trails, no spinner/full mark/route/claim и единственная neutral Beta-copy; matte-black idle island и light-mode geometry прошли original-detail QA. Bitmap не доказывает motion. SHA-256 `0877b9b2144a43d3f565e0dc3fbf268658d584cb6f2d5b570d451bb223e5e1ca`. |
| `gap-permissions-primer-ru-v1` | rejected; изолирован в `rejected/` | Permission semantics, rows, actions и island прошли; диакритика `й` в title отделилась в самостоятельный glyph, поэтому строгий text gate не пройден. |
| `gap-permissions-primer-ru-v2` | visual-approved / **runtime-copy-gated**; перенесён в `visual_only/` | Геометрия и строки прошли original-detail QA, но формулировка про сообщения и звонки зависит от ещё не доказанных push/call capabilities. Microphone и camera также остаются двумя отдельными системными запросами. SHA-256 `fc74eaf619cf56568697a19faea65a70994700e79d770fb89ff7a0e07633206e`. |
| `gap-network-reconnect-error-ru-v1` | visual-approved / **route-gated**; перенесён в `visual_only/` | Геометрия и blocking-state прошли original-detail QA, но действие `Открыть диагностику` нельзя считать product-ready до появления реального route. SHA-256 `d985e3db689003575db2563bb2b5cd1b7796c573c453d04f81dfd4c0af207666`. |
| `auth-phone-01-start-ru-v1` | rejected; изолирован в `rejected/` | Phone-first content/geometry прошли, но Dynamic Island получил outline и строка подтверждения номера появилась до ввода номера. V2 исправляет оба дефекта. |
| `auth-phone-01-start-ru-v2.png` | **accepted concept**, 1179×2556 | Phone-first start: only Luxora identity, Beta-0.1, `Начать` and neutral next-step copy; no username/password/email/QR; all text, exact logo, status bar and no-outline idle island passed. SHA-256 `c343876f23b0a52fa4cd73b9c6dda07f99c63b314c373a001faff37146213c16`. |
| `auth-phone-02-country-number-ru-v1` | visual-approved / **interaction-state-rejected**; перенесён в `visual_only/` | Экран показывает пустой placeholder, но активную CTA, и дублирует выбор страны отдельным действием. V2 обязана оставить одну country-row и disabled CTA до валидного E.164. SHA-256 `a34bbf7f0d4c399a241eeb01cc298881dbbef4662b8669f10cdc4e9b5ad3edeb`. |
| `auth-phone-02-country-number-ru-v2.png` | **accepted concept**, 1179×2556 | Empty phone-entry state соответствует interaction contract: единственная country-row `Россия +7`, пустой `Номер телефона`, disabled `Продолжить`, одна neutral server-copy; numeric keyboard, русский текст, exact logo, status bar и no-outline idle island прошли original-detail QA. SHA-256 `2e6d01a727c7b9e704fb92d1212532d23c402ad976d14b0614a6a616316b4e1a`. |
| `auth-phone-03-otp-ru-v1` | **rejected**; изолирован в `rejected/` | Phone mask, timer, disabled CTA, keyboard и text gate прошли, но grouped OTP field выровнен слева вместо runtime-aligned centered input. SHA-256 `61af9018459cff66f4ff77d9a0a041c7052dbbb38435bff1f93851add564705e`. |
| `auth-phone-03-otp-ru-v2.png` | **accepted concept**, 1179×2556 | Empty OTP state соответствует runtime contract: один centered grouped `000000` input с caret, synthetic masked phone, disabled resend timer и disabled `Продолжить`; numeric keyboard, русский текст, exact logo, status bar и no-outline idle island прошли original-detail QA. SHA-256 `50779388086bc942385a844e939fa3b75641b967c5f2275bee0959c6afbf0555`. |
| `auth-phone-04-name-profile-ru-v1` | visual-approved / **superseded by expanded onboarding**; перенесён в `visual_only/` | Прежний empty-profile runtime screen прошёл QA, но новый flow требует optional bio, явный circular-crop path, CTA `Продолжить` и отдельный username availability/suggestion screen. SHA-256 `6fcd264f63763073f55aa5770f24b66eb9a1fe5d0826dfb9501bb408741fef95`. |

## Gap coverage

| Очередь | Статус |
| --- | --- |
| Auth/onboarding | phone-first start v2 → country/number v2 → OTP v2 passed; expanded profile/crop → optional username → permissions/sync concepts in progress; username is not a login method |
| Фирменный loader dark/light | dark/light v3 accepted static concept keyframes; runtime still bound only to exact SVG route + same-direction 50%-phase contract |
| Permissions/errors | visual-only до подтверждения push/calls и diagnostics route; auth имеет приоритет |
| Statuses/stories | next |
| Остальные G01–G27 из `../FULL_REFERENCE_INVENTORY_RU.md` | pending |

**Concept QA-passed assets:** 5.  
**Visual-only assets:** 9.  
**Rejected assets:** 6 generations.

## Обязательная runtime-спецификация loader

Bitmap-файлы loader — только статические визуальные keyframes, не реализация анимации. Runtime обязан:

- использовать уже извлечённый точный SVG-маршрут внешнего контура **и** внутренней петли Luxora;
- держать две точки строго на расстоянии 180° по длине общего замкнутого маршрута;
- двигать обе точки с одинаковой скоростью в одном направлении, поэтому они никогда не встречаются;
- показывать только короткий tapered trail за каждой точкой;
- никогда не проявлять заливку, ghost mark, полный контур или полный wireframe логотипа;
- в light mode использовать чёрные runner/trails, в dark mode — violet/indigo/ice-blue runners;
- сохранять idle matte-black Dynamic Island, если OS не показывает реальное активное состояние.

## Product truth gates

- Legal footer links на auth-board остаются gated до появления реальных документов и рабочих routes.
- Security/E2EE/protected-space/data-control claims запрещены без подтверждённого backend/runtime contract и evidence.
- Neutral Beta-0.1 copy описывает только показанное состояние; bitmap никогда не считается доказательством реализации.
