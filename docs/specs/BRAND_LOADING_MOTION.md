# Luxora contour loader

**Canonical public release:** Beta-0.1  
**Owner and developer:** Flenym  
**Status:** approved motion concept and standalone preview; client integration is queued behind server-complete

## 1. Intent

The loader turns the exact Luxora ribbon geometry into a short piece of
functional brand motion without displaying the logo itself. Two points travel
in the same direction around one reviewed closed route that follows both the
outer edge and the internal crossing/loop. They remain exactly half a path
apart: neither point catches, meets, or passes the other. Only their compact
light trails momentarily reveal a small part of the otherwise invisible route.
The animation communicates real work; it is not a delay added for decoration.

The source mark is never rendered by the loader. The motion geometry in
[`assets/brand/luxora-loader-route.svg`](../../assets/brand/luxora-loader-route.svg)
was reviewed against both the outer and internal luminous edge network of
[`logo.png`](../../logo.png). The route asset supplies geometry only: the
loader never paints its complete stroke or the colour/alpha image.

## 2. Visual modes

| Mode | Surface | Idle route | Moving points and rays | Logo image |
| --- | --- | --- | --- | --- |
| Dark | `#000000` | invisible | white cores; violet and blue trails | never rendered |
| Light | `#FFFFFF` | invisible | black cores and neutral-black trails | never rendered |
| Reduced transparency | opaque system background | invisible | no blur; solid semantic dots/trails | never rendered |
| High contrast | system black/white | invisible | system foreground only | never rendered |

The black surface is truly black, not charcoal. The light surface is truly
white. Client safe-area backgrounds match the loader surface so no rectangle is
visible around the mark.

## 3. Motion contract

- Outer-contour loop: `1,800 ms` per revolution, linear path velocity.
- Point A path phase: `t`; point B path phase: `(t + 0.5) mod 1`.
- Both points use the same path direction and angular velocity, preserving the
  half-revolution separation for the entire animation.
- Core diameter: `6 pt` compact / `8 pt` full-screen.
- Trail: 14 samples over the previous 9% of path, ease-out opacity, maximum
  visual length 36 pt. A trail never hides the logo edge.
- Neither the source logo, a ghost fill, nor a persistent full-route stroke is
  drawn at any animation phase.
- Transition to content: both rays stop in their still-opposing positions and
  use a `180 ms` opacity crossfade. Content readiness is never gated on
  completion of that flourish.
- Indeterminate work may loop. Determinate work maps progress monotonically to
  one revolution and exposes the numeric value to accessibility APIs.
- Pause animation when the surface is hidden/backgrounded.

Motion uses a monotonic clock and path distance, not frame count. On a slow
device it drops frames instead of changing task completion or accumulating
multiple animation loops.

## 4. Placement variants

### First launch / cold app start

- Centered mark occupies 34–42% of the shorter screen edge.
- Show only while initial database/session/config work is actually pending.
- Do not flash for work completing in under 120 ms.
- Minimum visible duration after presentation: 650 ms, maximum: 8 s. At the
  maximum, render a useful recovery/status surface; never spin forever.

### Authentication and session restoration

- Compact 72–96 pt loader near the truthful status text: `Signing in`,
  `Restoring your session`, or `Reconnecting`.
- The loader cannot substitute for errors, retry, cancellation, or offline UI.
- Password/passkey/QR secrets are never embedded in animation telemetry.

### Website and download page

- Use only for initial application hydration or a real download preparation
  step, not every route transition.
- Server-rendered content and accessibility text remain available without
  JavaScript. The preloader must not reduce LCP by hiding already usable content.
- Download progress uses the determinate variant when byte progress is known.

### Inline operations

- Use the compact monochrome form for a single bounded control.
- Never cover the whole conversation for sending one message or loading one
  thumbnail. Existing content remains interactive where safe.

## 5. Accessibility and user settings

- The container has a localized status label; the moving points are decorative.
- Status changes are announced once, not on every frame.
- With Reduce Motion, render only two fixed opposing dots with short static
  trails and one gentle opacity transition no faster than 1,200 ms. Do not
  reveal the complete route and do not orbit.
- With Reduce Transparency, remove glow/blur and use solid semantic foreground.
- Respect high contrast, increased contrast, colour filters, Dynamic Type, RTL,
  browser `prefers-reduced-motion`, and `forced-colors`.
- The loader never conveys failure/success by colour or motion alone.

## 6. Performance budgets

- One animation clock per visible loader; zero clocks after unmount/background.
- No per-frame image decoding, DOM creation, SwiftUI state fan-out, or layout.
- Web target: one canvas/SVG layer, no more than 320 contour samples after
  tracing, no long task over 16 ms on the reference mobile browser.
- Native target: cached path and gradients; no continuous offscreen blur when
  Reduce Transparency is active.
- Route viewBox/path and SHA-256 are build-time validated. Missing/corrupt asset
  falls back to a standard accessible progress indicator.

## 7. Platform implementation route

| Surface | Planned implementation | Gate before wiring |
| --- | --- | --- |
| iPhone/iPad | SwiftUI `Canvas`/trimmed cached `Path`, TimelineView only while visible | server-complete, iPhone loading-state model, simulator + real-device energy/accessibility tests |
| macOS | shared Swift path data with native scene lifecycle | full iPhone stable |
| Android | Compose `Canvas`, cached `PathMeasure` | full iPhone stable |
| Web | SVG/canvas contour with Page Visibility and media-query fallbacks | full iPhone stable; no LCP/content hiding regression |
| Windows/Linux | shared web canvas only after desktop shell security/update gate | full iPhone stable |

The standalone preview at
[`design-previews/brand-loader/index.html`](../../design-previews/brand-loader/index.html)
is design evidence only. It is not wired into any release surface and therefore
does not imply those clients are complete.

## 8. Acceptance checklist

- [x] Canonical raster logo preserved at repository root.
- [x] Transparent RGBA master exists and has transparent corners.
- [x] Dark and light contour behaviours are specified.
- [x] A reviewed closed route follows the mark's outer edge and internal ribbon loop.
- [x] The standalone preview renders only two same-direction, always-opposing points/rays; no logo fill, ghost image, or persistent outline.
- [x] Reduced Motion, contrast, lifecycle, timing and failure rules are defined.
- [ ] Port the reviewed SVG route into platform-native path data without changing its geometry.
- [ ] Wire first-launch/session states into the full iPhone app after server-complete.
- [ ] Pass VoiceOver, Reduce Motion/Transparency, high-contrast, energy and launch tests on real iPhone hardware.
- [ ] Wire the website only after the authenticated Web/public-site phase is unfrozen and prove no Core Web Vitals regression.
- [ ] Port the proven component to remaining clients in the approved platform order.
