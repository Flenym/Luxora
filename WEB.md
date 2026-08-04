# Luxora Web

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Status:** local public-site and messenger UX slice; not connected to backend

## 1. What exists

`apps/web` is React + TypeScript + Vite. Route `/` renders a responsive product site; `/app` renders an interactive messenger prototype. It uses the canonical logo, light/dark themes, responsive layouts and extensive synthetic content.

Implemented in local component state:

- chat list, filters and search;
- list → conversation mobile navigation;
- draft/send interaction and synthetic receipt transition;
- reaction toggle, pinned/typing/presence visuals;
- local file selection rendered as a message without upload;
- conversation search/details surfaces;
- semantic landmarks, focus styles, live region and reduced-motion CSS;
- Electron menu bridge for search/new-message focus.

Only theme is saved in `localStorage`. Conversation state is in memory for the current tab. No `fetch`, WebSocket, persistent message database, service worker, push, auth or media upload is implemented.

## 2. Product truth

The current UI labels itself local demo/roadmap. Calls emit a roadmap toast and do not open a call. E2EE, multi-device, AI, storage and native download cards are roadmap/source-build statements. Files never leave the local selection flow.

Local demo content not being sent to the server is not an E2EE claim. Once a real backend is connected, Phase 1 messages are server-readable Cloud preview until the independently audited Private subsystem is negotiated.

The Web and public site remain feature-frozen until complete server platform + full iPhone. Only truth, security, accessibility and build maintenance proceeds.

## 3. Run and build

```bash
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

Vite listens on `0.0.0.0:4173`; browse `http://127.0.0.1:4173`. Production asset build:

```bash
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix apps/web run preview
```

Output is `apps/web/dist` and is ignored. Building assets does not create a secure public deployment or downloadable native client.

## 4. Current structure

- `src/App.tsx` — landing, messenger and local state/components.
- `src/styles.css` — semantic variables, glass/brand/layout/responsive/motion styles.
- `src/main.tsx` — React boot.
- `public/logo.png` — derived canonical brand asset.
- `vite.config.ts` — dev/preview host and port.

The single-file prototype is acceptable for exploration, not future product architecture. When Web unfreezes, split public site/authenticated app and split features into presentation, domain, sync, transport and storage modules.

## 5. Future connection prerequisites

Blocked until server + full iPhone stable:

- reviewed browser auth architecture; refresh credential must not enter `localStorage`;
- explicit Cloud preview onboarding and trust label sourced from capability/negotiated state;
- generated/validated protocol adapter and error/cursor fixtures;
- IndexedDB/local encrypted-at-rest strategy for drafts/outbox/cache where feasible;
- durable optimistic send, WebSocket replay and `sync.required` reconciliation;
- logout/session-revoke cache/service-worker/storage purge;
- real delivered/read only from protocol receipts;
- push permission after contextual explanation;
- media upload/download authorization and browser parser policy;
- supported browser/PWA matrix and minimum secure version handling.

## 6. Web security baseline

- Strong CSP with no unsafe script/HTML path; current external Google Fonts dependency should be self-hosted or reviewed for production privacy/CSP.
- `frame-ancestors`, Referrer-Policy and minimal Permissions-Policy at ingress.
- Avoid bearer/refresh in URLs, logs, DOM attributes or persistent JS storage.
- Sanitize/semantic-render rich text; no `dangerouslySetInnerHTML` for messages.
- Validate WebSocket Origin and all HTTP object authorization server-side.
- Service worker must not cache credentials/private API responses and must purge on logout/update.
- External links use safe protocol/rel and cannot navigate Electron renderer unexpectedly.
- No analytics message text, filenames, exact search or raw social graph.

Current Vite static output needs hosting security headers configured by deployment; source code alone cannot set every response header.

## 7. Accessibility and responsive behavior

Current code includes skip link, labelled controls, landmarks, `aria-live` conversation/status, visible focus and `prefers-reduced-motion`. Required before release:

- automated WCAG scan with zero critical plus manual keyboard/NVDA/VoiceOver tests;
- focus trap/restore for panels/mobile navigation;
- zoom 200–400%, reflow 320 px, high contrast and Reduce Transparency fallback;
- screen-reader message grouping/action semantics and non-noisy receipt updates;
- RTL/pseudo-localization and locale-aware all user strings;
- virtualized 10k-message history without breaking reading/focus order.

## 8. Performance

Current app imports font CSS at runtime and contains a large single component/style sheet; these are preview tradeoffs. Before public Web release measure bundle, LCP/CLS/INP, font behavior, memory for long histories, composer latency under event burst and glass GPU cost. Target values in canonical specs are gates, not current claims.

## 9. Public-site publication gate

The site may advertise only a platform with a real signed artifact/working URL and evidence. Download cards are non-links until then. Security/call/multi-device/server-scale copy stays explicitly roadmap. Privacy/terms/cookie/support destinations must become real reviewed pages before public launch.

