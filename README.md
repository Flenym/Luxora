# Luxora

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Статус:** технический preview, не production-сервис

Luxora — премиальный мессенджер для личных разговоров и осмысленных сообществ. Его ключевой продуктовый принцип: модель приватности должна быть понятна до отправки первого сообщения, а скорость интерфейса не должна скрывать реальные состояния доставки и ошибки.

> **Важно:** Beta-0.1 не использует end-to-end encryption. Сервер обрабатывает содержимое сообщений. Не используйте текущую сборку для чувствительных данных. Работающие звонки, APNs push-доставка, QR-linking, E2EE Private Spaces, production media-processing и production-scale инфраструктура пока не реализованы. Изолированные call-control/SFU/TURN, push-registration и media-storage foundations ниже не являются готовыми пользовательскими функциями.

## Что действительно работает

| Область | Состояние Beta-0.1 |
| --- | --- |
| Shared protocol | Zod-контракты HTTP/realtime, лимиты, стабильные типы и тесты |
| Backend | Node.js 22, Fastify, SQLite WAL, health/readiness, OpenAPI, Prometheus metrics |
| Auth | Argon2id legacy login, short-lived HS256 access JWT, hash-only rotating refresh tokens, per-device sessions/revoke и default-off phone OTP slice с ветками existing account / `profile_required` / `password_required`, username suggestions и encrypted exact replay; отдельный post-OTP password hash не открывает legacy password-login. Реальный SMS, recovery и legacy phone binding ещё открыты |
| Identity/access | Exact privacy-filtered lookup, accepted relationships, message requests, quiet dismiss, directed blocks и selected-evidence reports |
| Passkey foundation | Внутренние authenticated add-authenticator, identifier-free sign-in и pre-account first-passkey signup seams плюс non-routed durable authenticator list/rename/revoke foundation: строгий raw HTTP boundary, зашифрованные SQLite intents/challenge/handle/credential/label records, атомарные session/token/revoke commits, last-active invariant, replay recovery и expiry reconciliation. Routed flags по умолчанию `false`, production запрещает их включение, management routes отсутствуют и `features.passkeys:false`; public enablement/management UX, notifications и recovery ещё не реализованы |
| Messaging | Direct/group/channel, text/media contracts, replies, privacy-minimized forward, edit history, topics, pins, reactions и receipts |
| Media/storage | Resumable encrypted staging, authorized local/S3 object storage, byte-range download, quota/restart/orphan tests; обычные вложения честно помечены `unscanned`, а профильная аватарка проходит отдельную decode/crop/metadata-strip/PNG re-encode границу с `server_verified` metadata. Общий scan/transcode pipeline ещё отсутствует |
| Realtime | WebSocket auth, account/session-bound V2 cursor, bounded replay + authoritative HTTP reconciliation, heartbeat/backpressure, typing и process-local presence |
| Notifications foundation | Session-bound APNs token registration/rotation/revoke with encrypted-at-rest token and token-free projections plus synchronized privacy-first notification preferences; APNs provider credentials, delivery jobs, payloads and real-device evidence are still absent, so `features.push:false` |
| Storage protection | В production-конфигурации обязательный AES-256-GCM envelope для message bodies и durable event payloads; это не E2EE |
| Calls foundation | Изолированный versioned call-control/grant aggregate и loopback LiveKit/coturn harness; нет API/signaling/client и звонки не работают |
| Apple | Русский phone-first SwiftUI harness: страна/номер, OTP, новый профиль/bio/local avatar crop, server username check, permission primer и Keychain restore; реальные chat refresh/load, optimistic send/retry, read/reactions и known-contact direct chat; Telegram-подобные профили/QR/папки/permission routes. Fixture-free Simulator прошёл live onboarding и chat integration, но durable offline, media/calls/push и 62/62 pixel closure ещё открыты |
| Android | Нативная Compose foundation с локальным state и unit tests; не подключена к API |
| Web | Адаптивный landing и интерактивный локальный messenger prototype; не является сетевым клиентом |
| Desktop | Hardened Electron shell для Web build; Windows/Linux являются portability probe, не готовым релизом |

Фактический контракт backend описан в [BACKEND.md](BACKEND.md), [API.md](API.md) и [DATABASE.md](DATABASE.md). Продуктовая цель и ограничения — в [docs/specs/PRODUCT_REQUIREMENTS.md](docs/specs/PRODUCT_REQUIREMENTS.md).
Полный критерий «всё работает» для iPhone ведётся в [функциональной матрице](docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md).

## Жёсткий порядок разработки

1. **Полная server platform.** После текущих локальных text/media/identity/call foundations последовательно завершить devices/passkeys/recovery, полный chat/community и media-processing domain, voice/video messages, search, push, synchronized presence/receipts, API-integrated call signaling/SFU/TURN/screen share, key management и audited E2EE, moderation/jobs/production storage/backups/monitoring/DR.
2. **iPhone thin integration harness во время server-фазы.** Только проверка реальных контрактов, auth, sync, offline и протокольных fixtures; это не разрешение полировать/расширять полный клиент раньше сервера.
3. **Полный iPhone.** Все запланированные продуктовые функции и mobile gates реализуются после стабильной server platform.
4. **iPad, macOS, Android, Web, Windows, Linux и публичный сайт.** Размораживаются только после стабильных server + full iPhone. Пока это foundations/portability/design probes и truth/security/build fixes.

E2EE и звонки входят в server program только как самостоятельные gated подсистемы: наличие инфраструктуры не разрешает claims без аудита и end-to-end client evidence. Этот порядок предотвращает расхождение semantics между семью клиентами. Подробности: [ROADMAP.md](ROADMAP.md) и [TODO.md](TODO.md).

## Быстрый запуск backend

Требования: Node.js 22+, npm и нативный toolchain для `better-sqlite3`/`argon2`.

```bash
npm --prefix packages/protocol ci
npm --prefix packages/protocol run build
npm --prefix services/api ci
cp services/api/.env.example services/api/.env
# Замените JWT_SECRET и задайте локальные DATA_ENCRYPTION_KEYS +
# ACTIVE_DATA_ENCRYPTION_KEY_ID; без активного AES-ключа API не стартует.
set -a; source services/api/.env; set +a
npm --prefix services/api run dev
```

Проверка:

```bash
curl http://127.0.0.1:8080/health/ready
open http://127.0.0.1:8080/docs
```

Для локального Docker preview:

```bash
cp .env.example .env
# Замените JWT_SECRET, DATA_ENCRYPTION_KEYS и ACTIVE_DATA_ENCRYPTION_KEY_ID;
# .env исключён из Git. Для входа с iPhone Simulator дополнительно
# включите PHONE_AUTH_ENABLED=true, PHONE_AUTH_PROVIDER=development,
# PHONE_AUTH_HMAC_SECRET и PHONE_AUTH_DEVELOPMENT_CODE.
make compose-up

# Отдельная development-only консоль показывает текущий фиксированный OTP.
# Она доступна только на этом ПК и не входит в production-профиль.
docker compose --profile development up -d otp-console
open http://127.0.0.1:8081
# Либо без браузера:
curl --fail http://127.0.0.1:8081/api/code
```

Compose слушает только loopback. Это не публичный deployment. Полная инструкция: [DEPLOY.md](DEPLOY.md).

## Клиенты

```bash
# Web prototype
npm --prefix apps/web ci
npm --prefix apps/web run dev

# Apple shared package and macOS executable
swift test --package-path apps/apple
swift run --package-path apps/apple LuxoraMac

# Android foundation (JDK 17 + Android SDK 36)
apps/android/gradlew testDebugUnitTest assembleDebug

# Electron shell; сначала соберите apps/web
npm --prefix apps/desktop ci
npm --prefix apps/desktop run start
```

Platform truth и ограничения собраны в [CLIENTS.md](CLIENTS.md), [WEB.md](WEB.md), [MOBILE.md](MOBILE.md) и [DESKTOP.md](DESKTOP.md).

## Проверки

```bash
make install
make check
make build
make apple-test
make android-test
make docker-build
```

`make check-truth` блокирует известные неканонические release labels и неподтверждённые E2EE/call claims в клиентском коде. Полная стратегия: [TESTING.md](TESTING.md).

## Структура репозитория

```text
apps/
  apple/       shared SwiftUI foundation; thin iPhone target and frozen macOS probe
  android/     Kotlin + Jetpack Compose foundation
  web/         React + Vite landing/messenger prototype
  desktop/     Electron shell for Windows/Linux portability
packages/
  protocol/    canonical HTTP/realtime schemas and types
  passkey-domain/ audited WebAuthn ceremony orchestration used by the gated internal API seam
  call-control/ isolated call state/grant/persistence domain; not API-integrated
services/
  api/         Fastify API, realtime gateway, SQLite repository
docs/
  research/    source-backed competitor/product research
  specs/       canonical product, UX, threat and release gates
infra/         local/reference observability configuration
assets/        derived brand assets and reviewed loader route
design-previews/ standalone design evidence; not product clients
.github/       CI, dependency updates and security workflows
```

## Документация

| Документ | Назначение |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Текущая и целевая архитектура, boundaries и sequencing |
| [ROADMAP.md](ROADMAP.md) / [TODO.md](TODO.md) | Этапы, зависимости, приоритеты и открытая работа |
| [DESIGN.md](DESIGN.md) / [ANIMATIONS.md](ANIMATIONS.md) | Бренд, tokens, glass, motion и accessibility |
| [docs/specs/BRAND_LOADING_MOTION.md](docs/specs/BRAND_LOADING_MOTION.md) | Невидимая outer/internal logo-route загрузка и platform gates |
| [BACKEND.md](BACKEND.md) / [API.md](API.md) | Service contract, HTTP и WebSocket |
| [docs/specs/REALTIME_SYNC.md](docs/specs/REALTIME_SYNC.md) | V2 scoped cursor, checkpoint order, HTTP rebuild и explicit residuals |
| [docs/specs/PASSKEY_PLATFORM.md](docs/specs/PASSKEY_PLATFORM.md) | Internal-only add/sign-in/signup foundations и оставшиеся public passkey gates |
| [SECURITY.md](SECURITY.md) | Честный security contract и обязательные gates |
| [DATABASE.md](DATABASE.md) | SQLite schema, транзакции, encryption scope и migration path |
| [DEPLOY.md](DEPLOY.md) | Local preview, production prerequisites, backup и rollback |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [STYLEGUIDE.md](STYLEGUIDE.md) | Engineering process и conventions |
| [TESTING.md](TESTING.md) | Существующие suites, CI и недостающее evidence |
| [CHANGELOG.md](CHANGELOG.md) | Изменения единственного публичного релиза Beta-0.1 |
| [docs/specs/CALLS_PLATFORM.md](docs/specs/CALLS_PLATFORM.md) | Gated call-control, SFU/TURN и media trust contract |
| [docs/specs/IDENTITY_ACCESS.md](docs/specs/IDENTITY_ACCESS.md) | CURRENT IA-1 boundary и TARGET authenticator/recovery/privacy lifecycle |

## Product truth

- Публичный release label: только **Beta-0.1**.
- Владелец и разработчик: только **Flenym**.
- Термин `Private` зарезервирован для будущего доказанного E2EE режима.
- Текущий режим называется `Cloud preview`: transport protection не скрывает plaintext от application/server layer.
- Roadmap-функция не показывается работающей без явной метки `prototype`, `demo` или `coming later`.
- Целевые SLO являются gates, а не текущими обещаниями.

Исследование Telegram, WhatsApp, Signal, Discord и Apple HIG: [docs/research/PRODUCT_RESEARCH.md](docs/research/PRODUCT_RESEARCH.md). Canonical quality bar: [docs/specs/RELEASE_QUALITY_GATES.md](docs/specs/RELEASE_QUALITY_GATES.md).
