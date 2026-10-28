// v8 Part 2b: an explicit Gemini output cap per route (generationConfig.maxOutputTokens), a reply cut off at the cap
// (finishReason MAX_TOKENS) handled as a malformed response, and pure functional transcript updates in useChatSession.
// The real geminiGenerate client is exercised against a stubbed fetch: no network, no real key.
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.UTSAV_SILENT_LOGS = "1";
import { royalWedding } from "../presets";
import { handleChat, type ChatResponseBody } from "../server/chat-handler";
import { handleCreatePlan, type PlanResponseBody } from "../server/plan-handler";
import { handleScan, scanInputFromJson } from "../server/scan-handler";
import { assertNotTruncated, GEMINI_MAX_OUTPUT_TOKENS, geminiGenerate, ProviderError, type GenerateFn, type GenerateParams, type GenerateResult } from "../server/gemini-client";
import { defaultSetupCategories, type SetupInputRaw } from "../setup";
import { checklistFor } from "../config/vendor-checklist";
import { withTranscript } from "../components/planner/transcript";
import type { ChatMsg } from "../components/ChatSidebar";

const TODAY = "2026-10-21";
const KEY = "unit-test-placeholder";
const user = (text: string) => [{ role: "user" as const, text }];
const setup = (): SetupInputRaw => ({ eventType: "wedding", style: "telugu-hindu", city: "Hyderabad", startDate: "2027-02-10", endDate: "2027-02-12",
  guestCount: 250, totalBudgetRupees: 20_00_000, categories: defaultSetupCategories("wedding", "telugu-hindu") });

// ---------- a stubbed Gemini REST endpoint behind the real SDK client ----------
type Candidate = { content: { role: "model"; parts: Record<string, unknown>[] }; finishReason: string };
const realFetch = globalThis.fetch;
const sentBodies: { url: string; body: Record<string, unknown> }[] = [];
function stubGemini(...answers: Candidate[]) {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sentBodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const c = answers.shift() ?? { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" };
    return new Response(JSON.stringify({ candidates: [c] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const client = () => geminiGenerate(KEY, { retryDelaysMs: [] });
const capOf = (i: number) => (sentBodies[i]!.body.generationConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens;
const textAnswer = (text: string, finishReason = "STOP"): Candidate => ({ content: { role: "model", parts: [{ text }] }, finishReason });
const callAnswer = (name: string, args: Record<string, unknown>, finishReason = "STOP"): Candidate => ({ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason });
afterEach(() => { globalThis.fetch = realFetch; sentBodies.length = 0; });

describe("Gemini output cap: generationConfig.maxOutputTokens", () => {
  test("the caps are named per route and leave room for the largest schema-sized answers", () => {
    assert.deepEqual(GEMINI_MAX_OUTPUT_TOKENS, { chat: 4096, plan: 8192, scan: 4096 });
    // The plan is the largest structured answer: it gets the biggest cap.
    assert.ok(GEMINI_MAX_OUTPUT_TOKENS.plan > GEMINI_MAX_OUTPUT_TOKENS.chat);
  });

  test("the request body the SDK sends carries the cap the caller asked for", async () => {
    stubGemini(textAnswer("Namaste!"));
    const res = await client()({ contents: [{ role: "user", parts: [{ text: "hi" }] }], maxOutputTokens: 1234 }, { signal: new AbortController().signal });
    assert.equal(res.text, "Namaste!");
    assert.equal(sentBodies.length, 1);
    assert.match(sentBodies[0]!.url, /:generateContent$/);
    assert.equal(capOf(0), 1234);
  });

  test("/api/chat sends the chat cap on chat turns, ideas and vendor questions", async () => {
    stubGemini(textAnswer("Namaste!"));
    const chat = await handleChat({ messages: user("hello"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: client() });
    assert.equal((chat.body as ChatResponseBody).mode, "gemini");
    stubGemini(callAnswer("suggest_ideas", { ideas: [{ kind: "decor", title: "Marigold toranam entrance", description: "Fresh flowers at the gate" }] }));
    await handleChat({ messages: user("ideas"), state: royalWedding, today: TODAY, ideas: {} }, { apiKey: KEY, generate: client() });
    const need = checklistFor(royalWedding)[0]!.key;
    stubGemini(callAnswer("suggest_vendor_questions", { need, questions: ["Is GST included in the quote?", "How many guests does it cover?", "What is the cancellation policy?"] }));
    await handleChat({ messages: user("q"), state: royalWedding, today: TODAY, vendorQuestions: { need } }, { apiKey: KEY, generate: client() });
    assert.equal(sentBodies.length, 3);
    for (let i = 0; i < 3; i++) assert.equal(capOf(i), GEMINI_MAX_OUTPUT_TOKENS.chat, `call ${i}`);
  });

  test("/api/plan sends the plan cap and /api/scan-quote the scan cap", async () => {
    const params: GenerateParams[] = [];
    const recorder = (r: GenerateResult): GenerateFn => async p => { params.push(p); return r; };
    await handleCreatePlan({ setup: setup() }, { apiKey: KEY, generate: recorder({}) });
    const png = readFileSync("samples/deccan-royal-caterers-quote.png").toString("base64");
    const i = scanInputFromJson({ imageBase64: png, mimeType: "image/png", state: royalWedding, today: TODAY });
    assert.ok(i.ok);
    await handleScan(i.input, { apiKey: KEY, generate: recorder({ text: "{}" }) });
    assert.deepEqual(params.map(p => p.maxOutputTokens), [GEMINI_MAX_OUTPUT_TOKENS.plan, GEMINI_MAX_OUTPUT_TOKENS.scan]);
  });
});

describe("finishReason MAX_TOKENS is a truncated, malformed response", () => {
  test("assertNotTruncated passes complete replies through and rejects a capped one", () => {
    const ok: GenerateResult = { text: "x", candidates: [{ content: null, finishReason: "STOP" }] };
    assert.equal(assertNotTruncated(ok), ok);
    assert.equal(assertNotTruncated(null), null);
    assert.equal(assertNotTruncated({ text: "x" }).text, "x");
    assert.throws(() => assertNotTruncated({ candidates: [{ finishReason: "MAX_TOKENS" }] }), (e: unknown) => e instanceof ProviderError && e.kind === "malformed_response");
  });

  test("the client rejects with malformed_response and does not retry it", async () => {
    stubGemini(textAnswer("{\"half\":", "MAX_TOKENS"), textAnswer("never sent"));
    await assert.rejects(client()({ contents: [{ role: "user", parts: [{ text: "hi" }] }], maxOutputTokens: 16 }, { signal: new AbortController().signal }),
      (e: unknown) => e instanceof ProviderError && e.kind === "malformed_response" && /MAX_TOKENS/.test(e.message));
    assert.equal(sentBodies.length, 1);
  });

  test("a chat turn cut off at the cap falls back to Demo Mode with the unreadable-response message", async () => {
    stubGemini(callAnswer("apply_plan_changes", { summary: "cut" }, "MAX_TOKENS"));
    const r = await handleChat({ messages: user("Cut ₹20k from decor"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: client() });
    assert.equal(r.status, 200);
    const b = r.body as ChatResponseBody;
    assert.deepEqual([b.mode, b.fallbackReason], ["offline", "malformed_response"]);
    assert.equal(b.warning, "Gemini returned an unreadable response. Answered in Demo Mode.");
    assert.ok(b.actions.some(a => a.kind === "batch"), "the Demo Mode brain still answers the request");
  });

  test("a plan draft cut off at the cap falls back to the Demo Mode blueprint", async () => {
    stubGemini(callAnswer("initialize_event_plan", { title: "Half a plan" }, "MAX_TOKENS"));
    const r = await handleCreatePlan({ setup: setup() }, { apiKey: KEY, generate: client() });
    assert.equal(r.status, 200);
    const b = r.body as PlanResponseBody;
    assert.deepEqual([b.mode, b.fallbackReason], ["offline", "malformed_response"]);
    assert.match(b.warning ?? "", /Demo Mode blueprint/);
    assert.ok(b.plan.subEvents.length > 0);
  });

  test("a quote extraction cut off at the cap is the existing unreadable-result error", async () => {
    stubGemini(textAnswer("{\"vendorName\":\"Deccan", "MAX_TOKENS"));
    const png = readFileSync("samples/deccan-royal-caterers-quote.png").toString("base64");
    const i = scanInputFromJson({ imageBase64: png, mimeType: "image/png", state: royalWedding, today: TODAY });
    assert.ok(i.ok);
    const r = await handleScan(i.input, { apiKey: KEY, generate: client() });
    assert.equal(r.status, 502);
    assert.equal((r.body as { error?: string }).error, "provider_malformed_response");
  });
});

describe("useChatSession: pure transcript updates", () => {
  const msg = (id: string, text: string): ChatMsg => ({ id, role: "user", text });
  test("withTranscript never mutates and gives the same result when React calls it twice", () => {
    const prev: Record<"organizer" | "guest", ChatMsg[]> = { organizer: [msg("a", "one")], guest: [] };
    const snapshot = JSON.stringify(prev);
    const added = msg("b", "two");
    const f = (ms: ChatMsg[]) => [...ms, added];
    const first = withTranscript(prev, "organizer", f);
    const second = withTranscript(prev, "organizer", f);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(prev), snapshot, "prev is untouched");
    assert.deepEqual(first.organizer.map(m => m.id), ["a", "b"]);
    assert.equal(first.guest, prev.guest, "the other role keeps its array");
    const missing = withTranscript({ organizer: [] } as unknown as Record<"organizer" | "guest", ChatMsg[]>, "guest", f);
    assert.deepEqual(missing.guest.map(m => m.id), ["b"]);
  });

  test("source: no updater writes the ref or makes ids, and send's history includes the new message", () => {
    const src = readFileSync(new URL("../components/planner/useChatSession.ts", import.meta.url), "utf8");
    assert.match(src, /setChats\(prev => withTranscript\(prev, r, f\)\)/);
    const refWrites = src.match(/chatsRef\.current\s*=(?!=)/g) ?? [];
    assert.equal(refWrites.length, 1, "chatsRef is written in one place only");
    assert.match(src, /useLayoutEffect\(\(\) => \{ chatsRef\.current = chats; \}, \[chats\]\)/);
    assert.doesNotMatch(src, /setMsgs\([^;]*nid\(\)/, "ids are made before setMsgs, never inside an updater");
    assert.match(src, /const sent = \[\.\.\.\(chatsRef\.current\[r\] \?\? \[\]\), userMsg\];/);
    assert.match(src, /const history = sent\.filter\(/);
  });
});
