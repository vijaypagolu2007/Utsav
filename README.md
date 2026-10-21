# Utsav — GenAI Event Planning Co-Pilot & Live Reactive Canvas

Weddings, birthdays and community events on one split-screen canvas. Gemini **proposes**, a deterministic
reducer **computes**, and you **approve**. The LLM never does budget math or date arithmetic.

```
npm install
cp .env.example .env.local   # add GEMINI_API_KEY (optional — without it the app runs in Demo Mode)
npm run dev                  # http://localhost:3000
npm run verify               # demo-output check + 54 unit tests + typecheck + lint (0 warnings) + production build
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
| `src/app/api/chat/route.ts` | Gemini multi-step function-calling loop with automatic offline fallback |
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

## API

| Route | Body | Returns |
|---|---|---|
| `POST /api/chat` | `{ messages, state, today, role?, actingGuestId? }` | `{ reply, actions[], mode: "gemini" \| "offline" }` |
| `POST /api/scan-quote` | JSON `{ presetQuoteKey \| imageBase64+mimeType \| dataUrl, state, today }` or multipart `file` | `{ reply, actions[], mode, source, scanned }` |

Both routes fall back to the deterministic offline path when `GEMINI_API_KEY` is missing or Gemini errors.

## Testing
`npm run verify` runs, in order: the demo-output check against `src/tests/demo.baseline.txt`, 54 unit tests (`node --test`), `tsc --noEmit`, `eslint --max-warnings=0`, and `next build`.

### Live Gemini smoke test
With `GEMINI_API_KEY` in `.env.local`, `npm run smoke:gemini` calls the real routes and checks four things: an organizer prompt runs multi-step function calling into a Tier-1 batch, an over-cut gets a counter-offer, a guest budget change is refused, and Gemini Vision reads `samples/deccan-royal-caterers-quote.png` as ₹1,85,000.

## Deploy
Works on Vercel as is: import the repo and add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) as environment variables.

## Status
- ✅ Phases 1–8 complete; all checks green.
- ⏳ Live Gemini paths: run `npm run smoke:gemini` with a real key.
- ⏳ No browser E2E suite yet (UI verified through the build and API tests).
