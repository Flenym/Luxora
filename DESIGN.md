# Luxora Design System

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Источник бренда:** корневой `logo.png`

## 1. Design thesis

Luxora should feel calm, luminous and exact: deep neutral content surfaces, a restrained violet/indigo ribbon for focus, and motion that explains continuity. “Premium” never permits low contrast, blocked interactions, misleading security symbols or expensive blur across scrolling content.

Three brand properties derived from the logo:

1. **Luminous focus** — the gradient appears on the current destination, primary action or meaningful progress.
2. **Ribbon continuity** — shared geometry/motion connects inbox, conversation and details.
3. **Deep calm** — reading surfaces remain quiet; glow is scarce and therefore meaningful.

## 2. Canonical palette

The Apple and Android foundations currently share the following core values; Web should converge on the same semantic tokens rather than duplicating ad-hoc hex values.

| Token | Dark value | Intent |
| --- | --- | --- |
| `ink` | `#090914` | Primary deep background |
| `deepViolet` | `#2F1893` | Gradient depth, never long body text |
| `violet` | `#7C48D4` | Brand ribbon |
| `electricBlue` | `#373ABF` | Gradient anchor |
| `iris` | `#A999ED` | Secondary accent/highlight |
| `frost` | `#C0C2F7` | Cool highlight on dark surfaces |
| `accent` | `#7657FF` | Primary interactive state |
| `success` | `#4CD7A4` | Confirmed positive state, with text/icon |
| `danger` | approx. `#FF5D72` | Destructive/error state, with label/icon |

Semantic tokens, not raw brand colors, are used in components: `background`, `surface`, `surfaceElevated`, `textPrimary`, `textSecondary`, `stroke`, `focus`, `success`, `warning`, `danger`. Light/high-contrast values are independently tuned; they are not simple inversions.

The brand gradient flows electric blue → deep violet → violet → iris. Use it for logo, a primary CTA accent, small progress/ring states and selected navigation. Never fill entire message history or every button with it.

## 3. Typography

- Apple: San Francisco system typography and Dynamic Type.
- Android: Material typography backed by system/user font scaling.
- Windows/Linux/Web: Manrope may be used for brand/marketing; product UI must retain robust system fallbacks.
- Body copy uses regular weight; hierarchy comes from size, spacing and restrained weight changes.
- Avoid all-caps except compact technical labels with adequate tracking.
- User content is never rendered in a decorative face.
- Dates, counters and file sizes use locale-aware APIs; no string concatenation.

Minimum baseline: readable body around platform-standard 15–17 pt equivalent, controls with touch target at least 44×44 Apple / 48×48 Android where practical, and no critical information clipped at the largest accessibility sizes.

## 4. Spacing, shape and depth

Use a 4-point base grid with common steps `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`. Optical alignment may differ by 1–2 points for icons but must be component-owned.

Shape families:

- compact controls: 10–14 radius;
- cards/composer: 16–22 radius;
- prominent sheets/panels: 24–32 radius;
- avatars/status dots: circular unless brand content requires another mask.

Elevation has a functional meaning: base content → persistent navigation → transient menu/sheet → blocking security/permission dialog. Do not add shadows to every message. Borders and tonal separation are preferred to large diffuse shadows.

## 5. Glass policy

Allowed:

- navigation/tab/sidebar chrome;
- floating composer controls;
- menus, toolbars and call controls;
- transient overlays that preserve readable content below.

Not allowed:

- message bubble bodies;
- long text/card reading surfaces;
- every list row;
- security status whose legibility changes with wallpaper/media;
- stacked glass layers that multiply blur and GPU cost.

Glass must have an opaque/tonal fallback for Reduce Transparency, unsupported browser/platform, low-power mode or measured GPU pressure. Text and icons must meet contrast against the worst background, not a static mock screenshot.

## 6. Information architecture

Stable destinations are Inbox, Spaces, Calls, Search and You. Beta-0.1 clients may expose only implemented/prototype subsets, but they must not present an inactive roadmap area as a working feature.

Adaptive structure:

- compact: one pane and navigation stack;
- medium: conversation list + conversation, details as sheet;
- expanded: resizable sidebar + conversation + optional inspector;
- deep link: restore destination, parent and target context;
- desktop: menus/commands and right-click mirror touch actions.

Public discovery never interrupts the personal Inbox.

## 7. Messaging components

### Conversation row

Avatar, title, semantic preview, time, mute/pin and unread. Current selection must be distinguishable without color alone. Long names/previews truncate gracefully and remain accessible.

### Message bubble

Quiet opaque content surface. Group consecutive messages by author without removing the screen-reader author context. Reply preview has a stable target; deleted/inaccessible target reads “Original message unavailable”.

### Delivery state

| State | Visible language | Rule |
| --- | --- | --- |
| Local queued | Sending / waiting for network | Preserve draft and allow cancel/edit |
| Server accepted | Sent | Only after durable acceptance contract |
| Delivered | Delivered | Do not infer from a timer |
| Read | Read | Respect privacy policy |
| Retryable failure | Not sent · Retry | Keep content |
| Permanent rejection | Couldn’t send · reason | Explain next action |

Current local prototypes simulate some states for interaction design; those simulations must be visibly identified as demo behavior. The connected client may only show states sourced from protocol truth.

### Composer

The primary send action stays stable; attachment/emoji/voice affordances use progressive disclosure. Enter/newline behavior follows platform conventions. Draft must survive navigation and failures in the connected client. Permission prompts occur only after selecting the related capability.

## 8. Trust and safety language

The current header label is:

`Cloud preview — Protected in transit. Not end-to-end encrypted. Don’t use for sensitive information.`

Future labels, only after gates:

- `Private` — verified E2EE state and member-device access.
- `Moderated` — content may be processed for search, safety and moderation.

A lock/shield never stands alone. Security color/icon is derived from actual negotiated/policy state, not a chat name or local toggle. “Secure”, “protected”, “anonymous” and performance numbers require scope and evidence.

## 9. Interaction states

Every feature designs loading, empty-first-use, empty-filter, no-results, offline cached/uncached, reconnecting, stale, permission-denied, membership-removed, retryable failure, permanent rejection, conflict, deleted target and update-required states.

Destructive actions name object, scope and reversibility. “Delete for me” and “Delete for everyone” are separate. Unknown sender requests do not emit read/presence/call signals before acceptance.

## 10. Accessibility baseline

- WCAG 2.2 AA for Web and corresponding platform semantics for native clients.
- Keyboard/switch path for every core action; no hover-only control.
- Logical focus order, focus restoration and visible 2 px-equivalent focus indicator.
- Status never encoded by color or motion alone.
- Dynamic Type/text scaling, high contrast, Reduce Motion and Reduce Transparency.
- RTL-aware layout without mirroring code, phone numbers or media incorrectly.
- Screen-reader announcements are concise: failures and material changes, not every receipt animation.
- Animations carry no unique information and are interruptible.

## 11. Asset rules

- `logo.png` is the canonical source asset; derived platform assets preserve silhouette, aspect and color order.
- `assets/brand/luxora-logo-transparent-final.png` is the non-destructive RGBA
  compositing master; `assets/brand/luxora-loader-route.svg` is reviewed motion
  geometry, not a visible replacement logo.
- The contour loader never renders the logo, a ghost fill or the complete route.
  Only its two moving points and short trails are visible.
- Never stretch, recolor into unrelated palettes, crop the ribbon or add typography inside the mark.
- Provide appropriate density/scale assets and an accessible product-name label; decorative marks are hidden from assistive tech.
- Screenshots/mock content use synthetic identities and contain no real personal data.

Motion details are in [ANIMATIONS.md](ANIMATIONS.md) and the canonical
[brand loading contract](docs/specs/BRAND_LOADING_MOTION.md); platform
implementation notes are in [CLIENTS.md](CLIENTS.md).
