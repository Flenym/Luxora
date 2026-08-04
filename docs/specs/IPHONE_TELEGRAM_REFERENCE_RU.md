# iPhone Telegram-reference baseline — Russian Luxora UI

**Product:** Luxora Beta-0.1  
**Owner/developer:** Flenym  
**Reference viewport:** 393 × 852 pt, 3× scale (1179 × 2556 px)  
**Primary reference inputs:** 62 images in
`screens_app_iphone/telegram_reference_concepts/` (`01_…` through `36_…`)  
**Secondary historical inputs:** `screens_app_iphone/telegram_sreenshots/*.jpeg`

This document is the binding visual baseline for the current iPhone pass. The
owner requested a maximally faithful reconstruction of the supplied Telegram
iPhone UI before Luxora-specific additions. The numbered 62-image set is the
primary source for geometry, buttons, panels, spacing and interaction states;
the older JPEG set is secondary when the numbered set has no equivalent state.
Never edit the supplied references. Match layout, information density,
navigation, control placement and interaction states. Ship only Luxora naming,
logo, fictional identities and original brand assets; do not ship Telegram's
name, paper-plane mark, proprietary artwork, verified/Premium treatment or any
personal data visible in the source captures.

## Russian-first rule

- Russian is the default language for every production screen, sheet, menu,
  button, tab, empty/loading/offline/error state, accessibility label and UI
  test scenario.
- Strings live in the Apple localization system; they are not scattered
  literals used only to make screenshots pass.
- Geometry is validated with Russian strings. Truncation is a defect unless the
  corresponding reference intentionally truncates user content.
- User-created content may use any language. Test data must be fictional and
  must not reproduce names, phone numbers, usernames, avatars or messages from
  the reference screenshots.

## Primary navigation

Reproduce the current shell visible in `chats.jpeg`:

1. One floating glass bar containing four destinations in this order:
   **Контакты / Звонки / Чаты / Настройки**.
2. One separate circular glass **Поиск** control to the right of the bar.
3. The selected destination uses the same bounded circular/rounded treatment,
   icon-to-label rhythm and vertical alignment as the reference.
4. Luxora Circles, Spaces and Channels are represented inside **Чаты**, folders
   and creation flows; they are not an extra bottom destination.
5. Pushed conversations, profiles and Settings detail screens hide the primary
   bar and reclaim the bottom safe area. Root destinations retain it.

The story/status rail and chat-folder rail are independent horizontal scrollers.
Swiping left reveals later items and swiping right returns; the selected folder
remains visible and visually selected. Both rails show a clipped/peeking next
item when content overflows, preserve their position across push/back, expose
VoiceOver scroll actions and do not steal ordinary vertical list scrolling.

The presentation may adapt only where an iOS accessibility setting requires
it. Internal view-model names do not need to match these user-facing labels.

## Geometry gate

- Capture and compare on an iPhone 14 Pro or iPhone 15 Pro Simulator at
  393 × 852 pt. A 402 × 874 pt iPhone 17 Pro capture is not pixel-comparable.
- Use an idle, plain Dynamic Island. Album art, waveform/equalizer and other
  Now Playing content in the supplied real-phone captures are device state, not
  Telegram/Luxora interface geometry, and must not be reproduced.
- Preserve the native top and bottom safe areas; never compensate with a
  screenshot-specific bitmap offset.
- Align the candidate and reference at original 1179 × 2556 px resolution.
- Review a 50% opacity overlay and a difference image for every implemented
  reference screen.
- Maximum unexplained variance: 1 pt for container bounds, dividers, navigation
  and icon centers; 2 pt for text baselines and glyph optical alignment.
- Dynamic user text and Luxora-vs-reference brand marks are masked from raw
  difference scoring but still reviewed for clipping and visual weight.
- Record device model, iOS runtime, locale, appearance, text size and Reduce
  Motion/Transparency state in each screenshot manifest.

Run the repository visual-diff helper only after both files have the same
1179 × 2556 dimensions:

```sh
python3 script/iphone_visual_diff.py \
  --reference screens_app_iphone/telegram_sreenshots/chats.jpeg \
  --candidate screens_app_iphone/production/<pass>/01-chats.png \
  --output-dir screens_app_iphone/production/<pass>/visual-diff/01-chats
```

The helper never resizes input. It writes a 50% overlay, difference heatmap,
edge images and a checksum-indexed JSON report. An optional same-size mask may
exclude personal/reference-only copy and brand areas from the edge metric.
Its reproducible Python dependency is pinned in
`script/visual-requirements.txt`; the exact Python and Pillow versions are
recorded in every report.

## Source-to-screen coverage

The auditable status of all 62 numbered reference images is maintained in
[`IPHONE_REFERENCE_COVERAGE_MATRIX_RU.md`](IPHONE_REFERENCE_COVERAGE_MATRIX_RU.md).
An image being reviewed does not mean its feature is implemented. Runtime proof
must come from `LuxoraMobile`, and unsupported controls remain visibly gated.

| Source | Required Russian Luxora screen/state |
| --- | --- |
| `chats.jpeg` | Чаты list, header actions, search, folders, pinned/normal rows, unread/mute/pin states, primary navigation |
| `chats_with_stories.jpeg` | Чаты with optional status/story rail and unchanged list/navigation rhythm |
| `contacts.jpeg` | Контакты, sort/add/search/invite, presence/last-seen hierarchy and alphabet index |
| `edit_chats.jpeg` | Chat selection/reorder mode and anchored read/archive/delete actions |
| `in_chat.jpeg` | Direct conversation header, pinned context, reply, media/message variants and composer |
| `profile_friend-contact.jpeg` | Contact profile, quick actions, details, shared-media tabs and grid |
| `search_in_chats.jpeg` | Global search, recent people, scopes, results and keyboard-aware layout |
| `settings.jpeg` | Настройки identity header, profile/edit actions, accounts and first settings group |
| `settings_down1.jpeg` | Devices/folders plus notification/privacy/data/appearance/language groups |
| `settings_down2.jpeg` | Remaining account/support/legal/About coverage; unsupported commerce is omitted or visibly unavailable |

## Interaction and product-truth gate

- A control that looks enabled must perform a real action against the current
  Luxora server or local iOS setting.
- Unsupported calls, media, passkeys, push, E2EE and community mutations are
  visibly disabled/locked or open a truthful capability explanation. They must
  not create fixture success in `LuxoraMobile`.
- `LuxoraDesignLab` may render target states, but every frame is labelled and
  stored separately from production Simulator evidence.
- Every visible button has a pressed/disabled/loading/error result, VoiceOver
  label and UI-test assertion.
- Nested screens hide the bottom shell; no content may be obscured by it or by
  the home indicator.

## Acceptance evidence

For each completed source mapping, retain:

- the original reference filename and checksum;
- the production Russian Simulator PNG and checksum;
- a manifest entry with route/state and server capability assumptions;
- overlay/difference review status and recorded deviations;
- build, unit-test and UI-test commands/results;
- a short manual QA note covering clipping, safe areas, enabled-state truth and
  navigation back to the exact originating context.

Generated imagegen boards are design references only. Only screenshots from the
fixture-free `LuxoraMobile` target can demonstrate production implementation.
