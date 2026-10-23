// First-run setup → new plan. Logic lives in src/server/plan-handler.ts (unit-tested with a mocked Gemini).
import { handleCreatePlan, PLAN_MAX_BODY_BYTES } from "@/server/plan-handler";
import { geminiGenerate } from "@/server/gemini-client";
import { fail, geminiApiKey, logServer, readJsonLimited, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await readJsonLimited(request, PLAN_MAX_BODY_BYTES);
  if (!body.ok) return toResponse(body.result);
  const apiKey = geminiApiKey();
  try {
    return toResponse(await handleCreatePlan(body.value, { apiKey, generate: apiKey ? geminiGenerate(apiKey) : null }));
  } catch (e) {
    logServer("plan", "internal_error", { message: e instanceof Error ? e.message : String(e) });
    return toResponse(fail(500, "internal_error", "Something went wrong on the server"));
  }
}
