# Utsav: technical reference

The full reference behind the [README](../README.md): architecture, features, configuration, API, security, testing, accessibility and deployment.

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
| `src/persistence.ts` | `localStorage["genai_event_planner_v1"]`: active template, planning date and undo/redo history per template slot, Zod-revalidated on load |
| `src/components/GuestMicrosite.tsx` | Guest / Committee view: hero, live itinerary, self-service RSVP + diets, wishlist claims, volunteer & sponsor sign-up |
| `src/presets.ts` | Seed plans for the built-in templates: Royal Wedding ₹25L · 30th Arcade Birthday ₹1.5L · Community Cultural Fest ₹5L |
| `src/config/*` · `src/kpis.ts` | Configuration layer: event templates, option lists, demo prompts, KPI definitions (see [Configuration](#configuration)) |
| `src/app/api/chat/route.ts` | Thin route → `src/server/chat-handler.ts`: Zod-validated request, bounded multi-step function calling, classified provider failures with labelled offline fallback |
| `src/server/gemini-client.ts` | The only module that touches the Gemini SDK; injectable `GenerateFn` (mocked in tests), timeouts, error classification |
| `src/server/scan-handler.ts` | Quote upload validation (size caps, magic-byte sniffing, strict base64), Vision call, `rupeesToPaise` checks |
| `src/server/events.ts` · `store.ts` | Shared guest links: organizer token (hashed), household invite tokens, public projection, optimistic concurrency; Upstash Redis REST / local file / memory stores |
| `src/guest-view.ts` · `src/sync.ts` | Allowlisted public projection; organizer-side rebase of guest-owned fields after a version conflict |
| `src/app/guest/[eventId]` · `PublicGuestPage.tsx` | Shared guest page (works on any device) |
| `src/components/*` | Command bar (KPIs, undo/redo scrubber, red flags, time-travel date), budget ledger, lane timeline, derived-date task queue, archetype module, chat with diff/approval/draft cards |
| `CopilotDrawer.tsx` · `src/budget-a11y.ts` | Header-docked launcher + modal drawer around the chat; screen-reader values for the budget meters and sponsor progress bars |
| `src/app/(planner)/*` · `src/routes.ts` | The organizer pages: `/` Overview, `/budget`, `/tasks`, `/schedule`, `/event` (`/guests` redirects there). One layout renders `ClientRoot` → `PlannerApp` around every page, so the plan state, undo history, Co-Pilot drawer, share dialog, theme and toasts survive client navigation. `routes.ts` maps red flags and diff rows to their page |
| `PlannerApp.tsx` · `planner-context.ts` · `PlannerPages.tsx` | The shell (state, persistence, chat, drawer, toasts, focus on navigation) and the five page views, which read the plan through `usePlanner()` |
| `CommandBar.tsx` · `Overview.tsx` · `PageNav.tsx` · `ui.tsx` | Header (event switcher, Organizer/Guest toggle, red flags, undo/redo, Guest links, an APG "More" menu, and the page tabs from 768px), KPI strip and "Needs attention" panel, the mobile bottom tab bar, and the shared `Card` / `SectionHeader` / `Chip` / `IconButton` / `InlineEdit` pieces |
| `src/server/cloud-handler.ts` · `cloud-repo.ts` · `firebase-token.ts` · `cloud-route.ts` · `src/app/api/cloud/plans/*` | Optional signed-in cloud save (v7, keyless): Firebase ID-token check with `jose` against Google's public keys, Zod-validated plans, server-assigned versions with compare-and-set, Firestore `users/{uid}/plans/{planKey}` through the Firestore REST API with the user's own token (no service account, no server secret) |
| `src/cloud-sync.ts` · `src/cloud-config.ts` · `components/cloud-auth.ts` · `useCloudSync.ts` · `AccountMenu.tsx` | Client side of cloud save: pure sync decisions, the lazily loaded Firebase Auth wrapper (Google popup, auth only), the autosave hook, the header account control and the "Which version should we keep?" dialog |
| `src/theme.ts` · `ThemeSelect.tsx` | Light / Dark / System theme: `localStorage["utsav_theme_v1"]` (separate from the plan), inline no-flash script in `layout.tsx`, `data-theme` on `<html>`; the dark tokens are in `globals.css` |

## Demo prompts (the "Try asking" chips in the AI Co-Pilot drawer)
The chips are filtered by event type: the ones that name the Haldi exist only for weddings, and birthday and community plans get the same scenarios with their own sub-events. A message never switches templates or resets a plan.

1. *Cut ₹20k from decor and move the Haldi to Friday* → ₹10,000 off Haldi decor and Sangeet stage (Mandap locked, Mehendi fully committed), Haldi Thu→Fri, 2 task due dates cascade. Tier 1 diff card.
2. *Cut ₹1.5L from decor* → rolled back: only ₹1,00,000 unlocked slack. Counter-offer card for ₹1,00,000.
3. *Move the Haldi to Monday* → rejected (pre-event after the Muhurtham); valid dates listed; counter-offer Sat.
4. *Which vendor deposits are overdue and what tasks are urgent?* → insights card.
5. *Switch to a 30th Retro Arcade Birthday for ₹1.5L* → cold-start blueprint, exact to the paisa, birthday `ext`.

6. *Give me ideas for decor, food and return gifts* → idea cards on the Ideas page (Live AI or the curated Demo Mode bank).
7. *Rebalance to my total* → a Tier 1 card spreading the headroom over unlocked lines.
8. *Our budget dropped by ₹50,000 and the event is 2 weeks earlier* (v6 stress test) → ONE Tier 1 card: total ₹25,00,000 → ₹24,50,000, every date 14 days earlier (2 tasks now overdue), and the ₹30,000 overrun cut from Decor and Misc (cut first) to keep Catering and Venue (must protect) intact. Works offline.

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

### 8. Inline editing (organizer)
- Click the pencil next to a value to edit it in place: the event name and the couple (weddings), budget line names, each line's planned amount, each category's planned total, vendor names, task titles, sub-event names and start times, guest names and household names. Enter saves, Escape cancels, focus returns to the pencil; a parsing or reducer error stays under the field (`aria-describedby`).
- Every edit is a command through `applyBatch`, so it lands in undo/redo, autosave and the shared-link sync like any other change. Amounts are typed in whole rupees and converted to integer paise in code (max ₹100 crore).
- New direct-edit ops (organizer UI only): `rename_event`, `set_partner_names`, `rename_entity` (budget line, task, sub-event, guest, household, vendor) and `set_planned_amount`. They are never declared to Gemini and the reducer refuses them unless the batch comes from the UI (`applyBatch(state, batch, { source: "ui" })`), and the guest role and the guest HTTP endpoint refuse them. Renames are Tier 0; `set_planned_amount` follows the adjust_budget rule (Tier 1 at ≥ ₹25,000 of change, measured against the `expectedPaise` the editor saw, which must still be current). A planned amount can't go below what is committed, and a locked line can be raised but not lowered. Renaming a sub-event keeps its slug, so links, RSVPs and prompts still find it.
- The category total reuses `adjust_budget` with the difference (a raise lands on the largest unlocked line, a cut is spread over unlocked slack); sub-event start times reuse `move_sub_event` on the same date (duration kept, unanchored blocks move with it). Committed amounts and task due offsets have no op and stay read-only.

### 9. Pages
| Route | Page | What is on it |
|---|---|---|
| `/` | Overview | Event name and couple (editable), KPIs, Needs attention (each "Show me" opens the owning page at `#ref-<id>`, highlights and focuses the row), and summary cards for Budget, Tasks, Schedule and Event, each with a "View …" link |
| `/budget` | Budget | Smart Budget Ledger: quote scanner, categories (vendors beside them from 1280px), lock, planned edits, payments |
| `/tasks` | Tasks | Derived-date task queue, status groups as columns on wide screens |
| `/schedule` | Schedule | Sub-events with lane timelines (agenda below 768px), start-time and name edits, public/private toggle |
| `/event` | Event | The event-type card: RSVP matrix (household cards when narrow), diet counts, couple; wishlist and activities; sponsors and permits |
| `/ideas` | Ideas | Personalised idea board: get more ideas, filter by kind, save, dismiss, add to plan |
| `/setup` | New plan | The setup form (not in the tab bar; More → New plan) |

Each page has its own `<title>` ("Budget · Utsav Co-Pilot") and one h1; client navigation moves focus to the h1 and Next's route announcer reads the new title. Tabs sit in the header from 768px and a bottom tab bar below, both with `aria-current="page"`. When the Co-Pilot (or undo, or a guest sync) changes a page other than the one on screen, the drawer and the toast link to it. Guest View replaces the page and hides the navigation on any route. Deep links such as `/budget#ref-b1` work on a fresh load.

### 10. First-run setup and your own budget
- A new browser (no saved plans) opens on a welcome screen: **Plan my event** or **Explore a sample**. Anyone with saved plans goes straight to them. Later, **More → New plan** (`/setup`) opens the same form.
- Step 1: event type, tradition or kind of party/event, names, city, first and last day, guests, total budget and an optional "anything special" note. Step 2: the categories for that type and style, each with a toggle, our suggested share as a grey hint, an amount (₹ or %) and **Already booked**. A live summary shows what you have set and what is left.
- `POST /api/plan`: Gemini drafts sub-events, tasks and the run-of-show with `initialize_event_plan`; then `initializeEventPlan(draft, { setup })` enforces your answers in code: basics from the form, sub-events kept inside your dates, excluded categories dropped, typed amounts kept exactly, booked lines committed and locked, and only blank categories filled from the remainder (largest remainder, whole rupees first, then any odd paise). Without a key, or if the draft can't be made to fit, a deterministic blueprint per tradition does the same (`src/setup.ts`): Haldi/Mehendi/Sangeet/Muhurtham only for Hindu weddings; Nikah and Walima, church ceremony, Anand Karaj or registration otherwise; a kid's party at home has no venue, bar or cabs; a Ganesh pandal runs sthapana, daily aarti and visarjan.
- On `/budget`: an editable total, **Add category or line**, **Remove** (only for lines with nothing committed or paid, after a confirm; Undo brings it back) and **Rebalance to my total** (previewed as an approval card).

### 11. Personalised ideas (`/ideas`)
- Idea cards (theme, decor, menu, activity, return gift, invite text, music, photo) with a cost range, the budget category it would come from and tags. Gemini's `suggest_ideas` tool proposes them from the event type, city, traditions, age, guest count, diets, the note and the money left per category; code converts rupees to paise, drops duplicates and ideas above the whole budget, and flags ones above their category's headroom. Offline, a curated Indian idea bank does the same deterministically. Each card says **Live AI** or **Demo**.
- **Get more ideas** (with an optional focus such as "eco-friendly", "under ₹50k", "Telangana style"), filter by kind, **Save**, **Dismiss** and **Add to plan**, which previews `adopt_idea` (a task and a budget line at the low estimate) as a Tier 1 card. Ask in chat too ("give me sangeet ideas"). Ideas live in the organizer's plan only: never in the guest projection, the guest prompt or Guest View.

| New command | Who | Tier |
|---|---|---|
| `add_budget_item` | organizer (UI and AI) | 0, or 1 at ₹25,000+ |
| `remove_budget_item` | organizer (UI and AI); refused with anything committed or paid | 1 |
| `set_event_basics` (total, guests, city, dates; a date change shifts every sub-event by whole days) | organizer (UI and AI); total can't go below committed | 1 |
| `rebalance_budget` | organizer (UI and AI); stale previews are refused | 1 |
| `add_ideas` | built by code from `suggest_ideas` (not declared to the LLM) | 0 |
| `save_idea`, `dismiss_idea` | organizer UI only | 0 |
| `adopt_idea` | organizer (UI and AI) | 1 |

Guests can run none of them.

### 12. Priorities and trade-offs (v6)
- **What matters most.** The plan carries a ranked list of must-protect and cut-first budget categories (everything else is flexible) and an experience level (simple / balanced / premium). Collected in setup's "What matters most" step and editable on `/budget`; saved with `set_priorities` (Tier 0). Legacy plans parse with a default (no priorities, balanced).
- **Trade-offs, not uniform cuts** (`src/priorities.ts`, code only). A shortfall is taken in stages: cut-first categories down to a depth set by the level (100% / 75% / 50% of their unlocked, uncommitted slack), then flexible categories, then the rest of cut-first. Must-protect categories are never cut by a fix (rebalance may touch them only as a last resort, because it must land on the total exactly). Each category's share becomes one `adjust_budget`, so locks and commitments are respected and the result is exact to the paisa (whole rupees when the inputs are).
- **Over budget? Fix by my priorities** on `/budget` shows one approval card listing each trade-off in plain English ("Decor −₹57,143 (cut first) to keep Catering and Venue intact"). `rebalance_budget`, AI cuts with no category ("cut ₹25k") and the adopt-idea warning use the same rules; Gemini gets the priorities in its prompt and is told to explain trade-offs.
- **What-if** on `/budget`: set one category's total or the guest count and see headroom and every category before and after, optionally balanced by priorities, then commit it as an approval card.
- **Per-guest lines.** Budget lines can be `flat` or `per_guest` with a rate in paise. Catering and return gifts default to per-guest in blueprints (not cakes or volunteer meals). Changing the guest count through `set_event_basics` moves each per-guest line by rate × (new − old) in code, never below what is committed, and never down on a locked line; the approval preview lists every line it moves.
- **Revise, don't restart.** "Our budget dropped by ₹50,000 and the event is 2 weeks earlier" (a demo chip) becomes ONE approval card: `set_event_basics` (total −₹50,000, every date −14 days, tasks re-dated with their sub-events) plus priority cuts, with the knock-on effects (tasks now overdue) and the trade-offs explained. Gemini calls `revise_plan` with what the user said (rupees, weeks); code computes the total, the dates and the cuts. The same parser runs offline and in the browser when the server is unreachable.

### 13. Vendor workspace (`/vendors`, v6)
- A checklist of the vendors the event type needs (`src/config/vendor-checklist.ts`: wedding venue, caterer, decorator, photographer, mehendi artist, pandit, nadaswaram/DJ, makeup; birthday cake, decor, entertainer, venue (optional); community tent/pandal, sound, idol, prasad, permits, visarjan transport, with idol/prasad/visarjan only for a puja). Each slot shows needed → shortlisted → quoted → booked (derived from vendors, never stored), what you need from that vendor, and can be marked not needed.
- Ops: `add_vendor` (T0), `set_vendor_stage` (T0; booking is T1), `remove_vendor` (T1, refused while a linked line has money committed or a payment), `set_vendor_need` (T0). Guests can run none of them; an AI proposal of any v6 op is shown as an approval card even when its tier is 0.
- "Questions to ask" per slot: Gemini's `suggest_vendor_questions` (slot and shape checked in code) or the curated Demo Mode bank, as a copyable list.
- Quote comparison for a slot with two or more quotes: amount and basis, guests covered (assumed and flagged when the quote doesn't say), whole-event amount, per-guest cost computed in code (BigInt, half up), inclusions, exclusions, extra charges (listed, not added; "amount not stated" when unknown) and what still needs clarifying. The quote schema gained optional `inclusions`, `exclusions`, `extraCharges`, `guestsCovered` and `openQuestions` (with defaults); the scanner fills them when it can. The sample wedding ships a second photography quote so the comparison is there out of the box.
- Labels everywhere: **Estimate** (setup, blueprint, idea and envelope figures), **Quoted** (from an actual quote), **Committed** (signed or paid), **Unverified** (a vendor with no quote). No price or availability is ever claimed.

### 14. Tasks, dependencies and refinement (v6)
- Tasks carry `dependsOn` (default `[]`), set by blueprints (venue booking before decor, catering and invitations; permissions before stalls and the procession) or with `set_task_dependency` (T0; self-references and cycles refused). The queue is ordered by priority, then due date, shows "Blocked by …", and Needs Attention flags a task whose blocker is overdue, due within a week, or due after it (`blocked_task` in `src/insights.ts`).
- Idea cards have "Cheaper alternative", "Make it kid-friendly" and "More traditional": `suggest_ideas` with the refinement and the source idea (code drops a "cheaper" card that isn't cheaper), or the offline bank with a derived fallback. Refined cards link back to their source.
- Adopting an idea that puts the plan over the total shows a warning on the approval card and offers "Add it and fix by my priorities" (the idea's own category is kept).

### 15. Dark mode
- Light, Dark or System (default, follows `prefers-color-scheme` live) from the **Theme** select in the More menu or at the foot of the shared guest page. Stored in `localStorage["utsav_theme_v1"]`; `persistence.ts` is untouched.
- An inline script in `<head>` sets `data-theme` on `<html>` before the first paint (no flash). `globals.css` re-points the palette shades, and so the design tokens, under `:root[data-theme="dark"]` inside `@media screen`, so printing always uses the light theme. `src/tests/a11y.test.ts` checks every text (4.5:1) and UI (3:1) pair in both themes and that every colour the components use has a dark value; `e2e/theme.spec.ts` runs axe in dark mode for the organizer, the Guest View and the public guest page.

### 16. Optional Google sign-in and cloud save (v7)
- Off unless configured. With no `NEXT_PUBLIC_FIREBASE_*` env the Sign in button is not rendered and no Firebase code is downloaded; Demo Mode, local plans and guest links work exactly as before. Signed out is the same as never configured.
- **Sign in** (header, organizer view) opens Google's popup through Firebase Auth (`signInWithPopup`, auth only: no Analytics, no client Firestore). Signed in, the header shows the user's initial and the sync status; the account panel has the name, the full status (*Saved to cloud*, *Saving…*, *Offline – saved on this device*, or a pending choice), *Try again* after a failure, and *Sign out*. Status changes are announced in a polite live region.
- **What is saved:** the current plan of the active slot (`wedding`, `birthday`, `community`) as one document per slot. Local storage stays the working copy, with its undo history; the cloud copy is a backup that follows the organizer to other devices.
- **On sign-in** (and when switching slots while signed in) the app compares the two (`decideOnSignIn` in `src/cloud-sync.ts`): no cloud copy → upload; identical → nothing to do; the cloud still holds exactly what this device last saved → save over it; otherwise ask **Use cloud copy** or **Keep this device's plan**. Using the cloud copy lands as one history step (the device's plan is one Undo away); keeping the device's plan replaces the cloud copy. Nothing is merged silently and the app never picks the cloud copy by itself.
- **Autosave** runs about 1.5 s after a plan change while signed in. Every save names the version it started from; if another device saved in between, the server answers 409 with its copy and the same two choices appear. Offline, the status says so and saving resumes on *Try again*, the next change or when the browser comes back online.
- **Keyless server.** No service account and no Admin SDK (some Google Cloud orgs forbid service-account keys). The server verifies the Firebase ID token itself (`src/server/firebase-token.ts`: RS256 against Google's `securetoken` JWKS, `aud` = project id, `iss` = `https://securetoken.google.com/<project id>`, `exp`/`iat`/`auth_time` checked with 30 s skew, `sub` 1 to 128 chars), then calls the Firestore REST API v1 with that same token as `Authorization: Bearer`, so `firestore.rules` judge every read and write. Each document holds `plan` (the validated plan as one JSON string), `version` (integer), `updatedAt` (timestamp), `title`, `eventType` and `schema`. Saves are compare-and-set twice over: a `currentDocument.exists=false` (create) or `currentDocument.updateTime` (update) precondition, and rules that only accept version 1 on create and current + 1 on update; a lost race (`ALREADY_EXISTS`, `FAILED_PRECONDITION`, or a rules refusal because the version moved) becomes the usual 409. Firestore's own error bodies are never forwarded or logged (only a category and status): its 401 → 401, 403 → 403 `cloud_forbidden`, no database yet → empty list on read and 502 `cloud_not_ready` on save, anything else → 502 `cloud_unavailable`.
- The cloud copy is validated with the full `AgentState` schema on the server and again on arrival; loading it is a plan load like *Explore a sample*, not an edit, so no money or date maths happens anywhere in sync.

## Configuration

Templates, option lists, demo prompts and KPI tiles are data, validated with Zod when the app loads (so a bad entry fails `npm test` and `next build`, never a user's session). Configuration only chooses among existing components and text. It never contains code, never decides permissions, and never bypasses the reducer.

| What | Where | Validated by | Consumed by |
|---|---|---|---|
| Event templates (seed plan + presentation) | `src/config/event-templates.ts`, seeds in `src/presets.ts` | `EventTemplate` / `TemplateRegistry` (strict; seed is a full `AgentState`) | event switcher, `persistence.ts`, `ArchetypeCard`, `GuestMicrosite`, `GET /api/event-templates` |
| Status vocabularies (RSVP, task, priority, sponsor tier/status, permit) | Zod enums in `src/schema.ts` | the schema itself | commands, blueprint, guest projection, option lists |
| Option lists and labels (diets, RSVP answers, task columns, sponsor/permit selects, volunteer shifts) | `src/config/planner-options.ts` | label maps typed as `Record<enum, string>` (a missing label is a type error) | all selects, chip groups and toggles |
| Demo prompts | `src/config/demo-prompts.ts` | `DemoPrompt` (strict: text only) | Co-Pilot chips, filtered by audience and event type |
| KPI tiles | `src/config/kpis.ts` (label, description, audiences, event types, order) | `KpiDefinitionList` (money tiles can't be guest-visible) | `CommandBar`; values from `src/kpis.ts` |

**Templates and slots.** Each template owns one slot in local storage. The three built-in ids (`wedding`, `birthday`, `community`) are the keys plans have always been saved under, so existing saved plans load with no migration. A saved slot whose template no longer exists is kept as-is and written back, never dropped. Picking a template deep-copies its frozen seed (`instantiateTemplate`), so no two plans share objects with each other or with the registry. Entity ids inside a plan (`s1`, `b1`, `g1`…) stay as authored, because they are plan-scoped and the offline brain and tests depend on them. An AI blueprint of another event type lands in that type's first template.

**Generic layout.** A template's `layout` lists sections by id in one or two columns (`main-aside` or `two-up`), plus a heading that may use `{tokens}`. `guest` sets the microsite kicker, tagline and side/footer cards. The section ids, and the event types whose data each needs, are in `ORGANIZER_SECTIONS` and `GUEST_SECTIONS`. Their components are the `SECTIONS` map in `ArchetypeCard.tsx` and `GUEST_SECTIONS` in `GuestMicrosite.tsx`. `rsvp-matrix`, `diet-summary` and `guest-rsvp` work for any event type. Validation rejects a section that needs another event type's data. The shared guest page (`/guest/:id`) is not template-driven: what it shows is decided by the server's allowlisted projection.

**KPIs.** Definitions are serializable data. Each id maps to one pure function in `KPI_CALCULATORS` (`src/kpis.ts`), sharing a context computed once per render. The map is keyed by the id union, so a tile without a calculation doesn't compile.

**Unchanged.** The reducer (`applyBatch`), trust tiers, approval cards, guest permissions, visibility filtering, the Gemini loop and Demo Mode don't read configuration. A prompt chip sends its text exactly as if typed.

### Adding a template
1. Write a seed plan (any valid `AgentState`) in `src/presets.ts`, for example a smaller wedding:
   ```ts
   export const intimateWedding = AgentState.parse({
     event: { id: "ev-intimate", title: "Riya & Kabir", eventType: "wedding", city: "Goa", totalBudgetPaise: 8_00_000_00,
       startDate: "2027-01-22", endDate: "2027-01-23", ext: { type: "wedding", partners: ["Riya", "Kabir"] } },
     subEvents: [{ id: "s1", name: "Beach ceremony", slug: "ceremony", date: "2027-01-23", startMin: 960, endMin: 1140, isMain: true, phase: "main", visibility: "public" }],
     budgetItems: [{ id: "b1", category: "venue", label: "Beach lawn", plannedPaise: 3_00_000_00 }],
   });
   ```
2. Add one entry to `DEFINITIONS` in `src/config/event-templates.ts`:
   ```ts
   { id: "intimate-wedding", name: "Intimate Beach Wedding", eventType: "wedding", accent: "rose",
     description: "Two-day beach wedding for 60 guests.", seed: intimateWedding,
     layout: { heading: "Wedding · {partners}", icon: "heart", arrangement: "main-aside", columns: [["rsvp-matrix"], ["diet-summary"]] },
     guest: { kicker: "You're invited to celebrate", tagline: "[{partners}]", aside: ["guest-rsvp"], footer: [] } },
   ```
3. Run `npm test`. The registry test lists the expected template ids, so update it alongside. The switcher, the template API and the persistence slot pick it up automatically.

## API

| Route | Auth | Body | Returns |
|---|---|---|---|
| `POST /api/chat` | none (stateless; nothing is persisted) | `{ messages ≤40 (≤4000 chars), state, today?, role?, actingGuestId?, forceOffline?, ideas?: { focus?, kind? } }` ≤ 512 KB | `{ reply, actions[], mode, warning?, fallbackReason?, truncated? }` (`ideas` forces one `suggest_ideas` call; organizer only) |
| `POST /api/plan` | none (stateless) | `{ setup, forceOffline? }` ≤ 32 KB | `{ plan, log, mode, warning?, fallbackReason? }` |
| `POST /api/scan-quote` | none (stateless) | JSON `{ presetQuoteKey \| imageBase64+mimeType \| dataUrl, state, today? }` or multipart `file` (≤ 3 MB) | `{ reply, actions[], mode, source, scanned, detectedType? }` |
| `POST /api/events` | none, rate-limited | `{ plan }` | `201 { eventId, organizerToken, version, invites[] }` (token shown once) |
| `GET /api/events/:id` | `Authorization: Bearer <organizerToken>` | | `{ version, plan, invites[] }` |
| `PUT /api/events/:id` | organizer bearer | `{ plan, baseVersion }` | `200 { version }` or `409 { current }` |
| `GET /api/event-templates` | none (read-only, same for everyone) | | `{ templates: [{ id, name, label, description, eventType, city, currency, totalBudgetPaise, startDate, endDate, subEventCount }] }` |
| `GET /api/cloud/plans` | `Authorization: Bearer <Firebase ID token>` | | `{ plans: [{ planKey, version, updatedAt, title, eventType }] }` (no plan bodies) |
| `GET /api/cloud/plans/:planKey` | Firebase ID token | | `{ planKey, version, updatedAt, plan }` or `404` |
| `PUT /api/cloud/plans/:planKey` | Firebase ID token | `{ plan, baseVersion }` ≤ 512 KB (plan ≤ 400 KB); `baseVersion` 0 creates | `200 { planKey, version, updatedAt }` or `409 { current, currentVersion }` |
| `GET /api/events/:id/public` | optional `X-Guest-Token` | | public projection |
| `POST /api/events/:id/guest` | `X-Guest-Token` (sign-ups work without) | `{ commands ≤10 }`, only `set_rsvp`, `set_guest_diet`, `claim_wishlist_item`, `community_signup` | `{ log, view }` |

**Error contract.** Every error is JSON `{ error: <code>, message }` with `Cache-Control: no-store`: `400` invalid input · `401` missing/invalid token · `403` out of scope · `404` unknown or expired link · `409` version conflict · `413` too large · `415` unsupported or mismatched file · `422` rejected by the reducer or an implausible quote · `429` rate limited · `502/504` AI reader failed or timed out (scan) · `502` cloud database unavailable or not created yet (cloud save) · `503` shared storage (or cloud save) not configured · `500` internal (details only in server logs).

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
| Cloud save (v7) | Optional Firebase sign-in, keyless: **no server secrets**. Every `/api/cloud/*` request carries a Firebase ID token, verified on the server with `jose` (RS256 only, Google's public JWKS, audience and issuer pinned to the project); the uid comes only from the verified token (strict bodies can't carry one). The server then reaches Firestore with that same token, and `firestore.rules` allow only the owner (`request.auth.uid == uid`) to read `users/{uid}/plans/*` and to create or update with exactly the known fields, a plan string ≤ 400 KiB, the server's plan-key pattern and version 1 / current + 1; deletes and every other path are denied. Plans are Zod-validated first (invalid → 400, never repaired; a stored copy that fails the schema is treated as missing), capped (413, counted in UTF-8 bytes), versioned with compare-and-set (409), rate-limited per IP and per user, and `no-store`. Tokens and Firestore error bodies are never logged or echoed (only error codes). Without the `NEXT_PUBLIC_FIREBASE_*` config the routes answer 503. That web config is a public identifier, not a secret, but it still comes only from env; a unit test fails if anything imports `firebase-admin`. |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`, Permissions-Policy, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (so the Firebase sign-in popup can report back); `/guest/*` is `noindex` and uncached; all API responses `no-store`. |

**Remaining risks.** Shared guest links still use the organizer token, not the Google account: losing the organizer token (clearing site data) means losing edit access to the shared copy (the local plan is unaffected; publish again). Anyone who receives a household link can respond for that household. Rate limits are per IP (shared NATs share a budget). A strict nonce-based CSP is not enabled yet. `/api/chat` and `/api/scan-quote` are unauthenticated and spend your Gemini quota; add Vercel's firewall rate limiting or a key in front of them before a public launch.

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
| `UTSAV_STORE` | optional | server | `file` forces the local JSON store (dev/E2E). Default in `next dev`. Refused on Vercel. A local `npm start` (NODE_ENV=production) has no store unless you set this, so **Guest links → Publish** returns 503: put `UTSAV_STORE=file` in `.env.local` (works on Windows too, unlike `VAR=value npm start`). |
| `UTSAV_DATA_DIR` | optional | server | Folder for the file store (default `.data/`, git-ignored). |

| `NEXT_PUBLIC_FIREBASE_API_KEY` · `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` · `NEXT_PUBLIC_FIREBASE_PROJECT_ID` · `NEXT_PUBLIC_FIREBASE_APP_ID` | optional (all four) | browser (inlined at build time) | Firebase web app config for Google sign-in and, keyless, the whole cloud-save setup (the server uses the project id to check tokens and reach Firestore). Without all four, sign-in is hidden. |
| `NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK` | test only | browser | `1` lets Playwright stand in a fake auth module. Never set it in production. |

`.env.local` is git-ignored; `.env.example` holds placeholders only.

## Testing

| Command | What it runs |
|---|---|
| `npm test` | Node test runner: engine tests (`src/tests/engine.test.ts`), cloud save handlers, ID-token verification (tokens signed with a throwaway RSA key), the Firestore REST repo against a fake REST API, `firestore.rules` checks, config and sync decisions (`src/tests/cloud.test.ts`), API/security/concurrency tests with mocked Gemini and an in-memory store (`src/tests/server.test.ts`), accessibility helpers (`src/tests/a11y.test.ts`) and the configuration layer: templates, template API, options, prompts, server-rendered layouts, KPIs (`src/tests/config.test.ts`) |
| `npm run demo:check` | `src/demo.ts` output vs. `src/tests/demo.baseline.txt` (byte-identical) |
| `npm run typecheck` · `npm run lint` · `npm run build` | `tsc --noEmit` · `eslint --max-warnings=0` · `next build` |
| `npm run verify` | all of the above, in that order |
| `npm run e2e:install` then `npm run test:e2e` | Playwright: `e2e/smoke.spec.ts` (core workflows), `e2e/config.spec.ts` (template API, switcher, configured sections and prompts) `e2e/a11y.spec.ts` (Co-Pilot drawer, focus, meters, axe-core WCAG 2.2 A/AA scan, 320/375/768/1280 px layouts), `e2e/header-and-editing.spec.ts` (Guest links publish at 1280/375 px, copy fallback, unconfigured storage, every header control, inline editing) `e2e/theme.spec.ts` (theme persistence, no flash, axe in dark mode, print stays light) `e2e/v5.spec.ts` (welcome and setup with exact amounts, add/remove line, total and rebalance, ideas save/adopt/undo, the haldi regression, axe on the new screens) `e2e/cloud.spec.ts` (sign-in hidden without Firebase config; with a mocked auth module and a fake cloud API: first save, autosave with compare-and-set, the choice dialog, 409, offline, axe in light and dark at 1280/375 px) and `e2e/routes.spec.ts` (each page's h1 and title, nav `aria-current`, state and undo across navigation, the drawer on every page, "Show me" and deep links, the mobile tab bar, axe in light and dark and overflow at 320/375/768/1280 px on every page) against a production build with no Gemini key and the file store |
| `npm run smoke:gemini` | Live check with your real key (see below) |

### Live Gemini smoke test
With `GEMINI_API_KEY` in `.env.local`, `npm run smoke:gemini` pings Gemini directly, then calls the real routes: an organizer prompt runs multi-step function calling into a Tier-1 batch, an over-cut gets a counter-offer, a guest budget change is refused, and Gemini Vision reads `samples/deccan-royal-caterers-quote.png` as ₹1,85,000. It also checks that the scan stays a Tier-1 proposal with integer paise, and that a rejected key falls back safely without echoing it. Exit code 0 means PASS, 1 means FAIL, and 2 means BLOCKED (key, quota, or provider down). A BLOCKED run is not a pass. Checks are spaced 13 s apart (`SMOKE_GAP_MS`) to stay under the free tier's ~5 requests a minute; a check that falls back because of a rate limit, overload or timeout counts as BLOCKED rather than FAIL. One run uses about eight Gemini requests.

## Accessibility
Target: WCAG 2.2 AA. Design tokens (stone surfaces, violet-700 primary, emerald/amber/rose status) live in `src/app/globals.css` and every text/background pair is contrast-checked in `src/tests/a11y.test.ts`; no text is smaller than 12px, and status, budget segments and timeline lanes carry an icon, text or pattern as well as colour. A skip link leads every page; a brand-new browser opens on a welcome screen first. The dashboard is split into seven pages (header tabs from 768px; below that a bottom bar with Overview, Budget, Tasks and Vendors plus a "More" sheet for Schedule, Event and Ideas; `aria-current="page"`), and client navigation moves focus to the new page's h1. Targets are at least 24×24px (44px on touch for primary actions, RSVP and diet buttons). Export CSV, Print Run-Sheet, Reset, the planning date and the history scrubber sit in the header's "More" menu (WAI-ARIA menu button). The AI Co-Pilot is a native modal `<dialog>` that opens from the launcher docked in the header, so it never covers page content. It is closed by default. Escape, the close button or the backdrop closes it, and focus returns to whatever opened it. Closing never clears the transcript, the typed draft or pending approvals. Every control has a visible focus ring and an accessible name. Budget bars are meters with rupee `aria-valuetext`. Results are announced through polite live regions. Text colours are checked against Tailwind's palette in `src/tests/a11y.test.ts`, and `prefers-reduced-motion` turns off the slide, pulse and toast animations. Automated checks don't prove conformance. Screen-reader passes with NVDA, VoiceOver and TalkBack, and 200% zoom on real devices, are still manual.

## Deploy (Vercel)
1. **Storage:** Vercel → Storage → Marketplace → *Upstash for Redis* → create a database and connect it to the project (this adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`). No schema or migrations: each event is one Redis hash `utsav:event:<id>` with a 180-day TTL refreshed on every write; rate-limit counters are `utsav:rl:*` keys that expire on their own.
2. **Env:** add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) for Production and Preview. Never as `NEXT_PUBLIC_*`.
3. **Deploy:** import the repo; framework preset Next.js; build command `npm run build`. No `vercel.json` is needed. API routes run on the Node.js runtime with `maxDuration = 60` for chat and scan (the Hobby plan caps lower; that's fine, timeouts fall back cleanly).
4. **Verify on the deployed URL:** send *Which vendor deposits are overdue?* and check the badge says **Gemini** (not *Offline*); click *Scan sample quote*, then upload `samples/deccan-royal-caterers-quote.png` and check the red flags say *read by Gemini Vision*; click **Guest links → Publish**, open a household link in a private window on another device, RSVP, then **Sync now** on the organizer and check the RSVP KPI.
5. **Rollback:** Vercel → Deployments → *Promote* the previous deployment. Stored events are forward-compatible JSON validated with Zod on every read; a record that fails validation is treated as missing (404), never served half-parsed.

Upload limits: files ≤ 3 MB (Vercel's ~4.5 MB request cap minus base64 overhead).

### Optional: Google sign-in and cloud save (Firebase)
1. Firebase console → add a project (or use an existing Google Cloud project) → **Build → Authentication → Sign-in method → Google → Enable**.
2. Authentication → **Settings → Authorized domains** → add your Vercel domain (for example `utsav-event-planner-rho.vercel.app`); `localhost` is there by default. Use `127.0.0.1` only if you add it too.
3. **Build → Firestore Database → Create database** → location `asia-south1` (Mumbai) → **production mode**. Then **Rules** → paste `firestore.rules` from this repo (owner-only access to `users/{uid}/plans/*`, everything else denied) → **Publish**. No Firebase CLI is needed.
4. Project settings → **Your apps → Web app** (no Hosting, no Analytics) → copy `apiKey`, `authDomain`, `projectId`, `appId` into `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`.
5. Nothing else: cloud save is keyless (no service account, no private key, no server secret).
6. Put the four `NEXT_PUBLIC_FIREBASE_*` values in `.env.local` for local runs and in Vercel → Settings → Environment Variables (Production and Preview), then redeploy (they are inlined at build time). Vercel needs only these four for sign-in and cloud save. Never commit them, and never set `NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK` on Vercel.
7. Check: Sign in on the deployed URL, edit the plan, see *Saved to cloud*, then sign in on another browser and choose **Use cloud copy**.

## Known limitations
- Google sign-in (optional) backs up plans to the cloud, but organizer access to a *shared guest link* is still a bearer capability stored in one browser.
- The local canvas is the organizer's working copy (localStorage); the server copy is for guests and other devices. Opening the organizer view on a second device isn't supported yet (it would need an "import with organizer token" screen).
- Guest Concierge chat runs on the organizer's canvas preview only; shared guest pages use buttons and forms, not chat.
- PDFs are passed to Gemini as-is and are never parsed on the server.

## Status
- ✅ Sandbox (v7, keyless cloud save): `npm run verify` (demo baseline, 648 unit, API, security and concurrency tests, typecheck, lint, production build) and the full Playwright suite (124 tests) against `next start` with the E2E env.
- ⏳ Google sign-in and Firestore cloud save are tested with real RS256 token checks (throwaway keys), a fake Firestore REST API, an in-memory repo and a mocked auth module; the live Google popup and the Firestore round trip need a real Firebase project (see the setup steps above).
- ✅ Windows (2026-10-23, before v7): verify, Playwright and `npm run smoke:gemini` PASS against live Gemini.
