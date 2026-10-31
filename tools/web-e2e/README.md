# Luxora web messenger browser E2E

Self-contained end-to-end gate for the web messenger (`apps/web` → `/app`). It
drives **two isolated Chrome browser contexts** through the real UI
(`puppeteer-core` + system Chrome) against a **real API and real SQLite
database**, then tears everything down. It runs on GitHub Actions
(`web-e2e` job in `.github/workflows/node.yml`) and locally on Windows, macOS
and Linux.

No production code, tokens or fixtures are committed from a real environment:
every run generates its own development secrets in memory, a fresh SQLite
database in a temporary directory, and two throw-away accounts.

## What it proves (16 checks)

| Check | User journey |
| --- | --- |
| accounts registered | Two fresh accounts created through the public API |
| wrong password | Auth screen shows the server's honest error |
| A / B sign in | Real sign-in through the UI (password auth) |
| stranger guard | A stranger Direct is rejected by the server and the UI falls back to a message request; A sends it |
| request accept | B accepts the request; the Direct chat opens |
| B reopens chat | Chat list survives a reload |
| A opens chat | Accepted Direct is visible to A |
| realtime message | A sends; B receives over `/v2/realtime` **without reload** |
| reply | Reply through the message action menu reaches A in realtime |
| delivery ticks | Own message renders an honest tick (`sent`/`delivered`/`read`), never `failed` |
| image upload | Authenticated chunked upload → attachment message rendered |
| calls gating | `capabilities.features.calls=false` is surfaced honestly (no fake call UI) |
| profile menu | Profile menu opens |
| sign out | Sign-out returns to the auth screen |
| console hygiene | No unexpected page/console errors (expected 401/403 probes filtered) |

The run also captures desktop and mobile screenshots plus an API/vite log; on
failure the whole artifacts directory is uploaded by CI.

## Quick start (local, Windows/macOS/Linux)

Prerequisites: Node 22+, Chrome or Chromium installed, and the web E2E tool
dependencies installed once:

```powershell
npm --prefix tools/web-e2e ci
```

### Self-contained mode (default)

Spawns the API and `vite preview` itself. Expects ports **2222** (API) and
**4173** (web) to be free, because `apps/web/vite.config.ts` proxies
`/v1,/v2`,`/health` to port 2222 so the browser only talks to one origin.

```powershell
# builds API/web dist first if missing, then runs the suite
npm --prefix tools/web-e2e test
```

### Attach mode (against already-running servers)

Useful while iterating; does not spawn or build anything:

```powershell
node tools/web-e2e/runner.mjs --attach
# or explicit endpoints
node tools/web-e2e/runner.mjs --api-base http://127.0.0.1:2222 --web-base http://127.0.0.1:4173
```

### API spawn/env self-check (does not touch 2222/4173)

Validates the generated dev secrets, fresh-database boot and process teardown on
a private port:

```powershell
node tools/web-e2e/runner.mjs --api-only-check   # uses port 2232
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `CHROME_PATH` | Explicit Chrome/Chromium binary. Auto-detected otherwise: `/usr/bin/google-chrome` (Ubuntu runners), `C:\Program Files\Google\Chrome\Application\chrome.exe` (Windows), `/Applications/Google Chrome.app/...` (macOS). |
| `E2E_ARTIFACTS_DIR` | Artifact root (default `tools/web-e2e/artifacts`, git-ignored). Contains `screenshots/`, `logs/` and `e2e-report.json`. |
| `E2E_KEEP_TEMP=1` | Keep the temporary database/upload directory for debugging. |
| `E2E_API_PORT`, `E2E_WEB_PORT` | Orchestrated-mode ports (defaults 2222/4173; the vite proxy requires 2222). |

Run exit codes: `0` all checks passed, `1` any failed/aborted, `130/143` after
SIGINT/SIGTERM (children are always stopped).

## How orchestration works

`runner.mjs` → `lib/environment.mjs`:

1. `ensureApiBuild()` / `ensureWebBuild()` — run the missing workspace build
   only when `dist/` is absent (CI builds them explicitly first, so this is a
   no-op there).
2. Generate `JWT_SECRET`, `DATA_ENCRYPTION_KEYS` (`{"main":"<base64url 32B>"}`,
   `ACTIVE_DATA_ENCRYPTION_KEY_ID=main`), `ADMIN_TOKEN` with `crypto.randomBytes`.
3. Spawn `node services/api/dist/server.js` with a temp `DATABASE_PATH`,
   `STORAGE_LOCAL_PATH`, `UPLOAD_STAGING_PATH`, `HOST=127.0.0.1`, `PORT=2222`,
   `PHONE_AUTH_ENABLED=false`, and `CORS_ORIGINS` for the preview origin.
4. Poll `/health/ready` (never a fixed sleep); fail fast if the child exits.
5. Spawn `node apps/web/node_modules/vite/bin/vite.js preview --host 127.0.0.1
   --port 4173 --strictPort` and poll `/app`.
6. Run the suite; then close Chrome, stop children (SIGTERM → SIGKILL/taskkill)
   and remove the temp directory.

Chrome is launched with `--no-sandbox`/`--disable-dev-shm-usage` so it works on
rootless CI containers as well as desktops.

## CI

`web-e2e` job in `.github/workflows/node.yml` (ubuntu-24.04, Node 22.23.2,
timeout 15 min) runs only when the existing path filters match (they include
`apps/web/**`, `services/api/**` and now `tools/web-e2e/**`):

```yaml
- run: npm --prefix tools/web-e2e ci --no-audit --no-fund
- run: npm --prefix tools/web-e2e test
- uses: actions/upload-artifact@... # only if: failure()
  with:
    path: tools/web-e2e/artifacts
```

Expected runtime: ~3–4 min on a warm GitHub runner (installs/builds dominate;
the browser suite itself is well under a minute). Failure artifacts include the
PASS/FAIL matrix (`e2e-report.json`), step screenshots, both failure screenshots
and the captured API/vite logs.

## Flakiness notes and mitigations

- **Fixed sleeps are avoided.** Every UI assertion is a `waitForSelector` /
  `waitForFunction` / polling body-text check with a generous timeout, so slow
  CI machines pass without slowing fast machines.
- **Auth rate limits**: accounts use unique usernames per run and the register
  loop honours `Retry-After` with bounded retries (fresh DB: two registrations
  total).
- **Realtime assertions** wait for the other browser context's rendered text —
  the same observable a user sees — not for WebSocket internals.
- **Chrome version drift**: `puppeteer-core` is pinned; the runner uses the
  system Chrome via `CHROME_PATH`/auto-detection. If a runner image ships an
  incompatible Chrome, set `CHROME_PATH`.
- **Port conflicts**: orchestrated mode fails fast if the API/preview child
  exits (mode/port hints in the error and `artifacts/logs/*.log`). Use
  `--attach` when local servers already occupy 2222/4173.
- **Secrets**: generated tokens/passwords are never printed; only non-secret
  details (HTTP status, step names, screenshots) are reported.

## Files

```
tools/web-e2e/
  runner.mjs              CLI + PASS/FAIL matrix + browser suite
  lib/environment.mjs     secrets, builds, process spawn/wait/teardown, Chrome discovery
  fixtures/pixel.png      1×1 PNG used by the upload step
  package.json            pinned puppeteer-core dependency
  package-lock.json
  .gitignore              node_modules/, artifacts/, *.log
```
