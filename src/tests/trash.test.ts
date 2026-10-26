// Run: npm test. v8 Part 0c: delete event (soft delete). The trash and purge logic, the cloud tombstone decision, the
// cloud handler's tombstone and DELETE, firestore.rules, the delete_event op (tier, guests, the AI), guest links of a
// deleted event (410), and the new UI pieces statically from their source.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.UTSAV_SILENT_LOGS = "1";
import {
  canDelete, daysLeft, decideTombstoneSync, mayDeleteForever, moveToTrash, nextActiveAfterDelete, parseTrash, purgeExpired, restoreFromTrash, samplesHidden,
  serializeTrash, TRASH_KEY, TRASH_RETENTION_MS, CLOUD_PENDING_KEY, UNDO_MS, type TrashItem, type TombstoneInput,
} from "../trash";
import { freshHistory, historyOf, type Store } from "../persistence";
import { instantiateTemplate, type TemplateId } from "../config/event-templates";
import { planHash, statusLabel, shouldAutosave, tombstoneCloudCopy, deleteCloudCopy, fetchCloudCopy, type CloudCopy } from "../cloud-sync";
import { DEVICE_PLAN_KEYS } from "../signin";
import type { AgentState } from "../schema";
import { AgentBatch, applyBatch, Batch, GUEST_ALLOWED_OPS, ORGANIZER_ONLY_OPS } from "../commands";
import { agentBatchTier, batchTier, commandTier } from "../trust";
import { executeAgentTool } from "../agent";
import { functionDeclarations, guestFunctionDeclarations } from "../gemini-tools";
import { DELETE_EVENT_RE, runOfflineAgent, runOfflineGuestAgent } from "../offline";
import { handleCloudDelete, handleCloudGet, handleCloudSave, type CloudDeps } from "../server/cloud-handler";
import { CLOUD_DOC_FIELDS, FirestoreRestRepo, MemoryCloudRepo, fromFirestore, toFirestoreFields } from "../server/cloud-repo";
import { MemoryStore, setStoreForTests } from "../server/store";
import { createSharedEvent, getGuestView, getOrganizerEvent, postGuestActions, postRsvp, putOrganizerEvent, REMOVED_MESSAGE, setOrganizerEventRemoved } from "../server/events";
import { royalWedding } from "../presets";

const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-25T12:00:00Z");
const own = (slot: TemplateId, title: string, id = "ev-mine"): AgentState => { const p = instantiateTemplate(slot); return { ...p, event: { ...p.event, id, title } }; };
const renamed = (p: AgentState, title: string): AgentState => ({ ...p, event: { ...p.event, title } });
const storeWith = (entries: Partial<Record<TemplateId, AgentState[]>>, active: TemplateId): Store => {
  const byType: Store["byType"] = {};
  for (const [slot, plans] of Object.entries(entries) as [TemplateId, AgentState[]][]) byType[slot] = { snaps: plans.map((plan, i) => ({ plan, label: `step ${i}` })), idx: plans.length - 1 };
  return { active, byType };
};
const cur = (s: Store, slot: TemplateId) => { const h = historyOf(s, slot); return h.snaps[h.idx]!.plan; };

describe("trash: move, restore, purge (pure)", () => {
  test("every event can be deleted, samples included (v8 Part 0d); a never-stored slot has nothing to delete", () => {
    assert.equal(canDelete("wedding", own("wedding", "Our wedding")), true);
    assert.equal(canDelete("wedding", instantiateTemplate("wedding")), true);
    assert.equal(canDelete("wedding", renamed(instantiateTemplate("wedding"), "Edited sample")), true);
    const s = storeWith({ wedding: [renamed(instantiateTemplate("wedding"), "Edited sample")] }, "wedding");
    assert.ok(moveToTrash(s, "wedding", NOW));
    // A sample slot never opened (nothing stored) holds the untouched sample: deletable too.
    assert.equal(moveToTrash(storeWith({}, "wedding"), "birthday", NOW)?.item.slot, "birthday");
  });
  test("moving to the trash keeps the history (≤ 10 steps up to the current one) and leaves the slot's untouched sample", () => {
    const steps = Array.from({ length: 14 }, (_, i) => own("birthday", `Party v${i}`));
    const s = storeWith({ birthday: steps, wedding: [own("wedding", "Wedding")] }, "birthday");
    const r = moveToTrash(s, "birthday", NOW, { eventId: "E".repeat(22), organizerToken: "t".repeat(43), version: 3, invites: [] })!;
    assert.ok(r);
    assert.equal(r.item.title, "Party v13");
    assert.equal(r.item.slot, "birthday");
    assert.equal(r.item.eventId, "ev-mine");
    assert.equal(r.item.deletedAt, NOW);
    assert.equal(r.item.id, `ev-mine@${NOW}`);
    assert.equal(r.item.history.snaps.length, 10);
    assert.equal(r.item.history.snaps[r.item.history.idx]!.plan.event.title, "Party v13");
    assert.equal(r.item.share?.version, 3);
    // Still the active slot: a fresh sample takes its place. The other slots are untouched.
    assert.equal(planHash(cur(r.store, "birthday")), planHash(instantiateTemplate("birthday")));
    assert.equal(cur(r.store, "wedding").event.title, "Wedding");
    // Not the active slot: the key is dropped (historyOf falls back to the sample).
    const r2 = moveToTrash({ ...s, active: "wedding" }, "birthday", NOW)!;
    assert.equal(r2.store.byType.birthday, undefined);
  });
  test("redo steps past the current one are not kept (the trash holds what was on screen)", () => {
    const s = storeWith({ community: [own("community", "A"), own("community", "B"), own("community", "C")] }, "community");
    s.byType.community!.idx = 1;
    const r = moveToTrash(s, "community", NOW)!;
    assert.deepEqual(r.item.history.snaps.map(x => x.plan.event.title), ["A", "B"]);
    assert.equal(r.item.title, "B");
  });
  test("restore: back in its slot and active; an untouched sample is replaced, an edited one stays one Undo away", () => {
    const s = storeWith({ wedding: [own("wedding", "Ours")] }, "wedding");
    const del = moveToTrash(s, "wedding", NOW)!;
    const r = restoreFromTrash({ ...del.store, active: "birthday" }, [del.item], del.item.id);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.store.active, "wedding");
    assert.equal(cur(r.store, "wedding").event.title, "Ours");
    assert.deepEqual(r.items, []);
    // The sample was edited after the delete: it stays in the history.
    const edited = { ...del.store, byType: { ...del.store.byType, wedding: { snaps: [...freshHistory("wedding").snaps, { plan: renamed(instantiateTemplate("wedding"), "Sample edit"), label: "x" }], idx: 1 } } };
    const r2 = restoreFromTrash(edited, [del.item], del.item.id);
    assert.ok(r2.ok);
    if (!r2.ok) return;
    const h = r2.store.byType.wedding!;
    assert.equal(h.snaps[h.idx]!.plan.event.title, "Ours");
    assert.equal(h.snaps[h.idx - 1]!.plan.event.title, "Sample edit");
  });
  test("restore is refused while another own event uses the slot (one event per type), and for an unknown id", () => {
    const s = storeWith({ wedding: [own("wedding", "First")] }, "wedding");
    const del = moveToTrash(s, "wedding", NOW)!;
    const taken = { ...del.store, byType: { ...del.store.byType, wedding: { snaps: [{ plan: own("wedding", "Second", "ev-2"), label: "x" }], idx: 0 } } };
    const r = restoreFromTrash(taken, [del.item], del.item.id);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.reason, "occupied"); assert.match(r.message, /"Second" uses the wedding place/); }
    const m = restoreFromTrash(del.store, [del.item], "nope");
    assert.equal(m.ok, false);
    if (!m.ok) assert.equal(m.reason, "missing");
  });
  test("purge: items 30 days old or more go; the rest stay, newest first; days left counts down", () => {
    const item = (id: string, at: number) => ({ id, deletedAt: at }) as TrashItem;
    const { kept, purged } = purgeExpired([item("a", NOW - 29 * DAY), item("b", NOW - 30 * DAY), item("c", NOW - 1000), item("d", NOW - 45 * DAY)], NOW);
    assert.deepEqual(kept.map(i => i.id), ["c", "a"]);
    assert.deepEqual(purged.map(i => i.id).sort(), ["b", "d"]);
    assert.equal(TRASH_RETENTION_MS, 30 * DAY);
    assert.equal(daysLeft({ deletedAt: NOW }, NOW), 30);
    assert.equal(daysLeft({ deletedAt: NOW - 29.5 * DAY }, NOW), 1);
    assert.equal(daysLeft({ deletedAt: NOW - 31 * DAY }, NOW), 0);
    assert.equal(UNDO_MS, 10_000);
  });
  test("after a delete: another own event (registry order), or null (the setup form)", () => {
    const s = storeWith({ wedding: [own("wedding", "W")], birthday: [instantiateTemplate("birthday")], community: [own("community", "C", "ev-c")] }, "wedding");
    assert.equal(nextActiveAfterDelete(s, "wedding"), "community");
    assert.equal(nextActiveAfterDelete(s, "community"), "wedding");
    assert.equal(nextActiveAfterDelete(storeWith({ wedding: [own("wedding", "W")] }, "wedding"), "wedding"), null);
  });
  test("samples are hidden only on request and only while an own event exists", () => {
    assert.equal(samplesHidden(true, 1), true);
    assert.equal(samplesHidden(true, 0), false);
    assert.equal(samplesHidden(false, 2), false);
  });
  test("the stored trash is re-validated on load; anything malformed is dropped", () => {
    const del = moveToTrash(storeWith({ wedding: [own("wedding", "Ours")] }, "wedding"), "wedding", NOW)!;
    const back = parseTrash(serializeTrash([del.item]));
    assert.equal(back.length, 1);
    assert.equal(back[0]!.title, "Ours");
    assert.equal(back[0]!.id, del.item.id);
    for (const bad of [null, "", "{", "[]", JSON.stringify({ v: 2, items: [] }), JSON.stringify({ v: 1, items: [{ slot: "nope", deletedAt: 1, history: del.item.history }] }),
      JSON.stringify({ v: 1, items: [{ slot: "wedding", deletedAt: "x", history: del.item.history }] }),
      JSON.stringify({ v: 1, items: [{ slot: "wedding", deletedAt: 1, history: { snaps: [{ plan: { nope: 1 } }], idx: 0 } }] })])
      assert.deepEqual(parseTrash(bad), [], String(bad));
  });
  test("signing out with 'remove from this device' clears the trash and the owed cloud deletions too", () => {
    for (const k of [TRASH_KEY, CLOUD_PENDING_KEY]) assert.ok((DEVICE_PLAN_KEYS as readonly string[]).includes(k), k);
  });
});

describe("cloud tombstone decision (pure)", () => {
  const mine = own("wedding", "Ours");
  const sample = instantiateTemplate("wedding");
  const copy = (plan: AgentState, version: number, deletedAt?: string): CloudCopy => ({ plan, version, updatedAt: "2026-10-25T10:00:00Z", ...(deletedAt ? { deletedAt } : {}) });
  const D = "2026-10-25T09:00:00.000Z";
  const base = (plan: AgentState, version: number) => ({ version, hash: planHash(plan) });
  const decide = (i: Partial<TombstoneInput>) => decideTombstoneSync({ local: mine, localPristine: false, cloud: null, base: null, pending: null, ...i });

  test("no cloud copy, or a live one with nothing owed: nothing tombstone-related", () => {
    assert.deepEqual(decide({}), { kind: "none" });
    assert.deepEqual(decide({ cloud: copy(mine, 2) }), { kind: "none" });
  });
  test("deleted elsewhere, nothing new here → remove the local copy (to its trash), with the cloud's deletion time", () => {
    assert.deepEqual(decide({ cloud: copy(mine, 3, D) }), { kind: "remove_local", deletedAt: D });
    const edited = renamed(mine, "Edited and synced");
    assert.deepEqual(decide({ local: edited, cloud: copy(mine, 3, D), base: base(edited, 2) }), { kind: "remove_local", deletedAt: D });
  });
  test("deleted elsewhere but this device has edits the cloud never saw → ask (never resurrect silently, never drop the edits)", () => {
    const edited = renamed(mine, "Unsynced edit");
    assert.deepEqual(decide({ local: edited, cloud: copy(mine, 3, D), base: base(mine, 2) }), { kind: "choose", reason: "deleted_elsewhere" });
    assert.deepEqual(decide({ local: edited, cloud: copy(mine, 3, D), base: null }), { kind: "choose", reason: "deleted_elsewhere" });
  });
  test("restored here → save over the tombstone on its version", () => {
    assert.deepEqual(decide({ cloud: copy(mine, 4, D), pending: { kind: "restore", eventId: mine.event.id } }), { kind: "restore", baseVersion: 4 });
  });
  test("deleted here while offline: tombstone when the cloud copy is still the version this device knew, else ask", () => {
    const p = { kind: "delete" as const, eventId: mine.event.id, baseVersion: 5 };
    assert.deepEqual(decide({ local: sample, localPristine: true, cloud: copy(mine, 5), pending: p }), { kind: "send_tombstone", baseVersion: 5 });
    assert.deepEqual(decide({ local: sample, localPristine: true, cloud: copy(renamed(mine, "edited elsewhere"), 6), pending: p }), { kind: "choose", reason: "edited_elsewhere" });
    assert.deepEqual(decide({ local: sample, localPristine: true, cloud: copy(mine, 5), pending: { ...p, baseVersion: null } }), { kind: "choose", reason: "edited_elsewhere" });
  });
  test("an old event's tombstone: an untouched sample stays local; anything worth keeping replaces it", () => {
    assert.deepEqual(decide({ local: sample, localPristine: true, cloud: copy(mine, 7, D) }), { kind: "keep_local_only" });
    assert.deepEqual(decide({ local: own("wedding", "New one", "ev-new"), cloud: copy(mine, 7, D) }), { kind: "replace", baseVersion: 7 });
    assert.deepEqual(decide({ local: renamed(sample, "Edited sample"), cloud: copy(mine, 7, D) }), { kind: "replace", baseVersion: 7 });
  });
  test("delete forever only removes this event's tombstone, never a live copy or a newer event", () => {
    assert.equal(mayDeleteForever(copy(mine, 3, D), mine.event.id), true);
    assert.equal(mayDeleteForever(copy(mine, 3), mine.event.id), false);
    assert.equal(mayDeleteForever(copy(own("wedding", "x", "ev-other"), 3, D), mine.event.id), false);
    assert.equal(mayDeleteForever(null, mine.event.id), false);
  });
  test("the chooser blocks autosave and has its own status line", () => {
    const s = { state: "choose_deleted", cloud: copy(mine, 3, D), reason: "deleted_elsewhere" } as const;
    assert.equal(shouldAutosave(s, mine, null), false);
    assert.match(statusLabel(s), /Deleted on another device/);
    assert.match(statusLabel({ ...s, reason: "edited_elsewhere" }), /Edited on another device/);
  });
});

describe("cloud API client: tombstone and delete forever", () => {
  const TOKEN = "x.y.z";
  const fake = (status: number, json: unknown, seen: { url?: string; init?: RequestInit }[] = []) =>
    (async (url: string, init?: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify(json), { status }); }) as unknown as typeof fetch;
  test("tombstone is a PUT { deleted: true, baseVersion }; delete forever is a DELETE with ?baseVersion&eventId", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    assert.deepEqual(await tombstoneCloudCopy("wedding", TOKEN, 3, fake(200, { version: 4, updatedAt: "u" }, seen)), { kind: "ok", version: 4, updatedAt: "u" });
    assert.equal(seen[0]!.init!.method, "PUT");
    assert.deepEqual(JSON.parse(String(seen[0]!.init!.body)), { deleted: true, baseVersion: 3 });
    assert.equal((await deleteCloudCopy("wedding", TOKEN, 4, "ev-1", fake(200, { deleted: true }, seen))).kind, "copy");
    assert.equal(seen[1]!.init!.method, "DELETE");
    assert.equal(seen[1]!.url, "/api/cloud/plans/wedding?baseVersion=4&eventId=ev-1");
    assert.equal((await tombstoneCloudCopy("wedding", TOKEN, 3, fake(409, { current: null, currentVersion: 5 }))).kind, "conflict");
    assert.equal((await deleteCloudCopy("wedding", TOKEN, 4, "e", fake(401, {}))).kind, "unauthorized");
  });
  test("a fetched tombstone carries deletedAt", async () => {
    const r = await fetchCloudCopy("wedding", TOKEN, fake(200, { version: 2, updatedAt: "u", plan: royalWedding, deletedAt: "2026-10-25T09:00:00.000Z" }));
    assert.ok(r.kind === "copy" && r.copy?.deletedAt === "2026-10-25T09:00:00.000Z");
  });
});

// ---------- server: tombstone PUT and DELETE ----------
const TOKEN_A = `${"a".repeat(20)}.${"userA".repeat(8)}.${"s".repeat(30)}`;
const TOKEN_B = `${"b".repeat(20)}.${"userB".repeat(8)}.${"t".repeat(30)}`;
const verifyToken = async (t: string) => { if (t === TOKEN_A) return { uid: "uid_A" }; if (t === TOKEN_B) return { uid: "uid_B" }; throw Object.assign(new Error("bad"), { code: "x" }); };
function setup() {
  const repo = new MemoryCloudRepo();
  const deps: CloudDeps = { verifyToken, repo, store: new MemoryStore(), now: () => new Date("2026-10-25T09:00:00Z"), log: () => {} };
  return { deps, repo };
}
const req = (method: string, token: string | null, body?: unknown, query = "") =>
  new Request(`http://localhost/api/cloud/plans/wedding${query}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const b = (r: { body: unknown }) => r.body as Record<string, unknown>;

describe("cloud API: tombstone (PUT { deleted: true }) and delete forever (DELETE)", () => {
  test("tombstone keeps the plan, bumps the version, and GET returns deletedAt; a normal save restores (clears it)", async () => {
    const { deps, repo } = setup();
    assert.equal((await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps)).status, 200);
    const t = await handleCloudSave(req("PUT", TOKEN_A, { deleted: true, baseVersion: 1 }), "wedding", deps);
    assert.equal(t.status, 200);
    assert.equal(b(t).version, 2);
    assert.equal(b(t).deletedAt, "2026-10-25T09:00:00.000Z");
    const g = await handleCloudGet(req("GET", TOKEN_A), "wedding", deps);
    assert.equal(b(g).deletedAt, "2026-10-25T09:00:00.000Z");
    assert.equal((b(g).plan as AgentState).event.id, royalWedding.event.id);
    // Idempotent at the current version: nothing changes.
    const again = await handleCloudSave(req("PUT", TOKEN_A, { deleted: true, baseVersion: 2 }), "wedding", deps);
    assert.equal(again.status, 200);
    assert.equal(repo.docs.get("uid_A/wedding")!.version, 2);
    // Restore = a normal save on the tombstone's version.
    assert.equal((await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 2 }), "wedding", deps)).status, 200);
    assert.equal(repo.docs.get("uid_A/wedding")!.deletedAt, undefined);
    assert.equal(b(await handleCloudGet(req("GET", TOKEN_A), "wedding", deps)).deletedAt, undefined);
  });
  test("tombstone is version-checked (409 with the current copy), 404 without a copy, and strict", async () => {
    const { deps } = setup();
    assert.equal((await handleCloudSave(req("PUT", TOKEN_A, { deleted: true, baseVersion: 1 }), "wedding", deps)).status, 404);
    await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    await handleCloudSave(req("PUT", TOKEN_A, { plan: renamed(royalWedding, "v2"), baseVersion: 1 }), "wedding", deps);
    const stale = await handleCloudSave(req("PUT", TOKEN_A, { deleted: true, baseVersion: 1 }), "wedding", deps);
    assert.equal(stale.status, 409);
    assert.equal(b(stale).currentVersion, 2);
    assert.equal(((b(stale).current as { plan: AgentState }).plan).event.title, "v2");
    for (const bad of [{ deleted: true, baseVersion: 0 }, { deleted: false, baseVersion: 2 }, { deleted: true, baseVersion: 2, uid: "uid_B" }, { deleted: true, baseVersion: 2, plan: royalWedding }])
      assert.equal((await handleCloudSave(req("PUT", TOKEN_A, bad), "wedding", deps)).status, 400, JSON.stringify(Object.keys(bad)));
    assert.equal((await handleCloudSave(req("PUT", null, { deleted: true, baseVersion: 2 }), "wedding", deps)).status, 401);
  });
  test("DELETE: only a tombstoned copy, at its version, of the named event; owner-only; 404 when absent", async () => {
    const { deps, repo } = setup();
    await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    const live = await handleCloudDelete(req("DELETE", TOKEN_A, undefined, "?baseVersion=1"), "wedding", deps);
    assert.equal(live.status, 409);
    assert.equal(b(live).error, "not_deleted");
    await handleCloudSave(req("PUT", TOKEN_A, { deleted: true, baseVersion: 1 }), "wedding", deps);
    assert.equal((await handleCloudDelete(req("DELETE", TOKEN_A, undefined, "?baseVersion=1"), "wedding", deps)).status, 409);
    const other = await handleCloudDelete(req("DELETE", TOKEN_A, undefined, "?baseVersion=2&eventId=someone-else"), "wedding", deps);
    assert.equal(b(other).error, "different_event");
    for (const q of ["", "?baseVersion=0", "?baseVersion=x", "?baseVersion=2&eventId=%3Cscript%3E"])
      assert.equal((await handleCloudDelete(req("DELETE", TOKEN_A, undefined, q), "wedding", deps)).status, 400, q);
    assert.equal((await handleCloudDelete(req("DELETE", null, undefined, "?baseVersion=2"), "wedding", deps)).status, 401);
    // Another user can't reach it (their own path is empty).
    assert.equal((await handleCloudDelete(req("DELETE", TOKEN_B, undefined, "?baseVersion=2"), "wedding", deps)).status, 404);
    assert.equal((await handleCloudDelete(req("DELETE", TOKEN_A, undefined, "?baseVersion=2"), "../x", deps)).status, 400);
    const ok = await handleCloudDelete(req("DELETE", TOKEN_A, undefined, `?baseVersion=2&eventId=${encodeURIComponent(royalWedding.event.id)}`), "wedding", deps);
    assert.equal(ok.status, 200);
    assert.equal(repo.docs.has("uid_A/wedding"), false);
    assert.equal((await handleCloudDelete(req("DELETE", TOKEN_A, undefined, "?baseVersion=2"), "wedding", deps)).status, 404);
    // Deleted forever: the slot starts again at version 1.
    assert.equal((await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps)).status, 200);
  });
  test("DELETE shares the cloud write rate limit and 503 when cloud save isn't configured", async () => {
    const { deps } = setup();
    assert.equal((await handleCloudDelete(req("DELETE", TOKEN_A, undefined, "?baseVersion=1"), "wedding", { ...deps, verifyToken: null, repo: null })).status, 503);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await handleCloudDelete(req("DELETE", TOKEN_A, undefined, "?baseVersion=1"), "wedding", deps)).status;
    assert.equal(last, 429);
  });
  test("route file wires DELETE to the handler", () => {
    const route = src("../app/api/cloud/plans/[planKey]/route.ts");
    assert.match(route, /export async function DELETE\(request: Request, ctx: Ctx\)/);
    assert.match(route, /handleCloudDelete\(request, planKey, deps\)/);
  });
});

describe("Firestore REST: deletedAt field and the DELETE precondition", () => {
  test("deletedAt is written as a timestamp only when set and read back", () => {
    const d = { version: 2, updatedAt: "2026-10-25T09:00:00.000Z", planJson: "{}", title: "t", eventType: "wedding" };
    assert.equal(toFirestoreFields(d).deletedAt, undefined);
    const f = toFirestoreFields({ ...d, deletedAt: d.updatedAt });
    assert.deepEqual(f.deletedAt, { timestampValue: d.updatedAt });
    assert.equal(fromFirestore({ fields: f })!.deletedAt, d.updatedAt);
    assert.equal(fromFirestore({ fields: toFirestoreFields(d) })!.deletedAt, undefined);
    assert.ok((CLOUD_DOC_FIELDS as readonly string[]).includes("deletedAt"));
  });
  test("remove: DELETE with the document's updateTime as a precondition; a stale version never sends it", async () => {
    const calls: { url: string; method: string }[] = [];
    const doc = { name: "x", updateTime: "2026-10-25T09:00:00.123456Z", fields: toFirestoreFields({ version: 3, updatedAt: "2026-10-25T09:00:00.000Z", planJson: "{}", title: "t", eventType: "wedding", deletedAt: "2026-10-25T09:00:00.000Z" }) };
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify(init?.method === "DELETE" ? {} : doc), { status: 200 });
    }) as unknown as typeof fetch;
    const repo = new FirestoreRestRepo("demo-project", f);
    assert.equal((await repo.remove({ uid: "u1", idToken: "tok" }, "wedding", 2)).ok, false);
    assert.ok(!calls.some(c => c.method === "DELETE"));
    assert.deepEqual(await repo.remove({ uid: "u1", idToken: "tok" }, "wedding", 3), { ok: true });
    const del = calls.find(c => c.method === "DELETE")!;
    assert.match(del.url, /\/users\/u1\/plans\/wedding\?currentDocument.updateTime=2026-10-25T09%3A00%3A00.123456Z$/);
  });
});

describe("firestore.rules: delete and the tombstone field", () => {
  const rules = src("../../firestore.rules").replace(/\/\/.*$/gm, "");
  test("owner-only delete with a valid key; deletedAt allowed only as a timestamp; everything else still denied", () => {
    assert.match(rules, /allow delete: if isOwner\(\) && validKey\(\);/);
    assert.doesNotMatch(rules, /allow delete: if false;/);
    assert.match(rules, /'deletedAt'\]\)/);
    assert.match(rules, /\(!\('deletedAt' in d\) \|\| d\.deletedAt is timestamp\)/);
    assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    assert.doesNotMatch(rules, /if true|allow write: if isOwner|allow read, write: if isOwner|allow delete: if isOwner\(\);/);
  });
});

// ---------- delete_event: trust tier, guests, the AI ----------
describe("delete_event op", () => {
  const TODAY = "2026-10-25";
  const del = { op: "delete_event" as const };
  test("Tier 2, organizer-only, never in the guest allow-list (unchanged), never combined with other changes", () => {
    assert.equal(commandTier(Batch.parse({ summary: "x", commands: [del] }).commands[0]!), 2);
    assert.equal(batchTier(Batch.parse({ summary: "x", commands: [del] }).commands), 2);
    assert.equal(agentBatchTier(Batch.parse({ summary: "x", commands: [del] }).commands), 2);
    assert.ok(ORGANIZER_ONLY_OPS.has("delete_event"));
    assert.ok(!GUEST_ALLOWED_OPS.has("delete_event" as never));
    assert.deepEqual([...GUEST_ALLOWED_OPS].sort(), ["claim_wishlist_item", "community_signup", "request_join", "submit_rsvp_entry"]);
    const mixed = applyBatch(royalWedding, { summary: "x", commands: [{ op: "set_task_status", taskId: royalWedding.tasks[0]!.id, status: "done" }, del] });
    assert.equal(mixed.ok, false);
    if (!mixed.ok) { assert.equal(mixed.failedCommandIndex, 1); assert.match(mixed.reason, /can't be combined/); }
  });
  test("the reducer deletes nothing: the plan is unchanged and the log says the app asks first", () => {
    const r = applyBatch(royalWedding, { summary: "Delete", commands: [del] });
    assert.ok(r.ok);
    if (r.ok) { assert.equal(r.state, royalWedding); assert.match(r.log.join(" "), /Recently deleted for 30 days/); }
  });
  test("guests are refused at the reducer, through the agent tool and in the offline concierge", () => {
    for (const source of ["agent", "ui"] as const) {
      const r = applyBatch(royalWedding, { summary: "x", commands: [del] }, { role: "guest", source });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /Guest Concierge Mode is read-only/);
    }
    const viaTool = executeAgentTool("apply_plan_changes", { summary: "x", commands: [del] }, royalWedding, TODAY, "guest");
    assert.equal(viaTool.response.ok, false);
    const offline = runOfflineGuestAgent(royalWedding, "delete this event", TODAY, royalWedding.guests[0]!.id);
    assert.ok(!offline.actions.some(a => a.kind === "batch"));
    assert.match(offline.reply, /read-only/);
    const guestDecl = JSON.stringify(guestFunctionDeclarations);
    assert.ok(!guestDecl.includes("delete_event"));
  });
  test("the AI may only propose it: declared to Gemini, shown as a Tier 2 card, never auto-applied", () => {
    const declared = JSON.stringify(functionDeclarations.find(f => f.name === "apply_plan_changes")!.parametersJsonSchema);
    assert.ok(declared.includes("delete_event"));
    assert.ok(AgentBatch.safeParse({ summary: "x", commands: [del] }).success);
    const t = executeAgentTool("apply_plan_changes", { summary: "Delete", commands: [del] }, royalWedding, TODAY, "organizer");
    assert.equal(t.response.ok, true);
    const card = t.actions.find(a => a.kind === "batch");
    assert.ok(card && card.kind === "batch" && card.tier === 2);
    assert.equal(t.working, royalWedding);
    const off = runOfflineAgent(royalWedding, "Delete this event", TODAY);
    const c2 = off.actions.find(a => a.kind === "batch");
    assert.ok(c2 && c2.kind === "batch" && c2.tier === 2 && c2.batch.commands[0]!.op === "delete_event");
    assert.match(off.reply, /can't delete anything myself/);
  });
  test("the offline intent matches only a request to delete the whole event", () => {
    for (const yes of ["delete this event", "Please remove the whole plan", "delete our event.", "trash my plan please"]) assert.ok(DELETE_EVENT_RE.test(yes), yes);
    for (const no of ["remove the decor line", "delete the haldi task", "remove this event's DJ", "can you delete this event's sangeet", "how do I delete the event later?"]) assert.ok(!DELETE_EVENT_RE.test(no), no);
  });
  test("the client confirms before deleting an approved card (approval card → app confirm)", () => {
    const app = src("../components/PlannerApp.tsx");
    assert.match(app, /a\.batch\.commands\.some\(c => c\.op === "delete_event"\)/);
    assert.match(app, /requestDelete\(storeRef\.current\.active, ok =>/);
    const chat = src("../components/ChatSidebar.tsx");
    assert.match(chat, /Approve, then confirm/);
  });
});

// ---------- guest links of a deleted event ----------
describe("guest links: 410 while the event is deleted", () => {
  let store: MemoryStore;
  const IP = "203.0.113.9";
  beforeEach(() => { store = new MemoryStore(); setStoreForTests(store); });
  const publish = async () => {
    const r = await createSharedEvent({ plan: royalWedding }, IP);
    assert.equal(r.status, 201);
    return r.body as { eventId: string; organizerToken: string; version: number; invites: { householdId: string; token: string }[]; rsvpToken: string };
  };
  test("removed: public and invite reads, and every guest write, answer 410 with the same friendly message; restore brings them back", async () => {
    const p = await publish();
    const inv = p.invites[0]!;
    assert.equal((await setOrganizerEventRemoved(p.eventId, p.organizerToken, { removed: true })).status, 200);
    for (const r of [await getGuestView(p.eventId, null, IP), await getGuestView(p.eventId, inv.token, IP), await getGuestView(p.eventId, "x".repeat(43), IP)]) {
      assert.equal(r.status, 410);
      assert.deepEqual(r.body, { error: "event_removed", message: REMOVED_MESSAGE });
    }
    // v8 Part 1c: the RSVP form and gift claims answer 410 too, with nothing about the event's guests.
    const DEV = "8f14e45f-ceea-4e7a-9d1b-000000000001";
    const rsvp = { name: "Asha", partySize: 2, functions: ["s4"], meal: "veg", answer: "coming" };
    assert.equal((await getGuestView(p.eventId, p.rsvpToken, IP, DEV)).status, 410);
    const write = await postRsvp(p.eventId, p.rsvpToken, DEV, rsvp, IP);
    assert.equal(write.status, 410);
    assert.equal((await postGuestActions(p.eventId, p.rsvpToken, { commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: null }] }, IP, DEV)).status, 410);
    assert.ok(!JSON.stringify(write.body).includes("Rao"), "no household data in the 410");
    // The organizer still reads it (to restore), but can't push edits to a removed event.
    const org = await getOrganizerEvent(p.eventId, p.organizerToken);
    assert.equal(org.status, 200);
    assert.ok((org.body as { removedAt?: string }).removedAt);
    assert.equal((await putOrganizerEvent(p.eventId, p.organizerToken, { plan: royalWedding, baseVersion: (org.body as { version: number }).version })).status, 410);
    // Restore: links work again with the same invite tokens.
    assert.equal((await setOrganizerEventRemoved(p.eventId, p.organizerToken, { removed: false })).status, 200);
    assert.equal((await getGuestView(p.eventId, inv.token, IP)).status, 200);
    assert.equal((await postRsvp(p.eventId, p.rsvpToken, DEV, rsvp, IP)).status, 200);
  });
  test("only the organizer token can remove or restore; strict body; idempotent", async () => {
    const p = await publish();
    assert.equal((await setOrganizerEventRemoved(p.eventId, null, { removed: true })).status, 401);
    assert.equal((await setOrganizerEventRemoved(p.eventId, p.invites[0]!.token, { removed: true })).status, 401);
    assert.equal((await setOrganizerEventRemoved(p.eventId, p.organizerToken, { removed: "yes" })).status, 400);
    assert.equal((await setOrganizerEventRemoved(p.eventId, p.organizerToken, { removed: true, plan: {} })).status, 400);
    assert.equal((await setOrganizerEventRemoved("A".repeat(22), p.organizerToken, { removed: true })).status, 404);
    assert.equal((await setOrganizerEventRemoved(p.eventId, p.organizerToken, { removed: true })).status, 200);
    assert.equal((await setOrganizerEventRemoved(p.eventId, p.organizerToken, { removed: true })).status, 200);
    assert.equal((await getGuestView(p.eventId, null, IP)).status, 410);
  });
  test("the guest page shows 'This event was removed by the organizer' on 410; the route exposes PATCH", () => {
    const page = src("../components/PublicGuestPage.tsx");
    assert.match(page, /r\.status === 410\) \{ setRemoved\(true\)/);
    assert.match(page, /This event was removed by the organizer/);
    assert.match(src("../app/api/events/[id]/route.ts"), /export async function PATCH/);
  });
});

// ---------- UI pieces (static: no browser) ----------
describe("delete UI (static)", () => {
  test("Overview: red outlined Delete event for every event; samples add Reset sample before it (v8 Part 0d)", () => {
    const pages = src("../components/PlannerPages.tsx");
    assert.match(pages, /data-testid="overview-delete-event"[\s\S]*?border border-red-600 bg-surface[^"]*text-red-700/);
    assert.match(pages, /\{actions\.isSample && \([\s\S]*?data-testid="overview-reset-sample"[\s\S]*?\)\}\s*<button type="button" onClick=\{actions\.requestDelete\} data-testid="overview-delete-event"/);
    assert.doesNotMatch(pages, /actions\.canDelete/);
  });
  test("event menu: the event stays a menuitemradio; its Delete is a separate labelled menuitem; Hide samples is a menuitemcheckbox", () => {
    const bar = src("../components/CommandBar.tsx");
    assert.match(bar, /role="menuitemradio" aria-checked=\{e\.active\}/);
    assert.match(bar, /role="menuitem" tabIndex=\{-1\} data-row-action="" aria-label=\{`Delete \$\{e\.title\}`\}/);
    assert.match(bar, /role="menuitemcheckbox" aria-checked=\{hideSamples\}/);
    assert.match(bar, /aria-label=\{`Restore \$\{t\.title\}`\}/);
    assert.match(bar, /aria-label=\{`Delete forever: \$\{t\.title\}`\}/);
    assert.match(bar, /'\[role="menuitem"\], \[role="menuitemradio"\], \[role="menuitemcheckbox"\]'/);
  });
  test("confirm dialog uses the fix6 close guard, starts on Cancel, and the chooser can't be dismissed by Escape", () => {
    const d = src("../components/ConfirmDialog.tsx");
    assert.match(d, /onClose=\{\(\) => \{ if \(!ref\.current\?\.open\) onClose\(\); \}\}/);
    assert.match(d, /ref=\{safe\}[^>]*onClick=\{onClose\}/);
    assert.match(d, /onCancel=\{e => \{ if \(!dismissible\) e\.preventDefault\(\); \}\}/);
    const app = src("../components/PlannerApp.tsx");
    assert.match(app, /You can restore it for \{TRASH_RETENTION_DAYS\} days\./);
    assert.match(app, /testId="deleted-choice-dialog" onClose=\{\(\) => \{\}\} dismissible=\{false\}/);
  });
});
