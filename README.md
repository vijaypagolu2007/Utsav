# Utsav: GenAI Event Planning Co-Pilot

A planning assistant for Indian weddings, birthdays and community events. It handles budgets, timelines, vendor checklists and personalised ideas. **Gemini proposes, code computes, you approve.** The LLM never does money or date maths.

**Live:** https://utsav-event-planner-rho.vercel.app · **Technical reference:** [docs/TECHNICAL.md](docs/TECHNICAL.md)

## What it does

| The brief asks for | Utsav | Gemini or code |
|---|---|---|
| Practical setup questions | `/setup`: event, city, dates, guests, budget, your own ₹ or % per category, booked locks, what matters most | Code keeps your amounts exact |
| Budget trade-offs | "Fix by my priorities": cut-first, then flexible; must-protect never cut, each trade-off explained | Code computes, Gemini explains |
| Consequences of decisions | What-if on guest count or a category before committing; per-guest lines rescale | Code |
| Update, don't restart | "Budget dropped ₹50,000 and the event is 2 weeks earlier" becomes one approval card | Gemini `revise_plan`, code applies |
| Timelines and tasks | Sub-event order rules, date cascades, priority order, "Blocked by …" | Code |
| Vendors | Checklist per event type, stages, questions to ask, quote scanner, side-by-side quote comparison | Gemini Vision and drafting, code compares |
| Honest estimates | Every figure tagged Estimate, Quoted, Committed or Unverified; no availability claimed | Code |
| Personalised ideas | Ideas within what's left in the budget; Cheaper, Kid-friendly, More traditional; adopt as a task or budget line | Gemini or offline bank |
| Culture and guests | Ritual-aware templates, diets, shared guest pages with RSVP; private events and money hidden | Config and server rules |
| RSVPs and gifts (v8) | `/guests`: one open RSVP link and QR code for everyone (no guest list needed), a short form per family, an RSVP dashboard with headcount per function and meal, search, filters, VIP, duplicates to merge and CSV; an optional household list with paste / .vcf / phone-contacts import, a group join link and a change log; birthday wishlist and wedding gift registry with surprise mode | Counts, dedupe and imports in code; Gemini answers headcount questions from a read-only tool and only proposes changes |

## How it works

- **Gemini 3.5 Flash Lite** with function calling and Vision. The tool schemas are generated from Zod, so the model can only propose valid commands.
- **Deterministic core:** a Zod 4 schema plus a pure reducer (`applyBatch`) in integer paise. Every change is validated, dry-run, shown as a before-and-after diff, and undoable.
- **Trust tiers:** small changes apply automatically, large ones need your approval, and messages are only ever drafts you send yourself.
- **Demo Mode:** the same tools run offline without a key, labelled as offline.
- **Optional sign-in (Google or email):** a `/signin` page (with *Try without an account* always available), Firebase Auth plus cloud save of your plans to Firestore through the server (verified tokens, owner-only rules, versioned saves, you choose on a conflict). Keyless: no server secrets, just the four `NEXT_PUBLIC_FIREBASE_*` values ([setup](docs/TECHNICAL.md#optional-google-sign-in-and-cloud-save-firebase)). Without it, plans stay on the device.
- **My events and Samples:** the event's title in the header is a menu listing your own events and the three samples, plus *New event*. A new account is asked once whether to *Start your own event* or *Load sample events*; samples are never saved to an account unless you load them or edit one. **Judges:** sign in, then click *Load sample events* (or skip signing in: *Explore a sample* works without an account).
- **Delete event (soft delete):** *Delete event* on the Overview for every event, samples included (a sample also offers *Reset sample* next to it), or the trash next to any event in the event menu. After a short confirm the event moves to **Recently deleted** in the event menu (Undo for 10 s, Restore or Delete forever for 30 days). Signed in, the cloud copy is tombstoned so your other devices drop it instead of re-uploading it; guest links answer "This event was removed by the organizer" until you restore it. The Co-Pilot can only *propose* a delete (Tier 2 card, then the same confirm). *Hide samples* tidies the menu once you have an event of your own; *Restore samples* (or *Load sample events*) brings deleted or hidden samples back as fresh copies. Delete everything and the planner opens the setup form with *Restore samples*, never a blank page.
- **Guest list (v8 Part 1, `/guests`):** add, edit and remove households and people, each household with an organizer-only WhatsApp number. Import many at once from a **pasted list** ("Ravi Kumar, +91 98480 12345", "Sita - 98765 43210"), a **contacts file (.vcf)** read in the browser, or **Pick from phone contacts** (Chrome on Android; the button is hidden elsewhere): a preview shows what is new, a duplicate (same phone, normalised to +91…) or can't be added, then **one approval card** adds them all (one Undo takes it back). Messy text? *Ask the Co-Pilot* ("add these guests: …") produces the same card, online or in Demo Mode.
- **One open RSVP link, with a QR code (v8 Part 1c):** an Indian wedding has 500 to 800 guests, so nobody should have to type in households first. The *Share RSVP link* card on `/guests` shows the event's one link as text and as a QR code (PNG or SVG for the printed card), with **Copy**, **Share on WhatsApp** (a `wa.me` link with the message filled in; you tap send) and **Reset link**. The header's **Guest links** dialog (v8 Part 1d) shares the same single link: Copy, WhatsApp and Show QR, nothing else to choose. Guests on it see the schedule, venues and dress codes, never your budget, vendors or other guests. Old public itinerary links still open read-only.
- **One form per family:** the guest opens the link and fills in their name, an optional WhatsApp number, how many are coming (1 to 20; kids too when you ask for it), which functions, the meal (Veg, Non-veg or Jain) and Coming / Maybe / Not coming. The confirmation shows the gift registry or wishlist, where they claim or release a gift. Opening the link again on the same phone says *Welcome back, editing your RSVP* with the answers filled in. Guests never see anyone else's RSVP, and never a phone number, not even their own.
- **RSVP dashboard:** headcount per function (the sum of party sizes of *Coming* families), kids, and Veg / Non-veg / Jain per function, all computed in code; *Maybe* is shown on its own and never added to the catering total. Below it, the RSVP list: search by name or phone, filter by function, meal, answer, VIP or possible duplicates, mark VIPs, **Remove** (with Undo and *Recently removed*), **Merge** possible duplicates and **Download CSV** (formula-safe). Settings: an optional **close date** in IST (after it the form says *RSVP period has ended*; the page still opens) and *Ask kids count*. Ask the Co-Pilot "how many veg for Sangeet?": it answers from the same counts.
- **Duplicates without overwriting:** each browser keeps a random device id per event, so the same phone always edits its own RSVP. If a *new* device sends a phone number that is already on an RSVP, nothing is overwritten: a second RSVP is saved, flagged *possible duplicate*, and the guest is told "We already have an RSVP for this number. The organizer will sort it out." You merge (keep the newest, or choose) or remove it. Without a phone, a second device is simply a second RSVP (a deliberate trade-off).
- **Anti-spam:** a hidden honeypot field, rate limits per connection (about 30 every 10 minutes, generous for Jio and Airtel's shared addresses) and per device, a 4 KB body cap with strict validation, and at most 1,000 RSVPs per event.
- **Guest list (optional):** the households, imports, group join link and change log from Part 1 sit in a collapsed *Guest list (optional)* section. Household links sent earlier open the same RSVP form and show nothing about the household.
- **Group join link:** post one link in a WhatsApp group; people add their name, household size and (optionally) phone. Nobody is on the list until you **Approve** them (or the Co-Pilot's "approve join requests" card). Rate limited, with a honeypot and a cap on waiting requests; you can rotate or turn the link off.
- **RSVP change log:** who changed which household answer or meal preference, when, and whether it came from you or the Co-Pilot (organizer only).
- **Wishlist and gift registry:** add, edit and remove gifts (https shop links only, never fetched by the server) on birthdays and, new, weddings; guests claim and release their own claim once they have sent an RSVP; **surprise mode** hides claims on the public link and hides who claimed in the organizer view until asked.
- **Privacy (DPDP):** phones and emails are visible to the organizer only: never in the guest page, the public link, the AI prompt, approval cards (masked) or logs. RSVP phones are also kept as a salted hash on the server, used only to spot duplicates. See [Privacy](docs/TECHNICAL.md#privacy-and-the-dpdp-act).
- **Stack:** Next.js 16, Tailwind v4, Upstash Redis (shared guest links) and Vercel.

## Quality

- **Security:** Zod at every boundary; guest permissions enforced on the server; hashed organizer tokens; body caps and upload sniffing; redacted logs; rate limiting.
- **Testing:** 1,118 unit and API tests (Gemini mocked), 176 Playwright end-to-end tests, and a live Gemini smoke test.
- **Accessibility:** WCAG 2.2 AA target, axe on every page in light and dark from 320 to 1280 px, contrast unit-tested, 24 px minimum targets.

## Run it

```
npm install
cp .env.example .env.local
npm run dev
npm run verify
```

Add `GEMINI_API_KEY` to `.env.local` for live Gemini; without it the app runs in Demo Mode. `npm run test:e2e` runs Playwright and `npm run smoke:gemini` checks live Gemini.
