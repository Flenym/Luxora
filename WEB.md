# Luxora Web

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Status:** public product site completed; web messenger client implemented at `/app` and verified by 49 unit tests, typecheck + build and a committed browser E2E + axe accessibility CI gate (`tools/web-e2e`, 17/17 checks in GitHub Actions) — developer preview, not a released client; honest PWA shell; standalone call fallback page for diagnostics

## 1. What exists

`apps/web` is React + TypeScript + Vite with React Router. It ships two
surfaces plus one diagnostic page.

### 1.1 Public product site (completed in this PR)

| Route | Content |
| --- | --- |
| `/` | Landing: lazy-loaded Three.js phone hero (`src/Hero3D.tsx` / `src/components/HeroStage.tsx`), messaging/privacy/platform feature blocks, "in development" Beta-0.1 labels, "Open messenger" CTA to `/app` |
| `/download` | Per-platform "Coming Soon" cards (Windows, macOS, Linux, iOS, Android, Web). No real artifacts, no download links |
| `/security` | Honest security model: Cloud preview today, E2EE described only as planned/not available |
| `/docs` | Redirects to `/docs/introduction` |
| `/docs/:slug` | Documentation portal: 22 bilingual pages in `src/docs.ts` (16 written topics — introduction, installation, quick start, first steps, creating an account, profile, settings, sessions, chats, groups, messages, media, files, account security, privacy, API — plus Windows/macOS/Linux/iOS/Android/Web platform pages) |
| `/faq` | Product and availability FAQ with planned/absent features labelled |
| `/about`, `/blog`, `/status`, `/contact` | Project, update placeholder, static status snapshot (explicitly "monitoring not connected"), contact form UI without a delivery backend |
| `/privacy`, `/terms` | Pre-launch legal copy for the Beta preview |
| `*` | Not-found page |

14 routes total including `/app` and the router catch-all. Bilingual RU/EN: a
locale provider in `src/i18n.tsx` stores only the language choice in
`localStorage` (`luxora-lang`), detects the browser language on first visit and
keeps `<html lang>` in sync. Every page carries bilingual copy and per-page
metadata. The layout adds a labelled navbar/footer, skip link, landmarks,
responsive mobile menu, scroll restoration and reduced-motion support.

Publication metadata lives in `index.html` and `public/`: canonical
`https://luxora.app/`, Open Graph/Twitter cards, a JSON-LD graph (WebSite +
Organization/SoftwareApplication data), 32/64/192 px icons, a 1200×630 `og.png`,
`robots.txt` that allows the marketing site and disallows `/app`, and a
`sitemap.xml` listing the public routes and documentation pages. The
`https://luxora.app` origin is the declared publication origin; this repository
does not host or deploy the site, so the metadata is not proof of a live
deployment.

Truth properties of the public site:

- it performs **no** backend requests: no `fetch`, WebSocket, auth, realtime or media;
- it has **no** analytics, no cookies beyond the language preference, no service
  worker/PWA support and no signed/downloadable artifacts;
- "Open messenger" and the hero/CTA links navigate to the `/app` preview with
  honest Beta labels; platform download cards remain "Coming Soon" placeholders;
- planned calls and E2EE are described as planned only; the active trust mode is
  Cloud preview and the copy says the server can read message content.

### 1.2 Web messenger client at `/app` (implemented in this PR)

`/app` (also `/app/*`) renders `src/app/MessengerApp.tsx` full-screen, outside
the marketing layout. It is a real network client against the Beta-0.1 API and
realtime gateway; it is **not** a finished release and must not be presented as
one.

Implemented and verified:

- **Auth:** sign-in and sign-up with the server's strict rules (username 3–32
  chars, password 12–128), device name, session boot from the `sessionStorage`
  refresh token with a single-flight refresh, sign-out. Honest Beta-0.1 /
  Cloud-preview / not-E2EE notices on the auth screen. No phone-OTP or passkey UI.
- **Shell:** sidebar with server+local chat search, All/Unread/Archived filters,
  chat rows with unread badge, last message and relative time; new chat by exact
  username lookup; message-request panel (incoming/outgoing, accept, decline,
  send request); profile menu with display-name/bio edit, connection state and
  sign out.
- **Conversation:** cursor-paginated history, load-older, optimistic send with
  same-nonce retry, reply quotes, edit/delete, reactions (💜👍🔥😂 + counts),
  pinned-message display, day separators, new-messages divider, typing
  indicator, approximate realtime-only presence, per-chat local drafts,
  read receipts on open/focus.
- **Receipt truth:** delivered/read ticks are shown only from authoritative
  receipt reads — one tick while incomplete, two only when the server proof
  exists; nothing is faked by a timer.
- **Attachments:** images sent through chunked authenticated upload and rendered
  via authenticated fetch + server thumbnail; file cards; authenticated
  download; authenticated avatars.
- **Realtime:** `/v2/realtime` with the access token in the authenticate frame
  (never in a URL), opaque cursor resume, `sync.required` → bounded HTTP reload
  then reconnect, bounded backoff with jitter, close-code handling
  (`4001` refresh-or-sign-out, `1008`/`1013` backoff), and `call.state.changed`
  driving call banners.
- **Calls (signalling UI only):** incoming accept/decline banner and an
  active-call overlay with hangup. The media adapter starts as "unavailable" and
  honest Russian copy explains that the server advertises no calls media while
  `GET /v1/capabilities` reports `features.calls:false`; it never claims
  connected audio. A LiveKit adapter exists behind a dynamic import for a server
  that advertises calls and issues a join grant.
- **Tokens:** access token memory-only, refresh token in `sessionStorage` only —
  never `localStorage`, never a URL, never in logs.
- **CORS:** the API now preflights every browser mutation method and exposes the
  safe headers needed for authorized downloads/range reads
  (`services/api/src/app.ts`, covered by a preflight regression test). Vite dev
  and preview proxy `/v1`, `/v2` (websockets) and `/health` to the local API on
  `127.0.0.1:2222`; a hosted build needs a real API origin and hosting headers.

Verification recorded for this client: **49 Vitest tests** (`api` 17,
`realtime` 13, `store` 19) wired into the "Node, Web and Desktop" CI workflow,
`tsc -b`/build passing, and a **committed browser E2E + accessibility gate**:
`tools/web-e2e` drives two isolated Chrome contexts against a real API and a
temporary SQLite database (generated dev secrets and CSPRNG test accounts,
`vite preview`, system-Chrome autodetect, process-tree cleanup) and passed in
GitHub Actions with **17/17 checks** — 16 functional checks (auth error, sign-in,
stranger-Direct guard → message request → accept, chat reopen/open, realtime
delivery, reply, honest delivery tick, image upload/render, honest call gating,
profile, sign-out, zero unexpected console errors) plus an **axe-core 4.14 WCAG
2.x A/AA audit over nine states** that fails on critical/serious findings with an
empty baseline and JSON/markdown artifacts. An independent web-ui audit recorded
**0 critical/serious/moderate/minor axe findings across 22 development and 21
production-preview states** and **11/11 keyboard checks**. Route-level code
splitting reduced the initial marketing payload from 606.33 kB raw / 170.60 kB
gzip to **287.99 kB raw / 89.73 kB gzip (−52.5% / −47.4%)**, with `/app`, docs and
other routes lazy under an honest loader. Bundle note: the earlier ≈536 kB main
chunk was replaced by that split, so it is not a current figure.

Known gaps — do not imply these exist:

- no server-synced drafts or folder-management UI (drafts are local
  `localStorage` per account; the folder filter is local);
- no video or screen-share calls and no push ringing; the web client's calls use
  the cloud-preview server media plane (no E2EE) and mute works only when media is
  actually connected;
- PWA shell caches only public shell/static assets — **no Web Push and no offline
  message cache**, and service-worker registration is production-HTTPS-only;
- calls media is verified locally against the Docker media plane (18/18 browser
  checks: both peers connected, active via signed webhook, mute both ways,
  hangup clears overlays) but there is no CI media-stack job; without a configured
  media plane `features.calls` stays `false` and the adapter stays unavailable;
- presence is approximate and realtime-only;
- no RTL/pseudo-localization run and no manual WCAG/assistive-technology audit for
  `/app` yet (axe is a floor, not a conformance proof); hosted CSP/headers remain a
  deployment gate.

### 1.3 Standalone web call fallback page

`apps/call-web/index.html` remains a separate single-file, build-less diagnostic
page (Russian UI) for the calls preview. It is not part of `apps/web`, not
produced by any build and not covered by CI. It signs in with username/password,
keeps the access token in `sessionStorage`, polls `GET /v1/calls?chatId=` every
two seconds (no push), and after a `connecting`/`active` state requests a join
grant and connects LiveKit via `livekit-client` imported from jsDelivr. Limits:
diagnostic only — no video, no push, no message history/realtime, no device
management, no CSP of its own, third-party CDN dependency; it must not be
announced as the web client.

## 2. Product truth

The product release is `Beta-0.1 · Cloud preview`. Web copy must never claim:

- end-to-end encryption, "private" or "protected" calls — there is no audited
  E2EE and no audited media encryption; WebRTC hop encryption is not Luxora E2EE;
- real push delivery, production SMS or production calls — none are configured;
- stable availability, uptime or monitoring — `/status` is a static snapshot and
  says so;
- downloadable apps, installers or an installable PWA — none exist;
- that `/app` is a released client or that its calls can carry audio in the
  current deployment.

Messages and media are readable by the server in this build. The web client
inherits the same Cloud-preview trust class and says so; it does not claim E2EE.

## 3. Run and build

```bash
npm --prefix apps/web ci
npm --prefix apps/web run dev      # Vite dev server on 0.0.0.0:4173
npm --prefix apps/web run typecheck
npm --prefix apps/web run build    # tsc -b && vite build -> apps/web/dist
npm --prefix apps/web test         # Vitest: 49 unit tests
npm --prefix tools/web-e2e test    # committed browser E2E (CI gate; needs Chrome)
npm --prefix apps/web run preview  # serves the production build on :4173
```

With a local API on `127.0.0.1:2222`, open the marketing site at
`http://127.0.0.1:4173/` and the messenger at
`http://127.0.0.1:4173/app`; the dev/preview Vite proxy forwards `/v1`, `/v2`
and `/health` to the API. `VITE_LUXORA_API` exists for hosted/desktop builds
that talk to a different API origin; the default is same-origin. Output
`apps/web/dist` is ignored and is also what `apps/desktop` packages; building
assets does not create a secure public deployment.

## 4. Current structure

- `src/main.tsx` — React boot with the locale provider;
- `src/App.tsx` — router and marketing layout; `/app` renders the messenger;
- `src/pages/` — landing, download, security, docs portal, FAQ, about, blog,
  status, contact, legal, not-found;
- `src/components/` — navbar, footer, scroll restoration, shared UI primitives,
  lazy hero stage / phone visual;
- `src/Hero3D.tsx` — Three.js hero scene;
- `src/docs.ts` — bilingual documentation content and slug lookup;
- `src/i18n.tsx` — RU/EN locale context and `useCopy`;
- `src/styles.css` — marketing design tokens, layout, responsive/motion;
- `src/app/contract.ts` — Lead-owned UI/data contract;
- `src/app/messenger.tsx` — provider + `useMessenger()` state/action seam;
- `src/app/MessengerApp.tsx`, `src/app/app.css` — full-screen shell and styles;
- `src/app/core/` — REST client, realtime client, pure state helpers, call-media
  adapters, colocated unit tests, module README;
- `src/app/ui/` — sidebar, conversation pane, message list/bubble, composer,
  attachments/media, calls overlay, dialogs, toasts, primitives, copy, format;
- `public/` — icons, `og.png`, `robots.txt`, `sitemap.xml`;
- `vite.config.ts` — dev/preview host, port and local API proxy.

## 5. Web security baseline

Implemented in the client: access token memory-only, refresh token only in
`sessionStorage` (no `localStorage`, no URL, no logs), strict server error
envelopes, no `dangerouslySetInnerHTML` for server content, WebSocket auth via
the authenticate frame, and CORS limited to the exact configured origins while
allowing all browser mutation methods and exposing only safe headers.

Still required before any hosted release:

- strict CSP (no unsafe script/HTML paths), `frame-ancestors`, Referrer-Policy
  and a minimal Permissions-Policy at the hosting ingress — the static build
  cannot set every response header itself;
- review of `sessionStorage` refresh-token exposure (XSS boundary) versus a
  secure HttpOnly design before production hosting;
- service-worker/cache purge on logout/update if a PWA is ever added;
- no analytics of message text, filenames, exact search or the social graph;
- external links use safe protocol/rel and must not navigate an embedding shell.

The `call-web` fallback page additionally must not be hosted as a product
surface: it imports a CDN script and has no CSP of its own.

## 6. Accessibility and responsive behavior

The marketing site includes a skip link, labelled controls, landmarks, visible
focus, responsive layout and `prefers-reduced-motion`; the `/app` shell keeps
labelled dialogs/filters, status roles, focus handling for the call overlay and
a keyboard-operable composer. Required before calling any Web surface released:

- automated WCAG scan with zero critical findings plus manual keyboard and
  NVDA/VoiceOver passes (including `/app` dialogs and the call overlay);
- focus trap/restore for panels, mobile navigation and call overlay;
- zoom 200–400 %, reflow at 320 px, high contrast and reduced-motion checks;
- screen-reader semantics for message grouping, receipt updates and virtualized
  long histories;
- RTL/pseudo-localization and locale-aware all user strings.

## 7. Performance

The landing code-splits the Three.js hero; the `/app` client code-splits
`livekit-client` behind a dynamic import. Before a public release, measure bundle
size, LCP/CLS/INP, font behavior, memory for long histories and composer latency
under event bursts. The main-chunk figure above is a recorded build fact, not a
performance claim; target values in the canonical specs are gates.

## 8. Publication gate

The site may advertise only a platform with a real signed artifact or a working
URL and evidence. Download cards are non-links until then. Security/call/
multi-device/server-scale copy stays explicitly planned. Privacy, terms, cookie
and support destinations must be reviewed pages before a public launch. The
`/app` messenger is a developer preview: it becomes a "web client" only after
hosting with the required headers/CSP, CI E2E coverage, an accessibility audit
and a decision on session storage, with the Lead confirming the evidence.
