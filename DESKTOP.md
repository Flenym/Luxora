# Luxora Desktop

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Status:** macOS SwiftUI and Electron portability foundations; no full desktop client

## 1. Sequencing

Desktop product development is frozen until complete server platform + full iPhone. Current macOS/Windows/Linux code may receive truth/security/build/accessibility maintenance only. It must not create an independent protocol or be advertised as a downloadable finished client.

## 2. Native macOS foundation

`apps/apple` includes a SwiftPM `LuxoraMac` executable and XcodeGen `LuxoraDesktop` app using `LuxoraKit`. It can enter the explicit local preview or use the same thin `ApplicationSession` harness as iPhone: register/login, Keychain restore/refresh, chat/message load, optimistic text send and basic message/typing realtime. It still has no durable local DB/outbox, robust reconciliation, push, calls, full remote message actions, signing/notarization or updater.

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

## 3. Electron Windows/Linux foundation

`apps/desktop` packages the static Web build. The main process currently:

- enables app sandbox;
- uses context isolation, disables Node integration and insecure content;
- disables DevTools in packaged mode;
- limits navigation/new windows and allows external HTTPS only for selected Luxora hosts;
- grants media/notification permission only to a trusted renderer URL;
- injects a CSP for packaged content;
- exposes a narrow preload bridge with release and menu actions;
- provides New Message/Search desktop menu commands.

This is useful shell hardening, not proof that the renderer is a real messenger.

## 4. Build commands

Build Web first because Electron packages `apps/web/dist`:

```bash
npm --prefix apps/web ci
npm --prefix apps/web run build
npm --prefix apps/desktop ci
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run start
```

Packaging definitions exist for DMG/ZIP, NSIS/portable, AppImage and deb. Running `dist`, `dist:windows` or `dist:linux` produces unsigned/unreviewed artifacts unless signing infrastructure is configured; these are not public downloads.

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
