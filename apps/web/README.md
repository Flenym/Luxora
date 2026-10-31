# Luxora Web

Маркетинговый сайт и web-клиент мессенджера Luxora на React, TypeScript и Vite.

- Владелец и разработчик: **Flenym**
- Текущий релиз: **Beta-0.1**
- Статус: публичный сайт завершён, `/app` — developer preview, не выпущенный клиент

## Два продукта в одном приложении

- **Публичный сайт** (`src/pages`, `src/components`, `src/docs.ts`): 14 маршрутов —
  лендинг с lazy Three.js hero, download, security, docs-портал (22 страницы RU/EN),
  FAQ, about, blog, status, contact, privacy/terms, 404. RU/EN локаль, per-page
  metadata, canonical/Open Graph/JSON-LD, `robots.txt` (disallows `/app`),
  `sitemap.xml`, skip link, reduce-motion. Сайт не делает backend-запросов, не
  использует аналитику/cookies (кроме выбора языка) и не отдаёт реальных
  download-артефактов — платформенные карточки остаются «Coming Soon».
- **Web-клиент мессенджера `/app`** (`src/app`): работает против реального Beta-0.1
  API и realtime.

## Локальный запуск

```bash
npm install
npm run dev      # http://127.0.0.1:4173 — сайт на /, клиент на /app
```

Vite dev/preview проксирует `/v1`, `/v2` (websockets) и `/health` на локальный API
`http://127.0.0.1:2222` (см. `vite.config.ts`), поэтому `DEFAULT_API_BASE` остаётся
same-origin. Для hosted/desktop сборки, говорящей с другим origin, задаётся
`VITE_LUXORA_API`.

## Проверки

```bash
npm run typecheck
npm run build
npm test         # Vitest: 49 unit-тестов (api 17, realtime 13, store 19)
npm run preview
```

## Что реализовано в `/app`

Auth (username+password, device name, session boot из `sessionStorage`,
single-flight refresh, sign-out); sidebar (server+local search, All/Unread/Archived,
unread badges, new chat по username), message requests, profile edit; conversation
(cursor history, optimistic send с same-nonce retry, reply/edit/delete, реакции,
pins, честные delivered/read только по authoritative receipts, image upload +
thumbnail, file cards, authenticated download/avatars, typing, approximate
realtime presence, per-chat local drafts, read receipts on open/focus, day
separators, load-older, new-messages divider); realtime `/v2` (cursor resume,
`sync.required` → HTTP reload/reconnect, bounded backoff, close-code handling);
call signalling UI (incoming accept/decline, active overlay с hangup) с honest
`unavailable` media, пока сервер не рекламирует calls; access token memory-only,
refresh token только в `sessionStorage`.

## Честные gaps (не заявлять как готовое)

- нет server-synced drafts/folders UI (drafts/folders — локальные);
- нет видео/screen share, PWA/service worker/Web Push, offline-кэша сообщений;
- calls media не проверено end-to-end: без медиаплана `features.calls:false`,
  адаптер остаётся `unavailable`, звук не имитируется;
- presence приблизительный и только realtime;
- формального WCAG-аудита `/app` и hosting CSP/headers ещё нет; refresh в
  `sessionStorage` — предмет отдельного review до production-хостинга;
- публичный сайт объявляет canonical origin `https://luxora.app`, но деплой и
  заголовки этим репозиторием не поставляются.

## Browser E2E (committed CI gate)

`tools/web-e2e` гоняет два изолированных Chrome-контекста против реального API и
временной SQLite (генерируемые dev-секреты и CSPRNG-аккаунты, `vite preview`,
system-Chrome autodetect, process-tree cleanup) и входит в `web-e2e` job
`.github/workflows/node.yml` — **16/16 user-observable checks PASS в GitHub
Actions**. Локально:

```bash
npm --prefix tools/web-e2e ci
npm --prefix tools/web-e2e test                  # self-contained: API :2222 + preview :4173
node tools/web-e2e/runner.mjs --attach            # против уже запущенных серверов
```

Подробности — `tools/web-e2e/README.md`.

Правила truth и release-гейты — в корневых `WEB.md`, `SECURITY.md` и
`PROJECT_STATE.md`. Никаких заявлений E2EE, real push или production-звонков:
Beta-0.1 — server-readable Cloud preview.
