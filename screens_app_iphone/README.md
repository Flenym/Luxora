# Luxora iPhone screen evidence

This directory separates visual evidence by purpose:

- `concepts/` is the Design Lab gallery. Every image comes from the iOS Simulator, but a concept image is not proof that its feature works.
- `telegram_reference_concepts/` contains the immutable 62-screen user binding set. Its required geometry, density, hierarchy and state coverage are catalogued in [`FULL_REFERENCE_INVENTORY_RU.md`](telegram_reference_concepts/FULL_REFERENCE_INVENTORY_RU.md).
- `telegram_sreenshots/` retains the supplied raw Telegram captures used as additional comparison material.
- `production/` contains captures from the real `LuxoraMobile` target. A versioned set may use either a deterministic Debug fixture with synthetic data or a fixture-free live backend; its own README is authoritative for that distinction.

The catalog source for earlier scheme/scenario state is [`manifest.json`](manifest.json). Latest evidence and backend truth are documented in each versioned production README:

- [`v7-live-chat-functions-ru`](production/v7-live-chat-functions-ru/README.md) — three Russian chat/function smoke states; PNGs use the deterministic Debug messenger fixture, with separate live-backend integration evidence.
- [`v7-telegram-navigation-settings-ru`](production/v7-telegram-navigation-settings-ru/README.md) — five Russian navigation/settings states with exact working/gated notes and per-reference gaps.

Status terms:

- `implemented`: shared production SwiftUI backed by the real API/state architecture; the Design Lab supplies deterministic display data only.
- `production-ui fixture evidence`: the real `LuxoraMobile` target and production views rendered with synthetic deterministic Debug data; never a live-data claim.
- `live-backend evidence`: fixture-free application/API execution supported by an explicit health check or integration result.
- `concept-not-implemented`: Design Lab-only product direction with deliberately inactive controls.
- `validated`: built, launched, captured, and visually inspected on the named Simulator.
- `planned`: not yet captured or inspected.

All visible product copy must be Russian except Luxora branding and synthetic usernames. Telegram references are binding inputs, not production assets and not permission to ship Telegram trademarks or personal data.

The current v7 sets are selected visual smoke, not full reference closure. **62/62 pixel closure remains open**: all 62 binding states still require per-screen implementation, capture at the binding geometry, original-resolution comparison and interaction evidence. A fixture screenshot proves reproducible UI geometry only; it does not prove live backend behavior.

Repository state is recorded as `uncommitted-no-head` because this workspace has no Git commit yet.
