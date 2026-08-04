# LuxoraMobile v3 You and settings inventory

Simulator captures of the real `LuxoraMobile` target after expanding You into
the production settings hierarchy. These are not Imagegen or Design Lab
screens. They use the same `DEBUG`-only, server-shaped UI automation state
documented in `../v2-five-tab-shell/README.md`; they are visual/UI evidence, not
live-backend evidence.

Coverage:

- You root inventory
- Chat folders
- Identity & access
- Devices
- Notifications & sounds
- Privacy & security
- Data & storage
- Appearance
- Language
- Help & feedback
- About Luxora

All eleven captures were inspected at original resolution on the iPhone 17 Pro
Simulator (iOS 26.5, 1206×2622). Early captures caught an incomplete Simulator
Liquid Glass composition; those frames were discarded and every affected screen
was recaptured only after the system chrome had settled. The Help screen also
exposed misleading disclosure arrows on gated, non-interactive rows; they were
removed, rebuilt and recaptured before validation.

Working controls are limited to server-loaded Saved/text chats, session-local
folder filtering, theme/motion preferences and sign-out. Every other row reports
its actual capability state. Exact checksums and capture metadata are recorded
in `manifest.json`.

Verification for this slice:

- 22 Swift/package tests passed; the opt-in live-backend probe was skipped.
- All 4 `LuxoraMobileUITests` passed on the same iPhone 17 Pro Simulator.
- `LuxoraDesignLab` Debug and `LuxoraMobile` Release builds passed.
- The Release executable contains no UI-test scenario, debug scenario or debug
  installer strings.
