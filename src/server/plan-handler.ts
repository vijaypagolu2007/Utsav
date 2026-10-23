// /api/plan: first-run setup → a new plan. Gemini drafts the plan with initialize_event_plan (sub-events, tasks, timeline,
// personalised to tradition, city and the note); initializeEventPlan then enforces the user's own answers as hard
// constraints (basics, date range, categories, exact amounts, booked lines). Without a key, or if Gemini fails or its
// draft can't be made to fit, the deterministic setup blueprint is used and the response says so. Nothing persists here.
import { z } from "zod";
import { geminiTimeoutMs } from "@/gemini-model";
import { initializeEventPlan } from "@/blueprint";
import { functionDeclarations } from "@/gemini-tools";
import { blueprintFromSetup, setupBrief, SetupInput } from "@/setup";
import type { AgentState } from "@/schema";
import { fail, issuesOf, logServer, ok, type HandlerResult } from "./http";
import { classifyProviderError, ProviderError, withDeadline, type Content, type FunctionDeclaration, type GenerateFn, type ProviderFailure } from "./gemini-client";

export const PLAN_MAX_BODY_BYTES = 32 * 1024;
export const PLAN_MAX_STEPS = 2;
const PLAN_STEP_TIMEOUT_MS = 40_000;

export const PlanRequestSchema = z.object({
  setup: z.unknown(),
  forceOffline: z.boolean().optional(),
}).strict();

export type PlanDeps = { apiKey?: string | null; generate?: GenerateFn | null; stepTimeoutMs?: number };
export type PlanResponseBody = { plan: AgentState; log: string[]; mode: "gemini" | "offline"; warning?: string; fallbackReason?: ProviderFailure | "no_api_key" | "forced" | "draft_rejected" };

const INIT_DECL = functionDeclarations.filter(f => f.name === "initialize_event_plan");
const SETUP_SYSTEM = `You draft Indian event plans for the Utsav planner. Call initialize_event_plan exactly once.
Give budget lines as weightBps only (the app sets every amount from the user's own choices), sub-event days as dayOffset from startDate,
and task deadlines as dueOffsetDays. Pick sub-events, tasks and run-of-show blocks that fit the tradition, region, age and venue described;
never a fixed template. Use only the budget categories listed.`;

export async function handleCreatePlan(raw: unknown, deps: PlanDeps): Promise<HandlerResult> {
  const req = PlanRequestSchema.safeParse(raw);
  if (!req.success) return fail(400, "invalid_request", "Malformed plan request", { issues: issuesOf(req.error.issues) });
  const sp = SetupInput.safeParse(req.data.setup);
  if (!sp.success) return fail(400, "invalid_setup", "Some setup answers need another look", { issues: issuesOf(sp.error.issues) });
  const setup = sp.data;

  const offline = (warning?: string, fallbackReason?: PlanResponseBody["fallbackReason"]): HandlerResult => {
    const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
    if (!r.ok) return fail(422, "setup_rejected", r.reason, { issues: r.diagnostics.issues });
    return ok({ plan: r.state, log: r.log, mode: "offline", ...(warning ? { warning } : {}), ...(fallbackReason ? { fallbackReason } : {}) } satisfies PlanResponseBody);
  };
  if (req.data.forceOffline) return offline(undefined, "forced");
  if (!deps.apiKey || !deps.generate) return offline("No GEMINI_API_KEY on the server: built with the Demo Mode blueprint.", "no_api_key");

  const contents: Content[] = [{ role: "user", parts: [{ text: setupBrief(setup) }] }];
  const stepMs = deps.stepTimeoutMs ?? geminiTimeoutMs(PLAN_STEP_TIMEOUT_MS, 45_000);
  // The route's maxDuration is 60 s: the whole Gemini attempt (both steps) stays under 52 s, leaving room for the fallback.
  const deadline = Date.now() + Math.min(52_000, stepMs * PLAN_MAX_STEPS);
  try {
    for (let step = 0; step < PLAN_MAX_STEPS; step++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new ProviderError("timeout", "Gemini setup exceeded its time budget");
      let res;
      try {
        res = await withDeadline(signal => deps.generate!({ contents, systemInstruction: SETUP_SYSTEM,
          functionDeclarations: INIT_DECL as unknown as FunctionDeclaration[], temperature: 0.4 }, { signal }), Math.min(stepMs, left));
      } catch (e) { throw classifyProviderError(e); }
      const call = (Array.isArray(res?.functionCalls) ? res.functionCalls : []).find(c => c?.name === "initialize_event_plan");
      if (!call || typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) throw new ProviderError("malformed_response", "No initialize_event_plan call");
      const r = initializeEventPlan(call.args, { setup });
      if (r.ok) return ok({ plan: r.state, log: r.log, mode: "gemini" } satisfies PlanResponseBody);
      logServer("plan", "draft_rejected", { step, issues: r.diagnostics.issues.slice(0, 5) });
      const modelContent = res.candidates?.[0]?.content;
      contents.push(modelContent && typeof modelContent === "object" ? modelContent : { role: "model", parts: [{ functionCall: { id: call.id, name: call.name, args: call.args as Record<string, unknown> } }] });
      contents.push({ role: "user", parts: [{ functionResponse: { id: call.id, name: "initialize_event_plan", response: { ok: false, reason: r.reason, issues: r.diagnostics.issues } } }] });
    }
    return offline("Gemini's draft didn't fit your choices, so the Demo Mode blueprint was used. Your amounts are exactly as you set them.", "draft_rejected");
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    logServer("plan", "provider_failure", { kind: e.kind, status: e.status ?? null });
    return offline(`Gemini was unavailable (${e.kind.replace("_", " ")}), so the Demo Mode blueprint was used.`, e.kind);
  }
}
