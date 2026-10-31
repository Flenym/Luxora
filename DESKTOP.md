# Luxora Desktop

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Status:** Electron Windows/Linux shell runs the real web client (`luxora://app` + loopback API bridge) with a CI smoke gate; macOS SwiftUI remains a frozen portability probe; no signed/packaged desktop release

## 1. Sequencing

Desktop product development is frozen until complete server platform + full iPhone. Current macOS/Windows/Linux code may receive truth/security/build/accessibility maintenance only. It must not create an independent protocol or be advertised as a downloadable finished client.

## 2. Native macOS foundation

`apps/apple` includes a SwiftPM `LuxoraMac` executable and XcodeGen `LuxoraDesktop` app using `LuxoraKit`. It can enter the explicit local preview or use the same thin `ApplicationSession` harness as iPhone: register/login, Keychain restore/refresh, chat/message load, optimistic text send and basic message/typing realtime. The iPhone-only `CallBanner`/`CallsStore` media UI is wired for the phone root and is not presented as a finished macOS calling surface. It still has no durable local DB/outbox, robust reconciliation, push, production calls, full remote message actions, signing/notarization or updater.

```bash
swift test --package-path apps/apple
swift run --package-path apps/apple LuxoraMac
```

After unfreeze, macOS should use the proven Swift server/iPhone domain/sync/storage layers while implementing desktop-specific:

- resizable navigation split view and inspector;
- commands/menus, global/in-conversation search and shortcuts;
- multiple windows/popouts where real server capability supports them;
- notifications, Dock/badge and background lifecycle;
- drag/drop/files with privacy preview;
- Keychain, sandbox entitlements, signed/notarized distribution and safe updater.

## 3. Electron Windows/Linux shell — real client mechanism (PR #110)

`apps/desktop` now serves the packaged Web build through Electron instead of a
`file://` URL, so the renderer has a stable, secure origin. The main process:

- registers the custom secure scheme **`luxora://app`** and serves the packaged
  `resources/web` tree through it (dev iteration can still point at a loopback
  `LUXORA_WEB_URL`);
- injects an in-handler **CSP** for that origin and keeps app sandbox, context
  isolation, `nodeIntegration:false`, `webSecurity` and navigation/window limits;
- exposes the API base URL through a **sandboxed CommonJS preload** (the previous
  ESM preload never loaded): the preload passes a validated
  `--luxora-api-base-url` value only for **loopback origins** (`127.0.0.1`,
  `localhost`, `[::1]`), otherwise the default `http://127.0.0.1:2222`; the web
  client honours the bridge only for loopback origins;
- adds the explicit `luxora://app` CORS origin to the API allowlist used by the
  desktop shell;
- supports a **`LUXORA_DESKTOP_SMOKE=1`** smoke mode and keeps narrow menu
  actions (New Message/Search) plus the external-host navigation allowlist.

The renderer is the real web client (public site + `/app` messenger) talking to a
loopback API; this is a working desktop shell, not a claim of desktop product
availability. A `desktop` CI job builds the web app, compiles the shell and runs
the smoke mode under Xvfb (ubuntu-24.04, 49 s), with an Electron CI-only
`--no-sandbox` switch required by the hosted runner while the application keeps
its sandbox/context-isolation/Node-integration protections.

Honest limits: packaged signed distribution (DMG/ZIP, NSIS, AppImage/deb),
notarization, signed anti-rollback updater, OS credential vault, tray/background
lifecycle and multi-window coordination are **not shipped**. The renderer origin
is `luxora://app` and the API bridge is loopback-only; hosted/remote API
deployments are not supported by this shell yet.

## 4. Build, run and CI

Build the Web app first because Electron packages `apps/web/dist`:

```bash
npm --prefix apps/web ci
npm --prefix apps/web run build
npm --prefix apps/desktop ci
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run start
```

Smoke mode (used by the `desktop` CI job under Xvfb):

```bash
LUXORA_DESKTOP_SMOKE=1 npm --prefix apps/desktop run start
```

The desktop job also sets `LUXORA_API_URL` to a loopback API when one is running;
without an API the shell still starts and its bridge keeps the loopback default.
Packaging definitions exist for DMG/ZIP, NSIS/portable, AppImage and deb. Running
`dist`, `dist:windows` or `dist:linux` produces unsigned/unreviewed artifacts
unless signing infrastructure is configured; these are not public downloads.

## 5. Desktop target contract after unfreeze

- Same auth/session/outbox/realtime/error/capability fixtures as full iPhone.
- OS credential vault (Keychain/Credential Manager/Secret Service) with no JS localStorage refresh token.
- Durable local cache/outbox with user-only permissions and logout/revoke purge.
- Renderer treated as hostile web content boundary; IPC allowlisted and typed.
- Native file dialogs validate returned paths/types and never expose arbitrary filesystem through preload.
- Background/tray behavior respects logout, updates, OS privacy/focus and battery.
- Multi-window shares one coordinated session/sync store without duplicate sockets/sends.

## 6. Electron security work before release

- Pin/track Electron security updates and define minimum secure version.
- Self-host/review fonts and tighten CSP without unnecessary `unsafe-inline`.
- Restrict `connect-src` to exact API origins, not general HTTPS/WSS.
- Validate permission checks as well as request handler and handle revocation.
- Store no secret in renderer; narrowly broker credential operations where necessary.
- Sign macOS/Windows packages, notarize macOS and verify Linux repository/package integrity.
- Signed updater with anti-rollback, staged rollout and emergency minimum version.
- Generate SBOM/provenance; scan packaged ASAR/native modules.
- Test malicious link, navigation, IPC, XSS, file and extension behavior.

## 7. Desktop UX/accessibility

- Keyboard can reach every chat/message/media/call action; menus expose canonical shortcuts.
- Right-click mirrors long-press semantics; no hover-only essential control.
- Window size/position/sidebar selection/draft restoration is deterministic and privacy-safe.
- Screen readers: VoiceOver on macOS, NVDA/JAWS on Windows, named Linux baseline.
- High contrast, text scaling, Reduce Motion/Transparency and RTL.
- Call/screen-share future surfaces use native source picker and persistent capture indicator.

## 8. Distribution gate

No platform is “available” until signed artifact, support matrix, real backend integration, update verification, crash/security/accessibility evidence and rollback are ready. Package target declarations and source-build instructions are not public availability.
