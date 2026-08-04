# Telegram iPhone UX baseline — reference-only imagegen pass

> **Исторический manifest, superseded 2026-08-04.** Он описывает прежний 10-screen pass и больше не является текущим inventory. Актуальные 62 пользовательских binding-референса, полный визуальный аудит и gap-анализ находятся в [`FULL_REFERENCE_INVENTORY_RU.md`](FULL_REFERENCE_INVENTORY_RU.md). Перечисленные ниже generated outputs не находятся в корне и не должны восстанавливаться поверх пользовательских исходников.

**Reviewed:** 2026-08-04  
**Scope:** reference study only; never Simulator evidence and never a claim that Luxora implements the pictured feature.  
**Production rule:** preserve useful geometry, density, hierarchy and state coverage; never ship Telegram's name, paper-plane mark, proprietary artwork, verified/Premium treatment, exact icon system, personal screenshot data or copied wording in Luxora.

## Why this layer exists

The owner requested two explicitly separated visual layers:

1. `telegram_reference_concepts/` — a maximally faithful UX-baseline reconstruction of the supplied Telegram iPhone screens and official settings/feature inventory. Geometry and information density stay close; identities and brand/trademark assets are removed.
2. `../imagegen_concepts/` — Luxora's original product layer. Older five-tab explorations in that folder are drafts only. The owner-approved root shell is now exactly **Контакты / Звонки / Чаты / Настройки** in one floating glass panel plus a separate circular **Поиск** control. Spaces, circles and channels are reached from **Чаты/folders**, not from a fifth root tab.

Reference images are inputs, not production assets. Every generated output is a bitmap design study made with the built-in imagegen tool, one call per asset.

## Local screenshot audit and generated mapping

All ten source JPEG files were visually inspected at original detail before generation.

| # | Local source | UX baseline to preserve | Reference-pass output | Luxora mapping |
| --- | --- | --- | --- | --- |
| 01 | `../telegram_sreenshots/chats.jpeg` | centered title/action chrome; 44-pt search; horizontal folders; 72–78-pt rows; avatar/title/preview/time/pin; persistent tab bar | `01-chats-baseline-ru-v3.png` | Root **Чаты**, synthetic avatar stack, folders, owner-approved 4+search shell |
| 02 | `../telegram_sreenshots/chats_with_stories.jpeg` | optional status/story rail expands above search without replacing list | `02-chats-status-rail-ru-v2.png` | Root **Чаты** with optional status rail; both rails visibly continue offscreen |
| 03 | `../telegram_sreenshots/contacts.jpeg` | Sort/add; search; invite; presence/last seen; alphabet index | `03-contacts-baseline-ru-v4.png` | Root **Контакты**, synthetic Russian identities and Cyrillic index |
| 04 | `../telegram_sreenshots/edit_chats.jpeg` | Done; select circles; reorder; folder removal; bottom Read/Archive/Delete actions | `04-chat-list-edit-baseline-ru-v3.png` | **Чаты** multi-select/manage mode; no root shell while editing |
| 05 | `../telegram_sreenshots/in_chat.jpeg` | compact identity header; pin strip; mixed bubbles; circular video; reply; day chip; 48–52-pt composer | `05-direct-chat-baseline-ru-v2.png` | Direct/Circle conversation; Luxora delivery semantics and synthetic media |
| 06 | `../telegram_sreenshots/profile_friend-contact.jpeg` | large identity; five quick actions; grouped details; segment strip; three-column media grid | `06-contact-profile-baseline-ru-v1.png` | Profile/contact/Circle/Channel info and shared-content browser |
| 07 | `../telegram_sreenshots/search_in_chats.jpeg` | recent people; Recent/Clear; scoped result tabs; keyboard-aware bottom search | `07-global-search-baseline-ru.png` (planned) | Separate root **Поиск**, Russian scopes and exact-context return |
| 08 | `../telegram_sreenshots/settings.jpeg` | identity hero; QR/Edit; profile actions; account switcher; primary settings entry | `08-settings-top-baseline-ru.png` (planned) | Root **Настройки**, target-only features labelled unavailable |
| 09 | `../telegram_sreenshots/settings_down1.jpeg` | sticky collapsed identity header; saved/calls/devices/folders; notification/privacy/data/appearance/language groups | `09-settings-middle-baseline-ru.png` (planned) | Luxora settings groups, no Telegram colored-tile clone |
| 10 | `../telegram_sreenshots/settings_down2.jpeg` | lower monetization/support groups and persistent navigation | `10-settings-lower-baseline-ru.png` (planned) | Support/legal/about; Telegram-only commerce rows are benchmarked, not copied |

## Official Telegram sources reviewed

Primary sources were opened on 2026-08-04:

- [Telegram FAQ](https://telegram.org/faq) — messages/media/files, usernames, contacts, checks, presence, calls, groups/channels, topics, search, pins, moderation, notifications and account lifecycle.
- [Privacy settings API](https://core.telegram.org/api/privacy) — selective privacy rules and exception model.
- [Dialog folders](https://core.telegram.org/api/folders) — folder/filter semantics and shared folders.
- [Push notifications](https://core.telegram.org/api/push-updates) — push categories, privacy-safe payload behavior and reconciliation implications.
- [Notification sounds](https://core.telegram.org/api/ringtones) — uploaded/default ringtone model.
- [Message reactions](https://core.telegram.org/api/reactions) — reaction availability, recent/top choices and message reaction state.
- [Client configuration](https://core.telegram.org/api/config) — server-advertised client limits/feature parameters.
- [Passkeys announcement](https://telegram.org/blog/passkeys-and-gift-offers?setln=en) — passkey settings/navigation benchmark only; Luxora follows its own WebAuthn/security contracts.
- [Official Telegram-iOS source](https://github.com/TelegramMessenger/Telegram-iOS) — current iOS Settings/Search inventory. Its README explicitly tells third-party apps not to use the Telegram name or standard logo; Luxora complies.
- Source files inspected for inventory: `SettingsSearchableItems.swift`, `PrivacyAndSecurityController.swift`, `NotificationsAndSoundsController.swift`, `DataAndStorageSettingsController.swift`, theme/language/settings modules in the official repository.

## Comprehensive Settings baseline

The following is a coverage matrix, not a promise to clone every Telegram commercial feature. Dedicated reference boards use this matrix after the ten screenshot reconstructions.

| Area | Telegram baseline inventory | Luxora product mapping |
| --- | --- | --- |
| Identity/account | profile/edit, name, bio, username, photo, profile color, birthday, QR, add/switch account, logout | **Настройки** → profile/account, username/status/links/visibility, QR device/profile flows; own original visual system |
| Devices/sessions | active sessions, session detail, link desktop/device, terminate one/all, auto-terminate | Devices, QR confirmation, rotating code, approximate region, revoke/security review; target-only until backend gate |
| Chats/folders | Saved Messages, recent calls, chat folders, recommended/shared folders, folder tags | Luxora personal storage, **Звонки**, **Чаты** folders/archive/requests; circles/spaces/channels live under **Чаты**, not a root tab |
| Notifications | private/group/channel/story/reaction categories; show/preview/sound/exceptions; in-app sound/vibrate/preview; lock-screen names; badge counting; joined-contact; reset | Message/Circle/Channel/Status/reaction categories, private previews, per-conversation exceptions, quiet schedule, OS-permission explanation, deep-link/grouped summary |
| Privacy discovery | blocked; last seen/online/read time; photo/public photo; forwards; calls/P2P/system-call integration; invites; bio; birthday; gifts; phone; voice messages; incoming messages | question-led Privacy Checkup: find/message/call/status/profile; exceptions and visibility preview; omit commerce-specific settings unless Luxora defines product need |
| Authentication/local security | passcode, biometrics, autolock, 2-step verification, passkey, login email | Keychain/session lock, passkeys/authenticators/devices/recovery under Luxora protocol; no seed/private-key display and no false sync guarantee |
| Lifecycle/data privacy | auto-delete, active websites, delete account timer, archive/mute, contact sync/reset, suggestions, drafts, payment info, link previews, bot settings, open links | retention controls, connected apps/sessions, delete/export account, contacts/drafts/link-preview boundaries; policy-specific and honestly gated |
| Storage/network | storage usage, keep-media duration, max cache, clear cache, network usage, auto-download by network/type, save-to-photos exceptions, less data for calls, edited media, recording behavior, share-sheet suggestions, proxy | bounded local cache, resumable uploads/downloads, Cellular/Wi-Fi/Roaming caps, large-file confirm, call data mode, safe share suggestions; no unbounded retention default |
| Power | videos, GIFs, stickers, emoji, visual effects, preload, background activity | low-power/reduced-motion policy and per-media autoplay/download controls |
| Appearance | wallpapers, light/dark/auto night, themes/edit/create, text size/system, bubble corners, app icon, animations, next-media tap, keyboard send | Light/Dark/System, Luxora accent, Dynamic Type, bubble scale/corners, Reduce Motion/Transparency, wallpaper, platform-native keyboard behavior |
| Stickers/emoji/reactions | installed/trending/archive, suggestion rules, large emoji, dynamic order, custom emoji, quick reaction | sticker/GIF/custom emoji picker and reaction preferences using original Luxora components |
| Language/translation | language list, translate button/chat, do-not-translate, RTL | full localization, language packs, region formats, RTL preview and translation privacy disclosure |
| Help/legal | support question, FAQ, feature guide, terms/privacy, diagnostics | **Настройки** → Help Center, FAQ, support, docs, privacy/security, about Beta-0.1, exportable diagnostics without secrets |
| Telegram-only commerce | Premium, Stars, Business, Wallet/TON, gifts | benchmark only. Do not surface in Luxora until separately specified, implemented and legally reviewed |

## Reference generation status

| Output | Status | QA notes |
| --- | --- | --- |
| `01-chats-baseline-ru-v3.png` | accepted concept | Header geometry corrected: three-avatar stack + one shared three-action capsule; folder overflow, idle island and Russian 4+search shell passed. Hash in `ACCEPTED.md`. |
| `02-chats-status-rail-ru-v2.png` | accepted concept | Expanded rail/list displacement preserved; both horizontal rails expose partial next item; idle island passed. |
| `03-contacts-baseline-ru-v4.png` | accepted concept | About eleven rows, Russian presence strings and А–Я/# index; true-black idle island intentionally blends into background. |
| `04-chat-list-edit-baseline-ru-v3.png` | accepted concept | Selection/reorder/bulk hierarchy; approximately 6.7 large rows; both rails overflow; no root bar in edit mode. |
| `05-direct-chat-baseline-ru-v2.png` | accepted concept | Mixed-message/composer geometry and synthetic media preserved; accidental media island removed. |
| `06-contact-profile-baseline-ru-v1.png` | accepted concept | Nested profile without root shell; five actions, privacy-safe details, clipped scopes and synthetic three-column media grid passed. |
| `07-global-search-baseline-ru.png` | planned | Preserve recent/scopes/keyboard geometry; Russian text; separate **Поиск** destination. |
| `08-settings-top-baseline-ru.png` | planned | Preserve top settings density, debrand identity/assets and use **Настройки** root state. |
| `09-settings-middle-baseline-ru.png` | planned | Preserve middle settings groups and sticky header. |
| `10-settings-lower-baseline-ru.png` | planned | Preserve lower/support density; commerce remains a benchmark, not a Luxora row. |
| `11-settings-notifications-privacy-matrix-ru.png` | planned | Official-source categories and exception hierarchy. |
| `12-settings-storage-appearance-matrix-ru.png` | planned | Official-source data/power/appearance/language hierarchy. |
| `13-settings-account-devices-help-matrix-ru.png` | planned | Official-source identity/session/lifecycle/help hierarchy. |

## Acceptance boundary

- `telegram_reference_concepts` may be visually close to the supplied screenshots but is documentation-only.
- `imagegen_concepts` must never reuse its trademark treatment, personal data or exact visual identity.
- Current ImageGen boards are approximately 852–853×1844–1846 pixels and are concept-only. They cannot satisfy the binding 393×852-point / 1179×2556-pixel Simulator geometry gate.
- A still image only communicates horizontal-carousel overflow through a partial right-edge item; it cannot prove swipe behavior.
- No bitmap proves an implemented feature. Runtime proof belongs in separate Simulator/device screenshots and tests.
