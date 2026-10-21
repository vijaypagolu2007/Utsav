// Gemini co-pilot route. The model only proposes tool calls; every tool runs through the deterministic
// executor (dry-run reducer, blueprint allocator, insights). If Gemini is missing or fails, the offline
// demo parser answers the flagship prompts with the very same tools.
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { AgentState } from "@/schema";
import { executeAgentTool, type AgentAction, type ChatRequest, type ChatResponse } from "@/agent";
import { functionDeclarations, guestFunctionDeclarations, GUEST_SYSTEM_PROMPT, SYSTEM_PROMPT } from "@/gemini-tools";
import { runOfflineAgent, runOfflineGuestAgent } from "@/offline";
import type { Role } from "@/commands";
import { todayIST } from "@/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_STEPS = 6;
const TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function runGemini(apiKey: string, req: ChatRequest, st: AgentState, today: string, role: Role): Promise<ChatResponse> {
  const guest = role === "guest";
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const contents: Content[] = req.messages.slice(-12).map(m => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] }));
  const actions: AgentAction[] = [];
  let working = st;
  let reply = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await withTimeout(ai.models.generateContent({
      model, contents,
      config: {
        // Rebuilt every step from `working`, so step > 0 sees the batches already staged this turn.
        systemInstruction: guest ? GUEST_SYSTEM_PROMPT(working, req.actingGuestId ?? null) : SYSTEM_PROMPT(working, today),
        tools: [{ functionDeclarations: (guest ? guestFunctionDeclarations : functionDeclarations) as unknown as FunctionDeclaration[] }],
        temperature: 0.2,
      },
    }), TIMEOUT_MS);
    const calls = res.functionCalls ?? [];
    if (!calls.length) { reply = res.text ?? ""; break; }
    const modelContent = res.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);
    const parts: Part[] = [];
    for (const call of calls) {
      const out = executeAgentTool(call.name ?? "", call.args ?? {}, working, today, role);
      actions.push(...out.actions);
      working = out.working;
      parts.push({ functionResponse: { id: call.id, name: call.name, response: out.response } });
    }
    contents.push({ role: "user", parts });
  }
  if (!reply) reply = actions.length ? "Here's what I prepared." : "I couldn't work that out. Try rephrasing?";
  return { reply, actions, mode: "gemini" };
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try { body = (await request.json()) as ChatRequest; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = AgentState.safeParse(body?.state);
  if (!parsed.success) return NextResponse.json({ error: "Invalid plan state", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  const st = parsed.data;
  const today = typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : todayIST();
  const messages = Array.isArray(body.messages) ? body.messages.filter(m => m && typeof m.text === "string") : [];
  const last = [...messages].reverse().find(m => m.role === "user")?.text ?? "";
  if (!last.trim()) return NextResponse.json({ error: "Empty message" }, { status: 400 });

  const role: Role = body.role === "guest" ? "guest" : "organizer";
  const actingGuestId = typeof body.actingGuestId === "string" ? body.actingGuestId : null;
  const offline = () => (role === "guest" ? runOfflineGuestAgent(st, last, today, actingGuestId) : runOfflineAgent(st, last, today));
  const key = process.env.GEMINI_API_KEY;
  if (!key || body.forceOffline) {
    const r = offline();
    return NextResponse.json({ ...r, ...(key ? {} : { warning: "No GEMINI_API_KEY set: running in deterministic Demo Mode." }) } satisfies ChatResponse);
  }
  try {
    return NextResponse.json(await runGemini(key, { ...body, messages, actingGuestId }, st, today, role));
  } catch (e) {
    const r = offline();
    return NextResponse.json({ ...r, warning: `Gemini unavailable (${e instanceof Error ? e.message.slice(0, 120) : "error"}). Answered in Demo Mode.` } satisfies ChatResponse);
  }
}
