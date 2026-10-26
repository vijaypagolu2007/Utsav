// v8 Part 1: guest list, imports, invites, the group join link, the RSVP change log and the wishlist / registry.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.UTSAV_SILENT_LOGS = "1";
import { royalWedding, arcadeBirthday, culturalFest } from "../presets";
import { AgentState } from "../schema";
import { AgentBatch, applyBatch, Batch, GUEST_ALLOWED_OPS, GUEST_LIMITS, GUEST_LIST_OPS, isSafeWishlistUrl, JOIN_ONLY_OPS, ORGANIZER_ONLY_OPS, planImport, type BatchInput, type CommandInput } from "../commands";
import { agentBatchTier, batchTier, commandTier } from "../trust";
import { formatPhone, maskPhone, normalizePhone, waDigits } from "../phone";
import { contactsToEntries, parsePasteList, parseVcf, previewImport } from "../guest-import";
import { toGuestView, type GuestView as GuestViewT } from "../guest-view";
import { rebaseGuestFields } from "../sync";
import { computePlanDiff, DIFF_LIST_MAX } from "../diff";
import { inviteMessage, joinLink, privateLink, waLink } from "../invites";
import { runOfflineAgent } from "../offline";
import { executeAgentTool, summarizePlan } from "../agent";
import { functionDeclarations, guestFunctionDeclarations } from "../gemini-tools";
import { MemoryStore, setStoreForTests } from "../server/store";
import { createSharedEvent, getGuestView, getJoinInfo, getOrganizerEvent, postGuestActions, postJoinRequest, postRsvp, putOrganizerEvent, RATE, resetHouseholdInvite, setJoinLink } from "../server/events";
import { pageForPath, PAGES, pagesForDiff } from "../routes";
import { MAX_SNAPSHOTS, parseStore, serializeStore, type Store } from "../persistence";

const TODAY = "2026-10-25";
const NOW = "2026-10-25T10:00:00.000Z";
const IP = "203.0.113.7";
type R = ReturnType<typeof applyBatch>;
const run = (st: AgentState, commands: CommandInput[], opts: Parameters<typeof applyBatch>[2] = { source: "ui" }): R => applyBatch(st, { summary: "t", commands }, opts);
const okState = (r: R) => { assert.ok(r.ok, r.ok ? "" : r.reason); return (r as Extract<R, { ok: true }>).state; };
const reason = (r: R) => { assert.equal(r.ok, false); return (r as Extract<R, { ok: false }>).reason; };
const body = <T = Record<string, unknown>>(r: { body: unknown }) => r.body as T;
const tierOf = (commands: CommandInput[]) => batchTier(Batch.parse({ summary: "x", commands }).commands);

// ---------------------------------------------------------------- phone
describe("phone normaliser (India default, E.164)", () => {
  test("national, trunk-0, country-code and 00 forms all give the same E.164", () => {
    for (const s of ["9848012345", "98480 12345", "098480-12345", "+91 98480 12345", "91 98480 12345", "0091 9848012345", "+91-98480-12345", "(+91) 98480.12345", "tel:+91-98480-12345", "98480\u00a012345"])
      assert.deepEqual(normalizePhone(s), { ok: true, e164: "+919848012345" }, s);
  });
  test("other countries need + or 00; lengths are checked", () => {
    assert.deepEqual(normalizePhone("+1 415 555 0100"), { ok: true, e164: "+14155550100" });
    assert.deepEqual(normalizePhone("0044 20 7946 0958"), { ok: true, e164: "+442079460958" });
    for (const bad of ["", "12345", "abc", "98480 1234x", "+91 1234567890", "+91 98480 1234", "98480123456", "+0 123 456 789", "+1234567890123456", "9".repeat(30)])
      assert.equal(normalizePhone(bad).ok, false, bad);
  });
  test("display helpers: format, mask (last four only), wa.me digits", () => {
    assert.equal(formatPhone("+919848012345"), "+91 98480 12345");
    assert.equal(formatPhone("+14155550100"), "+14155550100");
    assert.equal(maskPhone("+919848012345"), "+91 ••••• •2345");
    assert.ok(!maskPhone("+14155550100").includes("4155"));
    assert.equal(waDigits("+919848012345"), "919848012345");
  });
});

// ---------------------------------------------------------------- parsers
describe("paste-list parser", () => {
  test("the common shapes: comma, dash, colon, phone first, list markers, email, name only", () => {
    const r = parsePasteList("Ravi Kumar, +91 98480 12345\nSita - 9876543210\n1. Anil: 098480-22222\n+91 99999 11111 Lakshmi\n• Meena <meena@example.com>\nPriya");
    assert.deepEqual(r.entries, [
      { name: "Ravi Kumar", phone: "+91 98480 12345" }, { name: "Sita", phone: "9876543210" }, { name: "Anil", phone: "098480-22222" },
      { name: "Lakshmi", phone: "+91 99999 11111" }, { name: "Meena", email: "meena@example.com" }, { name: "Priya" },
    ]);
    assert.deepEqual(r.issues, []);
  });
  test("several people on one line are split at each phone; ';' separates lines too", () => {
    const r = parsePasteList("Ravi 98480 12346, Sita Rao 98765 43211 and Gopi +919000000001; Uma 9000000002");
    assert.deepEqual(r.entries.map(e => e.name), ["Ravi", "Sita Rao", "Gopi", "Uma"]);
  });
  test("numbers with no name and blank lines are reported or skipped, never guessed; the cap truncates", () => {
    const r = parsePasteList("\n\n98480 12345\n   \nAsha 98480 11111");
    assert.equal(r.entries.length, 1);
    assert.equal(r.issues.length, 1);
    assert.match(r.issues[0]!.reason, /No name/);
    const big = parsePasteList(Array.from({ length: 305 }, (_, i) => `Guest ${i}`).join("\n"));
    assert.equal(big.entries.length, GUEST_LIMITS.maxImport);
    assert.equal(big.truncated, true);
  });
  test("deterministic: same text, same result; invisible characters are stripped", () => {
    const t = "\ufeffRavi\u200b, 98480 12345";
    assert.deepEqual(parsePasteList(t), parsePasteList(t));
    assert.equal(parsePasteList(t).entries[0]!.name, "Ravi");
  });
});

describe("vCard parser", () => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Ravi", "  Kumar", "TEL;TYPE=HOME:040 2345 6789", "item1.TEL;TYPE=CELL:+91 98480 12345", "EMAIL;TYPE=INTERNET:ravi@example.com", "END:VCARD",
    "BEGIN:VCARD", "VERSION:2.1", "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E0=A4=B8=E0=A5=80=E0=A4=A4=E0=A4=BE;;;", "TEL;CELL:9876543210", "END:VCARD",
    "BEGIN:VCARD", "VERSION:4.0", "N:Rao;Anil;;Dr.;", "TEL;VALUE=uri;PREF=1:tel:+91-90000-00001", "TEL:+91 90000 00002", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Smith\\, Jane", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "TEL:123", "END:VCARD",
  ].join("\r\n");
  test("FN (folded), N fallback, QUOTED-PRINTABLE names, CELL / PREF numbers, EMAIL, escapes, multiple cards", () => {
    const r = parseVcf(vcf);
    assert.deepEqual(r.entries, [
      { name: "Ravi Kumar", phone: "+91 98480 12345", email: "ravi@example.com" },
      { name: "सीता", phone: "9876543210" },
      { name: "Dr. Anil Rao", phone: "+91-90000-00001" },
      { name: "Smith, Jane" },
    ]);
    assert.equal(r.issues.length, 1);
    assert.match(r.issues[0]!.reason, /no name/i);
  });
  test("LF-only files and the import cap", () => {
    const many = Array.from({ length: 310 }, (_, i) => `BEGIN:VCARD\nFN:Person ${i}\nEND:VCARD`).join("\n");
    const r = parseVcf(many);
    assert.equal(r.entries.length, GUEST_LIMITS.maxImport);
    assert.equal(r.truncated, true);
  });
  test("Contact Picker results map to the same entries (first name, phone and email)", () => {
    assert.deepEqual(contactsToEntries([{ name: ["Asha", "A"], tel: ["", "+91 98480 33333"], email: ["a@x.in"] }, { name: [] }, { name: ["Dev"] }]),
      [{ name: "Asha", phone: "+91 98480 33333", email: "a@x.in" }, { name: "Dev" }]);
  });
});

// ---------------------------------------------------------------- import + dedupe
describe("import_guests: dedupe by E.164 phone, one approval card", () => {
  const withPhone = okState(run(royalWedding, [{ op: "update_household", householdId: "h1", phone: "98480 12345" }]));
  test("duplicates by phone (any written form), by email, and within the batch are skipped; invalid phones reported", () => {
    const entries = [
      { name: "Srinivas again", phone: "+91 98480-12345" },   // same as h1
      { name: "New One", phone: "9000000001" },
      { name: "New One twin", phone: "09000000001" },          // duplicate of the row above
      { name: "Bad Phone", phone: "12345" },
      { name: "Mail", email: "m@example.com" }, { name: "Mail 2", email: "M@example.com" },
      { name: "No phone" }, { name: "no phone" },
    ];
    const p = planImport(withPhone, entries);
    assert.deepEqual(p.rows.map(r => r.status), ["duplicate", "new", "duplicate", "invalid", "new", "duplicate", "new", "duplicate"]);
    assert.equal(p.guests.length, 3);
    const r = run(withPhone, [{ op: "import_guests", entries }]);
    const st = okState(r);
    assert.equal(st.guests.length, royalWedding.guests.length + 3);
    assert.ok(r.ok && r.log.some(l => /Skipped 4 duplicates/.test(l)) && r.log.some(l => /Skipped 1 with a phone/.test(l)));
    assert.equal(st.households.find(h => h.label === "New One")!.phone, "+919000000001");
  });
  test("household names group people; new guests are invited to every sub-event that collects RSVPs", () => {
    const st = okState(run(royalWedding, [{ op: "import_guests", entries: [{ name: "Ravi", household: "Kumar family", phone: "9000000011" }, { name: "Uma", household: "Kumar family" }, { name: "Gita", household: "Rao family (bride's parents)" }] }]));
    const k = st.households.find(h => h.label === "Kumar family")!;
    assert.deepEqual(st.guests.filter(g => g.householdId === k.id).map(g => g.name), ["Ravi", "Uma"]);
    assert.equal(st.guests.find(g => g.name === "Gita")!.householdId, "h1");
    const want = royalWedding.subEvents.filter(s => s.collectsRsvp).map(s => s.id).sort();
    assert.deepEqual(Object.keys(st.guests.find(g => g.name === "Ravi")!.rsvp).sort(), want);
    assert.ok(Object.values(st.guests.find(g => g.name === "Ravi")!.rsvp).every(v => v === "invited"));
  });
  test("nothing new is a clear rejection; the cap is 300 entries; Tier 1 always, one card for the AI", () => {
    assert.match(reason(run(withPhone, [{ op: "import_guests", entries: [{ name: "x", phone: "9848012345" }] }])), /Nothing new to import: 1 already on the list/);
    assert.equal(Batch.safeParse({ summary: "x", commands: [{ op: "import_guests", entries: Array.from({ length: 301 }, (_, i) => ({ name: `G${i}` })) }] }).success, false);
    assert.equal(tierOf([{ op: "import_guests", entries: [{ name: "A" }] }]), 1);
    const a = executeAgentTool("apply_plan_changes", { summary: "Import", commands: [{ op: "import_guests", source: "ai", entries: [{ name: "A", phone: "9000000021" }, { name: "B" }] }] }, royalWedding, TODAY);
    const cards = a.actions.filter(x => x.kind === "batch");
    assert.equal(cards.length, 1);
    assert.ok(cards[0]!.kind === "batch" && cards[0]!.tier === 1);
  });
  test("preview = commit: the preview's rows and its single batch match what the reducer does", () => {
    const entries = parsePasteList("Ravi, 9000000031\nRavi again - 90000 00031\nSita 9000000032").entries;
    const pv = previewImport(royalWedding, entries, "paste");
    assert.deepEqual(pv.rows.map(r => r.status), ["new", "duplicate", "new"]);
    assert.equal(pv.batch!.commands.length, 1);
    const st = okState(applyBatch(royalWedding, pv.batch!, { source: "ui" }));
    assert.equal(st.guests.length - royalWedding.guests.length, pv.guests.length);
    assert.equal(previewImport(withPhone, [{ name: "dup", phone: "9848012345" }], "vcf").batch, null);
  });
  test("a big import collapses to one diff row and links the Guests page", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ name: `Guest ${i}`, phone: `90000${String(10000 + i)}` }));
    const st = okState(run(royalWedding, [{ op: "import_guests", entries }]));
    const d = computePlanDiff(royalWedding, st);
    assert.equal(d.rows.filter(r => r.kind === "guest").length, 1);
    assert.ok(40 > DIFF_LIST_MAX);
    assert.deepEqual(pagesForDiff(d.rows, "overview").map(p => p.id), ["guests"]);
    // phones never appear in the diff (masked at most)
    assert.ok(!JSON.stringify(computePlanDiff(royalWedding, okState(run(royalWedding, [{ op: "add_household", label: "P", phone: "9848077777" }])))).includes("9848077777"));
  });
});

// ---------------------------------------------------------------- every op: tier, organizer-only, behaviour
describe("guest-list ops", () => {
  test("tiers: add / update / approve Tier 0; remove, import, decline Tier 1; the AI always gets a card", () => {
    const t0: CommandInput[] = [{ op: "add_household", label: "X" }, { op: "update_household", householdId: "h1", side: "s" }, { op: "add_guest", householdId: "h1", name: "Y" },
      { op: "update_guest", guestId: "g1", name: "Z" }, { op: "approve_join_request", requestId: "r" }, { op: "add_wishlist_item", item: "i" },
      { op: "update_wishlist_item", itemId: "w1", item: "j" }, { op: "set_wishlist_surprise", on: true }];
    const t1: CommandInput[] = [{ op: "remove_household", householdId: "h1" }, { op: "remove_guest", guestId: "g1" }, { op: "import_guests", entries: [{ name: "a" }] },
      { op: "reject_join_request", requestId: "r" }, { op: "remove_wishlist_item", itemId: "w1" }];
    for (const c of t0) { assert.equal(tierOf([c]), 0, c.op); assert.equal(agentBatchTier(Batch.parse({ summary: "x", commands: [c] }).commands), 1, c.op); }
    for (const c of t1) assert.equal(tierOf([c]), 1, c.op);
    assert.equal(commandTier(Batch.parse({ summary: "x", commands: [{ op: "unclaim_wishlist_item", itemId: "w", guestId: "g" }] }).commands[0]!), 0);
    for (const op of GUEST_LIST_OPS) assert.ok(ORGANIZER_ONLY_OPS.has(op), op);
  });
  test("guests are refused every organizer op, at the allow-list and in the reducer", () => {
    const all: CommandInput[] = [{ op: "add_household", label: "X" }, { op: "update_household", householdId: "h1", side: "s" }, { op: "remove_household", householdId: "h1" },
      { op: "add_guest", householdId: "h1", name: "Y" }, { op: "update_guest", guestId: "g1", name: "Z" }, { op: "remove_guest", guestId: "g1" },
      { op: "import_guests", entries: [{ name: "a" }] }, { op: "approve_join_request", requestId: "r" }, { op: "reject_join_request", requestId: "r" }];
    for (const c of all) {
      assert.ok(!GUEST_ALLOWED_OPS.has(c.op as never), c.op);
      assert.match(reason(run(royalWedding, [c], { role: "guest" })), /Guest Concierge Mode is read-only/, c.op);
    }
    for (const c of [{ op: "add_wishlist_item", item: "i" }, { op: "remove_wishlist_item", itemId: "w1" }, { op: "set_wishlist_surprise", on: true }] as CommandInput[])
      assert.match(reason(run(arcadeBirthday, [c], { role: "guest" })), /read-only/, c.op);
  });
  test("add_household: members, normalised phone, duplicate phone and name refused, limits", () => {
    const st = okState(run(royalWedding, [{ op: "add_household", label: "Kumar family", side: "friends", phone: "098480 55555", members: [{ name: "Ravi" }, { name: "Baby", ageGroup: "infant" }] }]));
    const h = st.households.at(-1)!;
    assert.deepEqual([h.label, h.side, h.phone], ["Kumar family", "friends", "+919848055555"]);
    assert.deepEqual(st.guests.filter(g => g.householdId === h.id).map(g => [g.name, g.ageGroup]), [["Ravi", "adult"], ["Baby", "infant"]]);
    assert.match(reason(run(st, [{ op: "add_household", label: "Other", phone: "+91 98480 55555" }])), /already on the list \(Kumar family\)/);
    assert.match(reason(run(st, [{ op: "add_household", label: "kumar FAMILY" }])), /already a household/);
    assert.match(reason(run(st, [{ op: "add_household", label: "P", phone: "12" }])), /isn't a phone number/);
    assert.equal(Batch.safeParse({ summary: "x", commands: [{ op: "add_household", label: "P", members: Array.from({ length: 21 }, () => ({ name: "a" })) }] }).success, false);
    assert.match(reason(run(st, [{ op: "add_household", label: "Q", invitedTo: ["nope"] }])), /No sub-event/);
  });
  test("update_household / add_guest / update_guest / remove_guest / remove_household", () => {
    let st = okState(run(royalWedding, [{ op: "update_household", householdId: "h2", phone: "9848066666", email: "r@x.in" }]));
    assert.equal(st.households.find(h => h.id === "h2")!.phone, "+919848066666");
    st = okState(run(st, [{ op: "update_household", householdId: "h2", phone: "" }]));
    assert.equal(st.households.find(h => h.id === "h2")!.phone, "");
    assert.match(reason(run(st, [{ op: "update_household", householdId: "h2" }])), /Nothing to change/);
    st = okState(run(st, [{ op: "add_guest", householdId: "h2", name: "Chinni", ageGroup: "child" }]));
    const c = st.guests.at(-1)!;
    assert.equal(c.householdId, "h2");
    const haldi = royalWedding.subEvents.find(s => s.slug === "haldi")!;
    st = okState(run(st, [{ op: "set_rsvp", guestId: c.id, subEvent: "haldi", answer: "yes" }, { op: "update_guest", guestId: c.id, invitedTo: ["haldi", "sangeet"], householdId: "h3" }]));
    const c2 = st.guests.find(g => g.id === c.id)!;
    assert.equal(c2.householdId, "h3");
    assert.equal(c2.rsvp[haldi.id], "yes", "answers already given are kept");
    assert.equal(Object.keys(c2.rsvp).length, 2);
    st = okState(run(st, [{ op: "remove_guest", guestId: c.id }]));
    assert.ok(!st.guests.some(g => g.id === c.id));
    st = okState(run(st, [{ op: "remove_household", householdId: "h1" }]));
    assert.ok(!st.households.some(h => h.id === "h1") && !st.guests.some(g => g.householdId === "h1"));
    assert.match(reason(run(st, [{ op: "remove_guest", guestId: "nope" }])), /No guest/);
  });
  test("removing a guest releases their gift claim; undo is the previous state (pure reducer)", () => {
    const before = arcadeBirthday;
    const st = okState(run(before, [{ op: "remove_guest", guestId: "bg2" }]));
    const x = st.event.ext;
    assert.ok(x.type === "birthday" && x.wishlist.find(w => w.id === "w2")!.claimedByGuestId === null);
    assert.ok(before.event.ext.type === "birthday" && before.event.ext.wishlist.find(w => w.id === "w2")!.claimedByGuestId === "bg2", "input untouched");
  });
});

// ---------------------------------------------------------------- change log
describe("RSVP change log", () => {
  test("records who, what, old → new, when and through which door; nothing without `now`", () => {
    const g = royalWedding.guests.find(x => x.id === "g5")!;
    const sid = Object.keys(g.rsvp)[0]!;
    const slug = royalWedding.subEvents.find(s => s.id === sid)!.slug;
    const st = okState(run(royalWedding, [{ op: "set_rsvp", guestId: "g5", subEvent: slug, answer: "no" }, { op: "set_guest_diet", guestId: "g5", diet: ["jain"] }], { source: "ui", now: NOW }));
    assert.equal(st.rsvpLog.length, 2);
    const [a, b] = st.rsvpLog;
    assert.deepEqual([a!.guestName, a!.householdLabel, a!.field, a!.subEventId, a!.before, a!.after, a!.source, a!.at], ["Anil Sharma", "Sharma family", "rsvp", sid, g.rsvp[sid], "no", "organizer", NOW]);
    assert.deepEqual([b!.field, b!.before, b!.after], ["diet", "veg", "jain"]);
    assert.equal(okState(run(royalWedding, [{ op: "set_rsvp", guestId: "g5", subEvent: slug, answer: "no" }])).rsvpLog.length, 0, "dry runs log nothing");
    assert.equal(okState(run(royalWedding, [{ op: "set_rsvp", guestId: "g5", subEvent: slug, answer: g.rsvp[sid]! }], { source: "ui", now: NOW })).rsvpLog.length, 0, "no-op not logged");
  });
  test("sources: organizer, Co-Pilot, guest link, guest preview; capped at 300 newest", () => {
    const one = (opts: Parameters<typeof applyBatch>[2]) => okState(run(royalWedding, [{ op: "set_guest_diet", guestId: "g3", diet: ["veg"] }], opts)).rsvpLog[0]!.source;
    assert.equal(one({ source: "ui", now: NOW }), "organizer");
    assert.equal(one({ now: NOW }), "copilot");
    assert.equal(one({ source: "guest_link", now: NOW }), "guest_link", "older server writes keep their door");
    // v8 Part 1c: guests no longer write household diets or RSVPs (they answer on the open RSVP form instead).
    assert.match(reason(run(royalWedding, [{ op: "set_guest_diet", guestId: "g3", diet: ["veg"] }], { role: "guest", source: "ui", now: NOW })), /read-only/);
    let st = royalWedding;
    for (let i = 0; i < 160; i++) st = okState(run(st, [{ op: "set_guest_diet", guestId: "g3", diet: ["veg"] }, { op: "set_guest_diet", guestId: "g3", diet: [] }], { source: "ui", now: `2026-10-25T10:${String(i % 60).padStart(2, "0")}:00.${String(i).padStart(3, "0")}Z` }));
    assert.equal(st.rsvpLog.length, 300);
    assert.equal(new Set(st.rsvpLog.map(e => e.id)).size, 300, "ids unique");
    assert.ok(AgentState.safeParse(st).success);
  });
  test("never in the guest projection", () => {
    const st = okState(run(royalWedding, [{ op: "set_guest_diet", guestId: "g1", diet: ["jain"] }], { source: "ui", now: NOW }));
    const v = JSON.stringify(toGuestView(st, "e", 1, { kind: "open" }));
    assert.ok(!v.includes("rsvpLog") && !v.includes(NOW));
  });
});

// ---------------------------------------------------------------- join requests (reducer)
describe("request_join / approve / reject", () => {
  const req = (id: string, extra: Partial<{ name: string; size: number; phone: string }> = {}): CommandInput => ({ op: "request_join", requestId: id, name: extra.name ?? "Ravi", size: extra.size ?? 3, ...(extra.phone ? { phone: extra.phone } : {}), at: NOW });
  test("only the join source can run it, and that source can run nothing else", () => {
    assert.ok(JOIN_ONLY_OPS.has("request_join"));
    for (const opts of [{}, { source: "ui" as const }, { role: "guest" as const }, { role: "guest" as const, source: "guest_link" as const }])
      assert.match(reason(run(royalWedding, [req("abcdefgh01")], opts)), /only through the group join link/);
    assert.match(reason(run(royalWedding, [{ op: "community_signup", kind: "volunteer", name: "X" }], { role: "guest", source: "join" })), /can't run from the join link/);
    assert.ok(!AgentBatch.safeParse({ summary: "x", commands: [req("abcdefgh01")] }).success, "not declared to Gemini");
    const st = okState(run(royalWedding, [req("abcdefgh01", { phone: "9848012399" })], { role: "guest", source: "join", now: NOW }));
    assert.deepEqual(st.joinRequests.map(r => [r.name, r.size, r.phone, r.status]), [["Ravi", 3, "+919848012399", "pending"]]);
  });
  test("a repeat (same phone, or same name with no phone) is a silent no-op; the pending cap holds", () => {
    let st = okState(run(royalWedding, [req("abcdefgh01", { phone: "9848012399" })], { role: "guest", source: "join" }));
    const same = run(st, [req("abcdefgh02", { phone: "+91 98480 12399", name: "R" })], { role: "guest", source: "join" });
    assert.equal(okState(same), st);
    for (let i = 1; i < GUEST_LIMITS.maxPendingJoins; i++) st = okState(run(st, [req(`bulkreq${String(i).padStart(3, "0")}`, { name: `P${i}` })], { role: "guest", source: "join" }));
    assert.match(reason(run(st, [req("overflow001", { name: "Late" })], { role: "guest", source: "join" })), /too many requests/);
  });
  test("approve → household + guests with invites, phone moves to the household and leaves the request; reject wipes the phone", () => {
    let st = okState(run(royalWedding, [req("abcdefgh01", { phone: "9848012399", size: 3 }), req("abcdefgh02", { name: "Uma", size: 1, phone: "9848012398" })], { role: "guest", source: "join" }));
    st = okState(run(st, [{ op: "approve_join_request", requestId: "abcdefgh01", side: "friends" }]));
    const r = st.joinRequests.find(x => x.id === "abcdefgh01")!;
    assert.equal(r.status, "approved"); assert.equal(r.phone, "");
    const h = st.households.find(x => x.id === r.householdId)!;
    assert.deepEqual([h.label, h.phone, h.side], ["Ravi household", "+919848012399", "friends"]);
    assert.deepEqual(st.guests.filter(g => g.householdId === h.id).map(g => g.name), ["Ravi", "Ravi guest 2", "Ravi guest 3"]);
    assert.match(reason(run(st, [{ op: "approve_join_request", requestId: "abcdefgh01" }])), /already approved/);
    st = okState(run(st, [{ op: "reject_join_request", requestId: "abcdefgh02" }]));
    assert.deepEqual([st.joinRequests[1]!.status, st.joinRequests[1]!.phone], ["rejected", ""]);
  });
  test("approving a number already on the list is refused (the organizer decides)", () => {
    let st = okState(run(royalWedding, [{ op: "update_household", householdId: "h1", phone: "9848012399" }]));
    st = okState(run(st, [req("abcdefgh01", { phone: "9848012399" })], { role: "guest", source: "join" }));
    assert.match(reason(run(st, [{ op: "approve_join_request", requestId: "abcdefgh01" }])), /already on the list/);
  });
  test("offline agent: 'approve join requests' → one card with every pending request", () => {
    const st = okState(run(royalWedding, [req("abcdefgh01"), req("abcdefgh02", { name: "Uma", size: 1 })], { role: "guest", source: "join" }));
    const r = runOfflineAgent(st, "approve all join requests", TODAY);
    const card = r.actions.find(a => a.kind === "batch");
    assert.ok(card && card.kind === "batch" && card.tier === 1);
    assert.deepEqual(card.batch.commands.map(c => c.op), ["approve_join_request", "approve_join_request"]);
    assert.match(runOfflineAgent(royalWedding, "approve join requests", TODAY).reply, /No join requests/);
  });
});

// ---------------------------------------------------------------- wishlist
describe("wishlist / registry", () => {
  test("https only: no http, javascript:, data:, credentials, IP literals or localhost", () => {
    for (const ok of ["https://www.amazon.in/dp/B0C1", "https://shop.example.com/a?b=c#d"]) assert.ok(isSafeWishlistUrl(ok), ok);
    for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "https://user:pw@example.com", "https://127.0.0.1/x", "https://169.254.169.254/latest",
      "https://[::1]/", "https://localhost/x", "https://intranet/x", "https://printer.local/", "ftp://example.com", "https://exa mple.com", `https://e.com/${"a".repeat(600)}`])
      assert.equal(isSafeWishlistUrl(bad), false, bad);
    assert.match(reason(run(arcadeBirthday, [{ op: "add_wishlist_item", item: "Gift", url: "http://example.com" }])), /https:\/\//);
  });
  test("add / update / remove with rupees converted by code; duplicates refused; works on weddings (registry), not community", () => {
    let st = okState(run(arcadeBirthday, [{ op: "add_wishlist_item", item: "Lego set", approxRupees: 2500, url: "https://www.amazon.in/dp/X", priority: "high" }]));
    const x = st.event.ext;
    assert.ok(x.type === "birthday");
    const w = x.wishlist.at(-1)!;
    assert.deepEqual([w.item, w.approxPaise, w.url, w.priority, w.claimedByGuestId], ["Lego set", 250000, "https://www.amazon.in/dp/X", "high", null]);
    assert.match(reason(run(st, [{ op: "add_wishlist_item", item: "lego SET" }])), /already on the wishlist/);
    st = okState(run(st, [{ op: "update_wishlist_item", itemId: w.id, url: "", approxRupees: null, item: "Lego Technic" }]));
    const w2 = (st.event.ext as Extract<AgentState["event"]["ext"], { type: "birthday" }>).wishlist.find(i => i.id === w.id)!;
    assert.deepEqual([w2.item, w2.url, w2.approxPaise], ["Lego Technic", undefined, undefined]);
    st = okState(run(st, [{ op: "remove_wishlist_item", itemId: w.id }]));
    assert.ok(!(st.event.ext as { wishlist: { id: string }[] }).wishlist.some(i => i.id === w.id));
    const wed = okState(run(royalWedding, [{ op: "add_wishlist_item", item: "Dinner set" }, { op: "claim_wishlist_item", itemId: "wl-dinner-set", guestId: "g1" }]));
    assert.ok(wed.event.ext.type === "wedding" && wed.event.ext.wishlist[0]!.claimedByGuestId === "g1");
    assert.match(reason(run(culturalFest, [{ op: "add_wishlist_item", item: "x" }])), /birthday and wedding/);
    assert.equal(Batch.safeParse({ summary: "x", commands: [{ op: "add_wishlist_item", item: "x", approxRupees: 1.5 }] }).success, false, "whole rupees only");
  });
  test("v8 Part 1c: guests release with claim null, and only their own claim; unclaim_wishlist_item is organizer-side now", () => {
    // Sneha's claim (bg2) can't be released by the guest boundary for anyone else.
    assert.match(reason(run(arcadeBirthday, [{ op: "claim_wishlist_item", itemId: "w2", guestId: null }], { role: "guest", actorEntryId: "r-someone" })), /your own/);
    assert.match(reason(run(arcadeBirthday, [{ op: "unclaim_wishlist_item", itemId: "w2", guestId: "bg2" }], { role: "guest" })), /read-only/);
    const withEntry = okState(run(arcadeBirthday, [{ op: "submit_rsvp_entry", entryId: "r-sneha1", name: "Sneha", partySize: 1, functions: ["party"], meal: "veg", answer: "coming" }], { role: "guest", actorEntryId: "r-sneha1" }));
    const claimed = okState(run(withEntry, [{ op: "claim_wishlist_item", itemId: "w1", guestId: "r-sneha1" }], { role: "guest", actorEntryId: "r-sneha1" }));
    assert.match(reason(run(claimed, [{ op: "claim_wishlist_item", itemId: "w1", guestId: "r-other1" }], { role: "guest", actorEntryId: "r-sneha1" })), /your own/);
    const released = okState(run(claimed, [{ op: "claim_wishlist_item", itemId: "w1", guestId: null }], { role: "guest", actorEntryId: "r-sneha1" }));
    assert.ok(released.event.ext.type === "birthday" && released.event.ext.wishlist.find(w => w.id === "w1")!.claimedByGuestId === null);
    assert.match(reason(run(arcadeBirthday, [{ op: "claim_wishlist_item", itemId: "w2", guestId: "bg1" }], { role: "guest", actorEntryId: "bg1" })), /already claimed by another guest/);
  });
  test("surprise mode: the public link and an RSVP link with no RSVP yet hide claims; a device with an RSVP sees its own; nobody is named", () => {
    const st0 = okState(run(arcadeBirthday, [{ op: "set_wishlist_surprise", on: true }]));
    const st = okState(run(okState(run(st0, [{ op: "submit_rsvp_entry", entryId: "r-sneha1", name: "Sneha", partySize: 1, functions: ["party"], meal: "veg", answer: "coming" }], { role: "guest" })),
      [{ op: "claim_wishlist_item", itemId: "w1", guestId: "r-sneha1" }], { role: "guest", actorEntryId: "r-sneha1" }));
    const pub = toGuestView(st, "e", 1, null);
    assert.equal(pub.claimsHidden, true);
    assert.ok(pub.wishlist!.every(w => !w.claimed && !w.claimedByYou));
    assert.equal(toGuestView(st, "e", 1, { kind: "open" }).claimsHidden, true);
    const own = toGuestView(st, "e", 1, { kind: "open", entryId: "r-sneha1" });
    assert.equal(own.claimsHidden, false);
    assert.deepEqual(own.wishlist!.find(w => w.id === "w1")!.claimedByYou, true);
    assert.deepEqual(own.wishlist!.find(w => w.id === "w2"), { id: "w2", item: "Vinyl record player", priority: "high", url: null, claimed: true, claimedByYou: false });
    assert.ok(!JSON.stringify(own).includes("bg2") && !JSON.stringify(pub).includes("Sneha"), "the claimer's id or name never reaches anyone");
    const off = toGuestView(arcadeBirthday, "e", 1, null);
    assert.equal(off.claimsHidden, false);
    assert.equal(off.wishlist!.find(w => w.id === "w2")!.claimed, true);
  });
  test("an unsafe legacy URL is dropped from the projection; wedding registry kind", () => {
    const bad = AgentState.parse({ ...arcadeBirthday, event: { ...arcadeBirthday.event, ext: { ...arcadeBirthday.event.ext, wishlist: [{ id: "w9", item: "x", url: "http://evil.example.com" }] } } });
    assert.equal(toGuestView(bad, "e", 1, null).wishlist![0]!.url, null);
    assert.equal(toGuestView(royalWedding, "e", 1, null).wishlistKind, "registry");
    assert.equal(toGuestView(culturalFest, "e", 1, null).wishlist, null);
  });
  test("the server never fetches a wishlist URL (no SSRF): adding, projecting and sharing never call fetch", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("no network in this test"); }) as typeof fetch;
    try {
      setStoreForTests(new MemoryStore());
      const st = okState(run(arcadeBirthday, [{ op: "add_wishlist_item", item: "Gift", url: "https://shop.example.com/item" }]));
      const p = await createSharedEvent({ plan: st }, IP);
      const id = body<{ eventId: string }>(p).eventId;
      await getGuestView(id, null, IP);
      runOfflineAgent(st, "add a wishlist item: Kite https://kites.example.com/k ₹500", TODAY);
    } finally { globalThis.fetch = real; }
    assert.equal(calls, 0);
  });
  test("offline agent: 'add a wishlist item …' → Tier 1 card, rupees converted by code; http refused", () => {
    const r = runOfflineAgent(arcadeBirthday, "add a wishlist item: Lego Technic set ₹4,000 https://www.amazon.in/dp/B0 most wanted", TODAY);
    const c = r.actions.find(a => a.kind === "batch");
    assert.ok(c && c.kind === "batch" && c.tier === 1);
    assert.deepEqual(c.batch.commands[0], { op: "add_wishlist_item", item: "Lego Technic set", url: "https://www.amazon.in/dp/B0", approxRupees: 4000, priority: "high" });
    assert.match(runOfflineAgent(arcadeBirthday, "add a wishlist item: Kite http://kites.example.com", TODAY).reply, /https/);
  });
});

// ---------------------------------------------------------------- privacy
describe("privacy: phones and emails are organizer-only", () => {
  const st = okState(run(royalWedding, [{ op: "update_household", householdId: "h1", phone: "9848012345", email: "rao@example.com" }]));
  test("stripped from every guest projection (public, RSVP link, RSVP link with an entry) and from the AI's prompt", () => {
    const kinds = [null, { kind: "open" as const }, { kind: "open" as const, entryId: "r-nobody1" }];
    for (const a of kinds) {
      const v = JSON.stringify(toGuestView(st, "e", 1, a));
      for (const leak of ["9848012345", "+919848012345", "rao@example.com", "phone", "email"]) assert.ok(!v.includes(leak), `${JSON.stringify(a)}: ${leak}`);
    }
    const prompt = summarizePlan(st, TODAY);
    assert.ok(!prompt.includes("9848012345") && !prompt.includes("rao@example.com"));
  });
  test("server logs never carry a phone, a name or a token", async () => {
    setStoreForTests(new MemoryStore());
    const lines: string[] = [];
    const warn = console.warn;
    const silent = process.env.UTSAV_SILENT_LOGS;
    delete process.env.UTSAV_SILENT_LOGS;
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const p = body<{ eventId: string; organizerToken: string }>(await createSharedEvent({ plan: st }, IP));
      const j = body<{ joinToken: string }>(await setJoinLink(p.eventId, p.organizerToken, { action: "enable" }));
      await postJoinRequest(p.eventId, { t: j.joinToken, name: "Secret Person", size: 2, phone: "9876501234" }, IP);
      await postJoinRequest(p.eventId, { t: j.joinToken, name: "Bot", size: 1, website: "http://spam" }, "198.51.100.9");
    } finally { console.warn = warn; process.env.UTSAV_SILENT_LOGS = silent; }
    assert.ok(lines.length >= 2, "something was logged");
    const all = lines.join("\n");
    for (const leak of ["9876501234", "Secret Person", "9848012345", "rao@example.com"]) assert.ok(!all.includes(leak), leak);
  });
});

// ---------------------------------------------------------------- server: reset link, join link, guest endpoint
describe("server: private links, the group join link and the join endpoint", () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); setStoreForTests(store); });
  const publish = async (plan: AgentState = royalWedding) => body<{ eventId: string; organizerToken: string; invites: { householdId: string; token: string }[]; rsvpToken: string }>(await createSharedEvent({ plan }, IP));
  const DEV = "8f14e45f-ceea-4e7a-9d1b-6a0b2c3d4e5f";

  test("reset link: a new token for that household only; the old link gets 403 with a clear message; RSVPs kept", async () => {
    const p = await publish();
    const old = p.invites.find(i => i.householdId === "h1")!.token;
    const other = p.invites.find(i => i.householdId === "h2")!.token;
    assert.equal((await resetHouseholdInvite(p.eventId, "x".repeat(43), { householdId: "h1" })).status, 401);
    const r = await resetHouseholdInvite(p.eventId, p.organizerToken, { householdId: "h1" });
    assert.equal(r.status, 200);
    const fresh = body<{ invites: { householdId: string; token: string }[] }>(r).invites.find(i => i.householdId === "h1")!.token;
    assert.notEqual(fresh, old);
    assert.match(fresh, /^[A-Za-z0-9_-]{43}$/);
    const dead = await getGuestView(p.eventId, old, IP);
    assert.equal(dead.status, 403);
    assert.match(body<{ message: string }>(dead).message, /no longer valid/);
    assert.equal((await postGuestActions(p.eventId, old, { commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: null }] }, IP)).status, 403);
    assert.equal((await getGuestView(p.eventId, fresh, IP)).status, 200);
    assert.equal((await getGuestView(p.eventId, other, IP)).status, 200, "other households untouched");
    assert.equal((await resetHouseholdInvite(p.eventId, p.organizerToken, { householdId: "nope" })).status, 404);
    assert.equal((await resetHouseholdInvite(p.eventId, p.organizerToken, { householdId: "h1", extra: 1 })).status, 400);
  });

  test("join link: off by default, enable is idempotent, rotate kills the old token, disable answers 403", async () => {
    const p = await publish();
    assert.equal(body<{ joinToken: unknown }>(await getOrganizerEvent(p.eventId, p.organizerToken)).joinToken, null);
    assert.equal((await getJoinInfo(p.eventId, null, IP)).status, 403);
    const t1 = body<{ joinToken: string }>(await setJoinLink(p.eventId, p.organizerToken, { action: "enable" })).joinToken;
    assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body<{ joinToken: string }>(await setJoinLink(p.eventId, p.organizerToken, { action: "enable" })).joinToken, t1);
    const info = await getJoinInfo(p.eventId, t1, IP);
    assert.equal(info.status, 200);
    assert.deepEqual(Object.keys(body(info)).sort(), ["city", "endDate", "eventId", "eventType", "hosts", "maxSize", "startDate", "title"]);
    const t2 = body<{ joinToken: string }>(await setJoinLink(p.eventId, p.organizerToken, { action: "rotate" })).joinToken;
    assert.notEqual(t2, t1);
    assert.equal((await getJoinInfo(p.eventId, t1, IP)).status, 403);
    assert.equal((await postJoinRequest(p.eventId, { t: t1, name: "A", size: 1 }, IP)).status, 403);
    await setJoinLink(p.eventId, p.organizerToken, { action: "disable" });
    const off = await getJoinInfo(p.eventId, t2, IP);
    assert.equal(off.status, 403);
    assert.match(body<{ message: string }>(off).message, /isn't active/);
    assert.equal((await setJoinLink(p.eventId, "y".repeat(43), { action: "enable" })).status, 401);
    assert.equal((await setJoinLink(p.eventId, p.organizerToken, { action: "explode" })).status, 400);
  });

  test("join request → pending queue (no guest data returned) → organizer approves → the new guest is found on the RSVP link", async () => {
    const p = await publish();
    const t = body<{ joinToken: string }>(await setJoinLink(p.eventId, p.organizerToken, { action: "enable" })).joinToken;
    const r = await postJoinRequest(p.eventId, { t, name: "Ravi Kumar", size: 2, phone: "98480 12399" }, IP);
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(body(r)).sort(), ["message", "ok"]);
    const o = body<{ plan: AgentState; version: number }>(await getOrganizerEvent(p.eventId, p.organizerToken));
    assert.deepEqual(o.plan.joinRequests.map(x => [x.name, x.size, x.phone, x.status]), [["Ravi Kumar", 2, "+919848012399", "pending"]]);
    // The organizer approves locally (applyBatch), then syncs (PUT): the server mints the household's invite token.
    const approved = okState(run(o.plan, [{ op: "approve_join_request", requestId: o.plan.joinRequests[0]!.id }]));
    const put = await putOrganizerEvent(p.eventId, p.organizerToken, { plan: approved, baseVersion: o.version });
    assert.equal(put.status, 200);
    const hid = approved.joinRequests[0]!.householdId!;
    const inv = body<{ invites: { householdId: string; token: string }[] }>(put).invites.find(i => i.householdId === hid);
    assert.ok(inv, "a private link for the new household");
    // v8 Part 1c: a household link opens the open RSVP form and shows nothing about the household.
    const v = body<GuestViewT>(await getGuestView(p.eventId, inv!.token, IP));
    assert.equal(v.mode, "open");
    assert.ok(v.rsvp && v.mine === null);
    assert.ok(!JSON.stringify(v).includes("Ravi") && !JSON.stringify(v).includes("8012399"));
  });

  test("join endpoint: honeypot, strict body, rate limit, pending cap, deleted event", async () => {
    const p = await publish();
    const t = body<{ joinToken: string }>(await setJoinLink(p.eventId, p.organizerToken, { action: "enable" })).joinToken;
    const hp = await postJoinRequest(p.eventId, { t, name: "Bot", size: 1, website: "http://spam.example" }, "198.51.100.20");
    assert.equal(hp.status, 202, "a bot gets the same answer");
    assert.equal(body<{ plan: AgentState }>(await getOrganizerEvent(p.eventId, p.organizerToken)).plan.joinRequests.length, 0, "…and nothing is saved");
    for (const bad of [{ t, name: "", size: 1 }, { t, name: "A", size: 0 }, { t, name: "A", size: 21 }, { t, name: "A", size: 1, admin: true }, { t, name: "A".repeat(81), size: 1 }])
      assert.equal((await postJoinRequest(p.eventId, bad, "198.51.100.21")).status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal((await postJoinRequest(p.eventId, { t, name: "A", size: 1, phone: "12" }, "198.51.100.22")).status, 422);
    const ip = "198.51.100.30";
    const codes: number[] = [];
    for (let i = 0; i < RATE.join.limit + 1; i++) codes.push((await postJoinRequest(p.eventId, { t, name: `Rate ${i}`, size: 1 }, ip)).status);
    assert.deepEqual(codes, [...Array(RATE.join.limit).fill(202), 429]);
    // a repeated request is the same 202 and stores one entry
    await postJoinRequest(p.eventId, { t, name: "Twice", size: 1, phone: "9000000099" }, "198.51.100.40");
    await postJoinRequest(p.eventId, { t, name: "Twice again", size: 1, phone: "+91 90000 00099" }, "198.51.100.41");
    const pl = body<{ plan: AgentState }>(await getOrganizerEvent(p.eventId, p.organizerToken)).plan;
    assert.equal(pl.joinRequests.filter(r => r.phone === "+919000000099").length, 1);
    // fill the queue to the cap from many IPs → 429 join_queue_full
    let n = pl.joinRequests.filter(r => r.status === "pending").length, k = 0;
    while (n < GUEST_LIMITS.maxPendingJoins) { assert.equal((await postJoinRequest(p.eventId, { t, name: `Fill ${k}`, size: 1 }, `10.0.${k >> 8}.${k & 255}`)).status, 202); n++; k++; }
    const full = await postJoinRequest(p.eventId, { t, name: "One too many", size: 1 }, "10.9.9.9");
    assert.equal(full.status, 429);
    assert.equal(body<{ error: string }>(full).error, "join_queue_full");
    const { setOrganizerEventRemoved } = await import("../server/events");
    await setOrganizerEventRemoved(p.eventId, p.organizerToken, { removed: true });
    assert.equal((await postJoinRequest(p.eventId, { t, name: "Gone", size: 1 }, "10.8.8.8")).status, 410);
    assert.equal((await getJoinInfo(p.eventId, t, "10.8.8.8")).status, 410);
  });

  test("guest endpoint (v8 Part 1c): request_join and set_rsvp are refused at the boundary; a claim needs this device's own RSVP", async () => {
    const p = await publish(arcadeBirthday);
    const bh1 = p.invites.find(i => i.householdId === "bh1")!.token;
    assert.equal((await postGuestActions(p.eventId, bh1, { commands: [{ op: "request_join", requestId: "abcdefgh01", name: "x", size: 1, at: "" }] }, IP)).status, 400);
    assert.equal((await postGuestActions(p.eventId, bh1, { commands: [{ op: "set_rsvp", guestId: "bg1", subEvent: "party", answer: "no" }] }, IP)).status, 400);
    assert.equal((await postGuestActions(p.eventId, p.rsvpToken, { commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: null }] }, IP, DEV)).status, 403, "no RSVP from this device yet");
    const sent = await postRsvp(p.eventId, p.rsvpToken, DEV, { name: "Asha", partySize: 2, functions: ["bs2"], meal: "veg", answer: "coming" }, IP);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const me = body<{ view: GuestViewT }>(sent).view.mine!.entryId;
    assert.equal((await postGuestActions(p.eventId, p.rsvpToken, { commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: "bg1" }] }, IP, DEV)).status, 403, "only for yourself");
    const claimed = await postGuestActions(p.eventId, p.rsvpToken, { commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: me }] }, IP, DEV);
    assert.equal(claimed.status, 200);
    assert.equal(body<{ view: GuestViewT }>(claimed).view.wishlist!.find(w => w.id === "w1")!.claimedByYou, true);
    assert.equal((await postGuestActions(p.eventId, p.rsvpToken, { commands: [{ op: "claim_wishlist_item", itemId: "w2", guestId: null }] }, IP, DEV)).status, 422, "Sneha's claim isn't yours to release");
    const released = await postGuestActions(p.eventId, p.rsvpToken, { commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: null }] }, IP, DEV);
    assert.equal(released.status, 200);
    assert.equal(body<{ view: GuestViewT }>(released).view.wishlist!.find(w => w.id === "w1")!.claimed, false);
  });
});

// ---------------------------------------------------------------- sync merge
describe("sync: join requests and the change log merge, decisions stick", () => {
  test("a new remote request is added; the organizer's decision is never undone; log entries union", () => {
    const base = royalWedding;
    const remote = okState(run(base, [{ op: "request_join", requestId: "abcdefgh01", name: "Ravi", size: 1, at: NOW }, { op: "request_join", requestId: "abcdefgh02", name: "Uma", size: 1, at: NOW }], { role: "guest", source: "join" }));
    const remote2 = okState(run(remote, [{ op: "set_guest_diet", guestId: "g1", diet: ["jain"] }], { source: "guest_link", now: NOW }));
    let local = rebaseGuestFields(base, remote2, base);
    assert.deepEqual(local.joinRequests.map(r => r.id), ["abcdefgh01", "abcdefgh02"]);
    assert.equal(local.rsvpLog.length, 1);
    local = okState(run(local, [{ op: "approve_join_request", requestId: "abcdefgh01" }, { op: "reject_join_request", requestId: "abcdefgh02" }]));
    const again = rebaseGuestFields(local, remote2, remote2);
    assert.deepEqual(again.joinRequests.map(r => r.status), ["approved", "rejected"]);
    assert.equal(again.rsvpLog.length, 1, "no duplicate log entries");
  });
  test("wedding registry claims are guest-owned in the merge too", () => {
    const local = okState(run(royalWedding, [{ op: "add_wishlist_item", item: "Dinner set" }]));
    const remote = okState(run(local, [{ op: "claim_wishlist_item", itemId: "wl-dinner-set", guestId: "g1" }]));
    const m = rebaseGuestFields(local, remote, local);
    assert.ok(m.event.ext.type === "wedding" && m.event.ext.wishlist[0]!.claimedByGuestId === "g1");
  });
});

// ---------------------------------------------------------------- invites, AI wiring, routes, schema compatibility
describe("invites, Co-Pilot wiring, routes and compatibility", () => {
  test("wa.me links: digits only for a known number, chat picker otherwise; the text carries the private link", () => {
    const link = privateLink("https://utsav.example", "EVT", "tok_abc");
    assert.equal(link, "https://utsav.example/guest/EVT#k=tok_abc");
    const wa = waLink("+919848012345", inviteMessage(royalWedding, "Rao family", link));
    assert.match(wa, /^https:\/\/wa\.me\/919848012345\?text=/);
    assert.ok(decodeURIComponent(wa.split("text=")[1]!).includes(link));
    assert.match(waLink("", "hi"), /^https:\/\/wa\.me\/\?text=hi$/);
    assert.equal(joinLink("https://u.example", "EVT", "jt"), "https://u.example/join/EVT?t=jt");
  });
  test("offline 'add these guests: …' → ONE import_guests card (Tier 1), phones untouched as written", () => {
    const r = runOfflineAgent(royalWedding, "Add these guests: Ravi Kumar 98480 12345, Sita - 98765 43210 and Gopi +91 90000 00001", TODAY);
    const cards = r.actions.filter(a => a.kind === "batch");
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.ok(c.kind === "batch" && c.tier === 1 && c.batch.commands.length === 1);
    assert.deepEqual(c.batch.commands[0], { op: "import_guests", source: "ai", entries: [{ name: "Ravi Kumar", phone: "98480 12345" }, { name: "Sita", phone: "98765 43210" }, { name: "Gopi", phone: "+91 90000 00001" }] });
    assert.ok(!r.reply.includes("98480"), "the reply never repeats a phone");
  });
  test("Gemini: import_guests, approve_join_request and add_wishlist_item are declared; request_join is not; guests get submit_rsvp_entry only", () => {
    const decl = JSON.stringify(functionDeclarations[0].parametersJsonSchema);
    for (const op of ["import_guests", "approve_join_request", "add_wishlist_item", "remove_guest", "set_wishlist_surprise"]) assert.ok(decl.includes(`"${op}"`), op);
    assert.ok(!decl.includes('"request_join"'));
    const g = JSON.stringify(guestFunctionDeclarations[0].parametersJsonSchema);
    assert.ok(g.includes('"submit_rsvp_entry"') && !g.includes('"set_rsvp"') && !g.includes('"set_guest_diet"') && !g.includes('"unclaim_wishlist_item"') && !g.includes('"import_guests"') && !g.includes('"request_join"'));
    assert.ok(!g.includes('"duplicateOf"'), "only the server flags duplicates");
    // A Gemini-style messy-text call still becomes the single approval card.
    const a = executeAgentTool("apply_plan_changes", { summary: "Import", commands: [{ op: "import_guests", source: "ai", entries: [{ name: "Ravi", phone: "+91 98480 12345" }] }] } satisfies BatchInput, royalWedding, TODAY);
    assert.ok(a.actions[0]!.kind === "batch" && a.actions[0]!.tier === 1);
  });
  test("a big guest list still saves: the store can be written with a shorter undo history (quota fallback)", () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ name: `Guest ${i}`, phone: `9${String(100000000 + i)}` }));
    const big = okState(run(royalWedding, [{ op: "import_guests", entries }]));
    const snaps = Array.from({ length: 30 }, (_, i) => ({ plan: big, label: `step ${i}` }));
    const s: Store = { active: "wedding", byType: { wedding: { snaps, idx: 29 } } };
    const full = serializeStore(s), short = serializeStore(s, 1);
    assert.equal(JSON.parse(full).byType.wedding.snaps.length, MAX_SNAPSHOTS);
    assert.equal(JSON.parse(short).byType.wedding.snaps.length, 1);
    assert.ok(short.length * 10 < full.length);
    const back = parseStore(short);
    assert.equal(back.byType.wedding!.snaps[back.byType.wedding!.idx]!.plan.guests.length, big.guests.length, "the plan on screen survives");
  });
  test("/guests is a nav page after Event; diff kinds map to it", () => {
    assert.equal(pageForPath("/guests").id, "guests");
    assert.deepEqual(PAGES.map(p => p.id).slice(-3), ["event", "guests", "ideas"]);
  });
  test("plans saved before v8 Part 1 still parse (defaults: registry, surprise, email, join queue, change log)", () => {
    const legacy = JSON.parse(JSON.stringify(royalWedding)) as Record<string, unknown> & { event: { ext: Record<string, unknown> }; households: Record<string, unknown>[] };
    delete legacy.joinRequests; delete legacy.rsvpLog; delete legacy.event.ext.wishlist; delete legacy.event.ext.wishlistSurprise;
    for (const h of legacy.households) delete h.email;
    const p = AgentState.parse(legacy);
    assert.deepEqual([p.joinRequests, p.rsvpLog, p.households[0]!.email], [[], [], ""]);
    assert.ok(p.event.ext.type === "wedding" && p.event.ext.wishlist.length === 0 && p.event.ext.wishlistSurprise === false);
  });
});
