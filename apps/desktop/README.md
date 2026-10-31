# Luxora Desktop

Secure Electron shell for the local Luxora web build on Windows, Linux, and macOS.

- Product release: **Beta-0.1**
- Developer and owner: **Flenym**
- Renderer sandboxing and context isolation are mandatory.
- Node integration is disabled; the sandboxed preload exposes only an immutable
  `window.luxoraDesktop` bridge (product metadata plus the validated loopback
  API origin).
- External navigation is denied unless a host is explicitly allowlisted.

## Renderer origin and API bridge

- Packaged builds, and `npm run start` when `LUXORA_WEB_URL` is unset, serve the
  web messenger through the secure standard custom scheme **`luxora://app`**
  from `resources/web` (development: `../web/dist`). That gives the renderer a
  stable origin instead of `file:` and lets a strict CSP apply.
- `LUXORA_WEB_URL` still points the shell at a Vite dev/preview server, but only
  loopback `http://127.0.0.1` / `http://localhost` values are trusted.
- `LUXORA_API_URL` configures the API origin passed to the web client through the
  bridge; only loopback `http(s)` origins are accepted (default
  `http://127.0.0.1:2222`). The desktop CSP allows exactly that origin and its
  WebSocket counterpart in `connect-src`; `script-src` stays `'self'`.
- The API must allow the desktop renderer origin `luxora://app` in its
  `CORS_ORIGINS` (see `scripts/start-server.ps1` and `.env.example`).

Run `npm run start` after building `../web`. Distribution commands are available
for Linux and Windows in `package.json`.

## Headless smoke check

`LUXORA_DESKTOP_SMOKE=1` loads the renderer, verifies that the bridge value
reached the page and that the web messenger mounted into `#root`, prints
`LUXORA_DESKTOP_SMOKE_OK <url>`, and exits `0` (bounded timeout exits `1`).
On Linux run it under `xvfb-run`; CI covers it in the `desktop` job.
