# Luxora Web

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Status:** public product site shipped in this PR; web messenger client under active development; standalone web call fallback page for the media-plane preview

## 1. What exists

`apps/web` is React + TypeScript + Vite with React Router. It now has two clearly
different products, and only the first one is complete:

### 1.1 Public product site (complete in this PR)

| Route | Content |
| --- | --- |
| `/` | Landing: Three.js 3D phone hero (`src/Hero3D.tsx`), messaging/privacy/platform feature blocks, "in development" Beta-0.1 labels, CTA |
| `/download` | Per-platform "Coming Soon" cards (Windows, macOS, Linux, iOS, Android, Web). No real artifacts, no download links |
| `/security` | Honest security model: Cloud preview today, E2EE described only as planned/not available |
| `/docs` | Redirects to `/docs/introduction` |
| `/docs/:slug` | Documentation portal, 21 pages in `src/docs.ts`: introduction, installation, first steps, creating an account, profile, settings, sessions, chats, groups, messages, media, files, Windows/macOS/Linux/iOS/Android/Web, account security, privacy, API |
| `/faq` | Product and availability FAQ with planned/absent features labelled |
| `/about`, `/blog`, `/status`, `/contact` | Project, update placeholder, static status snapshot (explicitly "monitoring not connected"), contact form UI without a delivery backend |
| `/privacy`, `/terms` | Legal copy for the Beta preview |
| `*` | Not-found page |

The site is bilingual RU/EN: a locale provider in `src/i18n.tsx` stores only the
language choice in `localStorage` (`luxora-lang`), detects the browser language
on first visit and keeps `<html lang>` in sync. Every page carries its own
bilingual copy and per-page metadata (`useMeta`). The layout adds a skip link,
labelled navigation, landmarks, responsive mobile menu, scroll restoration,
reduced-motion support and a footer. `public/robots.txt` and
`public/sitemap.xml` are placeholders for a future hosted origin.

Truth properties of the public site:

- it performs **no** backend requests: no `fetch`, WebSocket, auth, realtime or media;
- it has **no** analytics, cookies beyond the language preference, no service
  worker/PWA support and no signed/downloadable artifacts;
- "Open Luxora" and every download card open a "Coming Soon" dialog while the
  web messenger client is unfinished;
- planned calls and E2EE are described as planned only; the active trust mode is
  Cloud preview and the copy says the server can read message content.

### 1.2 Web messenger client (in development, not shipped)

A real web messenger is being built inside the same Vite app under
`apps/web/src/app/`. Only the shared UI/data contract is committed at the moment
(`apps/web/src/app/contract.ts`): server-shaped models, the durable realtime
event union including `call.state.changed`, capability shape and the
state/action seam the UI must consume. The implementation (API client, realtime
client, store, screens) is under active development in this PR and is **not**
feature-complete.

Until the Lead hands over the verified feature list, this document must not be
read as a claim that any browser flow exists: no sign-in, chat list,
conversation, send, receipt, upload or call is documented here as working. The
global `MOBILE.md`/`CLIENTS.md` rule applies — a screen is not a feature, and a
fixture is not evidence.

Known gates the client must pass before it may be described as available (see
`docs/specs/PRODUCT_REQUIREMENTS.md` and `SECURITY.md` §7):

- browser auth architecture with the refresh credential kept out of
  `localStorage` and the access token memory-only;
- Cloud-preview trust label sourced from `GET /v1/capabilities`, never hardcoded;
- durable optimistic outbox, realtime v2 resume/replay and `sync.required`
  reconciliation;
- token/browser session purge on logout, revoke and account switch;
- CSP and hosting headers, safe rendering of user content, WebSocket origin checks
  in the deployed environment;
- keyboard/screen-reader, zoom/reflow, high-contrast and reduced-motion evidence;
- an automated test suite wired into CI (the package has Vitest; CI currently
  runs only build/typecheck for the site).

### 1.3 Standalone web call fallback page

`apps/call-web/index.html` is a separate single-file, build-less diagnostic page
(Russian UI) for the calls preview. It exists so a browser can test the
server-side call signaling and LiveKit media path while the web messenger client
is unfinished. It is not part of `apps/web`, not produced by any build and not
covered by CI.

What it actually does, as read from the file:

- sign in or register with username/password against a Luxora API (default
  `https://luxora.cloudpub.ru`, overridable with `?api=`), keeping the access
  token in `sessionStorage` (no Keychain, no refresh flow);
- lists direct chats through `GET /v1/chats` and polls `GET /v1/calls?chatId=`
  every two seconds to discover an incoming call (there is no push delivery);
- starts an audio call (`POST /v1/calls` + `ring`), accepts/declines, hangs up;
- once the server call reaches `connecting`/`active`/`reconnecting`, requests
  `POST /v1/calls/:id/join-grant` and connects a LiveKit room with
  `livekit-client` imported from the jsDelivr CDN, publishing the microphone and
  playing remote audio; a `503` (media plane not configured) is shown as an
  error instead of a fake connected call.

Honest limits: this page is a temporary fallback, not a product client. It has
no video, no push pings, no message history, no realtime messaging, no device
management, no CSP/hosting headers of its own, depends on a third-party CDN and
stores a bearer token in `sessionStorage`. It must not be announced as the web
client.

## 2. Product truth

The product release is `Beta-0.1 · Cloud preview`. Web copy must never claim:

- end-to-end encryption, "private" or "protected" calls — there is no audited
  E2EE and no audited media encryption; WebRTC hop encryption is not Luxora E2EE;
- real push delivery, production SMS or production calls — none are configured;
- stable availability, uptime or monitoring — `/status` is a static snapshot and
  says so;
- downloadable apps, installers or an installable PWA — none exist.

Messages and media are readable by the server in this build. A public site that
is static does not change that. When the web messenger client lands, it inherits
the same Cloud-preview trust class until the separately audited Private
subsystem is negotiated.

## 3. Run and build

```bash
npm --prefix apps/web ci
npm --prefix apps/web run dev      # Vite dev server on 0.0.0.0:4173
npm --prefix apps/web run typecheck
npm --prefix apps/web run build    # tsc -b && vite build -> apps/web/dist
npm --prefix apps/web run preview  # serves the production build on :4173
```

The package also declares `npm --prefix apps/web run test` (Vitest); it is used
for the web client slice as tests are added. Output `apps/web/dist` is ignored
and is also what `apps/desktop` packages; building assets does not create a
secure public deployment, a downloadable native client or a working messenger.

## 4. Current structure

- `src/main.tsx` — React boot with the locale provider;
- `src/App.tsx` — router and layout (public routes only today);
- `src/pages/` — landing, download, security, docs portal, FAQ, about, blog,
  status, contact, legal, not-found;
- `src/components/` — navbar, footer, scroll restoration, shared UI primitives;
- `src/Hero3D.tsx` — Three.js hero scene;
- `src/docs.ts` — bilingual documentation content and slug lookup;
- `src/i18n.tsx` — RU/EN locale context and `useCopy`;
- `src/styles.css` — design tokens, layout, responsive and motion styles;
- `src/app/contract.ts` — shared contract for the in-development messenger
  client (`src/app/core/` and `src/app/ui/` are the implementation being built);
- `public/` — logo, robots.txt, sitemap.xml;
- `vite.config.ts` — dev/preview host `0.0.0.0:4173`.

## 5. Web security baseline (for the site and the future client)

- Strict CSP without unsafe script/HTML paths at the eventual hosting ingress;
  no `dangerouslySetInnerHTML` for user content.
- `frame-ancestors`, Referrer-Policy and a minimal Permissions-Policy at ingress.
- Never put bearer/refresh tokens in URLs, logs, DOM attributes or persistent JS
  storage; the refresh credential must not enter `localStorage`.
- Validate WebSocket Origin and every object authorization server-side; the
  static site cannot set response headers by itself.
- Service worker (when added) must not cache credentials or private API
  responses and must purge on logout/update.
- Sanitize or semantically render rich text; external links use safe
  protocol/rel and must not navigate the Electron renderer unexpectedly.
- No analytics of message text, filenames, exact search or the social graph.
- The `call-web` fallback page additionally must not be hosted as a product
  surface: it imports a CDN script and has no CSP of its own.

## 6. Accessibility and responsive behavior

The public site includes a skip link, labelled controls, landmarks, visible
focus, responsive layout and `prefers-reduced-motion`. Required before calling
any Web surface released:

- automated WCAG scan with zero critical findings plus manual keyboard and
  NVDA/VoiceOver passes;
- focus trap/restore for the mobile menu and modal dialogs;
- zoom 200–400 %, reflow at 320 px, high contrast and reduced-motion checks;
- screen-reader semantics for the messenger once it exists (message grouping,
  receipt updates that are not noisy, virtualized history that keeps focus order);
- RTL/pseudo-localization and locale-aware strings.

## 7. Performance

The landing imports Three.js and renders a canvas hero; the docs portal bundles
its copy into one module. Before a public release, measure bundle size, LCP/CLS/
INP, font behavior, memory for long histories and composer latency under event
bursts. Target values in the canonical specs are gates, not current claims.

## 8. Publication gate

The site may advertise only a platform with a real signed artifact or a working
URL and evidence. Download cards are non-links until then. Security/call/
multi-device/server-scale copy stays explicitly planned. Privacy, terms,
cookie and support destinations must be reviewed pages before a public launch.
The web messenger client is added to this document only when the Lead confirms
it is feature-complete, with its exact implemented features and honest gaps.
