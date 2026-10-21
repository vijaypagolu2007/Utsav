// /api/chat logic, framework-free. Gemini proposes tool calls; executeAgentTool dry-runs every one through the
// Zod schemas and the deterministic reducer. Nothing here persists anything: the response carries proposals
// that the client commits through applyBatch (Tier 0 auto, Tier 1 approve).
import { geminiTimeoutMs } from "@/gemini-model";
import { z } from "zod";
import { AgentState } from "@/schema";
import { executeAgentTool, type AgentAction, type ChatResponse } from "@/agent";
import { functionDeclarations, guestFunctionDeclarations, GUEST_SYSTEM_PROMPT, SYSTEM_PROMPT } from "@/gemini-tools";
import { runOfflineAgent, runOfflineGuestAgent } from "@/offline";
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
  actingGuestId: z.string().max(64).nullable().optional(),
}).strict();

export type ChatDeps = {
  apiKey?: string | null;
  /** Injected for tests; defaults to the real SDK when a key exists. */
  generate?: GenerateFn | null;
  stepTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxSteps?: number;
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
  const role: Role = req.data.role ?? "organizer";
  const actingGuestId = req.data.actingGuestId ?? null;
  if (actingGuestId !== null && !plan.guests.some(g => g.id === actingGuestId)) return fail(400, "invalid_guest", "actingGuestId is not a guest of this event");

  const offline = (): ChatResponse => (role === "guest" ? runOfflineGuestAgent(plan, last, today, actingGuestId) : runOfflineAgent(plan, last, today));
  if (req.data.forceOffline) return ok({ ...offline(), fallbackReason: "forced" } satisfies ChatResponseBody);
  if (!deps.apiKey || !deps.generate) {
    return ok({ ...offline(), warning: "No GEMINI_API_KEY on the server: running in deterministic Demo Mode.", fallbackReason: "no_api_key" } satisfies ChatResponseBody);
  }
  try {
    const body = await runGeminiLoop(deps.generate, messages, plan, today, role, actingGuestId, deps);
    return ok(body);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e; // programming errors surface as 500 in the route, never as a fake success
    logServer("chat", "provider_failure", { kind: e.kind, status: e.status ?? null, message: e.message });
    if (!FALLBACK_OK.has(e.kind)) return fail(502, "provider_error", "The AI provider failed");
    return ok({ ...offline(), warning: FALLBACK_MESSAGE[e.kind], fallbackReason: e.kind } satisfies ChatResponseBody);
  }
}

async function runGeminiLoop(generate: GenerateFn, messages: z.infer<typeof ChatTurn>[], plan: AgentState, today: string, role: Role,
  actingGuestId: string | null, deps: ChatDeps): Promise<ChatResponseBody> {
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
        systemInstruction: guest ? GUEST_SYSTEM_PROMPT(working, actingGuestId) : SYSTEM_PROMPT(working, today),
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
        ? executeAgentTool(name, args ?? {}, working, today, role)
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
