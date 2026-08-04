# Luxora Motion and Animation

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym

## 1. Motion contract

Motion explains cause, continuity, hierarchy or live state. It never fabricates delivery/security/network progress, delays an action, captures focus unnecessarily or becomes the only signal. Luxora motion should be quiet enough to disappear during conversation and precise enough to orient during navigation.

Current Apple/Android/Web animations are interaction prototypes over local data. Their timing does not prove server acceptance, delivery, presence, calling or synchronization.

## 2. Duration tokens

| Token | Range | Use |
| --- | --- | --- |
| `instant` | 0–80 ms | pressed/highlight feedback |
| `quick` | 120–160 ms | icon/state swap, small opacity |
| `standard` | 180–240 ms | row selection, menu, compact transition |
| `spatial` | 280–360 ms | pane/sheet/navigation continuity |
| `emphasis` | 400–520 ms | rare onboarding/brand resolve only |

Durations are budgets, not mandatory waits. State mutates immediately; animation follows and may be interrupted. Repeated live events use the quick end or no animation to avoid thrash.

## 3. Easing

- Standard enter/move: smooth deceleration similar to `cubic-bezier(.2,.8,.2,1)`.
- Exit: slightly faster acceleration, about `cubic-bezier(.4,0,1,1)`.
- Small toggle: system spring with low overshoot or platform standard.
- No elastic bounce for errors, security, destructive actions or long lists.
- Avoid linear easing except truly continuous progress/waveform playback.

Use native platform curves when they preserve these semantics; cross-platform parity means comparable intent, not identical milliseconds.

## 4. Navigation

### List → conversation

- Compact: conversation enters from the navigation direction while list recedes subtly; Back reverses.
- Expanded: selection highlight and content crossfade/short translate; columns do not fly across the window.
- Deep link: render parent/list context, then focus target; avoid an orphan message zoom.
- Focus moves after content is mounted, not after decorative animation completes.

Reduced Motion: direct crossfade ≤ 150 ms, no depth/scale/blur interpolation.

### Inspector/sheets

Anchor to invoking control when platform supports it. Sheet may translate with scrim fade; background does not excessively scale. Closing restores focus and remains cancellable by system gesture/Escape.

## 5. Messaging motion

### Send

1. Local outbox acceptance inserts optimistic bubble immediately.
2. A subtle ≤ 160 ms settle may connect composer to stream.
3. Canonical ID/server acceptance updates state without moving the bubble.
4. Delivered/read icon changes only from an explicit protocol event, with quick opacity/shape transition.
5. Failure retains bubble and uses icon/text; no shake loop.

No confetti, long flight path or timer-based double-check.

### Incoming messages

Append with small opacity/vertical settle when user is at the live edge. While reading older history, preserve scroll anchor and show a new-message affordance instead of auto-scrolling. Burst events coalesce; virtualization must not replay enter animations when rows are recycled.

### Edit/delete/reaction

- Edit: content crossfade/height animation only if measurement is stable; focus/draft preserved.
- Tombstone: short content-to-tombstone fade; deletion scope confirmation precedes it.
- Reaction: small scale/opacity feedback on the reaction chip, not the entire bubble; count layout does not jump.
- Failed optimistic reaction rolls back with clear status, not invisible reversal.

### Typing/presence

Typing dots are ephemeral, low-amplitude and stop at TTL. Screen reader announces a coarse state at most, not each dot. Presence changes use a static label/icon; animated pulse is optional decoration and never means verified availability.

## 6. Loading and progress

- Skeleton only when layout is known; avoid shimmering large message histories indefinitely.
- Determinate upload/download uses real byte progress; indeterminate only before total is known.
- Reconnect uses text after anti-flicker delay; transition to `Syncing recent changes…` when replay fails.
- Never animate from 0 to 100 after work has already completed just for spectacle.
- Background operations remain cancellable where policy permits.

## 7. Future media and calls

Not implemented. When server platform and client gates permit:

- waveform follows decoded/playback data, not random decoration;
- record indicator is persistent, high contrast and accompanied by elapsed time;
- call join/leave roster animation is bounded so active-speaker updates do not cause grid thrash;
- network downgrade changes quality without full-screen flash;
- screen-share indicator persists until OS capture is confirmed stopped;
- E2EE/verification state never transitions to protected before negotiated proof.

Marketing call visuals remain labelled concept/roadmap and cannot resemble an active connected call without context.

## 8. Brand motion

The approved loader is specified in
[docs/specs/BRAND_LOADING_MOTION.md](docs/specs/BRAND_LOADING_MOTION.md) and has
a standalone evidence preview at
[design-previews/brand-loader/index.html](design-previews/brand-loader/index.html).
The logo image, fill and complete route remain invisible: only two
same-direction, half-a-route-separated points and short trails momentarily
reveal the reviewed outer/internal ribbon loop. App readiness always wins and
Reduce Motion renders a fixed, non-orbiting pair. Product integration remains
sequenced behind server-complete and the full iPhone loading-state model.

Scroll animations reveal hierarchy, but content is present and usable without
IntersectionObserver or motion. No continuous full-screen aurora runs behind
product reading surfaces.

## 9. Accessibility

Respect OS/browser Reduced Motion from the first frame. Remove:

- zoom/depth/parallax;
- animated blur/material thickness;
- repetitive pulses/waves;
- nonessential auto-scroll;
- large directional transitions.

Replace with short crossfade or immediate state. Reduce Transparency uses opaque tonal surfaces. Animation conveys no unique status; accessible labels and stable text remain.

Vestibular-safe is not equivalent to “duration 0”: focus, reading order and spatial state still require a clear, non-moving update.

## 10. Performance budgets

- Target display refresh where possible; baseline 60 fps on declared reference devices.
- Main-thread frame budget at 60 Hz is 16.7 ms including all rendering, not just animation code.
- Animate compositor-friendly opacity/transform; avoid large-area blur, layout and shadow changes in scroll.
- Do not animate every row in a long/virtualized list.
- Measure GPU/memory/battery for glass and 30-minute chat/call scenarios.
- Input/send remains responsive under realtime burst; animation is dropped before user input.

## 11. Platform implementation

- SwiftUI: system transitions/springs, `accessibilityReduceMotion`, `accessibilityReduceTransparency`; keep state change independent of `withAnimation` completion.
- Compose: `MotionDurationScale`, system animator setting, `AnimatedContent/Visibility` only with stable keys and measured layout.
- Web: `prefers-reduced-motion`, transform/opacity, no smooth scrolling when reduced; current stylesheet collapses animation/transition duration.
- Desktop: respect OS setting exposed through renderer/native API; menus/windows use platform motion.

## 12. Validation checklist

- Is the animation tied to a real state/event?
- Can it be interrupted, reversed and skipped?
- Does rapid repetition remain calm and correct?
- Does it preserve scroll/focus/draft?
- Does Reduced Motion preserve meaning without movement?
- Does it meet contrast and Reduce Transparency?
- Is frame/CPU/GPU/memory/energy measured on low reference hardware?
- Does a network failure reveal any fake success?
