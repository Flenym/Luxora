# Luxora iPhone — Imagegen concept manifest

**Release:** Beta-0.1  
**Owner/developer:** Flenym  
**Purpose:** raster product-design exploration generated with the built-in `imagegen` tool. These images are not Simulator evidence and do not claim that the pictured functions are implemented.

## Visual direction

- The ten files in `../telegram_sreenshots/` are reference images for compact information density, predictable iPhone navigation, chat hierarchy, search, contacts and profile/settings ergonomics.
- They are not edit targets. Luxora must not reproduce Telegram branding, icons, copy, user data, exact layouts or ornamental details.
- `../../../logo.png` is the canonical brand reference: black/deep-ink base, electric blue → violet → iris ribbon, sparse glow and high-contrast white type.
- Luxora uses its own five-destination model: **Inbox, Spaces, Calls, Search, You**. Liquid Glass is limited to navigation, floating controls, menus and call controls; reading/content surfaces stay calm and opaque.
- All accepted boards use synthetic people, accounts, conversations, files and messages. Any failed generation that accidentally reused reference data is quarantined under `rejected/` and is not an approved design source.

### Product terminology

Luxora names are not euphemisms for missing product types:

- **Direct** = личный чат.
- **Circle** = private group; the supergroup-scale form lives inside the same governed group model.
- **Space** = community/supergroup container containing channels, topics and live rooms.
- **Channel** = one-way or permissioned broadcast surface, optionally with a comments thread.
- **Status** = ephemeral user update; it is optional UI above Inbox, not a replacement for Inbox.

## Reference audit

Every source image was inspected before generation:

| Reference | Pattern extracted (not copied) |
| --- | --- |
| `chats.jpeg` | Dense conversation rows, immediate search, folders, stable bottom navigation |
| `chats_with_stories.jpeg` | Optional horizontal ephemeral-status rail without hiding the inbox |
| `contacts.jpeg` | Search-first contact list, presence subordinate to identity |
| `edit_chats.jpeg` | Explicit multi-select/edit mode and anchored bulk actions |
| `in_chat.jpeg` | Compact conversation header, pinned context, mixed message types, persistent composer |
| `profile_friend-contact.jpeg` | Large identity header, quick actions, segmented shared-content browser |
| `search_in_chats.jpeg` | Recent people plus scoped results and keyboard-aware search surface |
| `settings.jpeg` | Identity-led settings entry and grouped rows |
| `settings_down1.jpeg` | Devices, notifications, privacy, storage and appearance grouping |
| `settings_down2.jpeg` | Secondary/account/support settings below primary controls |
| `../../../logo.png` | Luxora silhouette, restrained blue-violet-iris accent and deep black brand atmosphere |

## Complete product-screen inventory

The boards below cover the complete target iPhone information architecture and its important states. A board may contain several full-height iPhone frames so relationships can be reviewed together.

| Asset | Screens / states | References | Status |
| --- | --- | --- | --- |
| `00-luxora-messenger-overview.png` | Brand welcome; Inbox; Direct; Circle conversation; Contacts; active audio call; You/settings; attachment sheet | logo + chat/contact/settings references | generated; inspected; keep as broad visual thesis |
| `01-auth-onboarding-registration-v2.png` | Welcome; create-account profile; username; passkey creation; sign-in; another-device code; recovery exploration; new-device review | logo + `00` continuity | generated/inspected; **draft** — QR, recovery custody and generic device-copy correction required |
| `02-chat-list.png` | Inbox/list direction | logo + chats/stories | generated/inspected; **exploration** — replace self-chat icon/star, deduplicate compose, fix row overlap, add 5-destination IA and status state |
| `03-direct-chat.png` | Direct conversation direction | logo + in-chat | generated/inspected; **exploration** — replace logo-as-video, use original delivery edge/glyph treatment |
| `04-group-rich-media.png` | Circle rich-media direction and attachment sheet | logo + in-chat/profile | generated/inspected; **exploration** — normalize device size, unclip sheet, replace logo-as-video |
| `05-search-contacts-and-new-message.png` | Global and in-conversation search; Contacts; New conversation; request preview/accept/block/report | logo + search/contacts/chats | generated/inspected; **strong draft** — fix Contacts destination selection, file-search scope, locale annotation and privacy-dependent mutual-Space wording |
| `06-creation-circles-spaces-channels-v2.png` | New sheet; Circle; Private/Moderated Space choice; template preview; member/permission review; overview | logo + chats/contacts | generated/inspected; **improved draft** — standalone Channel create/review and external target annotations still required; v1 quarantined for false E2EE claim |
| `07-calls-history-incoming-active-group-v2.png` | Calls history; incoming audio; connecting; active audio/video; group grid; noise/quality/reconnect; iOS Screen Broadcast | logo + profile/in-chat ergonomics | **accepted concept** — v1 quarantined for copied reference identity; calling arc is a neutral connection spinner, never the brand loader |
| `08-profiles-info-media-members.png` | Own profile; contact profile; Circle info; channel/Space info; members/roles; media/files/links/voice; block/report | logo + profile/settings | planned |
| `09-settings-security-devices-passkeys.png` | You hub; Privacy & Security; Devices; device detail/revoke; Passkeys; add/rename/remove authenticator; QR link confirmation; security review | logo + settings | planned |
| `10-settings-notifications-appearance-storage.png` | Notifications; per-chat mute; Appearance light/dark/system; accessibility/reduced motion; Data & Storage; auto-download/cache; language | logo + settings-down | planned |
| `11-message-actions-reactions-forward-share.png` | Anchored message menu; reaction palette/details; reply/edit state; delete scope; multi-select; forward destination/privacy warning; system share | logo + in-chat/edit | planned |
| `12-brand-loader-dark-light-storyboard-v4.png` | Dark/light 8-checkpoint storyboards; two heads on one hidden route, 50% phase, same direction, short trails, no complete runtime outline | strict logo geometry reference | **accepted raster storyboard** after manual particle count; v1–v3 quarantined |
| `13-empty-loading-offline-error-states.png` | First-use empty; filtered empty; skeleton/incremental loading; cached offline queue; reconnect/reconcile; retryable error; permission denied; removed membership; update required | logo + chats/in-chat | planned |
| `14-spaces-community-navigation.png` | Spaces home; Space guide/onboarding; channel tree; text channel; forum topics; announcement/comments; voice room preview; notification overrides | logo + chats/in-chat | planned |

## Generation rules

- One built-in imagegen invocation per raster asset; no CLI/API fallback.
- Each prompt names input roles explicitly and requests a realistic, shippable product UI rather than concept art.
- English synthetic UI copy is used for legibility; implementation strings remain fully localizable.
- iPhone hardware frame/status chrome is presentation context only. Final SwiftUI must use system safe areas and controls.
- Obvious image defects are either regenerated with one targeted correction or recorded here; text in a bitmap is never treated as a source-of-truth specification.
- Still boards cannot validate motion, interruption, Reduce Motion, animation energy use or runtime accessibility. Those require the logo-derived vector route, SwiftUI implementation, Simulator/real-device capture and UI/accessibility tests.

## Prompt and reference ledger

| Board/version | Built-in prompt intent | Reference roles | Outcome |
| --- | --- | --- | --- |
| `01...v2` | Eight auth frames: welcome → profile → username → passkey → sign-in → device-link → recovery → device review; 4×2 complete-device board | `logo.png`: strict brand; `00`: family continuity only | Generated. Strong hierarchy; security/product-copy corrections pending. |
| `05` draft 1 | Search/contacts/new-message six-screen board | logo: brand; `search_in_chats.jpeg`, `contacts.jpeg`, `chats.jpeg`: density/ergonomics only | Rejected composition: bottom devices clipped and an extra frame appeared; not persisted. |
| `05` draft 2 | Same six states with non-negotiable exact 3×2 complete-phone composition | logo: brand; search/contacts: density only | Persisted; all six devices visible. QA issues recorded in inventory. |
| `06` v1 | New action, Circle, Space privacy choice, templates, role review, created overview | logo: brand; chats/contacts: row rhythm only | Quarantined: generated false E2EE and retention claims. |
| `06` v2 | Precise copy edits removing E2EE and indefinite-retention claims; `Choose Space type`; `Default policy` | v1: edit target only | Persisted as improved draft, not final. |
| `07` v1 | Eight call states including quality, reconnect, group and screen share | logo: brand; profile/in-chat: identity/header ergonomics only | Quarantined: model reused reference identity/data and desktop share chooser. |
| `07` v2 | Replace all people/data with fictional cast; then replace desktop chooser with iOS Screen Broadcast active state | v1: layout edit target; logo: brand only | Accepted concept after visual QA; all prominent copy is English and synthetic. |
| `12` v1–v3 | Dark/light two-particle loader storyboards | logo: strict route topology | Rejected: generic oval/wrong topology, then a three-particle frame. Quarantined. |
| `12` v4 | Eight identical dark/light checkpoints visiting tall blade, crossing, right blade and lower fold; exactly two heads at 50% phase | logo: strict geometry | Accepted raster storyboard. Dotted legend is documentation-only and must never render at runtime. |

## Inspection log

- `00`: coherent Luxora palette and hierarchy; useful broad direction. It compresses several unrelated flows and therefore cannot substitute for the dedicated boards below. Some tiny labels are illustrative only.
- `01 v2`: good passkey-first spine and full-device composition. Before acceptance, add an explicit nonfunctional QR placeholder plus rotating confirmation code; remove invented iCloud/24-word recovery choices and fixed device telemetry; keep recovery bound to supported passkey/trusted-device/support paths.
- `05`: full 3×2 composition and useful five-destination Search hierarchy. Correct the selected destination on Contacts, do not imply crawling arbitrary local files, and make locale/theme variants explicit.
- `06 v2`: E2EE/retention false claims from v1 were removed. Keep as draft until a standalone Channel flow, distinct Circle/Space identities and policy-approved privacy wording are shown.
- `07 v2`: accepted visual concept. All identities are fictional; screen sharing uses an iPhone Screen Broadcast state. The connecting arc is merely a neutral activity signal and cannot replace the canonical two-point loader.
- `12 v4`: accepted after inspection of all sixteen runtime frames; each contains exactly two particle heads/trails. The complete dotted route appears only in its documentation legend. Production must derive the exact contour from `assets/brand/luxora-loader-route.svg` and keep that guide invisible.
- `08` initial generation attempt failed in the built-in image tool before producing an artifact; no CLI/API fallback was used. Retry remains in progress.
