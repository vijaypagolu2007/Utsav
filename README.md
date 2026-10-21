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
| `src/app/api/scan-quote/route.ts` | `multipart/form-data`, base64 `dataUrl`, or `samplePresetId`; Gemini Vision with JSON output when a key is set |
| `src/export.ts` | Budget ledger CSV (RFC 4180) + print-styled day-of run sheet HTML |
| `src/persistence.ts` | `localStorage["genai_event_planner_v1"]`: active archetype + undo/redo history per archetype, Zod-revalidated on load |
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

## Phases 5–7 at a glance
- **Quote scanner:** 📸 upload / drag-drop or 📄 sample (Royal Deccan Caterers ₹4,80,000 · Neon Arcade Machines ₹65,000 · City Sound & Stage ₹1,45,000). The quote never raises the envelope: `quoted > planned` becomes an *Envelope breach* insight with the gap and the unlocked slack elsewhere that could cover it. Always Tier 1; red flags shown on the card before **Approve & Update Budget**.
- **Guest / Committee mode:** `applyBatch(state, batch, { role: "guest" })` only accepts `set_rsvp`, `set_guest_diet`, `claim_wishlist_item`, `community_signup`. Guests can't self-invite to sub-events or take a gift someone else claimed. The Gemini persona gets only guest tools and a money-free summary.
- **Persistence & export:** autosave to localStorage, ↺ Reset preset, ⬇ Export → CSV ledger / printable run sheet. Every canvas click (lock, task status, RSVP, wishlist, permits, sponsors, sign-ups) goes through the same reducer, so undo history and insights stay in sync.
