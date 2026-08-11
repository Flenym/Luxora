# Luxora Apple foundation

Owner and developer: **Flenym**. Public release label: **Beta-0.1**.

The current iPhone target is a server-integrated Beta-0.1 foundation, not the
completed Luxora client. Its current Russian shell uses four root tabs —
Contacts, Calls, Chats and Settings — plus a separate Search control; Spaces are
reached from Chats. It can branch login versus registration from the live phone
OTP response, collect a new profile and username, restore a Keychain session,
load the implemented chat/message slice, send text and consume the implemented
realtime frames. The connected chat slice includes refresh/load/error/retry,
stable-nonce optimistic send retry, reply/edit/delete/forward/pin, mark-read,
reactions, message requests, synchronized archive/mute and custom folders,
known-contact direct-chat creation, and group/channel membership management.
Telegram-like Russian profile/QR, processed-avatar upload, device and optional
phone-password settings, notification preferences, Settings and real iOS
permission-state routes are present, with unsupported operations visibly
gated. The first-launch and saved-session restoration surfaces use the native
invisible-route contour animation. Durable media messaging, call signaling,
real push delivery, E2EE and a durable offline outbox remain gated by their
server/client phases.

## Open in Xcode 26.6

`project.yml` is the source of truth. It references the canonical root
`logo.png` directly, so no drifting Apple-only logo copy is created. Generate
`Luxora.xcodeproj` with the same pinned XcodeGen release verified by
[`apple.yml`](../../.github/workflows/apple.yml):

```bash
cd apps/apple
xcodegen generate --spec project.yml
open Luxora.xcodeproj
```

Select the `LuxoraMobile` scheme and an iPhone simulator. `project.yml` remains
the source of truth, while the generated shared project, workspace metadata and
shared schemes are checked in so a clean clone opens directly. Regenerate them
after changing `project.yml`; Xcode per-user state remains ignored. The target
is iPhone-only for this phase. Full iPad work remains frozen until the complete
iPhone client is stable.

Two iPhone applications are generated on purpose:

- `LuxoraMobile` (`app.luxora.mobile`) is the production target. It links only
  `LuxoraKit`, uses the real API/session state, and contains no fixture entry.
- `LuxoraDesignLab` (`app.luxora.designlab`) is a separately named visual test
  application. It links `LuxoraDesignFixtures`, accepts deterministic
  `--scenario=...` launch arguments, and labels concept-only surfaces directly
  in the UI. It must never be distributed as Luxora.

Their UI-test bundles are also separate: `LuxoraMobileUITests` and
`LuxoraDesignLabUITests`.

The production UI tests can opt into a `DEBUG`-only, server-shaped in-memory
state with `LUXORA_UI_TEST_SCENARIO=messenger`. This is used to deterministically
exercise the real navigation and `MessengerStore` send path; it imports no
`LuxoraDesignFixtures`, is absent from Release, and is never treated as live
backend evidence. Versioned Simulator captures and their checksums live under
[`screens_app_iphone/production`](../../screens_app_iphone/production/README.md).
The Settings tab now exposes the full settings inventory (folders, identity,
devices, notifications, privacy, data, appearance, language, help and about),
while only controls backed by the current client/server contract are enabled.

The default development endpoints are `http://127.0.0.1:8080` and
`ws://127.0.0.1:8080/v1/realtime`. Override them in the Xcode scheme when a
different local server is under test:

- `LUXORA_API_URL`
- `LUXORA_REALTIME_URL`

## Honest root states

The native root explicitly distinguishes session restoration, unauthenticated,
realtime connecting, connected, offline and connection error. Deterministic
fixtures live only in `LuxoraDesignFixtures` and are not linked into
`LuxoraMobile`; the real authentication screen has no fixture-entry affordance.
Offline/error banners never claim message durability or encryption and expose a
manual reconnect action. Sending is disabled until a real remote sender and an
online realtime state are present, so the local preview cannot manufacture
delivery receipts. A failed saved-session restoration can be retried without
discarding the refresh credential, or abandoned explicitly to sign in again.
Cancelled restoration keeps the saved credential, and late frames from a
cancelled prior session cannot mutate a replacement or preview store.

The thin composer shows only a send arrow. It remains neutral and disabled
until a non-empty text draft can be sent through an online server connection;
it does not advertise voice notes before the server media gate is implemented.
Server UUID path segments are emitted in canonical lowercase form.

## Connected Simulator evidence

The current structured iPhone gallery and its per-screen implementation status
are documented in [`screens_app_iphone`](../../screens_app_iphone/README.md).
Images below predate that manifest and are retained as connected-backend
evidence, not as the Design Lab concept gallery.

The checked root screenshots were captured from a locally signed Debug build on
the iPhone 17 Pro Simulator against a running Luxora API populated through real
register, message-request, acceptance and message HTTP contracts:

- [`iphone-auth.png`](../../iphone-auth.png) — server authentication with no fixture entry.
- [`iphone-chats-connected.png`](../../iphone-chats-connected.png) — server-loaded Direct list after realtime `ready`.
- [`iphone-conversation-connected.png`](../../iphone-conversation-connected.png) — server-loaded history with a visible connected state.

The current fixture-free phone onboarding evidence is in
[`production/v6-live-phone-onboarding-ru`](../../screens_app_iphone/production/v6-live-phone-onboarding-ru/README.md).
It covers a fresh server challenge, six-digit OTP verification,
`profile_required`, live username availability, account/session creation,
permission rationale, Chats synchronization and a separate restored-session
launch on iPhone 17 Pro Simulator.

The current selected chat/function and navigation/settings visual smokes are in
[`production/v7-live-chat-functions-ru`](../../screens_app_iphone/production/v7-live-chat-functions-ru/README.md)
and
[`production/v7-telegram-navigation-settings-ru`](../../screens_app_iphone/production/v7-telegram-navigation-settings-ru/README.md).
They are production-surface Debug captures backed by separate tests; their
README files distinguish deterministic UI fixtures from fixture-free live API
evidence. They do not close the complete 62-screen pixel gate.

Reproducible navigation uses an explicit, opt-in `DEBUG`-only launch harness:
`LUXORA_DEBUG_AUTOMATION`, `LUXORA_DEBUG_USERNAME`,
`LUXORA_DEBUG_PASSWORD` and optional `LUXORA_DEBUG_OPEN_CHAT_ID`. Credentials
are passed only in the Simulator launch-process environment and are never stored
in the repository. The automation type and environment keys are excluded from
Release compilation.

## Verification

```bash
swift test --package-path apps/apple

cd apps/apple
xcodebuild \
  -project Luxora.xcodeproj \
  -scheme LuxoraMobile \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/luxora-iphone-derived-data \
  CODE_SIGNING_ALLOWED=NO \
  build
```

For an installable Simulator build with Keychain support, omit
`CODE_SIGNING_ALLOWED=NO`; Xcode then uses its local Simulator signing identity
and injects the simulated application identifier entitlement.

The opt-in live server probe remains:

```bash
LUXORA_LIVE_TEST=1 \
LUXORA_API_URL=http://127.0.0.1:8080 \
LUXORA_REALTIME_URL=ws://127.0.0.1:8080/v1/realtime \
swift test --package-path apps/apple \
  --filter 'LiveBackendIntegrationTests|CommunityLiveBackendIntegrationTests'
```

The full opt-in live phone UI path additionally requires a disposable number
and the development/provider verification code. The test is skipped unless the
explicit gate is present:

```bash
LUXORA_LIVE_PHONE_UI_TEST=1 \
LUXORA_LIVE_PHONE_CODE='<provider-code>' \
LUXORA_API_URL=http://127.0.0.1:8080 \
LUXORA_REALTIME_URL=ws://127.0.0.1:8080/v1/realtime \
xcodebuild \
  -project apps/apple/Luxora.xcodeproj \
  -scheme LuxoraMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  test \
  -only-testing:LuxoraMobileUITests/LuxoraMobileUITests/testOptInLivePhoneRegistrationSynchronizesIntoChats
```

The current server and iPhone client do expose the optional post-OTP
`password_required` continuation, authenticated password enable/change/disable,
profile name/bio updates and resumable image upload into a processed 512x512
avatar. Fixture-free tests cover those successful paths. Independent password
recovery, phone re-binding, storage-pressure/expiry failure matrices and
real-device release evidence remain open; the client must continue to label
those gaps rather than imply completion.
