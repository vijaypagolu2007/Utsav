// API, security and concurrency tests. Gemini is always mocked; no network, no real key.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
process.env.UTSAV_SILENT_LOGS = "1";
import { royalWedding, arcadeBirthday, culturalFest } from "../presets";
import { handleChat, type ChatResponseBody } from "../server/chat-handler";
import { handleScan, scanInputFromJson, sniff, SCAN_MAX_FILE_BYTES } from "../server/scan-handler";
import type { GenerateFn, GenerateResult } from "../server/gemini-client";
import { rupeesToPaise, QuoteValidationError } from "../quote-scanner";
import { FileStore, MemoryStore, setStoreForTests, UpstashStore } from "../server/store";
import { createSharedEvent, getGuestView, getOrganizerEvent, postGuestActions, putOrganizerEvent } from "../server/events";
import { rebaseGuestFields } from "../sync";
import { geminiApiKey, readBodyLimited } from "../server/http";
import { AgentState } from "../schema";
import { applyBatch } from "../commands";
import { batchTier } from "../trust";
import { computePlanDiff } from "../diff";
import { initializeEventPlan } from "../blueprint";
import { toGuestView } from "../guest-view";

const TODAY = "2026-10-21";
const user = (text: string) => [{ role: "user" as const, text }];
const body = <T = Record<string, unknown>>(r: { body: unknown }) => r.body as T;

/** A scripted Gemini: returns the queued responses in order and records what it was sent. */
function scripted(...steps: (GenerateResult | Error | "hang")[]): GenerateFn & { calls: number } {
  const f = (async (_p, { signal }) => {
    f.calls++;
    const s = steps.shift() ?? { text: "done" };
    if (s === "hang") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (s instanceof Error) throw s;
    return s;
  }) as GenerateFn & { calls: number };
  f.calls = 0;
  return f;
}
const KEY = "test-key-not-real";

describe("chat API", () => {
  test("missing API key → offline Demo Mode, labelled, never mode=gemini", async () => {
    const r = await handleChat({ messages: user("Cut ₹20k from decor and move the Haldi to Friday"), state: royalWedding, today: TODAY }, { apiKey: null });
    assert.equal(r.status, 200);
    const b = body<ChatResponseBody>(r);
    assert.equal(b.mode, "offline");
    assert.equal(b.fallbackReason, "no_api_key");
    assert.ok(b.actions.some(a => a.kind === "batch" && a.tier === 1));
  });
  test("plain text Gemini response → mode=gemini", async () => {
    const r = await handleChat({ messages: user("hello"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: scripted({ text: "Namaste!" }) });
    assert.equal(r.status, 200);
    assert.deepEqual([body<ChatResponseBody>(r).mode, body<ChatResponseBody>(r).reply], ["gemini", "Namaste!"]);
  });
  test("function call → validated by the reducer → Tier-1 batch, then final text", async () => {
    const gen = scripted(
      { functionCalls: [{ id: "1", name: "apply_plan_changes", args: { summary: "cut", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -3_000_000 }] } }] },
      { text: "Staged a ₹20,000 cut." },
    );
    const r = await handleChat({ messages: user("cut decor 20k"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: gen });
    const b = body<ChatResponseBody>(r);
    assert.equal(b.mode, "gemini");
    assert.equal(gen.calls, 2);
    const batch = b.actions.find(a => a.kind === "batch");
    assert.ok(batch && batch.kind === "batch" && batch.tier === 1);
  });
  test("invalid function arguments are rejected by the schema, never executed", async () => {
    const gen = scripted(
      { functionCalls: [{ id: "1", name: "apply_plan_changes", args: { summary: "x", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: "lots" }] } }] },
      { functionCalls: [{ id: "2", name: "apply_plan_changes", args: "not an object" }] },
      { functionCalls: [{ id: "3", name: 42 as unknown as string, args: {} }] },
      { text: "Sorry." },
    );
    const r = await handleChat({ messages: user("x"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: gen });
    const b = body<ChatResponseBody>(r);
    assert.equal(b.mode, "gemini");
    assert.equal(b.actions.filter(a => a.kind === "batch").length, 0);
    assert.ok(b.actions.some(a => a.kind === "rejection"));
  });
  test("malformed provider response → safe offline fallback, labelled", async () => {
    const r = await handleChat({ messages: user("Cut ₹20k from decor"), state: royalWedding, today: TODAY },
      { apiKey: KEY, generate: scripted({ functionCalls: "nope" as unknown as [] }) });
    const b = body<ChatResponseBody>(r);
    assert.deepEqual([r.status, b.mode, b.fallbackReason], [200, "offline", "malformed_response"]);
  });
  test("provider timeout → offline fallback with fallbackReason=timeout", async () => {
    const r = await handleChat({ messages: user("Cut ₹20k from decor"), state: royalWedding, today: TODAY },
      { apiKey: KEY, generate: scripted("hang"), stepTimeoutMs: 30 });
    assert.deepEqual([body<ChatResponseBody>(r).mode, body<ChatResponseBody>(r).fallbackReason], ["offline", "timeout"]);
  });
  test("provider errors are classified (auth, rate limit, unavailable, model)", async () => {
    const cases: [Error, string][] = [
      [Object.assign(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'), { status: 400 }), "auth"],
      [Object.assign(new Error("quota"), { status: 429 }), "rate_limited"],
      [Object.assign(new Error("high demand"), { status: 503 }), "unavailable"],
      [Object.assign(new Error("gone"), { status: 404 }), "model_not_found"],
    ];
    for (const [err, kind] of cases) {
      const r = await handleChat({ messages: user("hi"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: scripted(err) });
      assert.equal(body<ChatResponseBody>(r).fallbackReason, kind);
      assert.equal(body<ChatResponseBody>(r).mode, "offline");
      assert.ok(!JSON.stringify(r.body).includes("API_KEY_INVALID"), "raw provider error must not leak");
    }
  });
  test("tool-call loop is bounded", async () => {
    const forever: GenerateFn = async () => ({ functionCalls: [{ id: "x", name: "get_plan_snapshot", args: {} }] });
    let n = 0;
    const counting: GenerateFn = async (p, o) => { n++; return forever(p, o); };
    const r = await handleChat({ messages: user("loop"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: counting, maxSteps: 4 });
    assert.equal(n, 4);
    assert.equal(body<ChatResponseBody>(r).truncated, true);
    assert.equal(body<ChatResponseBody>(r).mode, "gemini");
  });
  test("invalid event state, role, message shape and guest id → 400", async () => {
    const bad = [
      { messages: user("hi"), state: { nope: true } },
      { messages: user("hi"), state: royalWedding, role: "admin" },
      { messages: [{ role: "system", text: "x" }], state: royalWedding },
      { messages: user("x".repeat(5000)), state: royalWedding },
      { messages: user("hi"), state: royalWedding, actingGuestId: "ghost" },
      { messages: user("hi"), state: royalWedding, extra: 1 },
      { messages: user("   "), state: royalWedding },
    ];
    for (const b of bad) assert.equal((await handleChat(b, { apiKey: null })).status, 400, JSON.stringify(Object.keys(b)));
  });
  test("programming errors are not disguised as offline success", async () => {
    // The provider call succeeds, but reading its result blows up inside our own code: that must reject
    // (the route turns it into a 500), not come back as a labelled offline answer.
    const res = { get functionCalls(): never { throw new TypeError("bug in our code"); } } as unknown as GenerateResult;
    await assert.rejects(handleChat({ messages: user("x"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: async () => res }), TypeError);
  });
  test("guest role: organizer tools refused, budget command rejected by the reducer", async () => {
    const gen = scripted(
      { functionCalls: [{ id: "1", name: "initialize_event_plan", args: {} }, { id: "2", name: "apply_plan_changes", args: { summary: "x", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -100 }] } }] },
      { text: "That's for the organiser." },
    );
    const r = await handleChat({ messages: user("cut decor"), state: royalWedding, today: TODAY, role: "guest", actingGuestId: "g1" }, { apiKey: KEY, generate: gen });
    const b = body<ChatResponseBody>(r);
    assert.equal(b.actions.filter(a => a.kind === "batch" || a.kind === "init").length, 0);
    assert.ok(b.actions.some(a => a.kind === "rejection"));
  });
  test("an invalid batch is rejected atomically (no partial state)", async () => {
    const gen = scripted({ functionCalls: [{ id: "1", name: "apply_plan_changes", args: { summary: "x", commands: [
      { op: "adjust_budget", category: "decor", deltaPaise: -1_000_000 }, { op: "move_sub_event", subEvent: "haldi", to: { weekday: "monday" } }] } }] }, { text: "no" });
    const b = body<ChatResponseBody>(await handleChat({ messages: user("x"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: gen }));
    assert.equal(b.actions.filter(a => a.kind === "batch" && !a.counterOffer).length, 0);
    const rj = b.actions.find(a => a.kind === "rejection");
    assert.ok(rj && rj.kind === "rejection" && rj.rejection.failedCommandIndex === 1);
  });
});

// ---------- scan ----------
const PNG = Buffer.from(readFileSync("samples/deccan-royal-caterers-quote.png"));
const b64 = PNG.toString("base64");
const visionJson = (o: Record<string, unknown> = {}) => JSON.stringify({ vendorName: "Deccan Royal Caterers", category: "catering", itemLabel: "Sangeet dinner",
  quotedRupees: 185000, depositRupees: 50000, dueAt: "2026-10-25", redFlags: ["⚠️ 25% non-refundable deposit"], summary: "Quote", ...o });
const scanJson = async (raw: unknown, deps: Parameters<typeof handleScan>[1] = { apiKey: null }) => {
  const i = scanInputFromJson(raw);
  return i.ok ? handleScan(i.input, deps) : i.result;
};

describe("scan API", () => {
  test("sample quote works without an API key and yields a Tier-1 card", async () => {
    const r = await scanJson({ presetQuoteKey: "wedding", state: royalWedding, today: TODAY });
    assert.equal(r.status, 200);
    const b = body<{ source: string; actions: { kind: string; tier?: number; redFlags?: string[] }[] }>(r);
    assert.equal(b.source, "sample");
    const card = b.actions.find(a => a.kind === "batch")!;
    assert.equal(card.tier, 1);
    assert.equal(card.redFlags?.length, 3);
  });
  test("valid image → image bytes sent as inlineData with the sniffed MIME, Tier-1 card, exact paise", async () => {
    let sent: { mimeType?: string; data?: string } | undefined;
    const gen: GenerateFn = async p => { sent = (p.contents[0]!.parts![0] as { inlineData: { mimeType: string; data: string } }).inlineData; return { text: visionJson() }; };
    const r = await scanJson({ imageBase64: b64, mimeType: "image/png", state: royalWedding, today: TODAY }, { apiKey: KEY, generate: gen });
    assert.equal(r.status, 200);
    assert.equal(sent?.mimeType, "image/png");
    assert.equal(sent?.data, b64);
    const b = body<{ source: string; scanned: { quotedPaise: number; depositRequiredPaise: number }; actions: { kind: string; tier?: number; diff?: { rows: { note?: string }[] } }[] }>(r);
    assert.deepEqual([b.source, b.scanned.quotedPaise, b.scanned.depositRequiredPaise], ["gemini", 18_500_000, 5_000_000]);
    const card = b.actions.find(a => a.kind === "batch")!;
    assert.equal(card.tier, 1);
    assert.ok(card.diff!.rows.some(x => /exceeds planned ₹1,50,000 by ₹35,000/.test(x.note ?? "")), "over-budget diagnostic");
  });
  test("dataUrl input is accepted", async () => {
    const r = await scanJson({ dataUrl: `data:image/png;base64,${b64}`, state: royalWedding, today: TODAY }, { apiKey: KEY, generate: async () => ({ text: visionJson() }) });
    assert.equal(r.status, 200);
  });
  test("image without a key → labelled unavailable, nothing staged", async () => {
    const r = await scanJson({ imageBase64: b64, mimeType: "image/png", state: royalWedding, today: TODAY });
    assert.deepEqual([r.status, body<{ source: string; actions: unknown[] }>(r).source, body<{ actions: unknown[] }>(r).actions.length], [200, "unavailable", 0]);
  });
  test("invalid MIME, mismatched signature, invalid base64, missing and empty file", async () => {
    assert.equal((await scanJson({ imageBase64: b64, mimeType: "image/gif", state: royalWedding })).status, 415);
    assert.equal((await scanJson({ imageBase64: b64, mimeType: "application/pdf", state: royalWedding })).status, 415);
    assert.equal((await scanJson({ imageBase64: Buffer.from("MZ\x90\x00binary").toString("base64"), mimeType: "image/png", state: royalWedding })).status, 415);
    assert.equal((await scanJson({ imageBase64: "%%%not-base64%%%", mimeType: "image/png", state: royalWedding })).status, 400);
    assert.equal((await scanJson({ dataUrl: "data:image/png,rawtext", state: royalWedding })).status, 400);
    assert.equal((await scanJson({ state: royalWedding })).status, 400);
    assert.equal((await scanJson({ imageBase64: "", mimeType: "image/png", state: royalWedding })).status, 400);
    assert.equal((await scanJson({ presetQuoteKey: "x", state: royalWedding, bogus: 1 })).status, 400);
    assert.equal((await scanJson({ presetQuoteKey: "nope", state: royalWedding })).status, 400);
  });
  test("oversized upload → 413", async () => {
    const big = Buffer.alloc(SCAN_MAX_FILE_BYTES + 10, 0x41).toString("base64");
    assert.equal((await scanJson({ imageBase64: big, mimeType: "image/png", state: royalWedding })).status, 413);
    const req = new Request("http://x", { method: "POST", body: "x".repeat(2000), headers: { "content-length": "2000" } });
    const r = await readBodyLimited(req, 1000);
    assert.ok(!r.ok && r.result.status === 413);
  });
  test("plain-text quote uses the deterministic parser", async () => {
    const txt = Buffer.from("SHREE DECOR\nItem: Mandap florals\nGrand Total: ₹90,000\n").toString("base64");
    const r = await scanJson({ imageBase64: txt, mimeType: "text/plain", state: royalWedding, today: TODAY });
    assert.equal(r.status, 200);
    assert.equal(body<{ source: string }>(r).source, "text");
  });
  test("Gemini timeout / malformed JSON / schema mismatch → controlled errors, nothing staged", async () => {
    const t = await scanJson({ imageBase64: b64, mimeType: "image/png", state: royalWedding, today: TODAY }, { apiKey: KEY, generate: scripted("hang"), timeoutMs: 30 });
    assert.equal(t.status, 504);
    const m = await scanJson({ imageBase64: b64, mimeType: "image/png", state: royalWedding, today: TODAY }, { apiKey: KEY, generate: async () => ({ text: "{not json" }) });
    assert.equal(m.status, 502);
    const s = await scanJson({ imageBase64: b64, mimeType: "image/png", state: royalWedding, today: TODAY }, { apiKey: KEY, generate: async () => ({ text: '{"vendorName":1}' }) });
    assert.equal(s.status, 502);
  });
  test("negative, non-finite, absurd or missing amounts are rejected (422)", async () => {
    for (const o of [{ quotedRupees: -5 }, { quotedRupees: 1e12 }, { quotedRupees: 0 }, { quotedRupees: 12.345 }, { depositRupees: 999999 }, { vendorName: "  " }]) {
      const r = await scanJson({ imageBase64: b64, mimeType: "image/png", state: royalWedding, today: TODAY }, { apiKey: KEY, generate: async () => ({ text: visionJson(o) }) });
      assert.equal(r.status, 422, JSON.stringify(o));
    }
  });
  test("rupees → paise conversion is exact", () => {
    assert.equal(rupeesToPaise(185000), 18_500_000);
    assert.equal(rupeesToPaise(1450.1), 145_010);
    assert.equal(rupeesToPaise(0.29), 29);
    assert.equal(rupeesToPaise(1_000_000_000), 100_000_000_000);
    for (const bad of [NaN, Infinity, -1, 1.005, "100"]) assert.throws(() => rupeesToPaise(bad), QuoteValidationError);
  });
  test("guest role cannot scan", async () => {
    assert.equal((await scanJson({ presetQuoteKey: "wedding", state: royalWedding, role: "guest" })).status, 403);
  });
  test("file signatures", () => {
    assert.equal(sniff(PNG), "png");
    assert.equal(sniff(Buffer.from("%PDF-1.7\n")), "pdf");
    assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
    assert.equal(sniff(Buffer.from("hello")), null);
  });
});

// ---------- shared events ----------
let store: MemoryStore;
const IP = "203.0.113.7";
async function publish(plan: AgentState = royalWedding) {
  const r = await createSharedEvent({ plan }, IP);
  assert.equal(r.status, 201);
  return body<{ eventId: string; organizerToken: string; version: number; invites: { householdId: string; label: string; token: string }[] }>(r);
}

describe("shared guest links", () => {
  beforeEach(() => { store = new MemoryStore(); setStoreForTests(store); });

  test("organizer publishes; ids and tokens are high-entropy; one invite per household with guests", async () => {
    const p = await publish();
    assert.match(p.eventId, /^[A-Za-z0-9_-]{22}$/);
    assert.match(p.organizerToken, /^[A-Za-z0-9_-]{43}$/);
    const withGuests = new Set(royalWedding.guests.map(g => g.householdId));
    assert.equal(p.invites.length, withGuests.size);
    const raw = (await store.get(`utsav:event:${p.eventId}`))!.json;
    assert.ok(!raw.includes(p.organizerToken), "organizer token is stored hashed");
  });
  test("a second session loads the public itinerary with no financial or private data", async () => {
    const p = await publish();
    const r = await getGuestView(p.eventId, null, "198.51.100.1");
    assert.equal(r.status, 200);
    const s = JSON.stringify(r.body);
    for (const leak of ["Paise", "budget", "vendor", "Sri Annapurna", "committed", "payments", "tasks", "phone", "inviteCode", "organizerToken", "Petals"]) assert.ok(!s.includes(leak), `leaked ${leak}`);
    const v = body<{ subEvents: unknown[]; household: unknown }>(r);
    assert.equal(v.subEvents.length, royalWedding.subEvents.filter(x => x.visibility === "public").length);
    assert.equal(v.household, null);
  });
  test("invite token reveals only that household", async () => {
    const p = await publish();
    const inv = p.invites[0]!;
    const v = body<{ household: { members: { id: string }[] } }>(await getGuestView(p.eventId, inv.token, IP));
    const expected = royalWedding.guests.filter(g => g.householdId === inv.householdId).map(g => g.id).sort();
    assert.deepEqual(v.household.members.map(m => m.id).sort(), expected);
  });
  test("guest RSVP persists and is visible to the organizer", async () => {
    const p = await publish();
    const g = royalWedding.guests.find(x => Object.keys(x.rsvp).length)!;
    const inv = p.invites.find(i => i.householdId === g.householdId)!;
    const sub = royalWedding.subEvents.find(s => s.id === Object.keys(g.rsvp)[0])!;
    const w = await postGuestActions(p.eventId, inv.token, { commands: [{ op: "set_rsvp", guestId: g.id, subEvent: sub.slug, answer: "yes" }] }, IP);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const o = body<{ plan: AgentState; version: number }>(await getOrganizerEvent(p.eventId, p.organizerToken));
    assert.equal(o.plan.guests.find(x => x.id === g.id)!.rsvp[sub.id], "yes");
    assert.equal(o.version, 2);
  });
  test("guests cannot run organizer commands or mass-assign fields", async () => {
    const p = await publish();
    const inv = p.invites[0]!;
    for (const c of [
      { op: "adjust_budget", category: "decor", deltaPaise: -100 },
      { op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } },
      { op: "record_payment", budgetItemId: "b6", paymentId: "x", paidDate: TODAY },
      { op: "set_rsvp", guestId: "g1", subEvent: "haldi", answer: "yes", plannedPaise: 1 },
      // The organizer's inline-edit ops are not on the guest allowlist either.
      { op: "rename_event", title: "Hijacked" },
      { op: "set_partner_names", partners: ["A", "B"] },
      { op: "rename_entity", kind: "guest", id: "g1", name: "Someone else" },
      { op: "rename_entity", kind: "sub_event", id: "s1", name: "Party" },
      { op: "set_planned_amount", budgetItemId: "b1", plannedPaise: 0, expectedPaise: 8_000_000 },
    ]) assert.equal((await postGuestActions(p.eventId, inv.token, { commands: [c] }, IP)).status, 400, c.op);
    // With or without a token.
    assert.equal((await postGuestActions(p.eventId, null, { commands: [{ op: "rename_event", title: "Hijacked" }] }, IP)).status, 400);
    const after = body<{ plan: AgentState }>(await getOrganizerEvent(p.eventId, p.organizerToken)).plan;
    assert.equal(after.event.title, royalWedding.event.title);
    assert.equal(after.budgetItems.find(b => b.id === "b1")!.plannedPaise, 8_000_000);
    assert.equal((await postGuestActions(p.eventId, inv.token, { commands: [], plan: royalWedding }, IP)).status, 400);
  });
  test("guests cannot impersonate another household or act without an invite", async () => {
    const p = await publish();
    const mine = p.invites[0]!;
    const other = royalWedding.guests.find(g => g.householdId !== mine.householdId)!;
    const sub = Object.keys(other.rsvp)[0] ?? royalWedding.subEvents[0]!.id;
    const slug = royalWedding.subEvents.find(s => s.id === sub)!.slug;
    assert.equal((await postGuestActions(p.eventId, mine.token, { commands: [{ op: "set_rsvp", guestId: other.id, subEvent: slug, answer: "no" }] }, IP)).status, 403);
    assert.equal((await postGuestActions(p.eventId, null, { commands: [{ op: "set_rsvp", guestId: other.id, subEvent: slug, answer: "no" }] }, IP)).status, 401);
    assert.equal((await postGuestActions(p.eventId, "A".repeat(43), { commands: [{ op: "set_rsvp", guestId: other.id, subEvent: slug, answer: "no" }] }, IP)).status, 403);
  });
  test("an invite for one event can't touch another event", async () => {
    const a = await publish(), b = await publish();
    const g = royalWedding.guests.find(x => x.householdId === a.invites[0]!.householdId)!;
    const slug = royalWedding.subEvents.find(s => s.id === Object.keys(g.rsvp)[0])!.slug;
    assert.equal((await postGuestActions(b.eventId, a.invites[0]!.token, { commands: [{ op: "set_rsvp", guestId: g.id, subEvent: slug, answer: "yes" }] }, IP)).status, 403);
    assert.equal((await getOrganizerEvent(b.eventId, a.organizerToken)).status, 401);
  });
  test("self-invite is rejected whether the sub-event is public or private", async () => {
    const g = royalWedding.guests.find(x => royalWedding.subEvents.some(s => !(s.id in x.rsvp) && !royalWedding.guests.some(o => o.householdId === x.householdId && s.id in o.rsvp)))!;
    const notInvited = royalWedding.subEvents.find(s => !royalWedding.guests.some(o => o.householdId === g.householdId && s.id in o.rsvp))!;
    for (const visibility of ["public", "private"] as const) {
      const plan = { ...royalWedding, subEvents: royalWedding.subEvents.map(s => s.id === notInvited.id ? { ...s, visibility } : s) };
      const p = await publish(plan);
      const inv = p.invites.find(i => i.householdId === g.householdId)!;
      const r = await postGuestActions(p.eventId, inv.token, { commands: [{ op: "set_rsvp", guestId: g.id, subEvent: notInvited.slug, answer: "yes" }] }, IP);
      // Public: visible but still not invited → the reducer refuses (visibility never grants RSVP).
      // Private: not even visible → the same answer as a nonexistent sub-event, with no name in the error.
      assert.equal(r.status, visibility === "public" ? 422 : 400, visibility);
      if (visibility === "private") assert.ok(!JSON.stringify(r.body).includes(notInvited.name), "private name leaked in error");
    }
  });
  test("duplicate wishlist claims are rejected", async () => {
    const p = await publish(arcadeBirthday);
    const ext = arcadeBirthday.event.ext;
    assert.equal(ext.type, "birthday");
    if (ext.type !== "birthday") return;
    const open = ext.wishlist.find(w => !w.claimedByGuestId)!;
    const [h1, h2] = p.invites;
    const g1 = arcadeBirthday.guests.find(g => g.householdId === h1!.householdId)!;
    const g2 = arcadeBirthday.guests.find(g => g.householdId === h2!.householdId)!;
    assert.equal((await postGuestActions(p.eventId, h1!.token, { commands: [{ op: "claim_wishlist_item", itemId: open.id, guestId: g1.id }] }, IP)).status, 200);
    assert.equal((await postGuestActions(p.eventId, h2!.token, { commands: [{ op: "claim_wishlist_item", itemId: open.id, guestId: g2.id }] }, IP)).status, 422);
    assert.equal((await postGuestActions(p.eventId, h1!.token, { commands: [{ op: "claim_wishlist_item", itemId: open.id, guestId: null }] }, IP)).status, 403);
  });
  test("community sign-up works on the public link without an invite", async () => {
    const p = await publish(culturalFest);
    const r = await postGuestActions(p.eventId, null, { commands: [{ op: "community_signup", kind: "volunteer", name: "Ravi" }] }, IP);
    assert.equal(r.status, 200);
    assert.equal(body<{ view: { community: { volunteersSignedUp: number } } }>(r).view.community.volunteersSignedUp, 1);
  });
  test("invalid, unknown or malformed links fail safely", async () => {
    await publish();
    assert.equal((await getGuestView("short", null, IP)).status, 404);
    assert.equal((await getGuestView("A".repeat(22), null, IP)).status, 404);
    assert.equal((await getGuestView("../../etc/passwd", null, IP)).status, 404);
    assert.equal((await getOrganizerEvent("A".repeat(22), "x")).status, 404);
    const p = await publish();
    assert.equal((await getGuestView(p.eventId, "not-a-token", IP)).status, 403);
    assert.equal((await getOrganizerEvent(p.eventId, null)).status, 401);
    assert.equal((await getOrganizerEvent(p.eventId, "B".repeat(43))).status, 401);
  });
  test("concurrent updates: a stale organizer save gets 409 and the rebase keeps the guest's RSVP", async () => {
    const p = await publish();
    const g = royalWedding.guests.find(x => Object.keys(x.rsvp).length)!;
    const subId = Object.keys(g.rsvp)[0]!;
    const inv = p.invites.find(i => i.householdId === g.householdId)!;
    // Organizer edits locally (a budget lock) while a guest RSVPs on the server.
    const local: AgentState = { ...royalWedding, budgetItems: royalWedding.budgetItems.map(b => (b.id === "b1" ? { ...b, locked: true } : b)) };
    assert.equal((await postGuestActions(p.eventId, inv.token, { commands: [{ op: "set_rsvp", guestId: g.id, subEvent: royalWedding.subEvents.find(s => s.id === subId)!.slug, answer: "no" }] }, IP)).status, 200);
    const stale = await putOrganizerEvent(p.eventId, p.organizerToken, { plan: local, baseVersion: 1 });
    assert.equal(stale.status, 409);
    const cur = body<{ current: { version: number; plan: AgentState } }>(stale).current;
    const merged = rebaseGuestFields(local, cur.plan);
    const okPut = await putOrganizerEvent(p.eventId, p.organizerToken, { plan: merged, baseVersion: cur.version });
    assert.equal(okPut.status, 200);
    const final = body<{ plan: AgentState }>(await getOrganizerEvent(p.eventId, p.organizerToken)).plan;
    assert.equal(final.guests.find(x => x.id === g.id)!.rsvp[subId], "no", "guest change kept");
    assert.equal(final.budgetItems.find(b => b.id === "b1")!.locked, true, "organizer change kept");
  });
  test("parallel guest writes all land (server-side retry on version conflict)", async () => {
    const p = await publish(culturalFest);
    const rs = await Promise.all(["A", "B", "C", "D"].map(n => postGuestActions(p.eventId, null, { commands: [{ op: "community_signup", kind: "volunteer", name: n }] }, `10.0.0.${n.charCodeAt(0)}`)));
    assert.ok(rs.every(r => r.status === 200));
    const o = body<{ plan: AgentState }>(await getOrganizerEvent(p.eventId, p.organizerToken)).plan;
    assert.equal(o.event.ext.type === "community" ? o.event.ext.volunteerSignups.length : -1, 4);
  });
  test("public writes are rate-limited", async () => {
    const p = await publish(culturalFest);
    let last = 200;
    for (let i = 0; i < 32; i++) last = (await postGuestActions(p.eventId, null, { commands: [{ op: "community_signup", kind: "volunteer", name: `V${i}` }] }, "192.0.2.9")).status;
    assert.equal(last, 429);
  });
  test("storage not configured → 503, never a fake success", async () => {
    setStoreForTests(null);
    const prev = { ...process.env };
    (process.env as Record<string, string>).NODE_ENV = "production"; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL; delete process.env.UTSAV_STORE;
    try { assert.equal((await createSharedEvent({ plan: royalWedding }, IP)).status, 503); }
    finally { Object.assign(process.env, prev); setStoreForTests(new MemoryStore()); }
  });
  test("Upstash store sends atomic EVAL compare-and-set commands", async () => {
    const sent: string[][] = [];
    const fake = (async (_u: unknown, init?: RequestInit) => {
      const args = JSON.parse(String(init!.body)) as string[];
      sent.push(args);
      const result = args[0] === "EVAL" && args[1]!.includes("HGET") ? -2 : args[0] === "HMGET" ? ["3", "{}"] : 1;
      return new Response(JSON.stringify({ result }), { status: 200 });
    }) as typeof fetch;
    const u = new UpstashStore("https://example.upstash.io", "t", fake);
    const r = await u.cas("k", 2, "{}", 60);
    assert.deepEqual(r, { ok: false, conflict: true, current: { version: 3, json: "{}" } });
    assert.equal(sent[0]![0], "EVAL");
    assert.equal(sent[0]![3], "k");
    assert.equal(sent[0]![4], "2");
  });
});

describe("secrets stay on the server", () => {
  test("no client component imports server code or reads GEMINI_API_KEY; no NEXT_PUBLIC secrets", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|mjs)$/.test(f)) files.push(p); } };
    walk("src");
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      if (/^["']use client["']/.test(s)) {
        assert.ok(!/@\/server\/|\.\.\/server\//.test(s), `${f} imports server code`);
        assert.ok(!/GEMINI_API_KEY|UPSTASH|KV_REST/.test(s), `${f} references a server secret`);
      }
      assert.ok(!/NEXT_PUBLIC_(GEMINI|UPSTASH|KV)/.test(s), `${f} exposes a secret via NEXT_PUBLIC`);
    }
  });
});

describe("storage selection", () => {
  test("dev defaults to the file store, production needs Upstash, Vercel never uses files", async () => {
    const { getStore } = await import("../server/store");
    setStoreForTests(null);
    try {
      assert.equal(getStore({ NODE_ENV: "development", UTSAV_STORE: "" } as NodeJS.ProcessEnv).store?.kind, "file");
      setStoreForTests(null);
      assert.equal(getStore({ NODE_ENV: "production" } as NodeJS.ProcessEnv).store, null);
      setStoreForTests(null);
      assert.equal(getStore({ NODE_ENV: "production", UTSAV_STORE: "file", VERCEL: "1" } as NodeJS.ProcessEnv).store, null);
      setStoreForTests(null);
      assert.equal(getStore({ NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" } as NodeJS.ProcessEnv).store?.kind, "upstash");
      setStoreForTests(null);
      assert.equal(getStore({ NODE_ENV: "production", KV_REST_API_URL: "http://insecure", KV_REST_API_TOKEN: "t" } as NodeJS.ProcessEnv).store, null);
    } finally { setStoreForTests(null); }
  });
});

describe("organizer ⇄ guest three-way merge", () => {
  const g = royalWedding.guests.find(x => Object.keys(x.rsvp).length)!;
  const sid = Object.keys(g.rsvp)[0]!;
  const withGuest = (p: AgentState, patch: Partial<AgentState["guests"][number]>): AgentState =>
    ({ ...p, guests: p.guests.map(x => (x.id === g.id ? { ...x, ...patch } : x)) });
  test("an organizer's own edit to a guest field is not overwritten by an unchanged server copy", () => {
    const base = royalWedding;
    const local = withGuest(base, { diet: ["jain"], rsvp: { ...g.rsvp, [sid]: "no" } });
    const merged = rebaseGuestFields(local, base, base);
    assert.deepEqual(merged.guests.find(x => x.id === g.id)!.diet, ["jain"]);
    assert.equal(merged.guests.find(x => x.id === g.id)!.rsvp[sid], "no");
  });
  test("a guest's server-side change wins when the organizer didn't touch it", () => {
    const remote = withGuest(royalWedding, { diet: ["vegan"], rsvp: { ...g.rsvp, [sid]: "yes" } });
    const merged = rebaseGuestFields(royalWedding, remote, royalWedding);
    assert.deepEqual(merged.guests.find(x => x.id === g.id)!.diet, ["vegan"]);
    assert.equal(merged.guests.find(x => x.id === g.id)!.rsvp[sid], "yes");
  });
  test("colliding volunteer ids from both sides are both kept", () => {
    const ext = culturalFest.event.ext;
    if (ext.type !== "community") throw new Error("preset");
    const add = (name: string): AgentState => ({ ...culturalFest, event: { ...culturalFest.event, ext: { ...ext, volunteers: ext.volunteers + 1,
      volunteerSignups: [...ext.volunteerSignups, { id: `vs-${ext.volunteerSignups.length + 1}`, name, subEventId: null, shift: "" }] } } });
    const merged = rebaseGuestFields(add("Organizer pick"), add("Guest pick"), culturalFest);
    const names = merged.event.ext.type === "community" ? merged.event.ext.volunteerSignups.map(v => v.name) : [];
    assert.ok(names.includes("Organizer pick") && names.includes("Guest pick"));
    const ids = merged.event.ext.type === "community" ? merged.event.ext.volunteerSignups.map(v => v.id) : [];
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("geminiApiKey", () => {
  test("UTSAV_DISABLE_GEMINI=1 forces Demo Mode even when a key is configured", () => {
    const k = process.env.GEMINI_API_KEY, d = process.env.UTSAV_DISABLE_GEMINI;
    try {
      process.env.GEMINI_API_KEY = "configured-key";
      process.env.UTSAV_DISABLE_GEMINI = "1";
      assert.equal(geminiApiKey(), null);
      delete process.env.UTSAV_DISABLE_GEMINI;
      assert.equal(geminiApiKey(), "configured-key");
    } finally {
      if (k === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = k;
      if (d === undefined) delete process.env.UTSAV_DISABLE_GEMINI; else process.env.UTSAV_DISABLE_GEMINI = d;
    }
  });
});


describe("sub-event visibility", () => {
  beforeEach(() => { store = new MemoryStore(); setStoreForTests(store); });
  const priv = royalWedding.subEvents.filter(x => x.visibility === "private");
  const pub = royalWedding.subEvents.filter(x => x.visibility === "public");

  test("preset has both kinds, so the tests below mean something", () => {
    assert.ok(priv.length > 0 && pub.length > 0);
  });
  test("public payload (no token) contains public sub-events and no trace of private ones", async () => {
    const p = await publish();
    const r = await getGuestView(p.eventId, null, IP);
    const raw = JSON.stringify(r.body);
    const v = body<{ subEvents: { id: string }[]; moments: { subEventId: string }[] }>(r);
    assert.deepEqual(new Set(v.subEvents.map(x => x.id)), new Set(pub.map(x => x.id)));
    for (const s of priv) {
      assert.ok(!raw.includes(`"${s.id}"`), `private id ${s.id} in payload`);
      assert.ok(!raw.includes(s.name), `private name ${s.name} in payload`);
      assert.ok(!raw.includes(s.venue) || pub.some(x => x.venue === s.venue), `private venue ${s.venue} in payload`);
    }
    assert.ok(v.moments.every(m => pub.some(x => x.id === m.subEventId)), "moment from a private sub-event leaked");
  });
  test("a household sees private sub-events it is invited to, and not the ones it isn't", async () => {
    const p = await publish();
    for (const inv of p.invites) {
      const members = royalWedding.guests.filter(g => g.householdId === inv.householdId);
      const invited = new Set(members.flatMap(g => Object.keys(g.rsvp)));
      const v = body<{ subEvents: { id: string }[] }>(await getGuestView(p.eventId, inv.token, IP));
      const ids = new Set(v.subEvents.map(x => x.id));
      for (const s of priv) assert.equal(ids.has(s.id), invited.has(s.id), `${inv.householdId} / ${s.id}`);
      for (const s of pub) assert.ok(ids.has(s.id));
    }
  });
  test("an invited household can still RSVP to a private sub-event", async () => {
    const p = await publish();
    const g = royalWedding.guests.find(x => priv.some(s => s.id in x.rsvp))!;
    const s = priv.find(x => x.id in g.rsvp)!;
    const inv = p.invites.find(i => i.householdId === g.householdId)!;
    const r = await postGuestActions(p.eventId, inv.token, { commands: [{ op: "set_rsvp", guestId: g.id, subEvent: s.slug, answer: "maybe" }] }, IP);
    assert.equal(r.status, 200);
  });
  test("guests cannot change visibility, with or without a token", async () => {
    const p = await publish();
    const cmd = { commands: [{ op: "set_sub_event_visibility", subEvent: priv[0]!.slug, visibility: "public" }] };
    assert.equal((await postGuestActions(p.eventId, null, cmd, IP)).status, 400);
    assert.equal((await postGuestActions(p.eventId, p.invites[0]!.token, cmd, IP)).status, 400);
    const v = body<{ subEvents: { id: string }[] }>(await getGuestView(p.eventId, null, IP));
    assert.ok(!v.subEvents.some(x => x.id === priv[0]!.id));
    // The reducer refuses it too, independent of the HTTP allowlist.
    const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "set_sub_event_visibility", subEvent: priv[0]!.slug, visibility: "public" }] }, { role: "guest" });
    assert.equal(r.ok, false);
  });
  test("community sign-up can't target a private sub-event from the public link", async () => {
    const pPriv = culturalFest.subEvents.find(x => x.visibility === "private")!;
    const p = await publish(culturalFest);
    const r = await postGuestActions(p.eventId, null, { commands: [{ op: "community_signup", kind: "volunteer", name: "Asha", subEvent: pPriv.slug, shift: "Morning" }] }, IP);
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.body).includes(pPriv.name));
  });
  test("organizer: sees every sub-event; publishing is Tier 1, hiding is Tier 0; the change shows in the diff", async () => {
    const p = await publish();
    const o = body<{ plan: AgentState }>(await getOrganizerEvent(p.eventId, p.organizerToken));
    assert.equal(o.plan.subEvents.length, royalWedding.subEvents.length);
    assert.equal(batchTier([{ op: "set_sub_event_visibility", subEvent: "haldi", visibility: "public" }]), 1);
    assert.equal(batchTier([{ op: "set_sub_event_visibility", subEvent: "haldi", visibility: "private" }]), 0);
    const r = applyBatch(royalWedding, { summary: "show haldi", commands: [{ op: "set_sub_event_visibility", subEvent: priv[0]!.slug, visibility: "public" }] });
    assert.ok(r.ok);
    assert.equal(r.state.subEvents.find(x => x.id === priv[0]!.id)!.visibility, "public");
    assert.ok(computePlanDiff(royalWedding, r.state).rows.some(x => x.label.endsWith("on guest link")));
    // Organizer publishes the change; the public link now includes it.
    const put = await putOrganizerEvent(p.eventId, p.organizerToken, { plan: r.state, baseVersion: body<{ version: number }>(await getOrganizerEvent(p.eventId, p.organizerToken)).version });
    assert.equal(put.status, 200);
    const v = body<{ subEvents: { id: string }[] }>(await getGuestView(p.eventId, null, IP));
    assert.ok(v.subEvents.some(x => x.id === priv[0]!.id));
  });
  test("legacy data without the field loads as private and loses nothing", () => {
    const legacy = JSON.parse(JSON.stringify(royalWedding)) as Record<string, unknown> & { subEvents: Record<string, unknown>[] };
    for (const s of legacy.subEvents) delete s.visibility;
    const parsed = AgentState.parse(legacy);
    assert.ok(parsed.subEvents.every(x => x.visibility === "private"));
    assert.equal(parsed.subEvents.length, royalWedding.subEvents.length);
    assert.deepEqual(parsed.subEvents.map(x => [x.id, x.name, x.date, x.venue]), royalWedding.subEvents.map(x => [x.id, x.name, x.date, x.venue]));
    // A legacy shared-event record also loads: the public view is empty, not an error.
    const v = toGuestView(parsed, "e", 1, null);
    assert.equal(v.subEvents.length, 0);
  });
  test("new plans from initialize_event_plan default to private unless asked", () => {
    const r = initializeEventPlan({ eventType: "community", title: "T", city: "Pune", startDate: "2027-01-10", totalBudgetRupees: 50000,
      subEvents: [{ name: "Main", dayOffset: 0, startMin: 600, endMin: 1200, isMain: true }, { name: "Closing", dayOffset: 1, startMin: 1020, endMin: 1200, phase: "post", visibility: "public" }],
      budgetLines: [{ category: "venue", label: "Venue", weightBps: 10000 }], ext: { type: "community" } });
    assert.ok(r.ok, !r.ok ? r.reason : "");
    if (r.ok) {
      assert.equal(r.state.subEvents.find(s => s.name === "Main")!.visibility, "private");
      assert.equal(r.state.subEvents.find(s => s.name === "Closing")!.visibility, "public");
    }
  });
  test("three-way merge keeps the organizer's visibility change (guest fields only come from the server)", () => {
    const local = { ...royalWedding, subEvents: royalWedding.subEvents.map(s => s.id === priv[0]!.id ? { ...s, visibility: "public" as const } : s) };
    const merged = rebaseGuestFields(local, royalWedding, royalWedding);
    assert.equal(merged.subEvents.find(s => s.id === priv[0]!.id)!.visibility, "public");
  });
});

describe("FileStore on Windows", () => {
  test("file names contain no characters Windows forbids, and distinct keys never collide", () => {
    const keys = ["utsav:event:U_BVlliH1NNXEa5jktai3w", "ratelimit:guestWrite:abc:::1", "ratelimit:guestWrite:abc:127.0.0.1", "a_b", "a:b", "a~003ab", "a/b\\c*?\"<>|"];
    const names = keys.map(k => FileStore.fileName(k));
    for (const n of names) assert.doesNotMatch(n, /[<>:"/\\|?*]/, n);
    assert.equal(new Set(names).size, keys.length);
  });
  test("create, get and compare-and-set work through real files", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "utsav-fs-"));
    try {
      const fsStore = new FileStore(dir);
      assert.equal(await fsStore.create("utsav:event:x", "{}"), true);
      assert.equal(await fsStore.create("utsav:event:x", "{}"), false);
      assert.equal((await fsStore.get("utsav:event:x"))!.version, 1);
      assert.ok((await fsStore.cas("utsav:event:x", 1, "{\"a\":1}")).ok);
      assert.equal((await fsStore.cas("utsav:event:x", 1, "{}")).ok, false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
