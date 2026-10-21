# Utsav — GenAI Event Planning Co-Pilot & Live Reactive Canvas

Weddings, birthdays and community events on one split-screen canvas. Gemini **proposes**, a deterministic
reducer **computes**, and you **approve**. The LLM never does budget math or date arithmetic.

```
npm install
cp .env.example .env.local   # add GEMINI_API_KEY (optional — without it the app runs in Demo Mode)
npm run dev                  # http://localhost:3000
npm run verify               # demo-output check + 111 unit + API tests + typecheck + lint (0 warnings) + production build
```

## Architecture

| File | Role |
|---|---|
| `src/schema.ts` | Zod 4 `AgentState`; polymorphic `event.ext` (`wedding · birthday · community`), integer paise, minute-of-day times |
| `src/commands.ts` | Command union + pure reducer `applyBatch` (atomic). Largest-remainder (BigInt) allocator, slack-proportional cuts, weekday resolver, lane/phase invariants, **structured rejections** (`reason`, `failedCommandIndex`, `diagnostics`, verified `suggestion`) |
| `src/blueprint.ts` | `initialize_event_plan` cold start: LLM gives **weights** and **day offsets**; the tool allocates `totalBudgetPaise` exactly and resolves every date |
| `src/insights.ts` | `computePlanInsights(plan, today)`: overdue deposits, envelope breaches, urgent tasks (≤14 d), permits / wishlist / RSVP alerts |
| `src/diff.ts` | Before → After diff (budget, dates, cascaded task due dates, blocks, RSVPs…) for approval cards + highlight pulse |
| `src/trust.ts` | Deterministic tiers: 0 auto-apply · 1 approve (≥ ₹25,000, date moves, payments) · 2 outbound draft |
| `src/agent.ts` | One tool executor shared by Gemini and the offline brain; dry-runs, never mutates the live plan |
| `src/gemini-tools.ts` | Function declarations generated from Zod (`z.toJSONSchema` → Gemini-safe subset) + live-state system prompt |
| `src/offline.ts` | Demo Mode: deterministic parser + blueprint templates for the flagship prompts (works with no Wi-Fi, also runs in-browser) |
| `src/copilot-actions.tsx` | CopilotKit alternative wiring: same reducer, Tier 1 via `renderAndWaitForResponse` |
| `src/quote-scanner.ts` | Vendor quote / contract scanner: 3 built-in sample documents, deterministic text parser, Gemini Vision extraction schema (rupees → paise in code), `scanToActions` → one Tier-1 `upsert_vendor_quote` card with red flags |
| `src/app/api/scan-quote/route.ts` | `multipart/form-data`, JSON `imageBase64`+`mimeType` (or `dataUrl`), or `presetQuoteKey` (`wedding · birthday · community` or a sample id); Gemini Vision with JSON output when a key is set; returns the chat shape (`reply`, `actions`, `mode`) |
| `src/export.ts` | `budgetToCsv` (RFC 4180: `ID,Category,Item,SubEvent,PlannedINR,QuotedINR,CommittedINR,PaidINR,CuttableSlackINR,Locked,Vendor` + TOTAL) and `runSheetToHtml` (print-styled day-of run sheet) |
| `src/persistence.ts` | `localStorage["genai_event_planner_v1"]`: active archetype, planning date and undo/redo history per archetype, Zod-revalidated on load |
| `src/components/GuestMicrosite.tsx` | Guest / Committee view: hero, live itinerary, self-service RSVP + diets, wishlist claims, volunteer & sponsor sign-up |
| `src/presets.ts` | Royal Wedding ₹25L · 30th Arcade Birthday ₹1.5L · Community Cultural Fest ₹5L |
| `src/app/api/chat/route.ts` | Thin route → `src/server/chat-handler.ts`: Zod-validated request, bounded multi-step function calling, classified provider failures with labelled offline fallback |
| `src/server/gemini-client.ts` | The only module that touches the Gemini SDK; injectable `GenerateFn` (mocked in tests), timeouts, error classification |
| `src/server/scan-handler.ts` | Quote upload validation (size caps, magic-byte sniffing, strict base64), Vision call, `rupeesToPaise` checks |
| `src/server/events.ts` · `store.ts` | Shared guest links: organizer token (hashed), household invite tokens, public projection, optimistic concurrency; Upstash Redis REST / local file / memory stores |
| `src/guest-view.ts` · `src/sync.ts` | Allowlisted public projection; organizer-side rebase of guest-owned fields after a version conflict |
| `src/app/guest/[eventId]` · `PublicGuestPage.tsx` | Shared guest page (works on any device) |
| `src/components/*` | Command bar (KPIs, undo/redo scrubber, red flags, time-travel date), budget ledger, lane timeline, derived-date task queue, archetype module, chat with diff/approval/draft cards |

## Judge demo prompts (chips in the sidebar)
1. *Cut ₹20k from decor and move the Haldi to Friday* → ₹10,000 off Haldi decor and Sangeet stage (Mandap locked, Mehendi fully committed), Haldi Thu→Fri, 2 task due dates cascade. Tier 1 diff card.
2. *Cut ₹1.5L from decor* → rolled back: only ₹1,00,000 unlocked slack. Counter-offer card for ₹1,00,000.
3. *Move the Haldi to Monday* → rejected (pre-event after the Muhurtham); valid dates listed; counter-offer Sat.
4. *Which vendor deposits are overdue and what tasks are urgent?* → insights card.
5. *Switch to a 30th Retro Arcade Birthday for ₹1.5L* → cold-start blueprint, exact to the paisa, birthday `ext`.

`src/demo.ts` is unchanged and its output is byte-identical to the original core.

## Features

### 1. Deterministic planning core
- Money is integer paise end to end; splits use BigInt largest-remainder, so totals are exact to the paisa.
- Cuts are proportional to *unlocked slack above committed*. Locked lines are never cut, but a top-up on a fully locked category still lands on its largest line.
- Tasks carry `dueOffsetDays` relative to their sub-event, so moving a sub-event cascades every due date. Timeline blocks are minute-of-day and `anchored` ones (muhurtham, cake cutting) never shift.
- `applyBatch` is atomic: one bad command rolls back the whole batch and returns `reason`, `diagnostics` and a verified counter-offer.

### 2. Three-tier trust model
| Tier | When | UI |
|---|---|---|
| 0 | small, reversible edits | auto-applied |
| 1 | ≥ ₹25,000, date moves, payments, every vendor quote | Before → After diff card, *Approve* |
| 2 | outbound messages | editable draft (mailto / WhatsApp), never auto-sent |

### 3. Vendor quote & contract scanner
- 📄 *Try Sample Contract* (one per archetype) or 📸 upload / drag-drop an image, PDF or .txt.
- Samples: **Deccan Royal Caterers** → Sangeet dinner ₹1,85,000 (₹35,000 over, ₹50,000 deposit due 2026-10-25) · **Bandra Arcade Rentals** → arcade rental ₹26,000 (₹6,000 over) · **Telangana Pro Audio & Truss** → stage & truss ₹1,45,000 (₹25,000 over).
- `upsert_vendor_quote` matches by `budgetItemId`, label or vendor (otherwise a new line at ₹0 planned), upserts the vendor, adds or updates the deposit and stores contract red flags. It **never raises `planned`**: the breach becomes a log line (`⚠ Quote exceeds planned envelope by ₹…`) and an insight listing unlocked slack elsewhere that could cover it.
- Gemini Vision returns amounts in rupees; conversion to paise happens in code.

### 4. 🛠️ Organizer / 🎟️ Guest View
- Guest View swaps the canvas for a microsite: itinerary with venues, times and dress codes; self-service RSVP and dietary needs; birthday wishlist claims; community volunteer and sponsor sign-up.
- Enforced in the reducer, not the UI: `applyBatch(state, batch, { role: "guest" })` accepts only `set_rsvp`, `set_guest_diet`, `claim_wishlist_item`, `community_signup`. Anything else returns *"Guest Concierge Mode is read-only for budgets and schedules…"*. Guests can't self-invite to sub-events or take a gift someone else claimed.
- A separate Gemini persona sees only guest tools and a money-free summary. Offline, the concierge answers schedule, dress-code and venue questions, RSVPs by name or household, and lists unclaimed wishes.

### 5. Persistence & export
- Autosave to localStorage, undo/redo + history scrubber, ↺ Reset to the clean preset.
- ⬇ Export CSV and 🖨️ Print Run-Sheet in the command bar.

### 6. Shareable guest links (cross-device)
- Organizer clicks **Guest links → Publish**. The server stores a copy of the plan and returns one **public itinerary link** and one **RSVP link per household**: `/guest/<eventId>#k=<household token>`.
- Guests on any device see only a projection built from an allowlist (`src/guest-view.ts`): title, hosts, city, dates, sub-events with venue / time / dress code, anchored moments, *their own household's* RSVPs and diets, wishlist items (claimed or not), community sign-up. Never budgets, quotes, payments, vendors, tasks, sponsors, permits, phone numbers, invite codes or other guests.
- The organizer's canvas keeps syncing: every change (debounced) and every 20 s it pulls the server copy, three-way merges guest-owned fields back in (against the last synced copy, so the organizer's own edits to those fields are never overwritten) (shown as a *Synced guest responses* history entry) and pushes with `baseVersion`.

### 7. Sub-event visibility (public vs private)
- Every sub-event has `visibility: "public" | "private"`. The organizer flips it with the **Public / Private** button on each row of the timeline, or by asking the co-pilot (`set_sub_event_visibility`). An agent proposal to make something public is Tier 1 (needs approval); hiding is Tier 0.
- **The server enforces it** in `toGuestView` (`src/guest-view.ts` + `src/visibility.ts`). The public link (no token) gets public sub-events only. A household link also gets the private sub-events that someone in that household is invited to. Private sub-events never enter the API payload: not their id, name, venue, or anchored moments. Hiding them in React alone wouldn't be enough.
- **Visibility never grants RSVP.** A guest can still RSVP only to sub-events they're invited to (the reducer checks `guest.rsvp`). If a guest names a private sub-event they can't see, they get `400 unknown_sub_event` with no name in the message, so the endpoint can't be used to probe for one.
- **Guests can't change visibility.** It isn't in the guest-action allowlist (HTTP 400), and the reducer refuses it for the guest role too.
- **Defaults and existing data.** New sub-events, including those created by `initialize_event_plan`, default to **private** unless the organizer explicitly asks for public. Plans saved before this field existed (localStorage, or a shared-event record on the server) load through Zod with every sub-event defaulted to **private**. Nothing is deleted: the organizer still sees everything. The public link shows an "itinerary not published yet" notice until something is marked public, and the Guest links dialog shows how many sub-events are public. This fails closed on purpose. The demo presets set visibility explicitly (for example, Haldi and Mehendi are private, and Sangeet, Muhurtham and Reception are public).
- Visibility is organizer-owned, so the three-way sync merge always keeps the organizer's value.

## API

| Route | Auth | Body | Returns |
|---|---|---|---|
| `POST /api/chat` | none (stateless; nothing is persisted) | `{ messages ≤40 (≤4000 chars), state, today?, role?, actingGuestId?, forceOffline? }` ≤ 512 KB | `{ reply, actions[], mode, warning?, fallbackReason?, truncated? }` |
| `POST /api/scan-quote` | none (stateless) | JSON `{ presetQuoteKey \| imageBase64+mimeType \| dataUrl, state, today? }` or multipart `file` (≤ 3 MB) | `{ reply, actions[], mode, source, scanned, detectedType? }` |
| `POST /api/events` | none, rate-limited | `{ plan }` | `201 { eventId, organizerToken, version, invites[] }` (token shown once) |
| `GET /api/events/:id` | `Authorization: Bearer <organizerToken>` | | `{ version, plan, invites[] }` |
| `PUT /api/events/:id` | organizer bearer | `{ plan, baseVersion }` | `200 { version }` or `409 { current }` |
| `GET /api/events/:id/public` | optional `X-Guest-Token` | | public projection |
| `POST /api/events/:id/guest` | `X-Guest-Token` (sign-ups work without) | `{ commands ≤10 }`, only `set_rsvp`, `set_guest_diet`, `claim_wishlist_item`, `community_signup` | `{ log, view }` |

**Error contract.** Every error is JSON `{ error: <code>, message }` with `Cache-Control: no-store`: `400` invalid input · `401` missing/invalid token · `403` out of scope · `404` unknown or expired link · `409` version conflict · `413` too large · `415` unsupported or mismatched file · `422` rejected by the reducer or an implausible quote · `429` rate limited · `502/504` AI reader failed or timed out (scan) · `503` shared storage not configured · `500` internal (details only in server logs).

**Chat fallback rules.** `mode: "gemini"` only when the Gemini loop actually finished. No key → `mode: "offline", fallbackReason: "no_api_key"`. Provider auth / model / rate-limit / outage / timeout / malformed output → the deterministic offline brain answers, labelled with `fallbackReason` and a warning (safe because it uses the same reducer). Bugs in our own code are **not** disguised: they return `500`.

## Security boundaries

| Boundary | How it's enforced |
|---|---|
| LLM vs. money and dates | Gemini only proposes tool calls. Every argument is parsed by Zod and dry-run through `applyBatch`; vision amounts go through `rupeesToPaise` (finite, ≥ 0, ≤ ₹100 Cr, ≤ 2 decimals); dates are computed in code. Nothing the model returns is committed without the reducer, and Tier 1 still needs the organizer's click. |
| Gemini key | Read only from server env in route files; never `NEXT_PUBLIC_*`; redacted from logs; a unit test fails if any `"use client"` file imports `src/server` or names a secret. |
| Organizer | 256-bit organizer token, returned once, stored only as SHA-256 on the server and in the organizer's localStorage; sent as a bearer header (no cookies → no CSRF). It is a capability, not an identity: whoever holds it can edit. |
| Guests | 256-bit per-household token in the URL **fragment** (never sent in requests, logs or Referer). Server checks: allowlisted ops, strict schemas (no extra fields → no mass assignment), every `guestId` must belong to the token's household (no IDOR / impersonation), reducer rules (no self-invites, no stealing claimed gifts, no releasing claims). |
| Abuse | Fixed-window rate limits in the store: publish 10/h per IP, public reads 120/min per IP, guest writes 30/min per IP per event, organizer writes 120/min per event. Body caps on every route. |
| Concurrency | Every write is a compare-and-set on `version` (Upstash: Lua `EVAL`). Guest writes retry on a fresh copy and re-validate; organizer saves get `409` with the current copy and rebase guest-owned fields explicitly. |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`, Permissions-Policy; `/guest/*` is `noindex` and uncached; all API responses `no-store`. |

**Remaining risks.** No user accounts: losing the organizer token (clearing site data) means losing edit access to the shared copy (the local plan is unaffected; publish again). Anyone who receives a household link can respond for that household. Rate limits are per IP (shared NATs share a budget). A strict nonce-based CSP is not enabled yet. `/api/chat` and `/api/scan-quote` are unauthenticated and spend your Gemini quota; add Vercel's firewall rate limiting or a key in front of them before a public launch.

## Environment variables

| Variable | Required | Where | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | optional | server | Enables Gemini chat and Vision. Without it: Demo Mode. |
| `UTSAV_DISABLE_GEMINI` | test only | server | `1` forces Demo Mode even if `.env.local` has a key. Playwright sets it so E2E never calls the real provider. |
| `GEMINI_MODEL` | optional | server | Default `gemini-3.5-flash-lite` (free tier 15 RPM / 500 RPD). Set it to use another model. |
| `GEMINI_FALLBACK_MODELS` | optional | server | Comma-separated models tried when the primary is busy, e.g. `gemini-3.1-flash-lite`. No fallback by default. |
| `GEMINI_THINKING_LEVEL` | optional | server | `MINIMAL`, `LOW` (default), `MEDIUM`, `HIGH`, or `default` to let the model decide. Lower is faster. |
| `GEMINI_TIMEOUT_MS` | optional | server | Per-call timeout. Chat 30 s by default (max 45 s), scan 40 s (max 55 s), inside the routes' 60 s limit. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | for guest links in production | server | Shared storage. `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel Marketplace names) also work. |
| `UTSAV_STORE` | optional | server | `file` forces the local JSON store (dev/E2E). Default in `next dev`. Refused on Vercel. |
| `UTSAV_DATA_DIR` | optional | server | Folder for the file store (default `.data/`, git-ignored). |

`.env.local` is git-ignored; `.env.example` holds placeholders only.

## Testing

| Command | What it runs |
|---|---|
| `npm test` | Node test runner: engine tests (`src/tests/engine.test.ts`) + API/security/concurrency tests with mocked Gemini and an in-memory store (`src/tests/server.test.ts`) |
| `npm run demo:check` | `src/demo.ts` output vs. `src/tests/demo.baseline.txt` (byte-identical) |
| `npm run typecheck` · `npm run lint` · `npm run build` | `tsc --noEmit` · `eslint --max-warnings=0` · `next build` |
| `npm run verify` | all of the above, in that order |
| `npm run e2e:install` then `npm run test:e2e` | Playwright smoke suite (`e2e/smoke.spec.ts`) against a production build with no Gemini key and the file store |
| `npm run smoke:gemini` | Live check with your real key (see below) |

### Live Gemini smoke test
With `GEMINI_API_KEY` in `.env.local`, `npm run smoke:gemini` pings Gemini directly, then calls the real routes: an organizer prompt runs multi-step function calling into a Tier-1 batch, an over-cut gets a counter-offer, a guest budget change is refused, and Gemini Vision reads `samples/deccan-royal-caterers-quote.png` as ₹1,85,000. It also checks that the scan stays a Tier-1 proposal with integer paise, and that a rejected key falls back safely without echoing it. Exit code 0 means PASS, 1 means FAIL, and 2 means BLOCKED (key, quota, or provider down). A BLOCKED run is not a pass. Checks are spaced 13 s apart (`SMOKE_GAP_MS`) to stay under the free tier's ~5 requests a minute; a check that falls back because of a rate limit, overload or timeout counts as BLOCKED rather than FAIL. One run uses about eight Gemini requests.

## Deploy (Vercel)
1. **Storage:** Vercel → Storage → Marketplace → *Upstash for Redis* → create a database and connect it to the project (this adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`). No schema or migrations: each event is one Redis hash `utsav:event:<id>` with a 180-day TTL refreshed on every write; rate-limit counters are `utsav:rl:*` keys that expire on their own.
2. **Env:** add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) for Production and Preview. Never as `NEXT_PUBLIC_*`.
3. **Deploy:** import the repo; framework preset Next.js; build command `npm run build`. No `vercel.json` is needed. API routes run on the Node.js runtime with `maxDuration = 60` for chat and scan (the Hobby plan caps lower; that's fine, timeouts fall back cleanly).
4. **Verify on the deployed URL:** send *Which vendor deposits are overdue?* and check the badge says **Gemini** (not *Offline*); click *Scan sample quote*, then upload `samples/deccan-royal-caterers-quote.png` and check the red flags say *read by Gemini Vision*; click **Guest links → Publish**, open a household link in a private window on another device, RSVP, then **Sync now** on the organizer and check the RSVP KPI.
5. **Rollback:** Vercel → Deployments → *Promote* the previous deployment. Stored events are forward-compatible JSON validated with Zod on every read; a record that fails validation is treated as missing (404), never served half-parsed.

Upload limits: files ≤ 3 MB (Vercel's ~4.5 MB request cap minus base64 overhead).

## 3-minute demo script

| Time | Do | Point out |
|---|---|---|
| 0:00–0:20 | Open the Royal Wedding canvas. | Gemini proposes, a deterministic reducer computes in integer paise, the organizer approves. The badge shows Gemini or Offline honestly. |
| 0:20–0:55 | Send *Cut ₹20k from decor and move the Haldi to Friday*. | Tier-1 diff: Haldi decor and Sangeet stage cut proportionally to unlocked slack (Mandap is locked), Haldi Thu→Fri, task due dates cascade. Click **Approve & Commit**; Planned drops by exactly ₹20,000. |
| 0:55–1:20 | Send *Cut ₹1.5L from decor*. | Whole batch rolled back, plan unchanged, diagnostics show only ₹1,00,000 is cuttable, and a verified counter-offer card is ready to approve. |
| 1:20–1:55 | Click **Scan sample quote** (or upload `samples/deccan-royal-caterers-quote.png` with a key). | ₹1,85,000 vs ₹1,50,000 planned: ₹35,000 over, deposit ₹50,000 due 2026-10-25, three red flags, **Approve & Update Budget**. The envelope is never raised silently. |
| 1:55–2:25 | **Guest links → Publish**, open the Rao family link in a private window. | Public itinerary, venues, dress codes, RSVP buttons only for that household; no ₹ anywhere. Try a budget change via the API → `400`. RSVP *maybe*, then **Sync now** on the organizer. |
| 2:25–2:45 | **⬇ Export CSV**, **🖨️ Print Run-Sheet**. | RFC 4180 ledger with totals; printable timeline with ⚓ anchored moments. |
| 2:45–3:00 | Wrap up. | Gemini function calling + Vision with offline fallback; Zod at every boundary; reducer as the single source of truth; server-enforced guest permissions; optimistic concurrency. |

Manual setup for the demo: shared storage (Upstash on Vercel, or nothing locally since `next dev` uses the file store) for the guest-link step; a Gemini key only if you want to show live Gemini instead of Demo Mode.

**Screenshots / GIF:** none are committed. To capture: `npm run dev`, set the browser to 1600×1000, run the script above, and record with your OS recorder (Win+G on Windows, ⌘⇧5 on macOS) or `npx playwright test --headed --trace on` and export frames from the trace viewer.

## Known limitations
- No user accounts; organizer access to a shared event is a bearer capability stored in one browser.
- The local canvas is the organizer's working copy (localStorage); the server copy is for guests and other devices. Opening the organizer view on a second device isn't supported yet (it would need an "import with organizer token" screen).
- Guest Concierge chat runs on the organizer's canvas preview only; shared guest pages use buttons and forms, not chat.
- PDFs are passed to Gemini as-is and are never parsed on the server.

## Status
- ✅ Verified here: `npm run verify` (demo baseline, unit + API + security + concurrency tests, typecheck, lint, production build) and manual HTTP checks against `next start` with the file store.
- ⏳ Needs your environment: Playwright suite (no browser could be installed in the build sandbox), live Gemini chat / Vision (`npm run smoke:gemini`), Upstash-backed guest links and a deployed URL.
