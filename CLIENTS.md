# Luxora Clients

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Status:** foundations/prototypes; no full connected client

## 1. Execution freeze

The complete server platform is the active product priority. A thin iPhone integration harness may validate evolving contracts. Full iPhone work starts only after server completion; iPad, macOS, Android, Web, Windows, Linux and public-site expansion start only after stable server + full iPhone.

Existing clients are valuable design/portability probes but do not define independent backend semantics.

## 2. Current matrix

| Platform | Technology | Current repository state | Working network product? |
| --- | --- | --- | --- |
| iPhone/iPad | SwiftUI | Russian phone-first UI, Telegram-like chat/profile/settings routes, API/Keychain/realtime chat operations, live local onboarding/chat evidence and separate Design Lab | Partial connected harness, not full/offline-ready |
| macOS native | SwiftUI/SwiftPM | same thin harness/local preview in executable | Partial harness, not full desktop |
| Android | Kotlin/Compose | adaptive local `MessengerState.demo()` | No |
| Web | React/TypeScript/Vite | public site + local in-tab messenger interaction demo | No |
| Windows/Linux | Electron | hardened shell packages the Web build | No |

Apple can request and verify a phone challenge, branch an existing account from
new profile registration, check a username, restore/refresh a Keychain session,
refresh/load chats and messages, retry optimistic text with the same client
nonce, mark read, add/remove reactions, find a known contact, create/open a
direct chat and consume basic message/typing realtime frames against the local
API. Fixture-free iPhone Simulator runs completed the development-provider
new-account path through Chats, restored that session after relaunch and
exercised registration/chat/send/read/reaction/realtime/revoke. Profile QR,
safe share/copy, local chat-folder filters and iOS permission states are also
implemented. Its message store is still in memory: there is no durable
outbox/cache, pagination, attachment binding, robust reconnect/reconcile or full
operation coverage. The separate Apple Design Lab and all Android/Web demo
chats remain local; simulated states must remain visibly labelled. Web persists
only theme preference.

## 3. Canonical cross-client contract

Every future client consumes `@luxora/protocol` semantics via generated/manual typed adapters and golden JSON fixtures. Shared meanings:

- opaque IDs and canonical server order;
- client nonce/idempotent retry;
- local queued → server accepted → explicit delivered → read → failed;
- edit revision conflict and tombstone delete;
- per-user authorized realtime cursor/replay/sync-required;
- short-lived access, rotating refresh and per-device revoke;
- exact public error codes and capability negotiation;
- explicit Cloud/Private/Moderated trust class.

Clients may use different language frameworks but cannot infer delivery from timers, presence from a cached boolean, security from an icon or capability from a visible mock control.

## 4. Thin iPhone integration harness

Allowed during server phases:

```text
test SwiftUI/CLI surface
  → protocol adapter
  → HTTP + WebSocket clients
  → Keychain session test store
  → durable outbox/cursor test database
  → reconciliation/interoperability fixtures
```

It verifies server auth, sync, media/push/call/E2EE subsystems as they become available. It may use synthetic accounts and rough diagnostics; it must not be marketed as the full iPhone app or cause other clients to unfreeze.

## 5. Target client layers

1. **Presentation:** native/adaptive screens and accessible interaction.
2. **Feature state:** explicit loading/offline/conflict/permission state machines.
3. **Domain:** platform-neutral conversation/message/session invariants.
4. **Sync coordinator:** outbox, optimistic entities, cursor/reconciliation and capability gates.
5. **Transport:** HTTP, WebSocket, future upload/push/call signaling.
6. **Local storage:** messages/drafts/outbox/index with OS protection and migrations.
7. **Credential/key storage:** OS vault, future device/E2EE keys and secure deletion strategy.

Views never own refresh tokens, raw SQL or ordering policy. Demo data source and real data source cannot silently fall back into one another.

## 6. Offline/sync behavior

- Draft persists locally without storing credentials/content in logs.
- Send creates UUID nonce and durable outbox record before clearing composer.
- HTTP acceptance reconciles local/canonical identity without visible duplicate/jump.
- WebSocket applies authorized dispatch in order and advances cursor after durable local apply.
- Duplicate/out-of-order event is ignored/deterministically applied.
- `sync.required` runs bounded HTTP reconciliation while preserving newer realtime head/outbox.
- Removed membership converts queued item to actionable permanent failure; no infinite retry.
- Relaunch, storage pressure, clock skew and token refresh race are tested.

This target is not implemented by current client prototypes.

## 7. Credentials and local data

- Access token: memory, short lifetime.
- Refresh/session credential: Keychain/Android Keystore-backed store/OS vault or reviewed secure HttpOnly Web design.
- Never Web `localStorage`, plain preferences, source or analytics for long-lived credential.
- Logout/session revoke purges credential, private caches/index keys and active socket.
- Local message/index database protection is platform-reviewed; hardware backing is a capability, not universal claim.
- Future E2EE device keys never cross into generic telemetry/support bundles.

## 8. Capability-driven UI

Before unfreezing full clients, server exposes versioned capabilities for message/file/group limits, media types, trust class, calls, push, search and minimum client/protocol. Unsupported feature is absent or clearly unavailable; a client never hardcodes roadmap marketing as working.

Security-critical incompatibility blocks safely: keep/export draft and show `This version can’t safely join this conversation`; never plaintext fallback.

## 9. Platform responsibility

- Apple: platform-native navigation/materials, Keychain, background/push and adaptive iPhone/iPad/macOS scenes.
- Android: Material/Compose patterns, Keystore, process-death restoration, notification channels and broad hardware matrix.
- Web: browser session/XSS/service-worker/cache threat boundary, feature detection and keyboard/screen-reader quality.
- Desktop: native menus/windowing/tray, OS vault, signed updater/anti-rollback, sandboxed renderer.

Pixel parity is not required. Semantic, security and user-outcome parity is.

## 10. Release gate for a platform

A platform is “available” only with installable signed artifact/URL, exact support matrix, real backend integration, core offline/reconnect tests, accessibility audit, safe local credential/data behavior, crash/performance evidence, security scan and tested update/rollback. Source code or a demo window is not public availability.

See [MOBILE.md](MOBILE.md), [DESKTOP.md](DESKTOP.md) and [WEB.md](WEB.md).
