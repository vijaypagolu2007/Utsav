// v8 Part 1e: the birthday party activity run-sheet. Ops (add / update / move / remove / set_party_start), their limits,
// tiers and guest denial, the run-sheet clock (minutes only, midnight wrap), adopt_idea adding a row, the approval-card
// diff, the Co-Pilot context and the Demo Mode intent. Gemini is never called.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
process.env.UTSAV_SILENT_LOGS = "1";
import { arcadeBirthday, royalWedding, culturalFest } from "../presets";
import type { AgentState } from "../schema";
import { ACTIVITY_LIMITS, ACTIVITY_OPS, AgentBatch, applyBatch, Batch, DEFAULT_ACTIVITY_MINUTES, GUEST_ALLOWED_OPS, ideaActivityMinutes, ORGANIZER_ONLY_OPS, type CommandInput } from "../commands";
import { agentBatchTier, batchTier, commandTier } from "../trust";
import { computeRunSheetTimes, formatClock, parseAges, parseHHMM, parseMinutes, runSheetEnd, runSheetTotal } from "../run-sheet";
import { computePlanDiff } from "../diff";
import { pagesForDiff } from "../routes";
import { functionDeclarations, SYSTEM_PROMPT } from "../gemini-tools";
import { clockToHHMM, runOfflineAgent } from "../offline";
import { toGuestView } from "../guest-view";

const TODAY = "2026-10-26";
const run = (st: AgentState, commands: CommandInput[], opts: Parameters<typeof applyBatch>[2] = {}) => applyBatch(st, { summary: "t", commands }, opts);
const ok = (r: ReturnType<typeof applyBatch>) => { assert.ok(r.ok, r.ok ? "" : r.reason); return r.ok ? r.state : (null as never); };
const fail = (r: ReturnType<typeof applyBatch>, re?: RegExp) => { assert.ok(!r.ok, "expected a rejection"); if (!r.ok && re) assert.match(r.reason, re); };
const ext = (st: AgentState) => { const x = st.event.ext; if (x.type !== "birthday") throw new Error("not a birthday"); return x; };
const names = (st: AgentState) => ext(st).activities.map(a => a.name);
/** A birthday with n plain rows (ids generated at runtime, never hard-coded). */
const withRows = (n: number, start: string | null = null): AgentState => {
  const x = ext(arcadeBirthday);
  return { ...arcadeBirthday, event: { ...arcadeBirthday.event, ext: { ...x, partyStart: start,
    activities: Array.from({ length: n }, (_, k) => ({ id: `ac-row-${k}-${Math.random().toString(36).slice(2, 8)}`, name: `Row ${k}`, durationMin: 10, supplies: [] })) } } };
};

describe("run-sheet clock (pure minutes arithmetic)", () => {
  test("parses HH:MM and formats 12-hour times, including noon and midnight", () => {
    assert.equal(parseHHMM("19:30"), 1170);
    assert.equal(parseHHMM("00:00"), 0);
    for (const bad of ["24:00", "7:30", "19:60", "", null, undefined, "7pm"]) assert.equal(parseHHMM(bad as string), null, String(bad));
    assert.deepEqual([0, 5, 720, 725, 779, 1439].map(formatClock), ["12:00 AM", "12:05 AM", "12:00 PM", "12:05 PM", "12:59 PM", "11:59 PM"]);
    assert.equal(formatClock(1440 + 15), "12:15 AM", "wraps past midnight");
    assert.equal(formatClock(-15), "11:45 PM", "and backwards");
  });
  test("rows run back to back from the start; no start → null (durations only)", () => {
    const rows = [{ durationMin: 45 }, { durationMin: 30 }, { durationMin: 20 }];
    const t = computeRunSheetTimes("19:00", rows)!;
    assert.deepEqual(t.map(r => r.label), ["7:00 PM to 7:45 PM", "7:45 PM to 8:15 PM", "8:15 PM to 8:35 PM"]);
    assert.deepEqual(t.map(r => [r.startMin, r.endMin]), [[1140, 1185], [1185, 1215], [1215, 1235]]);
    assert.equal(runSheetTotal(rows), 95);
    assert.equal(runSheetEnd("19:00", rows), "8:35 PM");
    assert.equal(computeRunSheetTimes(null, rows), null);
    assert.equal(runSheetEnd(null, rows), null);
    assert.deepEqual(computeRunSheetTimes("19:00", []), []);
  });
  test("a party that runs past midnight shows 12:15 AM, not 24:15", () => {
    const t = computeRunSheetTimes("23:30", [{ durationMin: 30 }, { durationMin: 45 }])!;
    assert.deepEqual(t.map(r => r.label), ["11:30 PM to 12:00 AM", "12:00 AM to 12:45 AM"]);
    assert.deepEqual(t.map(r => r.pastMidnight), [false, true]);
    assert.equal(runSheetEnd("23:00", [{ durationMin: 75 }]), "12:15 AM");
  });
  test("the same input gives the same times whatever the process time zone is (no Date involved)", () => {
    const before = process.env.TZ;
    const a = JSON.stringify(computeRunSheetTimes("18:45", [{ durationMin: 400 }]));
    process.env.TZ = "Pacific/Kiritimati";
    const b = JSON.stringify(computeRunSheetTimes("18:45", [{ durationMin: 400 }]));
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    assert.equal(a, b);
    assert.match(a, /6:45 PM to 1:25 AM/);
  });
  test("editor parsing: ages and minutes", () => {
    assert.deepEqual(parseAges("5-12"), { ok: true, ageMin: 5, ageMax: 12 });
    assert.deepEqual(parseAges("5 to 12"), { ok: true, ageMin: 5, ageMax: 12 });
    assert.deepEqual(parseAges("8+"), { ok: true, ageMin: 8, ageMax: 100 });
    assert.deepEqual(parseAges("All"), { ok: true, ageMin: null, ageMax: null });
    for (const bad of ["12-5", "abc", "5", "5-101"]) assert.equal(parseAges(bad).ok, false, bad);
    assert.deepEqual(parseMinutes("45 min"), { ok: true, value: 45 });
    for (const bad of ["4", "481", "1.5", "x"]) assert.equal(parseMinutes(bad).ok, false, bad);
  });
});

describe("run-sheet ops", () => {
  test("add_activity appends, or inserts at a position or after a row; ages and supplies are cleaned", () => {
    const end = ok(run(arcadeBirthday, [{ op: "add_activity", name: "  Treasure hunt ", durationMin: 20, supplies: ["Clues", "clues", " Map "], ageMin: 6 }]));
    const row = ext(end).activities.at(-1)!;
    assert.deepEqual([row.name, row.durationMin, row.supplies, row.ageRange], ["Treasure hunt", 20, ["Clues", "Map"], [6, 100]]);
    assert.match(row.id, /^ac-treasure-hunt/);
    const cake = ext(arcadeBirthday).activities.findIndex(a => /cake/i.test(a.name));
    const first = ok(run(arcadeBirthday, [{ op: "add_activity", name: "Welcome drinks", durationMin: 15, position: 0 }]));
    assert.equal(names(first)[0], "Welcome drinks");
    const mid = ok(run(arcadeBirthday, [{ op: "add_activity", name: "Musical chairs", durationMin: 10, afterId: ext(arcadeBirthday).activities[0]!.id }]));
    assert.equal(names(mid)[1], "Musical chairs");
    const afterCake = ok(run(arcadeBirthday, [{ op: "add_activity", name: "Treasure hunt", durationMin: 20, afterId: ext(arcadeBirthday).activities[cake]!.id }]));
    assert.equal(names(afterCake)[cake + 1], "Treasure hunt");
    assert.equal(ext(arcadeBirthday).activities.length, 4, "the input plan is never mutated");
  });
  test("validation: name 1-80, minutes 5-480, ages 0-100 with min <= max, at most 10 supplies of 1-40 characters", () => {
    const bad: CommandInput[] = [
      { op: "add_activity", name: "", durationMin: 20 },
      { op: "add_activity", name: "x".repeat(81), durationMin: 20 },
      { op: "add_activity", name: "A", durationMin: 4 },
      { op: "add_activity", name: "A", durationMin: 481 },
      { op: "add_activity", name: "A", durationMin: 20.5 },
      { op: "add_activity", name: "A", durationMin: 20, ageMin: 12, ageMax: 5 },
      { op: "add_activity", name: "A", durationMin: 20, ageMax: 101 },
      { op: "add_activity", name: "A", durationMin: 20, ageMin: -1 },
      { op: "add_activity", name: "A", durationMin: 20, supplies: Array.from({ length: 11 }, (_, k) => `s${k}`) },
      { op: "add_activity", name: "A", durationMin: 20, supplies: ["y".repeat(41)] },
      { op: "add_activity", name: "A", durationMin: 20, supplies: ["  "] },
    ];
    for (const c of bad) assert.equal(Batch.safeParse({ summary: "x", commands: [c] }).success, false, JSON.stringify(c).slice(0, 80));
    assert.ok(run(arcadeBirthday, [{ op: "add_activity", name: "x".repeat(80), durationMin: 480, ageMin: 0, ageMax: 100, supplies: Array.from({ length: 10 }, (_, k) => `${"s".repeat(38)}${k}`) }]).ok, "the limits themselves are allowed");
    fail(run(arcadeBirthday, [{ op: "add_activity", name: "Pac-man HIGH-score tournament", durationMin: 20 }]), /already on the run-sheet/);
    fail(run(arcadeBirthday, [{ op: "add_activity", name: "A", durationMin: 20, position: 9 }]), /past the end/);
    fail(run(arcadeBirthday, [{ op: "add_activity", name: "A", durationMin: 20, afterId: "nope" }]), /No activity/);
    fail(run(arcadeBirthday, [{ op: "add_activity", name: "A", durationMin: 20, position: 0, afterId: ext(arcadeBirthday).activities[0]!.id }]), /not both/);
  });
  test("cap: 30 activities", () => {
    const full = withRows(ACTIVITY_LIMITS.maxActivities);
    fail(run(full, [{ op: "add_activity", name: "One more", durationMin: 10 }]), /30 activities/);
    assert.ok(run(withRows(29), [{ op: "add_activity", name: "Last one", durationMin: 10 }]).ok);
  });
  test("birthday only", () => {
    for (const st of [royalWedding, culturalFest]) {
      fail(run(st, [{ op: "add_activity", name: "A", durationMin: 20 }]), /birthday events only/);
      fail(run(st, [{ op: "set_party_start", time: "19:00" }]), /birthday events only/);
    }
  });
  test("update_activity edits name, minutes, ages (partial, cleared) and supplies", () => {
    const a = ext(arcadeBirthday).activities[0]!;
    const st = ok(run(arcadeBirthday, [{ op: "update_activity", activityId: a.id, name: "Pac-Man finals", durationMin: 50, ageMax: 50, supplies: ["Trophy", "trophy", "Scoreboard"] }]));
    const b = ext(st).activities[0]!;
    assert.deepEqual([b.id, b.name, b.durationMin, b.ageRange, b.supplies], [a.id, "Pac-Man finals", 50, [18, 50], ["Trophy", "Scoreboard"]]);
    const cleared = ok(run(st, [{ op: "update_activity", activityId: a.id, ageMin: null, ageMax: null }]));
    assert.equal(ext(cleared).activities[0]!.ageRange, undefined);
    const fresh = ok(run(cleared, [{ op: "update_activity", activityId: a.id, ageMin: 4 }]));
    assert.deepEqual(ext(fresh).activities[0]!.ageRange, [4, 100]);
    fail(run(st, [{ op: "update_activity", activityId: a.id, ageMin: 60 }]), /youngest age/);
    fail(run(st, [{ op: "update_activity", activityId: a.id, ageMin: null, ageMax: 30 }]), /both/);
    fail(run(st, [{ op: "update_activity", activityId: a.id, name: "80s costume contest" }]), /already on the run-sheet/);
    fail(run(st, [{ op: "update_activity", activityId: "missing", name: "X" }]), /No activity/);
    const same = run(st, [{ op: "update_activity", activityId: a.id, durationMin: 50 }]);
    assert.ok(same.ok && same.state === st && /unchanged/.test(same.log.join()), "a no-op changes nothing");
  });
  test("move_activity: up, down, to an index, and the edges", () => {
    const ids = ext(arcadeBirthday).activities.map(a => a.id);
    const up = ok(run(arcadeBirthday, [{ op: "move_activity", activityId: ids[2]!, direction: "up" }]));
    assert.deepEqual(ext(up).activities.map(a => a.id), [ids[0], ids[2], ids[1], ids[3]]);
    const down = ok(run(arcadeBirthday, [{ op: "move_activity", activityId: ids[0]!, direction: "down" }]));
    assert.deepEqual(ext(down).activities.map(a => a.id), [ids[1], ids[0], ids[2], ids[3]]);
    const to = ok(run(arcadeBirthday, [{ op: "move_activity", activityId: ids[3]!, index: 0 }]));
    assert.deepEqual(ext(to).activities.map(a => a.id), [ids[3], ids[0], ids[1], ids[2]]);
    fail(run(arcadeBirthday, [{ op: "move_activity", activityId: ids[0]!, direction: "up" }]), /already first/);
    fail(run(arcadeBirthday, [{ op: "move_activity", activityId: ids[3]!, direction: "down" }]), /already last/);
    fail(run(arcadeBirthday, [{ op: "move_activity", activityId: ids[0]!, index: 4 }]), /4 rows/);
    const stay = run(arcadeBirthday, [{ op: "move_activity", activityId: ids[1]!, index: 1 }]);
    assert.ok(stay.ok && stay.state === arcadeBirthday);
    assert.equal(Batch.safeParse({ summary: "x", commands: [{ op: "move_activity", activityId: ids[0], direction: "up", index: 2 }] }).success, false, "direction or index, not both");
    assert.equal(Batch.safeParse({ summary: "x", commands: [{ op: "move_activity", activityId: ids[0] }] }).success, false, "one of them is required");
    const one = withRows(1);
    fail(run(one, [{ op: "move_activity", activityId: ext(one).activities[0]!.id, direction: "down" }]), /already last/);
  });
  test("remove_activity and set_party_start", () => {
    const a = ext(arcadeBirthday).activities[1]!;
    const gone = ok(run(arcadeBirthday, [{ op: "remove_activity", activityId: a.id }]));
    assert.ok(!ext(gone).activities.some(x => x.id === a.id));
    fail(run(gone, [{ op: "remove_activity", activityId: a.id }]), /No activity/);
    const timed = run(arcadeBirthday, [{ op: "set_party_start", time: "19:00" }]);
    assert.ok(timed.ok);
    assert.equal(ext(timed.state).partyStart, "19:00");
    assert.match(timed.log.join(), /7:00 PM.*ends at 9:15 PM/);
    assert.equal(ext(arcadeBirthday).partyStart, null, "the sample's default is null");
    const off = ok(run(timed.state, [{ op: "set_party_start", time: null }]));
    assert.equal(ext(off).partyStart, null);
    for (const time of ["7pm", "24:00", "7:00", "19:5"]) assert.equal(Batch.safeParse({ summary: "x", commands: [{ op: "set_party_start", time }] }).success, false, time);
    const add = run(timed.state, [{ op: "add_activity", name: "Treasure hunt", durationMin: 20, position: 1 }]);
    assert.ok(add.ok);
    assert.match(add.log.join(), /7:45 PM to 8:05 PM/, "the log quotes the computed time");
  });
});

describe("run-sheet policy: organizer only, tiers, Co-Pilot exposure", () => {
  const a = ext(arcadeBirthday).activities[0]!;
  const all: CommandInput[] = [
    { op: "add_activity", name: "Treasure hunt", durationMin: 20 }, { op: "update_activity", activityId: a.id, durationMin: 40 },
    { op: "move_activity", activityId: a.id, direction: "down" }, { op: "remove_activity", activityId: a.id }, { op: "set_party_start", time: "19:00" },
  ];
  test("guests can never run them, from any door", () => {
    for (const op of ACTIVITY_OPS) { assert.ok(ORGANIZER_ONLY_OPS.has(op), op); assert.ok(!GUEST_ALLOWED_OPS.has(op as never), op); }
    for (const c of all) {
      for (const source of ["agent", "ui", "guest_link", "rsvp_link"] as const) {
        const r = run(arcadeBirthday, [c], { role: "guest", source, actorEntryId: null });
        assert.ok(!r.ok, `${c.op} as guest via ${source}`);
        if (!r.ok) assert.deepEqual(r.diagnostics.violations, ["role:guest"]);
      }
      fail(run(arcadeBirthday, [c], { source: "join" }), /join link/);
    }
  });
  test("tiers: add, update, move and the start time are Tier 0; remove is Tier 1; an AI proposal is always a card", () => {
    const parsed = Batch.parse({ summary: "x", commands: all }).commands;
    assert.deepEqual(parsed.map(commandTier), [0, 0, 0, 1, 0]);
    assert.equal(batchTier(parsed), 1);
    for (const c of parsed) assert.ok(agentBatchTier([c]) >= 1, c.op);
  });
  test("declared to Gemini (generated from the Zod source), with the run-sheet rule and computed times in the prompt", () => {
    const declared = JSON.stringify(functionDeclarations[0].parametersJsonSchema);
    for (const op of ACTIVITY_OPS) assert.ok(declared.includes(`"${op}"`), op);
    assert.ok(AgentBatch.safeParse({ summary: "x", commands: all }).success);
    const timed = ok(run(arcadeBirthday, [{ op: "set_party_start", time: "19:00" }]));
    const prompt = SYSTEM_PROMPT(timed, TODAY);
    assert.match(prompt, /Party run-sheet/);
    const line = prompt.split("\n").find(l => l.startsWith("RUN-SHEET"))!;
    assert.match(line, /party start 19:00, ends 9:15 PM/);
    assert.match(line, new RegExp(`#0 ${a.id} "Pac-Man high-score tournament" 45min 18-45 7:00 PM to 7:45 PM`));
    assert.match(SYSTEM_PROMPT(arcadeBirthday, TODAY), /RUN-SHEET \(4\/30 rows, total 135 min, party start not set;/);
  });
  test("the guest view and the public page never carry editing (and no run-sheet ops)", () => {
    const v = JSON.stringify(toGuestView(arcadeBirthday, arcadeBirthday.event.id, 1, null, "2026-10-26T00:00:00.000Z"));
    assert.ok(!/add_activity|update_activity|partyStart/.test(v));
  });
});

describe("approval card and undo", () => {
  test("the diff names each change with code-computed times, and routes to the Event page", () => {
    const timed = ok(run(arcadeBirthday, [{ op: "set_party_start", time: "19:00" }]));
    const cake = ext(timed).activities.find(x => /cake/i.test(x.name))!;
    const added = ok(run(timed, [{ op: "add_activity", name: "Treasure hunt", durationMin: 20, afterId: cake.id }]));
    const rows = computePlanDiff(timed, added).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.kind, rows[0]!.label, rows[0]!.after], ["activity", "Treasure hunt (new activity)", "row 5 · 9:15 PM to 9:35 PM · 20 min · all ages"]);
    assert.deepEqual(pagesForDiff(rows, "overview").map(p => p.id), ["event"]);
    const first = ext(timed).activities[0]!;
    const second = ext(timed).activities[1]!;
    const swapped = computePlanDiff(timed, ok(run(timed, [{ op: "move_activity", activityId: first.id, direction: "down" }]))).rows;
    assert.deepEqual(swapped.map(r => [r.label, r.before.split(" · ")[0], r.after.split(" · ")[0]]), [[second.name, "row 2", "row 1"], [first.name, "row 1", "row 2"]], "a swap lists both rows");
    assert.match(swapped[1]!.after, /^row 2 · 7:30 PM to 8:15 PM/, "with the new computed time");
    const long = computePlanDiff(timed, ok(run(timed, [{ op: "move_activity", activityId: first.id, index: 3 }]))).rows;
    assert.deepEqual(long.map(r => [r.label, r.before.split(" · ")[0], r.after.split(" · ")[0]]), [[first.name, "row 1", "row 4"]], "a long move lists only the row that moved");
    const removed = computePlanDiff(timed, ok(run(timed, [{ op: "remove_activity", activityId: first.id }]))).rows;
    assert.deepEqual(removed.map(r => [r.label, r.after]), [[`${first.name} (removed)`, "—"]]);
    const start = computePlanDiff(arcadeBirthday, timed).rows;
    assert.deepEqual(start.map(r => [r.label, r.before, r.after]), [["Party starts at", "not set", "7:00 PM"]]);
  });
  test("every op is pure: the previous state (the undo snapshot) is untouched and still valid", () => {
    const before = JSON.stringify(arcadeBirthday);
    const a = ext(arcadeBirthday).activities[0]!;
    ok(run(arcadeBirthday, [{ op: "add_activity", name: "Treasure hunt", durationMin: 20 }, { op: "update_activity", activityId: a.id, name: "Renamed" },
      { op: "move_activity", activityId: a.id, direction: "down" }, { op: "set_party_start", time: "20:00" }, { op: "remove_activity", activityId: a.id }]));
    assert.equal(JSON.stringify(arcadeBirthday), before);
  });
});

describe("adopt_idea for an activity", () => {
  const withIdeas = ok(run(arcadeBirthday, [{ op: "add_ideas", ideas: [
    { kind: "activity", title: "Magician show (45 minutes)", source: "demo", estLowPaise: 6_000_00, estHighPaise: 15_000_00, category: "entertainment" },
    { kind: "activity", title: "Treasure hunt with picture clues", source: "demo" },
    { kind: "decor", title: "Neon balloon arch", source: "demo" },
  ] }]));
  const [magic, hunt, decor] = withIdeas.ideas;
  test("creates the task AND a run-sheet row, in one batch (one undo step)", () => {
    const r = run(withIdeas, [{ op: "adopt_idea", ideaId: magic!.id }]);
    const st = ok(r);
    const i = st.ideas.find(x => x.id === magic!.id)!;
    assert.ok(i.adoptedTaskId && i.adoptedBudgetItemId && i.adoptedActivityId);
    const row = ext(st).activities.find(a => a.id === i.adoptedActivityId)!;
    assert.deepEqual([row.name, row.durationMin], ["Magician show (45 minutes)", 45], "minutes from the idea");
    assert.equal(ext(st).activities.length, ext(withIdeas).activities.length + 1);
    assert.ok(st.tasks.some(t => t.id === i.adoptedTaskId && /^Organise: Magician/.test(t.title)));
    assert.match(r.ok ? r.log.join(" | ") : "", /New run-sheet row "Magician show \(45 minutes\)" \(45 min\)/);
    // Undo is the snapshot before the batch: the task, the line and the row all go together.
    assert.ok(!ext(withIdeas).activities.some(a => a.id === i.adoptedActivityId) && !withIdeas.tasks.some(t => t.id === i.adoptedTaskId));
    assert.deepEqual(new Set(computePlanDiff(withIdeas, st).rows.map(x => x.kind)), new Set(["task_new", "budget_new", "idea", "activity"]));
    fail(run(st, [{ op: "adopt_idea", ideaId: magic!.id }]), /already in the plan/);
  });
  test("an idea that doesn't say how long gets the default 30 minutes; other kinds and other event types add no row", () => {
    const st = ok(run(withIdeas, [{ op: "adopt_idea", ideaId: hunt!.id }]));
    assert.equal(ext(st).activities.at(-1)!.durationMin, DEFAULT_ACTIVITY_MINUTES);
    const d = ok(run(withIdeas, [{ op: "adopt_idea", ideaId: decor!.id }]));
    assert.equal(ext(d).activities.length, ext(withIdeas).activities.length);
    assert.equal(d.ideas.find(x => x.id === decor!.id)!.adoptedActivityId, undefined);
    const w = ok(run(royalWedding, [{ op: "add_ideas", ideas: [{ kind: "activity", title: "Ring-in-the-pot game", source: "demo" }] }]));
    const wa = ok(run(w, [{ op: "adopt_idea", ideaId: w.ideas[0]!.id }]));
    assert.ok(wa.ideas[0]!.adoptedTaskId && !wa.ideas[0]!.adoptedActivityId);
  });
  test("a full run-sheet or a row of the same name still adopts the task, without a duplicate row", () => {
    const full = { ...withRows(30), ideas: withIdeas.ideas };
    const st = ok(run(full, [{ op: "adopt_idea", ideaId: hunt!.id }]));
    assert.equal(ext(st).activities.length, 30);
    const dupBase = ok(run(withIdeas, [{ op: "add_activity", name: "Treasure hunt with picture clues", durationMin: 25 }]));
    const dup = ok(run(dupBase, [{ op: "adopt_idea", ideaId: hunt!.id }]));
    assert.equal(ext(dup).activities.filter(a => a.name === "Treasure hunt with picture clues").length, 1);
  });
  test("ideaActivityMinutes reads minutes or hours and clamps to 5-480", () => {
    assert.equal(ideaActivityMinutes({ title: "Magician show (45 minutes)" }), 45);
    assert.equal(ideaActivityMinutes({ title: "Workshop", description: "A 2 hour clay session" }), 120);
    assert.equal(ideaActivityMinutes({ title: "Quick game", description: "2 min warm-up" }), 5);
    assert.equal(ideaActivityMinutes({ title: "Movie marathon 10 hours" }), 480);
    assert.equal(ideaActivityMinutes({ title: "Face painting" }), 30);
  });
  test("removing the adopted row clears the idea's link to it", () => {
    const st = ok(run(withIdeas, [{ op: "adopt_idea", ideaId: hunt!.id }]));
    const rowId = st.ideas.find(x => x.id === hunt!.id)!.adoptedActivityId!;
    const gone = ok(run(st, [{ op: "remove_activity", activityId: rowId }]));
    assert.equal(gone.ideas.find(x => x.id === hunt!.id)!.adoptedActivityId, null);
  });
});

describe("Demo Mode (offline) run-sheet intents", () => {
  test("'add a 20 minute treasure hunt after cake' → one add_activity approval card placed after the cake row", () => {
    const r = runOfflineAgent(arcadeBirthday, "add a 20 minute treasure hunt after cake", TODAY);
    assert.equal(r.actions.length, 1);
    const a = r.actions[0]! as { kind: string; tier: number; batch: { commands: CommandInput[] } };
    assert.equal(a.kind, "batch");
    assert.ok(a.tier >= 1, "an approval card, never auto-applied");
    const cake = ext(arcadeBirthday).activities.find(x => /cake/i.test(x.name))!;
    assert.deepEqual(a.batch.commands, [{ op: "add_activity", name: "Treasure hunt", durationMin: 20, afterId: cake.id }]);
    assert.match(r.reply, /Approve the card/);
    const applied = ok(applyBatch(arcadeBirthday, a.batch));
    const list = names(applied);
    assert.equal(list.indexOf("Treasure hunt"), list.indexOf(cake.name) + 1);
  });
  test("'before', a missing duration, an unknown anchor and non-birthday events", () => {
    const b = runOfflineAgent(arcadeBirthday, "add a 15 min musical chairs before the costume contest", TODAY);
    const cmd = (b.actions[0] as { batch: { commands: CommandInput[] } }).batch.commands[0]!;
    assert.deepEqual(cmd, { op: "add_activity", name: "Musical chairs", durationMin: 15, position: 1 });
    assert.match(runOfflineAgent(arcadeBirthday, "add activity: limbo", TODAY).reply, /How long should "limbo" run/);
    assert.match(runOfflineAgent(arcadeBirthday, "add a 10 minute limbo after the fireworks", TODAY).reply, /Which activity should it go after/);
    assert.equal(runOfflineAgent(royalWedding, "add a 20 minute treasure hunt after cake", TODAY).actions.filter(a => (a as { batch?: { commands: { op: string }[] } }).batch?.commands.some(c => c.op === "add_activity")).length, 0);
  });
  test("'the party starts at 7 pm' → set_party_start 19:00 (converted in code); an ambiguous hour asks", () => {
    const r = runOfflineAgent(arcadeBirthday, "the party starts at 7 pm", TODAY);
    assert.deepEqual((r.actions[0] as { batch: { commands: CommandInput[] } }).batch.commands, [{ op: "set_party_start", time: "19:00" }]);
    assert.match(runOfflineAgent(arcadeBirthday, "party starts at 7", TODAY).reply, /am or pm/);
    assert.deepEqual([clockToHHMM("7", "30", "pm"), clockToHHMM("12", undefined, "am"), clockToHHMM("12", undefined, "pm"), clockToHHMM("19", "15", undefined), clockToHHMM("07", undefined, undefined), clockToHHMM("7", undefined, undefined), clockToHHMM("13", undefined, "pm")],
      ["19:30", "00:00", "12:00", "19:15", "07:00", null, null]);
  });
});
