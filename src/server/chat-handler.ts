// /api/chat logic, framework-free. Gemini proposes tool calls; executeAgentTool dry-runs every one through the
// Zod schemas and the deterministic reducer. Nothing here persists anything: the response carries proposals
// that the client commits through applyBatch (Tier 0 auto, Tier 1 approve).
import { geminiTimeoutMs } from "@/gemini-model";
import { z } from "zod";
import { AgentState } from "@/schema";
import { executeAgentTool, type AgentAction, type ChatResponse } from "@/agent";
import { functionDeclarations, guestFunctionDeclarations, GUEST_SYSTEM_PROMPT, SYSTEM_PROMPT } from "@/gemini-tools";
import { runOfflineAgent, runOfflineGuestAgent, runOfflineIdeas, runOfflineVendorQuestions } from "@/offline";
import { RefineMode } from "@/ideas";
import { checklistFor } from "@/config/vendor-checklist";
import { IdeaKind } from "@/schema";
import type { Role } from "@/commands";
import { todayIST } from "@/insights";
import { fail, issuesOf, logServer, ok, type HandlerResult } from "./http";
import { classifyProviderError, ProviderError, withDeadline, type Content, type FunctionDeclaration, type GenerateFn, type Part, type ProviderFailure } from "./gemini-client";

export const CHAT_MAX_BODY_BYTES = 512 * 1024;
export const CHAT_MAX_STEPS = 6;
export const CHAT_STEP_TIMEOUT_MS = 30_000;
export const CHAT_TOTAL_TIMEOUT_MS = 50_000;

const ChatTurn = z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) }).strict();
export const ChatRequestSchema = z.object({
  messages: z.array(ChatTurn).min(1).max(40),
  state: z.unknown(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  forceOffline: z.boolean().optional(),
  role: z.enum(["organizer", "guest"]).optional(),
  actingEntryId: z.string().max(64).nullable().optional(),
  /** "Get more ideas" from the Ideas page: forces one suggest_ideas call (or the offline bank). Organizer only. */
  ideas: z.object({ focus: z.string().trim().max(120).optional(), kind: IdeaKind.optional(),
    /** v6: refine one idea card ("Cheaper alternative", "Make it kid-friendly", "More traditional"). */
    refine: z.object({ mode: RefineMode, ideaId: z.string().min(1).max(64) }).strict().optional() }).strict().optional(),
  /** v6: "Questions to ask" for one vendor-checklist slot. Organizer only; changes nothing in the plan. */
  vendorQuestions: z.object({ need: z.string().min(1).max(40) }).strict().optional(),
}).strict();

export type ChatDeps = {
  apiKey?: string | null;
  /** Injected for tests; defaults to the real SDK when a key exists. */
  generate?: GenerateFn | null;
  stepTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxSteps?: number;
  /**
   * v8 Part 2: the request carries a guest's credentials (an X-Guest-Token or X-Device-Token header, as guest pages
   * send). Such a request is always answered as a guest, whatever role its body names, and one naming "organizer" is
   * refused: a guest link must never reach the organizer's tools.
   */
  guestCredentials?: boolean;
};

/** Failures where answering with the deterministic offline brain is safe: the user gets correct, labelled results. */
const FALLBACK_OK: ReadonlySet<ProviderFailure> = new Set(["auth", "model_not_found", "rate_limited", "unavailable", "timeout", "malformed_response", "bad_request", "unknown"]);
const FALLBACK_MESSAGE: Record<ProviderFailure, string> = {
  auth: "Gemini rejected the server's API key. Answered in Demo Mode.",
  model_not_found: "The configured Gemini model isn't available to this key. Answered in Demo Mode.",
  rate_limited: "Gemini rate limit reached. Answered in Demo Mode.",
  unavailable: "Gemini is temporarily busy. Answered in Demo Mode.",
  timeout: "Gemini took too long. Answered in Demo Mode.",
  malformed_response: "Gemini returned an unreadable response. Answered in Demo Mode.",
  bad_request: "Gemini couldn't process this request. Answered in Demo Mode.",
  unknown: "Gemini call failed. Answered in Demo Mode.",
};

export type ChatResponseBody = ChatResponse & { fallbackReason?: ProviderFailure | "no_api_key" | "forced"; truncated?: boolean };

export async function handleChat(raw: unknown, deps: ChatDeps): Promise<HandlerResult> {
  const req = ChatRequestSchema.safeParse(raw);
  if (!req.success) return fail(400, "invalid_request", "Malformed chat request", { issues: issuesOf(req.error.issues) });
  const st = AgentState.safeParse(req.data.state);
  if (!st.success) return fail(400, "invalid_state", "The plan state failed validation", { issues: issuesOf(st.error.issues) });
  const plan = st.data;
  const messages = req.data.messages;
  const last = [...messages].reverse().find(m => m.role === "user")?.text.trim() ?? "";
  if (!last) return fail(400, "empty_message", "The last user message is empty");
  const today = req.data.today ?? todayIST();
  if (deps.guestCredentials && req.data.role === "organizer") return fail(403, "not_allowed", "A guest link can't act as the organiser");
  const role: Role = deps.guestCredentials ? "guest" : req.data.role ?? "organizer";
  const actingEntryId = req.data.actingEntryId ?? null;
  // v8 Part 1c: Guest View acts as one RSVP entry of this event (or nobody yet).
  if (actingEntryId !== null && !plan.rsvpEntries.some(e => e.id === actingEntryId && !e.removedAt && !e.mergedInto)) return fail(400, "invalid_guest", "actingEntryId is not an RSVP of this event");

  const ideaReq = req.data.ideas;
  const vq = req.data.vendorQuestions;
  if ((ideaReq || vq) && role === "guest") return fail(403, "not_allowed", ideaReq ? "Ideas are for the organiser" : "Vendor questions are for the organiser");
  if (ideaReq?.refine && !plan.ideas.some(i => i.id === ideaReq.refine!.ideaId)) return fail(400, "invalid_idea", "No such idea to refine");
  if (vq && !checklistFor(plan).some(s => s.key === vq.need)) return fail(400, "invalid_need", "That isn't a vendor-checklist slot for this event");
  const offline = (): ChatResponse => (ideaReq ? runOfflineIdeas(plan, today, ideaReq.focus ?? "", ideaReq.kind, ideaReq.refine)
    : vq ? runOfflineVendorQuestions(plan, today, vq.need)
    : role === "guest" ? runOfflineGuestAgent(plan, last, today, actingEntryId) : runOfflineAgent(plan, last, today));
  if (req.data.forceOffline) return ok({ ...offline(), fallbackReason: "forced" } satisfies ChatResponseBody);
  if (!deps.apiKey || !deps.generate) {
    return ok({ ...offline(), warning: "No GEMINI_API_KEY on the server: running in deterministic Demo Mode.", fallbackReason: "no_api_key" } satisfies ChatResponseBody);
  }
  try {
    const body = ideaReq ? await runGeminiIdeas(deps.generate, plan, today, ideaReq, deps)
      : vq ? await runGeminiVendorQuestions(deps.generate, plan, today, vq.need, deps)
      : await runGeminiLoop(deps.generate, messages, plan, today, role, actingEntryId, deps);
    return ok(body);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e; // programming errors surface as 500 in the route, never as a fake success
    logServer("chat", "provider_failure", { kind: e.kind, status: e.status ?? null, message: e.message });
    if (!FALLBACK_OK.has(e.kind)) return fail(502, "provider_error", "The AI provider failed");
    return ok({ ...offline(), warning: FALLBACK_MESSAGE[e.kind], fallbackReason: e.kind } satisfies ChatResponseBody);
  }
}

const SUGGEST_IDEAS_DECL = functionDeclarations.filter(f => f.name === "suggest_ideas");
export const IDEAS_MAX_STEPS = 2;

/**
 * "Get more ideas": Gemini is offered only suggest_ideas and asked to call it. Code validates the cards (rupees → paise,
 * ranges, duplicates, category headroom). A malformed call is answered once with the reason; no call at all is a
 * malformed response, which falls back to the curated Demo Mode bank like any other provider failure.
 */
const REFINE_ASK: Record<z.infer<typeof RefineMode>, string> = {
  cheaper: "The organiser finds this too pricey. Suggest 2 to 4 CHEAPER alternatives of the same kind, each with a lower estimate than the original",
  kid_friendly: "The organiser wants this kid-friendly. Suggest 2 to 4 versions that suit children (safe materials, shorter, something for the kids to do)",
  traditional: "The organiser wants this more traditional. Suggest 2 to 4 versions rooted in the event's own traditions and region",
};
async function runGeminiIdeas(generate: GenerateFn, plan: AgentState, today: string, req: { focus?: string; kind?: z.infer<typeof IdeaKind>; refine?: { mode: z.infer<typeof RefineMode>; ideaId: string } }, deps: ChatDeps): Promise<ChatResponseBody> {
  const stepMs = deps.stepTimeoutMs ?? geminiTimeoutMs(CHAT_STEP_TIMEOUT_MS, 45_000);
  const deadline = Date.now() + (deps.totalTimeoutMs ?? Math.max(CHAT_TOTAL_TIMEOUT_MS, Math.min(stepMs + 10_000, 55_000)));
  const src = req.refine ? plan.ideas.find(i => i.id === req.refine!.ideaId)! : null;
  const ask = src && req.refine
    ? `${REFINE_ASK[req.refine.mode]}. Original idea (${src.kind}): "${src.title}": ${src.description}${src.estLowPaise !== null ? ` Estimated ₹${(src.estLowPaise / 100).toLocaleString("en-IN")}${src.estHighPaise ? `–₹${(src.estHighPaise / 100).toLocaleString("en-IN")}` : ""}.` : ""} Call suggest_ideas now.`
    : `Suggest new ideas for this event${req.kind ? ` (only ${req.kind.replace("_", " ")} ideas)` : ""}${req.focus ? `. Focus: ${req.focus}` : ""}. Call suggest_ideas now.`;
  const contents: Content[] = [{ role: "user", parts: [{ text: ask }] }];
  for (let step = 0; step < IDEAS_MAX_STEPS; step++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ProviderError("timeout", "Gemini ideas exceeded its time budget");
    let res;
    try {
      res = await withDeadline(signal => generate({ contents, systemInstruction: SYSTEM_PROMPT(plan, today),
        functionDeclarations: SUGGEST_IDEAS_DECL as unknown as FunctionDeclaration[], temperature: 0.7 }, { signal }), Math.min(stepMs, left));
    } catch (e) { throw classifyProviderError(e); }
    const calls = Array.isArray(res?.functionCalls) ? res.functionCalls : [];
    const call = calls.find(c => c?.name === "suggest_ideas");
    if (!call || typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) throw new ProviderError("malformed_response", "Gemini didn't return idea cards");
    const out = executeAgentTool("suggest_ideas", call.args, plan, today, "organizer", "gemini", req.refine ? { refine: req.refine } : {});
    const r = out.response as { ok: boolean; summary?: string; note?: string; reason?: string };
    if (r.ok) return { reply: r.summary ?? r.note ?? "No new ideas this time.", actions: out.actions, mode: "gemini" };
    const modelContent = res.candidates?.[0]?.content;
    contents.push(modelContent && typeof modelContent === "object" ? modelContent : { role: "model", parts: [{ functionCall: { id: call.id, name: "suggest_ideas", args: call.args as Record<string, unknown> } }] });
    contents.push({ role: "user", parts: [{ functionResponse: { id: call.id, name: "suggest_ideas", response: out.response } }] });
  }
  throw new ProviderError("malformed_response", "Gemini's idea cards failed validation twice");
}

const VENDOR_Q_DECL = functionDeclarations.filter(f => f.name === "suggest_vendor_questions");
/** v6: "Questions to ask" for one vendor slot: Gemini offered only suggest_vendor_questions; code checks the slot and shape. */
async function runGeminiVendorQuestions(generate: GenerateFn, plan: AgentState, today: string, need: string, deps: ChatDeps): Promise<ChatResponseBody> {
  const stepMs = deps.stepTimeoutMs ?? geminiTimeoutMs(CHAT_STEP_TIMEOUT_MS, 45_000);
  const slot = checklistFor(plan).find(s => s.key === need)!;
  const ask = `List 5 to 8 questions the organiser should ask a ${slot.label.toLowerCase()} for this event before booking (need: ${slot.need}). Use need "${need}". Call suggest_vendor_questions now.`;
  let res;
  try {
    res = await withDeadline(signal => generate({ contents: [{ role: "user", parts: [{ text: ask }] }], systemInstruction: SYSTEM_PROMPT(plan, today),
      functionDeclarations: VENDOR_Q_DECL as unknown as FunctionDeclaration[], temperature: 0.4 }, { signal }), deps.totalTimeoutMs ? Math.min(stepMs, deps.totalTimeoutMs) : stepMs);
  } catch (e) { throw classifyProviderError(e); }
  const calls = Array.isArray(res?.functionCalls) ? res.functionCalls : [];
  const call = calls.find(c => c?.name === "suggest_vendor_questions");
  if (!call || typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) throw new ProviderError("malformed_response", "Gemini didn't return vendor questions");
  const out = executeAgentTool("suggest_vendor_questions", { ...(call.args as Record<string, unknown>), need }, plan, today, "organizer", "gemini");
  const r = out.response as { ok: boolean; reason?: string };
  if (!r.ok) throw new ProviderError("malformed_response", `Gemini's vendor questions failed validation: ${r.reason}`);
  return { reply: `Questions to ask the ${slot.label.toLowerCase()} before you book.`, actions: out.actions, mode: "gemini" };
}

async function runGeminiLoop(generate: GenerateFn, messages: z.infer<typeof ChatTurn>[], plan: AgentState, today: string, role: Role,
  actingEntryId: string | null, deps: ChatDeps): Promise<ChatResponseBody> {
  const guest = role === "guest";
  const maxSteps = deps.maxSteps ?? CHAT_MAX_STEPS;
  // GEMINI_TIMEOUT_MS can lengthen a step up to 45 s; the whole turn stays under the route's 60 s maxDuration.
  const stepMs = deps.stepTimeoutMs ?? geminiTimeoutMs(CHAT_STEP_TIMEOUT_MS, 45_000);
  const deadline = Date.now() + (deps.totalTimeoutMs ?? Math.max(CHAT_TOTAL_TIMEOUT_MS, Math.min(stepMs + 10_000, 55_000)));
  const contents: Content[] = messages.slice(-12).map(m => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] }));
  const actions: AgentAction[] = [];
  let working = plan;
  let reply = "";
  let finished = false;
  for (let step = 0; step < maxSteps; step++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ProviderError("timeout", "Gemini turn exceeded its total time budget");
    let res;
    try {
      res = await withDeadline(signal => generate({
        contents,
        // Rebuilt every step from `working`, so step > 0 sees the batches already staged this turn.
        systemInstruction: guest ? GUEST_SYSTEM_PROMPT(working, actingEntryId) : SYSTEM_PROMPT(working, today),
        functionDeclarations: (guest ? guestFunctionDeclarations : functionDeclarations) as unknown as FunctionDeclaration[],
        temperature: 0.2,
      }, { signal }), Math.min(stepMs, left));
    } catch (e) { throw classifyProviderError(e); }
    if (!res || typeof res !== "object") throw new ProviderError("malformed_response", "Empty response");
    const calls = res.functionCalls ?? [];
    if (!Array.isArray(calls)) throw new ProviderError("malformed_response", "functionCalls is not an array");
    if (!calls.length) {
      if (res.text !== undefined && res.text !== null && typeof res.text !== "string") throw new ProviderError("malformed_response", "text is not a string");
      reply = (res.text ?? "").trim();
      finished = true;
      break;
    }
    const modelContent = res.candidates?.[0]?.content;
    contents.push(modelContent && typeof modelContent === "object" ? modelContent
      : { role: "model", parts: calls.map(c => ({ functionCall: { id: c.id, name: c.name, args: (c.args ?? {}) as Record<string, unknown> } })) });
    const parts: Part[] = [];
    for (const call of calls.slice(0, 8)) {
      const name = typeof call?.name === "string" ? call.name : "";
      const args = call?.args;
      // Untrusted: a non-object argument is answered as a tool error, never executed.
      const out = name && (args === undefined || (typeof args === "object" && args !== null && !Array.isArray(args)))
        ? executeAgentTool(name, args ?? {}, working, today, role, "gemini", { actingEntryId: guest ? actingEntryId : null })
        : { response: { ok: false, reason: "Malformed tool call: name must be a string and args an object" }, actions: [] as AgentAction[], working };
      actions.push(...out.actions);
      working = out.working;
      parts.push({ functionResponse: { id: call?.id, name: name || "unknown", response: out.response } });
    }
    contents.push({ role: "user", parts });
  }
  if (!finished) logServer("chat", "max_steps_reached", { steps: maxSteps, actions: actions.length });
  if (!reply) reply = !finished ? `I stopped after ${maxSteps} tool steps. Here's what I prepared so far.` : actions.length ? "Here's what I prepared." : "I couldn't work that out. Try rephrasing?";
  return { reply, actions, mode: "gemini", ...(finished ? {} : { truncated: true }) };
}
