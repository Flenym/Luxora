# Luxora — UX Flows

**Канонический релиз:** Beta-0.1  
**Разработчик и владелец:** Flenym  
**Дата:** 3 августа 2026  
**Область:** Web, iPhone/iPad, macOS, Android, Windows, Linux; M0 обозначен отдельно от target experience

## 1. UX contract

### 1.1. Главная навигация

Core destinations остаются стабильными:

1. **Inbox** — Direct, Circles, Saved, requests, archive/folders.
2. **Spaces** — сообщества и их channels/topics/rooms.
3. **Calls** — active/recent/scheduled calls.
4. **Search** — people, conversations, messages, files и public spaces в разрешённых scopes.
5. **You** — profile, devices, notifications, appearance, privacy, data.

На compact layout Search может быть отдельной tab или contextual surface; на desktop — глобальное поле/command с сохранением того же scope model. Public discovery не вставляется в Inbox.

### 1.2. Три уровня глубины

`Destination → list/space → conversation/topic → optional inspector`

- Back всегда возвращает на один уровень, не выбрасывая пользователя из destination.
- На expanded layout list и conversation остаются рядом; inspector открывается третьей колонкой.
- Deep link восстанавливает destination, parent context и target, а не показывает «оторванное» сообщение.

### 1.3. Trust label language

| Состояние | Заголовок | Объяснение |
| --- | --- | --- |
| M0 Current Cloud | `Cloud preview` | `Protected in transit. Not end-to-end encrypted. Don’t use for sensitive information.` |
| Target Private | `Private` | `End-to-end encrypted. Only conversation devices can read messages.` |
| Moderated | `Moderated` | `Messages can be processed for search, safety and moderation.` |
| Secret metadata mode | `Private · Minimized metadata` | Краткий список ограничений и ссылка `What remains visible?` |

Иконка и цвет дополняют текст, но не заменяют его. Состояние вычисляется из negotiated/policy state, а не из названия conversation.

### 1.4. Message state language

| Internal state | Visual | Accessible label | User action |
| --- | --- | --- | --- |
| Local pending | subtle clock/progress | `Sending` | Cancel при large media |
| Server accepted | one check | `Sent` | None |
| Delivered to at least one recipient device | two checks | `Delivered` | None |
| Read under privacy policy | filled/accent checks or avatar | `Read` | Open details where allowed |
| Retryable failure | warning + retained bubble | `Not sent` | Retry / Edit / Delete |
| Permanent rejection | warning + reason category | `Couldn’t send` | Fix issue / Learn more |

Presence, receipts и security state никогда не передаются только цветом.

### 1.5. Motion/material rules

- Glass применяется к navigation, floating composer actions, menus и call controls; message content остаётся на устойчивых surfaces.
- Send animation краткая и не задерживает optimistic bubble.
- Переход list → conversation поддерживает spatial continuity; при Reduce Motion — crossfade без zoom/depth/animated blur.
- Любая animation interruptible; durable status остаётся после её завершения.
- Haptic/audio — optional reinforcement, не единственный feedback.

## 2. Global states

Каждый экран специфицирует:

- Initial loading / incremental loading.
- Empty first-use / empty by filter / no search result.
- Offline with cached data / offline without cache.
- Permission denied / membership removed.
- Retryable server error / permanent policy rejection.
- Stale data / reconnecting / gap reconciliation.
- Deleted target / unsupported client version.
- Reduced Motion, large text, RTL, keyboard and screen reader state.

### 2.1. Offline banner

`Offline · Messages will send when you reconnect` — persistent but non-modal. Queued bubbles stay in chronological local order. Tap opens queue/status, not a generic settings page.

### 2.2. Reconnecting banner

`Reconnecting…` appears only after a short anti-flicker delay. If resume fails and reconciliation starts: `Syncing recent changes…`. Composer remains usable unless policy state is unknown; in that case queued send waits for membership validation.

### 2.3. Update required

Security-incompatible client shows a blocking, signed-update flow with reason: `This version can’t safely join this conversation.` Drafts remain exportable/retained; no plaintext fallback.

## 3. Flow F01 — first launch and registration

### Goal

Create a recoverable account and reach Inbox quickly without front-loading every permission.

### Happy path

1. Brand moment ≤ 800 ms and skippable by loaded app; logo ribbon resolves into navigation accent.
2. Welcome: `Your conversations, clearly private.` CTA `Create account`; secondary `Sign in`.
3. M0 only: inline disclosure `Preview: messages are not end-to-end encrypted.` with `Learn what this means`.
4. User enters profile name and credential required by current build.
5. M0 password screen provides password-manager affordances; no arbitrary composition checklist beyond strength/length policy.
6. User chooses available unique username or skips until later if policy allows.
7. Client creates account, starts current device session, lands in Inbox.
8. Contextual tip points to `New conversation`; notification/contact permissions are not requested yet.

### Alternate/error paths

- Existing identifier: generic sign-in guidance without revealing account to an attacker.
- Weak/compromised password: local explanation, retain form safely.
- Offline: form may be completed but submission clearly waits; credential is never persisted to disk/log.
- Rate limited: human-readable retry window, support link, no infinite spinner.
- Terms/privacy: accessible before submit; acceptance version recorded.

### Accessibility

- Autofill/password manager semantics, no paste blocking.
- Error summary focused first, then field-level errors.
- Logo/motion decorative and ignored by screen reader; CTA focus not delayed.

### Success criteria

- Median completion < 45 sec excluding chosen credential creation.
- ≥ 90% test users can identify M0 non-E2EE status when asked.

## 4. Flow F02 — sign in and recovery

### Sign in

1. Enter username/verified identifier.
2. Choose passkey (target preferred) or password/allowed authenticator.
3. Risk event may require second factor; copy states why without exposing detection detail.
4. New-device screen lists platform and approximate region; user confirms notification/privacy defaults.
5. Inbox loads recent state; realtime head appears before full history bootstrap.

### Recovery

1. `Can’t sign in?` offers available recovery methods without confirming account existence prematurely.
2. High-impact recovery shows delay/consequences and notifies existing devices.
3. Recovery never asks support for password, OTP, passkey private key or backup recovery secret.
4. After recovery: review devices, revoke unknown sessions, rotate affected credentials.
5. If E2EE keys/history cannot be recovered, say `Your account is restored; some private history can’t be decrypted` rather than showing an empty unexplained inbox.

### Defensive UX

- Approval prompts include action, origin, device, location and `Deny` as equal visible action.
- Push approval alone is not sufficient for phishing-resistant claim.
- Repeated prompts are grouped as suspicious and can temporarily freeze linking.

## 5. Flow F03 — link another device by QR

### Preconditions

User is signed in on an existing trusted device; target device displays a Luxora-owned origin.

### Happy path

1. Target chooses `Link this device` and displays a short-lived QR plus human-readable rotating code.
2. Trusted device opens `You → Devices → Link device`; system camera permission is requested in context.
3. Scanner recognizes Luxora challenge and shows confirmation sheet: target platform/browser, origin/domain, approximate region, requested capabilities.
4. User performs local biometric/PIN confirmation.
5. Both devices show matching short confirmation words/code for high-risk mode; linking completes only once.
6. Device list updates immediately; all existing devices receive `New device linked` event.
7. Target bootstraps permitted history. Private history sharing follows explicit key/history policy.

### Reject/attack paths

- QR from chat/web page with wrong origin: `This QR can’t link a Luxora device`.
- Expired/used code: regenerate; never silently retry same challenge.
- User denies: challenge invalidated; target sees no account details.
- Unknown linking notification: one tap `Secure account` revokes target/session family and starts review.

### Design rule

Scanner never says «scan any QR to get Premium/gift». Luxora QR scanner is visibly scoped to a stated action.

## 6. Flow F04 — start a Direct / message request

### Initiator

1. Tap `New conversation`.
2. Search exact username, scan QR, open verified Luxora link or choose an existing accepted contact.
3. Result displays profile name, username, avatar, shared Spaces (computed with permission) and safety cue.
4. If relationship is new, header says `Message request`; composer explains recipient must accept.
5. First message has tighter text/link/media limits; send creates request.
6. Initiator sees `Request sent`; no presence/read status is exposed.

### Recipient

1. Requests appear in a dedicated quiet folder, not interleaved as normal chats by default.
2. Preview shows sender profile, shared Spaces, first safe text preview and `Accept`, `Delete`, `Block & report`.
3. Opening preview does not send read receipt.
4. Accept creates normal Direct and only then enables receipts/presence/calls per settings.
5. Delete removes local request and rate-limits resend according to policy.
6. Block prevents username changes from bypassing block because block attaches to account ID.

### Safety details

- External links are not active in collapsed request preview.
- Images/files require explicit reveal/download.
- Name collision/shared group are context, never verified identity.

## 7. Flow F05 — send, fail, reconnect and reconcile

### Happy path

1. Composer creates local draft continuously.
2. On send, client assigns idempotency key and inserts optimistic bubble.
3. Server acceptance replaces local identity with canonical ID without reordering/jump.
4. Realtime receipts update status; screen reader announces only material failure, not every check transition by default.
5. Draft clears only after local queue accepts the item, not before.

### Offline/retry

1. Offline send remains `Sending when online` with queued order.
2. User may edit/delete queued text; editing changes queued payload before first accepted send.
3. On reconnect, client authenticates with resume cursor and sends queue idempotently.
4. Gap triggers `Syncing recent changes`; server snapshot/events reconcile edit/delete/membership.
5. Retryable failure shows `Retry`; permanent rejection retains copy and exact actionable category.

### Conflict examples

- User removed while offline: message becomes `Not sent · You no longer have access`; offer copy/export, not retry loop.
- Same draft edited on two devices: keep both drafts or deterministic latest with `Other draft` recovery; never silently discard long text.
- Local clock wrong: canonical grouping/order follows server/protocol order; display time may include `Device time differs` diagnostic only when material.

## 8. Flow F06 — message actions

### Invocation

- Touch: long press opens anchored menu; swipe shortcuts mirror top menu actions.
- Pointer: hover affordance + context menu.
- Keyboard: focused message opens action menu shortcut; every action has accessible label.

### Reply/quote

1. Select `Reply`; composer shows compact target preview.
2. Tap preview jumps to original without losing draft.
3. Sent reply keeps stable reference and safe snapshot.
4. Deleted/inaccessible original becomes `Original message unavailable`.

### Edit

1. Own eligible message → `Edit` loads content into composer with `Editing` state.
2. Send includes expected revision.
3. Conflict sheet offers `Review latest`, `Keep my version as new message`, or retry merge where safe.
4. Bubble receives `edited`; revision history entry follows conversation policy.

### Delete

1. Menu offers only valid scopes: `Delete for me`, `Delete for everyone`.
2. Confirmation names number/type of selected items, scope and moderation/retention caveat.
3. Delete-for-everyone produces synchronized tombstone where required; current selection can be undone only if backend policy truly supports it.

### Reactions

- Quick palette for frequent reactions; `More` opens full accessible picker.
- Adding/removing is optimistic and idempotent.
- Count list respects privacy/space policy and updates without moving the message.

### Forward

- Destination chooser separates recent people, circles and spaces.
- Preview states whether attribution/source link survives and warns when forwarding from Private to Moderated.
- Hidden metadata, original private deep link and local filename path are removed.

## 9. Flow F07 — media, files and voice/video notes

### Attach

1. `+` opens compact semantic choices: Camera, Photos, File, Voice/Video note, Location/Contact only when supported.
2. Permission requested only after selecting a capability.
3. Preview shows filename/type/size, compression/original option, caption and audience/trust class.
4. EXIF/location removal is default; `Send original metadata` is explicit.
5. Upload is resumable with progress, pause/cancel; text message queue is not blocked by another large upload.

### Receiving

- Progressive placeholder preserves layout; download state and size visible.
- Unknown executable/archive never auto-opens.
- Request context requires explicit reveal.
- Failed/corrupt/decryption states are distinct and offer safe retry.

### Voice note

- Hold-to-record and lock-to-record; persistent recording state, elapsed time, waveform, cancel gesture with non-gesture button alternative.
- Preview before send is available.
- Playback speed and transcript are accessible; transcript processing boundary disclosed before first use.

### Video note

- Camera/mic state visible; 1-minute style constraints, if any, come from server capability.
- Reduced Motion disables ornamental looping autoplay.

## 10. Flow F08 — create and manage a Circle

1. `New → Circle`.
2. Choose accepted contacts; requests/blocked relations handled explicitly.
3. Set name/avatar; optional description.
4. Target: choose `Private` (recommended) or create a Moderated Space instead; a Circle is not silently converted.
5. Review members and default permissions; create.
6. System event announces creator/membership; first-screen tips show reply, pin, call without modal tutorial.
7. `Circle details` contains members, media, pins, notification, privacy, disappearing timer, leave/report.

### Membership changes

- Add/remove/promote actions show effective permission and target E2EE key/epoch update progress.
- Removed user disappears from future delivery immediately; if keys cannot rotate, sending pauses with an honest error.
- Ownership transfer requires step-up auth and explicit acceptance by new owner.

## 11. Flow F09 — create a Space

1. `New → Space` and choose intent: friends, organization, creator/community.
2. Choose immutable trust class:
   - `Private Space` — invitation-only; target E2EE, local content search.
   - `Moderated Space` — server search/moderation, can later apply for discovery.
3. Explain choice in two short cards with `Compare privacy` details.
4. Name, icon, description and default language.
5. Start from minimal templates: General discussion, Community, Announcements; preview exact initial channels.
6. Pick role template and owner recovery/2FA requirement.
7. Optional onboarding questions (≤ 5); safe defaults always available.
8. Review trust label, invite policy, retention, discovery eligibility; create.
9. Land in Space Overview/Guide, not an unexplained empty channel tree.

### Prevented patterns

- No 30-channel template.
- No public/discoverable toggle until safety eligibility passes.
- No permission change without effective-policy preview.

## 12. Flow F10 — join and onboard into a Space

1. Invite/deep link opens preview: name, verified public identity where applicable, member/activity summary, public rules, trust class, age/region notice.
2. User chooses `Join` or `Request to join`; account/session challenge if needed.
3. Before final join, Moderated disclosure states content processing; Private flow verifies invitation/key package.
4. User answers up to 5 intent questions; can skip with default channels.
5. Guide shows welcome, 1–3 first tasks and resource pages.
6. Personalized channel list opens with `Browse all channels` available.
7. First post may be rate/approval limited; UI shows state without shaming.

### Leave

- Leave sheet explains retained public posts, local data and rejoin consequences.
- Owner must transfer/delete responsibility first.
- Private leave triggers membership/key update; local decrypted cache follows retention choice/policy.

## 13. Flow F11 — channels, topics and comments

### Channel navigation

- Text channel opens chronological live stream.
- Announcement channel visually emphasizes author/publication and keeps composer restricted by permission.
- Topic/forum channel opens topic list with title, tags, author, activity and state, not a single fast chat.
- Voice channel shows present participants and `Join`, not an incoming-call screen.

### Create topic

1. CTA `New topic`.
2. Title, initial post, optional allowed tags.
3. Preview trust/visibility and notification behavior.
4. Publish; topic gets stable deep link and optional auto-close policy.

### Channel comments

1. Announcement post shows comment count.
2. Tap opens dedicated thread while retaining post context.
3. Comment permissions/slow mode/approval visible near composer.
4. Closing comments preserves readable history according to policy.

### Notification model

- Space default, per-channel override, per-topic follow.
- Mention/reply always identifies source context.
- A muted parent never silently enables child all-message notifications without confirmation.

## 14. Flow F12 — global and in-conversation search

### Global entry

1. Open Search via tab/field/keyboard shortcut.
2. Before query, show Recent (local/private where applicable), filters and clear scope label.
3. Results sections: People, Conversations, Messages, Files/Media, Public Spaces.
4. Query remains active while refining sender/date/type/space.
5. Result opens parent context and highlights target; Back returns to exact search state.

### Privacy scope

- M0: `Cloud search · Preview messages are server-readable`.
- Target Private: `On this device`; optional per-device index progress and `Search more devices` is not faked.
- Moderated: `Luxora Search`; indexing/retention policy available.
- Mixed query results visibly label scope; no shield suggests all results share one privacy model.

### Error/empty

- `No results here` differs from `Some private history isn’t on this device`, `Offline`, and `You no longer have access`.
- Search never reveals hit counts/snippets from inaccessible conversations.

## 15. Flow F13 — 1:1 and group calls

### Start 1:1

1. Conversation header → audio/video.
2. Permission requested in context; preflight lets user select mic/camera/output.
3. Outgoing state shows recipient/device reachability without leaking private presence.
4. Connected controls: mute, camera, speaker/output, add/participants, screen share, more, end.
5. Privacy details show negotiated encryption state and optional verification.

### Incoming

- Full/compact platform-native notification respecting Focus/Do Not Disturb.
- Answer audio/video, decline, message where supported.
- Unknown requests cannot ring before accept; silenced calls remain in call history as policy allows.

### Group/drop-in room

1. Join screen shows participants, host, trust class and whether lobby approval is required.
2. Pre-join mic/camera default safe; `Join` explicit.
3. Grid/focus adapts; active speaker never causes uncontrolled layout thrash.
4. Raise hand/reactions are keyboard/screen-reader accessible.
5. Join/leave updates roster and E2EE epoch; brief transition does not show false secure state.
6. Scheduled call can add to calendar only after permission/deep-link action.

### Screen sharing

1. Choose application/window/screen where platform permits.
2. Persistent system + in-app indicator, pause and stop.
3. Warning to hide sensitive notifications; no screenshot prevention claim.
4. Ending call always stops capture even on crash/reconnect path.

### Quality degradation

- `Network is unstable · reducing video quality` with audio prioritized.
- Reconnect retains local mute state and does not create duplicate participant.
- User can send diagnostics only via reviewed, redacted bundle.

## 16. Flow F14 — block, report and personal safety

### Block

1. Profile/conversation details → `Block`.
2. Sheet states consequences: messages/calls/requests/presence/profile updates.
3. Optional `Also delete conversation locally`; separate choice.
4. Block applies to account ID and syncs devices.
5. Unblock does not automatically accept a relationship or resend hidden messages.

### Report in Moderated Space

1. Select message/profile/space → reason taxonomy + optional note.
2. Show content/context included and whether admins or Luxora Safety receive it.
3. Submit; immediate personal actions (mute/block/leave) offered separately.
4. Status/appeal visible where legally/safely possible.

### Report in target Private conversation

1. Explicit selection of messages; no background history upload.
2. Preview exact plaintext, attachments, sender/profile fields and context that will leave E2EE boundary.
3. User can remove items; copy explains reports are encrypted to Safety and retained by policy.
4. Submit + block/mute choices.

### Emergency Space controls

- Moderator sees `Lockdown`: pause new joins, enable approval, slow mode, limit new accounts.
- High-impact bulk actions require step-up auth and audit reason.

## 17. Flow F15 — Privacy Checkup

1. Entry from `You → Privacy & Safety`; summary shows last review date and urgent device/security alerts.
2. Five human questions:
   - Who can find me?
   - Who can message me?
   - Who can call me?
   - Who can see my activity/profile?
   - How is my history stored and recovered?
3. Each screen shows current choice, recommended baseline and usability effect.
4. Device review is embedded: revoke unknown, name device, enable passkey/step-up.
5. Notification preview and backup status included.
6. Final summary lists changes; user can undo individual settings.

High-risk preset is a transparent bundle, not an unexplained «maximum security» button.

## 18. Flow F16 — encrypted backup and restore (target)

### Enable

1. `You → Data → Encrypted backup` shows what is included/excluded, refresh schedule, size/cost and provider visibility.
2. User creates recovery secret/key; device requires local auth.
3. User must save/confirm recovery key. Copy: `Luxora can’t recover this key or read your backup.`
4. First archive uploads with progress; only `Protected` after verification restore/check completes.
5. Settings show last successful backup and excluded disappearing/view-once rules.

### Restore

1. Authenticate account/device, then enter/scan recovery secret locally.
2. Download/verify/decrypt archive; wrong key error does not corrupt current state.
3. Restore shows partial/history/media progress; realtime new messages remain separate until merge reconciliation.
4. Rollback/modified archive fails integrity check and gives safe recovery options.

### Disable/lost key

- Disable states deletion timing and local impact.
- Lost recovery key cannot be bypassed by support; user may replace future backup after authenticating, but old archive remains unreadable/deleted by policy.

## 19. Flow F17 — notification permission and tuning

1. No OS prompt on first launch.
2. After first accepted conversation or explicit Settings action, an in-app card explains calls/messages/value and preview privacy.
3. `Enable notifications` triggers OS prompt; `Not now` is respected.
4. Per-chat sheet: All, Mentions/Replies, Mute duration, preview, sound where supported.
5. Global schedule integrates platform Focus rather than promising to override it.
6. Delivery failures/token expiry surface only when actionable.

## 20. Flow F18 — session/device compromise response

1. User receives `New device`/`Suspicious session activity` alert with time/platform/region.
2. `Review now` opens Devices with suspicious item emphasized, no auto-approval.
3. One action `Secure account`:
   - revoke selected/all other sessions;
   - rotate relevant refresh families;
   - review/change authenticators;
   - review linked recovery channels;
   - target E2EE: re-establish device/key state and show affected conversations.
4. Audit summary explains actions and any residual risk/history exposure.
5. Support path never asks for secrets.

## 21. Screen/state inventory by milestone

| Surface | M0 | M1/M2 | M3/GA |
| --- | --- | --- | --- |
| Welcome/register/login | Required + preview disclosure | Passkey/recovery polish | Risk/localization maturity |
| Inbox/conversation/composer | Required | Offline/media/pins/folders | Full actions/search/cross-platform parity |
| Requests | Basic gate required before open internet | Shared context/safety polish | Abuse intelligence/appeal |
| Devices | List/revoke required | QR-linking + per-device identity | Transparency/advanced response |
| Trust label | `Cloud preview` | Private pilot labels | Full Private/Moderated matrix |
| Spaces/channels/topics | Visual/protocol placeholders only if clearly marked | Internal beta | Required for community beta/GA |
| Calls | Marketing/demo may not imply working | 1:1 beta | Group/live/screen share gates |
| Search | Current Cloud only | Local Private index | Mixed scoped/public search |
| Privacy Checkup | Link to essential controls | Full guided flow | High-risk/metadata mode |
| Backup | No false protected state | Encrypted pilot | Restore/ops maturity |

## 22. Cross-platform interaction notes

### iPhone/Android phone

- One-handed primary actions; composer above keyboard; destructive actions away from send.
- Bottom navigation respects platform patterns; call sheet and permission flows native.

### iPad/tablets

- Two/three columns; keyboard shortcuts; drag-and-drop attachments with privacy preview.
- Resize/multitasking must not collapse call or lose draft.

### macOS/Windows/Linux

- Menu/command palette, resizable columns, multi-window/popout calls, tray/dock behavior.
- Right-click mirrors touch action priority; no hover-only essential action.

### Web

- Exact supported-browser matrix and feature detection.
- Secure session storage model; offline cache cleared on logout.
- Install prompt only after value, not on first page load.

## 23. Accessibility acceptance journeys

The following must complete with VoiceOver/TalkBack/screen reader + keyboard where applicable:

1. Register/sign in and understand Current Cloud disclosure.
2. Find exact username, send request, accept request.
3. Send, observe failure, retry and verify success.
4. Reply, react, edit and delete own message.
5. Review/revoke device.
6. Join a Space, answer/skip onboarding, find a topic.
7. Join/mute/leave a call and stop screen sharing.
8. Block/report with exact report-data preview.
9. Run Privacy Checkup and change notification preview.
10. Restore encrypted backup without exposing recovery key to accessibility logs/analytics.

At largest supported text size, core content/actions remain available; dense layouts may reflow from columns to stack. Animations communicate no unique state and obey Reduced Motion.

## 24. Canonical microcopy rules

- Prefer concrete actor/action: `Delivered to Alex’s devices`, not `Success`.
- Security: name who can access and why, not `military-grade`/`bank-level`.
- Failure: preserve work, state next action and avoid blame.
- Permission: explain immediate benefit before OS prompt.
- Destructive: state scope and reversibility in the button label.
- Avoid dark patterns: equal visual weight for `Not now`, no countdown pressure for privacy choices.
- `Private` is reserved for verified target E2EE state; M0 always says `Cloud preview`.

## 25. UX validation plan

- Moderated usability sessions for novice, heavy messenger, community moderator and high-risk profiles.
- Reference tasks measured for completion, time, error, comprehension and confidence.
- Poor-network lab: 3G/high RTT/loss, offline 10 min, connection flaps, clock skew, app kill.
- Accessibility audit on real devices and desktop screen readers.
- Glass/contrast/performance tests across light/dark, vivid media backgrounds and Reduce Transparency.
- Security comprehension: at least 85% correctly identify who can access content in each trust class; no more than 5% confuse M0 with E2EE.
