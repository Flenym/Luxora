# Luxora web messenger browser E2E + accessibility gate

Self-contained end-to-end gate for the web messenger (`apps/web` → `/app`). It
drives **two isolated Chrome browser contexts** through the real UI
(`puppeteer-core` + system Chrome) against a **real API and real SQLite
database**, runs an **axe-core WCAG 2.x A/AA accessibility audit** over the
product states and public pages, then tears everything down. It runs on GitHub
Actions (`web-e2e` job in `.github/workflows/node.yml`) and locally on Windows,
macOS and Linux.

No production code, tokens or fixtures are committed from a real environment:
every run generates its own development secrets in memory, a fresh SQLite
database in a temporary directory, and two throw-away accounts.

## What it proves (16 functional checks + accessibility audit)

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
| accessibility | axe-core WCAG 2.x A/AA audit of auth, shell, conversation, the three dialogs and the public home/docs/security pages; **critical/serious fail**, moderate/minor warn |

The run also captures desktop/mobile screenshots, per-state accessibility
screenshots, `a11y/a11y-report.json` + `a11y/a11y-summary.md`, the PASS/FAIL
matrix and API/vite logs. On failure the whole artifacts directory is uploaded by
CI.

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

### Accessibility-only mode

Runs just the axe audit (spawns/attaches to the servers like the normal run,
registers throw-away accounts and creates a Direct chat + pending request so all
audited states are non-empty):

```powershell
npm --prefix tools/web-e2e run a11y                       # self-contained
node tools/web-e2e/runner.mjs --a11y-only --attach        # live 2222/4173
```

Audited states: `app-auth`, `app-shell`, `app-conversation`,
`app-new-chat-dialog`, `app-requests-dialog`, `app-profile-dialog`,
`site-home`, `site-docs-introduction`, `site-security` (1440×900).

The gate runs axe-core with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and
`wcag22aa` tags. `critical`/`serious` violations fail the run (exit 1);
`moderate`/`minor` are reported as non-blocking warnings. Results are written to
`artifacts/a11y/a11y-report.json` (per-state, per-rule, selectors, node counts)
and `artifacts/a11y/a11y-summary.md` (human-readable). Known exceptions can be
allow-listed in `tools/web-e2e/a11y-baseline.json` — it is **empty by policy**
and additions require Lead approval plus a `reason`:

```json
{ "version": 1, "exceptions": [
  { "state": "app-conversation", "rule": "color-contrast", "selector": "[data-testid=...]", "reason": "..." }
] }
```

`E2E_SKIP_A11Y=1` skips only the accessibility phase (useful while iterating on
functional E2E); the CI job never sets it.

CSS animations/transitions are frozen with an injected audit-only stylesheet
before each axe run (and the page settles for two animation frames). This makes
the audit measure the settled UI: without it, marketing `.reveal` fade-ins were
mid-transition during measurement and produced transient, non-real
`color-contrast` findings.

## Configuration

| Variable | Meaning |
| --- | --- |
| `CHROME_PATH` | Explicit Chrome/Chromium binary. Auto-detected otherwise: `/usr/bin/google-chrome` (Ubuntu runners), `C:\Program Files\Google\Chrome\Application\chrome.exe` (Windows), `/Applications/Google Chrome.app/...` (macOS). |
| `E2E_ARTIFACTS_DIR` | Artifact root (default `tools/web-e2e/artifacts`, git-ignored). Contains `screenshots/`, `logs/`, `a11y/` and `e2e-report.json`. |
| `E2E_KEEP_TEMP=1` | Keep the temporary database/upload directory for debugging. |
| `E2E_API_PORT`, `E2E_WEB_PORT` | Orchestrated-mode ports (defaults 2222/4173; the vite proxy requires 2222). |
| `E2E_SKIP_A11Y=1` | Skip only the axe accessibility phase (functional E2E still runs). |

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
6. Run the functional suite, then the accessibility phase (same browser, fresh
   context); write reports; then close Chrome, stop children (SIGTERM →
   SIGKILL/taskkill) and remove the temp directory.

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

Expected runtime: ~3–5 min on a warm GitHub runner (installs/builds dominate; the
browser suite is well under a minute and the axe phase adds roughly 10–20 s).
Failure artifacts include the PASS/FAIL matrix (`e2e-report.json`), step
screenshots, accessibility reports (`a11y/a11y-report.json`,
`a11y/a11y-summary.md`), both failure screenshots and the captured API/vite logs.
Because the accessibility gate is part of `npm --prefix tools/web-e2e test`, the
CI job fails on critical/serious WCAG findings.

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
- **Accessibility timing**: the audit waits for each state's selector plus a
  short settle delay, and public pages wait for their `h1`; axe runs
  document-scope only (hidden elements are ignored by axe itself). The baseline
  file is empty, so any critical/serious regression fails the gate loudly.

## Files

```
tools/web-e2e/
  runner.mjs              CLI + PASS/FAIL matrix + functional browser suite + a11y phase
  lib/environment.mjs     secrets, builds, process spawn/wait/teardown, Chrome discovery
  lib/a11y.mjs            axe-core injection, per-state audit, gate, JSON/markdown reports
  a11y-baseline.json      accessibility allowlist (EMPTY; Lead approval + reason required)
  fixtures/pixel.png      1×1 PNG used by the upload step
  package.json            pinned puppeteer-core + axe-core dev dependencies
  package-lock.json
  .gitignore              node_modules/, artifacts/, *.log
```
