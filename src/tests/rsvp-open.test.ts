// v8 Part 1c: the open RSVP link. Counts (computed in code), dedupe and duplicate flags, phone normalisation and hashing,
// the IST close date, anti-spam (rate limits, honeypot, body cap, strict Zod, entry cap), CSV escaping, privacy (no
// phone in any guest response, the AI prompt or logs) and the guest op allowlist.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.UTSAV_SILENT_LOGS = "1";
import { royalWedding, arcadeBirthday } from "../presets";
import { AgentState, RSVP_ENTRIES_CAP, type RsvpEntry } from "../schema";
import { AgentBatch, applyBatch, GUEST_ALLOWED_OPS, ORGANIZER_ONLY_OPS, RSVP_ORGANIZER_OPS, type CommandInput } from "../commands";
import { agentBatchTier, commandTier } from "../trust";
import { computeRsvpCounts, csvCell, filterEntries, formatIst, istToUtcIso, newestOf, rsvpClosed, rsvpCountsForAi, rsvpCsv, utcIsoToIst } from "../rsvp";
import { normalizePhone } from "../phone";
import { toGuestView } from "../guest-view";
import { rebaseGuestFields } from "../sync";
import { executeAgentTool, summarizePlan } from "../agent";
import { runOfflineAgent } from "../offline";
import { MemoryStore, setStoreForTests } from "../server/store";
import { createSharedEvent, deviceHash, getGuestView, getOrganizerEvent, phoneHash, planRsvpWrite, postRsvp, putOrganizerEvent, RATE } from "../server/events";
import { POST as rsvpRoute } from "../app/api/events/[id]/rsvp/route";

const IP = "203.0.113.7";
const TODAY = "2026-10-26";
const NOW = "2026-10-26T08:00:00.000Z";
type R = ReturnType<typeof applyBatch>;
const run = (st: AgentState, commands: CommandInput[], opts: Parameters<typeof applyBatch>[2] = { source: "ui", now: NOW }): R => applyBatch(st, { summary: "t", commands }, opts);
const okState = (r: R) => { assert.ok(r.ok, r.ok ? "" : r.reason); return (r as Extract<R, { ok: true }>).state; };
const reason = (r: R) => { assert.equal(r.ok, false); return (r as Extract<R, { ok: false }>).reason; };
const body = <T = Record<string, unknown>>(r: { body: unknown }) => r.body as T;
const dev = (n = 1) => `8f14e45f-ceea-4e7a-9d1b-${String(n).padStart(12, "0")}`;
const submit = (entryId: string, over: Partial<{ name: string; phone: string; partySize: number; kids: number; functions: string[]; meal: "veg" | "non_veg" | "jain"; answer: "coming" | "maybe" | "not_coming" }> = {}): CommandInput =>
  ({ op: "submit_rsvp_entry", entryId, name: "Guest", partySize: 1, functions: ["sangeet"], meal: "veg", answer: "coming", ...over });
const guest = (st: AgentState, entryId: string, over: Parameters<typeof submit>[1] = {}, now = NOW) => okState(run(st, [submit(entryId, over)], { role: "guest", now, actorEntryId: entryId }));

// ---------------------------------------------------------------- counts
describe("RSVP counts (pure, in code)", () => {
  const base = okState(run(royalWedding, [{ op: "set_rsvp_settings", askKids: true }]));
  let st = guest(base, "r-family01", { name: "Iyer", partySize: 4, kids: 1, functions: ["mehendi", "muhurtham"], meal: "veg" });
  st = guest(st, "r-family02", { name: "Khan", partySize: 3, functions: ["sangeet", "muhurtham"], meal: "non_veg" });
  st = guest(st, "r-family03", { name: "Shah", partySize: 2, functions: ["muhurtham"], meal: "jain" });
  st = guest(st, "r-family04", { name: "Maybe", partySize: 5, functions: ["muhurtham", "sangeet"], meal: "veg", answer: "maybe" });
  st = guest(st, "r-family05", { name: "No", partySize: 2, functions: [], answer: "not_coming" });
  st = guest(st, "r-family06", { name: "Removed", partySize: 9, functions: ["muhurtham"] });
  st = okState(run(st, [{ op: "remove_rsvp_entry", entryId: "r-family06" }]));

  test("per function: the sum of party sizes of Coming entries; kids, meals and Maybe separately", () => {
    const c = computeRsvpCounts(st);
    const f = (slug: string) => c.perFunction.find(x => x.slug === slug)!;
    assert.deepEqual([f("muhurtham").coming, f("muhurtham").kids, f("muhurtham").meals, f("muhurtham").maybe], [9, 1, { veg: 4, non_veg: 3, jain: 2 }, 5]);
    assert.deepEqual([f("mehendi").coming, f("mehendi").meals.veg, f("sangeet").coming, f("sangeet").meals.non_veg, f("sangeet").maybe], [4, 4, 3, 3, 5]);
    assert.deepEqual([f("haldi").coming, f("reception").coming], [0, 0]);
  });
  test("totals: Maybe never in the catering total, Not coming counted, removed and merged entries excluded", () => {
    const c = computeRsvpCounts(st);
    assert.deepEqual(c.coming, { entries: 3, people: 9, kids: 1 });
    assert.deepEqual(c.maybe, { entries: 1, people: 5 });
    assert.deepEqual(c.notComing, { entries: 1, people: 2 });
    assert.deepEqual([c.totalEntries, c.removed, c.meals], [5, 1, { veg: 4, non_veg: 3, jain: 2 }]);
  });
  test("kids are null when the organizer doesn't ask; the same plan always gives the same counts", () => {
    const off = okState(run(st, [{ op: "set_rsvp_settings", askKids: false }]));
    const c = computeRsvpCounts(off);
    assert.equal(c.coming.kids, null);
    assert.ok(c.perFunction.every(f => f.kids === null));
    assert.deepEqual(computeRsvpCounts(st), computeRsvpCounts(st));
  });
  test("the Co-Pilot's read-only tool returns the same numbers (no names, no phones); guests can't call it", () => {
    const withPhone = guest(st, "r-family07", { name: "Phone Person", phone: "98480 12345", functions: ["haldi"] });
    const r = executeAgentTool("get_rsvp_counts", {}, withPhone, TODAY);
    const raw = JSON.stringify(r.response);
    assert.ok(!raw.includes("Phone Person") && !raw.includes("9848012345") && !raw.includes("Iyer"));
    assert.deepEqual((r.response as { perFunction: { slug: string; coming: number }[] }).perFunction.find(f => f.slug === "muhurtham")!.coming, 9);
    assert.equal(r.actions.length, 0, "read-only");
    assert.equal(executeAgentTool("get_rsvp_counts", {}, withPhone, TODAY, "guest").response.ok, false);
    assert.match(runOfflineAgent(withPhone, "How many veg for Muhurtham?", TODAY).reply, /^4 veg for Muhurtham/);
    assert.match(runOfflineAgent(withPhone, "how many are coming?", TODAY).reply, /^10 people coming/);
    assert.deepEqual(rsvpCountsForAi(withPhone).coming, computeRsvpCounts(withPhone).coming);
  });
});

// ---------------------------------------------------------------- reducer
describe("submit_rsvp_entry and the organizer's RSVP ops", () => {
  test("create then update the same entry; validation: functions that take RSVPs, kids ≤ party, at least one function", () => {
    let st = guest(royalWedding, "r-asha0001", { name: " Asha ", partySize: 4, functions: ["mehendi", "muhurtham"] });
    st = guest(st, "r-asha0001", { name: "Asha", partySize: 5, functions: ["muhurtham"] });
    assert.deepEqual(st.rsvpEntries.map(e => [e.id, e.name, e.partySize, e.functions]), [["r-asha0001", "Asha", 5, ["s4"]]]);
    const noFn = okState(run(royalWedding, [{ op: "set_event_basics", city: "Pune" }]));
    assert.match(reason(run(noFn, [submit("r-x0000001", { functions: [] })], { role: "guest" })), /at least one function/);
    const off = { ...royalWedding, subEvents: royalWedding.subEvents.map(s => s.slug === "haldi" ? { ...s, collectsRsvp: false } : s) };
    assert.match(reason(run(off, [submit("r-x0000001", { functions: ["haldi"] })], { role: "guest" })), /doesn't take RSVPs/);
    const kids = okState(run(royalWedding, [{ op: "set_rsvp_settings", askKids: true }]));
    assert.match(reason(run(kids, [submit("r-x0000001", { partySize: 2, kids: 3 })], { role: "guest" })), /Kids can't be more/);
    assert.equal(okState(run(royalWedding, [submit("r-x0000001", { kids: 3 })], { role: "guest" })).rsvpEntries[0]!.kids, null, "kids ignored unless asked");
    assert.ok(okState(run(royalWedding, [submit("r-x0000001", { functions: [], answer: "not_coming" })], { role: "guest" })));
  });
  test("phones are normalised to E.164 (India default); a bad number is refused; blank keeps the one on file", () => {
    for (const raw of ["98480 12345", "098480-12345", "+91 98480 12345", "919848012345", "0091 9848012345"]) {
      assert.equal(guest(royalWedding, "r-p0000001", { phone: raw }).rsvpEntries[0]!.phone, "+919848012345", raw);
    }
    assert.match(reason(run(royalWedding, [submit("r-p0000001", { phone: "12345" })], { role: "guest" })), /doesn't look right/);
    const st = guest(royalWedding, "r-p0000001", { phone: "98480 12345" });
    assert.equal(guest(st, "r-p0000001", { partySize: 2 }).rsvpEntries[0]!.phone, "+919848012345");
  });
  test("the entry cap holds (a create is refused, an update still works)", () => {
    const filler: RsvpEntry[] = Array.from({ length: RSVP_ENTRIES_CAP }, (_, i) => ({ id: `r-fill${String(i).padStart(5, "0")}`, name: "F", phone: "", partySize: 1, kids: null, functions: ["s3"], meal: "veg",
      answer: "coming", vip: false, possibleDuplicateOf: null, removedAt: null, mergedInto: null, createdAt: NOW, updatedAt: NOW }));
    const full = { ...royalWedding, rsvpEntries: filler };
    assert.match(reason(run(full, [submit("r-new00001")], { role: "guest" })), /list is full/);
    assert.ok(okState(run(full, [submit("r-fill00007", { partySize: 3 })], { role: "guest", actorEntryId: "r-fill00007" })));
  });
  test("VIP, remove (soft, releases gift claims), restore, merge (flags and claims move to the kept entry)", () => {
    let st = guest(arcadeBirthday, "r-old00001", { name: "Rao", functions: ["party"], phone: "9848012345" }, "2026-10-01T00:00:00.000Z");
    st = okState(run(st, [submit("r-new00001", { name: "Rao (2nd phone)", partySize: 3, functions: ["party"], phone: "9848012345" }), ], { role: "guest", source: "rsvp_link", now: NOW }));
    st = okState(run(st, [{ ...submit("r-new00001", { name: "Rao (2nd phone)", partySize: 3, functions: ["party"] }), duplicateOf: "r-old00001" } as CommandInput], { role: "guest", source: "rsvp_link", now: NOW, actorEntryId: "r-new00001" }));
    assert.equal(st.rsvpEntries.find(e => e.id === "r-new00001")!.possibleDuplicateOf, "r-old00001");
    st = okState(run(st, [{ op: "claim_wishlist_item", itemId: "w1", guestId: "r-old00001" }], { role: "guest", actorEntryId: "r-old00001" }));
    st = okState(run(st, [{ op: "set_rsvp_vip", entryId: "r-old00001", vip: true }]));
    assert.equal(st.rsvpEntries.find(e => e.id === "r-old00001")!.vip, true);
    const removed = okState(run(st, [{ op: "remove_rsvp_entry", entryId: "r-old00001" }]));
    const gone = removed.rsvpEntries.find(e => e.id === "r-old00001")!;
    assert.deepEqual([gone.removedAt, removed.rsvpEntries.find(e => e.id === "r-new00001")!.possibleDuplicateOf], [NOW, null]);
    assert.ok(removed.event.ext.type === "birthday" && removed.event.ext.wishlist.find(w => w.id === "w1")!.claimedByGuestId === null, "a removed entry holds no gift");
    assert.equal(computeRsvpCounts(removed).totalEntries, 1);
    assert.equal(okState(run(removed, [{ op: "restore_rsvp_entry", entryId: "r-old00001" }])).rsvpEntries.find(e => e.id === "r-old00001")!.removedAt, null);
    assert.match(reason(run(removed, [submit("r-old00001")], { role: "guest", actorEntryId: "r-old00001" })), /removed by the organizer/);
    // Merge: keep the newest; the dropped one points at it, the claim moves, the flag clears.
    const a = st.rsvpEntries.find(e => e.id === "r-old00001")!, b = st.rsvpEntries.find(e => e.id === "r-new00001")!;
    assert.equal(newestOf(a, b).id, "r-new00001");
    const merged = okState(run(st, [{ op: "merge_rsvp_entries", keepId: "r-new00001", dropId: "r-old00001" }]));
    const drop = merged.rsvpEntries.find(e => e.id === "r-old00001")!, keep = merged.rsvpEntries.find(e => e.id === "r-new00001")!;
    assert.deepEqual([drop.mergedInto, keep.possibleDuplicateOf, keep.partySize], ["r-new00001", null, 3]);
    assert.ok(merged.event.ext.type === "birthday" && merged.event.ext.wishlist.find(w => w.id === "w1")!.claimedByGuestId === "r-new00001");
    assert.equal(computeRsvpCounts(merged).coming.people, 3, "merged entry no longer counted");
    assert.match(reason(run(merged, [{ op: "restore_rsvp_entry", entryId: "r-old00001" }])), /merged/);
    assert.match(reason(run(st, [{ op: "merge_rsvp_entries", keepId: "r-new00001", dropId: "r-new00001" }])), /two different/);
  });
  test("removing an entry: the approval-card log masks the phone (last four digits only)", () => {
    const st = guest(royalWedding, "r-p0000001", { name: "Asha", phone: "98480 12345" });
    const r = run(st, [{ op: "remove_rsvp_entry", entryId: "r-p0000001" }], { now: NOW });
    assert.ok(r.ok);
    const log = r.ok ? r.log.join(" ") : "";
    assert.ok(!log.includes("9848012345") && !log.includes("98480") && log.includes("2345"), log);
  });
});

// ---------------------------------------------------------------- allowlist and tiers
describe("guest op allowlist (tight) and trust tiers", () => {
  test("guests may run exactly submit_rsvp_entry, claim_wishlist_item, community_signup (+ request_join from the join endpoint)", () => {
    assert.deepEqual([...GUEST_ALLOWED_OPS].sort(), ["claim_wishlist_item", "community_signup", "request_join", "submit_rsvp_entry"]);
    for (const op of RSVP_ORGANIZER_OPS) { assert.ok(ORGANIZER_ONLY_OPS.has(op), op); assert.ok(!GUEST_ALLOWED_OPS.has(op as never), op); }
    const st = guest(royalWedding, "r-asha0001");
    for (const c of [{ op: "set_rsvp_vip", entryId: "r-asha0001", vip: true }, { op: "remove_rsvp_entry", entryId: "r-asha0001" }, { op: "merge_rsvp_entries", keepId: "r-asha0001", dropId: "r-x0000001" },
      { op: "set_rsvp_settings", askKids: true }, { op: "set_rsvp", guestId: "g1", subEvent: "haldi", answer: "yes" }, { op: "set_guest_diet", guestId: "g1", diet: [] }] as CommandInput[])
      assert.match(reason(run(st, [c], { role: "guest", actorEntryId: "r-asha0001" })), /read-only/, c.op);
  });
  test("a guest edits only their own entry; only the RSVP server may flag a duplicate", () => {
    const st = guest(royalWedding, "r-asha0001");
    assert.match(reason(run(st, [submit("r-other001")], { role: "guest", actorEntryId: "r-asha0001" })), /your own RSVP/);
    assert.match(reason(run(st, [submit("r-asha0001")], { role: "guest" })), /your own RSVP/, "no actor: can't edit an existing entry");
    assert.match(reason(run(st, [{ ...submit("r-new00001"), duplicateOf: "r-asha0001" } as CommandInput], { role: "guest" })), /Only the RSVP server/);
    assert.ok(!AgentBatch.safeParse({ summary: "x", commands: [submit("r-new00001")] }).success, "submit_rsvp_entry isn't declared to the organizer AI");
  });
  test("tiers: VIP / restore / a guest's RSVP Tier 0; remove, merge, settings Tier 1; the AI always gets a card", () => {
    assert.deepEqual([commandTier({ op: "set_rsvp_vip", entryId: "r-a0000001", vip: true }), commandTier({ op: "restore_rsvp_entry", entryId: "r-a0000001" }),
      commandTier({ op: "remove_rsvp_entry", entryId: "r-a0000001" }), commandTier({ op: "merge_rsvp_entries", keepId: "r-a0000001", dropId: "r-b0000001" }),
      commandTier({ op: "set_rsvp_settings", askKids: true })], [0, 0, 1, 1, 1]);
    assert.equal(agentBatchTier([{ op: "set_rsvp_vip", entryId: "r-a0000001", vip: true }]), 1);
  });
});

// ---------------------------------------------------------------- IST close date
describe("close date in IST", () => {
  test("IST wall time ↔ UTC instant, fixed +05:30 on every machine; impossible dates refused", () => {
    assert.equal(istToUtcIso("2026-11-20", "23:59"), "2026-11-20T18:29:00.000Z");
    assert.equal(istToUtcIso("2026-11-21", "00:30"), "2026-11-20T19:00:00.000Z");
    assert.deepEqual(utcIsoToIst("2026-11-20T19:00:00.000Z"), { date: "2026-11-21", time: "00:30" });
    assert.equal(formatIst("2026-11-20T18:29:00.000Z"), "20 Nov 2026, 11:59 PM IST");
    assert.equal(formatIst("2026-11-20T06:30:00.000Z"), "20 Nov 2026, 12:00 PM IST");
    for (const [d, t] of [["2026-02-30", "10:00"], ["2026-13-01", "10:00"], ["2026-11-20", "24:00"], ["20-11-2026", "10:00"]]) assert.equal(istToUtcIso(d!, t!), null, `${d} ${t}`);
  });
  test("closed from the instant on; the reducer refuses a guest write after it (with the server's clock), never before", () => {
    const st = okState(run(royalWedding, [{ op: "set_rsvp_settings", closesOn: "2026-11-20" }]));
    assert.equal(st.rsvpSettings.closesAt, "2026-11-20T18:29:00.000Z");
    assert.deepEqual([rsvpClosed(st.rsvpSettings, "2026-11-20T18:28:59.999Z"), rsvpClosed(st.rsvpSettings, "2026-11-20T18:29:00.000Z")], [false, true]);
    assert.ok(okState(run(st, [submit("r-asha0001")], { role: "guest", now: "2026-11-20T18:00:00.000Z" })));
    assert.equal(reason(run(st, [submit("r-asha0001")], { role: "guest", now: "2026-11-21T00:00:00.000Z" })), "RSVP period has ended");
    assert.match(reason(run(royalWedding, [{ op: "set_rsvp_settings", closesOn: "2026-02-30" }])), /isn't a real date/);
    assert.equal(okState(run(st, [{ op: "set_rsvp_settings", closesOn: null }])).rsvpSettings.closesAt, null);
    assert.equal(okState(run(royalWedding, [{ op: "set_rsvp_settings", closesOn: "2026-11-20", closesTime: "18:00" }])).rsvpSettings.closesAt, "2026-11-20T12:30:00.000Z");
  });
});

// ---------------------------------------------------------------- CSV
describe("CSV export", () => {
  test("formula injection: cells starting with = + - @ (and tab / CR) become text; quotes and commas are escaped", () => {
    assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
    assert.deepEqual(["+919848012345", "-2", "@SUM(A1)", "\tx", "plain", "a,b", "say \"hi\"", 4, null].map(csvCell),
      ["'+919848012345", "'-2", "'@SUM(A1)", "'\tx", "plain", "\"a,b\"", "\"say \"\"hi\"\"\"", "4", ""]);
  });
  test("one row per live entry, organizer-only columns, CRLF line ends", () => {
    let st = guest(royalWedding, "r-a0000001", { name: "=cmd|' /C calc'!A0", phone: "98480 12345", partySize: 3, functions: ["sangeet", "muhurtham"] });
    st = guest(st, "r-b0000001", { name: "Kumar, Ravi", functions: ["haldi"], meal: "jain" });
    const csv = rsvpCsv(st, filterEntries(st, {}));
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "Name,Phone,Party size,Kids,Answer,Functions,Meal,VIP,Possible duplicate of,Updated (IST)");
    assert.ok(csv.includes("\r\n'=cmd|' /C calc'!A0,") || csv.includes("\r\n'=cmd"), "formula neutralised");
    assert.ok(csv.includes("'+919848012345") && csv.includes("Sangeet; Muhurtham") && csv.includes("\"Kumar, Ravi\""));
    assert.ok(csv.endsWith("\r\n"));
  });
  test("search by name or phone digits; filters by function, meal, answer, VIP and duplicates", () => {
    let st = guest(royalWedding, "r-a0000001", { name: "Asha Rao", phone: "98480 12345", functions: ["sangeet"] });
    st = guest(st, "r-b0000001", { name: "Ravi", functions: ["haldi"], meal: "jain", answer: "maybe" });
    st = okState(run(st, [{ op: "set_rsvp_vip", entryId: "r-b0000001", vip: true }]));
    const ids = (f: Parameters<typeof filterEntries>[1]) => filterEntries(st, f).map(e => e.id).sort();
    assert.deepEqual(ids({ q: "asha" }), ["r-a0000001"]);
    assert.deepEqual(ids({ q: "12345" }), ["r-a0000001"]);
    assert.deepEqual(ids({ fn: "s1" }), ["r-b0000001"]);
    assert.deepEqual(ids({ meal: "jain" }), ["r-b0000001"]);
    assert.deepEqual(ids({ answer: "coming" }), ["r-a0000001"]);
    assert.deepEqual(ids({ vip: true }), ["r-b0000001"]);
    assert.deepEqual(ids({ duplicates: true }), []);
  });
});

// ---------------------------------------------------------------- sync
describe("sync: RSVP entries merge, organizer decisions stick", () => {
  test("a new server entry is added; a guest update arrives while the organizer's VIP and removal stay", () => {
    const base = guest(royalWedding, "r-a0000001", { name: "Asha", partySize: 2 });
    const remote = guest(guest(base, "r-a0000001", { name: "Asha", partySize: 5 }, "2026-10-26T09:00:00.000Z"), "r-b0000001", { name: "Bina" }, "2026-10-26T09:01:00.000Z");
    const local = okState(run(base, [{ op: "set_rsvp_vip", entryId: "r-a0000001", vip: true }]));
    const m = rebaseGuestFields(local, remote, base);
    assert.deepEqual(m.rsvpEntries.map(e => [e.id, e.partySize, e.vip]), [["r-a0000001", 5, true], ["r-b0000001", 1, false]]);
    const removedLocally = okState(run(base, [{ op: "remove_rsvp_entry", entryId: "r-a0000001" }]));
    assert.ok(rebaseGuestFields(removedLocally, remote, base).rsvpEntries.find(e => e.id === "r-a0000001")!.removedAt, "removal kept");
    assert.deepEqual(rebaseGuestFields(m, remote, remote).rsvpEntries, m.rsvpEntries, "nothing new: unchanged");
    const settings = okState(run(base, [{ op: "set_rsvp_settings", closesOn: "2026-12-01" }]));
    assert.equal(rebaseGuestFields(settings, remote, base).rsvpSettings.closesAt, settings.rsvpSettings.closesAt, "settings are the organizer's");
  });
});

// ---------------------------------------------------------------- server: dedupe, close date, anti-spam, privacy
describe("server: open RSVP endpoint", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  const publish = async (plan: AgentState = royalWedding) => body<{ eventId: string; organizerToken: string; rsvpToken: string }>(await createSharedEvent({ plan }, IP));
  const form = (over: Record<string, unknown> = {}) => ({ name: "Asha Rao", partySize: 4, functions: ["s2", "s4"], meal: "veg", answer: "coming", ...over });
  type View = { mine: { entryId: string; partySize: number; duplicate: boolean; removed: boolean; name: string } | null };
  const plan = async (p: { eventId: string; organizerToken: string }) => body<{ plan: AgentState; version: number }>(await getOrganizerEvent(p.eventId, p.organizerToken));

  test("same device → same entry (upsert by device token); the view prefills it", async () => {
    const p = await publish();
    const a = await postRsvp(p.eventId, p.rsvpToken, dev(1), form(), IP);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(body<{ result: string }>(a).result, "created");
    const again = await postRsvp(p.eventId, p.rsvpToken, dev(1).toUpperCase(), form({ partySize: 5 }), IP);
    assert.equal(body<{ result: string }>(again).result, "updated");
    const v = body<View>(await getGuestView(p.eventId, p.rsvpToken, IP, dev(1)));
    assert.deepEqual([v.mine!.partySize, v.mine!.name], [5, "Asha Rao"]);
    assert.equal((await plan(p)).plan.rsvpEntries.length, 1);
  });
  test("a NEW device with a known phone never overwrites: a second entry flagged possibleDuplicateOf, and the guest is told", async () => {
    const p = await publish();
    const first = body<View & { view: View }>(await postRsvp(p.eventId, p.rsvpToken, dev(1), form({ phone: "98480 12345" }), IP)).view.mine!.entryId;
    const dup = await postRsvp(p.eventId, p.rsvpToken, dev(2), form({ name: "Asha (husband's phone)", partySize: 2, phone: "+91 98480-12345" }), IP);
    assert.equal(dup.status, 200);
    const d = body<{ duplicate: boolean; message: string; view: View }>(dup);
    assert.equal(d.duplicate, true);
    assert.equal(d.message, "We already have an RSVP for this number. The organizer will sort it out.");
    assert.equal(d.view.mine!.duplicate, true);
    const o = (await plan(p)).plan;
    assert.equal(o.rsvpEntries.length, 2);
    assert.deepEqual(o.rsvpEntries.find(e => e.id === first)!.partySize, 4, "the first RSVP is untouched");
    assert.equal(o.rsvpEntries.find(e => e.id !== first)!.possibleDuplicateOf, first);
    assert.ok(!JSON.stringify(d).includes(first), "the guest never learns the other entry's id");
  });
  test("no phone + a new device = a new entry (the accepted trade-off), never flagged", async () => {
    const p = await publish();
    await postRsvp(p.eventId, p.rsvpToken, dev(1), form(), IP);
    const b = body<{ duplicate: boolean }>(await postRsvp(p.eventId, p.rsvpToken, dev(2), form(), IP));
    assert.equal(b.duplicate, false);
    const o = (await plan(p)).plan;
    assert.equal(o.rsvpEntries.length, 2);
    assert.ok(o.rsvpEntries.every(e => e.possibleDuplicateOf === null));
  });
  test("after the organizer merges, the dropped device edits the kept entry; a removed entry stays removed", async () => {
    const p = await publish();
    const keep = body<{ view: View }>(await postRsvp(p.eventId, p.rsvpToken, dev(1), form({ phone: "9848012345" }), IP)).view.mine!.entryId;
    const drop = body<{ view: View }>(await postRsvp(p.eventId, p.rsvpToken, dev(2), form({ phone: "9848012345", partySize: 2 }), IP)).view.mine!.entryId;
    let o = await plan(p);
    const merged = okState(run(o.plan, [{ op: "merge_rsvp_entries", keepId: keep, dropId: drop }]));
    assert.equal((await putOrganizerEvent(p.eventId, p.organizerToken, { plan: merged, baseVersion: o.version })).status, 200);
    const v = body<View>(await getGuestView(p.eventId, p.rsvpToken, IP, dev(2)));
    assert.equal(v.mine!.entryId, keep);
    assert.equal(body<{ result: string }>(await postRsvp(p.eventId, p.rsvpToken, dev(2), form({ partySize: 6 }), IP)).result, "updated");
    o = await plan(p);
    assert.equal(o.plan.rsvpEntries.find(e => e.id === keep)!.partySize, 6);
    const removed = okState(run(o.plan, [{ op: "remove_rsvp_entry", entryId: keep }]));
    assert.equal((await putOrganizerEvent(p.eventId, p.organizerToken, { plan: removed, baseVersion: o.version })).status, 200);
    const w = await postRsvp(p.eventId, p.rsvpToken, dev(1), form(), IP);
    assert.deepEqual([w.status, body<{ error: string }>(w).error], [403, "rsvp_removed"]);
    assert.equal(body<View>(await getGuestView(p.eventId, p.rsvpToken, IP, dev(1))).mine!.removed, true);
  });
  test("phone hash: salted per event, same number in any form gives the same hash, never the number itself", () => {
    const e164 = normalizePhone("098480-12345");
    assert.ok(e164.ok);
    const h = phoneHash("salt-a-0123456789abcdefgh", e164.ok ? e164.e164 : "");
    assert.equal(h, phoneHash("salt-a-0123456789abcdefgh", "+919848012345"));
    assert.notEqual(h, phoneHash("salt-b-0123456789abcdefgh", "+919848012345"));
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes("9848012345"));
    assert.equal(deviceHash("s", dev(1)), deviceHash("s", dev(1).toUpperCase()));
  });
  test("planRsvpWrite (pure): update own, flag on a phone match from a new device, removed stays removed", () => {
    const st = guest(guest(royalWedding, "r-a0000001"), "r-b0000001");
    const idx = [{ entryId: "r-a0000001", device: "a".repeat(64), phone: "1".repeat(64) }, { entryId: "r-b0000001", device: "b".repeat(64), phone: null }];
    assert.deepEqual(planRsvpWrite(st, idx, "a".repeat(64), "1".repeat(64)), { kind: "update", entryId: "r-a0000001", duplicateOf: null });
    assert.deepEqual(planRsvpWrite(st, idx, "c".repeat(64), "1".repeat(64)), { kind: "create", duplicateOf: "r-a0000001" });
    assert.deepEqual(planRsvpWrite(st, idx, "b".repeat(64), "1".repeat(64)), { kind: "update", entryId: "r-b0000001", duplicateOf: "r-a0000001" });
    assert.deepEqual(planRsvpWrite(st, idx, "c".repeat(64), null), { kind: "create", duplicateOf: null });
    const rm = okState(run(st, [{ op: "remove_rsvp_entry", entryId: "r-a0000001" }]));
    assert.deepEqual(planRsvpWrite(rm, idx, "a".repeat(64), null), { kind: "removed" });
    assert.deepEqual(planRsvpWrite(rm, idx, "c".repeat(64), "1".repeat(64)), { kind: "create", duplicateOf: null }, "a removed entry isn't a duplicate target");
  });
  test("close date: writes after it get 'RSVP period has ended' (403); reads still work and say closed", async () => {
    const closed = okState(run(royalWedding, [{ op: "set_rsvp_settings", closesOn: "2026-01-01" }]));
    const p = await publish(closed);
    const w = await postRsvp(p.eventId, p.rsvpToken, dev(1), form(), IP);
    assert.deepEqual([w.status, body<{ message: string }>(w).message], [403, "RSVP period has ended"]);
    const v = await getGuestView(p.eventId, p.rsvpToken, IP, dev(1));
    assert.equal(v.status, 200);
    assert.equal(body<{ rsvp: { closed: boolean; closesAt: string } }>(v).rsvp.closed, true);
    const open = okState(run(royalWedding, [{ op: "set_rsvp_settings", closesOn: "2099-01-01" }]));
    const p2 = await publish(open);
    assert.equal((await postRsvp(p2.eventId, p2.rsvpToken, dev(1), form(), IP)).status, 200);
  });
  test("honeypot: a bot gets a polite 200 and nothing is saved", async () => {
    const p = await publish();
    const r = await postRsvp(p.eventId, p.rsvpToken, dev(1), form({ website: "http://spam.example" }), IP);
    assert.deepEqual([r.status, r.body], [200, { result: "saved" }]);
    assert.equal((await plan(p)).plan.rsvpEntries.length, 0);
  });
  test("rate limits: ~30 per 10 minutes per IP (CGNAT-friendly) and 10 per device", async () => {
    const p = await publish();
    assert.deepEqual([RATE.rsvpIp.limit, RATE.rsvpIp.windowSec, RATE.rsvpDevice.limit], [30, 600, 10]);
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await postRsvp(p.eventId, p.rsvpToken, dev(100 + i), form({ name: `CGNAT ${i}` }), "100.64.0.1")).status);
    assert.deepEqual([codes.slice(0, 30).every(c => c === 200), codes[30]], [true, 429]);
    const dcodes: number[] = [];
    for (let i = 0; i < 11; i++) dcodes.push((await postRsvp(p.eventId, p.rsvpToken, dev(7), form(), `198.51.100.${i + 1}`)).status);
    assert.deepEqual([dcodes.slice(0, 10).every(c => c === 200), dcodes[10]], [true, 429]);
  });
  test("strict Zod at the boundary: unknown keys, long names, party 0 / 21, wrong meal → 400; kids > party → 422", async () => {
    const p = await publish();
    for (const bad of [form({ entryId: "r-x0000001" }), form({ name: "" }), form({ name: "A".repeat(81) }), form({ partySize: 0 }), form({ partySize: 21 }),
      form({ meal: "fish" }), form({ answer: "yes" }), form({ functions: "s4" }), form({ possibleDuplicateOf: "r-x" }), form({ phone: "1".repeat(41) })])
      assert.equal((await postRsvp(p.eventId, p.rsvpToken, dev(1), bad, IP)).status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal((await postRsvp(p.eventId, p.rsvpToken, dev(1), form({ phone: "12" }), IP)).status, 400);
    const kids = okState(run(royalWedding, [{ op: "set_rsvp_settings", askKids: true }]));
    const p2 = await publish(kids);
    assert.equal((await postRsvp(p2.eventId, p2.rsvpToken, dev(1), form({ partySize: 2, kids: 3 }), IP)).status, 422);
  });
  test("body size cap at the route: over 4 KB → 413 before anything runs", async () => {
    const p = await publish();
    const big = JSON.stringify(form({ name: "x".repeat(5000) }));
    const r = await rsvpRoute(new Request(`http://localhost/api/events/${p.eventId}/rsvp`, { method: "POST", headers: { "content-type": "application/json", "x-guest-token": p.rsvpToken, "x-device-token": dev(1) }, body: big }),
      { params: Promise.resolve({ id: p.eventId }) });
    assert.equal(r.status, 413);
  });
  test("entry cap: a full list answers 409 rsvp_list_full", async () => {
    const filler: RsvpEntry[] = Array.from({ length: RSVP_ENTRIES_CAP }, (_, i) => ({ id: `r-fill${String(i).padStart(5, "0")}`, name: "F", phone: "", partySize: 1, kids: null, functions: ["s3"], meal: "veg",
      answer: "coming", vip: false, possibleDuplicateOf: null, removedAt: null, mergedInto: null, createdAt: NOW, updatedAt: NOW }));
    const p = await publish({ ...royalWedding, rsvpEntries: filler });
    const r = await postRsvp(p.eventId, p.rsvpToken, dev(1), form(), IP);
    assert.deepEqual([r.status, body<{ error: string }>(r).error], [409, "rsvp_list_full"]);
  });
  test("privacy: no phone (not even the guest's own) in any guest response, the AI prompt or the logs", async () => {
    const lines: string[] = [];
    const warn = console.warn, silent = process.env.UTSAV_SILENT_LOGS;
    delete process.env.UTSAV_SILENT_LOGS;
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const p = await publish();
      const responses = [
        await postRsvp(p.eventId, p.rsvpToken, dev(1), form({ name: "Secret Name", phone: "98480 12345" }), IP),
        await postRsvp(p.eventId, p.rsvpToken, dev(2), form({ phone: "98480 12345" }), IP),
        await getGuestView(p.eventId, p.rsvpToken, IP, dev(1)),
        await getGuestView(p.eventId, null, IP),
      ];
      for (const r of responses) {
        const raw = JSON.stringify(r.body);
        for (const leak of ["9848012345", "98480", "12345", "\"phone\""]) assert.ok(!raw.includes(leak), `${leak} in ${raw.slice(0, 120)}`);
      }
      assert.ok(!JSON.stringify(responses[3]!.body).includes("Secret Name"), "nobody else's entry on the public link");
      assert.ok(!JSON.stringify(responses[1]!.body).includes("Secret Name"), "nor on another device's");
      const o = (await plan(p)).plan;
      assert.equal(o.rsvpEntries[0]!.phone, "+919848012345", "the organizer has the real number");
      const prompt = summarizePlan(o, TODAY);
      assert.ok(!prompt.includes("9848012345") && !prompt.includes("12345"));
    } finally { console.warn = warn; process.env.UTSAV_SILENT_LOGS = silent; }
    assert.ok(lines.some(l => l.includes("rsvp_created")));
    const all = lines.join("\n");
    for (const leak of ["9848012345", "Secret Name", dev(1), dev(2)]) assert.ok(!all.includes(leak), leak);
  });
  test("the server-side index (device and phone hashes) never reaches the organizer's plan", async () => {
    const p = await publish();
    await postRsvp(p.eventId, p.rsvpToken, dev(1), form({ phone: "98480 12345" }), IP);
    const raw = JSON.stringify(await getOrganizerEvent(p.eventId, p.organizerToken));
    assert.ok(!raw.includes("rsvpIndex") && !raw.includes("rsvpSalt") && !raw.includes(dev(1)));
  });
  test("plans saved before Part 1c still parse (empty list, open, no kids question)", () => {
    const legacy = JSON.parse(JSON.stringify(royalWedding)) as Record<string, unknown>;
    delete legacy.rsvpEntries; delete legacy.rsvpSettings;
    const st = AgentState.parse(legacy);
    assert.deepEqual([st.rsvpEntries, st.rsvpSettings], [[], { closesAt: null, askKids: false }]);
    const v = toGuestView(st, "e", 1, { kind: "open" });
    assert.ok(v.rsvp && !v.rsvp.closed && v.mine === null);
  });
});
