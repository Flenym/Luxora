# Luxora — восстановление сеанса и контурный загрузчик

Финальная проверка выполнена на iPhone 17 Pro Simulator с iOS 26.5, устройство `22D9F7E5-36B4-4A6E-9696-EEC13CF2C2DA`. Все PNG сняты напрямую через `simctl io screenshot`, без склейки, ретуши и дорисовки. Размер каждого кадра — 1206 × 2622 пикселя.

Это проверка на Simulator, а не на физическом iPhone. Энергопотребление и фактическое озвучивание VoiceOver на реальном устройстве ещё нужно подтвердить перед релизом.

## Кадры

- `01-session-loader-dark.png` — обычное движение на чёрном фоне.
- `02-session-loader-light.png` — светлая системная тема с чёрными бегунками.
- `03-session-loader-dark-reduce-motion-a.png` и `04-session-loader-dark-reduce-motion-b.png` — два последовательных кадра с включённым Reduce Motion. После декодирования в BMP они побайтно идентичны: статичная пара действительно не движется.
- `05-system-reduce-transparency-enabled.png` — отдельное доказательство фактически включённого системного переключателя «Понижение прозрачности».
- `05-session-loader-dark-reduce-motion-transparency.png` — результат в приложении при Reduce Motion + Reduce Transparency: ровно два белых шлейфа без свечения, нормальный статус-бар и полностью читаемый текст.
- `06-session-restoration-error-retry.png` — недоступный сервер: одна неповторяющаяся причина ошибки, рабочие «Повторить» и «Войти заново». Вторичная кнопка использует непрозрачный белый текст; на доминирующем фоне `#474751` измеренный по PNG контраст равен 9.18:1, что выше WCAG AA и AAA для обычного текста.
- `07-actual-keychain-restored-chats.png` — сохранённый в настоящем Keychain сеанс восстановлен живым API `http://127.0.0.1:8080` и переведён в экран «Чаты»; realtime подключён к `ws://127.0.0.1:8080/v1/realtime`.

## Контракт анимации

- Геометрия взята из `assets/brand/luxora-loader-route.svg`, SHA-256: `a31ee4352a86f16e8dca7a052abd4cd29e90ec2ad3577efc6c2a5a12488b415d`.
- Сам логотип и полный контур не рисуются.
- Видны ровно два бегунка, разнесённые на половину пути; оба идут в одном направлении с одинаковой скоростью и не встречаются.
- Один оборот занимает 1.8 секунды; каждый шлейф использует 14 точек на предыдущих 9% маршрута.
- При Reduce Motion фаза фиксирована. При сворачивании приложения часы анимации останавливаются.
- При Reduce Transparency исчезают glow и полупрозрачные материалы; остаются системные чёрный/белый цвета.

## Автоматические проверки

- `swift test --package-path apps/apple --filter LuxoraContourLoaderTests`: 8 тестов, 0 ошибок.
- `xcodebuild ... -scheme LuxoraMobile ... build`: сборка успешна.
- `testContourLoaderHasOneStableRussianAccessibilityStatus`: 1 тест, 0 ошибок; подтверждены одна русская accessibility-метка/значение и отсутствие `ProgressView`. Результат: `/tmp/luxora-loader-final-accessibility-20260804.xcresult`.
- `testOptInCancellationRetryAndErrorRecoveryPreserveActualKeychainSession`: 1 тест, 0 ошибок; проверены отмена восстановления, ошибка сети, повтор, сохранность реальной Keychain-сессии и переход в «Чаты». Результат: `/tmp/luxora-loader-final-recovery-live-20260804.xcresult`.

После съёмки Reduce Motion, Reduce Transparency и Increase Contrast возвращены в выключенное состояние; Simulator оставлен запущенным с живым сервером и корректным `/v1/realtime`.

Контрольные суммы находятся в `SHA256SUMS`.
