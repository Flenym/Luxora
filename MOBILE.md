# Luxora Mobile

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Platforms in repository:** iPhone/iPad SwiftUI foundation (call preview included); Android Compose foundation

## 1. Sequencing

The complete server platform comes first. The existing thin Apple integration harness may exercise real contracts during server work. The full iPhone app is blocked until the server-complete gate; iPad and Android full development is blocked until server + full iPhone are stable.

Apple can connect to the local API in a deliberately narrow harness. Its
Russian phone-first onboarding has completed one fixture-free local
development-provider journey through Chats and a Keychain relaunch restore, and
the calls preview now has a conversation-level call banner plus LiveKit voice
when the server media plane is configured. It is still not a durable offline or
full mobile product. Android remains demo-only.

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
- a calls preview: `LuxoraCallsAPIClient` (create/ring/accept/decline/hangup/join-grant/list, safe error mapping without response bodies), `LuxoraCallRealtimeDecoder` (`call.state.changed` in realtime v2, strict fields, no media fields), `CallsStore` (incoming/active state driven by server reads, `call.state.changed` used only as a refresh trigger), `CallMediaSession` (LiveKit SDK, publish microphone, count remote audio tracks, never log/store the join token), a `CallBanner` above the conversation with accept/decline/hangup and honest media text, and an audio-call toolbar button;
- a newer calls product surface (**verified by Apple CI**): recent-calls tab with server-derived direction/missed/status/duration, per-chat call-history sheet, full-screen active-call cover with a server-anchored elapsed timer, microphone mute only when media is connected, visibly unavailable speaker, hangup and an honest media status line, call-back, and a locked honest screen when `features.calls` is false. Audio only; no CallKit, no push ringing, no video/screen share, no media-E2EE;
- safety reports (**verified by Apple CI**, PR #109): `LuxoraSafetyAPIClient` (own-report cursor list, nonce-idempotent submit with exact category/comment/alsoBlock, sanitized errors), `SafetyReportsStore`, and a report sheet opened from the message menu for messages authored by another account with explicit cloud-preview consent; «Мои жалобы» list with cursor pagination;
- account data (**verified by Apple CI**, PR #109): `AccountDataStore` (bounded export polling, range download verified against server-declared size+SHA-256 via CryptoKit before sharing, deletion state machine using the server role-enforced seven-day grace, cancel refused after the deadline without network calls) and `PhoneAccountDataViews` (typed «УДАЛИТЬ» confirmation, grace deadline, honest pending/executing/completed/failed states); no instant-deletion claim;
- a searchable country picker, combined E.164 validation, local circular avatar crop/fallback, permission rationale and explicit synchronization state;
- the merged Swift package (PR #109 head `beb6ca7`, 31 October 2026) runs **455 XCTest cases executed, 6 expected live-only skips, 0 failures** plus **20 Swift Testing cases**, including calls, community-management and the new safety/account-data contract/store tests (`SafetyReportContractTests`, `AccountDataStoreTests`). Swift cannot be built or tested on the Windows workspace — CI is the only execution evidence.

`MessengerStore.sendDraft()` uses delay-simulated sent/read only when no remote sender is configured. In signed-in mode it calls the API and replaces the optimistic item with the server result; a failed item can retry with the same nonce. Read cursors and reactions use the current server API. The harness still lacks a durable outbox/cache, pagination, reconnect backoff and authoritative `sync.required` reconciliation, and has no real-device/offline evidence. The calls preview additionally lacks push/CallKit ringing, video/screen share, media-E2EE and real-device media evidence; its media only works against a server whose LiveKit/TURN configuration is complete, and the local API without a media plane keeps `features.calls:false`.

Implemented iPhone surfaces that must not be read as missing (as read
from the current sources): attachments (composer media strip, photo picker up to
10 images, file importer, upload→send with `attachmentIds`, image bubble, viewer
with pinch-zoom, file row), topics (`ChatTopicsStore`, management in the
community profile, composer chips, history filter, `topicID` through the send
funnel), voice (recorder with elapsed/levels, recording bar, playback with
waveform, consent toggle and transcript submission), chat folders, synchronized
drafts (load/autosave/delete/retry plus composer sync state), message actions
(reply/edit/delete/forward/pin/reaction), message-request data layer and privacy
policy, notification settings, blocked-users list with unblock, server
devices/password settings, appearance and local data settings, and the
device-link QR sheet. Calls product surface, community management (invite links
shown-once + revoke, join-request queue, ownership transfer, join-by-link), safety
reports and account export/deletion UI are verified by Apple CI on PR #109 head
`beb6ca7`: swift-package green — **455 XCTest executed / 6 skipped / 0 failures**
plus **20 Swift Testing** (including `CallHistoryTests`,
`CommunityManagementStoreTests`, `SafetyReportContractTests`,
`AccountDataStoreTests`); `ios-compile` PASS. Safety and account data are shipped
with honest limits: server-readable beta content consent is explicit in the
report sheet, and deletion follows the server's real seven-day grace — no
instant-deletion or E2EE claim.

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
- protocol fixture runner for media, push, calls and E2EE when the subsystem exists; the calls preview already uses the real REST signaling contract and the real LiveKit Swift SDK for voice — it is not a fixture;
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
