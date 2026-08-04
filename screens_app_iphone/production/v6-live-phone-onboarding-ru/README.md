# Live phone onboarding — Russian iPhone production target

These frames come from `LuxoraMobile` (`app.luxora.mobile`) on the iPhone 17 Pro
Simulator. They are not Design Lab fixtures and were not captured with
`LUXORA_UI_TEST_AUTH_PREVIEW`.

On 4 August 2026, the opt-in test
`LuxoraMobileUITests/testOptInLivePhoneRegistrationSynchronizesIntoChats()`
completed against the ready local `Beta-0.1` API at `http://127.0.0.1:8080`.
The API created a fresh phone challenge, verified the provider/development OTP,
returned `profile_required`, checked the requested username, committed the new
account/session, and synchronized the production app into Chats. Xcode exited
successfully and retained the final recapture result bundle at
`/tmp/luxora-phone-live-recapture2.xcresult` for this workstation session. The
first six PNGs are stable full-LCD `simctl` captures taken while the verified
production states were foregrounded; transient XCTest attachment frames were
deliberately not used. `07` is a direct full-LCD capture from an ordinary app
relaunch of that same persisted account, after Xcode had exited.

The separate fixture-free restored-session test
`LuxoraMobileUITests/testOptInLiveRestoredSessionOpensSettingsWithoutFixtures()`
also passed. Its result bundle is
`/tmp/luxora-phone-restored-hard-edge-final-ui-20260804201834.xcresult`.

| Frame | Runtime evidence |
| --- | --- |
| [`01-phone.png`](01-phone.png) | Russian country/phone entry before the live request |
| [`02-otp.png`](02-otp.png) | Server-created OTP challenge with masked phone |
| [`03-profile.png`](03-profile.png) | `profile_required` branch: name, optional bio and avatar editor entry |
| [`04-username-available.png`](04-username-available.png) | Username accepted by the live availability endpoint |
| [`05-permissions.png`](05-permissions.png) | First-install permission rationale after account creation |
| [`06-chats.png`](06-chats.png) | Authenticated sync completed and the production Chats root appeared |
| [`07-restored-live-session.png`](07-restored-live-session.png) | A separate fixture-free launch restored the persisted live profile/session and opened Settings |

The test intentionally used a new disposable development account. Phone text is
masked in screenshots. The generated username is test data, not the owner's
reserved public handle.

## Visual reference QA — not yet accepted as 1:1

This folder proves the live production route and clean rendering; it does **not**
close the owner's Telegram-reference visual gate.

- `01`–`05` use the correct Russian phone-first hierarchy, but the runtime still
  uses generic circular SF-symbol illustrations on true black. The accepted auth
  studies use the Luxora mark, a restrained blue/violet atmospheric background,
  tighter vertical rhythm, and visible numeric-keyboard interaction states.
- `06` is the truthful fresh-account state, not the dense binding chat-list
  state. It has no avatar/title/preview/time/pin rows, the centered avatar stack
  is absent, and the folder rail does not expose a clipped next item.
- `07` has the correct four-tab-plus-search shell and grouped settings rows, but
  its identity header is much sparser than reference family `05`: no patterned
  identity hero, account switcher/profile-customization cluster, or collapsed
  username header. The Settings root tab uses a gear instead of the reference
  identity/avatar treatment, and unavailable rows add lock glyphs not present in
  the source geometry.
- The iPhone 17 Pro runtime is `1206×2622`, whereas the 62 binding source frames
  are `1179×2556`; direct pixel acceptance therefore needs a named device/scale
  normalization pass. Every normal frame here contains the real status time,
  connectivity and battery pixels. The idle Dynamic Island is matte black and
  intentionally blends into the true-black background; no artificial notch or
  media activity was added.

## SHA-256

```text
ac6a3628038573085f6ba10a1f04e4bcaf9cae0e1431e4b7525e68e4dc86b93c  01-phone.png
508eba959e6407a1f6fb644938360e8e579b02d1699d4136539b9dae83da1d2e  02-otp.png
16c1247087c73c995b53ba53c390863803b64780ad4c932efdfc75afdcb3a997  03-profile.png
7a62913adbd9ef338925a63e9405af56e175ac1ede55d87cc194dd149880a424  04-username-available.png
be946fb6c3d0bb637080aaf468dc2b6d44ed1843046abfd45ca1df27f3b91e21  05-permissions.png
5925e45352cb3dea5d2688ae40233332a08bdcd12ce44977a77228a2845ad8cc  06-chats.png
723dd3bc0ddc0e310338fa40e11a825b7c53ea1c4539cf0380c0bceb2e870da2  07-restored-live-session.png
```

This evidence closes the successful new-account path only. It does not claim a
production SMS vendor, optional secret-password/2FA, or remote avatar upload;
those require backend contracts that are still absent.
