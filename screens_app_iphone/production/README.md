# LuxoraMobile production evidence

Only PNGs captured from the `LuxoraMobile` scheme belong here; concept boards
and `LuxoraDesignLab` captures do not. In this directory, `production` identifies
the application target and production SwiftUI surfaces. It does **not** by itself
mean that a PNG contains live-backend data. Each versioned README must identify
one of two evidence types:

- deterministic Debug fixture/scenario with synthetic data, compiled out of
  Release; or
- a fixture-free live-backend run with its own health and integration evidence.

Never describe deterministic fixture screenshots as a live connection. The
binding visual source is the immutable set of 62 user references documented in
[`FULL_REFERENCE_INVENTORY_RU.md`](../telegram_reference_concepts/FULL_REFERENCE_INVENTORY_RU.md),
with the supplied raw captures retained separately in
[`telegram_sreenshots`](../telegram_sreenshots/). Visible product UI is Russian;
brand names and synthetic usernames may remain unchanged.

Validated deterministic production-UI sets:

- [`v2-five-tab-shell`](v2-five-tab-shell/README.md) — canonical five-tab shell,
  dense Inbox/Direct flow and capability gates.
- [`v3-you-settings`](v3-you-settings/README.md) — complete You/settings
  inventory with honest per-capability states.
- [`v4-telegram-reference-ru`](v4-telegram-reference-ru/README.md) — Russian
  Telegram-reference shell and navigation checkpoint.
- [`v5-phone-auth-ru`](v5-phone-auth-ru) — production welcome plus explicitly
  DEBUG-only phone-auth presentation checkpoints.
- [`v7-live-chat-functions-ru`](v7-live-chat-functions-ru/README.md) — Russian
  chat-list, conversation and new-message visual smoke from the deterministic
  Debug messenger fixture. The folder name describes the connected chat/functions
  iteration; its PNGs are not live user-data evidence. Live backend behavior is
  documented separately inside that README.
- [`v7-telegram-navigation-settings-ru`](v7-telegram-navigation-settings-ru/README.md)
  — Russian Settings, own profile, chat folders, safe profile QR and Privacy
  visual/interaction evidence from the deterministic Debug messenger fixture.
- [`v13-chat-folders-ru`](v13-chat-folders-ru/README.md) — synchronized All,
  Archive and custom-folder states, folder settings/editor, and Spaces/create
  surfaces. Archive evidence uses a real swipe through the production
  confirmation path; the retained screenshots remain deterministic Debug
  fixture evidence, not live-backend proof.
- [`v14-global-search-ru`](v14-global-search-ru/README.md) — server-shaped
  people/message result surfaces and a navigation journey that opens both
  result types. The two retained PNGs are deterministic Debug fixture evidence;
  fixture-free Swift→Docker search behavior is proved separately in the test
  record, not by the screenshots.
- [`v15-synchronized-drafts-ru`](v15-synchronized-drafts-ru/README.md) —
  loading/autosave, rate-limit retry, cross-chat restoration and send/clear
  states from the production store/UI path. The post-patch journey passes 1/1
  in 75.079 s with no retained invalid-frame warning and three reviewed,
  checksum-verified 1206×2622 PNGs. Its transport is an opt-in DEBUG-only
  server-shaped fixture; a separate postpromotion Swift→Docker HTTP+V2 test
  proves the live draft boundary 1/1, not these screenshots.

Validated live-backend set:

- [`v6-live-phone-onboarding-ru`](v6-live-phone-onboarding-ru/README.md) — a
  visually reviewed, fixture-free new-account journey through live phone
  challenge, OTP, profile, username, registration, sync and restored session.

## Pixel-closure status

The Telegram references are binding for structure, geometry, density,
hierarchy, controls and shown states after replacing Telegram branding and
personal data with Luxora-safe equivalents. The v7 folders are bounded visual
smoke checkpoints only. They cover 8 selected states and use an iPhone 17 Pro
Max capture size of 1320×2868, while the binding set contains 62 individual
reference states, principally at 1179×2556.

Therefore **62/62 pixel closure remains open**. Neither the v7 archive names,
successful UI tests nor clean screenshots constitute a 1:1 pixel-match claim.
Per-screen gaps and working-versus-gated behavior are recorded in each v7
README.

`01-real-auth-server-unavailable.png` was captured from a locally signed Debug
build after clearing the Simulator Keychain session and allowing the real
capability request to fail against an intentionally unavailable endpoint. The
corresponding scheme, state, checksum, and validation record live in
[`../manifest.json`](../manifest.json).
