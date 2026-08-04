# LuxoraMobile v2 five-tab shell

These PNGs are Simulator captures of the real `LuxoraMobile` target and its
production `LuxoraKit` SwiftUI views. They are not Imagegen concepts and they do
not come from `LuxoraDesignLab`.

For repeatable visual and UI-test review, the Debug build installs a
`DEBUG`-only, server-shaped in-memory state through
`LUXORA_UI_TEST_SCENARIO=messenger`. That state exercises the same
`ApplicationSession`, `MessengerStore`, navigation and composer code as a live
session, but it is **not** evidence of a live backend connection. The harness is
compiled out of Release and imports no `LuxoraDesignFixtures` product.

Validated captures (iPhone 17 Pro Simulator, iOS 26.5, 1206×2622):

- `01-inbox.png`
- `02-direct-conversation.png`
- `03-spaces-gated.png`
- `04-calls-gated.png`
- `05-search-loaded-only.png`
- `06-you.png`
- `07-new-message-gated.png`
- `08-capability-status.png`

All eight captures were inspected at original resolution. The first Direct
capture exposed a persistent tab bar, and the first Calls capture exposed an
under-designed empty state; both were fixed, rebuilt and recaptured before the
files above were marked validated. Exact checksums and capture metadata are in
`manifest.json`.

Verification commands used for this slice:

```bash
swift test
xcodebuild -project Luxora.xcodeproj -scheme LuxoraMobile \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/luxora-mobile-five-tab-dd \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Luxora.xcodeproj -scheme LuxoraDesignLab \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/luxora-designlab-five-tab-dd \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Luxora.xcodeproj -scheme LuxoraMobile \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=22D9F7E5-36B4-4A6E-9696-EEC13CF2C2DA' \
  -derivedDataPath /tmp/luxora-mobile-ui-five-tab-dd test
xcodebuild -project Luxora.xcodeproj -scheme LuxoraMobile \
  -configuration Release -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/luxora-mobile-release-five-tab-dd \
  CODE_SIGNING_ALLOWED=NO build
```

Results: 22 Swift/package tests passed (one opt-in live-backend probe skipped),
all 3 `LuxoraMobileUITests` passed, both iPhone schemes built, and the
`LuxoraMobile` Release build succeeded. The Release executable contains no
`LUXORA_UI_TEST_SCENARIO`, `DebugMobileScenario` or debug installer symbol.
