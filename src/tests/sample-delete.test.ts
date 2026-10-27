// Run: npm test. v8 Part 0d: samples are deletable too. Deleting a sample works like deleting an own event (confirm,
// Undo, Recently deleted); the slot is marked as a deleted sample until "Restore samples" / "Load sample events" brings
// a fresh copy back; deleting the last event opens the setup form (never a blank screen); the Co-Pilot's delete_event
// works on samples (Tier 2, organizer only); an untouched local sample is deleted without a cloud write.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.UTSAV_SILENT_LOGS = "1";
import { afterDeleteTarget, canDelete, decideTombstoneSync, moveToTrash, parseTrash, restoreFromTrash, restoreSamples, samplesHidden, serializeTrash } from "../trash";
import { hasNoEvents, isPristineSample, sampleRemoved, switcherSections, unmarkRemoved } from "../my-events";
import { freshHistory, historyOf, parseStore, serializeStore, type Store } from "../persistence";
import { instantiateTemplate, type TemplateId } from "../config/event-templates";
import { planHash, type CloudCopy } from "../cloud-sync";
import type { AgentState } from "../schema";
import { applyBatch } from "../commands";
import { commandTier } from "../trust";
import { runOfflineAgent, runOfflineGuestAgent } from "../offline";
import { plannerSource } from "./planner-source";

const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const NOW = Date.parse("2026-10-25T16:30:00Z");
const TODAY = "2026-10-25";
const own = (slot: TemplateId, title: string, id = "ev-mine"): AgentState => { const p = instantiateTemplate(slot); return { ...p, event: { ...p.event, id, title } }; };
const renamed = (p: AgentState, title: string): AgentState => ({ ...p, event: { ...p.event, title } });
const storeWith = (entries: Partial<Record<TemplateId, AgentState[]>>, active: TemplateId, removedSamples?: TemplateId[]): Store => {
  const byType: Store["byType"] = {};
  for (const [slot, plans] of Object.entries(entries) as [TemplateId, AgentState[]][]) byType[slot] = { snaps: plans.map((plan, i) => ({ plan, label: `step ${i}` })), idx: plans.length - 1 };
  return { active, byType, ...(removedSamples ? { removedSamples } : {}) };
};
const cur = (s: Store, slot: TemplateId) => { const h = historyOf(s, slot); return h.snaps[h.idx]!.plan; };
const all = (): TemplateId[] => ["wedding", "birthday", "community"];

describe("deleting a sample (pure)", () => {
  test("a pristine or edited sample moves to the trash like an own event, and the slot is marked as a deleted sample", () => {
    const edited = renamed(instantiateTemplate("wedding"), "Edited sample");
    const s = storeWith({ wedding: [instantiateTemplate("wedding"), edited], birthday: [instantiateTemplate("birthday")] }, "wedding");
    const r = moveToTrash(s, "wedding", NOW)!;
    assert.ok(r);
    assert.equal(r.item.title, "Edited sample");
    assert.equal(r.item.eventId, instantiateTemplate("wedding").event.id);
    assert.equal(r.item.history.snaps.length, 2, "the sample's history goes with it (Undo after Restore)");
    assert.deepEqual(r.store.removedSamples, ["wedding"]);
    assert.ok(sampleRemoved(r.store, "wedding"));
    // Not listed under Samples any more; the others still are.
    const sec = switcherSections(r.store);
    assert.deepEqual(sec.samples.map(e => e.slot), ["birthday", "community"]);
    assert.deepEqual(sec.removed, ["wedding"]);
    // Its placeholder (still the active slot) can't be deleted again.
    assert.equal(canDelete("wedding", cur(r.store, "wedding"), r.store), false);
    assert.equal(moveToTrash(r.store, "wedding", NOW + 1), null);
  });
  test("a sample slot never opened (nothing stored) can be deleted too; a deleted one can't be deleted again", () => {
    const r = moveToTrash(storeWith({}, "wedding"), "community", NOW)!;
    assert.ok(r);
    assert.deepEqual(r.store.removedSamples, ["community"]);
    assert.equal(moveToTrash(r.store, "community", NOW + 1), null);
  });
  test("the local-only mark survives storage; Undo, Restore and Delete forever then leave the cloud alone", () => {
    const r = moveToTrash(storeWith({ wedding: [instantiateTemplate("wedding")] }, "wedding"), "wedding", NOW)!;
    const [back] = parseTrash(serializeTrash([{ ...r.item, localOnly: true }]));
    assert.equal(back?.localOnly, true);
    assert.equal(parseTrash(serializeTrash([r.item]))[0]?.localOnly, undefined);
    const app = plannerSource();
    assert.match(app, /if \(!r\.item\.localOnly\) cloud\.markRestored\(/);
    assert.match(app, /if \(!item\.localOnly\) void cloud\.deleteForever\(/);
    assert.match(app, /if \(!i\.localOnly\) void cloudDeleteForever\(/);
  });
  test("deleting an own event never marks the slot: its sample is listed again (Part 0c behaviour kept)", () => {
    const s = storeWith({ birthday: [own("birthday", "Kiran turns 8")] }, "birthday");
    const r = moveToTrash(s, "birthday", NOW)!;
    assert.equal(r.store.removedSamples, undefined);
    assert.ok(switcherSections(r.store).samples.some(e => e.slot === "birthday"));
  });
  test("Undo / Restore puts the sample back, listed and active, and clears the mark", () => {
    const s = storeWith({ wedding: [instantiateTemplate("wedding")], birthday: [instantiateTemplate("birthday")] }, "wedding");
    const del = moveToTrash(s, "wedding", NOW)!;
    const r = restoreFromTrash({ ...del.store, active: "birthday" }, [del.item], del.item.id);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.store.active, "wedding");
    assert.equal(r.store.removedSamples, undefined);
    assert.ok(isPristineSample("wedding", cur(r.store, "wedding")));
    assert.ok(switcherSections(r.store).samples.some(e => e.slot === "wedding"));
  });
  test("restoring a sample while an own event uses the slot is refused with a reason", () => {
    const s = storeWith({ wedding: [instantiateTemplate("wedding")] }, "wedding");
    const del = moveToTrash(s, "wedding", NOW)!;
    const taken = unmarkRemoved({ ...del.store, byType: { ...del.store.byType, wedding: { snaps: [{ plan: own("wedding", "Ours"), label: "x" }], idx: 0 } } }, "wedding");
    const r = restoreFromTrash(taken, [del.item], del.item.id);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "occupied");
  });
});

describe("where the planner goes after a delete", () => {
  test("own events first; after a sample, the next listed sample; the last own event → setup; nothing left → empty", () => {
    const withOwn = moveToTrash(storeWith({ wedding: [instantiateTemplate("wedding")], community: [own("community", "Fest", "ev-c")] }, "wedding"), "wedding", NOW)!;
    assert.deepEqual(afterDeleteTarget(withOwn.store, "wedding", true), { kind: "switch", slot: "community" });
    const samplesOnly = moveToTrash(storeWith({ wedding: [instantiateTemplate("wedding")] }, "wedding"), "wedding", NOW)!;
    assert.deepEqual(afterDeleteTarget(samplesOnly.store, "wedding", true), { kind: "switch", slot: "birthday" });
    const lastOwn = moveToTrash(storeWith({ wedding: [own("wedding", "Ours")] }, "wedding"), "wedding", NOW)!;
    assert.deepEqual(afterDeleteTarget(lastOwn.store, "wedding", false), { kind: "setup" });
    const last = moveToTrash(storeWith({ wedding: [instantiateTemplate("wedding")] }, "wedding", ["birthday", "community"]), "wedding", NOW)!;
    assert.deepEqual(afterDeleteTarget(last.store, "wedding", true), { kind: "empty" });
    assert.ok(hasNoEvents(last.store));
    assert.equal(hasNoEvents(samplesOnly.store), false);
    // The last own event when every sample was deleted: also empty, never a blank page.
    const ownLast = moveToTrash(storeWith({ wedding: [own("wedding", "Ours")] }, "wedding", ["birthday", "community"]), "wedding", NOW)!;
    assert.deepEqual(afterDeleteTarget({ ...ownLast.store, removedSamples: all() }, "wedding", false), { kind: "empty" });
  });
});

describe("Restore samples / Load sample events", () => {
  test("every deleted sample comes back as a fresh copy; a slot an own event took is left alone", () => {
    const s = storeWith({ wedding: [own("wedding", "Ours")], birthday: [renamed(instantiateTemplate("birthday"), "edited then deleted")] }, "wedding", ["birthday", "community", "wedding"]);
    const r = restoreSamples(s);
    assert.deepEqual(r.restored, ["birthday", "community"]);
    assert.equal(r.store.removedSamples, undefined);
    assert.ok(isPristineSample("birthday", cur(r.store, "birthday")));
    assert.ok(isPristineSample("community", cur(r.store, "community")));
    assert.equal(cur(r.store, "wedding").event.title, "Ours");
    assert.deepEqual(switcherSections(r.store).samples.map(e => e.slot), ["birthday", "community"]);
    // Nothing deleted: nothing to do.
    assert.deepEqual(restoreSamples(storeWith({}, "wedding")).restored, []);
  });
  test("hidden samples are part of it: Hide samples only applies while an own event exists, and the app clears it", () => {
    assert.equal(samplesHidden(true, 0), false);
    const app = plannerSource();
    assert.match(app, /const bringSamplesBack = \(\): TemplateId\[\] => \{[\s\S]*?if \(hidePref\) \{ setHidePref\(false\); saveHideSamples\(false\); \}/);
    assert.match(app, /const loadSampleEvents = \(\) => \{\s*rememberChoice\("samples"\);[\s\S]*?bringSamplesBack\(\);/);
    assert.match(app, /const samplesMissing = events\.removed\.length > 0 \|\| hideSamples === true;/);
  });
  test("fresh copies of samples that were in the account are saved over their tombstone (markRestored)", () => {
    const app = plannerSource();
    assert.match(app, /for \(const slot of r\.restored\) cloud\.markRestored\(slot, historyOf\(r\.store, slot\)\.snaps\[0\]!\.plan\);/);
  });
});

describe("storage: the deleted-sample mark", () => {
  test("round-trips, keeps registry order, drops unknown ids, and is absent when empty (older builds ignore it)", () => {
    const s = storeWith({ birthday: [instantiateTemplate("birthday")] }, "birthday", ["community", "wedding"]);
    const back = parseStore(serializeStore(s));
    assert.deepEqual(back.removedSamples, ["wedding", "community"]);
    const raw = JSON.parse(serializeStore(s)) as Record<string, unknown>;
    raw.removedSamples = ["wedding", "nope", "__proto__", 3];
    assert.deepEqual(parseStore(JSON.stringify(raw)).removedSamples, ["wedding"]);
    assert.equal("removedSamples" in JSON.parse(serializeStore(storeWith({}, "wedding"))), false);
  });
  test("anything landing in a slot clears its mark (setHist), and unmarkRemoved drops the field when empty", () => {
    const s = storeWith({}, "wedding", ["wedding"]);
    assert.equal(unmarkRemoved(s, "wedding").removedSamples, undefined);
    assert.deepEqual(unmarkRemoved({ ...s, removedSamples: ["wedding", "birthday"] }, "wedding").removedSamples, ["birthday"]);
    assert.equal(unmarkRemoved(s, "birthday"), s);
    // An own event in a marked slot is listed (the mark only hides a sample).
    const withOwn = { ...s, byType: { wedding: { snaps: [{ plan: own("wedding", "Ours"), label: "x" }], idx: 0 } } };
    assert.equal(sampleRemoved(withOwn, "wedding"), false);
    assert.deepEqual(switcherSections(withOwn).mine.map(e => e.slot), ["wedding"]);
    assert.match(plannerSource(), /const setHist = \(h: History, t: TemplateId = storeRef\.current\.active\) => setStore\(unmarkRemoved\(/);
  });
  test("a fresh slot history is still the sample (nothing else changes for slots without a mark)", () => {
    assert.equal(planHash(freshHistory("community").snaps[0]!.plan), planHash(instantiateTemplate("community")));
  });
});

describe("cloud: samples take the Part 0c tombstone path; untouched local samples never write", () => {
  const sample = instantiateTemplate("wedding");
  const D = "2026-10-25T09:00:00.000Z";
  const copy = (plan: AgentState, version: number, deletedAt?: string): CloudCopy => ({ plan, version, updatedAt: D, ...(deletedAt ? { deletedAt } : {}) });
  test("another device deleted the account's sample: an untouched sample here goes too (nothing to keep)", () => {
    const edited = renamed(sample, "Synced edit");
    assert.deepEqual(decideTombstoneSync({ local: sample, localPristine: true, cloud: copy(edited, 4, D), base: null, pending: null }), { kind: "remove_local", deletedAt: D });
    // Unsynced edits to the sample here are still asked about.
    assert.deepEqual(decideTombstoneSync({ local: renamed(sample, "Mine"), localPristine: false, cloud: copy(edited, 4, D), base: null, pending: null }), { kind: "choose", reason: "deleted_elsewhere" });
    // A fresh copy brought back by Restore samples (pending restore) is saved over the tombstone, not removed.
    assert.deepEqual(decideTombstoneSync({ local: sample, localPristine: true, cloud: copy(edited, 4, D), base: null, pending: { kind: "restore", eventId: sample.event.id } }), { kind: "restore", baseVersion: 4 });
  });
  test("the app skips the cloud for an untouched sample that never went to the account, and the hook never syncs a placeholder", () => {
    const app = plannerSource();
    assert.match(app, /const localOnly = isPristineSample\(slot, deleted\) && !\(account && \(firstChoice === "samples" \|\| loadSyncBase\(account, slot\)\)\);/);
    assert.match(app, /if \(!localOnly\) cloud\.markDeleted\(slot, deleted\);/);
    assert.match(app, /isRemoved: k => isTemplateId\(k\) && sampleRemoved\(storeRef\.current, k\)/);
    const hook = src("../components/useCloudSync.ts");
    assert.match(hook, /if \(hooksRef\.current\.isRemoved\?\.\(key\)\) \{ void sendPendingDelete\(key\); setStatus\(\{ state: "sample" \}\); return; \}/);
    assert.match(hook, /if \(!u \|\| cloudOff\.current \|\| hooksRef\.current\.isRemoved\?\.\(keyRef\.current\)\) return;/);
  });
});

describe("Co-Pilot delete_event on a sample", () => {
  test("offline: a Tier 2 card for the sample on screen; the reducer changes nothing; guests are refused", () => {
    const st = instantiateTemplate("birthday");
    const out = runOfflineAgent(st, "delete this event", TODAY);
    const card = out.actions.find(a => a.kind === "batch");
    assert.ok(card && card.kind === "batch");
    if (!card || card.kind !== "batch") return;
    assert.deepEqual(card.batch.commands.map(c => c.op), ["delete_event"]);
    assert.equal(commandTier({ op: "delete_event" }), 2);
    const r = applyBatch(st, { summary: "Delete", commands: [{ op: "delete_event" }] }, { role: "organizer", source: "agent" });
    assert.ok(r.ok);
    if (r.ok) assert.equal(planHash(r.state), planHash(st));
    const g = runOfflineGuestAgent(st, "delete this event", TODAY, st.guests[0]?.id ?? null);
    assert.ok(!g.actions.some(a => a.kind === "batch" && a.batch.commands.some(c => c.op === "delete_event")));
  });
  test("approving the card opens the same confirm for samples (no 'use Reset sample' refusal any more)", () => {
    const app = plannerSource();
    assert.doesNotMatch(app, /use Reset sample on the Overview instead/);
    assert.match(app, /requestDelete\(storeRef\.current\.active, ok =>/);
  });
});

describe("UI (static)", () => {
  test("event menu: every sample row has its Delete; Restore samples is a menuitem; the empty state reads No events", () => {
    const bar = src("../components/CommandBar.tsx");
    assert.doesNotMatch(bar, /if \(sample\) return radio;/);
    assert.match(bar, /data-testid="event-restore-samples"/);
    assert.match(bar, /title=\{empty \? "No events" : plan\.event\.title\}/);
  });
  test("nothing left: the setup form says so and offers Restore samples; tabs and the Co-Pilot launcher are hidden", () => {
    const pages = src("../components/PlannerPages.tsx");
    assert.match(pages, /data-testid="no-events"/);
    assert.match(pages, /data-testid="setup-restore-samples"/);
    const app = plannerSource();
    assert.match(app, /if \(noEvents && opening === "plan" && !isSetupPath\(pathRef\.current\)\) router\.replace\(SETUP_PATH\)/);
    assert.match(app, /\{!noEvents && <CopilotLauncher/);
  });
});
