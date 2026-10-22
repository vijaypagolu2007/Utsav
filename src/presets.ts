// Seed plans for the three built-in event templates (registered in config/event-templates.ts), one per archetype,
// so judges can try wedding, birthday and community in one click.
// Dates are fixed so the demo is reproducible; the app's "today" control can be moved to see flags change.
import { AgentState } from "./schema";

const L = (lakh: number) => Math.round(lakh * 100_000 * 100); // lakh rupees → paise
const K = (thousand: number) => thousand * 1000 * 100;          // thousand rupees → paise

type R = "y" | "n" | "m" | "i" | "-";
const RSVP: Record<Exclude<R, "-">, "yes" | "no" | "maybe" | "invited"> = { y: "yes", n: "no", m: "maybe", i: "invited" };
/** rsvp("yym-i", ids) → per-sub-event RSVP map; "-" means not invited. */
const rsvp = (code: string, ids: string[]) =>
  Object.fromEntries([...code].flatMap((c, i) => (c === "-" ? [] : [[ids[i]!, RSVP[c as Exclude<R, "-">]]])));

// ---------------------------------------------------------------- Wedding
const W = ["s1", "s2", "s3", "s4", "s5"];
export const royalWedding = AgentState.parse({
  event: {
    id: "ev-royal-wedding", title: "Arjun & Meera — Royal Telugu Wedding", eventType: "wedding", city: "Hyderabad",
    totalBudgetPaise: L(25), guestCount: 300, startDate: "2027-03-10", endDate: "2027-03-15",
    ext: { type: "wedding", partners: ["Arjun", "Meera"], traditions: ["telugu", "hindu", "south-indian"], rsvpDeadline: "2027-02-10" },
  },
  subEvents: [
    { id: "s1", visibility: "private", name: "Haldi", slug: "haldi", date: "2027-03-11", startMin: 600, endMin: 780, venue: "Family home, Jubilee Hills", dressCode: "Yellow" },
    { id: "s2", visibility: "private", name: "Mehendi", slug: "mehendi", date: "2027-03-12", startMin: 960, endMin: 1200, venue: "Poolside lawn", dressCode: "Green & pink" },
    { id: "s3", visibility: "public", name: "Sangeet", slug: "sangeet", date: "2027-03-13", startMin: 1140, endMin: 1380, venue: "Grand ballroom", dressCode: "Indo-western" },
    { id: "s4", visibility: "public", name: "Muhurtham", slug: "muhurtham", date: "2027-03-14", startMin: 420, endMin: 720, isMain: true, phase: "main", venue: "N Convention", dressCode: "Silk" },
    { id: "s5", visibility: "public", name: "Reception", slug: "reception", date: "2027-03-15", startMin: 1140, endMin: 1380, phase: "post", venue: "N Convention", dressCode: "Formal" },
  ],
  budgetItems: [
    { id: "b1", category: "decor", label: "Haldi marigold decor", subEventId: "s1", vendorId: "v2", plannedPaise: K(80), committedPaise: K(30) },
    { id: "b2", category: "decor", label: "Mehendi swing & drapes", subEventId: "s2", vendorId: "v2", plannedPaise: K(60), committedPaise: K(60) },
    { id: "b3", category: "decor", label: "Sangeet stage", subEventId: "s3", vendorId: "v2", plannedPaise: L(1.5), committedPaise: L(1) },
    { id: "b4", category: "decor", label: "Mandap", subEventId: "s4", vendorId: "v2", plannedPaise: L(2), committedPaise: L(2), locked: true },
    { id: "b5", category: "decor", label: "Reception florals", subEventId: "s5", vendorId: "v2", plannedPaise: L(1.2), committedPaise: K(50), locked: true },
    { id: "b6", category: "venue", label: "N Convention hall (2 days)", subEventId: "s4", vendorId: "v1", plannedPaise: L(3.8), committedPaise: L(3.8),
      payments: [
        { id: "p1", amountPaise: L(1.5), kind: "deposit", dueDate: "2026-09-01", paidDate: "2026-08-29" },
        { id: "p2", amountPaise: L(1.5), kind: "installment", dueDate: "2027-01-15" },
        { id: "p3", amountPaise: K(80), kind: "final", dueDate: "2027-03-01" },
      ] },
    { id: "b7", category: "catering", label: "Muhurtham lunch (banana leaf)", subEventId: "s4", vendorId: "v3", plannedPaise: L(4.5), committedPaise: L(2),
      payments: [{ id: "p4", amountPaise: L(1), kind: "deposit", dueDate: "2026-10-15" }] },
    { id: "b8", category: "catering", label: "Sangeet dinner", subEventId: "s3", vendorId: "v3", plannedPaise: L(1.5) },
    { id: "b9", category: "catering", label: "Reception dinner", subEventId: "s5", vendorId: "v3", plannedPaise: L(2.5), committedPaise: L(1),
      payments: [{ id: "p5", amountPaise: K(50), kind: "deposit", dueDate: "2026-10-28" }] },
    { id: "b10", category: "photo_video", label: "Candid + cinematic film", vendorId: "v4", plannedPaise: L(1.8), quotedPaise: L(2.2),
      payments: [{ id: "p6", amountPaise: K(50), kind: "deposit", dueDate: "2026-11-01" }] },
    { id: "b11", category: "music", label: "Sangeet DJ & sound", subEventId: "s3", vendorId: "v5", plannedPaise: K(80), committedPaise: K(80) },
    { id: "b12", category: "music", label: "Nadaswaram ensemble", subEventId: "s4", plannedPaise: K(40) },
    { id: "b13", category: "attire", label: "Bride & groom attire", plannedPaise: L(1.2) },
    { id: "b14", category: "beauty", label: "Bridal makeup (3 looks)", plannedPaise: K(60) },
    { id: "b15", category: "stationery", label: "Invitations & e-invites", plannedPaise: K(30) },
    { id: "b16", category: "gifts", label: "Return gifts", plannedPaise: K(40) },
    { id: "b17", category: "logistics", label: "Guest shuttles", plannedPaise: K(50) },
    { id: "b18", category: "misc", label: "Contingency", plannedPaise: K(40) },
  ],
  vendors: [
    { id: "v1", name: "N Convention", category: "venue", phone: "+91 98480 00001", stage: "booked", rating: 4.6 },
    { id: "v2", name: "Petals & Pillars Decor", category: "decor", phone: "+91 98480 00002", stage: "booked", rating: 4.4 },
    { id: "v3", name: "Sri Annapurna Caterers", category: "catering", phone: "+91 98480 00003", email: "orders@annapurna.example", stage: "booked", rating: 4.7 },
    { id: "v4", name: "Frame by Frame Studios", category: "photo_video", phone: "+91 98480 00004", stage: "negotiating", rating: 4.8,
      quotes: [{ id: "q1", amountPaise: L(2.2), basis: "flat", receivedOn: "2026-10-05", notes: "Includes drone + same-day edit" }] },
    { id: "v5", name: "DJ Nikhil", category: "music", phone: "+91 98480 00005", stage: "booked", rating: 4.5 },
  ],
  tasks: [
    { id: "k1", title: "Confirm Haldi florist", subEventId: "s1", vendorId: "v2", dueOffsetDays: -14, priority: "med" },
    { id: "k2", title: "Pay caterer deposit", subEventId: "s4", vendorId: "v3", dueOffsetDays: -151, priority: "high" },
    { id: "k3", title: "Book Muhurtham purohit", subEventId: "s4", dueOffsetDays: -140, priority: "high" },
    { id: "k4", title: "Finalise Sangeet choreographer", subEventId: "s3", dueOffsetDays: -131, priority: "med" },
    { id: "k5", title: "Print wedding invitations", subEventId: "s4", dueOffsetDays: -120, priority: "med" },
    { id: "k6", title: "Mehendi artist trial", subEventId: "s2", dueOffsetDays: -30, priority: "low" },
    { id: "k7", title: "Book guest shuttles", subEventId: "s4", dueOffsetDays: -45, priority: "med" },
    { id: "k8", title: "Reception photo-booth vendor", subEventId: "s5", dueOffsetDays: -60, priority: "low" },
    { id: "k9", title: "Order turmeric & flowers for Haldi", subEventId: "s1", dueOffsetDays: -3, priority: "high" },
    { id: "k10", title: "Send save-the-dates", subEventId: "s4", dueOffsetDays: -160, priority: "high", status: "done", column: "done" },
  ],
  timeline: [
    { id: "t0", subEventId: "s1", label: "Marigold decor setup", lane: "decor", startMin: 450, endMin: 570, vendorId: "v2" },
    { id: "t1", subEventId: "s1", label: "Haldi application", startMin: 600, endMin: 690 },
    { id: "t2", subEventId: "s1", label: "Lunch", startMin: 690, endMin: 780 },
    { id: "t4", subEventId: "s2", label: "Mehendi artists", startMin: 960, endMin: 1140 },
    { id: "t5", subEventId: "s2", label: "Chaat counters", lane: "catering", startMin: 990, endMin: 1110, vendorId: "v3" },
    { id: "t6", subEventId: "s3", label: "Family performances", startMin: 1170, endMin: 1320 },
    { id: "t7", subEventId: "s3", label: "DJ night", startMin: 1320, endMin: 1380, vendorId: "v5" },
    { id: "t8", subEventId: "s3", label: "Sangeet dinner", lane: "catering", startMin: 1200, endMin: 1350, vendorId: "v3" },
    { id: "t9", subEventId: "s4", label: "Mandap dressing", lane: "decor", startMin: 300, endMin: 400, vendorId: "v2" },
    { id: "t10", subEventId: "s4", label: "Baraat & welcome", startMin: 420, endMin: 470 },
    { id: "t3", subEventId: "s4", label: "Muhurtham", startMin: 470, endMin: 500, anchored: true },
    { id: "t11", subEventId: "s4", label: "Talambralu & rituals", startMin: 500, endMin: 600 },
    { id: "t12", subEventId: "s4", label: "Wedding lunch", lane: "catering", startMin: 630, endMin: 720, vendorId: "v3" },
    { id: "t13", subEventId: "s5", label: "Couple entry", startMin: 1140, endMin: 1170 },
    { id: "t14", subEventId: "s5", label: "Stage photos", startMin: 1170, endMin: 1350, vendorId: "v4" },
    { id: "t15", subEventId: "s5", label: "Reception dinner", lane: "catering", startMin: 1170, endMin: 1380, vendorId: "v3" },
  ],
  households: [
    { id: "h1", label: "Rao family (bride's parents)", side: "bride" },
    { id: "h2", label: "Reddy family (groom's parents)", side: "groom" },
    { id: "h3", label: "Sharma family", side: "bride" },
    { id: "h4", label: "Iyer family", side: "groom" },
    { id: "h5", label: "College friends", side: "friends" },
    { id: "h6", label: "Office — Meera", side: "friends" },
    { id: "h7", label: "Naidu family", side: "groom" },
    { id: "h8", label: "Kapoor family", side: "bride" },
  ],
  guests: [
    { id: "g1", householdId: "h1", name: "Srinivas Rao", diet: ["veg"], rsvp: rsvp("yyyyy", W) },
    { id: "g2", householdId: "h1", name: "Lakshmi Rao", diet: ["veg", "no-onion-garlic"], rsvp: rsvp("yyyyy", W) },
    { id: "g3", householdId: "h2", name: "Venkat Reddy", diet: [], rsvp: rsvp("yyyyy", W) },
    { id: "g4", householdId: "h2", name: "Padma Reddy", diet: ["veg"], rsvp: rsvp("yyyyy", W) },
    { id: "g5", householdId: "h3", name: "Anil Sharma", diet: ["veg"], rsvp: rsvp("imyyi", W) },
    { id: "g6", householdId: "h3", name: "Kavita Sharma", diet: ["jain"], rsvp: rsvp("imyyi", W) },
    { id: "g7", householdId: "h3", name: "Aarav Sharma", ageGroup: "child", diet: ["veg"], rsvp: rsvp("imyyi", W) },
    { id: "g8", householdId: "h4", name: "Ramesh Iyer", diet: ["veg"], rsvp: rsvp("--myy", W) },
    { id: "g9", householdId: "h4", name: "Geetha Iyer", diet: ["veg"], rsvp: rsvp("--myy", W) },
    { id: "g10", householdId: "h5", name: "Kiran", diet: [], rsvp: rsvp("--yiy", W) },
    { id: "g11", householdId: "h5", name: "Divya", diet: ["vegan"], rsvp: rsvp("--yii", W) },
    { id: "g12", householdId: "h5", name: "Sameer", diet: [], isPlusOne: true, rsvp: rsvp("--iii", W) },
    { id: "g13", householdId: "h6", name: "Priya Menon", diet: ["veg"], rsvp: rsvp("--nny", W) },
    { id: "g14", householdId: "h6", name: "Rahul Verma", diet: [], rsvp: rsvp("---iy", W) },
    { id: "g15", householdId: "h7", name: "Suresh Naidu", diet: [], rsvp: rsvp("-iiii", W) },
    { id: "g16", householdId: "h7", name: "Sunitha Naidu", diet: ["veg"], rsvp: rsvp("-iiii", W) },
    { id: "g17", householdId: "h8", name: "Vikram Kapoor", diet: [], rsvp: rsvp("--myn", W) },
    { id: "g18", householdId: "h8", name: "Neha Kapoor", diet: ["gluten-free"], rsvp: rsvp("--myn", W) },
  ],
});

// ---------------------------------------------------------------- Birthday
export const arcadeBirthday = AgentState.parse({
  event: {
    id: "ev-arcade-30", title: "Rohan's 30th — Retro Arcade Night", eventType: "birthday", city: "Mumbai",
    totalBudgetPaise: L(1.5), guestCount: 40, startDate: "2026-12-12", endDate: "2026-12-13",
    ext: {
      type: "birthday", honoree: "Rohan", turningAge: 30, theme: "Retro arcade · 80s neon",
      wishlist: [
        { id: "w1", item: "Mini Pac-Man arcade cabinet", approxPaise: K(18), priority: "high" },
        { id: "w2", item: "Vinyl record player", approxPaise: K(12), priority: "high", claimedByGuestId: "bg2" },
        { id: "w3", item: "Retro handheld console", approxPaise: K(6), priority: "high" },
        { id: "w4", item: "Synthwave poster set", approxPaise: K(2), priority: "med" },
        { id: "w5", item: "Retro Polaroid camera", approxPaise: K(7), priority: "low" },
      ],
      activities: [
        { id: "a1", name: "Pac-Man high-score tournament", ageRange: [18, 45], durationMin: 45, supplies: ["2 arcade cabinets", "Scoreboard", "Trophy"] },
        { id: "a2", name: "80s costume contest", ageRange: [18, 60], durationMin: 30, supplies: ["Prize hampers", "Ring light"] },
        { id: "a3", name: "Dance-off on the light-up floor", ageRange: [18, 45], durationMin: 40, supplies: ["Dance mats", "Playlist"] },
        { id: "a4", name: "Cake cutting & toast", durationMin: 20, supplies: ["Pixel-art cake", "Sparklers", "Mocktails"] },
      ],
    },
  },
  subEvents: [
    { id: "bs1", visibility: "private", name: "Neon Setup", slug: "setup", date: "2026-12-12", startMin: 840, endMin: 1080, collectsRsvp: false, venue: "Level Up Lounge, Bandra" },
    { id: "bs2", visibility: "public", name: "Arcade Party", slug: "party", date: "2026-12-12", startMin: 1140, endMin: 1410, isMain: true, phase: "main", venue: "Level Up Lounge, Bandra", dressCode: "80s neon" },
    { id: "bs3", visibility: "private", name: "Recovery Brunch", slug: "brunch", date: "2026-12-13", startMin: 660, endMin: 810, phase: "post", venue: "Rohan's place" },
  ],
  budgetItems: [
    { id: "bb1", category: "venue", label: "Level Up Lounge buyout", subEventId: "bs2", plannedPaise: K(45), committedPaise: K(20),
      payments: [{ id: "bp1", amountPaise: K(20), kind: "deposit", dueDate: "2026-10-01", paidDate: "2026-09-28" }] },
    { id: "bb2", category: "catering", label: "Finger food & mocktail bar", subEventId: "bs2", plannedPaise: K(35), quotedPaise: K(38) },
    { id: "bb3", category: "decor", label: "Neon signs & LED floor", subEventId: "bs1", plannedPaise: K(15) },
    { id: "bb4", category: "entertainment", label: "Arcade machine rental (4)", subEventId: "bs2", plannedPaise: K(20), committedPaise: K(10),
      payments: [{ id: "bp2", amountPaise: K(10), kind: "deposit", dueDate: "2026-10-18" }] },
    { id: "bb5", category: "photo_video", label: "Photo booth + GIF cam", subEventId: "bs2", plannedPaise: K(8) },
    { id: "bb6", category: "misc", label: "Pixel-art cake", subEventId: "bs2", plannedPaise: K(7) },
    { id: "bb7", category: "gifts", label: "Retro return gifts", plannedPaise: K(6) },
    { id: "bb8", category: "logistics", label: "Late-night cabs", plannedPaise: K(4) },
    { id: "bb9", category: "catering", label: "Brunch spread", subEventId: "bs3", plannedPaise: K(6) },
  ],
  tasks: [
    { id: "bk1", title: "Send neon e-invites", subEventId: "bs2", dueOffsetDays: -49, priority: "high" },
    { id: "bk2", title: "Reserve arcade machines", subEventId: "bs2", dueOffsetDays: -60, priority: "high", status: "done", column: "done" },
    { id: "bk3", title: "Confirm headcount with venue", subEventId: "bs2", dueOffsetDays: -41, priority: "med" },
    { id: "bk4", title: "Order pixel-art cake", subEventId: "bs2", dueOffsetDays: -14, priority: "med" },
    { id: "bk5", title: "Build synthwave playlist", subEventId: "bs2", dueOffsetDays: -7, priority: "low", status: "doing", column: "doing" },
    { id: "bk6", title: "Rent LED dance floor", subEventId: "bs1", dueOffsetDays: -21, priority: "med" },
  ],
  timeline: [
    { id: "bt1", subEventId: "bs1", label: "Neon signs & LED floor", lane: "decor", startMin: 840, endMin: 960 },
    { id: "bt2", subEventId: "bs1", label: "Arcade machines install", lane: "tech", startMin: 900, endMin: 1020 },
    { id: "bt3", subEventId: "bs2", label: "Doors & welcome mocktails", startMin: 1140, endMin: 1200 },
    { id: "bt4", subEventId: "bs2", label: "Pac-Man tournament", startMin: 1200, endMin: 1245 },
    { id: "bt5", subEventId: "bs2", label: "Costume contest", startMin: 1250, endMin: 1280 },
    { id: "bt6", subEventId: "bs2", label: "Cake & toast", startMin: 1290, endMin: 1310, anchored: true },
    { id: "bt7", subEventId: "bs2", label: "Dance-off", startMin: 1320, endMin: 1410 },
    { id: "bt8", subEventId: "bs2", label: "Food service", lane: "catering", startMin: 1170, endMin: 1350 },
    { id: "bt9", subEventId: "bs3", label: "Brunch", startMin: 660, endMin: 810 },
  ],
  households: [
    { id: "bh1", label: "School gang", side: "school" },
    { id: "bh2", label: "Work crew", side: "work" },
    { id: "bh3", label: "Family", side: "family" },
  ],
  guests: [
    { id: "bg1", householdId: "bh1", name: "Aditya", rsvp: { bs2: "yes", bs3: "yes" } },
    { id: "bg2", householdId: "bh1", name: "Sneha", diet: ["veg"], rsvp: { bs2: "yes", bs3: "maybe" } },
    { id: "bg3", householdId: "bh1", name: "Farhan", rsvp: { bs2: "maybe" } },
    { id: "bg4", householdId: "bh2", name: "Ishita", diet: ["vegan"], rsvp: { bs2: "yes" } },
    { id: "bg5", householdId: "bh2", name: "Karthik", rsvp: { bs2: "yes" } },
    { id: "bg6", householdId: "bh2", name: "Tanya", rsvp: { bs2: "invited" } },
    { id: "bg7", householdId: "bh3", name: "Asha (sister)", diet: ["veg"], rsvp: { bs2: "yes", bs3: "yes" } },
    { id: "bg8", householdId: "bh3", name: "Dev (cousin)", rsvp: { bs2: "no" } },
  ],
});

// ---------------------------------------------------------------- Community
export const culturalFest = AgentState.parse({
  event: {
    id: "ev-kondapur-fest", title: "Kondapur Community Cultural Fest", eventType: "community", city: "Hyderabad",
    totalBudgetPaise: L(5), guestCount: 2000, startDate: "2026-11-20", endDate: "2026-11-22",
    ext: {
      type: "community", organizer: "Kondapur Residents' Welfare Association", expectedFootfall: 2000, volunteers: 40,
      sponsors: [
        { id: "sp1", name: "Kondapur Motors", tier: "title", pledgedPaise: L(1.5), receivedPaise: K(75), status: "committed",
          deliverables: ["Naming rights", "Stage backdrop logo", "2 stalls"] },
        { id: "sp2", name: "SpiceRoute Foods", tier: "gold", pledgedPaise: K(50), status: "pitched", deliverables: ["Food-court branding", "1 stall"] },
        { id: "sp3", name: "Bright Smiles Dental", tier: "silver", pledgedPaise: K(25), receivedPaise: K(25), status: "paid", deliverables: ["Banner logo", "Free check-up camp"] },
        { id: "sp4", name: "Café Brew", tier: "in_kind", status: "committed", deliverables: ["Coffee for volunteers"] },
        { id: "sp5", name: "Hitech City Bank branch", tier: "gold", pledgedPaise: K(75), status: "prospect", deliverables: ["Entry-gate branding"] },
      ],
      permits: [
        { id: "pm1", authority: "GHMC", kind: "Event permission", applyBy: "2026-11-01", status: "not_started", feePaise: K(10) },
        { id: "pm2", authority: "Cyberabad Police", kind: "Public gathering NOC", applyBy: "2026-10-28", status: "applied", feePaise: K(5), referenceNo: "CYB-NOC-2291" },
        { id: "pm3", authority: "Telangana Fire Services", kind: "Fire NOC", applyBy: "2026-10-18", status: "approved", feePaise: K(5), referenceNo: "TSFS-7781" },
        { id: "pm4", authority: "Traffic Police", kind: "Parking & diversion", applyBy: "2026-11-05", status: "not_started", feePaise: K(5) },
      ],
    },
  },
  subEvents: [
    { id: "cs1", visibility: "private", name: "Volunteer Briefing", slug: "briefing", date: "2026-11-20", startMin: 1080, endMin: 1200, collectsRsvp: false, venue: "Community hall" },
    { id: "cs2", visibility: "public", name: "Main Stage & Food Court", slug: "main-stage", date: "2026-11-21", startMin: 600, endMin: 1320, isMain: true, phase: "main", venue: "Kondapur Grounds" },
    { id: "cs3", visibility: "public", name: "Cultural Night & Closing", slug: "cultural-night", date: "2026-11-22", startMin: 1020, endMin: 1320, phase: "post", venue: "Kondapur Grounds" },
  ],
  budgetItems: [
    { id: "cb1", category: "venue", label: "Grounds rental (2 days)", subEventId: "cs2", plannedPaise: K(80), committedPaise: K(80),
      payments: [
        { id: "cp1", amountPaise: K(40), kind: "deposit", dueDate: "2026-10-01", paidDate: "2026-09-30" },
        { id: "cp2", amountPaise: K(40), kind: "final", dueDate: "2026-11-10" },
      ] },
    { id: "cb2", category: "permits", label: "Permits & NOC fees", plannedPaise: K(25) },
    { id: "cb3", category: "decor", label: "Stage, truss & lighting", subEventId: "cs2", plannedPaise: L(1.2), committedPaise: K(60),
      payments: [{ id: "cp3", amountPaise: K(30), kind: "deposit", dueDate: "2026-10-12" }] },
    { id: "cb4", category: "entertainment", label: "Artists & folk troupes", subEventId: "cs3", plannedPaise: L(1), quotedPaise: L(1.15) },
    { id: "cb5", category: "logistics", label: "Tents, chairs & sanitation", subEventId: "cs2", plannedPaise: K(70) },
    { id: "cb6", category: "catering", label: "Volunteer meals", plannedPaise: K(30) },
    { id: "cb7", category: "stationery", label: "Banners & signage", plannedPaise: K(25) },
    { id: "cb8", category: "photo_video", label: "Photo & live stream", plannedPaise: K(20) },
    { id: "cb9", category: "misc", label: "Security & first aid", plannedPaise: K(25) },
  ],
  tasks: [
    { id: "ck1", title: "Allot food-court stalls", subEventId: "cs2", dueOffsetDays: -30, priority: "high" },
    { id: "ck2", title: "Lock artist line-up", subEventId: "cs3", dueOffsetDays: -26, priority: "high" },
    { id: "ck3", title: "Collect sponsor logo files", subEventId: "cs2", dueOffsetDays: -20, priority: "med" },
    { id: "ck4", title: "Publish volunteer roster", subEventId: "cs1", dueOffsetDays: -13, priority: "med" },
    { id: "ck5", title: "Print banners", subEventId: "cs2", dueOffsetDays: -10, priority: "low" },
    { id: "ck6", title: "Book ambulance on standby", subEventId: "cs2", dueOffsetDays: -7, priority: "med" },
  ],
  timeline: [
    { id: "ct1", subEventId: "cs1", label: "Volunteer briefing", startMin: 1080, endMin: 1200 },
    { id: "ct2", subEventId: "cs2", label: "Inauguration & lamp lighting", startMin: 600, endMin: 660, anchored: true },
    { id: "ct3", subEventId: "cs2", label: "Kids' talent hour", startMin: 660, endMin: 780 },
    { id: "ct4", subEventId: "cs2", label: "Food court open", lane: "food", startMin: 690, endMin: 1320 },
    { id: "ct5", subEventId: "cs2", label: "Classical dance showcase", startMin: 1020, endMin: 1140 },
    { id: "ct6", subEventId: "cs2", label: "Band performance", startMin: 1170, endMin: 1320 },
    { id: "ct7", subEventId: "cs3", label: "Folk troupes", startMin: 1020, endMin: 1140 },
    { id: "ct8", subEventId: "cs3", label: "Closing ceremony & fireworks", startMin: 1230, endMin: 1290, anchored: true },
  ],
});
