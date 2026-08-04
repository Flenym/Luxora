# Luxora Mobile

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Platforms in repository:** iPhone/iPad SwiftUI foundation; Android Compose foundation

## 1. Sequencing

The complete server platform comes first. The existing thin Apple integration harness may exercise real contracts during server work. The full iPhone app is blocked until the server-complete gate; iPad and Android full development is blocked until server + full iPhone are stable.

Apple can connect to the local API in a deliberately narrow harness. Its
Russian phone-first onboarding has completed one fixture-free local
development-provider journey through Chats and a Keychain relaunch restore, but
it is not a durable offline or full mobile product. Android remains demo-only.

## 2. Apple foundation

`apps/apple` is a Swift 6.2 package with deployment targets iOS 18 and macOS 15 plus an XcodeGen project containing an iPhone-only mobile target and a frozen macOS foundation (Xcode 26 configuration). There is no iPad application target in the current phase.

Current `LuxoraKit` provides:

- design tokens, logo and glass surface;
- participant/conversation/message/destination models;
- observable in-memory `MessengerStore` with typed remote chat/message operations;
- synthetic `DemoData`;
- `ApplicationSession`, Russian phone-first authentication views, legacy non-iOS authentication fallback, URLSession API client and basic WebSocket decoder;
- Keychain storage for current session credentials and an explicit local-preview mode/banner;
- list, conversation, composer, message row, new-message, contacts, profile/QR, folders, permissions, settings and root views;
- local folder filtering/counts, persisted contact sorting, loaded-message contact search, safe username copy/share and real iOS permission-state actions;
- remote phone challenge/OTP verification, existing-account versus profile-required branching, profile/bio/username registration, legacy register/login, restore and serialized runtime refresh, chat/message refresh/load/retry, optimistic text send/reconcile/retry with a stable client nonce, server mark-read/reactions, known-contact lookup/direct-chat creation, monotonic durable realtime cursor/message/typing apply and sign-out revoke;
- a searchable country picker, combined E.164 validation, local circular avatar crop/fallback, permission rationale and explicit synchronization state;
- 39 XCTest cases in the merged package checkpoint (38 pass plus one expected opt-in live skip), three additional Swift Testing cases, focused navigation/chat UI smokes, and opt-in live tests for phone registration/session restore plus registration/chat/send/read/reaction/realtime/revoke.

`MessengerStore.sendDraft()` uses delay-simulated sent/read only when no remote sender is configured. In signed-in mode it calls the API and replaces the optimistic item with the server result; a failed item can retry with the same nonce. Read cursors and reactions use the current server API. The harness still lacks a durable outbox/cache, attachment upload binding, pagination, edit/delete/reply/forward/pin UI operations, reconnect backoff and authoritative `sync.required` reconciliation.

Run shared package/macOS executable:

```bash
swift test --package-path apps/apple
swift run --package-path apps/apple LuxoraMac
```

With the local API running, the opt-in integration handshake is:

```bash
LUXORA_LIVE_TEST=1 swift test --package-path apps/apple --filter LiveBackendIntegrationTests
```

Generate iOS/macOS Xcode project when XcodeGen is installed:

```bash
cd apps/apple
xcodegen generate
```

## 3. Android foundation

`apps/android` targets SDK 36, minimum SDK 26, JDK 17, Kotlin 2.2.10 and Jetpack Compose/Material 3. The custom `gradlew` bootstraps Gradle 8.13 into an ignored cache.

Current state:

- adaptive Compose shell/list/conversation/components/theme;
- canonical logo copied into generated resources;
- in-memory `MessengerState.demo()` with filters/search/send;
- three local state unit tests;
- cleartext traffic disabled, Android backup disabled, INTERNET/notification permissions declared.

There is no HTTP/realtime/session/Keystore/database/push implementation. Full Android is frozen.

```bash
apps/android/gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

## 4. Thin iPhone server harness

Present/allowed now, intentionally minimal:

- typed HTTP and WebSocket clients against test environments (present for the core subset);
- Keychain session credential and basic restore/refresh/revoke (present; access-token persistence should be narrowed in the hardened design);
- serialized refresh coordinator (present and unit-tested);
- small durable outbox/cursor store to test process death/offline/reconciliation (still required);
- protocol fixture runner for media, push, calls and E2EE when server subsystem exists;
- diagnostics that contain no content/credentials.

Its implemented onboarding exists to validate the real phone contract. It must
not grow unsupported semantics, ship, or be described as full mobile
availability before the remaining server and client gates pass.

## 5. Full iPhone architecture after server gate

```text
SwiftUI feature views
  → observable feature models
  → domain/use cases
  → sync coordinator + durable outbox
  → protocol adapter
  → HTTP / WebSocket / upload / call signaling
  → local DB + Keychain + future protected device keys
```

Required behavior:

- registration/passkeys/recovery/devices and compromise response;
- all server-supported chats/community/message/media/search/call/privacy flows;
- optimistic local echo with canonical ID, explicit receipts and conflicts;
- offline/relaunch/background sync without data loss;
- contextual camera/mic/photo/notification permissions;
- APNs token rotation/revoke and privacy-safe payload;
- VoiceOver, Dynamic Type, hardware keyboard, Reduce Motion/Transparency;
- secure local cache/index/key lifecycle and diagnostic redaction.

## 6. iPad after full iPhone

Reuse proven domain/network/sync/storage, not a stretched phone view. Add adaptive two/three-pane navigation, multitasking/window resize restoration, keyboard shortcuts, pointer/context menu, drag/drop attachment privacy preview and no draft/call loss while scene changes.

## 7. Android after full iPhone

Implement the same golden protocol/offline/security corpus in Kotlin:

- repository + Room-equivalent durable local store with migrations;
- structured-coroutine sync/outbox and process-death recovery;
- Keystore-backed credential/key handling;
- WorkManager/background and FCM token lifecycle;
- notification channels, permission timing and privacy previews;
- phone/tablet adaptive Compose, TalkBack/font scale/RTL;
- device matrix from API 26 to declared supported target.

It must not mechanically port SwiftUI layout or share insecure JS state to accelerate parity.

## 8. Mobile security

- Access token memory-only; refresh/session credential in OS protected store.
- Future identity/private keys generated locally and hardware-backed when available; capability stated honestly.
- Local DB/index protected using reviewed key/data-protection design; app backups excluded or E2EE-reviewed.
- Certificate/TLS policy uses platform validation; pinning only with rotation/recovery analysis.
- Deep/universal links strictly parse host/path and never carry bearer/linking secret beyond a short-lived challenge.
- Screenshots/clipboard cannot be perfectly prevented; use secure surfaces only for narrow secrets and honest limitations.
- Root/jailbreak is a risk signal, not a false guarantee.

## 9. Mobile quality gates

- Real device + simulator/emulator; cold/warm launch, background/kill/relaunch.
- Wi-Fi/4G/5G/high RTT/loss/offline/flaps/captive transitions.
- Low storage, memory pressure, battery/thermal and clock skew.
- VoiceOver/TalkBack, largest text, high contrast, RTL, Reduce Motion/Transparency.
- Push denied/expired/rotated token and focus/do-not-disturb behavior.
- Media/call permission denied/revoked mid-flow; capture always stops.
- Signed artifact, privacy manifest/data safety, crash-free and rollback evidence.
