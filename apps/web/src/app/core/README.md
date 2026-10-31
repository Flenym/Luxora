# Luxora web messenger — data layer

This directory owns everything between the Luxora HTTP/WebSocket API and the
React UI. It is deliberately framework-light so it can be unit-tested in a node
environment without a DOM.

## Modules

| File | Responsibility |
| --- | --- |
| `api.ts` | Typed REST client for the Beta-0.1 API. Token policy (access in memory, refresh in `sessionStorage`), strict error-envelope parsing (`LuxoraApiError`), one in-flight refresh + single retry on 401, chat/message/reaction/receipt/request/user/search/upload/call endpoints, idempotent chunked uploads with WebCrypto SHA-256, authenticated binary `authBlob()`. |
| `realtime.ts` | `/v2/realtime` WebSocket client. Sends the access token in the `authenticate` frame (never the URL), resumes from the opaque cursor, persists cursors only after apply, handles one reconnect attempt with exponential backoff + jitter, `sync.required` (HTTP reload first, then reconnect without a cursor), close codes `4001` (refresh or sign out), `1008`/`1013` (bounded backoff). Fully injectable WebSocket factory + timers. |
| `store.ts` | Pure `MessengerState` helpers: idempotent chat/message/reaction merge, canonical ordering, optimistic rows (`_pending`/`_failed`) with outbox state, unread counters, receipt merge that never overclaims (`complete` only from authoritative reads), typing expiry, presence, call snapshots. |
| `call-media.ts` | Isolated call-media adapter. `UnavailableCallMediaAdapter` is the honest default; `LiveKitCallMediaAdapter` is dynamically imported only when capabilities advertise calls *and* a join grant succeeded. |
| `__tests__`-style colocated tests | `api.test.ts`, `realtime.test.ts`, `store.test.ts` — node environment, injected fetch/WebSocket/timers/storage, no DOM. |

`app/messenger.tsx` is the React integration seam: `MessengerProvider` +
`useMessenger()` implement the Lead-owned contract in `app/contract.ts`
(README: see the module docblocks; `app/ui/**` only consumes the hook).

## Truth rules encoded here

- Delivery ticks: `receipts[messageId].complete` is `true` only after
  `GET /v1/messages/:id/receipts`; realtime receipt events merge rows but never
  upgrade `complete`, so the UI can never fake Delivered/Read.
- Calls: `call.media` starts and stays `"unavailable"` when
  `capabilities.features.calls` is false or the join grant answers `503`; it is
  never set to `"connected"` without a real media connection.
- Tokens: access token never leaves memory, refresh token never goes to
  `localStorage`, and no token ever appears in a URL.
- Server content is never rendered as trusted HTML.

## Commands

From the repository root:

```powershell
npm --prefix apps/web test          # vitest run (node env)
npm --prefix apps/web run typecheck # tsc -b
npm --prefix apps/web run build     # tsc -b && vite build
```

The unit tests use `apps/web/vitest.config.ts` (`environment: "node"`,
`include: ["src/app/core/**/*.test.ts"]`). The browser build is served by Vite at
`http://127.0.0.1:4173/app`; in dev the API is reached through the same-origin
Vite proxy (`/v1`, `/v2` with websockets, `/health` → `http://127.0.0.1:2222`),
so `DEFAULT_API_BASE` can stay `""`. Set `VITE_LUXORA_API` only for a hosted or
desktop shell deployment that talks to a different API origin.
